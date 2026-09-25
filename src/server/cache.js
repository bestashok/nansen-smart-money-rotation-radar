import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MINUTES = 15;

// Windows can transiently refuse the final rename of the atomic write while
// an antivirus, indexer or editor holds the file (observed as EPERM on
// data/cache.json.tmp -> data/cache.json, which silently dropped responses
// from the ledger). Retry the rename before giving up.
const RENAME_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
const DEFAULT_RENAME_ATTEMPTS = 8;
const DEFAULT_RENAME_DELAY_MS = 100;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function cacheableBody(body) {
  const normalized = structuredClone(body);
  if (normalized?.date?.from && normalized?.date?.to) {
    const from = Date.parse(normalized.date.from);
    const to = Date.parse(normalized.date.to);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      normalized.date = { windowMs: to - from };
    }
  }
  return normalized;
}

function cacheKey(endpoint, body) {
  return createHash("sha256")
    .update(`${endpoint}\n${JSON.stringify(stableValue(cacheableBody(body)))}`)
    .digest("hex");
}

// Public alias: the ledger-repair tool must hash reconstructed bodies with
// exactly the same function the cache uses, so the repaired key lands on the
// same entry the campaign will inspect.
export function cacheKeyOf(endpoint, body) {
  return cacheKey(endpoint, body);
}

// Atomic rename with retries for the transient Windows failures above.
export async function renameWithRetry(from, to, {
  attempts = DEFAULT_RENAME_ATTEMPTS,
  delayMs = DEFAULT_RENAME_DELAY_MS,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!RENAME_RETRYABLE.has(error.code) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function validTtlMinutes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MINUTES;
}

export function createCachedNansenClient(client, {
  cachePath = path.resolve("data/cache.json"),
  ttlMinutes = process.env.CACHE_TTL_MINUTES,
  now = () => Date.now(),
  renameAttempts = DEFAULT_RENAME_ATTEMPTS,
  renameDelayMs = DEFAULT_RENAME_DELAY_MS,
} = {}) {
  const ttlMs = validTtlMinutes(ttlMinutes) * 60_000;
  let cachePromise;
  let writeQueue = Promise.resolve();
  const current = { hits: 0, misses: 0, persistFailures: 0 };

  async function loadCache() {
    if (!cachePromise) {
      cachePromise = readFile(cachePath, "utf8")
        .then((content) => JSON.parse(content))
        .catch(() => ({ version: 1, entries: {} }));
    }
    const cache = await cachePromise;
    if (!cache.entries || typeof cache.entries !== "object") cache.entries = {};
    return cache;
  }

  async function persist(cache) {
    const temporaryPath = `${cachePath}.tmp`;
    // A ledger write failure must never fail the caller: the response was
    // already received, the call was already counted, and the in-memory
    // entry still deduplicates this session. The rename is retried first
    // (renameWithRetry); only a persistent failure is counted here.
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(cachePath), { recursive: true });
      // Compact JSON: the ledger is hash-keyed machine data that grows past
      // a megabyte, and it is fully rewritten after every response — the
      // compact form keeps both the live run and tests from spending seconds
      // per hundred calls serializing indentation.
      await writeFile(temporaryPath, JSON.stringify(cache));
      await renameWithRetry(temporaryPath, cachePath, { attempts: renameAttempts, delayMs: renameDelayMs });
    }).catch((error) => {
      current.persistFailures += 1;
      console.warn(`[cache] could not persist ${cachePath}: ${error.message}`);
    });
    return writeQueue;
  }

  return {
    current,
    // Read-only lookup used for cross-cycle deduplication: returns what the
    // request ledger knows about this exact request (date windows normalized
    // the same way as cache keys) even when the entry is too old to serve.
    // This is how the campaign avoids repeating requests it already made.
    // `dataLost: true` marks a repaired entry: the request WAS sent, but its
    // response body was lost to a ledger write failure, so records are unknown.
    async inspect(endpoint, body) {
      const cache = await loadCache();
      const entry = cache.entries[cacheKey(endpoint, body)];
      if (!entry) return null;
      const data = entry.data ?? null;
      return {
        endpoint: entry.endpoint ?? endpoint,
        createdAt: entry.createdAt ?? null,
        data,
        dataLost: entry.dataLost === true,
        records: Array.isArray(data?.data) ? data.data : [],
        pagination: data?.pagination ?? null,
        meta: entry.meta ?? null,
      };
    },
    async post(endpoint, body) {
      const cache = await loadCache();
      const key = cacheKey(endpoint, body);
      const entry = cache.entries[key];
      const timestamp = now();

      if (entry && entry.expiresAt > timestamp) {
        current.hits += 1;
        return {
          data: structuredClone(entry.data),
          meta: { ...entry.meta, source: "CACHED" },
        };
      }

      current.misses += 1;
      const result = await client.post(endpoint, body);
      // Full replacement: a repaired (dataLost) entry self-heals into a
      // normal entry as soon as some path fetches the response again.
      cache.entries[key] = {
        endpoint,
        createdAt: timestamp,
        expiresAt: timestamp + ttlMs,
        data: result.data,
        meta: {
          endpoint: result.meta?.endpoint ?? endpoint,
          status: result.meta?.status ?? 200,
        },
      };
      await persist(cache);
      return {
        ...result,
        meta: { ...result.meta, source: "LIVE" },
      };
    },
  };
}
