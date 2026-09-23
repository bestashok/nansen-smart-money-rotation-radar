import assert from "node:assert/strict";
import test from "node:test";
import { withRateLimitRetries } from "../src/server/retry.js";

test("429 retries use Retry-After and eventually return", async () => {
  let calls = 0;
  const delays = [];
  const client = withRateLimitRetries({
    async post() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("limited"), { status: 429, retryAfterMs: 25 });
      return { data: { ok: true }, meta: { status: 200 } };
    },
  }, { maxRetries: 3, sleep: async (delay) => delays.push(delay) });

  const result = await client.post("/endpoint", {});
  assert.equal(result.data.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [25, 25]);
});

test("429 retry count is bounded", async () => {
  let calls = 0;
  const client = withRateLimitRetries({
    async post() {
      calls += 1;
      throw Object.assign(new Error("limited"), { status: 429 });
    },
  }, { maxRetries: 2, baseDelayMs: 10, sleep: async () => {} });

  await assert.rejects(client.post("/endpoint", {}), /limited/);
  assert.equal(calls, 3);
});
