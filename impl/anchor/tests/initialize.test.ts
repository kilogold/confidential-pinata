import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, test } from "node:test";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSome,
  signTransaction,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
} from "@solana/kit";
import { fetchToken } from "@solana-program/token";
import { fetchMaybeToken, fetchMint } from "@solana-program/token-2022";
import { AeCiphertext } from "@solana/zk-sdk/node";
import {
  fetchSession,
  findHpVaultPda,
  findRewardVaultPda,
  findSessionPda,
  SessionStatus,
} from "@/app/generated/pinata";
import { TOKEN_PROGRAM_ADDRESS } from "@/app/lib/constants";
import { deriveArbiterKeys } from "@/app/lib/server/arbiter-keys";
import { loadArbiterEnv } from "@/app/lib/server/env";
import { buildPartialInitializeTransaction } from "@/app/lib/server/initialize/build";
import {
  generateInitializeProofs,
  hpVaultNeedsCreate,
} from "@/app/lib/server/initialize/proofs";
import { createRpc } from "@/app/lib/server/rpc";

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

const HP_MINT = "F8kzHfvDipseePMuZx81rVB7ESJRDX4DuBFTmjsh3BTW" as Address;
const ARBITER = "arbXiNvkQ88uyPAUwxzdk5cqpbtuxSMWrQzbczqP66m" as Address;
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const HP_AMOUNT = 5n;
const REWARD_AMOUNT = 1_000_000n;
const STRIKE_FEE_LAMPORTS = 1_000_000n;
const SOL_LAMPORTS = 10_000_000_000n;
const USDC_AMOUNT = 1_000_000_000n;

const rpcUrl =
  process.env.ANCHOR_PROVIDER_URL?.trim() || "http://127.0.0.1:8899";
const rpc = createRpc(rpcUrl);

type JsonRpcError = { message: string };
type JsonRpcResponse<T> = { result?: T; error?: JsonRpcError };

async function surfnet<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`${method}: ${json.error.message}`);
  }
  return json.result as T;
}

async function fundSol(address: Address, lamports: bigint): Promise<void> {
  await surfnet("surfnet_setAccount", [
    address,
    { lamports: Number(lamports), owner: SYSTEM_PROGRAM },
  ]);
}

async function fundUsdc(owner: Address, amount: bigint): Promise<void> {
  await surfnet("surfnet_setTokenAccount", [
    owner,
    DEVNET_USDC,
    { amount: Number(amount), state: "initialized" },
  ]);
}

function enableConfidentialAutoApprove(data: Buffer, authority: Address): void {
  const authorityBytes = Buffer.from(getAddressEncoder().encode(authority));
  const typeTag = Buffer.from([4, 0]);
  let idx = 0;
  while ((idx = data.indexOf(typeTag, idx)) >= 0) {
    if (idx + 4 > data.length) break;
    const length = data.readUInt16LE(idx + 2);
    const body = idx + 4;
    if (
      length === 65 &&
      body + length <= data.length &&
      data.subarray(body, body + 32).equals(authorityBytes)
    ) {
      data[body + 32] = 1;
      return;
    }
    idx += 1;
  }
  throw new Error("ConfidentialTransferMint TLV not found on HP mint");
}

