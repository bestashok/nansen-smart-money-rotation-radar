export function configuredConcurrency(value = process.env.NANSEN_CONCURRENCY) {
  const parsed = Number.parseInt(value ?? "10", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
}

export async function mapWithConcurrency(items, worker, options = {}) {
  const concurrency = Math.min(
    configuredConcurrency(options.concurrency),
    Math.max(items.length, 1),
  );
  const results = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let maximumActive = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      } finally {
        active -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

  return {
    results,
    maximumConcurrentRequests: maximumActive,
    configuredConcurrency: concurrency,
  };
}
