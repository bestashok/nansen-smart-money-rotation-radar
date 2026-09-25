import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readUsage, trackNansenUsage } from "../src/server/apiUsage.js";
import { CallBudgetExceededError, withCallBudget } from "../src/server/callBudget.js";
import {
  CAMPAIGN_CREDIT_COSTS,
  CreditBudgetExceededError,
  withCreditBudget,
} from "../src/server/creditBudget.js";
import { createCachedNansenClient } from "../src/server/cache.js";
import { createNansenClient } from "../src/server/nansenClient.js";
import { withRateLimitRetries } from "../src/server/retry.js";

// Rebuilds the exact production chain from app.js createBoundedNansenClient:
//   cached -> retried -> creditBudget -> callBudget -> tracked -> nansenClient(fetch)
// but with a fake fetch, a throwaway usage file, and a throwaway cache file so
// these tests can never touch data/api-usage.json or make a real Nansen call.
function fakeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

async function createChain({ fetchImpl, callLimit, creditCap = 875, onSend }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-runbudget-"));
  const usagePath = path.join(directory, "api-usage.json");
  const cachePath = path.join(directory, "cache.json");

  const nansen = createNansenClient({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:9",
    fetchImpl,
  });
  const tracked = trackNansenUsage(nansen, { usagePath });
  const callBudgeted = withCallBudget(tracked, callLimit, { onSend });
  const budgeted = withCreditBudget(callBudgeted, creditCap, { costs: CAMPAIGN_CREDIT_COSTS });
  const retried = withRateLimitRetries(budgeted, { maxRetries: 3, sleep: async () => {} });
  const cached = createCachedNansenClient(retried, { cachePath, ttlMinutes: 15 });

  return { cached, tracked, callBudgeted, budgeted, retried, usagePath };
}

function okBody(index) {
  return { data: { data: [{ index }] } };
}

