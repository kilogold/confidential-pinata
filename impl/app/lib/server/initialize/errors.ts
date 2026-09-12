export type InitializeErrorCode =
  | "INVALID_SESSION_ID"
  | "INVALID_GM"
  | "INVALID_REWARD_MINT"
  | "INVALID_REWARD_AMOUNT"
  | "INVALID_STRIKE_FEE"
  | "REWARD_MINT_NOT_FOUND"
  | "NOT_A_MINT"
  | "REWARD_SOURCE_MISSING"
  | "INSUFFICIENT_REWARD_BALANCE"
  | "SESSION_ALREADY_LIVE"
  | "HP_BELOW_MINIMUM"
  | "JUPITER_SOL_PRICE_UNAVAILABLE"
  | "JUPITER_UNAVAILABLE"
  | "HP_MINT_MISCONFIGURED"
  | "ARBITER_KEY_MISSING"
  | "RPC_UNAVAILABLE"
  | "PROOF_SETUP_FAILED"
  | "SIMULATION_FAILED"
  | "TRANSACTION_BUILD_FAILED";

export class InitializeApiError extends Error {
  readonly code: InitializeErrorCode;
  readonly field?: string;
  readonly status: number;

  constructor(
    code: InitializeErrorCode,
    message: string,
    options?: { field?: string; status?: number }
  ) {
    super(message);
    this.name = "InitializeApiError";
    this.code = code;
    this.field = options?.field;
    this.status = options?.status ?? 400;
  }

  toJson() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
      },
    };
  }
}
