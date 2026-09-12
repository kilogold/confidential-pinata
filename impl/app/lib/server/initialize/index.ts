import { isSome, type Address } from "@solana/kit";
import {
  fetchMint as fetchSplMint,
  fetchMaybeToken as fetchMaybeSplToken,
  findAssociatedTokenPda,
} from "@solana-program/token";
import {
  fetchMint as fetchToken2022Mint,
  fetchMaybeToken as fetchMaybeToken2022,
} from "@solana-program/token-2022";
import {
  fetchMaybeSession,
  findHpVaultPda,
  findSessionPda,
  SessionStatus,
} from "@/app/generated/pinata";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@/app/lib/constants";
import { deriveArbiterKeys } from "../arbiter-keys";
import type { SolanaRpc } from "../rpc";
import { buildPartialInitializeTransaction } from "./build";
import { InitializeApiError } from "./errors";
import { drawHp } from "./hp";
import { quoteRewardInSol } from "./price";
import { generateInitializeProofs, hpVaultNeedsCreate } from "./proofs";
import {
  parseDecimalToUnits,
  parseInitializeBody,
  parseStrikeFeeLamports,
} from "./validate";

export type InitializeSuccess = {
  transaction: string;
};

async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InitializeApiError) throw err;
    throw new InitializeApiError(
      "RPC_UNAVAILABLE",
      err instanceof Error ? err.message : "RPC request failed",
      { status: 502 }
    );
  }
}

export async function orchestrateInitialize(
  rpc: SolanaRpc,
  env: { arbiterSecretKey: Uint8Array; hpMint: Address },
  body: unknown
): Promise<InitializeSuccess> {
  const input = parseInitializeBody(body);
  const strikeFeeLamports = parseStrikeFeeLamports(input.strikeFeeSolUi);

  let keys;
  try {
    keys = await deriveArbiterKeys(env.arbiterSecretKey);
  } catch (err) {
    throw new InitializeApiError(
      "ARBITER_KEY_MISSING",
      err instanceof Error ? err.message : "Could not load the arbiter key",
      { status: 500 }
    );
  }

  const { value: hpMintInfo } = await rpcCall(() =>
    rpc.getAccountInfo(env.hpMint, { encoding: "base64" }).send()
  );
  if (!hpMintInfo || hpMintInfo.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "HP_MINT is not a Token-2022 mint",
      { status: 500 }
    );
  }
  let hpMint;
  try {
    hpMint = await fetchToken2022Mint(rpc, env.hpMint);
  } catch (err) {
    if (err instanceof InitializeApiError) throw err;
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "HP_MINT is not a valid Token-2022 mint",
      { status: 500 }
    );
  }
  if (
    !isSome(hpMint.data.mintAuthority) ||
    hpMint.data.mintAuthority.value !== keys.signer.address
  ) {
    throw new InitializeApiError(
      "HP_MINT_MISCONFIGURED",
      "arbiter must be the HP mint authority",
      { status: 500 }
    );
  }

  const { value: rewardMintInfo } = await rpcCall(() =>
    rpc.getAccountInfo(input.rewardMint, { encoding: "base64" }).send()
  );
  if (!rewardMintInfo) {
    throw new InitializeApiError(
      "REWARD_MINT_NOT_FOUND",
      "No account exists at the reward mint address",
      { field: "rewardMint" }
    );
  }

  let rewardTokenProgram: Address;
  let decimals: number;
  if (rewardMintInfo.owner === TOKEN_PROGRAM_ADDRESS) {
    rewardTokenProgram = TOKEN_PROGRAM_ADDRESS;
    try {
      const mint = await fetchSplMint(rpc, input.rewardMint);
      decimals = mint.data.decimals;
    } catch (err) {
      if (err instanceof InitializeApiError) throw err;
      throw new InitializeApiError(
        "NOT_A_MINT",
        "rewardMint is not an SPL Token mint",
        { field: "rewardMint" }
      );
    }
  } else if (rewardMintInfo.owner === TOKEN_2022_PROGRAM_ADDRESS) {
    rewardTokenProgram = TOKEN_2022_PROGRAM_ADDRESS;
    try {
      const mint = await fetchToken2022Mint(rpc, input.rewardMint);
      decimals = mint.data.decimals;
    } catch (err) {
      if (err instanceof InitializeApiError) throw err;
      throw new InitializeApiError(
        "NOT_A_MINT",
        "rewardMint is not a Token-2022 mint",
        { field: "rewardMint" }
      );
    }
  } else {
    throw new InitializeApiError(
      "NOT_A_MINT",
      "rewardMint is not an SPL Token or Token-2022 mint",
      { field: "rewardMint" }
    );
  }

  const rewardAmount = parseDecimalToUnits(
    input.rewardAmountUi,
    decimals,
    "INVALID_REWARD_AMOUNT",
    "rewardAmount"
  );

  const [rewardSource] = await findAssociatedTokenPda({
    owner: input.gm,
    tokenProgram: rewardTokenProgram,
    mint: input.rewardMint,
  });
  const source =
    rewardTokenProgram === TOKEN_2022_PROGRAM_ADDRESS
      ? await rpcCall(() => fetchMaybeToken2022(rpc, rewardSource))
      : await rpcCall(() => fetchMaybeSplToken(rpc, rewardSource));
  if (!source.exists) {
    throw new InitializeApiError(
      "REWARD_SOURCE_MISSING",
      "The connected wallet has no associated token account for this mint",
      { field: "rewardMint" }
    );
  }
  if (source.data.amount < rewardAmount) {
    throw new InitializeApiError(
      "INSUFFICIENT_REWARD_BALANCE",
      "Reward token account balance is below the requested amount",
      { field: "rewardAmount" }
    );
  }

  const [sessionPda] = await findSessionPda({ sessionId: input.sessionId });
  const [hpVault] = await findHpVaultPda({ sessionId: input.sessionId });
  const session = await rpcCall(() => fetchMaybeSession(rpc, sessionPda));
  if (session.exists && session.data.status === SessionStatus.Live) {
    throw new InitializeApiError(
      "SESSION_ALREADY_LIVE",
      "A live piñata already exists for this session ID",
      { field: "sessionId" }
    );
  }

  const needsVaultCreate = await hpVaultNeedsCreate(rpc, hpVault);
  const needsZeroProof =
    session.exists &&
    session.data.status === SessionStatus.GameOver &&
    !needsVaultCreate;

  const rewardUiAmount = Number(input.rewardAmountUi);
  const quote = await quoteRewardInSol(input.rewardMint, rewardUiAmount);
  const hp = drawHp(quote.rewardInSol, strikeFeeLamports);

  let proofs;
  try {
    proofs = await generateInitializeProofs({
      rpc,
      payer: keys.signer,
      elgamal: keys.elgamal,
      aes: keys.aes,
      hpMint: env.hpMint,
      hpVault,
      hp,
      needsVaultCreate,
      needsZeroProof,
    });
  } catch (err) {
    if (err instanceof InitializeApiError) throw err;
    throw new InitializeApiError(
      "PROOF_SETUP_FAILED",
      "Could not generate or submit mint proofs",
      { status: 502 }
    );
  }

  const transaction = await buildPartialInitializeTransaction({
    rpc,
    gm: input.gm,
    arbiter: keys.signer,
    sessionId: input.sessionId,
    strikeFeeLamports,
    rewardAmount,
    rewardMint: input.rewardMint,
    rewardTokenProgram,
    hpMint: env.hpMint,
    proofs,
  });

  return { transaction };
}
