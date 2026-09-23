import { configuredConcurrency, mapWithConcurrency } from "./concurrency.js";
import { discoverTokens } from "./discovery.js";
import { RESEARCH_ENDPOINTS, researchToken } from "./researchGate.js";
import { detectRotations } from "./rotationEngine.js";
import { scoreTokens } from "./scoringEngine.js";
import { creditCostFor } from "./creditBudget.js";

export const FULL_TOKEN_RESEARCH_CREDITS = Object.values(RESEARCH_ENDPOINTS)
  .reduce((total, endpoint) => total + creditCostFor(endpoint), 0);

export async function scanAllTokens(nansenClient, options = {}) {
  const scanStartedAt = new Date();
  const startedAt = performance.now();
  const discoveryStartedAt = performance.now();
  const discovery = await discoverTokens(nansenClient);
  const discoveryDurationMs = performance.now() - discoveryStartedAt;

  if (discovery.tokens.length === 0) {
    return {
      scanStartedAt: scanStartedAt.toISOString(),
      scanCompletedAt: new Date().toISOString(),
      totalDurationMs: performance.now() - startedAt,
      discoveryDurationMs,
      researchDurationMs: 0,
      tokensDiscovered: 0,
      tokensAnalyzed: 0,
      tokensFailed: 0,
      tokensSelectedForResearch: 0,
      tokensSkippedByBudget: 0,
      discoveredTokens: [],
      discoveryPages: discovery.pagesFetched,
      discoveryStoppedByBudget: discovery.stoppedByBudget,
      maximumConcurrentRequests: 0,
      tokens: [],
      rotations: [],
      failures: [],
    };
  }

  const candidates = discovery.tokens.slice(0, options.maxTokens ?? discovery.tokens.length);
  const concurrency = configuredConcurrency(options.concurrency);
  const researchStartedAt = performance.now();
  const tokens = [];
  const failures = [];
  let maximumConcurrentRequests = 0;
  let cursor = 0;

  while (cursor < candidates.length) {
    let batchSize = Math.min(concurrency, candidates.length - cursor);
    if (options.creditBudget) {
      const remaining = options.creditBudget.usage().remainingCredits;
      batchSize = Math.min(batchSize, Math.floor(remaining / FULL_TOKEN_RESEARCH_CREDITS));
    }
    if (batchSize < 1) break;

    const batch = candidates.slice(cursor, cursor + batchSize);
    const pool = await mapWithConcurrency(
      batch,
      (token) => researchToken(nansenClient, token, { now: options.now ?? new Date() }),
      { concurrency: batchSize },
    );
    maximumConcurrentRequests = Math.max(maximumConcurrentRequests, pool.maximumConcurrentRequests);
    cursor += batch.length;

    for (const [index, outcome] of pool.results.entries()) {
      const discoveredToken = batch[index];
      if (outcome.status === "fulfilled" && outcome.value.passed) {
        tokens.push(outcome.value);
      } else {
        failures.push({
          token: discoveredToken,
          reason: outcome.status === "rejected"
            ? outcome.reason?.message ?? String(outcome.reason)
            : outcome.value.reason,
          details: outcome.status === "fulfilled" ? outcome.value.failures ?? null : null,
        });
      }
    }
  }
  const researchDurationMs = performance.now() - researchStartedAt;

  const rotations = detectRotations(tokens);
  const rankedTokens = scoreTokens(tokens, rotations);
  return {
    scanStartedAt: scanStartedAt.toISOString(),
    scanCompletedAt: new Date().toISOString(),
    totalDurationMs: performance.now() - startedAt,
    discoveryDurationMs,
    researchDurationMs,
    tokensDiscovered: discovery.tokens.length,
    tokensSelectedForResearch: cursor,
    tokensSkippedByBudget: candidates.length - cursor,
    tokensAnalyzed: tokens.length,
    tokensFailed: failures.length,
    discoveredTokens: discovery.tokens,
    discoveryPages: discovery.pagesFetched,
    discoveryStoppedByBudget: discovery.stoppedByBudget,
    maximumConcurrentRequests,
    tokens: rankedTokens,
    rotations,
    failures,
  };
}
