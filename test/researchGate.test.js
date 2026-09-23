import assert from "node:assert/strict";
import test from "node:test";
import { createResearchRequests, runResearchGate } from "../src/server/researchGate.js";

const token = {
  symbol: "TEST",
  chain: "base",
  contractAddress: "0xabc",
  marketCapUsd: 2_000_000,
  liquidityUsd: 200_000,
  netflowUsd: 50_000,
};

function mockClient(overrides = {}) {
  return {
    async post(endpoint, body) {
      if (endpoint === "/api/v1/token-screener") {
        return {
          data: {
            data: [{
              token_symbol: token.symbol,
              chain: token.chain,
              token_address: token.contractAddress,
              market_cap_usd: token.marketCapUsd,
              liquidity: token.liquidityUsd,
              netflow: token.netflowUsd,
            }],
          },
          meta: { status: 200 },
        };
      }

      if (overrides[body.buy_or_sell]) return overrides[body.buy_or_sell]();
      if (endpoint === "/api/v1/tgm/flow-intelligence") {
        return {
          data: { data: [{ smart_trader_net_flow_usd: 12_345, smart_trader_wallet_count: 4 }] },
          meta: { status: 200 },
        };
      }
      if (endpoint === "/api/v1/tgm/flows") {
        return { data: { data: [{ date: "2026-09-22T00:00:00Z" }] }, meta: { status: 200 } };
      }
      if (endpoint === "/api/v1/tgm/holders") {
        return { data: { data: [{ address: "0xholder", token_amount: 10 }] }, meta: { status: 200 } };
      }
      return {
        data: {
          data: [{
            address: body.buy_or_sell === "BUY" ? "0xbuyer" : "0xseller",
            address_label: "Smart Trader",
          }],
        },
        meta: { status: 200 },
      };
    },
  };
}

test("research requests use documented fields and standard-cost holder labels", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const requests = createResearchRequests(token, now);

  assert.equal(requests.flows.label, "smart_money");
  assert.equal(requests.flowIntelligence.timeframe, "1d");
  assert.equal(requests.buyers.buy_or_sell, "BUY");
  assert.equal(requests.sellers.buy_or_sell, "SELL");
  assert.equal(requests.buyers.date.from, "2026-09-16T12:00:00.000Z");
  assert.equal(requests.holders.label_type, "all_holders");
  assert.equal(requests.holders.premium_labels, false);
});

test("research gate passes only with buyer and seller wallet addresses", async () => {
  const result = await runResearchGate(mockClient(), {
    now: new Date("2026-09-23T12:00:00.000Z"),
  });

  assert.equal(result.passed, true);
  assert.equal(result.buyers[0].address, "0xbuyer");
  assert.equal(result.sellers[0].address, "0xseller");
  assert.equal(result.holders[0].address, "0xholder");
  assert.equal(result.flowIntelligence[0].smartTraderNetFlowUsd, 12_345);
});

test("research gate fails when a required endpoint fails", async () => {
  const expected = new Error("buyers unavailable");
  const result = await runResearchGate(mockClient({ BUY: () => Promise.reject(expected) }));

  assert.equal(result.passed, false);
  assert.equal(result.failures.buyers, expected);
});
