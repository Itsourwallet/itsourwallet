/* eslint-disable @typescript-eslint/no-explicit-any -- Anchor program namespaces are generated from the committed IDL. */
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
} from '@pump-fun/pump-sdk';
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
} from '@pump-fun/pump-swap-sdk';
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

type ProposalState = {
  action: Record<string, unknown>;
  target: PublicKey;
  amount: BN;
  maximumAmount: BN;
  minimumOutput: BN;
};

export async function validatePumpToken(connection: Connection, mint: PublicKey) {
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) throw new Error('This token mint does not exist on Solana mainnet.');
  const tokenProgram = mintInfo.owner;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('This mint is not a supported Solana token.');
  }

  const mintState = await getMint(connection, mint, 'confirmed', tokenProgram);
  const curveInfo = await connection.getAccountInfo(bondingCurvePda(mint), 'confirmed');
  if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID)) {
    throw new Error('This address is not a Pump.fun token.');
  }
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (!curve.complete) return { tokenProgram, mintState, curve, route: 'bonding' as const };

  const pool = canonicalPumpPoolPda(mint, NATIVE_MINT);
  const poolInfo = await connection.getAccountInfo(pool, 'confirmed');
  if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    throw new Error('This graduated Pump.fun token does not have a canonical PumpSwap pool.');
  }
  return { tokenProgram, mintState, curve, route: 'pumpswap' as const, pool };
}
export async function quotePumpBuyAmount(
  connection: Connection,
  mint: PublicKey,
  maximumLamports: BN,
  slippageBps = 500,
) {
  const token = await validatePumpToken(connection, mint);
  if (token.route === 'bonding') {
    const onlineSdk = new OnlinePumpSdk(connection);
    const [global, feeConfig] = await Promise.all([
      onlineSdk.fetchGlobal(),
      onlineSdk.fetchFeeConfig(),
    ]);
    const expected = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: new BN(token.mintState.supply.toString()),
      bondingCurve: token.curve,
      amount: maximumLamports,
      quoteMint: PublicKey.default,
    });
    const protectedAmount = expected.muln(10_000 - slippageBps).divn(10_000);
    if (protectedAmount.isZero()) throw new Error('The SOL budget is too small for this Pump.fun token.');
    return protectedAmount;
  }

  const onlineAmm = new OnlinePumpAmmSdk(connection);
  const state = await onlineAmm.swapSolanaState(token.pool, PublicKey.default);
  const quote = buyQuoteInput({
    quote: maximumLamports,
    slippage: 0,
    baseReserve: state.poolBaseAmount,
    quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves,
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint,
    coinCreator: state.pool.coinCreator,
    creator: state.pool.creator,
    feeConfig: state.feeConfig,
  });
  const protectedAmount = quote.base.muln(10_000 - slippageBps).divn(10_000);
  if (protectedAmount.isZero()) throw new Error('The SOL budget is too small for this PumpSwap pool.');
  return protectedAmount;
}
export async function normalTokenAmountToBaseUnits(
  connection: Connection,
  mint: PublicKey,
  value: string,
) {
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new Error('This mint is not a supported Solana token.');
  }
  const mintState = await getMint(connection, mint, 'confirmed', mintInfo.owner);
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error('Token amount must be a positive number.');
  }
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > mintState.decimals) {
    throw new Error('This token supports at most ' + mintState.decimals + ' decimal places.');
  }
  const baseUnits = new BN(whole)
    .mul(new BN(10).pow(new BN(mintState.decimals)))
    .add(new BN((fraction + '0'.repeat(mintState.decimals)).slice(0, mintState.decimals) || '0'));
  if (baseUnits.isZero()) throw new Error('Token amount must be greater than zero.');
  return baseUnits;
}
export async function executePumpWinner({
  connection,
  program,
  keeper,
  treasury,
  round,
  vault,
  proposal,
  proposalState,
}: {
  connection: Connection;
  program: Program & any;
  keeper: PublicKey;
  treasury: PublicKey;
  round: PublicKey;
  vault: PublicKey;
  proposal: PublicKey;
  proposalState: ProposalState;
}) {
  const mint = proposalState.target;
  const token = await validatePumpToken(connection, mint);
  const isBuy = 'buyApprovedToken' in proposalState.action;
  const baseAta = getAssociatedTokenAddressSync(mint, vault, true, token.tokenProgram);

  if (token.route === 'bonding') {
    const quoteAmount = isBuy ? proposalState.maximumAmount : proposalState.minimumOutput;
    const pumpInstruction = isBuy
      ? await PUMP_SDK.getBuyV2InstructionRaw({
          user: vault,
          mint,
          creator: token.curve.creator,
          amount: proposalState.amount,
          quoteAmount,
          tokenProgram: token.tokenProgram,
        })
      : await PUMP_SDK.getSellV2InstructionRaw({
          user: vault,
          mint,
          creator: token.curve.creator,
          amount: proposalState.amount,
          quoteAmount,
          tokenProgram: token.tokenProgram,
        });

    if (!(await connection.getAccountInfo(baseAta, 'confirmed'))) {
      const provider = program.provider as AnchorProvider;
      await provider.sendAndConfirm(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(keeper, baseAta, vault, mint, token.tokenProgram),
      ));
    }
    const pumpAccounts = pumpInstruction.keys.slice(0, -1).map(meta => ({
      pubkey: meta.pubkey,
      isWritable: meta.isWritable,
      isSigner: false,
    }));
    return program.methods.executePumpTrade().accounts({
      keeper,
      treasury,
      vault,
      round,
      proposal,
      pumpProgram: PUMP_PROGRAM_ID,
    }).remainingAccounts(pumpAccounts).rpc();
  }

  const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  const provider = program.provider as AnchorProvider;
  await provider.sendAndConfirm(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(keeper, baseAta, vault, mint, token.tokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(keeper, quoteAta, vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
  ));

  const onlineAmm = new OnlinePumpAmmSdk(connection);
  const state = await onlineAmm.swapSolanaState(token.pool, vault, baseAta, quoteAta);
  const candidates = isBuy
    ? await PUMP_AMM_SDK.buyInstructions(state, proposalState.amount, proposalState.maximumAmount)
    : await PUMP_AMM_SDK.sellInstructions(state, proposalState.amount, proposalState.minimumOutput);
  const discriminator = isBuy
    ? Buffer.from([102, 6, 61, 18, 1, 218, 235, 234])
    : Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
  const swapInstruction = candidates.find(ix =>
    ix.programId.equals(PUMP_AMM_PROGRAM_ID) && Buffer.from(ix.data).subarray(0, 8).equals(discriminator),
  );
  if (!swapInstruction) throw new Error('PumpSwap did not produce a compatible trade instruction.');

  const swapData = Buffer.from(swapInstruction.data);
  if (isBuy && swapData.length === 25) swapData[24] = 0;

  return program.methods.executePumpSwapTrade([...swapData]).accounts({
    keeper,
    treasury,
    vault,
    round,
    proposal,
    pumpAmmProgram: PUMP_AMM_PROGRAM_ID,
  }).remainingAccounts(swapInstruction.keys.map(meta => ({
    pubkey: meta.pubkey,
    isWritable: meta.isWritable,
    isSigner: false,
  }))).rpc();
}

