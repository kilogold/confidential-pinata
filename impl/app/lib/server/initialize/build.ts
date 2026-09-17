import {
  assertIsTransactionWithinSizeLimit,
  createNoopSigner,
  createTransactionMessage,
  createTransactionPlanner,
  flattenTransactionPlan,
  getBase64EncodedWireTransaction,
  nonDivisibleSequentialInstructionPlan,
  partiallySignTransactionMessageWithSigners,
  pipe,
  sequentialInstructionPlan,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda } from "@solana-program/token";
import { getInitializeInstructionAsync } from "@/app/generated/pinata";
import { INITIALIZE_COMPUTE_UNIT_LIMIT } from "@/app/lib/constants";
import type { SolanaRpc } from "../rpc";
import { InitializeApiError } from "./errors";
import type { GeneratedInitializeProofs } from "./proofs";

export type PreparedInitializeTransactions = {
  transactions: string[];
  lastValidBlockHeight: string;
};

export async function buildPartialInitializeTransactions(args: {
  rpc: SolanaRpc;
  gm: Address;
  arbiter: KeyPairSigner;
  sessionId: string;
  strikeFeeLamports: bigint;
  rewardAmount: bigint;
  rewardMint: Address;
  rewardTokenProgram: Address;
  hpMint: Address;
  proofs: GeneratedInitializeProofs;
}): Promise<PreparedInitializeTransactions> {
  const [rewardSource] = await findAssociatedTokenPda({
    owner: args.gm,
    tokenProgram: args.rewardTokenProgram,
    mint: args.rewardMint,
  });
  const gmSigner = createNoopSigner(args.gm);

  const initializeIx = await getInitializeInstructionAsync({
    gm: gmSigner,
    arbiter: args.arbiter,
    hpMint: args.hpMint,
    rewardMint: args.rewardMint,
    rewardSource,
    rewardTokenProgram: args.rewardTokenProgram,
    sessionId: args.sessionId,
    strikeFeeLamports: args.strikeFeeLamports,
    rewardAmount: args.rewardAmount,
    equalityProof: args.proofs.accounts.equalityProof,
    ciphertextValidityProof: args.proofs.accounts.ciphertextValidityProof,
    rangeProof: args.proofs.accounts.rangeProof,
    pubkeyValidityProof: args.proofs.accounts.pubkeyValidityProof,
    zeroProof: args.proofs.accounts.zeroProof,
    decryptableZero: args.proofs.accounts.decryptableZero,
    newDecryptableSupply: args.proofs.accounts.newDecryptableSupply,
    mintAmountAuditorCiphertextLo:
      args.proofs.accounts.mintAmountAuditorCiphertextLo,
    mintAmountAuditorCiphertextHi:
      args.proofs.accounts.mintAmountAuditorCiphertextHi,
    expectedPendingBalanceCreditCounter:
      args.proofs.accounts.expectedPendingBalanceCreditCounter,
    newDecryptableAvailableBalance:
      args.proofs.accounts.newDecryptableAvailableBalance,
  });

  const computeUnitIx = getSetComputeUnitLimitInstruction({
    units: INITIALIZE_COMPUTE_UNIT_LIMIT,
  });

  const instructionPlan = sequentialInstructionPlan([
    args.proofs.instructionPlan,
    nonDivisibleSequentialInstructionPlan([computeUnitIx, initializeIx]),
  ]);

  let transactionPlan;
  try {
    const planner = createTransactionPlanner({
      createTransactionMessage: () =>
        pipe(createTransactionMessage({ version: 0 }), (message) =>
          setTransactionMessageFeePayerSigner(gmSigner, message)
        ),
    });
    transactionPlan = await planner(instructionPlan);
  } catch (err) {
    throw new InitializeApiError(
      "TRANSACTION_BUILD_FAILED",
      err instanceof Error
        ? err.message
        : "Failed to plan Initialize transactions",
      { status: 500 }
    );
  }

  let blockhash;
  try {
    ({ value: blockhash } = await args.rpc.getLatestBlockhash().send());
  } catch {
    throw new InitializeApiError(
      "RPC_UNAVAILABLE",
      "Could not fetch a recent blockhash",
      { status: 502 }
    );
  }

  let transactions: string[];
  try {
    transactions = await Promise.all(
      flattenTransactionPlan(transactionPlan).map(async ({ message }) => {
        const messageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
          blockhash,
          message
        );
        const partial =
          await partiallySignTransactionMessageWithSigners(messageWithLifetime);
        assertIsTransactionWithinSizeLimit(partial);
        return getBase64EncodedWireTransaction(partial);
      })
    );
  } catch (err) {
    throw new InitializeApiError(
      "TRANSACTION_BUILD_FAILED",
      err instanceof Error
        ? err.message
        : "Failed to partial-sign Initialize transactions",
      { status: 500 }
    );
  }

  if (transactions.length === 0) {
    throw new InitializeApiError(
      "TRANSACTION_BUILD_FAILED",
      "Initialize transaction plan was empty",
      { status: 500 }
    );
  }

  return {
    transactions,
    lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
  };
}
