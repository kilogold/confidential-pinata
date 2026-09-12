import { address, type Address } from "@solana/kit";
import { InitializeApiError } from "./initialize/errors";

export type ArbiterEnv = {
  rpcUrl: string;
  arbiterSecretKey: Uint8Array;
  hpMint: Address;
};

function requireEnv(name: string, code: InitializeApiError["code"]): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new InitializeApiError(code, `${name} is not set`, { status: 500 });
  }
  return value;
}

export function loadArbiterEnv(): ArbiterEnv {
  const rpcUrl = requireEnv("SOLANA_RPC_URL", "RPC_UNAVAILABLE");
  const secretB64 = requireEnv(
    "ARBITER_AUTHORITY_SECRET_KEY_BASE64",
    "ARBITER_KEY_MISSING"
  );
  const hpMintRaw = requireEnv("HP_MINT", "HP_MINT_MISCONFIGURED");

  let hpMint: Address;
  try {
    hpMint = address(hpMintRaw);
  } catch {
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "HP_MINT is not a valid pubkey",
      { status: 500 }
    );
  }

  let arbiterSecretKey: Uint8Array;
  try {
    arbiterSecretKey = Uint8Array.from(Buffer.from(secretB64, "base64"));
  } catch {
    throw new InitializeApiError(
      "ARBITER_KEY_MISSING",
      "ARBITER_AUTHORITY_SECRET_KEY_BASE64 is not valid base64",
      { status: 500 }
    );
  }
  if (arbiterSecretKey.length !== 64) {
    throw new InitializeApiError(
      "ARBITER_KEY_MISSING",
      "ARBITER_AUTHORITY_SECRET_KEY_BASE64 must decode to 64 bytes (seed || pubkey)",
      { status: 500 }
    );
  }

  return { rpcUrl, arbiterSecretKey, hpMint };
}
