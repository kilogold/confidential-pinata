import { ristretto255 } from "@noble/curves/ed25519";
import {
  generateKeyPairSigner,
  isSome,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  verifyPubkeyValidity,
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
  PubkeyValidityProofData,
  ZeroCiphertextProofData,
} from "@solana/zk-sdk/node";
import {
  fetchMint,
  fetchMaybeToken,
  type Extension,
} from "@solana-program/token-2022";
import { SYSTEM_PROGRAM_ADDRESS } from "@/app/lib/constants";
import type { SolanaRpc } from "../rpc";
import { InitializeApiError } from "./errors";
import { sendAndConfirmInstructions } from "./send";

const { Point: RistrettoPoint } = ristretto255;
const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;
const TRANSFER_AMOUNT_HI_BIT_LENGTH = 32n;
const SUPPLY_BIT_LENGTH = 64;
const RANGE_PROOF_PADDING_BIT_LENGTH = 16;
const LARGE_PROOF_BYTES = 800;

export type MintProofAccounts = {
  equalityProof: Address;
  ciphertextValidityProof: Address;
  rangeProof: Address;
  pubkeyValidityProof?: Address;
  zeroProof?: Address;
  decryptableZero: Uint8Array;
  newDecryptableSupply: Uint8Array;
  mintAmountAuditorCiphertextLo: Uint8Array;
  mintAmountAuditorCiphertextHi: Uint8Array;
  expectedPendingBalanceCreditCounter: bigint;
  newDecryptableAvailableBalance: Uint8Array;
};

function pointFromBytes(bytes: Uint8Array) {
  return RistrettoPoint.fromHex(bytes);
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
  ciphertext.set(commitment.toRawBytes(), 0);
  ciphertext.set(handle.toRawBytes(), 32);
  return ciphertext;
}

function addCiphertexts(left: Uint8Array, right: Uint8Array): Uint8Array {
  const l = ciphertextToPoints(left);
  const r = ciphertextToPoints(right);
  return pointsToCiphertext(
    l.commitment.add(r.commitment),
    l.handle.add(r.handle)
  );
}

function combineLoHiCiphertexts(
  ciphertextLo: Uint8Array,
  ciphertextHi: Uint8Array,
  bitLength: bigint
): Uint8Array {
  const scale = 1n << bitLength;
  const lo = ciphertextToPoints(ciphertextLo);
  const hi = ciphertextToPoints(ciphertextHi);
  return pointsToCiphertext(
    lo.commitment.add(hi.commitment.multiply(scale)),
    lo.handle.add(hi.handle.multiply(scale))
  );
}

function extractCiphertextFromGroupedBytes(
  groupedCiphertext: Uint8Array,
  handleIndex: number
): Uint8Array {
  const start = 32 + handleIndex * 32;
  const end = start + 32;
  const ciphertext = new Uint8Array(64);
  ciphertext.set(groupedCiphertext.slice(0, 32), 0);
  ciphertext.set(groupedCiphertext.slice(start, end), 32);
  return ciphertext;
}

function splitAmount(amount: bigint, bitLength: bigint): [bigint, bigint] {
  const mask = (1n << bitLength) - 1n;
  return [amount & mask, amount >> bitLength];
}

function parseElGamalCiphertext(bytes: Uint8Array): ElGamalCiphertext {
  const ciphertext = ElGamalCiphertext.fromBytes(bytes);
  if (!ciphertext) {
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "Could not deserialize an ElGamal ciphertext on the HP mint",
      { status: 500 }
    );
  }
  return ciphertext;
}

function requireExtension<K extends Extension["__kind"]>(
  extensions: readonly Extension[] | undefined,
  kind: K,
  message: string
): Extract<Extension, { __kind: K }> {
  const found = extensions?.find(
    (candidate): candidate is Extract<Extension, { __kind: K }> =>
      candidate.__kind === kind
  );
  if (!found) {
    throw new InitializeApiError("HP_MINT_MISCONFIGURED", message, {
      status: 500,
    });
  }
  return found;
}

function proofOrThrow<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new InitializeApiError(
      "PROOF_SETUP_FAILED",
      `Could not generate the ${label} proof`,
      { status: 500 }
    );
  }
}

async function sendProofVerify(args: {
  rpc: SolanaRpc;
  payer: TransactionSigner;
  instructions: Instruction[];
}): Promise<void> {
  const { rpc, payer, instructions } = args;
  if (instructions.length <= 1) {
    await sendAndConfirmInstructions(rpc, payer, instructions);
    return;
  }
  try {
    await sendAndConfirmInstructions(rpc, payer, instructions);
  } catch (err) {
    if (err instanceof InitializeApiError) {
      for (const ix of instructions) {
        await sendAndConfirmInstructions(rpc, payer, [ix]);
      }
      return;
    }
    throw err;
  }
}

