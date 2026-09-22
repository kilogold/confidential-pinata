import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, test } from "node:test";
import { ristretto255 } from "@noble/curves/ed25519.js";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpc,
  createTransactionMessage,
  createNoopSigner,
  estimateResourceLimitsFactory,
  fillTransactionMessageProvisoryResourceLimits,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  isSome,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { fetchToken, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeToken, fetchMint } from "@solana-program/token-2022";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  verifyZeroCiphertext,
} from "@solana-program/zk-elgamal-proof";
import {
  AeCiphertext,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalPubkey,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
  ZeroCiphertextProofData,
} from "@solana/zk-sdk/node";
import {
  fetchSession,
  getAttackInstructionAsync,
  findHpVaultPda,
  findRewardVaultPda,
  findSessionPda,
  SessionStatus,
} from "@/app/generated/pinata";
import {
  ARBITER_ACCOUNT,
  DEVNET_HP_MINT,
  DEVNET_USDC_MINT,
} from "@/app/lib/constants";
import { deriveArbiterKeys } from "@/app/lib/server/arbiter-keys";
import { loadArbiterEnv } from "@/app/lib/server/env";
import { buildPartialInitializeTransaction } from "@/app/lib/server/initialize/build";
import {
  generateInitializeProofs,
  hpVaultNeedsCreate,
} from "@/app/lib/server/initialize/proofs";
import type { SolanaRpc } from "@/app/lib/server/rpc";
import { signAndSendEmbeddedTransaction } from "@/app/lib/wallet/embedded/send";

