export class CallBudgetExceededError extends Error {
  constructor(limit) {
    super(`API call target guard stopped the request at ${limit} remaining call(s).`);
    this.name = "CallBudgetExceededError";
    this.code = "API_CALL_TARGET_REACHED";
    this.limit = limit;
  }
}

export function withCallBudget(client, limit, { onSend } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Call budget must be a positive whole number.");
  }
  let calls = 0;
  return {
    // Every call that reaches this layer is one real outbound HTTP attempt
    // (retry attempts included). Once the limit is reached the request is
    // refused BEFORE it can be sent, so request limit+1 can never go out.
    async post(endpoint, body) {
      if (calls >= limit) throw new CallBudgetExceededError(limit);
      calls += 1;
      onSend?.({ calls, limit, endpoint });
      return client.post(endpoint, body);
    },
    usage() {
      return { limit, calls, remainingCalls: limit - calls };
    },
  };
}// Cumulative source-of-truth guard. `cumulativeRealCalls` is the number of
  // genuine Nansen API calls already received by the account (as reported by
  // the persistent usage ledger). This wrapper stops the run BEFORE sending
  // request N + 1 once the account has received exactly 1,000 genuine calls:
  // the 1,000th call is the last one that may be sent, then the run stops.
  // It never double-counts a cache hit or a ledger-reused request, so the cap
  // binds only on real outbound calls. A 0 or null cumulative value means the
  // account has not been polled yet and the older 1,000-call buildathon cap
  // (909 + 91 = 1,000) remains the binding rule.
  export function withCumulativeCap(client, { onSend, cumulativeRealCalls = null } = {}) {
  const allTimeCap = 1000;
  const remainingAtStart = cumulativeRealCalls == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, allTimeCap - cumulativeRealCalls);
  let calls = 0;

  const current = { calls };
  return {
    current,
    usage() {
      return {
        allTimeCap,
        cumulativeRealCalls: cumulativeRealCalls ?? null,
        remainingCalls: Math.max(0, remainingAtStart - calls),
        callssofar: calls,
      };
    },
    async post(endpoint, body) {
      if (calls >= remainingAtStart) {
        throw new CallBudgetExceededError(remainingAtStart);
      }
      calls += 1;
      onSend?.({ calls, limit: remainingAtStart, endpoint });
      return client.post(endpoint, body);
    },
  };
}
