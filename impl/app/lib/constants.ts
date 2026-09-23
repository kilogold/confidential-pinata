import { address } from "@solana/kit";

/** Devnet deployment addresses used by the Surfpool Initialize test. */
export const DEVNET_HP_MINT = address(
  "F8kzHfvDipseePMuZx81rVB7ESJRDX4DuBFTmjsh3BTW"
);
export const ARBITER_ACCOUNT = address(
  "arbXiNvkQ88uyPAUwxzdk5cqpbtuxSMWrQzbczqP66m"
);

/** Devnet's canonical six-decimal USDC mint, also cloned by Surfpool. */
export const DEVNET_USDC_MINT = address(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

/** Wrapped SOL mint used for Jupiter SOL `usdPrice` (arbiter.md A4). */
export const WSOL_MINT = address("So11111111111111111111111111111111111111112");

/** UTF-8 byte cap matching `SESSION_ID_MAX` in the pinata program. */
export const SESSION_ID_MAX_BYTES = 24;

/** LAMPORTS_PER_SOL is the number of lamports in one SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Transaction v1 feature gate: https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md */
export const TRANSACTION_V1_FEATURE_ADDRESS = address(
  "txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL"
);

/** Canonical Memo program address: https://github.com/solana-program/memo */
export const MEMO_PROGRAM_ADDRESS = address(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

/** SIMD-0385 transaction-v1 wire prefix. */
export const TRANSACTION_V1_WIRE_PREFIX = 0x81;

/** Runtime resource caps: https://github.com/anza-xyz/agave/blob/2a165e7a90af75c76426d1e031ed0284211d5d1e/program-runtime/src/execution_budget.rs */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/** Application headroom granularity for loaded account data. */
export const LOADED_ACCOUNTS_PAGE_SIZE = 32 * 1024;
