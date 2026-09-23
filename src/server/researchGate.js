import { discoverTokens } from "./discovery.js";

export const RESEARCH_ENDPOINTS = Object.freeze({
  flowIntelligence: "/api/v1/tgm/flow-intelligence",
  flows: "/api/v1/tgm/flows",
  buyers: "/api/v1/tgm/who-bought-sold",
  sellers: "/api/v1/tgm/who-bought-sold",
  holders: "/api/v1/tgm/holders",
});

const SMART_MONEY_LABELS = Object.freeze([
  "Fund",
  "Smart Trader",
  "30D Smart Trader",
  "90D Smart Trader",
  "180D Smart Trader",
]);

function dateRange(now = new Date()) {
  return {
    from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
    to: now.toISOString(),
  };
}

export function createResearchRequests(token, now) {
  const date = dateRange(now);
  const common = {
    chain: token.chain,
    token_address: token.contractAddress,
  };

  return {
    flowIntelligence: {
      ...common,
      timeframe: "1d",
    },
    flows: {
      ...common,
      date,
      label: "smart_money",
      pagination: { page: 1, per_page: 30 },
      order_by: [{ field: "date", direction: "DESC" }],
    },
    buyers: {
      ...common,
      buy_or_sell: "BUY",
      date,
      pagination: { page: 1, per_page: 25 },
      filters: {
        include_smart_money_labels: SMART_MONEY_LABELS,
        trade_volume_usd: { min: 1 },
      },
      order_by: [{ field: "bought_volume_usd", direction: "DESC" }],
    },
    sellers: {
      ...common,
      buy_or_sell: "SELL",
      date,
      pagination: { page: 1, per_page: 25 },
      filters: {
        include_smart_money_labels: SMART_MONEY_LABELS,
        trade_volume_usd: { min: 1 },
      },
      order_by: [{ field: "sold_volume_usd", direction: "DESC" }],
    },
    holders: {
      ...common,
      aggregate_by_entity: false,
      label_type: "all_holders",
      premium_labels: false,
      pagination: { page: 1, per_page: 25 },
      order_by: [{ field: "token_amount", direction: "DESC" }],
    },
  };
}

function recordsFrom(result) {
  return Array.isArray(result.data?.data) ? result.data.data : [];
}

function normalizeWallet(record) {
  return {
    address: record.address ?? null,
    label: record.address_label ?? null,
    boughtVolumeUsd: record.bought_volume_usd ?? null,
    soldVolumeUsd: record.sold_volume_usd ?? null,
    tradeVolumeUsd: record.trade_volume_usd ?? null,
  };
}

function normalizeHolder(record) {
  return {
    address: record.address ?? null,
    label: record.address_label ?? null,
    tokenAmount: record.token_amount ?? null,
    ownershipPercentage: record.ownership_percentage ?? null,
    valueUsd: record.value_usd ?? null,
    balanceChange24h: record.balance_change_24h ?? null,
    balanceChange7d: record.balance_change_7d ?? null,
    balanceChange30d: record.balance_change_30d ?? null,
  };
}

function normalizeFlow(record) {
  return {
    date: record.date ?? null,
    bucketEnd: record.bucket_end ?? null,
    isComplete: record.is_complete ?? null,
    priceUsd: record.price_usd ?? null,
    tokenAmount: record.token_amount ?? null,
    valueUsd: record.value_usd ?? null,
    holdersCount: record.holders_count ?? null,
    totalInflowsCount: record.total_inflows_count ?? null,
    totalOutflowsCount: record.total_outflows_count ?? null,
  };
}

function normalizeFlowIntelligence(record) {
  return {
    smartTraderNetFlowUsd: record.smart_trader_net_flow_usd ?? null,
    smartTraderAverageFlowUsd: record.smart_trader_avg_flow_usd ?? null,
    smartTraderWalletCount: record.smart_trader_wallet_count ?? null,
    topPnlNetFlowUsd: record.top_pnl_net_flow_usd ?? null,
    topPnlWalletCount: record.top_pnl_wallet_count ?? null,
    exchangeNetFlowUsd: record.exchange_net_flow_usd ?? null,
    whaleNetFlowUsd: record.whale_net_flow_usd ?? null,
  };
}

export async function runResearchGate(nansenClient, { now = new Date() } = {}) {
  const discovery = await discoverTokens(nansenClient);
  const token = discovery.tokens[0];
  if (!token) {
    return { passed: false, reason: "No qualifying token was available for research.", discovery };
  }

  const requests = createResearchRequests(token, now);
  const startedAt = performance.now();
  const names = Object.keys(RESEARCH_ENDPOINTS);
  const settled = await Promise.allSettled(
    names.map((name) => nansenClient.post(RESEARCH_ENDPOINTS[name], requests[name])),
  );

  const failures = {};
  const results = {};
  for (const [index, outcome] of settled.entries()) {
    const name = names[index];
    if (outcome.status === "rejected") failures[name] = outcome.reason;
    else results[name] = outcome.value;
  }

  if (Object.keys(failures).length > 0) {
    return {
      passed: false,
      reason: "One or more required Nansen research endpoints failed.",
      token,
      requests,
      failures,
      durationMs: performance.now() - startedAt,
    };
  }

  const buyers = recordsFrom(results.buyers).map(normalizeWallet);
  const sellers = recordsFrom(results.sellers).map(normalizeWallet);
  const walletDataAvailable =
    buyers.length > 0 &&
    sellers.length > 0 &&
    buyers.every((wallet) => Boolean(wallet.address)) &&
    sellers.every((wallet) => Boolean(wallet.address));

  return {
    passed: walletDataAvailable,
    reason: walletDataAvailable
      ? "Wallet-level Smart Money buyer and seller data is available."
      : "The requests succeeded, but both wallet-level buyer and seller evidence was not available.",
    token,
    requests,
    durationMs: performance.now() - startedAt,
    flowIntelligence: recordsFrom(results.flowIntelligence).map(normalizeFlowIntelligence),
    flows: recordsFrom(results.flows).map(normalizeFlow),
    buyers,
    sellers,
    holders: recordsFrom(results.holders).map(normalizeHolder),
    warnings: {
      flowIntelligence: results.flowIntelligence.data?.warnings ?? [],
      flows: results.flows.data?.warnings ?? [],
      holders: results.holders.data?.warnings ?? [],
    },
    api: Object.fromEntries(names.map((name) => [name, results[name].meta])),
  };
}
