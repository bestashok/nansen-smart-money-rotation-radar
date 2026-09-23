import { CreditBudgetExceededError } from "./creditBudget.js";

export const TOKEN_SCREENER_ENDPOINT = "/api/v1/token-screener";
export const DISCOVERY_PAGE_SIZE = 20;

export const DISCOVERY_REQUEST = Object.freeze({
  chains: ["ethereum", "base", "solana", "bnb", "arbitrum"],
  timeframe: "24h",
  pagination: {
    page: 1,
    per_page: DISCOVERY_PAGE_SIZE,
  },
  filters: {
    trader_type: "sm",
    include_stablecoins: false,
    market_cap_usd: { min: 1_000_000, max: 1_000_000_000 },
    liquidity: { min: 100_000 },
    volume: { min: 100_000 },
    netflow: { min: 1_000 },
    nof_traders: { min: 3 },
  },
  order_by: [{ field: "netflow", direction: "DESC" }],
});

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeDiscoveredToken(record) {
  return {
    symbol: record.token_symbol,
    chain: record.chain,
    contractAddress: record.token_address,
    marketCapUsd: numberOrNull(record.market_cap_usd),
    liquidityUsd: numberOrNull(record.liquidity),
    netflowUsd: numberOrNull(record.netflow),
  };
}

export async function discoverTokens(nansenClient) {
  const startedAt = performance.now();
  const tokens = [];
  const seen = new Set();
  const api = [];
  let page = 1;
  let pagination = null;
  let stoppedByBudget = false;

  while (true) {
    const request = {
      ...DISCOVERY_REQUEST,
      pagination: { page, per_page: DISCOVERY_PAGE_SIZE },
    };
    let result;
    try {
      result = await nansenClient.post(TOKEN_SCREENER_ENDPOINT, request);
    } catch (error) {
      if (error instanceof CreditBudgetExceededError && page > 1) {
        stoppedByBudget = true;
        break;
      }
      throw error;
    }

    api.push(result.meta);
    const records = Array.isArray(result.data?.data) ? result.data.data : [];
    let newTokens = 0;
    for (const record of records) {
      const token = normalizeDiscoveredToken(record);
      const key = `${token.chain}:${token.contractAddress}`;
      if (!token.chain || !token.contractAddress || seen.has(key)) continue;
      seen.add(key);
      tokens.push(token);
      newTokens += 1;
    }

    pagination = result.data?.pagination ?? null;
    if (pagination?.is_last_page === true || records.length === 0) break;
    if (!pagination && records.length < DISCOVERY_PAGE_SIZE) break;
    if (newTokens === 0) break;
    page += 1;
  }

  return {
    tokens,
    filters: DISCOVERY_REQUEST,
    durationMs: performance.now() - startedAt,
    pagination,
    pagesFetched: api.length,
    stoppedByBudget,
    api,
  };
}
