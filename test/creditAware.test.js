import assert from "node:assert/strict";
import test from "node:test";

import { runEligibilityCampaign, CREDIT_SAFETY_RESERVE, HOLDER_CREDIT_COST } from "../src/server/eligibilityCampaign.js";
import { withCallBudget } from "../src/server/callBudget.js";
import { CAMPAIGN_CREDIT_COSTS, withCreditBudget } from "../src/server/creditBudget.js";
import { TOKEN_SCREENER_ENDPOINT } from "../src/server/discovery.js";

const HOLDERS_ENDPOINT = "/api/v1/tgm/holders";

const NOW = new Date("2026-09-24T12:00:00Z");

function discovered(index) {
  return {
    token_symbol: `TOKEN${index}`,
    chain: "base",
    token_address: `0x${index.toString(16).padStart(40, "0")}`,
    market_cap_usd: 2_000_000,
    liquidity: 200_000,
    netflow: 50_000,
  };
}

function walletRecord(index) {
  return {
    address: `0x${index.toString(16).padStart(40, "1")}`,
    address_label: "Smart Trader",
    bought_volume_usd: 5_000,
    sold_volume_usd: 4_000,
  };
}

function fingerprint(endpoint, body) {
  return `${endpoint}\n${JSON.stringify(body)}`;
}

// A Nansen double whose observations feed back the number of reserved credits
// through the credit budget, mirroring the production chain
// (creditBudget -> callBudget -> live client) so a refused request never
// reaches the network. `fullPages` makes every research page full so the
// cheap 1-credit vocabulary is effectively unlimited via pagination.
function creditChain({ creditLimit, callLimit = 633, tokenCount = 6, fullPages = true }) {
  const sent = [];
  const live = {
    async post(endpoint, body) {
      sent.push({ endpoint, body, key: fingerprint(endpoint, body) });
      if (endpoint === TOKEN_SCREENER_ENDPOINT) {
        return {
          data: { data: Array.from({ length: tokenCount }, (_, index) => discovered(index + 1)) },
          meta: { status: 200 },
        };
      }
      const perPage = body.pagination?.per_page ?? 0;
      const count = fullPages && perPage > 0 ? perPage : 1;
      return {
        data: {
          data: Array.from({ length: count }, (_, index) => walletRecord(index + 1)),
          pagination: null,
        },
        meta: { status: 200 },
      };
    },
  };
  const callBudgeted = withCallBudget(live, callLimit);
  const budgeted = withCreditBudget(callBudgeted, creditLimit, { costs: CAMPAIGN_CREDIT_COSTS });
  return { sent, budgeted, callBudgeted };
}

