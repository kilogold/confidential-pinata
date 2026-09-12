import { WSOL_MINT } from "@/app/lib/constants";
import { InitializeApiError } from "./errors";

type JupiterToken = {
  id?: string;
  usdPrice?: number | null;
};

async function searchToken(mint: string): Promise<JupiterToken | undefined> {
  const url = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new InitializeApiError(
      "JUPITER_UNAVAILABLE",
      "Could not reach Jupiter Tokens API",
      { status: 502 }
    );
  }
  if (!response.ok) {
    throw new InitializeApiError(
      "JUPITER_UNAVAILABLE",
      `Jupiter Tokens API returned ${response.status}`,
      { status: 502 }
    );
  }
  const json: unknown = await response.json();
  if (!Array.isArray(json)) {
    return undefined;
  }
  return json.find(
    (row): row is JupiterToken =>
      typeof row === "object" &&
      row !== null &&
      "id" in row &&
      (row as JupiterToken).id === mint
  );
}

function usdPriceOf(token: JupiterToken | undefined): number | null {
  const price = token?.usdPrice;
  return typeof price === "number" && Number.isFinite(price) && price > 0
    ? price
    : null;
}

export type RewardQuote = {
  rewardInSol: number;
  rewardUsdPrice: number;
  solUsdPrice: number;
};

/**
 * A4: reward_in_SOL = (reward_ui_amount * reward_usdPrice) / sol_usdPrice.
 * Missing mint or null usdPrice → treat 1 token = 1 USD.
 */
export async function quoteRewardInSol(
  rewardMint: string,
  rewardUiAmount: number
): Promise<RewardQuote> {
  const [rewardToken, solToken] = await Promise.all([
    searchToken(rewardMint),
    searchToken(WSOL_MINT),
  ]);

  const solUsdPrice = usdPriceOf(solToken);
  if (solUsdPrice === null) {
    throw new InitializeApiError(
      "JUPITER_SOL_PRICE_UNAVAILABLE",
      "Jupiter did not return a usdPrice for wrapped SOL",
      { status: 502 }
    );
  }

  const rewardUsdPrice = usdPriceOf(rewardToken) ?? 1;
  const rewardInSol = (rewardUiAmount * rewardUsdPrice) / solUsdPrice;
  if (!Number.isFinite(rewardInSol) || rewardInSol <= 0) {
    throw new InitializeApiError(
      "JUPITER_UNAVAILABLE",
      "Could not convert the reward amount to SOL",
      { status: 502 }
    );
  }

  return { rewardInSol, rewardUsdPrice, solUsdPrice };
}