function loadEnvFile(path: string): void {
  if (process.env.ARBITER_AUTHORITY_SECRET_KEY_BASE64) return;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(resolve(import.meta.dirname, "../../.env.local"));

const HP_AMOUNT = 5n;
const REWARD_AMOUNT = 1_000_000n;
const STRIKE_FEE_LAMPORTS = 1_000_000n;
const SOL_LAMPORTS = 10_000_000_000n;
const USDC_AMOUNT = 1_000_000_000n;
const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;
const TRANSFER_AMOUNT_HI_BIT_LENGTH = 32n;
const AVAILABLE_BALANCE_BIT_LENGTH = 64;
const RANGE_PROOF_PADDING_BIT_LENGTH = 16;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;
const LOADED_ACCOUNTS_PAGE_SIZE = 32 * 1024;
const MEMO_PROGRAM_ADDRESS = address(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

const { Point: RistrettoPoint } = ristretto255;

const rpcUrl =
  process.env.ANCHOR_PROVIDER_URL?.trim() || "http://127.0.0.1:8899";

let gm!: KeyPairSigner;
let player!: KeyPairSigner;
let arbiter!: Awaited<ReturnType<typeof deriveArbiterKeys>>;
let hpMint!: Address;
let rpc!: SolanaRpc;

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

async function inlineProofInstruction(args: {
  label: string;
  proofBytes: Uint8Array;
  verify: (input: {
    rpc: SolanaRpc;
    payer: ReturnType<typeof createNoopSigner>;
    proofData: Uint8Array;
  }) => Promise<Instruction[]>;
}): Promise<Instruction> {
  const instructions = await args.verify({
    rpc,
    payer: createNoopSigner(player.address),
    proofData: args.proofBytes,
  });
  assert.equal(
    instructions.length,
    1,
    `expected one inline ${args.label} proof`
  );
  return instructions[0]!;
}

async function generateAttackProofs(args: {
  hpVault: Address;
  terminal: boolean;
}): Promise<{
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
}> {
  const maybeVault = await fetchMaybeToken(rpc, args.hpVault);
  if (!maybeVault.exists) {
    throw new Error("HP vault missing after Initialize");
  }
  const extensions = isSome(maybeVault.data.extensions)
    ? maybeVault.data.extensions.value
    : [];
  const confidential = extensions.find(
    (extension) => extension.__kind === "ConfidentialTransferAccount"
  );
  if (!confidential || confidential.__kind !== "ConfidentialTransferAccount") {
    throw new Error("HP vault missing ConfidentialTransferAccount");
  }

  const decryptable = AeCiphertext.fromBytes(
    new Uint8Array(confidential.decryptableAvailableBalance)
  );
  const currentAvailable = decryptable && arbiter.aes.decrypt(decryptable);
  if (currentAvailable === undefined || currentAvailable < 1n) {
    throw new Error("HP vault has no available balance to burn");
  }
  const newAvailable = currentAvailable - 1n;
  assert.equal(
    args.terminal,
    newAvailable === 0n,
    "terminal proof must match post-burn HP"
  );

  const source = ElGamalPubkey.fromBytes(
    new Uint8Array(getAddressEncoder().encode(confidential.elgamalPubkey))
  );
  const currentCiphertext = ElGamalCiphertext.fromBytes(
    new Uint8Array(confidential.availableBalance)
  );
  const auditor = ElGamalPubkey.fromBytes(new Uint8Array(32));
  if (!source || !currentCiphertext || !auditor) {
    throw new Error("could not decode confidential HP vault data");
  }

  const amountLo = 1n;
  const amountHi = 0n;
  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
    source,
    arbiter.elgamal.pubkey(),
    auditor,
    amountLo,
    openingLo
  );
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
    source,
    arbiter.elgamal.pubkey(),
    auditor,
    amountHi,
    openingHi
  );
  const groupedLoBytes = groupedLo.toBytes();
  const groupedHiBytes = groupedHi.toBytes();
  const sourceLo = extractCiphertextFromGroupedBytes(groupedLoBytes, 0);
  const sourceHi = extractCiphertextFromGroupedBytes(groupedHiBytes, 0);
  const auditorLo = extractCiphertextFromGroupedBytes(groupedLoBytes, 2);
  const auditorHi = extractCiphertextFromGroupedBytes(groupedHiBytes, 2);
  const newAvailableCiphertextBytes = subtractCiphertexts(
    currentCiphertext.toBytes(),
    combineLoHiCiphertexts(sourceLo, sourceHi, TRANSFER_AMOUNT_LO_BIT_LENGTH)
  );
  const newAvailableCiphertext = ElGamalCiphertext.fromBytes(
    newAvailableCiphertextBytes
  );
  if (!newAvailableCiphertext) {
    throw new Error("could not derive post-burn HP ciphertext");
  }

  const newAvailableOpening = new PedersenOpening();
  const newAvailableCommitment = PedersenCommitment.from(
    newAvailable,
    newAvailableOpening
  );
  const equality = new CiphertextCommitmentEqualityProofData(
    arbiter.elgamal,
    newAvailableCiphertext,
    newAvailableCommitment,
    newAvailableOpening,
    newAvailable
  );
  const validity = new BatchedGroupedCiphertext3HandlesValidityProofData(
    source,
    arbiter.elgamal.pubkey(),
    auditor,
    groupedLo,
    groupedHi,
    amountLo,
    amountHi,
    openingLo,
    openingHi
  );
  const paddingOpening = new PedersenOpening();
  const range = new BatchedRangeProofU128Data(
    [
      newAvailableCommitment,
      PedersenCommitment.fromBytes(groupedLoBytes.slice(0, 32)),
      PedersenCommitment.fromBytes(groupedHiBytes.slice(0, 32)),
      PedersenCommitment.from(0n, paddingOpening),
    ],
    new BigUint64Array([newAvailable, amountLo, amountHi, 0n]),
    Uint8Array.from([
      AVAILABLE_BALANCE_BIT_LENGTH,
      Number(TRANSFER_AMOUNT_LO_BIT_LENGTH),
      Number(TRANSFER_AMOUNT_HI_BIT_LENGTH),
      RANGE_PROOF_PADDING_BIT_LENGTH,
    ]),
    [newAvailableOpening, openingLo, openingHi, paddingOpening]
  );

  const instructions = [
    await inlineProofInstruction({
      label: "equality",
      proofBytes: equality.toBytes(),
      verify: verifyCiphertextCommitmentEquality,
    }),
    await inlineProofInstruction({
      label: "ciphertext validity",
      proofBytes: validity.toBytes(),
      verify: verifyBatchedGroupedCiphertext3HandlesValidity,
    }),
    await inlineProofInstruction({
      label: "range",
      proofBytes: range.toBytes(),
      verify: verifyBatchedRangeProofU128,
    }),
  ];
  if (args.terminal) {
    const zero = new ZeroCiphertextProofData(
      arbiter.elgamal,
      newAvailableCiphertext
    );
    instructions.push(
      await inlineProofInstruction({
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
      // The equality proof is the first proof immediately before Attack.
      equality: -attackIndex,
      // The ciphertext-validity proof is the second proof before Attack.
      ciphertextValidity: 1 - attackIndex,
      // The range proof is the third proof before Attack.
      range: 2 - attackIndex,
      // The optional zero proof is directly before Attack when terminal.
      zero: args.terminal ? 3 - attackIndex : 0,
    },
    newDecryptableAvailableBalance: arbiter.aes.encrypt(newAvailable).toBytes(),
    burnAmountAuditorCiphertextLo: auditorLo,
    burnAmountAuditorCiphertextHi: auditorHi,
  };
}

async function initializeSession(hp: bigint) {
  const sessionId = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const [sessionPda] = await findSessionPda({ sessionId });
  const [hpVault] = await findHpVaultPda({ sessionId });
  const [rewardVault] = await findRewardVaultPda({ sessionId });
  const proofs = await generateInitializeProofs({
    rpc,
    payer: createNoopSigner(gm.address),
    elgamal: arbiter.elgamal,
    aes: arbiter.aes,
    hpMint,
    hpVault,
    hp,
    needsVaultCreate: await hpVaultNeedsCreate(rpc, hpVault),
  });
  const prepared = await buildPartialInitializeTransaction({
    rpc,
    gm: gm.address,
    arbiter: arbiter.signer,
    sessionId,
    strikeFeeLamports: STRIKE_FEE_LAMPORTS,
    rewardAmount: REWARD_AMOUNT,
    rewardMint: DEVNET_USDC_MINT,
    rewardTokenProgram: TOKEN_PROGRAM_ADDRESS,
    hpMint,
    proofs,
  });
  const txBytes = getBase64Encoder().encode(
    prepared.transaction as Base64EncodedWireTransaction
  );
  const signatureBytes = await signAndSendEmbeddedTransaction(
    new Uint8Array(txBytes),
    "solana:localnet",
    gm,
    rpc
  );
  await confirmSignature(signature(getBase58Decoder().decode(signatureBytes)));
  return { sessionId, sessionPda, hpVault, rewardVault };
}

function resourceLimitsWithHeadroom(estimate: {
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

async function sendAttack(args: {
  sessionId: string;
  hpVault: Address;
  terminal: boolean;
}): Promise<void> {
  const proofs = await generateAttackProofs(args);
  const attack = await getAttackInstructionAsync({
    attacker: createNoopSigner(player.address),
    arbiter: arbiter.signer,
    hpMint,
    sessionId: args.sessionId,
    equalityProofInstructionOffset: proofs.offsets.equality,
    ciphertextValidityProofInstructionOffset: proofs.offsets.ciphertextValidity,
    rangeProofInstructionOffset: proofs.offsets.range,
    zeroProofInstructionOffset: proofs.offsets.zero,
    newDecryptableAvailableBalance: proofs.newDecryptableAvailableBalance,
    burnAmountAuditorCiphertextLo: proofs.burnAmountAuditorCiphertextLo,
    burnAmountAuditorCiphertextHi: proofs.burnAmountAuditorCiphertextHi,
  });
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const memo: Instruction = {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode("strike"),
  };
  const draft = pipe(
    createTransactionMessage({ version: 1 }),
    (message) =>
      setTransactionMessageFeePayerSigner(
        createNoopSigner(player.address),
        message
      ),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
    (message) =>
      appendTransactionMessageInstructions(
        [memo, ...proofs.instructions, attack],
        message
      ),
    fillTransactionMessageProvisoryResourceLimits
  );
  const estimate = await estimateResourceLimitsFactory({ rpc })(draft);
  const message = setTransactionMessageConfig(
    resourceLimitsWithHeadroom(estimate),
    draft
  );
  const partial = await partiallySignTransactionMessageWithSigners(message);
  assertIsTransactionWithinSizeLimit(partial);
  const transaction = getBase64EncodedWireTransaction(partial);
  const simulation = await rpc
    .simulateTransaction(transaction, { encoding: "base64", sigVerify: false })
    .send();
  assert.equal(simulation.value.err, null, simulation.value.logs?.join("\n"));
  const signatureBytes = await signAndSendEmbeddedTransaction(
    new Uint8Array(getBase64Encoder().encode(transaction)),
    "solana:localnet",
    player,
    rpc
  );
  await confirmSignature(signature(getBase58Decoder().decode(signatureBytes)));
}

async function assertAvailableHp(
  hpVault: Address,
  expected: bigint
): Promise<void> {
  const maybeVault = await fetchMaybeToken(rpc, hpVault);
  if (!maybeVault.exists) {
    throw new Error("HP vault missing after Initialize");
  }
  const extensions = isSome(maybeVault.data.extensions)
    ? maybeVault.data.extensions.value
    : [];
  const confidential = extensions.find(
    (extension) => extension.__kind === "ConfidentialTransferAccount"
  );
  if (!confidential || confidential.__kind !== "ConfidentialTransferAccount") {
    throw new Error("HP vault missing ConfidentialTransferAccount");
  }
  const decryptable = AeCiphertext.fromBytes(
    new Uint8Array(confidential.decryptableAvailableBalance)
  );
  assert.ok(decryptable, "HP vault decryptable available balance");
  assert.equal(arbiter.aes.decrypt(decryptable), expected);
}

async function surfnet(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: `surfnet_${method}`,
      params,
    }),
  });
  const result = (await response.json()) as {
    error?: { message?: string };
    result?: unknown;
  };
  if (!response.ok || result.error) {
    throw new Error(
      `Surfpool ${method} failed: ${result.error?.message ?? response.statusText}`
    );
  }
  return result.result;
}

