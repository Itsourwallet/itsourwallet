use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey,
};
use anchor_lang::system_program;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::spl_token::state::Account as LegacyTokenAccount;
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensions, state::Account as Token2022Account,
};
use anchor_spl::{token, token_2022};

declare_id!("G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8");

const ROUND_SECONDS: i64 = 5 * 60;
const ADMIN_TIMELOCK_SECONDS: i64 = 86_400;
const ROLLING_WINDOW_SECONDS: i64 = 86_400;
const BASE_PROPOSAL_FEE: u64 = 100_000_000;
const BASE_VOTE_FEE: u64 = 10_000_000;
const MAX_BPS: u64 = 10_000;
const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_SOL_QUOTE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const PUMP_BUY_V2_DISCRIMINATOR: [u8; 8] = [184, 23, 238, 97, 103, 197, 211, 61];
const PUMP_SELL_V2_DISCRIMINATOR: [u8; 8] = [93, 246, 130, 60, 231, 233, 64, 178];
const PUMP_BUY_V2_ACCOUNT_COUNT_WITHOUT_PROGRAM: usize = 26;
const PUMP_SELL_V2_ACCOUNT_COUNT_WITHOUT_PROGRAM: usize = 25;
#[program]
pub mod onchain {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, config: SafetyConfig) -> Result<()> {
        config.validate()?;
        let now = Clock::get()?.unix_timestamp;
        let treasury = &mut ctx.accounts.treasury;
        treasury.authority = ctx.accounts.authority.key();
        treasury.pending_authority = Pubkey::default();
        treasury.authority_transfer_after = 0;
        treasury.paused = false;
        treasury.round_number = 0;
        treasury.proposal_fee = BASE_PROPOSAL_FEE;
        treasury.vote_fee = BASE_VOTE_FEE;
        treasury.config = config;
        treasury.rolling_window_started_at = now;
        treasury.rolling_spent_lamports = 0;
        treasury.bump = ctx.bumps.treasury;
        treasury.vault_bump = Pubkey::find_program_address(&[b"vault"], ctx.program_id).1;
        open_round(
            &mut ctx.accounts.round,
            treasury.key(),
            0,
            now,
            ctx.bumps.round,
        );
        emit!(RoundOpened {
            round: 0,
            opens_at: now,
            closes_at: now + ROUND_SECONDS
        });
        Ok(())
    }

    pub fn create_proposal(ctx: Context<CreateProposal>, args: ProposalArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.treasury.paused, WallError::Paused);
        require!(
            ctx.accounts.round.status == RoundStatus::Open,
            WallError::RoundClosed
        );
        require!(now < ctx.accounts.round.closes_at, WallError::RoundClosed);
        require!(
            args.expires_at > ctx.accounts.round.closes_at,
            WallError::Expired
        );
        validate_proposal_amounts(
            args.action,
            args.amount,
            args.maximum_amount,
            args.minimum_output,
        )?;
        require!(
            args.title.as_bytes().len() <= 64 && args.rationale.as_bytes().len() <= 192,
            WallError::TextTooLong
        );
        require!(
            args.max_slippage_bps <= ctx.accounts.treasury.config.max_slippage_bps,
            WallError::SlippageTooHigh
        );

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.proposer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            dynamic_fee(
                ctx.accounts.treasury.proposal_fee,
                ctx.accounts.round.proposal_count,
            )?,
        )?;
        let proposal = &mut ctx.accounts.proposal;
        proposal.round = ctx.accounts.round.key();
        proposal.id = ctx.accounts.round.proposal_count;
        proposal.proposer = ctx.accounts.proposer.key();
        proposal.action = args.action;
        proposal.target = args.target;
        proposal.amount = args.amount;
        proposal.maximum_amount = args.maximum_amount;
        proposal.minimum_output = args.minimum_output;
        proposal.max_slippage_bps = args.max_slippage_bps;
        proposal.expires_at = args.expires_at;
        proposal.title = args.title;
        proposal.rationale = args.rationale;
        proposal.created_at = now;
        proposal.status = ProposalStatus::Voting;
        proposal.bump = ctx.bumps.proposal;
        ctx.accounts.round.proposal_count = ctx
            .accounts
            .round
            .proposal_count
            .checked_add(1)
            .ok_or(WallError::Overflow)?;
        emit!(ProposalCreated {
            round: ctx.accounts.round.number,
            proposal: proposal.id,
            proposer: proposal.proposer
        });
        Ok(())
    }

    pub fn buy_votes(ctx: Context<BuyVotes>, votes: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(votes > 0, WallError::InvalidAmount);
        require!(!ctx.accounts.treasury.paused, WallError::Paused);
        require!(
            ctx.accounts.round.status == RoundStatus::Open && now < ctx.accounts.round.closes_at,
            WallError::RoundClosed
        );
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Voting,
            WallError::ProposalUnavailable
        );
        let unit_fee = dynamic_fee(
            ctx.accounts.treasury.vote_fee,
            ctx.accounts.round.total_votes,
        )?;
        let cost = unit_fee
            .checked_mul(votes as u64)
            .ok_or(WallError::Overflow)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.voter.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            cost,
        )?;
        let receipt = &mut ctx.accounts.receipt;
        receipt.proposal = ctx.accounts.proposal.key();
        receipt.voter = ctx.accounts.voter.key();
        receipt.votes = votes;
        receipt.paid_lamports = cost;
        receipt.created_at = now;
        receipt.bump = ctx.bumps.receipt;
        let proposal = &mut ctx.accounts.proposal;
        proposal.votes = proposal
            .votes
            .checked_add(votes as u64)
            .ok_or(WallError::Overflow)?;
        proposal.last_vote_at = now;
        let round = &mut ctx.accounts.round;
        round.total_votes = round
            .total_votes
            .checked_add(votes as u64)
            .ok_or(WallError::Overflow)?;
        if is_better(
            proposal.votes,
            proposal.last_vote_at,
            proposal.id,
            round.leading_votes,
            round.leading_reached_at,
            round.leading_proposal,
        ) {
            round.leading_proposal = proposal.id;
            round.leading_votes = proposal.votes;
            round.leading_reached_at = now;
        }
        emit!(VotesPurchased {
            round: round.number,
            proposal: proposal.id,
            voter: receipt.voter,
            votes,
            paid_lamports: cost
        });
        Ok(())
    }

    pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(round.status == RoundStatus::Open, WallError::AlreadySettled);
        require!(now >= round.closes_at, WallError::RoundStillOpen);
        round.status = RoundStatus::Settled;
        round.settled_at = now;
        round.winning_proposal = if round.proposal_count == 0 || round.leading_votes == 0 {
            None
        } else {
            Some(round.leading_proposal)
        };
        emit!(RoundSettled {
            round: round.number,
            winner: round.winning_proposal,
            votes: round.leading_votes,
            keeper: ctx.accounts.keeper.key()
        });
        Ok(())
    }

    pub fn open_next_round(ctx: Context<OpenNextRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.previous_round.status == RoundStatus::Settled,
            WallError::RoundStillOpen
        );
        let next = ctx
            .accounts
            .previous_round
            .number
            .checked_add(1)
            .ok_or(WallError::Overflow)?;
        require!(
            ctx.accounts
                .treasury
                .round_number
                .checked_add(1)
                .ok_or(WallError::Overflow)?
                == next,
            WallError::InvalidRound
        );
        ctx.accounts.treasury.round_number = next;
        open_round(
            &mut ctx.accounts.round,
            ctx.accounts.treasury.key(),
            next,
            now,
            ctx.bumps.round,
        );
        emit!(RoundOpened {
            round: next,
            opens_at: now,
            closes_at: now + ROUND_SECONDS
        });
        Ok(())
    }

    pub fn queue_mint_approval(ctx: Context<QueueMintApproval>, enabled: bool) -> Result<()> {
        validate_token_program(
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.token_program.key(),
        )?;
        let approval = &mut ctx.accounts.approval;
        approval.treasury = ctx.accounts.treasury.key();
        approval.mint = ctx.accounts.mint.key();
        approval.token_program = ctx.accounts.token_program.key();
        approval.pending_enabled = enabled;
        approval.execute_after = Clock::get()?
            .unix_timestamp
            .checked_add(ADMIN_TIMELOCK_SECONDS)
            .ok_or(WallError::Overflow)?;
        approval.bump = ctx.bumps.approval;
        emit!(MintApprovalQueued {
            mint: approval.mint,
            enabled,
            execute_after: approval.execute_after
        });
        Ok(())
    }

    pub fn apply_mint_approval(ctx: Context<ApplyMintApproval>) -> Result<()> {
        let approval = &mut ctx.accounts.approval;
        require!(
            Clock::get()?.unix_timestamp >= approval.execute_after,
            WallError::TimelockActive
        );
        approval.enabled = approval.pending_enabled;
        emit!(MintApprovalApplied {
            mint: approval.mint,
            enabled: approval.enabled
        });
        Ok(())
    }

    pub fn queue_authority_transfer(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            WallError::InvalidAuthority
        );
        let treasury = &mut ctx.accounts.treasury;
        treasury.pending_authority = new_authority;
        treasury.authority_transfer_after = Clock::get()?
            .unix_timestamp
            .checked_add(ADMIN_TIMELOCK_SECONDS)
            .ok_or(WallError::Overflow)?;
        emit!(AuthorityTransferQueued {
            new_authority,
            execute_after: treasury.authority_transfer_after
        });
        Ok(())
    }

    pub fn apply_authority_transfer(ctx: Context<ApplyAuthorityTransfer>) -> Result<()> {
        let treasury = &mut ctx.accounts.treasury;
        require!(
            treasury.pending_authority != Pubkey::default(),
            WallError::InvalidAuthority
        );
        require!(
            Clock::get()?.unix_timestamp >= treasury.authority_transfer_after,
            WallError::TimelockActive
        );
        treasury.authority = treasury.pending_authority;
        treasury.pending_authority = Pubkey::default();
        treasury.authority_transfer_after = 0;
        emit!(AuthorityTransferred {
            new_authority: treasury.authority
        });
        Ok(())
    }

    pub fn mark_winner(ctx: Context<MarkWinner>) -> Result<()> {
        let round = &ctx.accounts.round;
        let proposal = &mut ctx.accounts.proposal;
        require!(
            round.status == RoundStatus::Settled,
            WallError::RoundStillOpen
        );
        require!(
            round.winning_proposal == Some(proposal.id),
            WallError::NotWinningProposal
        );
        require!(
            proposal.status == ProposalStatus::Voting,
            WallError::ProposalUnavailable
        );
        proposal.status = ProposalStatus::Won;
        Ok(())
    }

    pub fn execute_pump_trade<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecutePumpTrade<'info>>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.treasury.paused, WallError::Paused);
        require!(
            ctx.accounts.round.status == RoundStatus::Settled,
            WallError::RoundStillOpen
        );
        require!(
            ctx.accounts.round.winning_proposal == Some(ctx.accounts.proposal.id),
            WallError::NotWinningProposal
        );
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Won,
            WallError::ProposalUnavailable
        );
        require!(now <= ctx.accounts.proposal.expires_at, WallError::Expired);
        let (discriminator, limit, expected_account_count) = match ctx.accounts.proposal.action {
            ActionKind::BuyApprovedToken => (
                PUMP_BUY_V2_DISCRIMINATOR,
                ctx.accounts.proposal.maximum_amount,
                PUMP_BUY_V2_ACCOUNT_COUNT_WITHOUT_PROGRAM,
            ),
            ActionKind::SellApprovedToken => (
                PUMP_SELL_V2_DISCRIMINATOR,
                ctx.accounts.proposal.minimum_output,
                PUMP_SELL_V2_ACCOUNT_COUNT_WITHOUT_PROGRAM,
            ),
            _ => return err!(WallError::UnsupportedExecution),
        };
        require!(
            ctx.remaining_accounts.len() == expected_account_count,
            WallError::InvalidPumpAccounts
        );

        let accounts = ctx.remaining_accounts;
        require!(
            accounts[1].key() == ctx.accounts.proposal.target,
            WallError::InvalidMint
        );
        require!(
            accounts[2].key() == PUMP_SOL_QUOTE_MINT,
            WallError::UnsupportedQuoteMint
        );
        require!(
            accounts[4].key() == token::ID,
            WallError::UnsupportedTokenProgram
        );
        require!(
            accounts[13].key() == ctx.accounts.vault.key(),
            WallError::InvalidPumpAccounts
        );
        validate_token_program(&accounts[1], accounts[3].key)?;
        validate_token_program(&accounts[2], accounts[4].key)?;
        require!(
            ctx.accounts.pump_program.key() == PUMP_PROGRAM_ID
                && ctx.accounts.pump_program.executable,
            WallError::InvalidPumpProgram
        );

        require!(
            ctx.accounts.proposal.amount > 0 && limit > 0,
            WallError::InvalidAmount
        );
        if ctx.accounts.proposal.action == ActionKind::BuyApprovedToken {
            let cap = ctx
                .accounts
                .vault
                .to_account_info()
                .lamports()
                .checked_mul(ctx.accounts.treasury.config.universal_action_limit_bps as u64)
                .ok_or(WallError::Overflow)?
                / MAX_BPS;
            require!(
                ctx.accounts.proposal.maximum_amount <= cap,
                WallError::ActionLimitExceeded
            );
            if now.saturating_sub(ctx.accounts.treasury.rolling_window_started_at)
                >= ROLLING_WINDOW_SECONDS
            {
                ctx.accounts.treasury.rolling_window_started_at = now;
                ctx.accounts.treasury.rolling_spent_lamports = 0;
            }
            let rolling_cap = ctx
                .accounts
                .vault
                .to_account_info()
                .lamports()
                .checked_mul(ctx.accounts.treasury.config.rolling_transfer_limit_bps as u64)
                .ok_or(WallError::Overflow)?
                / MAX_BPS;
            let new_total = ctx
                .accounts
                .treasury
                .rolling_spent_lamports
                .checked_add(ctx.accounts.proposal.maximum_amount)
                .ok_or(WallError::Overflow)?;
            require!(new_total <= rolling_cap, WallError::RollingLimitExceeded);
            ctx.accounts.treasury.rolling_spent_lamports = new_total;
        } else {
            let (mint, owner, balance) = token_account_details(&accounts[14], accounts[3].key)?;
            require!(
                mint == ctx.accounts.proposal.target && owner == ctx.accounts.vault.key(),
                WallError::InvalidTokenAccount
            );
            let cap = balance
                .checked_mul(ctx.accounts.treasury.config.universal_action_limit_bps as u64)
                .ok_or(WallError::Overflow)?
                / MAX_BPS;
            require!(
                ctx.accounts.proposal.amount <= cap,
                WallError::ActionLimitExceeded
            );
        }

        let mut data = Vec::with_capacity(25);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(&ctx.accounts.proposal.amount.to_le_bytes());
        data.extend_from_slice(&limit.to_le_bytes());
        data.push(0);
        let mut metas: Vec<AccountMeta> = accounts
            .iter()
            .enumerate()
            .map(|(index, account)| {
                let signer = index == 13;
                if account.is_writable {
                    AccountMeta::new(account.key(), signer)
                } else {
                    AccountMeta::new_readonly(account.key(), signer)
                }
            })
            .collect();
        metas.push(AccountMeta::new_readonly(PUMP_PROGRAM_ID, false));
        let instruction = Instruction {
            program_id: PUMP_PROGRAM_ID,
            accounts: metas,
            data,
        };
        let mut infos = accounts.to_vec();
        infos.push(ctx.accounts.pump_program.to_account_info());
        let bump = [ctx.accounts.treasury.vault_bump];
        let signer_seeds: &[&[u8]] = &[b"vault", &bump];
        invoke_signed(&instruction, &infos, &[signer_seeds])?;

        let proposal = &mut ctx.accounts.proposal;
        proposal.status = ProposalStatus::Executed;
        proposal.executed_at = now;
        proposal.execution_amount = if proposal.action == ActionKind::BuyApprovedToken {
            proposal.maximum_amount
        } else {
            proposal.amount
        };
        emit!(ProposalExecuted {
            proposal: proposal.key(),
            amount: proposal.execution_amount
        });
        Ok(())
    }

    pub fn execute_hold(ctx: Context<ExecuteHold>) -> Result<()> {
        require!(
            ctx.accounts.round.status == RoundStatus::Settled,
            WallError::RoundStillOpen
        );
        require!(
            ctx.accounts.round.winning_proposal == Some(ctx.accounts.proposal.id),
            WallError::NotWinningProposal
        );
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Won,
            WallError::ProposalUnavailable
        );
        require!(
            ctx.accounts.proposal.action == ActionKind::Hold,
            WallError::UnsupportedExecution
        );
        ctx.accounts.proposal.status = ProposalStatus::Executed;
        ctx.accounts.proposal.executed_at = Clock::get()?.unix_timestamp;
        emit!(ProposalExecuted {
            proposal: ctx.accounts.proposal.key(),
            amount: 0
        });
        Ok(())
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.treasury.paused = true;
        Ok(())
    }
    pub fn resume(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.treasury.paused = false;
        Ok(())
    }
}

