import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMPAIGN_CREDIT_CAP,
  CAMPAIGN_CREDIT_COSTS,
  FREE_PLAN_COSTS,
  withCreditBudget,
} from "../src/server/creditBudget.js";

test("credit budget refuses calls that could exceed 100 free-plan credits", async () => {
  const client = withCreditBudget({
    async post() { return { data: {}, meta: { status: 200 } }; },
  }, 100);

  for (let index = 0; index < 10; index += 1) {
    await client.post("/api/v1/token-screener", {});
  }
  await assert.rejects(
    client.post("/api/v1/token-screener", {}),
    /would exceed 100/,
  );
  assert.equal(client.usage().reservedCredits, 100);
  assert.equal(client.usage().remainingCredits, 0);
  assert.equal(client.usage().calls.length, 10);
});

test("credit budget validates user-selected limits", () => {
  assert.throws(() => withCreditBudget({ post() {} }, 9), /at least 10/);
  assert.throws(() => withCreditBudget({ post() {} }, 10.5), /whole number/);
});

test("campaign credit costs mirror Nansen's real 1- and 5-credit charges under the 875 cap", async () => {
  assert.equal(CAMPAIGN_CREDIT_CAP, 875);
  assert.equal(CAMPAIGN_CREDIT_COSTS["/api/v1/token-screener"], 1);
  assert.equal(CAMPAIGN_CREDIT_COSTS["/api/v1/tgm/who-bought-sold"], 1);
  assert.equal(CAMPAIGN_CREDIT_COSTS["/api/v1/tgm/flow-intelligence"], 1);
  assert.equal(CAMPAIGN_CREDIT_COSTS["/api/v1/tgm/flows"], 1);
  assert.equal(CAMPAIGN_CREDIT_COSTS["/api/v1/tgm/holders"], 5);
  // The conservative free-plan estimates used by /api/scan stay untouched.
  assert.equal(FREE_PLAN_COSTS["/api/v1/token-screener"], 10);
  assert.equal(FREE_PLAN_COSTS["/api/v1/tgm/holders"], 50);

  const client = withCreditBudget({
    async post() { return { data: {}, meta: { status: 200 } }; },
  }, CAMPAIGN_CREDIT_CAP, { costs: CAMPAIGN_CREDIT_COSTS });

  await client.post("/api/v1/token-screener", {});
  await client.post("/api/v1/tgm/holders", {});
  assert.equal(client.usage().reservedCredits, 6);
  assert.equal(client.usage().limit, 875);
  assert.equal(client.usage().remainingCredits, 869);

  // A 5-credit holders request is refused once only 4 credits remain.
  const nearlyFull = withCreditBudget({
    async post() { return { data: {}, meta: { status: 200 } }; },
  }, 10, { costs: CAMPAIGN_CREDIT_COSTS });
  await nearlyFull.post("/api/v1/tgm/holders", {});
  await nearlyFull.post("/api/v1/tgm/holders", {});
  await assert.rejects(
    () => nearlyFull.post("/api/v1/tgm/holders", {}),
    /would exceed 10/,
  );
  assert.equal(nearlyFull.usage().reservedCredits, 10);
  assert.equal(nearlyFull.usage().calls.length, 2);
});
