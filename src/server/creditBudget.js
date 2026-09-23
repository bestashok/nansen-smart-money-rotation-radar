export const FREE_PLAN_COSTS = Object.freeze({
  "/api/v1/token-screener": 10,
  "/api/v1/tgm/who-bought-sold": 10,
  "/api/v1/tgm/flow-intelligence": 10,
  "/api/v1/tgm/flows": 10,
  "/api/v1/tgm/holders": 50,
});

export class CreditBudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CreditBudgetExceededError";
    this.code = "CREDIT_BUDGET_EXCEEDED";
    this.limit = details.limit ?? null;
    this.reservedCredits = details.reservedCredits ?? null;
    this.requestedCredits = details.requestedCredits ?? null;
  }
}

export function creditCostFor(endpoint) {
  const cost = FREE_PLAN_COSTS[endpoint];
  if (!cost) throw new Error(`No conservative credit cost configured for ${endpoint}`);
  return cost;
}

export function withCreditBudget(nansenClient, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 10) {
    throw new TypeError("Credit limit must be a whole number of at least 10.");
  }
  let reservedCredits = 0;
  const calls = [];

  return {
    async post(endpoint, body) {
      const cost = creditCostFor(endpoint);
      if (reservedCredits + cost > limit) {
        throw new CreditBudgetExceededError(
          `Credit budget stopped request: ${reservedCredits} + ${cost} would exceed ${limit}.`,
          { limit, reservedCredits, requestedCredits: cost },
        );
      }
      reservedCredits += cost;
      try {
        const result = await nansenClient.post(endpoint, body);
        calls.push({ endpoint, reservedCredits: cost, status: result.meta.status });
        return result;
      } catch (error) {
        calls.push({ endpoint, reservedCredits: cost, status: error.status ?? null });
        throw error;
      }
    },
    canAfford(credits) {
      return Number.isFinite(credits) && credits >= 0 && reservedCredits + credits <= limit;
    },
    usage() {
      return { limit, reservedCredits, remainingCredits: limit - reservedCredits, calls: [...calls] };
    },
  };
}
