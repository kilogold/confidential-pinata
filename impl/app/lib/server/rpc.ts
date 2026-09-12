import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Instantiated per request from `SOLANA_RPC_URL`. */
export function createRpc(rpcUrl: string): SolanaRpc {
  return createSolanaRpc(rpcUrl);
}