fn dynamic_fee(base: u64, demand: u64) -> Result<u64> {
    let steps = demand.min(10);
    let surcharge = base.checked_mul(steps).ok_or(WallError::Overflow)? / 20;
    base.checked_add(surcharge)
        .ok_or(WallError::Overflow.into())
}

fn validate_proposal_amounts(
    action: ActionKind,
    amount: u64,
    maximum_amount: u64,
    minimum_output: u64,
) -> Result<()> {
    match action {
        ActionKind::Hold => require!(
            amount == 0 && maximum_amount == 0 && minimum_output == 0,
            WallError::InvalidAmount
        ),
        ActionKind::BuyApprovedToken => {
            require!(amount > 0 && maximum_amount > 0, WallError::InvalidAmount)
        }
        ActionKind::SellApprovedToken => {
            require!(amount > 0 && minimum_output > 0, WallError::InvalidAmount)
        }
        _ => return err!(WallError::UnsupportedExecution),
    }
    Ok(())
}

fn token_account_details(
    account: &AccountInfo,
    token_program: &Pubkey,
) -> Result<(Pubkey, Pubkey, u64)> {
    require!(
        *account.owner == *token_program,
        WallError::InvalidTokenAccount
    );
    let data = account.try_borrow_data()?;
    if *token_program == token::ID {
        let parsed = LegacyTokenAccount::unpack(&data)?;
        Ok((parsed.mint, parsed.owner, parsed.amount))
    } else if *token_program == token_2022::ID {
        let parsed = StateWithExtensions::<Token2022Account>::unpack(&data)?;
        Ok((parsed.base.mint, parsed.base.owner, parsed.base.amount))
    } else {
        err!(WallError::UnsupportedTokenProgram)
    }
}

