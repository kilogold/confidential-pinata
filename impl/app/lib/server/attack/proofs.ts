import { ristretto255 } from "@noble/curves/ed25519.js";
import {
  getAddressEncoder,
  isSome,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  verifyZeroCiphertext,
} from "@solana-program/zk-elgamal-proof";
import {
  AeCiphertext,
  AeKey,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  ElGamalPubkey,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
  ZeroCiphertextProofData,
} from "@solana/zk-sdk/node";
import { fetchMaybeToken, type Extension } from "@solana-program/token-2022";
import type { SolanaRpc } from "../rpc";
import { AttackApiError } from "./errors";

const { Point: RistrettoPoint } = ristretto255;
// Token-2022 confidential-burn proof layout: 64, 16, 32, 16 bits.
// https://github.com/solana-program/token-2022/blob/main/clients/js/src/confidentialTransferHelpers.ts
const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;
const TRANSFER_AMOUNT_HI_BIT_LENGTH = 32n;
const AVAILABLE_BALANCE_BIT_LENGTH = 64;
const RANGE_PROOF_PADDING_BIT_LENGTH = 16;
const SOURCE_HANDLE_INDEX = 0;
const AUDITOR_HANDLE_INDEX = 2;
const STRIKE_AMOUNT = 1n;
const ZERO_AMOUNT = 0n;

export type GeneratedAttackProofs = {
  instructions: Instruction[];
  offsets: {
    equality: number;
    ciphertextValidity: number;
    range: number;
    zero: number;
  };
  newDecryptableAvailableBalance: Uint8Array;
  burnAmountAuditorCiphertextLo: Uint8Array;
  burnAmountAuditorCiphertextHi: Uint8Array;
};

function pointFromBytes(bytes: Uint8Array) {
  return RistrettoPoint.fromBytes(bytes);
}

function ciphertextToPoints(ciphertext: Uint8Array) {
  return {
    commitment: pointFromBytes(ciphertext.slice(0, 32)),
    handle: pointFromBytes(ciphertext.slice(32, 64)),
  };
}

function pointsToCiphertext(
  commitment: ReturnType<typeof pointFromBytes>,
  handle: ReturnType<typeof pointFromBytes>
): Uint8Array {
  const ciphertext = new Uint8Array(64);
  ciphertext.set(commitment.toBytes(), 0);
  ciphertext.set(handle.toBytes(), 32);
  return ciphertext;
}

function combineLoHiCiphertexts(
  ciphertextLo: Uint8Array,
  ciphertextHi: Uint8Array,
  bitLength: bigint
): Uint8Array {
  const lo = ciphertextToPoints(ciphertextLo);
  const hi = ciphertextToPoints(ciphertextHi);
  return pointsToCiphertext(
    lo.commitment.add(hi.commitment.multiply(1n << bitLength)),
    lo.handle.add(hi.handle.multiply(1n << bitLength))
  );
}

function subtractCiphertexts(left: Uint8Array, right: Uint8Array): Uint8Array {
  const l = ciphertextToPoints(left);
  const r = ciphertextToPoints(right);
  return pointsToCiphertext(
    l.commitment.subtract(r.commitment),
    l.handle.subtract(r.handle)
  );
}

function extractCiphertextFromGroupedBytes(
  groupedCiphertext: Uint8Array,
  handleIndex: number
): Uint8Array {
  const start = 32 + handleIndex * 32;
  const ciphertext = new Uint8Array(64);
  ciphertext.set(groupedCiphertext.slice(0, 32), 0);
  ciphertext.set(groupedCiphertext.slice(start, start + 32), 32);
  return ciphertext;
}

function requireExtension<K extends Extension["__kind"]>(
  extensions: readonly Extension[] | undefined,
  kind: K
): Extract<Extension, { __kind: K }> {
  const extension = extensions?.find(
    (candidate): candidate is Extract<Extension, { __kind: K }> =>
      candidate.__kind === kind
  );
  if (!extension) {
    throw new AttackApiError(
      "HP_VAULT_MISCONFIGURED",
      "The session HP vault is not configured for confidential strikes",
      { status: 500 }
    );
  }
  return extension;
}

