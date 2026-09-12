import { HP_OFFSET_MAX } from "@/app/lib/constants";
import { InitializeApiError } from "./errors";
import { lamportsToSolNumber } from "./validate";

function randomOffsetInclusive(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % (max + 1);
}

/**
 * A3: HP = floor(reward_in_SOL / strike_fee_SOL) + offset.
 * Offset stays on the backend (A6).
 */
export function drawHp(rewardInSol: number, strikeFeeLamports: bigint): bigint {
  const strikeFeeSol = lamportsToSolNumber(strikeFeeLamports);
  if (!(strikeFeeSol > 0)) {
    throw new InitializeApiError(
      "INVALID_STRIKE_FEE",
      "strike fee must be greater than zero",
      { field: "strikeFeeSol" }
    );
  }
  const offset = randomOffsetInclusive(HP_OFFSET_MAX);
  const hp = Math.floor(rewardInSol / strikeFeeSol) + offset;
  if (!Number.isFinite(hp) || hp < 1) {
    throw new InitializeApiError(
      "HP_BELOW_MINIMUM",
      "This reward and strike fee cannot start a session",
      { status: 400 }
    );
  }
  return BigInt(hp);
}
