'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { WallActions } from './wall-actions';

const HIDDEN_TREASURY_TOKEN = '2GKqiJZ6VfipY2JEUp2FPt9Gu3PcE3j2HvCrnKzNA93g';
type TokenHolding = { mint: string; symbol?: string; name?: string; amount: number; priceUsd?: number; valueUsd?: number };
type ChainState = { slot?: number; walletSol?: number; treasury?: PublicKey; treasurySol?: number; treasuryTotalUsd?: number; treasuryTokens?: TokenHolding[]; roundClosesAt?: number; error?: string };

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [now, setNow] = useState(() => Date.now());
  const [chain, setChain] = useState<ChainState>({});
  const seconds = chain.roundClosesAt === undefined ? undefined : Math.max(0, chain.roundClosesAt - Math.floor(now / 1000));

  const refresh = useCallback(async () => {
    try {
      const configured = process.env.NEXT_PUBLIC_PUBLIC_WALLET_PROGRAM_ID;
      const program = configured ? new PublicKey(configured) : undefined;
      const state = program ? PublicKey.findProgramAddressSync([new TextEncoder().encode('treasury')], program)[0] : undefined;
      const vault = program ? PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program)[0] : undefined;
      const [slot, walletBalance, stateInfo] = await Promise.all([
        connection.getSlot('confirmed'),
        publicKey ? connection.getBalance(publicKey, 'confirmed') : Promise.resolve(undefined),
        state ? connection.getAccountInfo(state, 'confirmed') : Promise.resolve(null),
      ]);
      if (!program || !state || !vault || !stateInfo) {
        setChain({ slot, walletSol: walletBalance === undefined ? undefined : walletBalance / LAMPORTS_PER_SOL });
        return;
      }
      const roundNumber = readU64(stateInfo.data, 81);
      const roundBytes = u64Bytes(roundNumber);
      const round = PublicKey.findProgramAddressSync([new TextEncoder().encode('round'), state.toBuffer(), roundBytes], program)[0];
      const [treasuryBalance, roundInfo, treasuryTokens, solPriceUsd] = await Promise.all([
        connection.getBalance(vault, 'confirmed'),
        connection.getAccountInfo(round, 'confirmed'),
        fetchTokenHoldings(connection, vault),
        fetchSolPriceUsd(),
      ]);
      setChain({
        slot,
        walletSol: walletBalance === undefined ? undefined : walletBalance / LAMPORTS_PER_SOL,
        treasury: vault,
        treasurySol: treasuryBalance / LAMPORTS_PER_SOL,
        treasuryTotalUsd: solPriceUsd === undefined ? undefined : treasuryBalance / LAMPORTS_PER_SOL * solPriceUsd + treasuryTokens.filter(token => token.mint !== HIDDEN_TREASURY_TOKEN).reduce((sum, token) => sum + (token.valueUsd ?? 0), 0),
        treasuryTokens,
        roundClosesAt: roundInfo ? readU64(roundInfo.data, 56) : undefined,
      });
    } catch (error) { setChain({ error: error instanceof Error ? error.message : 'Mainnet RPC unavailable' }); }
  }, [connection, publicKey]);


  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const update = () => void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') update(); };
    update();
    const timer = window.setInterval(update, 6_000);
    window.addEventListener('public-wallet:refresh', update);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('public-wallet:refresh', update);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!publicKey) return;
    let active = true;
    const subscription = connection.onAccountChange(publicKey, account => {
      if (!active) return;
      setChain(current => ({ ...current, walletSol: account.lamports / LAMPORTS_PER_SOL }));
    }, 'confirmed');
    return () => {
      active = false;
      void connection.removeAccountChangeListener(subscription);
    };
  }, [connection, publicKey]);

  return <main>
    <header className="topbar"><a className="brand" href="#top"><img src="/public-wallet-logo.png" alt="It&apos;s Our Wallet" width="40" height="40"/><span>IT&apos;S OUR WALLET</span></a><nav><a href="#control">THE MACHINE</a><a href="#transparency">FINE PRINT</a><a href="/docs">DOCS</a></nav><CrowdWalletButton/></header>
    <section className="hero" id="top"><p className="eyebrow">ONE WALLET. THE INTERNET HAS THE KEYS. SORT OF.</p><h1>A treasury with<br/><i>zero adult supervision.</i></h1><p className="dek">Pitch an on-chain move. Buy votes. Every five minutes, the contract obeys the loudest valid idea.</p><div className="hero-actions"><a className="primary" href="#control">POKE THE MACHINE　↘</a><a className="secondary" href="#how-it-works">HOW IT WORKS</a></div><code className={chain.error ? 'net error' : 'net'}>●　SOLANA MAINNET · {chain.slot ? `LIVE AT SLOT ${chain.slot.toLocaleString()}` : chain.error ? 'RPC NEEDS A COFFEE' : 'CALLING THE CHAIN'}</code></section>
    <section className="how" id="how-it-works"><p>HOW IT WORKS</p><h2>Four steps. That is it.</h2><div className="how-grid"><article><b>01</b><h3>CONNECT</h3><span>Connect your Solana wallet.</span></article><article><b>02</b><h3>PROPOSE</h3><span>Choose an allowed action.</span></article><article><b>03</b><h3>VOTE</h3><span>Buy votes with SOL.</span></article><article><b>04</b><h3>EXECUTE</h3><span>The winner runs.</span></article></div></section>
    <section className="control" id="control">
      <aside className="panel" id="treasury"><Title n="01" text="THE COMMUNAL POT"/>{chain.treasury ? <div className="real-balance"><small>VERIFIED TREASURY VALUE</small><strong>{chain.treasuryTotalUsd === undefined ? 'WAIT' : formatUsd(chain.treasuryTotalUsd)}</strong><small>{chain.treasurySol?.toLocaleString(undefined,{maximumFractionDigits:4}) ?? 'WAIT'} SOL + TREASURY TOKENS</small><a href={`https://solscan.io/account/${chain.treasury.toBase58()}`} target="_blank" rel="noreferrer">{short(chain.treasury.toBase58())} ↗</a><TokenHoldings tokens={chain.treasuryTokens}/></div> : <Empty title="SMART WALLET NOT DEPLOYED" text="No program ID is configured, so we refuse to invent a treasury or its balance."/>}<dl><div><dt>NETWORK</dt><dd>MAINNET-BETA</dd></div><div><dt>DATA SOURCE</dt><dd>LIVE RPC</dd></div><div><dt>CONTROL</dt><dd>SYSTEM VAULT PDA</dd></div></dl></aside>
      <article className="machine"><div className={'ring ' + (seconds === 0 ? 'is-ended' : '')} aria-live="polite" style={{'--progress': `${Math.min(360, ((seconds ?? 0) / 300) * 360)}deg`} as React.CSSProperties}><div><span>NEXT GROUP DECISION</span><strong>{seconds === undefined ? 'WAIT' : seconds === 0 ? 'ENDED' : String(seconds).padStart(2,'0')}</strong><small>{seconds === 0 ? 'ROUND COMPLETE' : 'SECONDS'}</small><mark>{chain.treasury ? seconds && seconds > 0 ? 'ROUND OPEN' : 'START NEXT ROUND ↓' : 'WAITING FOR PROGRAM'}</mark></div></div><p>THE CROWD PICKS THE WINNER. THE CODE CHECKS ITS HOMEWORK.</p><section className="fees"><div>PROPOSAL BASE<b>0.1000 SOL</b></div><div>VOTE BASE<b>0.0100 SOL</b></div><div>CHAOS LEVEL<b>{connected ? 'WALLET READY' : 'POLITE'}</b></div></section></article>
      <aside className="panel proposals"><Title n="02" text="TODAY BIG IDEAS"/><WallActions/></aside>
    </section>
    {connected && publicKey && <section className="wallet-card"><div><small>YOUR ACTUAL MAINNET WALLET</small><strong>{short(publicKey.toBase58())}</strong></div><div><small>VERIFIED BALANCE</small><strong>{chain.walletSol?.toLocaleString(undefined,{maximumFractionDigits:4}) ?? 'LOADING'} SOL</strong></div><a href={`https://solscan.io/account/${publicKey.toBase58()}`} target="_blank" rel="noreferrer">VIEW ON SOLSCAN ↗</a></section>}    <section className="manifesto" id="transparency"><p>THE JOKE ENDS WHERE THE SAFETY RULES BEGIN</p><h2>Most votes wins.<br/><i>Bad ideas still get rejected.</i></h2><div className="rules"><article><b>01</b><h3>BRING AN IDEA</h3><p>Every action is typed and inspected. No mystery addresses. No arbitrary calls.</p></article><article><b>02</b><h3>PAY TO SHOUT</h3><p>Votes cost real SOL and go straight into the treasury. Volume has a price.</p></article><article><b>03</b><h3>CODE, NOT VIBES</h3><p>The winner executes only if prices, limits and slippage remain safe.</p></article></div></section>
    <footer><b>IT&apos;S OUR WALLET</b><a href="/docs">PROGRAM PROOF & DOCS ↗</a></footer>
  </main>;
}

