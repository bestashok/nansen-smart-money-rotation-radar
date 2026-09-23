import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readUsage, trackNansenUsage } from "../src/server/apiUsage.js";

test("concurrent live requests are all persisted without lost increments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-usage-"));
  const usagePath = path.join(directory, "usage.json");
  const tracked = trackNansenUsage({
    async post(endpoint) {
      return { data: { data: [] }, meta: { endpoint, status: 200 } };
    },
  }, { usagePath });

  await Promise.all(Array.from({ length: 20 }, () => tracked.post("/endpoint", {})));
  const usage = await readUsage({ usagePath });

  assert.equal(tracked.current.calls, 20);
  assert.equal(usage.cumulativeRealNansenApiCalls, 20);
  assert.equal(usage.calls.length, 20);
});

test("transport failures do not count as genuine Nansen API calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-usage-"));
  const usagePath = path.join(directory, "usage.json");
  const tracked = trackNansenUsage({
    async post() {
      throw new Error("fetch failed");
    },
  }, { usagePath });

  await assert.rejects(() => tracked.post("/endpoint", {}), /fetch failed/);
  const usage = await readUsage({ usagePath });

  assert.equal(tracked.current.attempts, 1);
  assert.equal(tracked.current.calls, 0);
  assert.equal(tracked.current.transportFailures, 1);
  assert.equal(usage.cumulativeRealNansenApiCalls, 0);
  assert.equal(usage.calls.length, 0);
});

test("HTTP error responses still count as calls received by Nansen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-usage-"));
  const usagePath = path.join(directory, "usage.json");
  const tracked = trackNansenUsage({
    async post() {
      const error = new Error("service unavailable");
      error.status = 503;
      throw error;
    },
  }, { usagePath });

  await assert.rejects(() => tracked.post("/endpoint", {}), /service unavailable/);
  const usage = await readUsage({ usagePath });

  assert.equal(tracked.current.calls, 1);
  assert.equal(tracked.current.transportFailures, 0);
  assert.equal(usage.cumulativeRealNansenApiCalls, 1);
  assert.equal(usage.calls[0].status, 503);
});
