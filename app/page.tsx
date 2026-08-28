'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { WallActions } from './wall-actions';

type ChainState = { slot?: number; walletSol?: number; treasury?: PublicKey; treasurySol?: number; roundClosesAt?: number; error?: string };

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
      const [treasuryBalance, roundInfo] = await Promise.all([
        connection.getBalance(vault, 'confirmed'), connection.getAccountInfo(round, 'confirmed'),
      ]);
      setChain({
        slot,
        walletSol: walletBalance === undefined ? undefined : walletBalance / LAMPORTS_PER_SOL,
        treasury: vault,
        treasurySol: treasuryBalance / LAMPORTS_PER_SOL,
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
      <aside className="panel" id="treasury"><Title n="01" text="THE COMMUNAL POT"/>{chain.treasury ? <div className="real-balance"><small>VERIFIED VAULT BALANCE</small><strong>{chain.treasurySol?.toLocaleString(undefined,{maximumFractionDigits:4}) ?? 'WAIT'} SOL</strong><a href={`https://solscan.io/account/${chain.treasury.toBase58()}`} target="_blank" rel="noreferrer">{short(chain.treasury.toBase58())} ↗</a></div> : <Empty title="SMART WALLET NOT DEPLOYED" text="No program ID is configured, so we refuse to invent a treasury or its balance."/>}<dl><div><dt>NETWORK</dt><dd>MAINNET-BETA</dd></div><div><dt>DATA SOURCE</dt><dd>LIVE RPC</dd></div><div><dt>CONTROL</dt><dd>SYSTEM VAULT PDA</dd></div></dl></aside>
      <article className="machine"><div className={'ring ' + (seconds === 0 ? 'is-ended' : '')} aria-live="polite" style={{'--progress': `${Math.min(360, ((seconds ?? 0) / 300) * 360)}deg`} as React.CSSProperties}><div><span>NEXT GROUP DECISION</span><strong>{seconds === undefined ? 'WAIT' : seconds === 0 ? 'ENDED' : String(seconds).padStart(2,'0')}</strong><small>{seconds === 0 ? 'ROUND COMPLETE' : 'SECONDS'}</small><mark>{chain.treasury ? seconds && seconds > 0 ? 'ROUND OPEN' : 'START NEXT ROUND ↓' : 'WAITING FOR PROGRAM'}</mark></div></div><p>THE CROWD PICKS THE WINNER. THE CODE CHECKS ITS HOMEWORK.</p><section className="fees"><div>PROPOSAL BASE<b>0.1000 SOL</b></div><div>VOTE BASE<b>0.0100 SOL</b></div><div>CHAOS LEVEL<b>{connected ? 'WALLET READY' : 'POLITE'}</b></div></section></article>
      <aside className="panel proposals"><Title n="02" text="TODAY BIG IDEAS"/><WallActions/></aside>
    </section>
    {connected && publicKey && <section className="wallet-card"><div><small>YOUR ACTUAL MAINNET WALLET</small><strong>{short(publicKey.toBase58())}</strong></div><div><small>VERIFIED BALANCE</small><strong>{chain.walletSol?.toLocaleString(undefined,{maximumFractionDigits:4}) ?? 'LOADING'} SOL</strong></div><a href={`https://solscan.io/account/${publicKey.toBase58()}`} target="_blank" rel="noreferrer">VIEW ON SOLSCAN ↗</a></section>}    <section className="manifesto" id="transparency"><p>THE JOKE ENDS WHERE THE SAFETY RULES BEGIN</p><h2>Most votes wins.<br/><i>Bad ideas still get rejected.</i></h2><div className="rules"><article><b>01</b><h3>BRING AN IDEA</h3><p>Every action is typed and inspected. No mystery addresses. No arbitrary calls.</p></article><article><b>02</b><h3>PAY TO SHOUT</h3><p>Votes cost real SOL and go straight into the treasury. Volume has a price.</p></article><article><b>03</b><h3>CODE, NOT VIBES</h3><p>The winner executes only if prices, limits and slippage remain safe.</p></article></div></section>
    <footer><b>IT&apos;S OUR WALLET</b><a href="/docs">PROGRAM PROOF & DOCS ↗</a></footer>
  </main>;
}

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
