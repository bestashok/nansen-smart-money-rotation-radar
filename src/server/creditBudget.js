const FREE_PLAN_COSTS = Object.freeze({
  "/api/v1/token-screener": 10,
  "/api/v1/tgm/who-bought-sold": 10,
});

export function withCreditBudget(nansenClient, limit = 100) {
  let reservedCredits = 0;
  const calls = [];

  return {
    async post(endpoint, body) {
      const cost = FREE_PLAN_COSTS[endpoint];
      if (!cost) throw new Error(`No conservative credit cost configured for ${endpoint}`);
      if (reservedCredits + cost > limit) {
        throw new Error(
          `Credit budget stopped request: ${reservedCredits} + ${cost} would exceed ${limit}.`,
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
    usage() {
      return { limit, reservedCredits, calls: [...calls] };
    },
  };
}