async function fundSol(address: Address, lamports: bigint): Promise<void> {
  await surfnet("setAccount", [
    address,
    { lamports: Number(lamports), owner: SYSTEM_PROGRAM_ADDRESS },
  ]);
}

async function fundUsdc(owner: Address, amount: bigint): Promise<void> {
  await surfnet("setTokenAccount", [
    owner,
    DEVNET_USDC_MINT,
    {
      amount: Number(amount),
      state: "initialized",
    },
  ]);
}

async function assertSupplyKeysMatchArbiter(): Promise<void> {
  const mint = await fetchMint(rpc, hpMint);
  const extensions = isSome(mint.data.extensions)
    ? mint.data.extensions.value
    : [];
  const burn = extensions.find((ext) => ext.__kind === "ConfidentialMintBurn");
  if (!burn || burn.__kind !== "ConfidentialMintBurn") {
    throw new Error("HP mint missing ConfidentialMintBurn");
  }
  const onchainPk = Buffer.from(
    getAddressEncoder().encode(burn.supplyElgamalPubkey)
  );
  assert.ok(
    onchainPk.equals(Buffer.from(arbiter.elgamal.pubkey().toBytes())),
    "HP mint supply ElGamal pubkey must match spl-token HKDF derivation"
  );
  const decryptable = AeCiphertext.fromBytes(
    new Uint8Array(burn.decryptableSupply)
  );
  assert.ok(decryptable, "HP mint decryptable supply");
  arbiter.aes.decrypt(decryptable);
}

