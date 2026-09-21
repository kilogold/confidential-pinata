import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, test } from "node:test";
import {
  createSolanaRpc,
  createNoopSigner,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  isSome,
  signature,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { fetchToken, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeToken, fetchMint } from "@solana-program/token-2022";
import { AeCiphertext } from "@solana/zk-sdk/node";
import {
  fetchSession,
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

const rpcUrl =
  process.env.ANCHOR_PROVIDER_URL?.trim() || "http://127.0.0.1:8899";

let gm!: KeyPairSigner;
let player!: KeyPairSigner;
let arbiter!: Awaited<ReturnType<typeof deriveArbiterKeys>>;
let hpMint!: Address;
let rpc!: SolanaRpc;

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
  const sessionId = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const [sessionPda] = await findSessionPda({ sessionId });
  const [hpVault] = await findHpVaultPda({ sessionId });
  const [rewardVault] = await findRewardVaultPda({ sessionId });
  const arbiterBalanceBefore = await rpc
    .getBalance(arbiter.signer.address)
    .send();

  const needsVaultCreate = await hpVaultNeedsCreate(rpc, hpVault);
  const proofs = await generateInitializeProofs({
    rpc,
    payer: createNoopSigner(gm.address),
    elgamal: arbiter.elgamal,
    aes: arbiter.aes,
    hpMint,
    hpVault,
    hp: HP_AMOUNT,
    needsVaultCreate,
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
  assert.equal(txBytes[0], 0x81, "Initialize must use transaction v1");
  assert.ok(txBytes.length <= 4096, "Initialize must fit the v1 wire limit");
  const partialTx = getTransactionDecoder().decode(txBytes);
  assert.notEqual(
    partialTx.signatures[arbiter.signer.address],
    null,
    "arbiter partial signature must be retained"
  );
  assert.equal(
    partialTx.signatures[gm.address],
    null,
    "GM must complete the fee-payer signature"
  );
  const signatureBytes = await signAndSendEmbeddedTransaction(
    new Uint8Array(txBytes),
    "solana:localnet",
    gm,
    rpc
  );
  const sentSignature = signature(getBase58Decoder().decode(signatureBytes));
  await confirmSignature(sentSignature);

  const arbiterBalanceAfter = await rpc
    .getBalance(arbiter.signer.address)
    .send();
  assert.equal(
    arbiterBalanceAfter.value,
    arbiterBalanceBefore.value,
    "arbiter must not pay Initialize fees or proof-account rent"
  );

  const session = await fetchSession(rpc, sessionPda);
  assert.equal(session.data.status, SessionStatus.Live);
  assert.equal(session.data.gm, gm.address);
  assert.equal(session.data.arbiter, arbiter.signer.address);
  assert.equal(session.data.rewardMint, DEVNET_USDC_MINT);
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
