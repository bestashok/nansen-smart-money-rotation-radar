import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverTokens,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_REQUEST,
  TOKEN_SCREENER_ENDPOINT,
} from "../src/server/discovery.js";
import { createNansenClient, NansenApiError } from "../src/server/nansenClient.js";

test("discovery requests a documented page size and normalizes fields", async () => {
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
          pagination: { page: 1, per_page: 20, is_last_page: true },
        },
        meta: { status: 200 },
      };
    },
  };

  const result = await discoverTokens(nansenClient);

  assert.equal(DISCOVERY_PAGE_SIZE, 20);
  assert.equal(request.endpoint, TOKEN_SCREENER_ENDPOINT);
  assert.equal(request.body.pagination.per_page, 20);
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

test("discovery paginates until Nansen reports the last page", async () => {
  const pages = [];
  const result = await discoverTokens({
    async post(_endpoint, body) {
      pages.push(body.pagination.page);
      const page = body.pagination.page;
      return {
        data: {
          data: [{
            token_symbol: `PAGE${page}`,
            chain: "base",
            token_address: `0x${page}`,
            market_cap_usd: 2_000_000,
            liquidity: 200_000,
            netflow: 50_000,
          }],
          pagination: { page, per_page: 20, is_last_page: page === 2 },
        },
        meta: { status: 200 },
      };
    },
  });

  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(result.tokens.map((token) => token.symbol), ["PAGE1", "PAGE2"]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.stoppedByBudget, false);
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
