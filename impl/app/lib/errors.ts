import {
  isSolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
} from "@solana/kit";
import {
  getPinataErrorMessage,
  PINATA_ERROR__INVALID_ARBITER_MINT_AUTHORITY,
  PINATA_ERROR__INVALID_HP_MINT,
  PINATA_ERROR__INVALID_REWARD_AMOUNT,
  PINATA_ERROR__INVALID_SESSION_ID,
  PINATA_ERROR__INVALID_STRIKE_FEE,
  PINATA_ERROR__INVALID_ZERO_PROOF,
  PINATA_ERROR__MISSING_PUBKEY_VALIDITY_PROOF,
  PINATA_ERROR__MISSING_ZERO_PROOF,
  PINATA_ERROR__PINATA_ALREADY_EXISTS,
  PINATA_ERROR__REWARD_VAULT_NOT_EMPTY,
  PINATA_ERROR__SOL_PILE_NOT_EMPTY,
  PINATA_ERROR__TOKEN2022_CPI,
  PINATA_ERROR__ZERO_PROOF_MISMATCH,
  type PinataError,
} from "../generated/pinata";

const PINATA_ERROR_CODES: Record<number, PinataError> = {
  [PINATA_ERROR__PINATA_ALREADY_EXISTS]: PINATA_ERROR__PINATA_ALREADY_EXISTS,
  [PINATA_ERROR__INVALID_SESSION_ID]: PINATA_ERROR__INVALID_SESSION_ID,
  [PINATA_ERROR__INVALID_STRIKE_FEE]: PINATA_ERROR__INVALID_STRIKE_FEE,
  [PINATA_ERROR__INVALID_REWARD_AMOUNT]: PINATA_ERROR__INVALID_REWARD_AMOUNT,
  [PINATA_ERROR__MISSING_ZERO_PROOF]: PINATA_ERROR__MISSING_ZERO_PROOF,
  [PINATA_ERROR__INVALID_ZERO_PROOF]: PINATA_ERROR__INVALID_ZERO_PROOF,
  [PINATA_ERROR__ZERO_PROOF_MISMATCH]: PINATA_ERROR__ZERO_PROOF_MISMATCH,
  [PINATA_ERROR__REWARD_VAULT_NOT_EMPTY]: PINATA_ERROR__REWARD_VAULT_NOT_EMPTY,
  [PINATA_ERROR__SOL_PILE_NOT_EMPTY]: PINATA_ERROR__SOL_PILE_NOT_EMPTY,
  [PINATA_ERROR__MISSING_PUBKEY_VALIDITY_PROOF]:
    PINATA_ERROR__MISSING_PUBKEY_VALIDITY_PROOF,
  [PINATA_ERROR__INVALID_HP_MINT]: PINATA_ERROR__INVALID_HP_MINT,
  [PINATA_ERROR__INVALID_ARBITER_MINT_AUTHORITY]:
    PINATA_ERROR__INVALID_ARBITER_MINT_AUTHORITY,
  [PINATA_ERROR__TOKEN2022_CPI]: PINATA_ERROR__TOKEN2022_CPI,
};

export function parseTransactionError(err: unknown): string {
  // Wallet rejection (comes from wallet-standard, not a SolanaError)
  if (err instanceof Error && err.message.includes("User rejected")) {
    return "Transaction was rejected by the wallet.";
  }

  // Anchor custom program errors — use the Codama-generated error messages
  if (
    isSolanaError(err, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) &&
    typeof err.context?.code === "number"
  ) {
    const pinataError = PINATA_ERROR_CODES[err.context.code];
    if (pinataError !== undefined) {
      return getPinataErrorMessage(pinataError);
    }
  }

  // For all other errors, kit's SolanaError already has readable messages.
  // Walk the cause chain to find the deepest message.
  const message = getDeepestMessage(err);
  return message.length > 200 ? `${message.slice(0, 200)}...` : message;
}

function getDeepestMessage(err: unknown): string {
  let deepest = err instanceof Error ? err.message : String(err);
  let current: unknown = err;

  while (current instanceof Error && current.cause) {
    current = current.cause;
    if (current instanceof Error) {
      deepest = current.message;
    }
  }

  return deepest;
}
