export const FREE_PLAN_COSTS = Object.freeze({
  "/api/v1/token-screener": 10,
  "/api/v1/tgm/who-bought-sold": 10,
  "/api/v1/tgm/flow-intelligence": 10,
  "/api/v1/tgm/flows": 10,
  "/api/v1/tgm/holders": 50,
});

// Actual per-request credit costs observed in Nansen's own
// `x-nansen-credits-used` response headers across live runs (91 recorded
// responses): 1 credit for screener/who-bought-sold/flow-intelligence/flows,
// 5 credits for holders. Used only by the Live Scan 2 campaign so its
// credit guard reflects reality instead of the conservative scan estimates.
export const CAMPAIGN_CREDIT_COSTS = Object.freeze({
  "/api/v1/token-screener": 1,
  "/api/v1/tgm/who-bought-sold": 1,
  "/api/v1/tgm/flow-intelligence": 1,
  "/api/v1/tgm/flows": 1,
  "/api/v1/tgm/holders": 5,
});

// Hard credit ceiling for a single Live Scan 2 run. With 879 credits in the
// account this guarantees at least 4 credits stay unused even if every
// possible request is sent.
export const CAMPAIGN_CREDIT_CAP = 875;

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

export function creditCostFor(endpoint, costs = FREE_PLAN_COSTS) {
  const cost = costs[endpoint];
  if (!cost) throw new Error(`No conservative credit cost configured for ${endpoint}`);
  return cost;
}

export function withCreditBudget(nansenClient, limit = 100, { costs = FREE_PLAN_COSTS } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 10) {
    throw new TypeError("Credit limit must be a whole number of at least 10.");
  }
  let reservedCredits = 0;
  const calls = [];

  return {
    async post(endpoint, body) {
      const cost = creditCostFor(endpoint, costs);
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
