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
