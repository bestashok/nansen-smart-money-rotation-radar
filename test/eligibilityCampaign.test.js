import assert from "node:assert/strict";
import test from "node:test";
import { runEligibilityCampaign } from "../src/server/eligibilityCampaign.js";

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

test("200-credit campaign uses 20 meaningful calls across nine token pairs", async () => {
  const calls = [];
  const sharedWallet = "0x9999999999999999999999999999999999999999";
  const client = {
    async post(endpoint, body) {
      calls.push({ endpoint, body });
      if (endpoint === "/api/v1/token-screener") {
        return { data: { data: Array.from({ length: 10 }, (_, index) => discovered(index + 1)) }, meta: { status: 200 } };
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

  const result = await runEligibilityCampaign(client, {
    creditLimit: 200,
    callsRemaining: 978,
    concurrency: 10,
    now: new Date("2026-09-23T12:00:00Z"),
  });

  assert.equal(calls.length, 20);
  assert.equal(result.logicalCallsAttempted, 20);
  assert.equal(result.tokensDiscovered, 10);
  assert.equal(result.tokensPairedForResearch, 9);
  assert.equal(result.tokensSkippedByBudget, 1);
  assert.equal(result.rotations.length, 1);
  assert.equal(result.rotations[0].sourceToken.symbol, "TOKEN1");
  assert.equal(result.rotations[0].destinationToken.symbol, "TOKEN2");
});

test("campaign never schedules more calls than remain to the target", async () => {
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

  const result = await runEligibilityCampaign(client, { creditLimit: 200, callsRemaining: 3 });
  assert.equal(calls, 3);
  assert.equal(result.logicalCallsAttempted, 3);
});
