import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MINUTES = 15;

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

function validTtlMinutes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MINUTES;
}

export function createCachedNansenClient(client, {
  cachePath = path.resolve("data/cache.json"),
  ttlMinutes = process.env.CACHE_TTL_MINUTES,
  now = () => Date.now(),
} = {}) {
  const ttlMs = validTtlMinutes(ttlMinutes) * 60_000;
  let cachePromise;
  let writeQueue = Promise.resolve();
  const current = { hits: 0, misses: 0 };

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
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(cache, null, 2));
      await rename(temporaryPath, cachePath);
    });
    return writeQueue;
  }

  return {
    current,
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
