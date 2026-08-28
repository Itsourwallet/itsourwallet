/* eslint-disable @typescript-eslint/no-explicit-any -- Anchor account namespaces are generated at runtime from the committed IDL. */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnchorProvider, BN, Idl, Program } from '@coral-xyz/anchor';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from './onchain-idl.json';
import {
  executePumpWinner,
  executeTransferWinner,
  normalTokenAmountToBaseUnits,
  quotePumpBuyAmount,
  quotePumpSellMinimum,
  validatePumpToken,
} from './pump-execution';

type ProposalView = { publicKey: PublicKey; account: any };

const KEEPER_ADDRESS = new PublicKey(process.env.NEXT_PUBLIC_KEEPER_ADDRESS || 'DErudid3kspiPZSteJXK9VJByZxv22eNJb7Ap6Z6TEKQ');
const KEEPER_MIN_LAMPORTS = 20_000_000;

export function WallActions() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [round, setRound] = useState<PublicKey>();
  const [roundState, setRoundState] = useState<any>();
  const [observedAt, setObservedAt] = useState(0);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [maxBuySol, setMaxBuySol] = useState<number>();
  const [keeperHasGas, setKeeperHasGas] = useState<boolean>();
  const [canSkipWinner, setCanSkipWinner] = useState(false);
  const [sendMaximum, setSendMaximum] = useState<{ display: string; baseUnits: string }>();
  const [sellMaximum, setSellMaximum] = useState<{ display: string; baseUnits: string }>();
  const [sellMinimumSol, setSellMinimumSol] = useState<string>();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [action, setAction] = useState<'hold' | 'buy' | 'sell' | 'sendSol' | 'sendToken'>('hold');
  const [mint, setMint] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [limit, setLimit] = useState('');

  const program = useMemo(() => {
    const advanceRound = async (skipWinner = false) => {
    if (!program || !wallet || !round) return;
    setBusy('advance'); setNotice('');
    try {
      const programId = program.programId as PublicKey;
      const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], programId);
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], programId);
      let liveRound = await program.account.round.fetch(round);
      if ('open' in liveRound.status) {
        if (Math.floor(Date.now() / 1000) < Number(liveRound.closesAt.toString())) throw new Error('This round is still collecting bad ideas.');
        await program.methods.settleRound().accounts({ keeper: wallet.publicKey, treasury, round }).rpc();
        liveRound = await program.account.round.fetch(round);
      }

      const winnerId = liveRound.winningProposal as BN | null;
      if (winnerId !== null && winnerId !== undefined && !skipWinner) {
        const [winner] = PublicKey.findProgramAddressSync([
          new TextEncoder().encode('proposal'), round.toBuffer(), Uint8Array.from(winnerId.toArray('le', 8)),
        ], programId);
        let winnerState = await program.account.proposal.fetch(winner);
        if ('voting' in winnerState.status) {
          await program.methods.markWinner().accounts({ keeper: wallet.publicKey, treasury, round, proposal: winner }).rpc();
          winnerState = await program.account.proposal.fetch(winner);
        }
        if ('won' in winnerState.status) {
          if ('hold' in winnerState.action) {
            await program.methods.executeHold().accounts({ keeper: wallet.publicKey, treasury, round, proposal: winner }).rpc();
          } else if ('transferToApprovedRecipient' in winnerState.action) {
            await executeTransferWinner({ connection, program, keeper: wallet.publicKey, treasury, round, vault, proposal: winner, proposalState: winnerState });
          } else {
            await executePumpWinner({ connection, program, keeper: wallet.publicKey, treasury, round, vault, proposal: winner, proposalState: winnerState });
          }
        }
      }

      const treasuryState = await program.account.treasury.fetch(treasury);
      if ((treasuryState.roundNumber as BN).eq(liveRound.number as BN)) {
        const nextNumber = (liveRound.number as BN).add(new BN(1));
        const [nextRound] = PublicKey.findProgramAddressSync([
          new TextEncoder().encode('round'), treasury.toBuffer(), Uint8Array.from(nextNumber.toArray('le', 8)),
        ], programId);
        await program.methods.openNextRound().accounts({
          keeper: wallet.publicKey, treasury, previousRound: round, round: nextRound, systemProgram: SystemProgram.programId,
        }).rpc();
      }
      setCanSkipWinner(false);
      setNotice(skipWinner ? 'Rejected winner skipped. The next round is open.' : winnerId !== null && winnerId !== undefined ? 'Winner certified. The next round is open.' : 'Empty round archived. Fresh nonsense is welcome.');
      await refresh();
      refreshPageBalances();
    } catch (error) {
      const message = readError(error);
      if (message.includes('treasury safety limit') || message.includes('expired') || message.includes('graduated')) {
        setCanSkipWinner(true);
        setNotice(message + ' The trade did not happen. You may now skip this rejected winner and open the next round.');
      } else {
        setNotice(message);
      }
    }
    finally { setBusy(''); }
  };

  if (!wallet) return undefined;
    const configured = process.env.NEXT_PUBLIC_PUBLIC_WALLET_PROGRAM_ID;
    if (!configured) return undefined;
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    return new Program({ ...(idl as Idl), address: configured } as Idl, provider) as Program & any;
  }, [connection, wallet]);

  const refreshPageBalances = () => window.dispatchEvent(new Event('public-wallet:refresh'));

  const refresh = useCallback(async () => {
    setObservedAt(Math.floor(Date.now() / 1000));
    if (!program) { setProposals([]); setRoundState(undefined); setMaxBuySol(undefined); setKeeperHasGas(undefined); return; }
    try {
      const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], program.programId);
      const state = await program.account.treasury.fetchNullable(treasury);
      if (!state) { setProposals([]); setRoundState(undefined); setMaxBuySol(undefined); setKeeperHasGas(undefined); return; }
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program.programId);
      const [vaultLamports, keeperLamports] = await Promise.all([
        connection.getBalance(vault, 'confirmed'),
        connection.getBalance(KEEPER_ADDRESS, 'confirmed'),
      ]);
      setMaxBuySol(calculateBuyCapLamports(state, vaultLamports) / 1_000_000_000);
      setKeeperHasGas(keeperLamports >= KEEPER_MIN_LAMPORTS);
      const number = state.roundNumber as BN;
      const [currentRound] = PublicKey.findProgramAddressSync([
        new TextEncoder().encode('round'), treasury.toBuffer(), Uint8Array.from(number.toArray('le', 8)),
      ], program.programId);
      setRound(currentRound);
      setRoundState(await program.account.round.fetch(currentRound));
      const rows = await program.account.proposal.all([{ memcmp: { offset: 8, bytes: currentRound.toBase58() } }]);
      const hydrated = await Promise.all(rows.map(async (row: ProposalView) => {
        if (!('transferToApprovedRecipient' in row.account.action)) return row;
        const [intent] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode('transfer-intent'), row.publicKey.toBuffer()],
          program.programId,
        );
        const transfer = await program.account.transferIntent.fetchNullable(intent);
        return { ...row, account: { ...row.account, transfer } };
      }));
      setProposals(hydrated.sort((a: ProposalView, b: ProposalView) => Number(b.account.votes.sub(a.account.votes))));
    } catch (error) {
      setNotice(readError(error));
    }
  }, [program, connection]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    if (!open || !program || (action !== 'sendSol' && action !== 'sendToken')) {
      setSendMaximum(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchSendMaximum(connection, program, action, mint).then(value => {
        if (!cancelled) setSendMaximum(value);
      }).catch(() => {
        if (!cancelled) setSendMaximum(undefined);
      });
    }, action === 'sendToken' ? 350 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [action, connection, mint, open, program]);
  useEffect(() => {
    let cancelled = false;
    if (!open || !program || action !== 'sell' || !mint.trim()) {
      setSellMaximum(undefined); setSellMinimumSol(undefined); return;
    }
    const timer = window.setTimeout(() => {
      void fetchSellMaximum(connection, program, mint).then(async maximum => {
        if (cancelled) return;
        setSellMaximum(maximum);
        if (!amount.trim()) { setSellMinimumSol(undefined); return; }
        const target = new PublicKey(mint.trim());
        const rawAmount = await normalTokenAmountToBaseUnits(connection, target, amount);
        const minimum = await quotePumpSellMinimum(connection, target, rawAmount);
        if (!cancelled) setSellMinimumSol(formatSol(minimum));
      }).catch(() => { if (!cancelled) { setSellMaximum(undefined); setSellMinimumSol(undefined); } });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [action, amount, connection, mint, open, program]);  const submit = async () => {
    if (!program || !wallet) { setNotice('Connect a wallet first.'); return; }
    if (roundState && (!('open' in roundState.status) || Math.floor(Date.now() / 1000) >= Number(roundState.closesAt.toString()))) {
      setOpen(false);
      setNotice('This round is over. Start the next round first.');
      return;
    }
    setBusy('proposal'); setNotice('');
    try {
      if (!title.trim()) throw new Error('Give the idea a title.');
      const programId = program.programId as PublicKey;
      const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], programId);
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], programId);
      const treasuryState = await program.account.treasury.fetch(treasury);
      const number = treasuryState.roundNumber as BN;
      const [currentRound] = PublicKey.findProgramAddressSync([
        new TextEncoder().encode('round'), treasury.toBuffer(), Uint8Array.from(number.toArray('le', 8)),
      ], programId);
      const roundState = await program.account.round.fetch(currentRound);
      const id = roundState.proposalCount as BN;
      const [proposal] = PublicKey.findProgramAddressSync([
        new TextEncoder().encode('proposal'), currentRound.toBuffer(), Uint8Array.from(id.toArray('le', 8)),
      ], programId);
      const isSend = action === 'sendSol' || action === 'sendToken';
      const target = action === 'hold' || action === 'sendSol' ? PublicKey.default : new PublicKey(mint.trim());
      const recipientKey = isSend ? new PublicKey(recipient.trim()) : PublicKey.default;
      if (action === 'buy' || action === 'sell') await validatePumpToken(connection, target);
      if (action === 'sendToken') {
        const mintInfo = await connection.getAccountInfo(target, 'confirmed');
        if (!mintInfo) throw new Error('This token mint does not exist.');
      }

      const quoteLamports = action === 'buy' ? solToLamports(limit) : new BN(0);
      if (action === 'buy') {
        const vaultLamports = await connection.getBalance(vault, 'confirmed');
        const buyCap = new BN(calculateBuyCapLamports(treasuryState, vaultLamports));
        if (quoteLamports.gt(buyCap)) {
          throw new Error('This treasury can currently spend at most ' + formatSol(buyCap) + ' SOL on one buy. Lower the amount.');
        }
      }
      const rawAmount = action === 'hold'
        ? new BN(0)
        : action === 'buy'
          ? await quotePumpBuyAmount(connection, target, quoteLamports)
          : action === 'sendSol'
            ? solToLamports(amount)
            : await normalTokenAmountToBaseUnits(connection, target, amount);
      if (isSend) {
        const maximum = await fetchSendMaximum(connection, program, action, mint);
        if (rawAmount.gt(new BN(maximum.baseUnits))) {
          throw new Error(`The most this proposal can send right now is ${maximum.display} ${action === 'sendSol' ? 'SOL' : 'tokens'}.`);
        }
      }
      let sellMinimumOutput = new BN(0);
      if (action === 'sell') {
        const maximum = await fetchSellMaximum(connection, program, mint);
        if (rawAmount.gt(new BN(maximum.baseUnits))) throw new Error(`The most this proposal can sell right now is ${maximum.display} tokens.`);
        sellMinimumOutput = await quotePumpSellMinimum(connection, target, rawAmount);
      }
      const actionValue = action === 'hold'
        ? { hold: {} }
        : action === 'buy'
          ? { buyApprovedToken: {} }
          : action === 'sell'
            ? { sellApprovedToken: {} }
            : { transferToApprovedRecipient: {} };
      const args = {
        action: actionValue,
        target,
        amount: rawAmount,
        maximumAmount: action === 'buy' ? quoteLamports : new BN(0),
        minimumOutput: sellMinimumOutput,
        maxSlippageBps: action === 'buy' || action === 'sell' ? 500 : 0,
        expiresAt: (roundState.closesAt as BN).add(new BN(600)),
        title: title.trim(),
        rationale: rationale.trim(),
      };
      if (isSend) {
        const [transferIntent] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode('transfer-intent'), proposal.toBuffer()],
          programId,
        );
        await program.methods.createTransferProposal(args, recipientKey, action === 'sendSol').accounts({
          proposer: wallet.publicKey,
          treasury,
          round: currentRound,
          vault,
          proposal,
          transferIntent,
          systemProgram: SystemProgram.programId,
        }).rpc();
      } else {
        await program.methods.createProposal(args).accounts({
          proposer: wallet.publicKey,
          treasury,
          round: currentRound,
          vault,
          proposal,
          systemProgram: SystemProgram.programId,
        }).rpc();
      }      setTitle(''); setRationale(''); setMint(''); setRecipient(''); setAmount(''); setLimit(''); setOpen(false);
      setNotice('Idea is on-chain. The crowd may now yell with money.');
      await refresh();
      refreshPageBalances();
    } catch (error) { setNotice(readError(error)); }
    finally { setBusy(''); }
  };

  const vote = async (proposal: PublicKey) => {
    if (!program || !wallet || !round) return;
    setBusy(proposal.toBase58()); setNotice('');
    try {
      const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], program.programId);
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program.programId);
      const [receipt] = PublicKey.findProgramAddressSync([
        new TextEncoder().encode('vote'), proposal.toBuffer(), wallet.publicKey.toBuffer(),
      ], program.programId);
      await program.methods.buyVotes(1).accounts({
        voter: wallet.publicKey, treasury, round, vault, proposal, receipt, systemProgram: SystemProgram.programId,
      }).rpc();
      setNotice('Vote purchased. Democracy remains financially irresponsible.');
      await refresh();
      refreshPageBalances();
    } catch (error) { setNotice(readError(error)); }
    finally { setBusy(''); }
  };


  const advanceRound = async (skipWinner = false) => {
    if (!program || !wallet || !round) return;
    setBusy('advance'); setNotice('');
    try {
      const programId = program.programId as PublicKey;
      const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], programId);
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], programId);
      let liveRound = await program.account.round.fetch(round);
      if ('open' in liveRound.status) {
        if (Math.floor(Date.now() / 1000) < Number(liveRound.closesAt.toString())) throw new Error('This round is still collecting bad ideas.');
        await program.methods.settleRound().accounts({ keeper: wallet.publicKey, treasury, round }).rpc();
        liveRound = await program.account.round.fetch(round);
      }

      const winnerId = liveRound.winningProposal as BN | null;
      if (winnerId !== null && winnerId !== undefined && !skipWinner) {
        const [winner] = PublicKey.findProgramAddressSync([
          new TextEncoder().encode('proposal'), round.toBuffer(), Uint8Array.from(winnerId.toArray('le', 8)),
        ], programId);
        let winnerState = await program.account.proposal.fetch(winner);
        if ('voting' in winnerState.status) {
          await program.methods.markWinner().accounts({ keeper: wallet.publicKey, treasury, round, proposal: winner }).rpc();
          winnerState = await program.account.proposal.fetch(winner);
        }
        if ('won' in winnerState.status) {
          if ('hold' in winnerState.action) {
            await program.methods.executeHold().accounts({ keeper: wallet.publicKey, treasury, round, proposal: winner }).rpc();
          } else if ('transferToApprovedRecipient' in winnerState.action) {
            await executeTransferWinner({ connection, program, keeper: wallet.publicKey, treasury, round, vault, proposal: winner, proposalState: winnerState });
          } else {
            await executePumpWinner({ connection, program, keeper: wallet.publicKey, treasury, round, vault, proposal: winner, proposalState: winnerState });
          }
        }
      }

      const treasuryState = await program.account.treasury.fetch(treasury);
      if ((treasuryState.roundNumber as BN).eq(liveRound.number as BN)) {
        const nextNumber = (liveRound.number as BN).add(new BN(1));
        const [nextRound] = PublicKey.findProgramAddressSync([
          new TextEncoder().encode('round'), treasury.toBuffer(), Uint8Array.from(nextNumber.toArray('le', 8)),
        ], programId);
        await program.methods.openNextRound().accounts({
          keeper: wallet.publicKey, treasury, previousRound: round, round: nextRound, systemProgram: SystemProgram.programId,
        }).rpc();
      }
      setCanSkipWinner(false);
      setNotice(skipWinner ? 'Rejected winner skipped. The next round is open.' : winnerId !== null && winnerId !== undefined ? 'Winner certified. The next round is open.' : 'Empty round archived. Fresh nonsense is welcome.');
      await refresh();
      refreshPageBalances();
    } catch (error) {
      const message = readError(error);
      if (message.includes('treasury safety limit') || message.includes('expired') || message.includes('graduated')) {
        setCanSkipWinner(true);
        setNotice(message + ' The trade did not happen. You may now skip this rejected winner and open the next round.');
      } else {
        setNotice(message);
      }
    }
    finally { setBusy(''); }
  };

  if (!wallet) return <div className="empty"><strong>☻</strong><h3>WALLET FIRST</h3><p>Join the crowd above to pitch or vote.</p></div>;
  if (!program) return <div className="empty"><strong>!</strong><h3>PROGRAM NOT CONFIGURED</h3><p>The site refuses to invent transactions.</p></div>;

  const roundEnded = roundState && (!('open' in roundState.status) || observedAt >= Number(roundState.closesAt.toString()));
  const expiredWinner = Boolean(
    roundEnded
      && roundState?.winningProposal !== null
      && roundState?.winningProposal !== undefined
      && proposals.some(({ account }) =>
        (account.id as BN).eq(roundState.winningProposal as BN)
        && 'won' in account.status
        && observedAt > Number((account.expiresAt as BN).toString()),
      ),
  );
  const winningProposal = roundEnded && roundState?.winningProposal !== null && roundState?.winningProposal !== undefined
    ? proposals.find(({ account }) => (account.id as BN).eq(new BN(roundState.winningProposal.toString())))
    : undefined;
  const winnerExecuted = Boolean(winningProposal && 'executed' in winningProposal.account.status);
  const hasRecordedWinner = roundState?.winningProposal !== null && roundState?.winningProposal !== undefined;
  const completedRoundMessage = winningProposal
    ? `Winner: ${winningProposal.account.title}. ${winnerExecuted ? 'The action is confirmed on-chain.' : 'The keeper is executing it now.'} The next round opens in about 10 seconds.`
    : hasRecordedWinner
      ? 'A winner was selected on-chain. Loading its details while the keeper executes it.'
      : 'No proposals were submitted in this round. The next round opens in about 10 seconds.';

  return <div className="wall-actions">
    <p className="vote-help"><b>HOW TO VOTE</b><span>Every live proposal has a +1 VOTE button. One vote starts at 0.01 SOL.</span></p>
    {roundEnded && keeperHasGas !== false && <div className="round-ended-banner keeper-settling" role="status"><b>{winnerExecuted ? 'WINNER EXECUTED' : keeperHasGas === undefined ? 'CHECKING KEEPER' : winningProposal ? 'WE HAVE A WINNER' : 'ROUND ENDED'}</b><span>{completedRoundMessage}</span></div>}
    {roundEnded && keeperHasGas === false && <div className="round-ended-banner keeper-empty" role="status"><b>KEEPER NEEDS GAS</b><span>The automatic keeper is below 0.02 SOL. Any connected user can safely finish this round.</span></div>}
    {roundEnded && keeperHasGas === false && <button className="pitch-button advance-button" type="button" disabled={Boolean(busy)} onClick={() => void advanceRound()}>{busy === 'advance' ? 'CHECKING WINNER…' : 'SETTLE & START NEXT ROUND'}</button>}
    {roundEnded && keeperHasGas === false && (canSkipWinner || expiredWinner) && <button className="skip-winner-button" type="button" disabled={Boolean(busy)} onClick={() => void advanceRound(true)}>SKIP REJECTED WINNER & START NEXT ROUND</button>}
    {proposals.length === 0 ? (!open && <div className="empty compact"><strong>☻</strong><h3>THE CROWD IS QUIET</h3><p>No proposals in this on-chain round.</p></div>) : proposals.map(({ publicKey, account }) =>
      <article className="proposal-card" key={publicKey.toBase58()}>
        <small>{actionName(account.action)} · {short(publicKey.toBase58())}</small>
        <h3>{account.title}</h3><p>{account.rationale || 'No manifesto supplied.'}</p><p className="proposal-details">{proposalDetails(account)}</p>
        <div><b>{account.votes.toString()} VOTES</b><button type="button" disabled={Boolean(busy) || Boolean(roundEnded)} onClick={() => void vote(publicKey)}>{roundEnded ? 'VOTING CLOSED' : busy === publicKey.toBase58() ? 'SIGNING…' : '+ 1 VOTE · FROM 0.01 SOL'}</button></div>
      </article>)}
    {!roundEnded && (!open ? <button className="pitch-button" type="button" onClick={() => setOpen(true)}>+ PITCH AN IDEA · FROM 0.1 SOL</button> :
      <div className="proposal-form">
        <label>THE MOVE<select value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="hold">Hold / do nothing</option><option value="buy">Buy any Pump.fun token</option><option value="sell">Sell any Pump.fun token</option><option value="sendSol">Send SOL</option><option value="sendToken">Send a treasury token</option></select></label>
        <label>HEADLINE<input maxLength={64} value={title} onChange={event => setTitle(event.target.value)} placeholder="Send it where the crowd says"/></label>
        <label>THE PITCH<textarea maxLength={192} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Why should strangers approve this?"/></label>
        {(action === 'buy' || action === 'sell' || action === 'sendToken') && <label>TOKEN MINT<input value={mint} onChange={event => setMint(event.target.value)} placeholder="Solana mint address"/></label>}
        {(action === 'sendSol' || action === 'sendToken') && <label>RECIPIENT WALLET<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="Solana wallet address"/></label>}
        {(action === 'sell' || action === 'sendSol' || action === 'sendToken') && <label>{action === 'sell' ? 'TOKENS TO SELL' : action === 'sendSol' ? 'SOL TO SEND' : 'TOKENS TO SEND'}
          <span className="amount-row"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder={action === 'sendSol' ? '0.01' : '100'}/>{action === 'sell' ? <button className="max-button" type="button" disabled={!sellMaximum} onClick={() => sellMaximum && setAmount(sellMaximum.display)}>MAX</button> : <button className="max-button" type="button" disabled={!sendMaximum} onClick={() => sendMaximum && setAmount(sendMaximum.display)}>MAX</button>}</span>
          {action === 'sell' && <small className="send-max">MAXIMUM NOW · {sellMaximum ? `${sellMaximum.display} TOKENS · 25% OF TREASURY BALANCE` : mint.trim() ? 'CALCULATING…' : 'ENTER A TOKEN MINT'}{sellMinimumSol ? ` · MINIMUM RETURN ${sellMinimumSol} SOL` : ''}</small>}
          {(action === 'sendSol' || action === 'sendToken') && <small className="send-max">MAXIMUM NOW · {sendMaximum ? `${sendMaximum.display} ${action === 'sendSol' ? 'SOL' : 'TOKENS'} · 5% OF TREASURY BALANCE` : action === 'sendToken' && !mint.trim() ? 'ENTER A TOKEN MINT' : 'CALCULATING…'}</small>}
        </label>}
        {action === 'buy' && <label>{'MAX SOL TO SPEND' + (maxBuySol === undefined ? '' : ' · CURRENT LIMIT ' + maxBuySol.toFixed(4))}<input inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} placeholder="0.05"/></label>}
        <div><button type="button" className="secondary" onClick={() => setOpen(false)}>NEVER MIND</button><button type="button" className="pitch-button" disabled={Boolean(busy)} onClick={() => void submit()}>{busy === 'proposal' ? 'ASKING WALLET…' : 'PUT IT ON-CHAIN'}</button></div>
      </div>)}
    {notice && <p className="chain-notice" role="status">{notice}</p>}
  </div>;
}

