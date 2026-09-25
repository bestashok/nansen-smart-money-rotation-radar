import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const defaultUsagePath = path.resolve("data/api-usage.json");
let usageWriteQueue = Promise.resolve();

// KNOWN DEFECT: on a read/parse failure this returns 0, not null/undefined.
// Callers cannot distinguish "no calls yet" from "ledger unreadable", and the
// 1,000-call all-time guard in app.js does `?? null`, which does not catch 0.
// An unreadable ledger therefore re-opens the full 1,000-call budget. This
// caused the 2026-09-25 overshoot to 1,011 calls. Correct fix: fail closed.
// See docs/POSTMORTEM.md. Left unfixed on purpose; no calls were made after.
async function loadUsage(usagePath) {
  try {
    return JSON.parse(await readFile(usagePath, "utf8"));
  } catch {
    return { cumulativeRealNansenApiCalls: 0, calls: [] };
  }
}

// Persist the latest raw balance immediately on every successful live
// response, so the ledger's latest creditsRemaining is always the Nansen
// API's most-recent report. A later call that consumed credits overwrites
// the balance while keeping the raw value (no double-subtraction: the
// reservation counter is separate from this raw balance field).
// Serializes every read-modify-write of the usage ledger. The task must be
// chained off the *current* queue with .then(): an async IIFE here would start
// immediately and ignore the pending write, letting two callers race on the
// same api-usage.json.tmp (ENOENT on rename) and drop increments.
export async function appendUsage(usagePath, entry) {
  const queued = usageWriteQueue.catch(() => {}).then(async () => {
    const usage = await loadUsage(usagePath);
    usage.cumulativeRealNansenApiCalls += 1;
    usage.calls.push(entry);
    // Keep only the last 1000 calls to bound file size.
    usage.calls = usage.calls.slice(-1000);
    await mkdir(path.dirname(usagePath), { recursive: true });
    const temporaryPath = `${usagePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(usage, null, 2));
    await rename(temporaryPath, usagePath);
  });
  usageWriteQueue = queued;
  return queued;
}

export function trackNansenUsage(client, { usagePath = defaultUsagePath } = {}) {
  const current = {
    calls: 0,
    attempts: 0,
    successful: 0,
    failed: 0,
    transportFailures: 0,
    latencies: [],
    rateLimitEvents: 0,
  };
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
        if (success) current.successful += 1;
        else current.failed += 1;
        current.latencies.push(latency);
        if (status === null || status === undefined) {
          current.transportFailures += 1;
        } else {
          current.calls += 1;
          await appendUsage(usagePath, {
            timestamp: new Date().toISOString(),
            endpoint,
            status,
            latencyMs: latency,
            success,
            creditsUsed: meta?.creditsUsed ?? meta?.creditsCost ?? null,
            creditsRemaining: meta?.creditsRemaining ?? null,
          });
        }
      }
    },
  };
}

export async function readUsage({ usagePath = defaultUsagePath } = {}) {
  await usageWriteQueue;
  return loadUsage(usagePath);
}
