const DEFAULT_BASE_URL = "https://api.nansen.ai";

export class NansenApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NansenApiError";
    this.endpoint = details.endpoint ?? null;
    this.status = details.status ?? null;
    this.response = details.response ?? null;
    this.category = details.category ?? "unknown";
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function classifyFailure(status, response) {
  const code = response?.code;
  if (status === 401 || code === "unauthenticated") return "authentication";
  if (status === 402 || code === "insufficient_credits") return "credits";
  if (status === 403 || code === "forbidden" || code === "plan_upgrade_required") {
    return "access_or_plan";
  }
  if (status === 422 || code === "unknown_field" || code === "invalid_field_value") {
    return "request_schema";
  }
  if (status === 429 || code === "rate_limit_exceeded") return "rate_limit";
  return status >= 500 ? "nansen_service" : "request";
}

export function createNansenClient({
  apiKey = process.env.NANSEN_API_KEY,
  baseUrl = process.env.NANSEN_BASE_URL ?? DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A Fetch-compatible implementation is required.");
  }

  async function post(endpoint, body) {
    if (!apiKey?.trim()) {
      throw new NansenApiError(
        "NANSEN_API_KEY is not configured. Add it to .env; never commit that file.",
        { endpoint, category: "configuration" },
      );
    }

    let response;
    try {
      response = await fetchImpl(new URL(endpoint, baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new NansenApiError(`Nansen request could not be sent: ${error.message}`, {
        endpoint,
        category: "transport",
      });
    }

    const rawBody = await response.text();
    let parsedBody;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = { raw: rawBody.slice(0, 2_000) };
    }

    if (!response.ok) {
      const usefulMessage = parsedBody?.message ?? parsedBody?.error ?? response.statusText;
      throw new NansenApiError(`Nansen request failed: ${usefulMessage}`, {
        endpoint,
        status: response.status,
        response: parsedBody,
        category: classifyFailure(response.status, parsedBody),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      });
    }

    return {
      data: parsedBody,
      meta: {
        endpoint,
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        creditsCost: response.headers.get("x-nansen-credits-cost"),
        creditsUsed: response.headers.get("x-nansen-credits-used"),
        creditsRemaining: response.headers.get("x-nansen-credits-remaining"),
        rateLimitSecond: response.headers.get("x-ratelimit-limit-second"),
        rateLimitMinute: response.headers.get("x-ratelimit-limit-minute"),
      },
    };
  }

  return { post };
}
