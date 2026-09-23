import { configuredConcurrency, mapWithConcurrency } from "./concurrency.js";
import {
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_REQUEST,
  normalizeDiscoveredToken,
  TOKEN_SCREENER_ENDPOINT,
} from "./discovery.js";
import { detectRotations } from "./rotationEngine.js";
import { createResearchRequests, RESEARCH_ENDPOINTS } from "./researchGate.js";

export const API_CALL_TARGET = 1_000;

function recordsFrom(result) {
  return Array.isArray(result?.data?.data) ? result.data.data : [];
}

function wallet(record) {
  return {
    address: record.address ?? null,
    label: record.address_label ?? null,
    boughtVolumeUsd: record.bought_volume_usd ?? null,
    soldVolumeUsd: record.sold_volume_usd ?? null,
    tradeVolumeUsd: record.trade_volume_usd ?? null,
  };
}

function flowIntelligence(record) {
  return {
    smartTraderNetFlowUsd: record.smart_trader_net_flow_usd ?? null,
    smartTraderWalletCount: record.smart_trader_wallet_count ?? null,
    topPnlNetFlowUsd: record.top_pnl_net_flow_usd ?? null,
    whaleNetFlowUsd: record.whale_net_flow_usd ?? null,
  };
}

function uniqueTokens(records) {
  const seen = new Set();
  const tokens = [];
  for (const record of records) {
    const token = normalizeDiscoveredToken(record);
    const key = `${token.chain}:${token.contractAddress}`;
    if (!token.chain || !token.contractAddress || seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

export async function runEligibilityCampaign(nansenClient, {
  creditLimit = 200,
  callsRemaining = API_CALL_TARGET,
  concurrency,
  now = new Date(),
} = {}) {
  const startedAt = performance.now();
  const maximumLogicalCalls = Math.max(
    1,
    Math.min(Math.floor(creditLimit / 10), Math.max(1, callsRemaining)),
  );
  const discovery = await nansenClient.post(TOKEN_SCREENER_ENDPOINT, {
    ...DISCOVERY_REQUEST,
    pagination: { page: 1, per_page: DISCOVERY_PAGE_SIZE },
  });
  const tokens = uniqueTokens(recordsFrom(discovery));
  let slots = maximumLogicalCalls - 1;
  const pairCount = Math.min(tokens.length, Math.floor(slots / 2));
  const pairedTokens = tokens.slice(0, pairCount);
  const tasks = [];

  for (const token of pairedTokens) {
    const requests = createResearchRequests(token, now);
    tasks.push({ token, kind: "buyers", endpoint: RESEARCH_ENDPOINTS.buyers, body: requests.buyers });
    tasks.push({ token, kind: "sellers", endpoint: RESEARCH_ENDPOINTS.sellers, body: requests.sellers });
  }
  slots -= pairCount * 2;

  const contextTokens = pairedTokens.length ? pairedTokens : tokens;
  for (const kind of ["flowIntelligence", "flows"]) {
    for (const token of contextTokens) {
      if (slots < 1) break;
      const requests = createResearchRequests(token, now);
      tasks.push({ token, kind, endpoint: RESEARCH_ENDPOINTS[kind], body: requests[kind] });
      slots -= 1;
    }
  }

  const pool = await mapWithConcurrency(
    tasks,
    (task) => nansenClient.post(task.endpoint, task.body),
    { concurrency: configuredConcurrency(concurrency) },
  );
  const byToken = new Map(pairedTokens.map((token) => [
    `${token.chain}:${token.contractAddress}`,
    { token, buyers: [], sellers: [], flowIntelligence: [], flowPoints: 0, failures: [] },
  ]));

  for (const [index, outcome] of pool.results.entries()) {
    const task = tasks[index];
    const key = `${task.token.chain}:${task.token.contractAddress}`;
    const researched = byToken.get(key);
    if (!researched) continue;
    if (outcome.status === "rejected") {
      researched.failures.push({ kind: task.kind, message: outcome.reason?.message ?? String(outcome.reason) });
      continue;
    }
    const records = recordsFrom(outcome.value);
    if (task.kind === "buyers" || task.kind === "sellers") {
      researched[task.kind] = records.map(wallet).filter((item) => item.address);
    } else if (task.kind === "flowIntelligence") {
      researched.flowIntelligence = records.map(flowIntelligence);
    } else if (task.kind === "flows") {
      researched.flowPoints = records.length;
    }
  }

  const researchedTokens = [...byToken.values()].filter(
    (item) => item.buyers.length > 0 && item.sellers.length > 0,
  );
  const rotations = detectRotations(researchedTokens);

  return {
    campaignStartedAt: now.toISOString(),
    campaignCompletedAt: new Date().toISOString(),
    durationMs: performance.now() - startedAt,
    targetApiCalls: API_CALL_TARGET,
    logicalCallsAttempted: 1 + tasks.length,
    tokensDiscovered: tokens.length,
    tokensPairedForResearch: pairedTokens.length,
    tokensWithWalletEvidence: researchedTokens.length,
    tokensSkippedByBudget: tokens.length - pairedTokens.length,
    maximumConcurrentRequests: pool.maximumConcurrentRequests,
    researchedTokens,
    rotations,
  };
}
