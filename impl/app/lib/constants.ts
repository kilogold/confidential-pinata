import { address } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import { PINATA_PROGRAM_ADDRESS } from "@/app/generated/pinata";

export {
  PINATA_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
};

/** Wrapped SOL mint used for Jupiter SOL `usdPrice` (arbiter.md A4). */
export const WSOL_MINT = address("So11111111111111111111111111111111111111112");

/** UTF-8 byte cap matching `SESSION_ID_MAX` in the pinata program. */
export const SESSION_ID_MAX_BYTES = 24;

/**
 * A2 public seed. Same bytes as the program tests (`KEY_SEED = b"pinata-hp"`).
 * Must not include the vault address, session, or `(owner, mint)`.
 */
export const HP_KEY_PUBLIC_SEED = new TextEncoder().encode("pinata-hp");

/**
 * Closed interval `0..=HP_OFFSET_MAX` for the Initialize HP offset.
 * Implementation-only; not a Decided range.
 */
export const HP_OFFSET_MAX = 5;

export const INITIALIZE_COMPUTE_UNIT_LIMIT = 1_400_000;
