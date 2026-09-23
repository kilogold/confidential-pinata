export type AttackErrorCode =
  | "INVALID_ATTACKER"
  | "INVALID_SESSION_ID"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_LIVE"
  | "HP_MINT_MISCONFIGURED"
  | "HP_VAULT_MISCONFIGURED"
  | "ARBITER_KEY_MISSING"
  | "RPC_UNAVAILABLE"
  | "PROOF_SETUP_FAILED"
  | "SIMULATION_FAILED"
  | "TRANSACTION_V1_UNAVAILABLE"
  | "TRANSACTION_BUILD_FAILED";

export class AttackApiError extends Error {
  readonly code: AttackErrorCode;
  readonly field?: string;
  readonly status: number;

  constructor(
    code: AttackErrorCode,
    message: string,
    options?: { field?: string; status?: number }
  ) {
    super(message);
    this.name = "AttackApiError";
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
