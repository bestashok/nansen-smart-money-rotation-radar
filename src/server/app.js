import express from "express";
import { createNansenClient } from "./nansenClient.js";
import { scanAllTokens } from "./scanner.js";
import { readHistory, readLatest, saveScan } from "./dataStore.js";
import { readUsage, trackNansenUsage } from "./apiUsage.js";
import { withCreditBudget } from "./creditBudget.js";
import { createCachedNansenClient } from "./cache.js";
import { withRateLimitRetries } from "./retry.js";

export function createApp() {
  const app = express();
  const status = { phase: "IDLE", running: false, message: "Ready for a live scan." };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "nansen-smart-money-rotation-radar",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/scan", (_request, response) => {
    if (status.running) return response.status(409).json({ error: "A scan is already running." });
    status.running = true;
    status.phase = "DISCOVERING_TOKENS";
    status.message = "Discovering qualifying tokens with Nansen.";
    const tracked = trackNansenUsage(createNansenClient());
    const budgeted = withCreditBudget(tracked, 200);
    const retried = withRateLimitRetries(budgeted);
    const cached = createCachedNansenClient(retried);
    scanAllTokens(cached, { maxTokens: 2, concurrency: 2 })
      .then(async (result) => {
        const averageApiLatencyMs = tracked.current.latencies.length
          ? tracked.current.latencies.reduce((sum, value) => sum + value, 0) / tracked.current.latencies.length
          : 0;
        Object.assign(result, { liveApiCalls: tracked.current.calls, cacheHits: cached.current.hits, averageApiLatencyMs, rateLimitEvents: tracked.current.rateLimitEvents, creditBudget: budgeted.usage() });
        await saveScan(result);
        Object.assign(status, { running: false, phase: "SCAN_COMPLETE", message: `Scan complete — ${result.tokensDiscovered} qualifying tokens found.` });
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
