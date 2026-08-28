import type { Metadata } from 'next';
import Link from 'next/link';

const PROGRAM = 'G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8';
const PROGRAM_DATA = 'J4q4HrGWZjThw98sMb38jSLXNHhnRMoHZMMmKGrPm1wJ';
const TREASURY = '8osPUnyLWUMyHTL1onGRAihKP8aUZjzCtraesZuQAaz1';
const VAULT = '6fvueR6oGYDjvsSdHnBDqrFU4EAsBvQd1xwshSAp4ycV';
const DEPLOYMENT = 'PuTiUheGCVYfnw2UdK3hkVp6VYh9KAuTBAmdCDVp2cDgdD6QU7WQwC9wsKUFvocCkHm8xLGG6eiUXiqtRpExAoJ';
const SHA256 = '2c138135abfe7ece4d652d7948aa110e287b6a06273ed2d16ddc712f6e6250fb';

export const metadata: Metadata = {
  title: "Program Proof & Docs | It's Our Wallet",
  description: "The public addresses, architecture, execution flow, safety rules and trust assumptions behind It's Our Wallet.",
};

export default function DocsPage() {
  return <main className="docs-page">
    <header className="docs-nav">
      <Link className="brand" href="/"><img src="/public-wallet-logo.png" alt="" width="40" height="40"/><span>IT&apos;S OUR WALLET</span></Link>
      <nav><a href="#proof">PROOF</a><a href="#how">HOW IT WORKS</a><a href="#trust">TRUST</a><Link href="/">OPEN APP</Link></nav>
    </header>

    <section className="docs-hero">
      <p>PROGRAM PROOF & TECHNICAL DOCS</p>
      <h1>Don&apos;t trust the pitch.<br/><i>Check the chain.</i></h1>
      <span>What is deployed, where the SOL lives, how the crowd controls decisions, how trades execute, and what still requires trust.</span>
    </section>

    <div className="docs-layout">
      <aside className="docs-toc">
        <b>ON THIS PAGE</b>
        <a href="#proof">01 · Mainnet proof</a>
        <a href="#architecture">02 · Architecture</a>
        <a href="#how">03 · Round lifecycle</a>
        <a href="#trading">04 · Pump.fun trades</a>
        <a href="#security">05 · Safety limits</a>
        <a href="#trust">06 · Trust disclosure</a>
        <a href="#verify">07 · Bytecode proof</a>
      </aside>

      <article className="docs-content">
        <section id="proof">
          <Label n="01" text="MAINNET PROOF"/>
          <h2>The public coordinates</h2>
          <p>It&apos;s Our Wallet is a Solana program on mainnet-beta. These addresses can be verified without trusting this website.</p>
          <Address label="PROGRAM ID" value={PROGRAM} href={'https://solscan.io/account/' + PROGRAM}/>
          <Address label="PROGRAMDATA" value={PROGRAM_DATA} href={'https://solscan.io/account/' + PROGRAM_DATA}/>
          <Address label="TREASURY STATE PDA" value={TREASURY} href={'https://solscan.io/account/' + TREASURY}/>
          <Address label="SOL VAULT PDA" value={VAULT} href={'https://solscan.io/account/' + VAULT}/>
          <Address label="DEPLOYMENT TRANSACTION" value={DEPLOYMENT} href={'https://solscan.io/tx/' + DEPLOYMENT}/>
          <div className="proof-grid">
            <Fact title="NETWORK" value="SOLANA MAINNET-BETA"/>
            <Fact title="DEPLOYED SLOT" value="442381141"/>
            <Fact title="PROGRAM ACCOUNT" value="364,048 BYTES"/>
          </div>
        </section>

        <section id="architecture">
          <Label n="02" text="ARCHITECTURE"/>
          <h2>Four public pieces</h2>
          <div className="docs-steps">
            <article><b>01</b><h3>PROGRAM</h3><p>Rules for rounds, proposals, paid votes, winner selection and Pump.fun execution.</p></article>
            <article><b>02</b><h3>TREASURY STATE</h3><p>A PDA stores the round number, safety configuration and rolling spending totals.</p></article>
            <article><b>03</b><h3>VAULT</h3><p>A separate PDA holds SOL. It has no ordinary private key; the program signs with deterministic PDA seeds.</p></article>
            <article><b>04</b><h3>PUBLIC RECORDS</h3><p>Rounds, proposals and vote receipts are Solana accounts that anyone can fetch and decode.</p></article>
          </div>
          <div className="flow"><span>PEOPLE</span><i>pitch + vote</i><span>ROUND</span><i>selects</i><span>WINNER</span><i>requests</i><span>VAULT</span><i>trades via</i><span>PUMP.FUN</span></div>
        </section>

        <section id="how">
          <Label n="03" text="ROUND LIFECYCLE"/>
          <h2>How the crowd reaches the wallet</h2>
          <ol className="technical-list">
            <li><b>A round opens.</b><span>Its account records opening time, closing time, proposal count and the current leader.</span></li>
            <li><b>Someone proposes.</b><span>The proposal fee enters the vault. The proposal stores a typed action, token mint, amounts, slippage, expiry and public copy.</span></li>
            <li><b>People buy votes.</b><span>Votes cost SOL and their payments enter the vault. On-chain vote receipts record participation.</span></li>
            <li><b>The round settles.</b><span>After the timer, anyone may submit settlement. Highest votes wins; ties use time reached and then proposal ID.</span></li>
            <li><b>The winner is checked.</b><span>Expiry, mint ownership, Pump.fun accounts, balances, rolling limits and slippage are checked again.</span></li>
            <li><b>A keeper triggers it.</b><span>A connected user sends settlement and execution transactions. The keeper never receives custody of vault funds.</span></li>
          </ol>
        </section>

        <section id="trading">
          <Label n="04" text="PUMP.FUN EXECUTION"/>
          <h2>What the wallet can trade</h2>
          <p>A proposal can target any valid Pump.fun token paired with native SOL. Active tokens use the bonding curve; graduated tokens use their canonical PumpSwap pool.</p>
          <div className="callout"><b>ONE PITCH, BOTH ROUTES</b><p>The app detects whether the token is still on its Pump.fun curve or has graduated to PumpSwap, then builds the matching transaction.</p></div>
          <h3>Buying</h3><p>The proposer enters a maximum SOL budget. The app reads the live curve and fee state, estimates output, applies 5% protection and records integer amounts.</p>
          <h3>Selling</h3><p>The proposer enters a normal token quantity. Mint decimals are converted automatically. The program can only sell tokens owned by the vault.</p>
          <h3>Sending</h3><p>A proposal can send SOL or a treasury-owned legacy/Token-2022 token to any valid Solana wallet. The recipient and asset are bound on-chain before voting.</p>
          <h3>Atomic execution</h3><p>The Pump.fun or PumpSwap call happens inside one Solana transaction. If validation or the venue fails, trade funds do not partially move.</p>
        </section>

        <section id="security">
          <Label n="05" text="ON-CHAIN SAFETY"/>
          <h2>Current limits</h2>
          <div className="proof-grid">
            <Fact title="SINGLE ACTION" value="25% OF BALANCE"/>
            <Fact title="ROLLING SPEND" value="25% PER 24 HOURS"/>
            <Fact title="MAX SLIPPAGE" value="5%"/>
            <Fact title="SEND LIMIT" value="5% PER ACTION"/>
            <Fact title="ORACLE FRESHNESS" value="60 SECONDS"/>
            <Fact title="EXECUTION WINDOW" value="10 MIN AFTER CLOSE"/>
          </div>
          <p>A 0.10 SOL buy requires at least 0.40 SOL in the vault, assuming the rolling allowance remains available.</p>
          <div className="callout warning"><b>EXPIRY IS FINAL</b><p>Funding can repair a balance limit only before expiry. An expired winner cannot be revived and must be skipped.</p></div>
        </section>

        <section id="trust">
          <Label n="06" text="TRUST DISCLOSURE"/>
          <h2>What is not trustless yet</h2>
          <ul className="disclosures">
            <li><b>The timer is not autonomous.</b> A user must send the keeper transaction after a round closes.</li>
            <li><b>Execution ordering is not fully enforced.</b> The contract permits advancing a settled round without proof that its trade executed. The app attempts execution first and allows rejected or expired winners to be skipped.</li>
            <li><b>This is not an audit.</b> Public bytecode proves what is deployed, not that it contains no vulnerabilities.</li>
          </ul>
        </section>

        <section id="verify">
          <Label n="07" text="BYTECODE PROOF"/>
          <h2>The deployed binary matches</h2>
          <p>The program was downloaded from mainnet and compared byte-for-byte with the release binary. The extra deployed bytes are Solana account padding and are all zero.</p>
          <pre><code>{'Release binary:       361,760 bytes\\nDeployed account:      364,048 bytes\\nBytecode prefix:       exact match\\nNon-zero padding:      0 bytes\\nRelease SHA-256:\\n' + SHA256}</code></pre>
          <div className="docs-links">
            <a href="https://github.com/Itsourwallet/publicwallet" target="_blank" rel="noreferrer">OFFICIAL ORGANIZATION SOURCE ↗</a>
            <a href={'https://explorer.solana.com/address/' + PROGRAM} target="_blank" rel="noreferrer">SOLANA EXPLORER ↗</a>
            <a href={'https://solscan.io/tx/' + DEPLOYMENT} target="_blank" rel="noreferrer">DEPLOYMENT TRANSACTION ↗</a>
          </div>
        </section>
      </article>
    </div>
    <footer><b>IT&apos;S OUR WALLET</b><Link href="/">BACK TO THE MACHINE ↗</Link></footer>
  </main>;
}

function Label({n,text}:{n:string;text:string}) { return <p className="docs-eyebrow"><b>{n}</b>{text}</p> }
function Address({label,value,href}:{label:string;value:string;href:string}) { return <div className="address-row"><span>{label}</span><code>{value}</code><a href={href} target="_blank" rel="noreferrer">VERIFY ↗</a></div> }
function Fact({title,value}:{title:string;value:string}) { return <div><small>{title}</small><b>{value}</b></div> }