test("hard cap: exactly `limit` requests reach the network, request limit+1 is refused before sending", async () => {
  const progress = [];
  let fetches = 0;
  const { cached, tracked, callBudgeted, usagePath } = await createChain({
    callLimit: 25,
    onSend: (event) => progress.push(event),
    fetchImpl: async () => {
      fetches += 1;
      return fakeResponse(200, okBody(fetches));
    },
  });

  const errors = [];
  for (let index = 0; index < 30; index += 1) {
    try {
      await cached.post("/api/v1/token-screener", { token_address: `0x${index}` });
    } catch (error) {
      errors.push(error);
    }
  }

  // The 26th..30th attempts never left the process.
  assert.equal(fetches, 25);
  assert.equal(errors.length, 5);
  for (const error of errors) {
    assert.ok(error instanceof CallBudgetExceededError, `unexpected error: ${error}`);
  }
  assert.deepEqual(callBudgeted.usage(), { limit: 25, calls: 25, remainingCalls: 0 });

  // Live progress: one event per real send, numbered 1..limit, never beyond.
  assert.deepEqual(progress.map((event) => event.calls), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.ok(progress.every((event) => event.limit === 25));

  // Report invariant: sent = successful + failed, and genuine usage = sent
  // (no transport failures in this test).
  assert.equal(tracked.current.attempts, 25);
  assert.equal(tracked.current.successful + tracked.current.failed, 25);
  assert.equal(tracked.current.calls, 25);

  const usage = await readUsage({ usagePath });
  assert.equal(usage.cumulativeRealNansenApiCalls, 25);
});

test("retries count as sent: every 429 attempt reaches Nansen and consumes the cap", async () => {
  let fetches = 0;
  const { cached, tracked, callBudgeted, retried, usagePath } = await createChain({
    callLimit: 10,
    fetchImpl: async () => {
      fetches += 1;
      // First request is rate limited once, then succeeds.
      if (fetches === 1) {
        return fakeResponse(429, { message: "rate limited" }, { "retry-after": "0" });
      }
      return fakeResponse(200, okBody(fetches));
    },
  });

  await cached.post("/api/v1/token-screener", { token_address: "0xaaa" });

  // 1 real send + 1 retry = 2 outbound requests, both consumed the cap.
  assert.equal(fetches, 2);
  assert.equal(callBudgeted.usage().calls, 2);
  assert.equal(callBudgeted.usage().remainingCalls, 8);
  assert.equal(retried.stats().retries, 1);

  // The retried 429 is a genuine Nansen call and a "failed" outcome; the
  // final attempt is a genuine, successful call.
  assert.equal(tracked.current.successful, 1);
  assert.equal(tracked.current.failed, 1);
  assert.equal(tracked.current.successful + tracked.current.failed, callBudgeted.usage().calls);
  assert.equal(tracked.current.calls, 2);

  const usage = await readUsage({ usagePath });
  assert.equal(usage.cumulativeRealNansenApiCalls, 2);
});

test("cache hits never consume the run cap", async () => {
  let fetches = 0;
  const { cached, tracked, callBudgeted } = await createChain({
    callLimit: 2,
    fetchImpl: async () => {
      fetches += 1;
      return fakeResponse(200, okBody(fetches));
    },
  });

  const body = { token_address: "0xaaa" };
  for (let index = 0; index < 5; index += 1) {
    await cached.post("/api/v1/token-screener", body);
  }
  assert.equal(fetches, 1);
  assert.equal(cached.current.hits, 4);
  assert.equal(callBudgeted.usage().calls, 1);
  assert.equal(callBudgeted.usage().remainingCalls, 1);

  // A distinct request still uses the remaining slot.
  await cached.post("/api/v1/token-screener", { token_address: "0xbbb" });
  assert.equal(fetches, 2);
  assert.equal(callBudgeted.usage().calls, 2);

  // The cap still holds after the cache hits.
  await assert.rejects(
    cached.post("/api/v1/token-screener", { token_address: "0xccc" }),
    (error) => error instanceof CallBudgetExceededError,
  );
  assert.equal(fetches, 2);
  assert.equal(tracked.current.calls, 2);
});

test("a credit-budget rejection never consumes the call cap", async () => {
  let fetches = 0;
  const { cached, tracked, callBudgeted, budgeted } = await createChain({
    callLimit: 25,
    creditCap: 10, // campaign screener cost is 1 credit -> 10 requests affordable
    fetchImpl: async () => {
      fetches += 1;
      return fakeResponse(200, okBody(fetches));
    },
  });

  for (let index = 0; index < 10; index += 1) {
    await cached.post("/api/v1/token-screener", { token_address: `0x${index}` });
  }
  assert.equal(budgeted.usage().reservedCredits, 10);

  await assert.rejects(
    cached.post("/api/v1/token-screener", { token_address: "0xoverflow" }),
    (error) => error instanceof CreditBudgetExceededError,
  );

  // Refused before the call guard: no fetch, no cap consumption.
  assert.equal(fetches, 10);
  assert.equal(callBudgeted.usage().calls, 10);
  assert.equal(callBudgeted.usage().remainingCalls, 15);
  assert.equal(tracked.current.calls, 10);
});

test("a transport failure consumes the cap but is not counted as genuine usage", async () => {
  const { cached, tracked, callBudgeted, usagePath } = await createChain({
    callLimit: 5,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:9");
    },
  });

  await assert.rejects(
    cached.post("/api/v1/token-screener", { token_address: "0xdead" }),
    /could not be sent/,
  );

  // The attempt was counted against the cap (it may have reached Nansen) ...
  assert.equal(callBudgeted.usage().calls, 1);
  assert.equal(callBudgeted.usage().remainingCalls, 4);
  assert.equal(tracked.current.attempts, 1);
  assert.equal(tracked.current.failed, 1);
  // ... but it was not a genuine call received by Nansen.
  assert.equal(tracked.current.successful, 0);
  assert.equal(tracked.current.calls, 0);
  assert.equal(tracked.current.transportFailures, 1);
  // sent = successful + failed still holds.
  assert.equal(tracked.current.successful + tracked.current.failed, callBudgeted.usage().calls);

  const usage = await readUsage({ usagePath });
  assert.equal(usage.cumulativeRealNansenApiCalls, 0);
});