test("a 334-credit run spends every credit on genuine 1-credit calls and never a 5-credit holder", async () => {
  // 339 credits remain: 334 spendable after the 5-credit safety reserve.
  const { sent, budgeted, callBudgeted } = creditChain({ creditLimit: 334 });

  const result = await runEligibilityCampaign(budgeted, {
    callsRemaining: 633,
    callBudget: callBudgeted,
    creditBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  // Every credit bought exactly one genuine, distinct 1-credit request.
  assert.equal(result.runCallLimit, 633, "the 909-campaign continuation cap stays 633");
  assert.equal(sent.length, 334, "339 - 5 reserve = 334 affordable 1-credit calls");
  assert.equal(new Set(sent.map((item) => item.key)).size, sent.length, "every request must be distinct");
  assert.equal(sent.filter((item) => item.endpoint === HOLDERS_ENDPOINT).length, 0,
    "5-credit holder requests must be deferred while 1-credit research remains");
  assert.ok(sent.every((item) => CAMPAIGN_CREDIT_COSTS[item.endpoint] === 1),
    "every sent request must cost exactly 1 credit");

  // The credit plan was hit exactly: nothing over the balance, reserve kept.
  assert.equal(budgeted.usage().reservedCredits, 334);
  assert.equal(budgeted.usage().remainingCredits, 0);
  assert.equal(budgeted.usage().calls.length, 334);
  assert.equal(callBudgeted.usage().calls, 334, "only 334 of the 633-call cap were needed");
  assert.equal(callBudgeted.usage().remainingCalls, 633 - 334);

  // The report tells the story: why it stopped, what it planned to spend.
  assert.equal(result.creditLimit, 334);
  assert.equal(result.creditSafetyReserve, 5);
  assert.match(result.stopReason, /credit budget exhausted/i);
  assert.match(result.stopReason, /safety reserve/);
  assert.match(result.stopReason, /334\/334 credits reserved/);
});

test("a holder request is never scheduled when it would exceed the remaining balance", async () => {
  // One token, empty research responses: the 1-credit vocabulary is finite
  // (discovery + 273 page-1 shapes) and pagination adds nothing. After it
  // drains, the only remaining shape is 5-credit holders — so size the budget
  // to leave exactly 4 credits: a holder call can never be afforded, and the
  // planner must stop instead of burning those credits on an unaffordable
  // request (or on a repeated/cheaper one).
  const { sent, budgeted, callBudgeted } = creditChain({ creditLimit: 278, tokenCount: 1, fullPages: false });

  const result = await runEligibilityCampaign(budgeted, {
    callsRemaining: 633,
    callBudget: callBudgeted,
    creditBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  // 1 discovery + 273 cheap page-1 requests = 274 reservations; the 4 credits
  // left cannot pay for any available request, so the run stops there.
  assert.equal(sent.filter((item) => item.endpoint === HOLDERS_ENDPOINT).length, 0,
    "the 5-credit holder call must not be sent against a 4-credit balance");
  assert.equal(sent.length, 274, "the run spends everything the cheap vocabulary allows");
  assert.equal(budgeted.usage().reservedCredits, 274);
  assert.equal(budgeted.usage().remainingCredits, 4);
  assert.equal(result.researchRequestsSkippedByBudget, 0,
    "no request should even be attempted past the affordable pool");
  assert.match(result.stopReason, /credit budget exhausted/i);
  assert.equal(HOLDER_CREDIT_COST, 5);
});

test("a credit-bounded run keeps producing distinct cheap requests until the balance runs out", async () => {
  // With full pages the cheap pool is effectively unbounded (pagination), so
  // a modest balance gets entirely new, distinct page-1..n requests — proving
  // credit exhaustion, not request exhaustion, is what stops the run.
  const { sent, budgeted, callBudgeted } = creditChain({ creditLimit: 140, tokenCount: 3 });

  const result = await runEligibilityCampaign(budgeted, {
    callsRemaining: 633,
    callBudget: callBudgeted,
    creditBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  assert.equal(sent.length, 140);
  assert.equal(new Set(sent.map((item) => item.key)).size, 140);
  assert.ok(sent.every((item) => CAMPAIGN_CREDIT_COSTS[item.endpoint] === 1));
  assert.equal(budgeted.usage().reservedCredits, 140);
  assert.equal(result.logicalCallsAttempted, 140);
  assert.match(result.stopReason, /credit budget exhausted/i);
  assert.notEqual(result.creditLimit, null);
  assert.equal(result.creditSafetyReserve, CREDIT_SAFETY_RESERVE);
});

test("the credit plan is reported even when no credit budget binds the run", async () => {
  // A non-credit-bounded run (the old worst-case sizing, or a run whose
  // balance is unknown) reports no credit limit instead of pretending one
  // existed: only the call cap binds.
  const sent = [];
  const live = {
    async post(endpoint, body) {
      sent.push({ endpoint, body, key: fingerprint(endpoint, body) });
      if (endpoint === TOKEN_SCREENER_ENDPOINT) {
        return { data: { data: Array.from({ length: 6 }, (_, index) => discovered(index + 1)) }, meta: { status: 200 } };
      }
      const perPage = body.pagination?.per_page ?? 0;
      const count = perPage > 0 ? perPage : 1;
      return {
        data: { data: Array.from({ length: count }, (_, index) => walletRecord(index + 1)), pagination: null },
        meta: { status: 200 },
      };
    },
  };
  const callBudgeted = withCallBudget(live, 633);

  const result = await runEligibilityCampaign(callBudgeted, {
    callsRemaining: 633,
    callBudget: callBudgeted,
    concurrency: 10,
    now: NOW,
  });

  assert.equal(result.creditLimit, null, "no credit budget was configured");
  assert.equal(result.creditSafetyReserve, CREDIT_SAFETY_RESERVE);
  assert.equal(sent.length, 633, "without a credit budget the call cap binds");
  assert.equal(new Set(sent.map((item) => item.key)).size, 633);
  assert.match(result.stopReason, /budget|cap/i);
});