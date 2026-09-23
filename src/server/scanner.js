import { mapWithConcurrency } from "./concurrency.js";
import { discoverTokens } from "./discovery.js";
import { researchToken } from "./researchGate.js";

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
      maximumConcurrentRequests: 0,
      tokens: [],
      failures: [],
    };
  }

  const researchStartedAt = performance.now();
  const pool = await mapWithConcurrency(
    discovery.tokens,
    (token) => researchToken(nansenClient, token, { now: options.now ?? new Date() }),
    { concurrency: options.concurrency },
  );
  const researchDurationMs = performance.now() - researchStartedAt;

  const tokens = [];
  const failures = [];
  for (const [index, outcome] of pool.results.entries()) {
    const discoveredToken = discovery.tokens[index];
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

  return {
    scanStartedAt: scanStartedAt.toISOString(),
    scanCompletedAt: new Date().toISOString(),
    totalDurationMs: performance.now() - startedAt,
    discoveryDurationMs,
    researchDurationMs,
    tokensDiscovered: discovery.tokens.length,
    tokensAnalyzed: tokens.length,
    tokensFailed: failures.length,
    maximumConcurrentRequests: pool.maximumConcurrentRequests,
    tokens,
    failures,
  };
}
