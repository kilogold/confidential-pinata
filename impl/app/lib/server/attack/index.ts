import { address, createNoopSigner, isSome, type Address } from "@solana/kit";
import {
  fetchMint,
  TOKEN_2022_PROGRAM_ADDRESS,
  type Extension,
} from "@solana-program/token-2022";
import { AeCiphertext } from "@solana/zk-sdk/node";
import {
  fetchMaybeSession,
  findHpVaultPda,
  findSessionPda,
  SessionStatus,
} from "@/app/generated/pinata";
import { SESSION_ID_MAX_BYTES } from "@/app/lib/constants";
import { deriveArbiterKeys } from "../arbiter-keys";
import type { SolanaRpc } from "../rpc";
import {
  buildPartialAttackTransaction,
  type PreparedAttackTransaction,
} from "./build";
import { AttackApiError } from "./errors";
import { generateAttackProofs } from "./proofs";

type ParsedAttackInput = {
  attacker: Address;
  sessionId: string;
};

export type AttackSuccess = PreparedAttackTransaction;

function parseAttackBody(body: unknown): ParsedAttackInput {
  if (body === null || typeof body !== "object") {
    throw new AttackApiError(
      "INVALID_ATTACKER",
      "Request body must be a JSON object"
    );
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.attacker !== "string") {
    throw new AttackApiError(
      "INVALID_ATTACKER",
      "attacker must be a base58 pubkey",
      { field: "attacker" }
    );
  }
  let attacker: Address;
  try {
    attacker = address(rec.attacker.trim());
  } catch {
    throw new AttackApiError(
      "INVALID_ATTACKER",
      "attacker is not a valid Solana pubkey",
      { field: "attacker" }
    );
  }
  if (typeof rec.sessionId !== "string") {
    throw new AttackApiError(
      "INVALID_SESSION_ID",
      "session_id must be a UTF-8 string of 1 to 24 bytes",
      { field: "sessionId" }
    );
  }
  const sessionIdBytes = new TextEncoder().encode(rec.sessionId);
  if (
    sessionIdBytes.length === 0 ||
    sessionIdBytes.length > SESSION_ID_MAX_BYTES
  ) {
    throw new AttackApiError(
      "INVALID_SESSION_ID",
      "session_id must be 1 to 24 bytes",
      { field: "sessionId" }
    );
  }
  return { attacker, sessionId: rec.sessionId };
}

function requireMintExtension<K extends Extension["__kind"]>(
  extensions: readonly Extension[] | undefined,
  kind: K,
  message: string
): Extract<Extension, { __kind: K }> {
  const extension = extensions?.find(
    (candidate): candidate is Extract<Extension, { __kind: K }> =>
      candidate.__kind === kind
  );
  if (!extension) {
    throw new AttackApiError("HP_MINT_MISCONFIGURED", message, {
      status: 500,
    });
  }
  return extension;
}

async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AttackApiError) throw err;
    throw new AttackApiError(
      "RPC_UNAVAILABLE",
      err instanceof Error ? err.message : "RPC request failed",
      { status: 502 }
    );
  }
}

export async function orchestrateAttack(
  rpc: SolanaRpc,
  env: { arbiterSecretKey: Uint8Array; hpMint: Address },
  body: unknown
): Promise<AttackSuccess> {
  const input = parseAttackBody(body);
  let keys;
  try {
    keys = await deriveArbiterKeys(env.arbiterSecretKey);
  } catch (err) {
    throw new AttackApiError(
      "ARBITER_KEY_MISSING",
      err instanceof Error ? err.message : "Could not load the arbiter key",
      { status: 500 }
    );
  }

  const [sessionPda] = await findSessionPda({ sessionId: input.sessionId });
  const [hpVault] = await findHpVaultPda({ sessionId: input.sessionId });
  const session = await rpcCall(() => fetchMaybeSession(rpc, sessionPda));
  if (!session.exists) {
    throw new AttackApiError(
      "SESSION_NOT_FOUND",
      "No session exists for this ID",
      {
        field: "sessionId",
      }
    );
  }
  if (session.data.status !== SessionStatus.Live) {
    throw new AttackApiError(
      "SESSION_NOT_LIVE",
      "This session is not accepting strikes",
      { field: "sessionId", status: 409 }
    );
  }
  if (session.data.arbiter !== keys.signer.address) {
    throw new AttackApiError(
      "HP_MINT_MISCONFIGURED",
      "The session arbiter does not match this deployment",
      { status: 500 }
    );
  }

  const { value: hpMintInfo } = await rpcCall(() =>
    rpc.getAccountInfo(env.hpMint, { encoding: "base64" }).send()
  );
  if (!hpMintInfo || hpMintInfo.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new AttackApiError(
      "HP_MINT_MISCONFIGURED",
      "HP_MINT is not a Token-2022 mint",
      { status: 500 }
    );
  }
  const hpMint = await rpcCall(() => fetchMint(rpc, env.hpMint));
  if (
    !isSome(hpMint.data.mintAuthority) ||
    hpMint.data.mintAuthority.value !== keys.signer.address
  ) {
    throw new AttackApiError(
      "HP_MINT_MISCONFIGURED",
      "arbiter must be the HP mint authority",
      { status: 500 }
    );
  }
  const mintExtensions = isSome(hpMint.data.extensions)
    ? hpMint.data.extensions.value
    : undefined;
  requireMintExtension(
    mintExtensions,
    "ConfidentialTransferMint",
    "HP mint is missing ConfidentialTransferMint"
  );
  const mintBurn = requireMintExtension(
    mintExtensions,
    "ConfidentialMintBurn",
    "HP mint is missing ConfidentialMintBurn"
  );
  const decryptableSupply = AeCiphertext.fromBytes(
    new Uint8Array(mintBurn.decryptableSupply)
  );
  if (!decryptableSupply) {
    throw new AttackApiError(
      "HP_MINT_MISCONFIGURED",
      "Could not decode the HP mint supply",
      { status: 500 }
    );
  }
  let currentSupply: bigint;
  try {
    currentSupply = keys.aes.decrypt(decryptableSupply);
  } catch {
    throw new AttackApiError(
      "HP_MINT_MISCONFIGURED",
      "Could not read the HP mint supply with the arbiter key",
      { status: 500 }
    );
  }
  if (currentSupply < 1n) {
    throw new AttackApiError(
      "HP_MINT_MISCONFIGURED",
      "The HP mint supply cannot be burned",
      { status: 500 }
    );
  }

  let proofs;
  try {
    proofs = await generateAttackProofs({
      rpc,
      payer: createNoopSigner(input.attacker),
      hpVault,
      elgamal: keys.elgamal,
      aes: keys.aes,
    });
  } catch (err) {
    if (err instanceof AttackApiError) throw err;
    throw new AttackApiError(
      "PROOF_SETUP_FAILED",
      "Could not generate confidential strike proofs",
      { status: 502 }
    );
  }

  return await buildPartialAttackTransaction({
    rpc,
    attacker: input.attacker,
    arbiter: keys.signer,
    sessionId: input.sessionId,
    hpMint: env.hpMint,
    newSupply: currentSupply - 1n,
    supplyAesKey: keys.aes,
    proofs,
  });
}
