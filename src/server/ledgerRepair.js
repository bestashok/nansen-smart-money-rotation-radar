import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKeyOf, renameWithRetry } from "./cache.js";
import { RESEARCH_ENDPOINTS } from "./researchGate.js";
import { researchBodyFor } from "./eligibilityCampaign.js";

// A ledger-write failure signature: the request DID reach Nansen (the call is
// recorded in data/api-usage.json) but the atomic cache rename failed and the
// response body was lost. Those requests must count as "already made" —
// without this repair the next cycle would silently repeat every one of them.
const LOST_RESPONSE_PATTERN = /EPERM|ENOTEMPTY|EBUSY|EACCES/;
const LOST_RESPONSE_CONTEXT = /rename|cache\.json\.tmp/;

function isLostResponse(failure) {
  const message = failure?.message ?? "";
  return LOST_RESPONSE_PATTERN.test(message) && LOST_RESPONSE_CONTEXT.test(message);
}

/**
 * Rebuild the exact request body for a recorded failure. The body comes from
 * the same `researchBodyFor` the planner uses, so its cache key always equals
 * the key of the request that was actually sent (and date windows normalize
 * to window lengths, so the run's timestamp cannot skew the key).
 *
 * Returns null when the failure cannot be tied to a concrete request.
 */
export function reconstructLostRequest(failure, group, run) {
  const token = group?.token;
  const kind = failure?.kind;
  if (!token?.chain || !token?.contractAddress || !RESEARCH_ENDPOINTS[kind]) return null;
  const startedAt = Date.parse(run?.campaignStartedAt ?? "");
  const now = Number.isFinite(startedAt) ? new Date(startedAt) : new Date();
  const endpoint = RESEARCH_ENDPOINTS[kind];
  const body = researchBodyFor(token, now, {
    kind,
    windowDays: failure.windowDays ?? 0,
    page: failure.page ?? 1,
  });
  return { endpoint, body, key: cacheKeyOf(endpoint, body) };
}

/**
 * Restore dedup-ledger entries for requests whose responses were lost to a
 * ledger write failure, without ever touching entries that already exist
 * (an existing entry holds the real response body, which is strictly better
 * than a repaired marker).
 *
 * Repaired entries are marked `dataLost: true` with an already-expired TTL:
 * the campaign will never re-send them (dedup), never serve them as fresh
 * data (post()), and will continue pagination one page deeper instead of
 * trusting an unknown record count.
 *
 * Idempotent: running it twice repairs nothing the second time.
 */
export async function repairLostLedgerEntries(history = [], {
  cachePath = path.resolve("data/cache.json"),
} = {}) {
  let cache;
  try {
    cache = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    cache = { version: 1, entries: {} };
  }
  if (!cache.entries || typeof cache.entries !== "object") cache.entries = {};

  const report = {
    repaired: 0,
    skippedExisting: 0,
    skippedNotLost: 0,
    skippedUnreconstructable: 0,
    totalEntries: 0,
  };

  for (const run of history ?? []) {
    for (const group of run?.researchFailures ?? []) {
      for (const failure of group?.failures ?? []) {
        if (!isLostResponse(failure)) {
          // A genuine API failure (4xx/5xx/timeout): re-requesting that data
          // later is legitimate, so it must not be masked as "already sent".
          report.skippedNotLost += 1;
          continue;
        }
        const request = reconstructLostRequest(failure, group, run);
        if (!request) {
          report.skippedUnreconstructable += 1;
          continue;
        }
        if (cache.entries[request.key]) {
          report.skippedExisting += 1;
          continue;
        }
        const createdAt = Date.parse(run?.campaignStartedAt ?? "");
        cache.entries[request.key] = {
          endpoint: request.endpoint,
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
          expiresAt: 0, // never served as fresh data
          data: null, // the response body was lost
          dataLost: true, // sent: dedup must skip it, depth must continue past it
          meta: { status: 200, source: "REPAIRED_LEDGER" },
        };
        report.repaired += 1;
      }
    }
  }

  if (report.repaired > 0) {
    await mkdir(path.dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(cache)); // same compact form as cache.js
    await renameWithRetry(temporaryPath, cachePath);
  }
  report.totalEntries = Object.keys(cache.entries).length;
  return report;
}
