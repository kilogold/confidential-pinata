import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
  type KeyPairSigner,
} from "@solana/kit";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/node";
import { HP_KEY_PUBLIC_SEED } from "@/app/lib/constants";

export type ArbiterKeys = {
  signer: KeyPairSigner;
  elgamal: ElGamalKeypair;
  aes: AeKey;
};

async function signSeed(
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

export async function deriveArbiterKeys(
  secretKey: Uint8Array
): Promise<ArbiterKeys> {
  const signer = await createKeyPairSignerFromBytes(secretKey);
  const elgamalSig = await signSeed(
    signer,
    ElGamalKeypair.signerMessage(HP_KEY_PUBLIC_SEED)
  );
  const aesSig = await signSeed(
    signer,
    AeKey.signerMessage(HP_KEY_PUBLIC_SEED)
  );
  return {
    signer,
    elgamal: ElGamalKeypair.fromSignature(elgamalSig),
    aes: AeKey.fromSignature(aesSig),
  };
}