async function accountData(address: Address): Promise<{
  data: Buffer;
  lamports: number;
  owner: string;
  executable: boolean;
}> {
  const { value } = await rpc
    .getAccountInfo(address, { encoding: "base64" })
    .send();
  if (!value) {
    throw new Error(`${address} missing on fork`);
  }
  const encoded = value.data;
  const b64 = Array.isArray(encoded) ? encoded[0] : encoded;
  if (typeof b64 !== "string") {
    throw new Error(`${address}: expected base64 account data`);
  }
  return {
    data: Buffer.from(b64, "base64"),
    lamports: Number(value.lamports),
    owner: value.owner,
    executable: value.executable,
  };
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

/** Some cloned Devnet mints have autoApproveNewAccounts=false. */
async function enableAutoApproveIfNeeded(): Promise<void> {
  const account = await accountData(hpMint);
  enableConfidentialAutoApprove(account.data, arbiter.signer.address);
  await surfnet("surfnet_setAccount", [
    hpMint,
    {
      lamports: account.lamports,
      owner: account.owner,
      executable: account.executable,
      data: account.data.toString("hex"),
    },
  ]);
}

async function confirmSignature(signature: string): Promise<void> {
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

let gm!: KeyPairSigner;
let player!: KeyPairSigner;
let arbiter!: Awaited<ReturnType<typeof deriveArbiterKeys>>;
let hpMint!: Address;

before(async () => {
  const env = loadArbiterEnv();
  assert.equal(
    env.hpMint,
    HP_MINT,
    `HP_MINT must be the Devnet shared mint ${HP_MINT}`
  );
  hpMint = env.hpMint;
  arbiter = await deriveArbiterKeys(env.arbiterSecretKey);
  assert.equal(
    arbiter.signer.address,
    ARBITER,
    `arbiter key must be ${ARBITER}`
  );

  gm = await generateKeyPairSigner();
  player = await generateKeyPairSigner();

  await fundSol(gm.address, SOL_LAMPORTS);
  await fundSol(player.address, SOL_LAMPORTS);
  await fundSol(arbiter.signer.address, SOL_LAMPORTS);
  await fundUsdc(gm.address, USDC_AMOUNT);
  await fundUsdc(player.address, USDC_AMOUNT);
  await fundUsdc(arbiter.signer.address, USDC_AMOUNT);
  await assertSupplyKeysMatchArbiter();
  await enableAutoApproveIfNeeded();
});

test("GM initializes a piñata session", { timeout: 180_000 }, async () => {
  const sessionId = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const [sessionPda] = await findSessionPda({ sessionId });
  const [hpVault] = await findHpVaultPda({ sessionId });
  const [rewardVault] = await findRewardVaultPda({ sessionId });

  const needsVaultCreate = await hpVaultNeedsCreate(rpc, hpVault);
  const proofs = await generateInitializeProofs({
    rpc,
    payer: arbiter.signer,
    elgamal: arbiter.elgamal,
    aes: arbiter.aes,
    hpMint,
    hpVault,
    hp: HP_AMOUNT,
    needsVaultCreate,
    needsZeroProof: false,
  });

  const partialWire = await buildPartialInitializeTransaction({
    rpc,
    gm: gm.address,
    arbiter: arbiter.signer,
    sessionId,
    strikeFeeLamports: STRIKE_FEE_LAMPORTS,
    rewardAmount: REWARD_AMOUNT,
    rewardMint: DEVNET_USDC,
    rewardTokenProgram: TOKEN_PROGRAM_ADDRESS,
    hpMint,
    proofs,
  });

  const txBytes = getBase64Encoder().encode(
    partialWire as Base64EncodedWireTransaction
  );
  const partialTx = getTransactionDecoder().decode(txBytes);
  const signedTx = await signTransaction([gm.keyPair], partialTx);
  const wire = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(getSignatureFromTransaction(signedTx));

  const session = await fetchSession(rpc, sessionPda);
  assert.equal(session.data.status, SessionStatus.Live);
  assert.equal(session.data.gm, gm.address);
  assert.equal(session.data.arbiter, arbiter.signer.address);
  assert.equal(session.data.rewardMint, DEVNET_USDC);
  assert.equal(session.data.rewardAmount, REWARD_AMOUNT);
  assert.equal(session.data.strikeFeeLamports, STRIKE_FEE_LAMPORTS);

  const reward = await fetchToken(rpc, rewardVault);
  assert.equal(reward.data.amount, REWARD_AMOUNT);

  const vault = await fetchMaybeToken(rpc, hpVault);
  assert.equal(vault.exists, true);
  if (!vault.exists) {
    throw new Error("HP vault missing after Initialize");
  }
  const extensions = isSome(vault.data.extensions)
    ? vault.data.extensions.value
    : undefined;
  const confidential = extensions?.find(
    (ext) => ext.__kind === "ConfidentialTransferAccount"
  );
  if (!confidential || confidential.__kind !== "ConfidentialTransferAccount") {
    throw new Error("HP vault missing ConfidentialTransferAccount");
  }
  const decryptable = AeCiphertext.fromBytes(
    new Uint8Array(confidential.decryptableAvailableBalance)
  );
  assert.ok(decryptable, "HP vault decryptable available balance");
  assert.equal(arbiter.aes.decrypt(decryptable), HP_AMOUNT);
});