async function confirmSignature(signature: Signature): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) {
      throw new Error(
        `Initialize failed on chain: ${JSON.stringify(status.err)}`
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for Initialize confirmation");
}

before(async () => {
  const env = loadArbiterEnv();
  assert.equal(
    env.hpMint,
    DEVNET_HP_MINT,
    `HP_MINT must be the Devnet shared mint ${DEVNET_HP_MINT}`
  );
  hpMint = env.hpMint;
  arbiter = await deriveArbiterKeys(env.arbiterSecretKey);
  assert.equal(
    arbiter.signer.address,
    ARBITER_ACCOUNT,
    `arbiter key must be ${ARBITER_ACCOUNT}`
  );

  rpc = createSolanaRpc(rpcUrl) as SolanaRpc;
  gm = await generateKeyPairSigner();
  player = await generateKeyPairSigner();

  await Promise.all([
    fundSol(gm.address, SOL_LAMPORTS),
    fundSol(player.address, SOL_LAMPORTS),
    fundSol(arbiter.signer.address, SOL_LAMPORTS),
    fundUsdc(gm.address, USDC_AMOUNT),
    fundUsdc(player.address, USDC_AMOUNT),
    fundUsdc(arbiter.signer.address, USDC_AMOUNT),
    assertSupplyKeysMatchArbiter(),
  ]);
});

test("GM initializes a piñata session", { timeout: 180_000 }, async () => {
  const arbiterBalanceBefore = await rpc
    .getBalance(arbiter.signer.address)
    .send();
  const { sessionPda, hpVault, rewardVault } =
    await initializeSession(HP_AMOUNT);

  const arbiterBalanceAfter = await rpc
    .getBalance(arbiter.signer.address)
    .send();
  assert.equal(
    arbiterBalanceAfter.value,
    arbiterBalanceBefore.value,
    "arbiter must not pay Initialize fees or proof-account rent"
  );

  const rawSession = await rpc
    .getAccountInfo(sessionPda, { encoding: "base64" })
    .send();
  assert.ok(rawSession.value);
  assert.equal(
    getBase64Encoder().encode(rawSession.value.data[0]).length,
    133,
    "Session must include successfulAttackCount"
  );

  const session = await fetchSession(rpc, sessionPda);
  assert.equal(session.data.status, SessionStatus.Live);
  assert.equal(session.data.gm, gm.address);
  assert.equal(session.data.arbiter, arbiter.signer.address);
  assert.equal(session.data.rewardMint, DEVNET_USDC_MINT);
  assert.equal(session.data.rewardAmount, REWARD_AMOUNT);
  assert.equal(session.data.strikeFeeLamports, STRIKE_FEE_LAMPORTS);
  assert.equal(session.data.successfulAttackCount, 0n);

  const reward = await fetchToken(rpc, rewardVault);
  assert.equal(reward.data.amount, REWARD_AMOUNT);

  await assertAvailableHp(hpVault, HP_AMOUNT);
});

test(
  "Attack burns HP and remains Live without a terminal proof",
  { timeout: 180_000 },
  async () => {
    const { sessionId, sessionPda, hpVault } = await initializeSession(2n);

    await sendAttack({ sessionId, hpVault, terminal: false });

    const session = await fetchSession(rpc, sessionPda);
    assert.equal(session.data.status, SessionStatus.Live);
    assert.equal(session.data.successfulAttackCount, 1n);
    await assertAvailableHp(hpVault, 1n);
  }
);

test(
  "terminal Attack burns HP and enters Drawing",
  { timeout: 180_000 },
  async () => {
    const { sessionId, sessionPda, hpVault } = await initializeSession(1n);

    await sendAttack({ sessionId, hpVault, terminal: true });

    const session = await fetchSession(rpc, sessionPda);
    assert.equal(session.data.status, SessionStatus.Drawing);
    assert.equal(session.data.successfulAttackCount, 1n);
    await assertAvailableHp(hpVault, 0n);
  }
);
