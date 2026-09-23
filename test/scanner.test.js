import assert from "node:assert/strict";
import test from "node:test";
import { scanAllTokens } from "../src/server/scanner.js";

function record(symbol, address) {
  return {
    token_symbol: symbol,
    chain: "base",
    token_address: address,
    market_cap_usd: 2_000_000,
    liquidity: 200_000,
    netflow: 50_000,
  };
}

function clientWithTokens(records) {
  return {
    async post(endpoint, body) {
      if (endpoint === "/api/v1/token-screener") {
        return { data: { data: records }, meta: { status: 200 } };
      }
      if (endpoint === "/api/v1/tgm/flow-intelligence") {
        return { data: { data: [{ smart_trader_net_flow_usd: 100 }] }, meta: { status: 200 } };
      }
      if (endpoint === "/api/v1/tgm/flows") {
        return { data: { data: [{ date: "2026-09-23T00:00:00Z" }] }, meta: { status: 200 } };
      }
      if (endpoint === "/api/v1/tgm/holders") {
        return { data: { data: [{ address: `holder-${body.token_address}` }] }, meta: { status: 200 } };
      }
      return {
        data: { data: [{ address: `${body.buy_or_sell}-${body.token_address}` }] },
        meta: { status: 200 },
      };
    },
  };
}

test("scanner researches every discovered token through the pool", async () => {
  const result = await scanAllTokens(
    clientWithTokens([record("ONE", "0x1"), record("TWO", "0x2")]),
    { concurrency: 2, now: new Date("2026-09-23T12:00:00Z") },
  );

  assert.equal(result.tokensDiscovered, 2);
  assert.equal(result.tokensAnalyzed, 2);
  assert.equal(result.tokensFailed, 0);
  assert.equal(result.maximumConcurrentRequests, 2);
});

test("scanner completes normally when discovery returns zero tokens", async () => {
  const result = await scanAllTokens(clientWithTokens([]));
  assert.equal(result.tokensDiscovered, 0);
  assert.equal(result.tokensAnalyzed, 0);
  assert.equal(result.tokensFailed, 0);
});
