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