export async function executeTransferWinner({
  connection,
  program,
  keeper,
  treasury,
  round,
  vault,
  proposal,
  proposalState,
}: {
  connection: Connection;
  program: Program & any;
  keeper: PublicKey;
  treasury: PublicKey;
  round: PublicKey;
  vault: PublicKey;
  proposal: PublicKey;
  proposalState: ProposalState;
}) {
  const [transferIntent] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('transfer-intent'), proposal.toBuffer()],
    program.programId,
  );
  const intent = await program.account.transferIntent.fetch(transferIntent);
  const recipient = intent.recipient as PublicKey;
  if (intent.nativeSol) {
    return program.methods.executeSolTransfer().accounts({
      keeper,
      treasury,
      vault,
      round,
      proposal,
      transferIntent,
      recipient,
      systemProgram: SystemProgram.programId,
    }).rpc();
  }

  const mint = proposalState.target;
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new Error('The proposed token mint is invalid.');
  }
  const tokenProgram = mintInfo.owner;
  const sourceTokenAccount = getAssociatedTokenAddressSync(mint, vault, true, tokenProgram);
  const destinationTokenAccount = getAssociatedTokenAddressSync(mint, recipient, true, tokenProgram);
  const provider = program.provider as AnchorProvider;
  await provider.sendAndConfirm(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      keeper,
      destinationTokenAccount,
      recipient,
      mint,
      tokenProgram,
    ),
  ));
  return program.methods.executeTokenTransfer().accounts({
    keeper,
    treasury,
    vault,
    round,
    proposal,
    transferIntent,
    mint,
    sourceTokenAccount,
    destinationTokenAccount,
    tokenProgram,
  }).rpc();
}