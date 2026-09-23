import express from "express";
import { createNansenClient } from "./nansenClient.js";
import { scanAllTokens } from "./scanner.js";
import { readHistory, readLatest, saveScan } from "./dataStore.js";
import { readUsage, trackNansenUsage } from "./apiUsage.js";
import { withCreditBudget } from "./creditBudget.js";
import { createCachedNansenClient } from "./cache.js";
import { withRateLimitRetries } from "./retry.js";

const DEFAULT_SCAN_CREDIT_LIMIT = 200;

function requestedCreditLimit(value) {
  const limit = value === undefined ? DEFAULT_SCAN_CREDIT_LIMIT : Number(value);
  return Number.isSafeInteger(limit) && limit >= 10 && limit <= DEFAULT_SCAN_CREDIT_LIMIT ? limit : null;
}

export function createApp() {
  const app = express();
  const status = { phase: "IDLE", running: false, message: "Ready for a live scan.", creditLimit: DEFAULT_SCAN_CREDIT_LIMIT };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "nansen-smart-money-rotation-radar",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/scan", (request, response) => {
    if (status.running) return response.status(409).json({ error: "A scan is already running." });
    const creditLimit = requestedCreditLimit(request.body?.creditLimit);
    if (creditLimit === null) {
      return response.status(400).json({ error: "creditLimit must be a whole number from 10 through 200." });
    }
    status.running = true;
    status.phase = "DISCOVERING_TOKENS";
    status.creditLimit = creditLimit;
    status.message = `Discovering qualifying tokens within a ${creditLimit}-credit budget.`;
    const tracked = trackNansenUsage(createNansenClient());
    const budgeted = withCreditBudget(tracked, creditLimit);
    const retried = withRateLimitRetries(budgeted);
    const cached = createCachedNansenClient(retried);
    scanAllTokens(cached, { creditBudget: budgeted })
      .then(async (result) => {
        const averageApiLatencyMs = tracked.current.latencies.length
          ? tracked.current.latencies.reduce((sum, value) => sum + value, 0) / tracked.current.latencies.length
          : 0;
        Object.assign(result, { liveApiCalls: tracked.current.calls, cacheHits: cached.current.hits, averageApiLatencyMs, rateLimitEvents: tracked.current.rateLimitEvents, creditBudget: budgeted.usage() });
        await saveScan(result);
        Object.assign(status, { running: false, phase: "SCAN_COMPLETE", message: `Scan complete — ${result.tokensDiscovered} discovered, ${result.tokensAnalyzed} analyzed, ${result.tokensSkippedByBudget} skipped by budget.` });
      })
      .catch((error) => Object.assign(status, { running: false, phase: "FAILED", message: error.message }));
    return response.status(202).json({ accepted: true });
  });

  app.get("/api/status", (_request, response) => response.json(status));
  app.get("/api/results", async (_request, response) => response.json(await readLatest()));
  app.get("/api/rotations", async (_request, response) => response.json((await readLatest())?.rotations ?? []));
  app.get("/api/usage", async (_request, response) => response.json(await readUsage()));
  app.get("/api/history", async (_request, response) => response.json(await readHistory()));

  return app;
}
