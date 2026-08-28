const anchor = require('@coral-xyz/anchor');

const PROGRAM_ID = new anchor.web3.PublicKey('G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8');
const CONFIRMATION = 'I_UNDERSTAND_MAINNET';

async function main() {
  if (process.env.CONFIRM_MAINNET !== CONFIRMATION) {
    throw new Error(`Refusing mainnet initialization. Set CONFIRM_MAINNET=${CONFIRMATION}.`);
  }
  if (process.env.SOLANA_CLUSTER !== 'mainnet-beta') {
    throw new Error('Refusing initialization unless SOLANA_CLUSTER=mainnet-beta.');
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  if (!provider.wallet?.publicKey) throw new Error('ANCHOR_WALLET did not load a signer.');

  const idl = require('../idl-onchain.json');
  const program = new anchor.Program(idl, provider);
  if (!program.programId.equals(PROGRAM_ID)) throw new Error('IDL program address mismatch.');

  const [treasury] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from('treasury')],
    PROGRAM_ID,
  );
  const [round] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from('round'), treasury.toBuffer(), Buffer.alloc(8)],
    PROGRAM_ID,
  );

  const existing = await program.account.treasury.fetchNullable(treasury);
  if (existing) {
    if (!existing.authority.equals(provider.wallet.publicKey)) {
      throw new Error(`Treasury already exists under authority ${existing.authority.toBase58()}.`);
    }
    console.log(`Treasury already initialized: ${treasury.toBase58()}`);
    return;
  }

  const signature = await program.methods.initialize({
    universalActionLimitBps: 2500,
    externalTransferLimitBps: 500,
    maxSlippageBps: 500,
    maxOracleStalenessSeconds: 60,
    rollingTransferLimitBps: 2500,
  }).accounts({
    authority: provider.wallet.publicKey,
    treasury,
    round,
    systemProgram: anchor.web3.SystemProgram.programId,
  }).rpc({ commitment: 'confirmed' });

  const created = await program.account.treasury.fetch(treasury);
  if (!created.authority.equals(provider.wallet.publicKey)) {
    throw new Error('Post-initialization authority verification failed.');
  }
  console.log(`Initialized treasury ${treasury.toBase58()} in transaction ${signature}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
