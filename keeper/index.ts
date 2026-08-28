/* eslint-disable @typescript-eslint/no-explicit-any -- Anchor namespaces come from the committed IDL at runtime. */
import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { executePumpWinner, executeTransferWinner } from '../app/pump-execution.ts';
import idl from '../app/onchain-idl.json';

const DEFAULT_PROGRAM_ID = 'G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8';
const rpcUrl = process.env.SOLANA_RPC_URL;
const keypairJson = process.env.KEEPER_KEYPAIR_JSON;
const programId = new PublicKey(process.env.PUBLIC_WALLET_PROGRAM_ID || DEFAULT_PROGRAM_ID);
const pollMs = Math.max(5_000, Number(process.env.KEEPER_POLL_MS || 12_000));
const minimumKeeperLamports = Math.max(1_000_000, Math.round(Number(process.env.KEEPER_MIN_SOL || 0.02) * 1_000_000_000));
const roundEndScreenMs = Math.max(10_000, Number(process.env.ROUND_END_SCREEN_MS || 10_000));
const runOnce = process.env.KEEPER_RUN_ONCE === 'true';
const dryRun = process.env.KEEPER_DRY_RUN === 'true';

if (!rpcUrl || !/^https:\/\//.test(rpcUrl)) throw new Error('SOLANA_RPC_URL must be a private HTTPS mainnet RPC endpoint.');
if (!keypairJson) throw new Error('KEEPER_KEYPAIR_JSON is required.');

let secret: unknown;
try { secret = JSON.parse(keypairJson); } catch { throw new Error('KEEPER_KEYPAIR_JSON must contain the keypair JSON array.'); }
if (!Array.isArray(secret) || secret.length !== 64 || secret.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
  throw new Error('KEEPER_KEYPAIR_JSON is not a valid 64-byte Solana keypair array.');
}
const keeper = Keypair.fromSecretKey(Uint8Array.from(secret as number[]));
const connection = new Connection(rpcUrl, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60_000 });
const wallet = new Wallet(keeper);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
if (idl.address !== programId.toBase58()) throw new Error('The committed IDL address does not match PUBLIC_WALLET_PROGRAM_ID.');
const program = new Program(idl, provider) as Program & any;
const [treasury] = PublicKey.findProgramAddressSync([Buffer.from('treasury')], programId);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
let active = false;
let lastWaitingRound = '';

function u64Bytes(value: BN) { return Uint8Array.from(value.toArray('le', 8)); }
function log(message: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...details }));
}

async function openNextRound(round: PublicKey, roundState: any) {
  const settledAtMs = Number((roundState.settledAt as BN).toString()) * 1_000;
  const remainingMs = settledAtMs + roundEndScreenMs - Date.now();
  if (remainingMs > 0) {
    log('showing completed round before opening the next one', { round: (roundState.number as BN).toString(), remainingMs });
    await new Promise(resolve => setTimeout(resolve, remainingMs));
  }
  const state = await program.account.treasury.fetch(treasury);
  if (!(state.roundNumber as BN).eq(roundState.number as BN)) return;
  const nextNumber = (roundState.number as BN).add(new BN(1));
  const [nextRound] = PublicKey.findProgramAddressSync(
    [Buffer.from('round'), treasury.toBuffer(), u64Bytes(nextNumber)],
    programId,
  );
  if (dryRun) return log('dry-run: would open next round', { nextRound: nextNumber.toString() });
  const signature = await program.methods.openNextRound().accounts({
    keeper: keeper.publicKey,
    treasury,
    previousRound: round,
    round: nextRound,
    systemProgram: SystemProgram.programId,
  }).rpc();
  log('next round opened', { round: nextNumber.toString(), signature });
}

