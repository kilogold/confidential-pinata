import { hkdfSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/utils";
import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
  type KeyPairSigner,
} from "@solana/kit";
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from "@solana/zk-sdk/node";
import {
  CONFIDENTIAL_HKDF_SALT,
  HP_KEY_PUBLIC_SEED,
} from "@/app/lib/constants";

export type ArbiterKeys = {
  signer: KeyPairSigner;
  elgamal: ElGamalKeypair;
  aes: AeKey;
};

async function signMessage(
  signer: KeyPairSigner,
  message: Uint8Array
): Promise<Uint8Array> {
  const [signatures] = await signer.signMessages([
    createSignableMessage(message),
  ]);
  const signature = signatures?.[signer.address];
  if (signature == null) {
    throw new Error("Arbiter signer did not return a derivation signature");
  }
  return new Uint8Array(signature);
}

function keysFromSignature(signature: Uint8Array): {
  elgamal: ElGamalKeypair;
  aes: AeKey;
} {
  const salt = Buffer.from(CONFIDENTIAL_HKDF_SALT);
  const aeBytes = new Uint8Array(
    hkdfSync("sha512", signature, salt, Buffer.from("ae"), 16)
  );
  const elgamalWide = new Uint8Array(
    hkdfSync("sha512", signature, salt, Buffer.from("elgamal"), 64)
  );
  const scalar = bytesToNumberLE(elgamalWide) % ed25519.Point.CURVE().n;
  return {
    elgamal: ElGamalKeypair.fromSecretKey(
      ElGamalSecretKey.fromBytes(numberToBytesLE(scalar, 32))
    ),
    aes: AeKey.fromBytes(aeBytes),
  };
}

/**
 * Wallet-level confidential keys: sign `solana-conf-bal/v1` || public seed
 * (A2 empty seed) once, then HKDF-SHA512. Matches `spl-token`
 * `derive_confidential_keys(signer, b"")`.
 */
export async function deriveArbiterKeys(
  secretKey: Uint8Array
): Promise<ArbiterKeys> {
  const signer = await createKeyPairSignerFromBytes(secretKey);
  const message = new Uint8Array(
    CONFIDENTIAL_HKDF_SALT.length + HP_KEY_PUBLIC_SEED.length
  );
  message.set(CONFIDENTIAL_HKDF_SALT, 0);
  message.set(HP_KEY_PUBLIC_SEED, CONFIDENTIAL_HKDF_SALT.length);
  const { elgamal, aes } = keysFromSignature(await signMessage(signer, message));
  return { signer, elgamal, aes };
}
