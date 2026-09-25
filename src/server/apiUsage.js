import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const defaultUsagePath = path.resolve("data/api-usage.json");
let usageWriteQueue = Promise.resolve();

// A ledger that has never been written is genuinely zero calls. A ledger that
// cannot be read or parsed is UNKNOWN, and must never be reported as 0: the
// 1,000-call all-time guard in app.js reads this number to decide how many
// requests it may still send, so collapsing "unknown" into "0" re-opens the
// entire budget. That defect caused the 2026-09-25 overshoot to 1,011 calls
// (see docs/POSTMORTEM.md). An unknown ledger is now surfaced as
// `cumulativeRealNansenApiCalls: null` + `ledgerUnreadable: true`, and every
// hard-cap consumer treats that as zero remaining, i.e. fails closed.
const LEDGER_READ_ATTEMPTS = 5;
const LEDGER_READ_BACKOFF_MS = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadUsage(usagePath) {
  let lastError = null;
  for (let attempt = 0; attempt < LEDGER_READ_ATTEMPTS; attempt += 1) {
    let raw;
    try {
      raw = await readFile(usagePath, "utf8");
    } catch (error) {
      // No file yet is a real, trustworthy zero - nothing has been sent.
      if (error?.code === "ENOENT") {
        return { cumulativeRealNansenApiCalls: 0, calls: [] };
      }
      // Locked / permission / transient I/O: usually clears within a few ms
      // on Windows, so retry before declaring the count unknown.
      lastError = error;
      if (attempt < LEDGER_READ_ATTEMPTS - 1) await sleep(LEDGER_READ_BACKOFF_MS);
      continue;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (attempt < LEDGER_READ_ATTEMPTS - 1) await sleep(LEDGER_READ_BACKOFF_MS);
    }
  }
  return {
    cumulativeRealNansenApiCalls: null,
    calls: [],
    ledgerUnreadable: true,
    ledgerError: lastError?.message ?? "unreadable",
  };
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
    // Refuse to write rather than corrupt: `null + 1` would silently reset the
    // cumulative counter to 1 and destroy the accounting the hard cap relies
    // on. The call was still made, so the safe outcome is to fail loudly.
    if (usage.ledgerUnreadable || !Number.isSafeInteger(usage.cumulativeRealNansenApiCalls)) {
      throw new Error(
        `Refusing to record a Nansen call: the usage ledger at ${usagePath} could not be read (${usage.ledgerError ?? "unknown count"}). Writing now would reset the cumulative counter.`,
      );
    }
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
  // Wait for pending writes, but do not let a failed write poison this read:
  // a rejected queue would break every status endpoint. loadUsage reports an
  // unreadable ledger via `ledgerUnreadable`, which callers fail closed on.
  await usageWriteQueue.catch(() => {});
  return loadUsage(usagePath);
}