async function verifyIntoContext(args: {
  rpc: SolanaRpc;
  payer: KeyPairSigner;
  proofBytes: Uint8Array;
  verify: (input: {
    rpc: SolanaRpc;
    payer: KeyPairSigner;
    proofData: Uint8Array;
    contextState: { contextAccount: KeyPairSigner; authority: Address };
  }) => Promise<Instruction[]>;
}): Promise<Address> {
  const contextAccount = await generateKeyPairSigner();
  const instructions = await args.verify({
    rpc: args.rpc,
    payer: args.payer,
    proofData: args.proofBytes,
    contextState: {
      contextAccount,
      authority: args.payer.address,
    },
  });
  if (args.proofBytes.length > LARGE_PROOF_BYTES && instructions.length > 1) {
    await sendAndConfirmInstructions(args.rpc, args.payer, [instructions[0]!]);
    await sendAndConfirmInstructions(
      args.rpc,
      args.payer,
      instructions.slice(1)
    );
  } else {
    await sendProofVerify({
      rpc: args.rpc,
      payer: args.payer,
      instructions,
    });
  }
  return contextAccount.address;
}

export async function hpVaultNeedsCreate(
  rpc: SolanaRpc,
  hpVault: Address
): Promise<boolean> {
  let value;
  try {
    ({ value } = await rpc
      .getAccountInfo(hpVault, { encoding: "base64" })
      .send());
  } catch (err) {
    throw new InitializeApiError(
      "RPC_UNAVAILABLE",
      err instanceof Error ? err.message : "Could not fetch HP vault",
      { status: 502 }
    );
  }
  if (!value) return true;
  if (value.data[0] === "" || value.lamports === 0n) return true;
  return value.owner === SYSTEM_PROGRAM_ADDRESS;
}

