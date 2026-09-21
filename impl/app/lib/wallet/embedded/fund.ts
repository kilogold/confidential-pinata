import { getClusterUrl } from "../../solana-client";
import { DEVNET_USDC_MINT, LAMPORTS_PER_SOL } from "../../constants";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { loadOrCreateEmbeddedSigner } from "./storage";

const GM_SOL_LAMPORTS = 5 * LAMPORTS_PER_SOL;
const GM_USDC_BASE_UNITS = 20_000_000;

type RpcResponse<T> = {
  result?: T;
  error?: { message: string };
};

async function surfpoolRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(getClusterUrl("localnet"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Surfpool ${method} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as RpcResponse<T>;
  if (body.error || body.result === undefined) {
    throw new Error(
      `Surfpool ${method} failed: ${body.error?.message ?? "missing result"}`
    );
  }
  return body.result;
}

async function fundGmOnSurfpool(): Promise<void> {
  const gm = await loadOrCreateEmbeddedSigner("gm");
  const mint = await surfpoolRpc<{
    value: {
      owner: string;
      data: { parsed?: { info?: { decimals?: number } } };
    } | null;
  }>("getAccountInfo", [DEVNET_USDC_MINT, { encoding: "jsonParsed" }]);
  if (
    mint.value?.owner !== TOKEN_PROGRAM_ADDRESS ||
    mint.value.data.parsed?.info?.decimals !== 6
  ) {
    throw new Error("Surfpool does not have the expected devnet USDC mint");
  }

  await surfpoolRpc("surfnet_setAccount", [
    gm.address,
    { lamports: GM_SOL_LAMPORTS, owner: SYSTEM_PROGRAM_ADDRESS },
  ]);
  await surfpoolRpc("surfnet_setTokenAccount", [
    gm.address,
    DEVNET_USDC_MINT,
    { amount: GM_USDC_BASE_UNITS },
    TOKEN_PROGRAM_ADDRESS,
  ]);
}

export async function fundEmbeddedWallets(): Promise<void> {
  await fundGmOnSurfpool();
  // TODO: fund player on Surfpool
}