function proofOrThrow<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new AttackApiError(
      "PROOF_SETUP_FAILED",
      err instanceof Error
        ? `Could not generate the ${label} proof: ${err.message}`
        : `Could not generate the ${label} proof`,
      { status: 500 }
    );
  }
}

async function inlineProofInstruction(args: {
  rpc: SolanaRpc;
  payer: TransactionSigner;
  label: string;
  proofBytes: Uint8Array;
  verify: (input: {
    rpc: SolanaRpc;
    payer: TransactionSigner;
    proofData: Uint8Array;
  }) => Promise<Instruction[]>;
}): Promise<Instruction> {
  const instructions = await args.verify({
    rpc: args.rpc,
    payer: args.payer,
    proofData: args.proofBytes,
  });
  if (instructions.length !== 1) {
    throw new AttackApiError(
      "PROOF_SETUP_FAILED",
      `Expected one inline ${args.label} proof instruction, received ${instructions.length}`,
      { status: 500 }
    );
  }
  return instructions[0]!;
}

export async function generateAttackProofs(args: {
  rpc: SolanaRpc;
  payer: TransactionSigner;
  hpVault: Address;
  elgamal: ElGamalKeypair;
  aes: AeKey;
}): Promise<GeneratedAttackProofs> {
  const vault = await fetchMaybeToken(args.rpc, args.hpVault);
  if (!vault.exists) {
    throw new AttackApiError("HP_VAULT_MISCONFIGURED", "HP vault is missing", {
      status: 500,
    });
  }
  const extensions = isSome(vault.data.extensions)
    ? vault.data.extensions.value
    : undefined;
  const confidential = requireExtension(
    extensions,
    "ConfidentialTransferAccount"
  );

  const decryptableBalance = AeCiphertext.fromBytes(
    new Uint8Array(confidential.decryptableAvailableBalance)
  );
  if (!decryptableBalance) {
    throw new AttackApiError(
      "HP_VAULT_MISCONFIGURED",
      "Could not decode the HP vault balance",
      { status: 500 }
    );
  }
  let currentAvailable: bigint;
  try {
    currentAvailable = args.aes.decrypt(decryptableBalance);
  } catch {
    throw new AttackApiError(
      "HP_VAULT_MISCONFIGURED",
      "Could not read the HP vault with the arbiter key",
      { status: 500 }
    );
  }
  if (currentAvailable < 1n) {
    throw new AttackApiError(
      "PROOF_SETUP_FAILED",
      "Could not prepare a strike for this session",
      { status: 409 }
    );
  }
  const newAvailable = currentAvailable - 1n;

  const source = ElGamalPubkey.fromBytes(
    new Uint8Array(getAddressEncoder().encode(confidential.elgamalPubkey))
  );
  const currentCiphertext = ElGamalCiphertext.fromBytes(
    new Uint8Array(confidential.availableBalance)
  );
  const auditor = ElGamalPubkey.fromBytes(new Uint8Array(32));
  if (!source || !currentCiphertext || !auditor) {
    throw new AttackApiError(
      "HP_VAULT_MISCONFIGURED",
      "Could not decode the HP vault ciphertext",
      { status: 500 }
    );
  }

  const amountLo = STRIKE_AMOUNT;
  const amountHi = ZERO_AMOUNT;
  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
    source,
    args.elgamal.pubkey(),
    auditor,
    amountLo,
    openingLo
  );
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
    source,
    args.elgamal.pubkey(),
    auditor,
    amountHi,
    openingHi
  );
  const groupedLoBytes = groupedLo.toBytes();
  const groupedHiBytes = groupedHi.toBytes();
  const sourceLo = extractCiphertextFromGroupedBytes(
    groupedLoBytes,
    SOURCE_HANDLE_INDEX
  );
  const sourceHi = extractCiphertextFromGroupedBytes(
    groupedHiBytes,
    SOURCE_HANDLE_INDEX
  );
  const auditorLo = extractCiphertextFromGroupedBytes(
    groupedLoBytes,
    AUDITOR_HANDLE_INDEX
  );
  const auditorHi = extractCiphertextFromGroupedBytes(
    groupedHiBytes,
    AUDITOR_HANDLE_INDEX
  );
  const newAvailableCiphertext = ElGamalCiphertext.fromBytes(
    subtractCiphertexts(
      currentCiphertext.toBytes(),
      combineLoHiCiphertexts(sourceLo, sourceHi, TRANSFER_AMOUNT_LO_BIT_LENGTH)
    )
  );
  if (!newAvailableCiphertext) {
    throw new AttackApiError(
      "HP_VAULT_MISCONFIGURED",
      "Could not derive the post-strike HP ciphertext",
      { status: 500 }
    );
  }

  const newAvailableOpening = new PedersenOpening();
  const newAvailableCommitment = PedersenCommitment.from(
    newAvailable,
    newAvailableOpening
  );
  const equality = proofOrThrow(
    "equality",
    () =>
      new CiphertextCommitmentEqualityProofData(
        args.elgamal,
        newAvailableCiphertext,
        newAvailableCommitment,
        newAvailableOpening,
        newAvailable
      )
  );
  const validity = proofOrThrow(
    "ciphertext-validity",
    () =>
      new BatchedGroupedCiphertext3HandlesValidityProofData(
        source,
        args.elgamal.pubkey(),
        auditor,
        groupedLo,
        groupedHi,
        amountLo,
        amountHi,
        openingLo,
        openingHi
      )
  );
  const paddingOpening = new PedersenOpening();
  const range = proofOrThrow(
    "range",
    () =>
      new BatchedRangeProofU128Data(
        [
          newAvailableCommitment,
          PedersenCommitment.fromBytes(groupedLoBytes.slice(0, 32)),
          PedersenCommitment.fromBytes(groupedHiBytes.slice(0, 32)),
          PedersenCommitment.from(ZERO_AMOUNT, paddingOpening),
        ],
        new BigUint64Array([newAvailable, amountLo, amountHi, ZERO_AMOUNT]),
        Uint8Array.from([
          AVAILABLE_BALANCE_BIT_LENGTH,
          Number(TRANSFER_AMOUNT_LO_BIT_LENGTH),
          Number(TRANSFER_AMOUNT_HI_BIT_LENGTH),
          RANGE_PROOF_PADDING_BIT_LENGTH,
        ]),
        [newAvailableOpening, openingLo, openingHi, paddingOpening]
      )
  );

  const instructions = [
    await inlineProofInstruction({
      rpc: args.rpc,
      payer: args.payer,
      label: "equality",
      proofBytes: equality.toBytes(),
      verify: verifyCiphertextCommitmentEquality,
    }),
    await inlineProofInstruction({
      rpc: args.rpc,
      payer: args.payer,
      label: "ciphertext-validity",
      proofBytes: validity.toBytes(),
      verify: verifyBatchedGroupedCiphertext3HandlesValidity,
    }),
    await inlineProofInstruction({
      rpc: args.rpc,
      payer: args.payer,
      label: "range",
      proofBytes: range.toBytes(),
      verify: verifyBatchedRangeProofU128,
    }),
  ];
  if (newAvailable === 0n) {
    const zero = proofOrThrow(
      "zero ciphertext",
      () => new ZeroCiphertextProofData(args.elgamal, newAvailableCiphertext)
    );
    instructions.push(
      await inlineProofInstruction({
        rpc: args.rpc,
        payer: args.payer,
        label: "zero ciphertext",
        proofBytes: zero.toBytes(),
        verify: verifyZeroCiphertext,
      })
    );
  }

  const attackIndex = instructions.length;
  return {
    instructions,
    offsets: {
      // Equality proof is expected at absolute transaction index 0.
      equality: -attackIndex,
      // Ciphertext-validity proof is expected at absolute transaction index 1.
      ciphertextValidity: 1 - attackIndex,
      // Range proof is expected at absolute transaction index 2.
      range: 2 - attackIndex,
      // Zero proof is expected at absolute transaction index 3; zero means absent.
      zero: newAvailable === 0n ? 3 - attackIndex : 0,
    },
    newDecryptableAvailableBalance: args.aes.encrypt(newAvailable).toBytes(),
    burnAmountAuditorCiphertextLo: auditorLo,
    burnAmountAuditorCiphertextHi: auditorHi,
  };
}
