import {
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
import { getApplyConfidentialPendingBurnInstruction } from "@solana-program/token-2022";
import { getUpdateConfidentialMintBurnDecryptableSupplyInstructionFromSupply } from "@solana-program/token-2022/confidential";
import {
  LOADED_ACCOUNTS_PAGE_SIZE,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_LOADED_ACCOUNTS_DATA_SIZE,
  MEMO_PROGRAM_ADDRESS,
  TRANSACTION_V1_FEATURE_ADDRESS,
  TRANSACTION_V1_WIRE_PREFIX,
} from "../../constants";
import { getAttackInstructionAsync } from "@/app/generated/pinata";
import type { SolanaRpc } from "../rpc";
import { AttackApiError } from "./errors";
import type { GeneratedAttackProofs } from "./proofs";

export type PreparedAttackTransaction = {
  transaction: string;
  lastValidBlockHeight: string;
};

async function assertTransactionV1Active(rpc: SolanaRpc): Promise<void> {
  let value;
  try {
    ({ value } = await rpc
      .getAccountInfo(TRANSACTION_V1_FEATURE_ADDRESS, { encoding: "base64" })
      .send());
  } catch {
    throw new AttackApiError(
      "RPC_UNAVAILABLE",
      "Could not check transaction-v1 activation",
      { status: 502 }
    );
  }
  if (!value) {
    throw new AttackApiError(
      "TRANSACTION_V1_UNAVAILABLE",
      "Transaction v1 is not active on the configured cluster",
      { status: 503 }
    );
  }
  try {
    const activation = getOptionDecoder(getU64Decoder()).decode(
      getBase64Encoder().encode(value.data[0])
    );
    if (!isSome(activation)) throw new Error("feature is inactive");
  } catch {
    throw new AttackApiError(
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
  return {
    computeUnitLimit: Math.min(
      MAX_COMPUTE_UNIT_LIMIT,
      Math.ceil(estimate.computeUnitLimit * 1.1)
    ),
    loadedAccountsDataSizeLimit: Math.min(
      MAX_LOADED_ACCOUNTS_DATA_SIZE,
      (Math.ceil(
        estimate.loadedAccountsDataSizeLimit / LOADED_ACCOUNTS_PAGE_SIZE
      ) +
        1) *
        LOADED_ACCOUNTS_PAGE_SIZE
    ),
  };
}

export async function buildPartialAttackTransaction(args: {
  rpc: SolanaRpc;
  attacker: Address;
  arbiter: KeyPairSigner;
  sessionId: string;
  hpMint: Address;
  newSupply: bigint;
  supplyAesKey: Parameters<
    typeof getUpdateConfidentialMintBurnDecryptableSupplyInstructionFromSupply
  >[0]["supplyAesKey"];
  proofs: GeneratedAttackProofs;
}): Promise<PreparedAttackTransaction> {
  await assertTransactionV1Active(args.rpc);

  const attacker = createNoopSigner(args.attacker);
  const attack = await getAttackInstructionAsync({
    attacker,
    arbiter: args.arbiter,
    hpMint: args.hpMint,
    sessionId: args.sessionId,
    equalityProofInstructionOffset: args.proofs.offsets.equality,
    ciphertextValidityProofInstructionOffset:
      args.proofs.offsets.ciphertextValidity,
    rangeProofInstructionOffset: args.proofs.offsets.range,
    zeroProofInstructionOffset: args.proofs.offsets.zero,
    newDecryptableAvailableBalance: args.proofs.newDecryptableAvailableBalance,
    burnAmountAuditorCiphertextLo: args.proofs.burnAmountAuditorCiphertextLo,
    burnAmountAuditorCiphertextHi: args.proofs.burnAmountAuditorCiphertextHi,
  });
  const applyPendingBurn = getApplyConfidentialPendingBurnInstruction({
    mint: args.hpMint,
    authority: args.arbiter,
  });
  const updateDecryptableSupply =
    getUpdateConfidentialMintBurnDecryptableSupplyInstructionFromSupply({
      mint: args.hpMint,
      authority: args.arbiter,
      supplyAesKey: args.supplyAesKey,
      supply: args.newSupply,
    });
  const memo = {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode("strike"),
  };

  let blockhash;
  try {
    ({ value: blockhash } = await args.rpc.getLatestBlockhash().send());
  } catch {
    throw new AttackApiError(
      "RPC_UNAVAILABLE",
      "Could not fetch a recent blockhash",
      { status: 502 }
    );
  }

  try {
    const draft = pipe(
      createTransactionMessage({ version: 1 }),
      (message) => setTransactionMessageFeePayerSigner(attacker, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
      (message) =>
        appendTransactionMessageInstructions(
          [
            memo,
            ...args.proofs.instructions,
            attack,
            applyPendingBurn,
            updateDecryptableSupply,
          ],
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
    if (bytes[0] !== TRANSACTION_V1_WIRE_PREFIX) {
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
      throw new AttackApiError(
        "SIMULATION_FAILED",
        logs.length > 0
          ? `Strike simulation failed: ${logs.slice(-1000)}`
          : `Strike simulation failed: ${JSON.stringify(simulation.value.err)}`,
        { status: 500 }
      );
    }
    return {
      transaction,
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
    };
  } catch (err) {
    if (err instanceof AttackApiError) throw err;
    throw new AttackApiError(
      "TRANSACTION_BUILD_FAILED",
      err instanceof Error
        ? err.message
        : "Failed to build the atomic Strike transaction",
      { status: 500 }
    );
  }
}
