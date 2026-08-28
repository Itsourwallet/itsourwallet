import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";

describe("public wall treasury", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Onchain as anchor.Program<any>;
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId);
  const [round] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), treasury.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
    program.programId,
  );

  it("initializes bounded safety configuration", async () => {
    await program.methods.initialize({
      universalActionLimitBps: 2500,
      externalTransferLimitBps: 500,
      maxSlippageBps: 500,
      maxOracleStalenessSeconds: 60,
      rollingTransferLimitBps: 500,
    }).accounts({ authority: provider.wallet.publicKey, treasury, round, systemProgram: SystemProgram.programId }).rpc();

    const state = await program.account.treasury.fetch(treasury);
    assert.equal(state.roundNumber.toNumber(), 0);
    assert.equal(state.config.universalActionLimitBps, 2500);
    assert.isFalse(state.paused);
  });

  it("routes real proposal and vote fees into the spendable vault", async () => {
    const [proposal] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), round.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    const before = await provider.connection.getBalance(vault);
    await program.methods.createProposal({
      action: { hold: {} },
      target: PublicKey.default,
      amount: new BN(0),
      maximumAmount: new BN(0),
      minimumOutput: new BN(0),
      maxSlippageBps: 0,
      expiresAt: new BN(Math.floor(Date.now() / 1000) + 180),
      title: "Keep the powder dry",
      rationale: "A typed no-op still proves the complete paid proposal path.",
    }).accounts({ proposer: provider.wallet.publicKey, treasury, round, vault, proposal, systemProgram: SystemProgram.programId }).rpc();

    const [receipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), proposal.toBuffer(), provider.wallet.publicKey.toBuffer()],
      program.programId,
    );
    await program.methods.buyVotes(2).accounts({ voter: provider.wallet.publicKey, treasury, round, vault, proposal, receipt, systemProgram: SystemProgram.programId }).rpc();
    const after = await provider.connection.getBalance(vault);
    assert.equal(after - before, 120_000_000);
    const stored = await program.account.proposal.fetch(proposal);
    assert.equal(stored.votes.toNumber(), 2);
  });


  it("settles, certifies, executes hold, and opens the next round", async () => {
    const roundBefore = await program.account.round.fetch(round);
    const waitMs = Math.max(0, roundBefore.closesAt.toNumber() * 1000 - Date.now() + 1_500);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    await program.methods.settleRound().accounts({
      keeper: provider.wallet.publicKey,
      treasury,
      round,
    }).rpc();

    const [winner] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), round.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    await program.methods.markWinner().accounts({
      keeper: provider.wallet.publicKey,
      treasury,
      round,
      proposal: winner,
    }).rpc();
    await program.methods.executeHold().accounts({
      keeper: provider.wallet.publicKey,
      treasury,
      round,
      proposal: winner,
    }).rpc();

    const [nextRound] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), treasury.toBuffer(), new BN(1).toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    await program.methods.openNextRound().accounts({
      keeper: provider.wallet.publicKey,
      treasury,
      previousRound: round,
      round: nextRound,
      systemProgram: SystemProgram.programId,
    }).rpc();

    const winnerState = await program.account.proposal.fetch(winner);
    const treasuryState = await program.account.treasury.fetch(treasury);
    const nextState = await program.account.round.fetch(nextRound);
    assert.property(winnerState.status, "executed");
    assert.equal(treasuryState.roundNumber.toNumber(), 1);
    assert.equal(nextState.number.toNumber(), 1);
    assert.property(nextState.status, "open");
  });
});
