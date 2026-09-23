import express from "express";
import { createNansenClient } from "./nansenClient.js";
import { scanAllTokens } from "./scanner.js";
import { readHistory, readLatest, saveScan } from "./dataStore.js";
import { readUsage, trackNansenUsage } from "./apiUsage.js";
import { withCreditBudget } from "./creditBudget.js";
import { createCachedNansenClient } from "./cache.js";
import { withRateLimitRetries } from "./retry.js";
import { API_CALL_TARGET, runEligibilityCampaign } from "./eligibilityCampaign.js";
import { readCampaignHistory, saveCampaignRun } from "./campaignStore.js";
import { withCallBudget } from "./callBudget.js";

const DEFAULT_SCAN_CREDIT_LIMIT = 200;

function requestedCreditLimit(value) {
  const limit = value === undefined ? DEFAULT_SCAN_CREDIT_LIMIT : Number(value);
  return Number.isSafeInteger(limit) && limit >= 10 && limit <= DEFAULT_SCAN_CREDIT_LIMIT ? limit : null;
}

function campaignCooldownMs() {
  const minutes = Number(process.env.CACHE_TTL_MINUTES ?? 15);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
}

function createBoundedNansenClient(creditLimit, { callLimit } = {}) {
  const tracked = trackNansenUsage(createNansenClient());
  const callBudgeted = callLimit ? withCallBudget(tracked, callLimit) : tracked;
  const budgeted = withCreditBudget(callBudgeted, creditLimit);
  const retried = withRateLimitRetries(budgeted);
  const cached = createCachedNansenClient(retried);
  return { tracked, budgeted, cached, callBudgeted };
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
    const { tracked, budgeted, cached } = createBoundedNansenClient(creditLimit);
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

  app.post("/api/campaign", async (request, response) => {
    if (status.running) return response.status(409).json({ error: "A scan or campaign run is already running." });
    const creditLimit = requestedCreditLimit(request.body?.creditLimit);
    if (creditLimit === null) {
      return response.status(400).json({ error: "creditLimit must be a whole number from 10 through 200." });
    }

    const usageBefore = await readUsage();
    const callsRemaining = Math.max(0, API_CALL_TARGET - usageBefore.cumulativeRealNansenApiCalls);
    if (callsRemaining === 0) {
      return response.status(409).json({ error: "The 1,000-call campaign target is already complete." });
    }
    const history = await readCampaignHistory();
    const lastStartedAt = Date.parse(history[0]?.campaignStartedAt ?? "");
    const nextEligibleAt = Number.isFinite(lastStartedAt) ? lastStartedAt + campaignCooldownMs() : 0;
    if (Date.now() < nextEligibleAt) {
      return response.status(429).json({
        error: "Wait for the 15-minute research window before starting another campaign cycle.",
        retryAfterSeconds: Math.ceil((nextEligibleAt - Date.now()) / 1_000),
      });
    }

    Object.assign(status, {
      running: true,
      phase: "CAMPAIGN_RESEARCH",
      creditLimit,
      message: `Collecting a new wallet-research snapshot toward ${API_CALL_TARGET.toLocaleString()} real calls.`,
    });
    const { tracked, budgeted, cached } = createBoundedNansenClient(creditLimit, { callLimit: callsRemaining });
    runEligibilityCampaign(cached, { creditLimit, callsRemaining })
      .then(async (result) => {
        const usageAfter = await readUsage();
        Object.assign(result, {
          liveApiCalls: tracked.current.calls,
          cacheHits: cached.current.hits,
          creditBudget: budgeted.usage(),
          cumulativeCallsBefore: usageBefore.cumulativeRealNansenApiCalls,
          cumulativeCallsAfter: usageAfter.cumulativeRealNansenApiCalls,
          callsRemaining: Math.max(0, API_CALL_TARGET - usageAfter.cumulativeRealNansenApiCalls),
        });
        await saveCampaignRun(result);
        Object.assign(status, {
          running: false,
          phase: "CAMPAIGN_COMPLETE",
          message: `Research cycle complete — ${result.liveApiCalls} real calls, ${result.rotations.length} probable rotations, ${result.callsRemaining} calls remaining.`,
        });
      })
      .catch((error) => Object.assign(status, { running: false, phase: "FAILED", message: error.message }));
    return response.status(202).json({
      accepted: true,
      maximumLogicalCalls: Math.min(Math.floor(creditLimit / 10), callsRemaining),
    });
  });

  app.get("/api/status", (_request, response) => response.json(status));
  app.get("/api/results", async (_request, response) => response.json(await readLatest()));
  app.get("/api/rotations", async (_request, response) => response.json((await readLatest())?.rotations ?? []));
  app.get("/api/usage", async (_request, response) => response.json(await readUsage()));
  app.get("/api/history", async (_request, response) => response.json(await readHistory()));
  app.get("/api/campaign", async (_request, response) => {
    const [history, usage] = await Promise.all([readCampaignHistory(), readUsage()]);
    const lastStartedAt = Date.parse(history[0]?.campaignStartedAt ?? "");
    const nextEligibleAt = Number.isFinite(lastStartedAt)
      ? new Date(lastStartedAt + campaignCooldownMs()).toISOString()
      : null;
    response.json({
      targetApiCalls: API_CALL_TARGET,
      cumulativeRealNansenApiCalls: usage.cumulativeRealNansenApiCalls,
      callsRemaining: Math.max(0, API_CALL_TARGET - usage.cumulativeRealNansenApiCalls),
      completedRuns: history.length,
      latest: history[0] ?? null,
      nextEligibleAt,
      canRun: usage.cumulativeRealNansenApiCalls < API_CALL_TARGET &&
        (!nextEligibleAt || Date.now() >= Date.parse(nextEligibleAt)),
    });
  });

  return app;
}
