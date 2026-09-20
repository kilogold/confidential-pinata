import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  createNoopSigner,
  createTransactionMessage,
  estimateResourceLimitsFactory,
  fillTransactionMessageProvisoryResourceLimits,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getOptionDecoder,
  getU64Decoder,
  isSome,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { getInitializeInstructionAsync } from "@/app/generated/pinata";
import type { SolanaRpc } from "../rpc";
import { InitializeApiError } from "./errors";
import type { GeneratedInitializeProofs } from "./proofs";

const ENABLE_TX_V1_FEATURE = address(
  "txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL"
);
const TRANSACTION_V1_PREFIX = 0x81;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;
const LOADED_ACCOUNTS_PAGE_SIZE = 32 * 1024;

export type PreparedInitializeTransaction = {
  transaction: string;
  lastValidBlockHeight: string;
};

async function assertTransactionV1Active(rpc: SolanaRpc): Promise<void> {
  let value;
  try {
    ({ value } = await rpc
      .getAccountInfo(ENABLE_TX_V1_FEATURE, { encoding: "base64" })
      .send());
  } catch {
    throw new InitializeApiError(
      "RPC_UNAVAILABLE",
      "Could not check transaction-v1 activation",
      { status: 502 }
    );
  }

  if (!value) {
    throw new InitializeApiError(
      "TRANSACTION_V1_UNAVAILABLE",
      "Transaction v1 is not active on the configured cluster",
      { status: 503 }
    );
  }

  try {
    const activation = getOptionDecoder(getU64Decoder()).decode(
      getBase64Encoder().encode(value.data[0])
    );
    if (!isSome(activation)) {
      throw new Error("feature is inactive");
    }
  } catch {
    throw new InitializeApiError(
      "TRANSACTION_V1_UNAVAILABLE",
      "Transaction v1 is not active on the configured cluster",
      { status: 503 }
    );
  }
}

function withResourceHeadroom(estimate: {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
}) {
  const computeUnitLimit = Math.min(
    MAX_COMPUTE_UNIT_LIMIT,
    Math.ceil(estimate.computeUnitLimit * 1.1)
  );
  const loadedAccountsDataSizeLimit = Math.min(
    MAX_LOADED_ACCOUNTS_DATA_SIZE,
    (Math.ceil(
      estimate.loadedAccountsDataSizeLimit / LOADED_ACCOUNTS_PAGE_SIZE
    ) +
      1) *
      LOADED_ACCOUNTS_PAGE_SIZE
  );
  return { computeUnitLimit, loadedAccountsDataSizeLimit };
}

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
  proofs: GeneratedInitializeProofs;
}): Promise<PreparedInitializeTransaction> {
  await assertTransactionV1Active(args.rpc);

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
    pubkeyValidityProofInstructionOffset: args.proofs.offsets.pubkeyValidity,
    equalityProofInstructionOffset: args.proofs.offsets.equality,
    ciphertextValidityProofInstructionOffset:
      args.proofs.offsets.ciphertextValidity,
    rangeProofInstructionOffset: args.proofs.offsets.range,
    decryptableZero: args.proofs.data.decryptableZero,
    newDecryptableSupply: args.proofs.data.newDecryptableSupply,
    mintAmountAuditorCiphertextLo:
      args.proofs.data.mintAmountAuditorCiphertextLo,
    mintAmountAuditorCiphertextHi:
      args.proofs.data.mintAmountAuditorCiphertextHi,
    expectedPendingBalanceCreditCounter:
      args.proofs.data.expectedPendingBalanceCreditCounter,
    newDecryptableAvailableBalance:
      args.proofs.data.newDecryptableAvailableBalance,
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

  try {
    const draft = pipe(
      createTransactionMessage({ version: 1 }),
      (message) => setTransactionMessageFeePayerSigner(gmSigner, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
      (message) =>
        appendTransactionMessageInstructions(
          [...args.proofs.instructions, initializeIx],
          message
        ),
      fillTransactionMessageProvisoryResourceLimits
    );

    const estimate = await estimateResourceLimitsFactory({ rpc: args.rpc })(
      draft
    );
    const message = setTransactionMessageConfig(
      withResourceHeadroom(estimate),
      draft
    );
    const partial = await partiallySignTransactionMessageWithSigners(message);
    assertIsTransactionWithinSizeLimit(partial);

    const transaction = getBase64EncodedWireTransaction(partial);
    const bytes = getBase64Encoder().encode(transaction);
    if (bytes[0] !== TRANSACTION_V1_PREFIX) {
      throw new Error("Prepared transaction is not transaction v1");
    }

    const simulation = await args.rpc
      .simulateTransaction(transaction, {
        encoding: "base64",
        sigVerify: false,
      })
      .send();
    if (simulation.value.err) {
      const logs = simulation.value.logs?.join("\n") ?? "";
      throw new InitializeApiError(
        "SIMULATION_FAILED",
        logs.length > 0
          ? `Initialize simulation failed: ${logs.slice(-1000)}`
          : `Initialize simulation failed: ${JSON.stringify(simulation.value.err)}`,
        { status: 500 }
      );
    }

    return {
      transaction,
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
    };
  } catch (err) {
    if (err instanceof InitializeApiError) throw err;
    throw new InitializeApiError(
      "TRANSACTION_BUILD_FAILED",
      err instanceof Error
        ? err.message
        : "Failed to build the atomic Initialize transaction",
      { status: 500 }
    );
  }
}
