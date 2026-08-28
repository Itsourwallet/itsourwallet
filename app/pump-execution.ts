import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
} from '@pump-fun/pump-sdk';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';

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
    throw new Error('This address is not an active Pump.fun token.');
  }
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (curve.complete) throw new Error('This token has graduated from Pump.fun and cannot use this trade route.');
  return { tokenProgram, mintState, curve };
}
export async function quotePumpBuyAmount(
  connection: Connection,
  mint: PublicKey,
  maximumLamports: BN,
  slippageBps = 500,
) {
  const { mintState, curve } = await validatePumpToken(connection, mint);
  const onlineSdk = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
  ]);
  const expected = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: new BN(mintState.supply.toString()),
    bondingCurve: curve,
    amount: maximumLamports,
    quoteMint: PublicKey.default,
  });
  const protectedAmount = expected.muln(10_000 - slippageBps).divn(10_000);
  if (protectedAmount.isZero()) throw new Error('The SOL budget is too small for this Pump.fun token.');
  return protectedAmount;
}

export async function normalTokenAmountToBaseUnits(
  connection: Connection,
  mint: PublicKey,
  value: string,
) {
  const { mintState } = await validatePumpToken(connection, mint);
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
  const { tokenProgram, curve } = await validatePumpToken(connection, mint);

  const isBuy = 'buyApprovedToken' in proposalState.action;
  const quoteAmount = isBuy ? proposalState.maximumAmount : proposalState.minimumOutput;
  const pumpInstruction = isBuy
    ? await PUMP_SDK.getBuyV2InstructionRaw({
        user: vault,
        mint,
        creator: curve.creator,
        amount: proposalState.amount,
        quoteAmount,
        tokenProgram,
      })
    : await PUMP_SDK.getSellV2InstructionRaw({
        user: vault,
        mint,
        creator: curve.creator,
        amount: proposalState.amount,
        quoteAmount,
        tokenProgram,
      });

  const baseAta = getAssociatedTokenAddressSync(mint, vault, true, tokenProgram);
  if (!(await connection.getAccountInfo(baseAta, 'confirmed'))) {
    const provider = program.provider as AnchorProvider;
    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      keeper,
      baseAta,
      vault,
      mint,
      tokenProgram,
    );
    await provider.sendAndConfirm(new Transaction().add(createAta));
  }

  const pumpAccounts = pumpInstruction.keys.slice(0, -1).map(meta => ({
    pubkey: meta.pubkey,
    isWritable: meta.isWritable,
    isSigner: meta.pubkey.equals(vault) ? false : meta.isSigner,
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
