import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const usagePath = path.resolve("data/api-usage.json");

async function readUsage() {
  try { return JSON.parse(await readFile(usagePath, "utf8")); }
  catch { return { cumulativeRealNansenApiCalls: 0, calls: [] }; }
}

export function trackNansenUsage(client) {
  const current = { calls: 0, latencies: [], rateLimitEvents: 0 };
  return {
    current,
    async post(endpoint, body) {
      const startedAt = performance.now();
      let status = null;
      let success = false;
      let meta = null;
      try {
        const result = await client.post(endpoint, body);
        status = result.meta.status;
        meta = result.meta;
        success = true;
        return result;
      } catch (error) {
        status = error.status;
        if (status === 429) current.rateLimitEvents += 1;
        throw error;
      } finally {
        const latency = performance.now() - startedAt;
        current.calls += 1;
        current.latencies.push(latency);
        const usage = await readUsage();
        usage.cumulativeRealNansenApiCalls += 1;
        usage.calls.push({ timestamp: new Date().toISOString(), endpoint, status, latencyMs: latency, success, creditsUsed: meta?.creditsUsed ?? meta?.creditsCost ?? null });
        usage.calls = usage.calls.slice(-1000);
        await mkdir(path.dirname(usagePath), { recursive: true });
        await writeFile(usagePath, JSON.stringify(usage, null, 2));
      }
    },
  };
}

export { readUsage };