async function fetchSendMaximum(connection: any, program: any, action: 'sendSol' | 'sendToken', mintValue: string) {
  const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program.programId);
  const state = await program.account.treasury.fetch(treasury);
  const config = state.config as any;
  const bps = BigInt(config.externalTransferLimitBps ?? config.external_transfer_limit_bps);
  if (action === 'sendSol') {
    const balance = BigInt(await connection.getBalance(vault, 'confirmed'));
    const cap = balance * bps / BigInt(10_000);
    return { display: formatBaseUnits(cap, 9), baseUnits: cap.toString() };
  }
  const mint = new PublicKey(mintValue.trim());
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new Error('This token mint is not supported.');
  }
  const source = getAssociatedTokenAddressSync(mint, vault, true, mintInfo.owner);
  const balance = await connection.getTokenAccountBalance(source, 'confirmed');
  const cap = BigInt(balance.value.amount) * bps / BigInt(10_000);
  return { display: formatBaseUnits(cap, balance.value.decimals), baseUnits: cap.toString() };
}

function formatBaseUnits(value: bigint, decimals: number) {
  if (decimals === 0) return value.toString();
  const padded = value.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
async function fetchSellMaximum(connection: any, program: any, mintValue: string) {
  const mint = new PublicKey(mintValue.trim());
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error('This token mint is invalid.');
  const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program.programId);
  const state = await program.account.treasury.fetch(treasury);
  const config = state.config as any;
  const bps = BigInt(config.universalActionLimitBps ?? config.universal_action_limit_bps);
  const source = getAssociatedTokenAddressSync(mint, vault, true, mintInfo.owner);
  const balance = await connection.getTokenAccountBalance(source, 'confirmed');
  const cap = BigInt(balance.value.amount) * bps / BigInt(10_000);
  return { display: formatBaseUnits(cap, balance.value.decimals), baseUnits: cap.toString() };
}
function calculateBuyCapLamports(treasuryState: any, vaultLamports: number) {
  const actionBps = Number(treasuryState.config.universalActionLimitBps);
  const actionCap = Math.floor(vaultLamports * actionBps / 10_000);
  const rollingBps = Number(treasuryState.config.rollingTransferLimitBps);
  const rollingCap = Math.floor(vaultLamports * rollingBps / 10_000);
  const windowStarted = Number((treasuryState.rollingWindowStartedAt as BN).toString());
  const spent = Math.floor(Date.now() / 1000) - windowStarted >= 86_400
    ? 0
    : Number((treasuryState.rollingSpentLamports as BN).toString());
  return Math.max(0, Math.min(actionCap, rollingCap - spent));
}
function formatSol(lamports: BN) { return (Number(lamports.toString()) / 1_000_000_000).toFixed(4); }
function solToLamports(value: string) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('SOL limit must be positive.'); return new BN(Math.round(parsed * 1_000_000_000)); }
function readError(error: unknown) {
  const message = error instanceof Error ? error.message.replace(/^AnchorError.*?Error Message: /, '') : 'Transaction failed.';
  if (message.includes('was not confirmed in 30.00 seconds')) return 'The transaction did not confirm in time. No confirmed transaction was found yet; wait a moment, refresh, then try once more.';
  return message;
}
function short(value: string) { return `${value.slice(0, 4)}…${value.slice(-4)}`; }
function proposalDetails(account: any) {
  if ('transferToApprovedRecipient' in account.action) {
    const recipient = account.transfer?.recipient?.toBase58?.() ?? 'recipient unavailable';
    const asset = account.transfer?.nativeSol ? 'SOL' : short(account.target.toBase58());
    return `SEND ${asset} · TO ${short(recipient)}`;
  }
  if ('buyApprovedToken' in account.action || 'sellApprovedToken' in account.action) {
    return `TOKEN · ${short(account.target.toBase58())}`;
  }
  return 'NO FUNDS MOVE';
}function actionName(action: Record<string, unknown>) { if ('buyApprovedToken' in action) return 'BUY PUMP.FUN TOKEN'; if ('sellApprovedToken' in action) return 'SELL PUMP.FUN TOKEN'; if ('transferToApprovedRecipient' in action) return 'SEND'; return 'HOLD'; }
