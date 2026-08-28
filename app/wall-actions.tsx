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
  const [sendMaximum, setSendMaximum] = useState<{ display: string; baseUnits: string }>();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [action, setAction] = useState<'hold' | 'buy' | 'sell' | 'sendSol' | 'sendToken'>('hold');
  const [mint, setMint] = useState('');
  const [recipient, setRecipient] = useState('');
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
    const timer = window.setInterval(() => void refresh(), 12_000);
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
      const isSend = action === 'sendSol' || action === 'sendToken';
      const target = action === 'hold' || action === 'sendSol' ? PublicKey.default : new PublicKey(mint.trim());
      const recipientKey = isSend ? new PublicKey(recipient.trim()) : PublicKey.default;
      if (action === 'buy' || action === 'sell') await validatePumpToken(connection, target);
      if (action === 'sendToken') {
        const mintInfo = await connection.getAccountInfo(target, 'confirmed');
        if (!mintInfo) throw new Error('This token mint does not exist.');
      }

      const quoteLamports = action === 'buy' || action === 'sell' ? solToLamports(limit) : new BN(0);
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
      }      const actionValue = action === 'hold'
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
        minimumOutput: action === 'sell' ? quoteLamports : new BN(0),
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


  if (!wallet) return <div className="empty"><strong>☻</strong><h3>WALLET FIRST</h3><p>Join the crowd above to pitch or vote.</p></div>;
  if (!program) return <div className="empty"><strong>!</strong><h3>PROGRAM NOT CONFIGURED</h3><p>The site refuses to invent transactions.</p></div>;

  const roundEnded = roundState && (!('open' in roundState.status) || observedAt >= Number(roundState.closesAt.toString()));

  return <div className="wall-actions">
    <p className="vote-help"><b>HOW TO VOTE</b><span>Every live proposal has a +1 VOTE button. One vote starts at 0.01 SOL.</span></p>
    {roundEnded && <div className="round-ended-banner keeper-settling" role="status"><b>KEEPER IS SETTLING</b><span>Voting is closed. The automatic keeper will execute the winner and open the next round.</span></div>}
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
          <span className="amount-row"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder={action === 'sendSol' ? '0.01' : '100'}/>{(action === 'sendSol' || action === 'sendToken') && <button className="max-button" type="button" disabled={!sendMaximum} onClick={() => sendMaximum && setAmount(sendMaximum.display)}>MAX</button>}</span>
          {(action === 'sendSol' || action === 'sendToken') && <small className="send-max">MAXIMUM NOW · {sendMaximum ? `${sendMaximum.display} ${action === 'sendSol' ? 'SOL' : 'TOKENS'} · 5% OF TREASURY BALANCE` : action === 'sendToken' && !mint.trim() ? 'ENTER A TOKEN MINT' : 'CALCULATING…'}</small>}
        </label>}
        {(action === 'buy' || action === 'sell') && <label>{action === 'buy' ? 'MAX SOL TO SPEND' + (maxBuySol === undefined ? '' : ' · CURRENT LIMIT ' + maxBuySol.toFixed(4)) : 'MIN SOL TO RECEIVE'}<input inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} placeholder="0.05"/></label>}
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
