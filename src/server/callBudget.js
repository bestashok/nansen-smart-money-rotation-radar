export class CallBudgetExceededError extends Error {
  constructor(limit) {
    super(`API call target guard stopped the request at ${limit} remaining call(s).`);
    this.name = "CallBudgetExceededError";
    this.code = "API_CALL_TARGET_REACHED";
    this.limit = limit;
  }
}

export function withCallBudget(client, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Call budget must be a positive whole number.");
  }
  let calls = 0;
  return {
    async post(endpoint, body) {
      if (calls >= limit) throw new CallBudgetExceededError(limit);
      calls += 1;
      return client.post(endpoint, body);
    },
    usage() {
      return { limit, calls, remainingCalls: limit - calls };
    },
  };
}
