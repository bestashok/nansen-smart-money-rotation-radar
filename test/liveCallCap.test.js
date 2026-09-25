import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_CALL_LIMIT, runEligibilityCampaign } from "../src/server/eligibilityCampaign.js";
import { CallBudgetExceededError, withCallBudget } from "../src/server/callBudget.js";
import { withRateLimitRetries } from "../src/server/retry.js";
import { trackNansenUsage } from "../src/server/apiUsage.js";
import { createCachedNansenClient } from "../src/server/cache.js";

const DISCOVERY_ENDPOINT = "/api/v1/token-screener";

function discovered(index) {
  return {
    token_symbol: `TOKEN${index}`,
    chain: "base",
    token_address: `0x${index.toString(16).padStart(40, "0")}`,
    market_cap_usd: 2_000_000,
    liquidity: 200_000,
    netflow: 50_000,
  };
}

function discoveryBody(count) {
  return { data: { data: Array.from({ length: count }, (_, index) => discovered(index + 1)) }, meta: { status: 200 } };
}

function rateLimited() {
  const error = new Error("rate limit exceeded");
  error.status = 429;
  error.retryAfterMs = 0;
  return error;
}

test("request 910 is never sent even when every attempt is rate-limited and retried", async () => {
  let sent = 0;
  const budgeted = withCallBudget({
    async post() {
      sent += 1;
      throw rateLimited();
    },
  }, API_CALL_LIMIT);
  const retried = withRateLimitRetries(budgeted, { maxRetries: 5_000, sleep: async () => {} });

  await assert.rejects(
    retried.post(DISCOVERY_ENDPOINT, {}),
    (error) => error instanceof CallBudgetExceededError,
  );

  assert.equal(API_CALL_LIMIT, 909);
  assert.equal(sent, 909);
  assert.ok(sent < 910, `sent ${sent} requests; request 910 must never go out`);
  assert.deepEqual(budgeted.usage(), { limit: 909, calls: 909, remainingCalls: 0 });
  assert.ok(retried.stats().retries <= API_CALL_LIMIT);
});

test("campaign planning never schedules more than the 909-request hard cap", async () => {
  let sent = 0;
  const budgeted = withCallBudget({
    async post(endpoint) {
      sent += 1;
      return endpoint === DISCOVERY_ENDPOINT
        ? discoveryBody(600)
        : { data: { data: [] }, meta: { status: 200 } };
    },
  }, API_CALL_LIMIT);

  const result = await runEligibilityCampaign(budgeted, {
    creditLimit: 100_000,
    callsRemaining: 100_000,
    concurrency: 10,
    now: new Date("2026-09-24T12:00:00Z"),
  });

  assert.equal(result.apiCallLimit, 909);
  assert.equal(result.logicalCallsAttempted, 909);
  assert.equal(sent, 909);
  assert.equal(budgeted.usage().remainingCalls, 0);
});

test("a retried campaign stops at exactly 909 real requests and never sends 910", async () => {
  let sent = 0;
  const transport = {
    async post(endpoint) {
      sent += 1;
      if (sent % 3 === 0) throw rateLimited();
      return endpoint === DISCOVERY_ENDPOINT
        ? discoveryBody(600)
        : { data: { data: [] }, meta: { status: 200 } };
    },
  };
  const budgeted = withCallBudget(transport, API_CALL_LIMIT);
  const retried = withRateLimitRetries(budgeted, { maxRetries: 10, sleep: async () => {} });

  const result = await runEligibilityCampaign(retried, {
    creditLimit: 100_000,
    callsRemaining: 100_000,
    concurrency: 10,
    now: new Date("2026-09-24T12:00:00Z"),
  });

  assert.ok(retried.stats().retries > 0, "retries should have been attempted");
  assert.ok(sent <= API_CALL_LIMIT, `sent ${sent} requests; request 910 must never go out`);
  assert.equal(sent, 909);
  assert.equal(budgeted.usage().calls, 909);
  assert.equal(budgeted.usage().remainingCalls, 0);
  assert.equal(result.runCallLimit, 909);
  assert.ok(result.logicalCallsAttempted <= API_CALL_LIMIT);
  assert.match(result.stopReason, /budget|cap/i);
});

test("cached responses never consume the 909-request budget", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-cap-"));
  const cachePath = path.join(directory, "cache.json");
  let sent = 0;
  const budgeted = withCallBudget({
    async post() {
      sent += 1;
      return { data: { data: [] }, meta: { status: 200 } };
    },
  }, API_CALL_LIMIT);
  const cached = createCachedNansenClient(budgeted, { cachePath });
  const body = { chain: "base", token_address: `0x${"a".repeat(40)}` };

  await cached.post("/api/v1/tgm/flows", body);
  await cached.post("/api/v1/tgm/flows", body);
  await cached.post("/api/v1/tgm/flows", body);

  assert.equal(cached.current.hits, 2);
  assert.equal(sent, 1);
  assert.equal(budgeted.usage().calls, 1);
  assert.equal(budgeted.usage().remainingCalls, API_CALL_LIMIT - 1);
});

test("the end-of-run report counts successful, failed, retried and total calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-cap-"));
  const usagePath = path.join(directory, "usage.json");
  let attempt = 0;
  const tracked = trackNansenUsage({
    async post() {
      attempt += 1;
      if (attempt % 2 === 1) throw rateLimited();
      return { data: { data: [] }, meta: { status: 200 } };
    },
  }, { usagePath });
  const budgeted = withCallBudget(tracked, API_CALL_LIMIT);
  const retried = withRateLimitRetries(budgeted, { maxRetries: 3, sleep: async () => {} });

  await retried.post("/api/v1/tgm/flows", {});
  await retried.post("/api/v1/tgm/flows", {});

  const totals = {
    totalCalls: budgeted.usage().calls,
    successfulCalls: tracked.current.successful,
    failedCalls: tracked.current.failed,
    retries: retried.stats().retries,
  };

  assert.deepEqual(totals, { totalCalls: 4, successfulCalls: 2, failedCalls: 2, retries: 2 });
  assert.ok(totals.totalCalls <= API_CALL_LIMIT);
});
