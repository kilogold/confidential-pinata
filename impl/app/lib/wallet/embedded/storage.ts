import {
  createKeyPairFromPrivateKeyBytes,
  createSignerFromKeyPair,
  type KeyPairSigner,
} from "@solana/kit";

export type EmbeddedRole = "gm" | "player";
export type SeedStore = Pick<Storage, "getItem" | "setItem">;

const STORAGE_PREFIX = "pinata:embedded:";
const SEED_HEX = /^[0-9a-f]{64}$/;

function roleLabel(role: EmbeddedRole): string {
  return role === "gm" ? "Local GM" : "Local Player";
}

function storageError(role: EmbeddedRole, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${roleLabel(role)} identity storage failed: ${detail}`);
}

function signerFromSeed(
  role: EmbeddedRole,
  storedSeed: string
): Promise<KeyPairSigner> {
  if (!SEED_HEX.test(storedSeed)) {
    throw new Error(
      `${roleLabel(role)} has an invalid stored key. Its identity will not be replaced automatically.`
    );
  }
  const seed = Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(storedSeed.slice(index * 2, index * 2 + 2), 16)
  );
  return createKeyPairFromPrivateKeyBytes(seed).then(createSignerFromKeyPair);
}

export async function loadOrCreateEmbeddedSigner(
  role: EmbeddedRole,
  store?: SeedStore
): Promise<KeyPairSigner> {
  const key = `${STORAGE_PREFIX}${role}:seed`;
  let selectedStore: SeedStore;
  let storedSeed: string | null;
  try {
    selectedStore = store ?? window.localStorage;
    storedSeed = selectedStore.getItem(key);
  } catch (error) {
    throw storageError(role, error);
  }
  if (storedSeed !== null) return signerFromSeed(role, storedSeed);

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const seedHex = Array.from(seed, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  try {
    selectedStore.setItem(key, seedHex);
    // Never return a newly generated identity unless a key was persisted.
    storedSeed = selectedStore.getItem(key);
    if (storedSeed === null) throw new Error("Could not read stored key");
  } catch (error) {
    throw storageError(role, error);
  }
  return signerFromSeed(role, storedSeed);
}
