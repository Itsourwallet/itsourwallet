/* eslint-disable @typescript-eslint/no-explicit-any -- Anchor account namespaces are generated at runtime from the committed IDL. */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnchorProvider, BN, Idl, Program } from '@coral-xyz/anchor';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import idl from './onchain-idl.json';
import {
  executePumpWinner,
  normalTokenAmountToBaseUnits,
  quotePumpBuyAmount,
  validatePumpToken,
} from './pump-execution';

type ProposalView = { publicKey: PublicKey; account: any };

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
  const [canSkipWinner, setCanSkipWinner] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [action, setAction] = useState<'hold' | 'buy' | 'sell'>('hold');
  const [mint, setMint] = useState('');
  const [amount, setAmount] = useState('');
  const [limit, setLimit] = useState('');

  const program = useMemo(() => {
    if (!wallet) return undefined;
    const configured = process.env.NEXT_PUBLIC_PUBLIC_WALLET_PROGRAM_ID;
    if (!configured) return undefined;
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    return new Program({ ...(idl as Idl), address: configured } as Idl, provider) as Program & any;
  }, [connection, wallet]);

  const refreshPageBalances = () => window.dispatchEvent(new Event('public-wallet:refresh'));

  const refresh = useCallback(async () => {
    setObservedAt(Math.floor(Date.now() / 1000));
    if (!program) { setProposals([]); setRoundState(undefined); setMaxBuySol(undefined); return; }
    try {
      const [treasury] = PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], program.programId);
      const state = await program.account.treasury.fetchNullable(treasury);
      if (!state) { setProposals([]); setRoundState(undefined); setMaxBuySol(undefined); return; }
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program.programId);
      const vaultLamports = await connection.getBalance(vault, 'confirmed');
      setMaxBuySol(calculateBuyCapLamports(state, vaultLamports) / 1_000_000_000);
      const number = state.roundNumber as BN;
      const [currentRound] = PublicKey.findProgramAddressSync([
        new TextEncoder().encode('round'), treasury.toBuffer(), Uint8Array.from(number.toArray('le', 8)),
      ], program.programId);
      setRound(currentRound);
      setRoundState(await program.account.round.fetch(currentRound));
      const rows = await program.account.proposal.all([{ memcmp: { offset: 8, bytes: currentRound.toBase58() } }]);
      setProposals(rows.sort((a: ProposalView, b: ProposalView) => Number(b.account.votes.sub(a.account.votes))));
    } catch (error) {
      setNotice(readError(error));
    }
  }, [program]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 12_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const submit = async () => {
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
      const target = action === 'hold' ? PublicKey.default : new PublicKey(mint.trim());
      if (action !== 'hold') {
        await validatePumpToken(connection, target);
      }
      const quoteLamports = action === 'hold' ? new BN(0) : solToLamports(limit);
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
          : await normalTokenAmountToBaseUnits(connection, target, amount);
      const actionValue = action === 'hold' ? { hold: {} } : action === 'buy' ? { buyApprovedToken: {} } : { sellApprovedToken: {} };
      await program.methods.createProposal({
        action: actionValue,
        target,
        amount: rawAmount,
        maximumAmount: action === 'buy' ? quoteLamports : new BN(0),
        minimumOutput: action === 'sell' ? quoteLamports : new BN(0),
        maxSlippageBps: 500,
        expiresAt: (roundState.closesAt as BN).add(new BN(600)),
        title: title.trim(),
        rationale: rationale.trim(),
      }).accounts({ proposer: wallet.publicKey, treasury, round: currentRound, vault, proposal, systemProgram: SystemProgram.programId }).rpc();
      setTitle(''); setRationale(''); setMint(''); setAmount(''); setLimit(''); setOpen(false);
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
      if (winnerId && !skipWinner) {
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
      setNotice(skipWinner ? 'Rejected winner skipped. The next round is open.' : winnerId ? 'Winner certified. The next round is open.' : 'Empty round archived. Fresh nonsense is welcome.');
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

  return <div className="wall-actions">
    <p className="vote-help"><b>HOW TO VOTE</b><span>Every live proposal has a +1 VOTE button. One vote starts at 0.01 SOL.</span></p>
    {roundEnded && <div className="round-ended-banner" role="status"><b>{expiredWinner ? 'WINNER EXPIRED' : 'ROUND ENDED'}</b><span>{expiredWinner ? 'The trade can no longer execute. Skip it to open the next round.' : 'Voting is closed. Settle the winner and open the next round.'}</span></div>}
    {roundEnded && <button className="pitch-button advance-button" type="button" disabled={Boolean(busy)} onClick={() => void advanceRound()}>{busy === 'advance' ? 'CHECKING WINNER…' : 'SETTLE & START NEXT ROUND'}</button>}
    {roundEnded && (canSkipWinner || expiredWinner) && <button className="skip-winner-button" type="button" disabled={Boolean(busy)} onClick={() => void advanceRound(true)}>SKIP REJECTED WINNER & START NEXT ROUND</button>}
    {proposals.length === 0 ? <div className="empty compact"><strong>☻</strong><h3>THE CROWD IS QUIET</h3><p>No proposals in this on-chain round.</p></div> : proposals.map(({ publicKey, account }) =>
      <article className="proposal-card" key={publicKey.toBase58()}>
        <small>{actionName(account.action)} · {short(publicKey.toBase58())}</small>
        <h3>{account.title}</h3><p>{account.rationale || 'No manifesto supplied.'}</p>
        <div><b>{account.votes.toString()} VOTES</b><button type="button" disabled={Boolean(busy) || Boolean(roundEnded)} onClick={() => void vote(publicKey)}>{roundEnded ? 'VOTING CLOSED' : busy === publicKey.toBase58() ? 'SIGNING…' : '+ 1 VOTE · FROM 0.01 SOL'}</button></div>
      </article>)}
    {!roundEnded && (!open ? <button className="pitch-button" type="button" onClick={() => setOpen(true)}>+ PITCH AN IDEA · FROM 0.1 SOL</button> :
      <div className="proposal-form">
        <label>THE MOVE<select value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="hold">Hold / do nothing</option><option value="buy">Buy Pump.fun token</option><option value="sell">Sell Pump.fun token</option></select></label>
        <label>HEADLINE<input maxLength={64} value={title} onChange={event => setTitle(event.target.value)} placeholder="Buy the frog, responsibly"/></label>
        <label>THE PITCH<textarea maxLength={192} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Why should strangers approve this?"/></label>
        {action !== 'hold' && <><label>TOKEN MINT<input value={mint} onChange={event => setMint(event.target.value)} placeholder="Solana mint address"/></label>{action === 'sell' && <label>TOKENS TO SELL<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="100"/></label>}<label>{action === 'buy' ? 'MAX SOL TO SPEND' + (maxBuySol === undefined ? '' : ' · CURRENT LIMIT ' + maxBuySol.toFixed(4)) : 'MIN SOL TO RECEIVE'}<input inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} placeholder="0.05"/></label></>}
        <div><button type="button" className="secondary" onClick={() => setOpen(false)}>NEVER MIND</button><button type="button" className="pitch-button" disabled={Boolean(busy)} onClick={() => void submit()}>{busy === 'proposal' ? 'ASKING WALLET…' : 'PUT IT ON-CHAIN'}</button></div>
      </div>)}
    {notice && <p className="chain-notice" role="status">{notice}</p>}
  </div>;
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
function actionName(action: Record<string, unknown>) { if ('buyApprovedToken' in action) return 'BUY PUMP.FUN TOKEN'; if ('sellApprovedToken' in action) return 'SELL PUMP.FUN TOKEN'; return 'HOLD'; }