fn validate_token_program(mint: &AccountInfo, token_program: &Pubkey) -> Result<()> {
    require!(
        *token_program == token::ID || *token_program == token_2022::ID,
        WallError::UnsupportedTokenProgram
    );
    require!(*mint.owner == *token_program, WallError::InvalidMintOwner);
    require!(!mint.data_is_empty(), WallError::InvalidMint);
    Ok(())
}

fn open_round(round: &mut Account<Round>, treasury: Pubkey, number: u64, now: i64, bump: u8) {
    round.treasury = treasury;
    round.number = number;
    round.opens_at = now;
    round.closes_at = now + ROUND_SECONDS;
    round.status = RoundStatus::Open;
    round.bump = bump;
}
fn is_better(
    votes: u64,
    reached: i64,
    id: u64,
    lead: u64,
    lead_reached: i64,
    lead_id: u64,
) -> bool {
    votes > lead
        || (votes == lead && (reached < lead_reached || (reached == lead_reached && id < lead_id)))
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer=authority, space=8+Treasury::INIT_SPACE, seeds=[b"treasury"], bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(init, payer=authority, space=8+Round::INIT_SPACE, seeds=[b"round", treasury.key().as_ref(), &0u64.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut, seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, has_one=treasury)]
    pub round: Account<'info, Round>,
    /// CHECK: system-owned SOL vault PDA; address is constrained.
    #[account(mut, seeds=[b"vault"], bump=treasury.vault_bump, owner=system_program::ID)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer=proposer, space=8+Proposal::INIT_SPACE, seeds=[b"proposal", round.key().as_ref(), &round.proposal_count.to_le_bytes()], bump)]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyVotes<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(mut, seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, has_one=treasury)]
    pub round: Account<'info, Round>,
    /// CHECK: system-owned SOL vault PDA; address is constrained.
    #[account(mut, seeds=[b"vault"], bump=treasury.vault_bump, owner=system_program::ID)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one=round)]
    pub proposal: Account<'info, Proposal>,
    #[account(init, payer=voter, space=8+VoteReceipt::INIT_SPACE, seeds=[b"vote", proposal.key().as_ref(), voter.key().as_ref()], bump)]
    pub receipt: Account<'info, VoteReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, has_one=treasury)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct OpenNextRound<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(has_one=treasury)]
    pub previous_round: Account<'info, Round>,
    #[account(init, payer=keeper, space=8+Round::INIT_SPACE, seeds=[b"round", treasury.key().as_ref(), &treasury.round_number.checked_add(1).ok_or(WallError::Overflow)?.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct QueueMintApproval<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[b"treasury"], bump=treasury.bump, has_one=authority)]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: owner is validated against one of the two supported token programs.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: address and mint ownership are validated by the handler.
    pub token_program: UncheckedAccount<'info>,
    #[account(init_if_needed, payer=authority, space=8+MintApproval::INIT_SPACE, seeds=[b"mint-approval", treasury.key().as_ref(), mint.key().as_ref()], bump)]
    pub approval: Account<'info, MintApproval>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyMintApproval<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, has_one=treasury, seeds=[b"mint-approval", treasury.key().as_ref(), approval.mint.as_ref()], bump=approval.bump)]
    pub approval: Account<'info, MintApproval>,
}