export async function generateInitializeProofs(args: {
  rpc: SolanaRpc;
  payer: KeyPairSigner;
  elgamal: ElGamalKeypair;
  aes: AeKey;
  hpMint: Address;
  hpVault: Address;
  hp: bigint;
  needsVaultCreate: boolean;
  needsZeroProof: boolean;
}): Promise<MintProofAccounts> {
  const mintAccount = await fetchMint(args.rpc, args.hpMint);
  const mintExtensions = isSome(mintAccount.data.extensions)
    ? mintAccount.data.extensions.value
    : undefined;
  requireExtension(
    mintExtensions,
    "ConfidentialTransferMint",
    "HP mint is missing ConfidentialTransferMint"
  );
  const mintBurn = requireExtension(
    mintExtensions,
    "ConfidentialMintBurn",
    "HP mint is missing ConfidentialMintBurn"
  );

  const currentSupplyCiphertext = parseElGamalCiphertext(
    new Uint8Array(mintBurn.confidentialSupply)
  );
  const decryptableSupply = AeCiphertext.fromBytes(
    new Uint8Array(mintBurn.decryptableSupply)
  );
  if (!decryptableSupply) {
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "Could not deserialize HP mint decryptable supply",
      { status: 500 }
    );
  }
  let currentSupplyAmount: bigint;
  try {
    currentSupplyAmount = args.aes.decrypt(decryptableSupply);
  } catch {
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "Could not decrypt HP mint supply with the arbiter key",
      { status: 500 }
    );
  }
  const newSupplyAmount = currentSupplyAmount + args.hp;

  const vaultToken = await fetchMaybeToken(args.rpc, args.hpVault);
  let expectedPending = 1n;
  let currentAvailable = 0n;
  if (vaultToken.exists) {
    const ext = isSome(vaultToken.data.extensions)
      ? vaultToken.data.extensions.value.find(
          (candidate) => candidate.__kind === "ConfidentialTransferAccount"
        )
      : undefined;
    if (ext && ext.__kind === "ConfidentialTransferAccount") {
      expectedPending = ext.pendingBalanceCreditCounter + 1n;
      const availableCt = AeCiphertext.fromBytes(
        new Uint8Array(ext.decryptableAvailableBalance)
      );
      if (availableCt) {
        currentAvailable = args.aes.decrypt(availableCt);
      }
    }
  }

  const destination = args.elgamal.pubkey();
  const supplyPubkey = args.elgamal.pubkey();
  const auditor = proofOrThrow("auditor key", () =>
    ElGamalPubkey.fromBytes(new Uint8Array(32))
  );
  const [lo, hi] = splitAmount(args.hp, TRANSFER_AMOUNT_LO_BIT_LENGTH);
  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
    destination,
    supplyPubkey,
    auditor,
    lo,
    openingLo
  );
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
    destination,
    supplyPubkey,
    auditor,
    hi,
    openingHi
  );
  const groupedLoBytes = groupedLo.toBytes();
  const groupedHiBytes = groupedHi.toBytes();
  const supplyLo = extractCiphertextFromGroupedBytes(groupedLoBytes, 1);
  const supplyHi = extractCiphertextFromGroupedBytes(groupedHiBytes, 1);
  const auditorLo = extractCiphertextFromGroupedBytes(groupedLoBytes, 2);
  const auditorHi = extractCiphertextFromGroupedBytes(groupedHiBytes, 2);
  const newSupplyCiphertextBytes = addCiphertexts(
    currentSupplyCiphertext.toBytes(),
    combineLoHiCiphertexts(supplyLo, supplyHi, TRANSFER_AMOUNT_LO_BIT_LENGTH)
  );
  const newSupplyCiphertext = parseElGamalCiphertext(newSupplyCiphertextBytes);
  const newSupplyOpening = new PedersenOpening();
  const newSupplyCommitment = PedersenCommitment.from(
    newSupplyAmount,
    newSupplyOpening
  );

  const equality = proofOrThrow(
    "equality",
    () =>
      new CiphertextCommitmentEqualityProofData(
        args.elgamal,
        newSupplyCiphertext,
        newSupplyCommitment,
        newSupplyOpening,
        newSupplyAmount
      )
  );
  const validity = proofOrThrow(
    "ciphertext validity",
    () =>
      new BatchedGroupedCiphertext3HandlesValidityProofData(
        destination,
        supplyPubkey,
        auditor,
        groupedLo,
        groupedHi,
        lo,
        hi,
        openingLo,
        openingHi
      )
  );
  const paddingOpening = new PedersenOpening();
  const paddingCommitment = PedersenCommitment.from(0n, paddingOpening);
  const commitmentLo = proofOrThrow("range lo commitment", () =>
    PedersenCommitment.fromBytes(groupedLoBytes.slice(0, 32))
  );
  const commitmentHi = proofOrThrow("range hi commitment", () =>
    PedersenCommitment.fromBytes(groupedHiBytes.slice(0, 32))
  );
  const range = proofOrThrow(
    "range",
    () =>
      new BatchedRangeProofU128Data(
        [newSupplyCommitment, commitmentLo, commitmentHi, paddingCommitment],
        new BigUint64Array([newSupplyAmount, lo, hi, 0n]),
        Uint8Array.from([
          SUPPLY_BIT_LENGTH,
          Number(TRANSFER_AMOUNT_LO_BIT_LENGTH),
          Number(TRANSFER_AMOUNT_HI_BIT_LENGTH),
          RANGE_PROOF_PADDING_BIT_LENGTH,
        ]),
        [newSupplyOpening, openingLo, openingHi, paddingOpening]
      )
  );

  const equalityProof = await verifyIntoContext({
    rpc: args.rpc,
    payer: args.payer,
    proofBytes: equality.toBytes(),
    verify: verifyCiphertextCommitmentEquality,
  });
  const ciphertextValidityProof = await verifyIntoContext({
    rpc: args.rpc,
    payer: args.payer,
    proofBytes: validity.toBytes(),
    verify: verifyBatchedGroupedCiphertext3HandlesValidity,
  });
  const rangeProof = await verifyIntoContext({
    rpc: args.rpc,
    payer: args.payer,
    proofBytes: range.toBytes(),
    verify: verifyBatchedRangeProofU128,
  });

  let pubkeyValidityProof: Address | undefined;
  if (args.needsVaultCreate) {
    const pubkeyProof = new PubkeyValidityProofData(args.elgamal);
    pubkeyValidityProof = await verifyIntoContext({
      rpc: args.rpc,
      payer: args.payer,
      proofBytes: pubkeyProof.toBytes(),
      verify: verifyPubkeyValidity,
    });
  }

  let zeroProof: Address | undefined;
  if (args.needsZeroProof) {
    if (!vaultToken.exists) {
      throw new InitializeApiError(
        "HP_MINT_MISCONFIGURED",
        "Zero leftover proof required but the HP vault does not exist",
        { status: 400 }
      );
    }
    const ext = isSome(vaultToken.data.extensions)
      ? vaultToken.data.extensions.value.find(
          (candidate) => candidate.__kind === "ConfidentialTransferAccount"
        )
      : undefined;
    if (!ext || ext.__kind !== "ConfidentialTransferAccount") {
      throw new InitializeApiError(
        "HP_MINT_MISCONFIGURED",
        "HP vault is missing ConfidentialTransferAccount",
        { status: 400 }
      );
    }
    const leftover = parseElGamalCiphertext(
      new Uint8Array(ext.availableBalance)
    );
    const zero = new ZeroCiphertextProofData(args.elgamal, leftover);
    zeroProof = await verifyIntoContext({
      rpc: args.rpc,
      payer: args.payer,
      proofBytes: zero.toBytes(),
      verify: verifyZeroCiphertext,
    });
  }

  const newAvailable = currentAvailable + args.hp;

  return {
    equalityProof,
    ciphertextValidityProof,
    rangeProof,
    pubkeyValidityProof,
    zeroProof,
    decryptableZero: args.aes.encrypt(0n).toBytes(),
    newDecryptableSupply: args.aes.encrypt(newSupplyAmount).toBytes(),
    mintAmountAuditorCiphertextLo: auditorLo,
    mintAmountAuditorCiphertextHi: auditorHi,
    expectedPendingBalanceCreditCounter: expectedPending,
    newDecryptableAvailableBalance: args.aes.encrypt(newAvailable).toBytes(),
  };
}
