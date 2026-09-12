import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
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
import type { MintProofAccounts } from "./proofs";

export async function buildPartialInitializeTransaction(args: {
  rpc: SolanaRpc;
  gm: Address;
  arbiter: KeyPairSigner;
  sessionId: string;
  strikeFeeLamports: bigint;
  rewardAmount: bigint;
  rewardMint: Address;
  rewardTokenProgram: Address;
  hpMint: Address;
  proofs: MintProofAccounts;
}): Promise<string> {
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
    equalityProof: args.proofs.equalityProof,
    ciphertextValidityProof: args.proofs.ciphertextValidityProof,
    rangeProof: args.proofs.rangeProof,
    pubkeyValidityProof: args.proofs.pubkeyValidityProof,
    zeroProof: args.proofs.zeroProof,
    decryptableZero: args.proofs.decryptableZero,
    newDecryptableSupply: args.proofs.newDecryptableSupply,
    mintAmountAuditorCiphertextLo: args.proofs.mintAmountAuditorCiphertextLo,
    mintAmountAuditorCiphertextHi: args.proofs.mintAmountAuditorCiphertextHi,
    expectedPendingBalanceCreditCounter:
      args.proofs.expectedPendingBalanceCreditCounter,
    newDecryptableAvailableBalance: args.proofs.newDecryptableAvailableBalance,
  });

  const cuIx = getSetComputeUnitLimitInstruction({
    units: INITIALIZE_COMPUTE_UNIT_LIMIT,
  });

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

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(gmSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([cuIx, initializeIx], m)
  );

  let partial;
  try {
    partial = await partiallySignTransactionMessageWithSigners(message);
  } catch (err) {
    throw new InitializeApiError(
      "TRANSACTION_BUILD_FAILED",
      err instanceof Error ? err.message : "Failed to partial-sign Initialize",
      { status: 500 }
    );
  }

  const wire = getBase64EncodedWireTransaction(partial);

  try {
    const sim = await args.rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
      .send();
    if (sim.value.err) {
      const logs = sim.value.logs?.join("\n") ?? "";
      const errDetail =
        typeof sim.value.err === "string"
          ? sim.value.err
          : JSON.stringify(sim.value.err);
      throw new InitializeApiError(
        "SIMULATION_FAILED",
        logs.length > 0
          ? `Initialize simulation failed (${errDetail}): ${logs.slice(-500)}`
          : `Initialize simulation failed: ${errDetail}`,
        { status: 400 }
      );
    }
  } catch (err) {
    if (err instanceof InitializeApiError) throw err;
    throw new InitializeApiError(
      "SIMULATION_FAILED",
      err instanceof Error ? err.message : "Initialize simulation failed",
      { status: 400 }
    );
  }

  return wire;
}