async function fetchSolPriceUsd() {
  const response = await fetch('/api/token-prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mints: ['So11111111111111111111111111111111111111112'] }) });
  if (!response.ok) return undefined;
  const payload = await response.json() as { prices?: Record<string, { priceUsd?: number }> };
  return payload.prices?.So11111111111111111111111111111111111111112?.priceUsd;
}
async function fetchTokenHoldings(connection: ReturnType<typeof useConnection>['connection'], owner: PublicKey): Promise<TokenHolding[]> {
  const [legacy, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
  ]);
  const amounts = new Map<string, number>();
  for (const account of [...legacy.value, ...token2022.value]) {
    const info = account.account.data.parsed.info as { mint: string; tokenAmount: { uiAmountString?: string | null } };
    const amount = Number(info.tokenAmount.uiAmountString ?? 0);
    if (Number.isFinite(amount) && amount > 0) amounts.set(info.mint, (amounts.get(info.mint) ?? 0) + amount);
  }
  const mints = [...amounts.keys()];
  if (mints.length === 0) return [];
  const response = await fetch('/api/token-prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mints }) });
  const payload = response.ok ? await response.json() as { prices?: Record<string, { name?: string; symbol?: string; priceUsd?: number }> } : {};
  return mints.map(mint => {
    const amount = amounts.get(mint) ?? 0;
    const price = payload.prices?.[mint];
    return { mint, amount, name: price?.name, symbol: price?.symbol, priceUsd: price?.priceUsd, valueUsd: price?.priceUsd === undefined ? undefined : amount * price.priceUsd };
  }).sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

function TokenHoldings({ tokens }: { tokens?: TokenHolding[] }) {
  if (!tokens) return <div className="token-holdings loading">READING TOKEN ACCOUNTS…</div>;
  const visibleTokens = tokens.filter(token => token.mint !== HIDDEN_TREASURY_TOKEN);
  if (visibleTokens.length === 0) return <div className="token-holdings empty-tokens">NO TREASURY TOKENS YET</div>;
  const pricedTotal = visibleTokens.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0);
  return <div className="token-holdings"><div className="token-summary"><span>TREASURY TOKENS</span><b>{pricedTotal > 0 ? formatUsd(pricedTotal) : `${visibleTokens.length} FOUND`}</b></div>{visibleTokens.map(token => <a className="token-row" key={token.mint} href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer"><span><b>{token.symbol || short(token.mint)}</b><small>{token.name || short(token.mint)}</small></span><span><b>{formatTokenAmount(token.amount)}</b><small>{token.valueUsd === undefined ? 'PRICE UNAVAILABLE' : `${formatUsd(token.valueUsd)} · ${formatUsd(token.priceUsd ?? 0)} EACH`}</small></span></a>)}</div>;
}

function formatTokenAmount(value: number) { return value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 8 : 4 }); }
function formatUsd(value: number) { return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 0.01 ? 6 : 2 }); }
function readU64(bytes: Uint8Array, offset: number) { let value = 0; for (let i = 7; i >= 0; i--) value = value * 256 + bytes[offset + i]; return value; }
function u64Bytes(value: number) { const bytes = new Uint8Array(8); for (let i = 0; i < 8; i++) { bytes[i] = value % 256; value = Math.floor(value / 256); } return bytes; }
function short(value:string){return `${value.slice(0,4)}…${value.slice(-4)}`}
function CrowdWalletButton(){
  const { publicKey, connected, connecting, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const handleClick = () => connected ? void disconnect() : setVisible(true);
  return <button className={`crowd-wallet${connected ? ' is-connected' : ''}`} type="button" onClick={handleClick} disabled={connecting} aria-label={connected ? 'Disconnect wallet' : 'Connect a Solana wallet'}><span className="crowd-wallet-dot"/>{connecting ? 'KNOCKING…' : connected && publicKey ? short(publicKey.toBase58()) : 'JOIN THE CROWD'}<span aria-hidden="true">{connected ? '×' : '↗'}</span></button>
}
function Title({n,text}:{n:string;text:string}) { return <div className="title"><span>{n}</span><h2>{text}</h2><i/></div> }
function Empty({title,text}:{title:string;text:string}) { return <div className="empty"><strong>☻</strong><h3>{title}</h3><p>{text}</p></div> }
