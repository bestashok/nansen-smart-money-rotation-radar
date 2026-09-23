import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverTokens,
  DISCOVERY_LIMIT,
  DISCOVERY_REQUEST,
  TOKEN_SCREENER_ENDPOINT,
} from "../src/server/discovery.js";
import { createNansenClient, NansenApiError } from "../src/server/nansenClient.js";

test("discovery requests up to 25 screener results and normalizes fields", async () => {
  let request;
  const nansenClient = {
    async post(endpoint, body) {
      request = { endpoint, body };
      return {
        data: {
          data: [{
            token_symbol: "TEST",
            chain: "base",
            token_address: "0xabc",
            market_cap_usd: 2_000_000,
            liquidity: 200_000,
            netflow: 50_000,
          }],
          pagination: { page: 1, per_page: 25, is_last_page: true },
        },
        meta: { status: 200 },
      };
    },
  };

  const result = await discoverTokens(nansenClient);

  assert.equal(DISCOVERY_LIMIT, 25);
  assert.equal(request.endpoint, TOKEN_SCREENER_ENDPOINT);
  assert.equal(request.body.pagination.per_page, 25);
  assert.equal(request.body.filters.trader_type, "sm");
  assert.equal(request.body.filters.include_stablecoins, false);
  assert.deepEqual(result.tokens[0], {
    symbol: "TEST",
    chain: "base",
    contractAddress: "0xabc",
    marketCapUsd: 2_000_000,
    liquidityUsd: 200_000,
    netflowUsd: 50_000,
  });
});

test("discovery accepts zero qualifying tokens", async () => {
  const result = await discoverTokens({
    async post() {
      return { data: { data: [], pagination: { is_last_page: true } }, meta: { status: 200 } };
    },
  });

  assert.deepEqual(result.tokens, []);
});

test("Nansen client refuses to send a request without a key", async () => {
  const client = createNansenClient({ apiKey: "", fetchImpl: async () => assert.fail("fetch called") });

  await assert.rejects(
    client.post(TOKEN_SCREENER_ENDPOINT, DISCOVERY_REQUEST),
    (error) => error instanceof NansenApiError && error.category === "configuration",
  );
});

test("Nansen client reports network failures as transport errors", async () => {
  const client = createNansenClient({
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    client.post(TOKEN_SCREENER_ENDPOINT, DISCOVERY_REQUEST),
    (error) => error instanceof NansenApiError && error.category === "transport",
  );
});