#[derive(Accounts)]
pub struct MarkWinner<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(has_one=treasury)]
    pub round: Account<'info, Round>,
    #[account(mut, has_one=round)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct ExecutePumpTrade<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: system-owned PDA; address and owner are constrained.
    #[account(mut, seeds=[b"vault"], bump=treasury.vault_bump, owner=system_program::ID)]
    pub vault: UncheckedAccount<'info>,
    #[account(has_one=treasury)]
    pub round: Account<'info, Round>,
    #[account(mut, has_one=round)]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: fixed to pump.fun mainnet program by handler.
    pub pump_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds=[b"treasury"], bump=treasury.bump, has_one=authority)]
    pub treasury: Account<'info, Treasury>,
}

#[derive(Accounts)]
pub struct ApplyAuthorityTransfer<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
}

#[derive(Accounts)]
pub struct ExecuteHold<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds=[b"treasury"], bump=treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(has_one=treasury)]
    pub round: Account<'info, Round>,
    #[account(mut, has_one=round)]
    pub proposal: Account<'info, Proposal>,
}

#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub authority_transfer_after: i64,
    pub paused: bool,
    pub round_number: u64,
    pub proposal_fee: u64,
    pub vote_fee: u64,
    pub config: SafetyConfig,
    pub rolling_window_started_at: i64,
    pub rolling_spent_lamports: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MintApproval {
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub enabled: bool,
    pub pending_enabled: bool,
    pub execute_after: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub treasury: Pubkey,
    pub number: u64,
    pub opens_at: i64,
    pub closes_at: i64,
    pub status: RoundStatus,
    pub proposal_count: u64,
    pub total_votes: u64,
    pub leading_proposal: u64,
    pub leading_votes: u64,
    pub leading_reached_at: i64,
    pub winning_proposal: Option<u64>,
    pub settled_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub round: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
    pub action: ActionKind,
    pub target: Pubkey,
    pub amount: u64,
    pub maximum_amount: u64,
    pub minimum_output: u64,
    pub max_slippage_bps: u16,
    pub expires_at: i64,
    #[max_len(64)]
    pub title: String,
    #[max_len(192)]
    pub rationale: String,
    pub created_at: i64,
    pub last_vote_at: i64,
    pub votes: u64,
    pub status: ProposalStatus,
    pub executed_at: i64,
    pub execution_amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VoteReceipt {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub votes: u32,
    pub paid_lamports: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct ProposalArgs {
    pub action: ActionKind,
    pub target: Pubkey,
    pub amount: u64,
    pub maximum_amount: u64,
    pub minimum_output: u64,
    pub max_slippage_bps: u16,
    pub expires_at: i64,
    #[max_len(64)]
    pub title: String,
    #[max_len(192)]
    pub rationale: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct SafetyConfig {
    pub universal_action_limit_bps: u16,
    pub external_transfer_limit_bps: u16,
    pub max_slippage_bps: u16,
    pub max_oracle_staleness_seconds: u32,
    pub rolling_transfer_limit_bps: u16,
}
impl SafetyConfig {
    fn validate(&self) -> Result<()> {
        require!(
            self.universal_action_limit_bps > 0 && self.universal_action_limit_bps <= 2500,
            WallError::UnsafeConfig
        );
        require!(
            self.external_transfer_limit_bps <= 500,
            WallError::UnsafeConfig
        );
        require!(self.max_slippage_bps <= 1000, WallError::UnsafeConfig);
        require!(
            self.max_oracle_staleness_seconds > 0,
            WallError::UnsafeConfig
        );
        require!(
            self.rolling_transfer_limit_bps > 0 && self.rolling_transfer_limit_bps <= 2500,
            WallError::UnsafeConfig
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RoundStatus {
    Open,
    Settled,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ProposalStatus {
    Voting,
    Won,
    Lost,
    FailedSafetyCheck,
    Executed,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ActionKind {
    Hold,
    SwapApprovedAssets,
    BuyApprovedToken,
    SellApprovedToken,
    TransferToApprovedRecipient,
    StakeSol,
    UnstakeSol,
    DepositApprovedLendingProtocol,
    WithdrawApprovedLendingProtocol,
    AddApprovedLiquidity,
    RemoveApprovedLiquidity,
    CreateApprovedLimitOrder,
    CancelApprovedLimitOrder,
    BuybackCommunityToken,
    BurnTreasuryOwnedTokens,
    RebalanceApprovedPortfolio,
}

#[event]
pub struct RoundOpened {
    pub round: u64,
    pub opens_at: i64,
    pub closes_at: i64,
}
#[event]
pub struct ProposalCreated {
    pub round: u64,
    pub proposal: u64,
    pub proposer: Pubkey,
}
#[event]
pub struct VotesPurchased {
    pub round: u64,
    pub proposal: u64,
    pub voter: Pubkey,
    pub votes: u32,
    pub paid_lamports: u64,
}
#[event]
pub struct RoundSettled {
    pub round: u64,
    pub winner: Option<u64>,
    pub votes: u64,
    pub keeper: Pubkey,
}

#[event]
pub struct MintApprovalQueued {
    pub mint: Pubkey,
    pub enabled: bool,
    pub execute_after: i64,
}
#[event]
pub struct MintApprovalApplied {
    pub mint: Pubkey,
    pub enabled: bool,
}
#[event]
pub struct ProposalExecuted {
    pub proposal: Pubkey,
    pub amount: u64,
}
#[event]
pub struct AuthorityTransferQueued {
    pub new_authority: Pubkey,
    pub execute_after: i64,
}
#[event]
pub struct AuthorityTransferred {
    pub new_authority: Pubkey,
}

#[error_code]
pub enum WallError {
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("System is paused")]
    Paused,
    #[msg("Round is closed")]
    RoundClosed,
    #[msg("Round is still open")]
    RoundStillOpen,
    #[msg("Round was already settled")]
    AlreadySettled,
    #[msg("Proposal expired")]
    Expired,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Text is too long")]
    TextTooLong,
    #[msg("Slippage exceeds configured limit")]
    SlippageTooHigh,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Proposal is unavailable")]
    ProposalUnavailable,
    #[msg("Unsafe configuration")]
    UnsafeConfig,
    #[msg("Invalid round transition")]
    InvalidRound,
    #[msg("Administrative timelock is active")]
    TimelockActive,
    #[msg("Proposal is not the winning proposal")]
    NotWinningProposal,
    #[msg("Action exceeds treasury safety limit")]
    ActionLimitExceeded,
    #[msg("Unsupported token program")]
    UnsupportedTokenProgram,
    #[msg("Only native-SOL-paired pump.fun markets are supported")]
    UnsupportedQuoteMint,
    #[msg("Mint owner does not match token program")]
    InvalidMintOwner,
    #[msg("Invalid mint account")]
    InvalidMint,
    #[msg("Mint is not approved")]
    MintNotApproved,
    #[msg("Invalid pump.fun account set")]
    InvalidPumpAccounts,
    #[msg("Invalid pump.fun program")]
    InvalidPumpProgram,
    #[msg("Proposal action is not executable by this handler")]
    UnsupportedExecution,
    #[msg("Invalid treasury token account")]
    InvalidTokenAccount,
    #[msg("Rolling 24-hour outflow limit exceeded")]
    RollingLimitExceeded,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tie_breaks_by_time_then_id() {
        assert!(is_better(4, 10, 2, 4, 11, 1));
        assert!(is_better(4, 10, 1, 4, 10, 2));
        assert!(!is_better(4, 10, 3, 4, 10, 2));
    }
    #[test]
    fn safety_caps_are_enforced() {
        assert!(SafetyConfig {
            universal_action_limit_bps: 2501,
            external_transfer_limit_bps: 500,
            max_slippage_bps: 100,
            max_oracle_staleness_seconds: 60,
            rolling_transfer_limit_bps: 500
        }
        .validate()
        .is_err());
    }
    #[test]
    fn pump_v2_account_counts_match_official_idl() {
        assert_eq!(PUMP_BUY_V2_ACCOUNT_COUNT_WITHOUT_PROGRAM, 26);
        assert_eq!(PUMP_SELL_V2_ACCOUNT_COUNT_WITHOUT_PROGRAM, 25);
    }

    #[test]
    fn proposal_amounts_are_action_specific() {
        assert!(validate_proposal_amounts(ActionKind::Hold, 0, 0, 0).is_ok());
        assert!(validate_proposal_amounts(ActionKind::BuyApprovedToken, 1, 10, 0).is_ok());
        assert!(validate_proposal_amounts(ActionKind::SellApprovedToken, 10, 0, 1).is_ok());
        assert!(validate_proposal_amounts(ActionKind::StakeSol, 1, 1, 1).is_err());
    }
}