async function processRound() {
  if (active) return;
  active = true;
  try {
    const keeperBalance = await connection.getBalance(keeper.publicKey, 'confirmed');
    if (!dryRun && keeperBalance < minimumKeeperLamports) {
      log('keeper waiting for fee funding', { keeper: keeper.publicKey.toBase58(), balanceSol: keeperBalance / 1_000_000_000, minimumSol: minimumKeeperLamports / 1_000_000_000 });
      return;
    }
    const treasuryState = await program.account.treasury.fetch(treasury);
    const roundNumber = treasuryState.roundNumber as BN;
    const [round] = PublicKey.findProgramAddressSync(
      [Buffer.from('round'), treasury.toBuffer(), u64Bytes(roundNumber)],
      programId,
    );
    let roundState = await program.account.round.fetch(round);
    const now = Math.floor(Date.now() / 1000);
    if ('open' in roundState.status && now < Number((roundState.closesAt as BN).toString())) {
      const key = roundNumber.toString();
      if (lastWaitingRound !== key) {
        lastWaitingRound = key;
        log('round open; keeper waiting', { round: key, closesAt: Number((roundState.closesAt as BN).toString()) });
      }
      return;
    }
    lastWaitingRound = '';
    if ('open' in roundState.status) {
      if (dryRun) return log('dry-run: would settle round', { round: roundNumber.toString() });
      const signature = await program.methods.settleRound().accounts({ keeper: keeper.publicKey, treasury, round }).rpc();
      log('round settled', { round: roundNumber.toString(), signature });
      roundState = await program.account.round.fetch(round);
    }

    const winnerId = roundState.winningProposal as BN | null;
    if (winnerId === null || winnerId === undefined) {
      await openNextRound(round, roundState);
      return;
    }
    const [proposal] = PublicKey.findProgramAddressSync(
      [Buffer.from('proposal'), round.toBuffer(), u64Bytes(winnerId)],
      programId,
    );
    let proposalState = await program.account.proposal.fetch(proposal);
    if ('voting' in proposalState.status) {
      if (dryRun) return log('dry-run: would mark winner', { round: roundNumber.toString(), proposal: proposal.toBase58() });
      const signature = await program.methods.markWinner().accounts({ keeper: keeper.publicKey, treasury, round, proposal }).rpc();
      log('winner marked', { round: roundNumber.toString(), proposal: proposal.toBase58(), signature });
      proposalState = await program.account.proposal.fetch(proposal);
    }
    if ('won' in proposalState.status) {
      const expiresAt = Number((proposalState.expiresAt as BN).toString());
      if (Math.floor(Date.now() / 1000) > expiresAt) {
        log('winner expired; opening next round without execution', { round: roundNumber.toString(), proposal: proposal.toBase58() });
        await openNextRound(round, roundState);
        return;
      }
      if (dryRun) return log('dry-run: would execute winner', { round: roundNumber.toString(), proposal: proposal.toBase58() });
      let signature: string;
      if ('hold' in proposalState.action) {
        signature = await program.methods.executeHold().accounts({ keeper: keeper.publicKey, treasury, round, proposal }).rpc();
      } else if ('transferToApprovedRecipient' in proposalState.action) {
        signature = await executeTransferWinner({ connection, program, keeper: keeper.publicKey, treasury, round, vault, proposal, proposalState });
      } else {
        signature = await executePumpWinner({ connection, program, keeper: keeper.publicKey, treasury, round, vault, proposal, proposalState });
      }
      log('winner executed', { round: roundNumber.toString(), proposal: proposal.toBase58(), signature });
      proposalState = await program.account.proposal.fetch(proposal);
    }
    if ('executed' in proposalState.status) await openNextRound(round, roundState);
  } catch (error) {
    log('keeper cycle failed; will retry', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    active = false;
  }
}

async function main() {
  log('keeper started', { keeper: keeper.publicKey.toBase58(), program: programId.toBase58(), pollMs, roundEndScreenMs, dryRun });
  await processRound();
  if (!runOnce) setInterval(() => void processRound(), pollMs);
}

void main().catch(error => {
  log('keeper stopped', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});