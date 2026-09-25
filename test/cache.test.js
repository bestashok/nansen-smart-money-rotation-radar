import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCachedNansenClient } from "../src/server/cache.js";

test("cache returns repeated requests without another live call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-cache-"));
  const cachePath = path.join(directory, "cache.json");
  let calls = 0;
  const live = {
    async post(endpoint) {
      calls += 1;
      return { data: { value: 42 }, meta: { endpoint, status: 200 } };
    },
  };
  const cached = createCachedNansenClient(live, { cachePath, ttlMinutes: 15, now: () => 1_000 });

  const first = await cached.post("/endpoint", { chain: "ethereum" });
  const second = await cached.post("/endpoint", { chain: "ethereum" });

  assert.equal(calls, 1);
  assert.equal(first.meta.source, "LIVE");
  assert.equal(second.meta.source, "CACHED");
  assert.deepEqual(cached.current, { hits: 1, misses: 1, persistFailures: 0 });
  assert.equal(JSON.parse(await readFile(cachePath, "utf8")).version, 1);
});

test("a failed ledger write never fails the request and dedup still works in memory", async () => {
  // Reproduces the Windows EPERM rename failure that silently dropped ~100
  // responses from data/cache.json: the response must still reach the caller
  // (the call was already made and counted), and the session must keep
  // deduplicating from memory even though the file could not be rewritten.
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-cache-persist-"));
  const cachePath = path.join(directory, "target"); // a directory: the final rename cannot succeed
  await mkdir(cachePath, { recursive: true });
  let calls = 0;
  const cached = createCachedNansenClient({
    async post() {
      calls += 1;
      return { data: { data: [] }, meta: { status: 200 } };
    },
  }, { cachePath, now: () => 1_000, renameAttempts: 2, renameDelayMs: 1 });

  const first = await cached.post("/endpoint", { chain: "base" });
  assert.equal(first.meta.source, "LIVE", "a persist failure must not fail the response");
  assert.equal(cached.current.persistFailures, 1);

  const second = await cached.post("/endpoint", { chain: "base" });
  assert.equal(calls, 1, "the in-memory entry must still dedup this session");
  assert.equal(second.meta.source, "CACHED");
});

test("cache treats equivalent rolling date windows as the same request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-cache-window-"));
  let calls = 0;
  const cached = createCachedNansenClient({
    async post(endpoint) {
      calls += 1;
      return { data: { ok: true }, meta: { endpoint, status: 200 } };
    },
  }, { cachePath: path.join(directory, "cache.json"), now: () => 1_000 });

  await cached.post("/endpoint", { date: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" } });
  await cached.post("/endpoint", { date: { from: "2026-01-01T00:01:00.000Z", to: "2026-01-08T00:01:00.000Z" } });

  assert.equal(calls, 1);
});
