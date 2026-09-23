function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function withRateLimitRetries(client, {
  maxRetries = process.env.NANSEN_MAX_RETRIES,
  baseDelayMs = process.env.NANSEN_RETRY_BASE_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const retryLimit = positiveInteger(maxRetries, 3);
  const baseDelay = positiveInteger(baseDelayMs, 500);

  return {
    async post(endpoint, body) {
      let retries = 0;
      while (true) {
        try {
          return await client.post(endpoint, body);
        } catch (error) {
          if (error?.status !== 429 || retries >= retryLimit) throw error;
          const delay = Number.isFinite(error.retryAfterMs)
            ? Math.max(0, error.retryAfterMs)
            : baseDelay * (2 ** retries);
          retries += 1;
          await sleep(delay);
        }
      }
    },
  };
}
