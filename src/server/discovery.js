export const TOKEN_SCREENER_ENDPOINT = "/api/v1/token-screener";
export const DISCOVERY_LIMIT = 25;

export const DISCOVERY_REQUEST = Object.freeze({
  chains: ["ethereum", "base", "solana", "bnb", "arbitrum"],
  timeframe: "24h",
  pagination: {
    page: 1,
    per_page: DISCOVERY_LIMIT,
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
  const result = await nansenClient.post(TOKEN_SCREENER_ENDPOINT, DISCOVERY_REQUEST);
  const records = Array.isArray(result.data?.data) ? result.data.data : [];
  const tokens = records.slice(0, DISCOVERY_LIMIT).map(normalizeDiscoveredToken);

  return {
    tokens,
    filters: DISCOVERY_REQUEST,
    durationMs: performance.now() - startedAt,
    pagination: result.data?.pagination ?? null,
    api: result.meta,
  };
}
