import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultUsagePath = path.resolve("data/api-usage.json");
let usageWriteQueue = Promise.resolve();

async function loadUsage(usagePath) {
  try { return JSON.parse(await readFile(usagePath, "utf8")); }
  catch { return { cumulativeRealNansenApiCalls: 0, calls: [] }; }
}

async function appendUsage(usagePath, entry) {
  usageWriteQueue = usageWriteQueue.catch(() => {}).then(async () => {
    const usage = await loadUsage(usagePath);
    usage.cumulativeRealNansenApiCalls += 1;
    usage.calls.push(entry);
    usage.calls = usage.calls.slice(-1000);
    await mkdir(path.dirname(usagePath), { recursive: true });
    const temporaryPath = `${usagePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(usage, null, 2));
    await rename(temporaryPath, usagePath);
  });
  return usageWriteQueue;
}

export function trackNansenUsage(client, { usagePath = defaultUsagePath } = {}) {
  const current = { calls: 0, attempts: 0, transportFailures: 0, latencies: [], rateLimitEvents: 0 };
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
        current.attempts += 1;
        current.latencies.push(latency);
        if (status === null || status === undefined) {
          current.transportFailures += 1;
        } else {
          current.calls += 1;
          await appendUsage(usagePath, { timestamp: new Date().toISOString(), endpoint, status, latencyMs: latency, success, creditsUsed: meta?.creditsUsed ?? meta?.creditsCost ?? null });
        }
      }
    },
  };
}

export async function readUsage({ usagePath = defaultUsagePath } = {}) {
  await usageWriteQueue;
  return loadUsage(usagePath);
}
