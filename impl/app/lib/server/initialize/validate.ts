import { address, type Address } from "@solana/kit";
import { SESSION_ID_MAX_BYTES } from "@/app/lib/constants";
import { InitializeApiError } from "./errors";

const DECIMAL = /^\d+(\.\d+)?$/;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export type InitializeRequestBody = {
  gm: string;
  sessionId: string;
  rewardMint: string;
  rewardAmount: string;
  strikeFeeSol: string;
};

export type ParsedInitializeInput = {
  gm: Address;
  sessionId: string;
  rewardMint: Address;
  rewardAmountUi: string;
  strikeFeeSolUi: string;
};

export function parsePubkey(
  value: string,
  code: InitializeApiError["code"],
  field: string
): Address {
  try {
    return address(value.trim());
  } catch {
    throw new InitializeApiError(
      code,
      `${field} is not a valid Solana pubkey`,
      {
        field,
      }
    );
  }
}

export function parseSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string") {
    throw new InitializeApiError(
      "INVALID_SESSION_ID",
      "session_id must be a UTF-8 string of 1 to 24 bytes",
      { field: "sessionId" }
    );
  }
  const bytes = new TextEncoder().encode(sessionId);
  if (bytes.length === 0 || bytes.length > SESSION_ID_MAX_BYTES) {
    throw new InitializeApiError(
      "INVALID_SESSION_ID",
      "session_id must be 1 to 24 bytes",
      { field: "sessionId" }
    );
  }
  return sessionId;
}

/** Parse a non-negative decimal string into integer smallest units. */
export function parseDecimalToUnits(
  value: string,
  decimals: number,
  code: InitializeApiError["code"],
  field: string
): bigint {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new InitializeApiError(code, `${field} must be a positive decimal`, {
      field,
    });
  }
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  if (fracRaw.length > decimals) {
    throw new InitializeApiError(
      code,
      `${field} has more fractional digits than allowed (${decimals})`,
      { field }
    );
  }
  const whole = BigInt(wholeRaw ?? "0");
  const fracPadded = fracRaw.padEnd(decimals, "0");
  const frac = fracPadded.length === 0 ? 0n : BigInt(fracPadded);
  const scale = 10n ** BigInt(decimals);
  const units = whole * scale + frac;
  if (units <= 0n) {
    throw new InitializeApiError(code, `${field} must be greater than zero`, {
      field,
    });
  }
  return units;
}

export function parseStrikeFeeLamports(strikeFeeSol: string): bigint {
  return parseDecimalToUnits(
    strikeFeeSol,
    9,
    "INVALID_STRIKE_FEE",
    "strikeFeeSol"
  );
}

export function lamportsToSolNumber(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

export function parseInitializeBody(body: unknown): ParsedInitializeInput {
  if (body === null || typeof body !== "object") {
    throw new InitializeApiError(
      "INVALID_GM",
      "Request body must be a JSON object",
      { status: 400 }
    );
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.gm !== "string") {
    throw new InitializeApiError("INVALID_GM", "gm must be a base58 pubkey", {
      field: "gm",
    });
  }
  if (typeof rec.rewardMint !== "string") {
    throw new InitializeApiError(
      "INVALID_REWARD_MINT",
      "rewardMint must be a base58 pubkey",
      { field: "rewardMint" }
    );
  }
  if (typeof rec.rewardAmount !== "string") {
    throw new InitializeApiError(
      "INVALID_REWARD_AMOUNT",
      "rewardAmount must be a decimal string",
      { field: "rewardAmount" }
    );
  }
  if (typeof rec.strikeFeeSol !== "string") {
    throw new InitializeApiError(
      "INVALID_STRIKE_FEE",
      "strikeFeeSol must be a decimal string",
      { field: "strikeFeeSol" }
    );
  }

  return {
    gm: parsePubkey(rec.gm, "INVALID_GM", "gm"),
    sessionId: parseSessionId(rec.sessionId),
    rewardMint: parsePubkey(
      rec.rewardMint,
      "INVALID_REWARD_MINT",
      "rewardMint"
    ),
    rewardAmountUi: rec.rewardAmount,
    strikeFeeSolUi: rec.strikeFeeSol,
  };
}

export { LAMPORTS_PER_SOL };
