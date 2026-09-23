import assert from "node:assert/strict";
import test from "node:test";
import { configuredConcurrency, mapWithConcurrency } from "../src/server/concurrency.js";

test("configured concurrency defaults to 10 and rejects invalid values", () => {
  assert.equal(configuredConcurrency(undefined), 10);
  assert.equal(configuredConcurrency("5"), 5);
  assert.equal(configuredConcurrency("0"), 10);
  assert.equal(configuredConcurrency("invalid"), 10);
});

test("worker pool preserves order and never exceeds its limit", async () => {
  let active = 0;
  let observedMaximum = 0;
  const pool = await mapWithConcurrency(
    [1, 2, 3, 4, 5, 6],
    async (value) => {
      active += 1;
      observedMaximum = Math.max(observedMaximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value * 2;
    },
    { concurrency: 3 },
  );

  assert.equal(observedMaximum, 3);
  assert.equal(pool.maximumConcurrentRequests, 3);
  assert.deepEqual(pool.results.map((result) => result.value), [2, 4, 6, 8, 10, 12]);
});

test("one failed item does not stop remaining work", async () => {
  const pool = await mapWithConcurrency([1, 2, 3], async (value) => {
    if (value === 2) throw new Error("expected failure");
    return value;
  });

  assert.equal(pool.results[0].status, "fulfilled");
  assert.equal(pool.results[1].status, "rejected");
  assert.equal(pool.results[2].status, "fulfilled");
});
