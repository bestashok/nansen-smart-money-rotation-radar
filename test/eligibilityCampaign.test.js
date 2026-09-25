import assert from "node:assert/strict";
import test from "node:test";
import { runEligibilityCampaign } from "../src/server/eligibilityCampaign.js";
import { withCallBudget, CallBudgetExceededError } from "../src/server/callBudget.js";

function discovered(index) {
  return {
    token_symbol: `TOKEN${index}`,
    chain: "base",
    token_address: `0x${String(index).padStart(40, "0")}`,
    market_cap_usd: 2_000_000,
    liquidity: 200_000,
    netflow: 50_000 - index,
  };
}

function recordingClient(recordCount = 2) {
  const calls = [];
  const sharedWallet = "0x9999999999999999999999999999999999999999";
  const client = {
    async post(endpoint, body) {
      calls.push({ endpoint, body });
      if (endpoint === "/api/v1/token-screener") {
        return {
          data: { data: Array.from({ length: recordCount }, (_, index) => discovered(index + 1)) },
          meta: { status: 200 },
        };
      }
      if (endpoint === "/api/v1/tgm/flow-intelligence") {
        return { data: { data: [{ smart_trader_net_flow_usd: 100_000 }] }, meta: { status: 200 } };
      }
      const tokenNumber = Number.parseInt(body.token_address.slice(-2), 10);
      const address = body.buy_or_sell === "SELL" && tokenNumber === 1
        ? sharedWallet
        : body.buy_or_sell === "BUY" && tokenNumber === 2
          ? sharedWallet
          : `0x${String(tokenNumber).padStart(40, body.buy_or_sell === "BUY" ? "1" : "2")}`;
      return {
        data: { data: [{ address, address_label: "Smart Trader", bought_volume_usd: 5_000, sold_volume_usd: 4_000 }] },
        meta: { status: 200 },
      };
    },
  };
  return { calls, client };
}

test("campaign researches the whole discovered universe with distinct requests and an honest stop reason", async () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const { calls, client } = recordingClient();

  const result = await runEligibilityCampaign(client, {
    callsRemaining: 909,
    concurrency: 10,
    now,
  });

  // Every request must be a distinct (endpoint, body) pair: no identical repeats.
  const keys = calls.map((call) => `${call.endpoint}\n${JSON.stringify(call.body)}`);
  assert.equal(new Set(keys).size, keys.length);

  // Core evidence, wider windows, and holder depth are all exercised.
  assert.ok(calls.some((call) => call.endpoint === "/api/v1/tgm/holders"));
  assert.ok(calls.some((call) => call.endpoint === "/api/v1/tgm/who-bought-sold"
    && call.body.date?.from === new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString()));
  assert.ok(calls.some((call) => call.endpoint === "/api/v1/tgm/who-bought-sold"
    && call.body.date?.from === new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000).toISOString()));

  assert.equal(result.logicalCallsAttempted, calls.length);
  assert.equal(result.runCallLimit, 909);
  assert.equal(result.tokensDiscovered, 2);
  assert.equal(result.tokensPairedForResearch, 2);
  assert.equal(result.tokensSkippedByBudget, 0);
  assert.equal(result.researchRequestsSkippedByBudget, 0);
  assert.equal(result.rotations.length, 1);
  assert.equal(result.rotations[0].sourceToken.symbol, "TOKEN1");
  assert.equal(result.rotations[0].destinationToken.symbol, "TOKEN2");
  assert.match(result.stopReason, /No further distinct/);
});

test("campaign never schedules more calls than remain to the run budget", async () => {
  let calls = 0;
  const client = {
    async post(endpoint) {
      calls += 1;
      if (endpoint === "/api/v1/token-screener") {
        return { data: { data: [discovered(1), discovered(2)] }, meta: { status: 200 } };
      }
      return { data: { data: [{ address: `0x${"1".repeat(40)}` }] }, meta: { status: 200 } };
    },
  };

  const result = await runEligibilityCampaign(client, { callsRemaining: 3, now: new Date("2026-09-23T12:00:00Z") });
  assert.equal(calls, 3);
  assert.equal(result.logicalCallsAttempted, 3);
  assert.match(result.stopReason, /budget/i);
});

test("a hard-cap handle stops the run at its exact limit and counts every send", async () => {
  let sends = 0;
  const guard = withCallBudget({
    async post(endpoint) {
      sends += 1;
      if (endpoint === "/api/v1/token-screener") {
        return { data: { data: [discovered(1), discovered(2)] }, meta: { status: 200 } };
      }
      return { data: { data: [{ address: `0x${"1".repeat(40)}` }] }, meta: { status: 200 } };
    },
  }, 5);

  const result = await runEligibilityCampaign(guard, {
    callsRemaining: 909,
    callBudget: guard,
    concurrency: 5,
    now: new Date("2026-09-23T12:00:00Z"),
  });

  assert.equal(sends, 5);
  assert.equal(guard.usage().calls, 5);
  assert.equal(guard.usage().remainingCalls, 0);
  assert.ok(result.logicalCallsAttempted <= 5);
  assert.match(result.stopReason, /budget/i);
  await assert.rejects(guard.post("/after-the-cap", {}), (error) => error instanceof CallBudgetExceededError);
  assert.equal(sends, 5);
});

test("campaign aborts immediately when Nansen reports insufficient credits", async () => {
  let calls = 0;
  const client = {
    async post(endpoint) {
      calls += 1;
      if (endpoint === "/api/v1/token-screener") {
        return { data: { data: [discovered(1), discovered(2)] }, meta: { status: 200 } };
      }
      throw Object.assign(new Error("Nansen request failed: insufficient credits"), {
        status: 402,
        category: "credits",
      });
    },
  };

  const result = await runEligibilityCampaign(client, {
    callsRemaining: 909,
    concurrency: 1,
    now: new Date("2026-09-23T12:00:00Z"),
  });

  assert.match(result.stopReason, /Early stop/);
  assert.equal(calls, 2); // one discovery + the first fatal research request
  assert.equal(result.researchRequestsDispatched, 1);
  assert.ok(result.researchRequestsSkippedByBudget >= 7,
    "the rest of the queued batch must be skipped after a fatal error");
  assert.equal(result.tokensSkippedByBudget, 1);
});
