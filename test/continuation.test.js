import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { API_CALL_LIMIT, researchBodyFor, runEligibilityCampaign } from "../src/server/eligibilityCampaign.js";
import { CallBudgetExceededError, withCallBudget } from "../src/server/callBudget.js";
import { withRateLimitRetries } from "../src/server/retry.js";
import { cacheKeyOf, createCachedNansenClient } from "../src/server/cache.js";
import { campaignCallsRemaining, campaignCallsSent } from "../src/server/campaignStore.js";
import { repairLostLedgerEntries } from "../src/server/ledgerRepair.js";
import { createResearchRequests, dateRange } from "../src/server/researchGate.js";
import { DISCOVERY_PAGE_SIZE, DISCOVERY_REQUEST, normalizeDiscoveredToken, TOKEN_SCREENER_ENDPOINT } from "../src/server/discovery.js";

const WBS_ENDPOINT = "/api/v1/tgm/who-bought-sold";
const FLOWS_ENDPOINT = "/api/v1/tgm/flows";
const FLOW_INTEL_ENDPOINT = "/api/v1/tgm/flow-intelligence";
const HOLDERS_ENDPOINT = "/api/v1/tgm/holders";

// Two completed Live Scan 2 cycles sent 144 + 132 = 276 genuine calls; the
// next cycle must send exactly 633 more so the campaign total lands on 909.
const CALLS_ALREADY_SENT = 276;
const CONTINUATION_LIMIT = API_CALL_LIMIT - CALLS_ALREADY_SENT;

const NOW = new Date("2026-09-24T12:00:00Z");
const RUN_STARTED_AT = "2026-09-24T11:35:06.000Z";

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

// A cooperative Nansen double that always returns full pages, so pagination
// depth is limited only by the configured page caps.
function fullPageClient({ tokenCount = 6 } = {}) {
  const sent = [];
  return {
    sent,
    client: {
      async post(endpoint, body) {
        sent.push({ endpoint, body, key: fingerprint(endpoint, body) });
        if (endpoint === TOKEN_SCREENER_ENDPOINT) {
          return {
            data: { data: Array.from({ length: tokenCount }, (_, index) => discovered(index + 1)) },
            meta: { status: 200 },
          };
        }
        const perPage = body.pagination?.per_page ?? 0;
        const count = perPage > 0 ? perPage : 1;
        return {
          data: { data: Array.from({ length: count }, (_, index) => walletRecord(index + 1)) },
          meta: { status: 200 },
        };
      },
    },
  };
}

test("the continuation ledger reports exactly 633 remaining calls after the 276 already made", () => {
  // Mirrors data/campaign-history.json: two real cycles (144 and 132 calls)
  // plus legacy runs that recorded no totals.
  const history = [
    { runReport: { nansenApiCallsSent: 132 }, totalCalls: 132 },
    { runReport: { nansenApiCallsSent: 144 }, totalCalls: 144 },
    { totalCalls: null, runReport: null }, // legacy runs that recorded no totals
    {},
  ];

  assert.equal(campaignCallsSent(history), 276);
  assert.equal(campaignCallsRemaining(history), 633);
  assert.equal(campaignCallsRemaining(history), API_CALL_LIMIT - CALLS_ALREADY_SENT);
  assert.equal(campaignCallsRemaining([]), 909);
  assert.equal(campaignCallsRemaining([{ runReport: { nansenApiCallsSent: 909 } }]), 0);
});

test("the 633-call continuation spends exactly 633 distinct requests and never sends call 634", async () => {
  assert.equal(CONTINUATION_LIMIT, 633);
  const { client, sent } = fullPageClient();
  const budgeted = withCallBudget(client, CONTINUATION_LIMIT);

  const result = await runEligibilityCampaign(budgeted, {
    callsRemaining: CONTINUATION_LIMIT,
    callBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  assert.equal(result.runCallLimit, 633);
  assert.equal(sent.length, 633, "the expanded breadth must supply the full 633 calls");
  assert.equal(new Set(sent.map((item) => item.key)).size, 633, "every request must be distinct");
  assert.equal(budgeted.usage().calls, 633);
  assert.equal(budgeted.usage().remainingCalls, 0);
  assert.match(result.stopReason, /budget|cap/i);

  await assert.rejects(
    budgeted.post("/after-the-cap", {}),
    (error) => error instanceof CallBudgetExceededError,
  );
  assert.equal(sent.length, 633, "request 634 must never leave the process");
});

test("request 634 can never be sent even when 429 retries consume the continuation budget", async () => {
  let sent = 0;
  const budgeted = withCallBudget({
    async post() {
      sent += 1;
      const error = new Error("rate limited");
      error.status = 429;
      error.retryAfterMs = 0;
      throw error;
    },
  }, CONTINUATION_LIMIT);
  const retried = withRateLimitRetries(budgeted, { maxRetries: 5_000, sleep: async () => {} });

  await assert.rejects(
    retried.post(TOKEN_SCREENER_ENDPOINT, {}),
    (error) => error instanceof CallBudgetExceededError,
  );

  assert.equal(sent, 633);
  assert.ok(sent < 634, `sent ${sent}; request 634 must never go out`);
  assert.deepEqual(budgeted.usage(), { limit: 633, calls: 633, remainingCalls: 0 });
});

test("requests already made are never repeated: depth resumes at the first unseen page", async () => {
  const token = normalizeDiscoveredToken(discovered(1));
  const requests = createResearchRequests(token, NOW);
  const discoveryBody = {
    ...DISCOVERY_REQUEST,
    pagination: { page: 1, per_page: DISCOVERY_PAGE_SIZE },
  };

  // What an earlier cycle left behind in the request ledger (cache): the
  // discovery page, the first who-bought-sold page (full), and the
  // non-paginated flow-intelligence call.
  const seen = new Map([
    [fingerprint(TOKEN_SCREENER_ENDPOINT, discoveryBody), { data: { data: [discovered(1)], pagination: null } }],
    [
      fingerprint(WBS_ENDPOINT, requests.buyers),
      { data: { data: Array.from({ length: 25 }, (_, index) => walletRecord(index + 1)) } },
    ],
    [fingerprint(FLOW_INTEL_ENDPOINT, requests.flowIntelligence), { data: { data: [{ smart_trader_net_flow_usd: 1 }] } }],
  ]);

  const sent = [];
  const client = {
    async post(endpoint, body) {
      sent.push({ endpoint, body, key: fingerprint(endpoint, body) });
      const perPage = body.pagination?.per_page ?? 0;
      const count = perPage > 0 ? perPage : 1;
      return {
        data: { data: Array.from({ length: count }, (_, index) => walletRecord(index + 1)) },
        meta: { status: 200 },
      };
    },
    async inspect(endpoint, body) {
      return seen.get(fingerprint(endpoint, body)) ?? null;
    },
  };
  const budgeted = withCallBudget(client, 400);
  // Mirrors the production chain: the campaign sees a client that can both
  // send (through the hard-cap guard) and answer from the request ledger.
  const campaignClient = {
    post: (endpoint, body) => budgeted.post(endpoint, body),
    inspect: (endpoint, body) => client.inspect(endpoint, body),
  };

  const result = await runEligibilityCampaign(campaignClient, {
    callsRemaining: 400,
    callBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  // Discovery came from the ledger: no identical screener request was sent.
  assert.equal(sent.filter((item) => item.endpoint === TOKEN_SCREENER_ENDPOINT).length, 0);
  assert.equal(result.tokensDiscovered, 1, "tokens must be reused from the cached discovery response");

  // The exact 7-day base buyers page 1 and the flow-intelligence call were
  // not repeated (cohort variants of the same window are different requests).
  assert.equal(
    sent.some((item) => item.key === fingerprint(WBS_ENDPOINT, requests.buyers)),
    false,
    "page 1 was already requested",
  );
  assert.equal(sent.filter((item) => item.endpoint === FLOW_INTEL_ENDPOINT).length, 0);

  // ...but depth resumed at page 2 of that shape.
  const buyersPage2 = sent.filter((item) => item.endpoint === WBS_ENDPOINT
    && item.body.buy_or_sell === "BUY"
    && item.body.pagination.page === 2);
  assert.ok(buyersPage2.length >= 1, "pagination must resume at the first unseen page");

  // Cached responses satisfied the run without consuming the call budget, so
  // everything that did leave the process is a fresh, distinct request.
  assert.equal(sent.length, 400);
  assert.equal(budgeted.usage().calls, 400);
  assert.equal(new Set(sent.map((item) => item.key)).size, sent.length, "no request may repeat");
  assert.ok(sent.every((item) => !seen.has(item.key)), "a seen request must never be re-sent");
  assert.match(result.stopReason, /budget|cap/i);
  assert.ok(result.researchRequestsReusedFromCache >= 2,
    "the reused buyers page and flow-intelligence call should be reported");
  assert.ok(result.discoveryPagesReused >= 1, "the reused discovery page should be reported");
});

test("expanded research breadth offers far more than the 633 distinct meaningful requests", async () => {
  const { client, sent } = fullPageClient({ tokenCount: 6 });
  // The absolute per-run cap (909) limits the probe, which is still plenty:
  // reaching 909 distinct requests proves capacity is well above the 633-call
  // continuation limit.
  const probe = 909;
  const budgeted = withCallBudget(client, probe);

  const result = await runEligibilityCampaign(budgeted, {
    callsRemaining: probe,
    callBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  // The planner must keep producing distinct requests well past the 633-call
  // continuation limit; only the budget stops it.
  assert.equal(result.logicalCallsAttempted, 909,
    `only ${result.logicalCallsAttempted} distinct requests were available`);
  assert.ok(result.logicalCallsAttempted > CONTINUATION_LIMIT);
  assert.equal(sent.length, result.logicalCallsAttempted);
  assert.equal(new Set(sent.map((item) => item.key)).size, sent.length,
    "every request in the expanded plan must be distinct");
  assert.match(result.stopReason, /budget|cap/i);
});

test("breadth alone supplies 909 distinct requests even when every research response is empty", async () => {
  // The scenario that ended the previous cycle: every window/page shape at
  // the old depth was exhausted (zero new records anywhere). The expanded
  // request vocabulary must still structurally provide more than the 633-call
  // continuation needs, without repeating a single request.
  const sent = [];
  const client = {
    async post(endpoint, body) {
      sent.push({ endpoint, body, key: fingerprint(endpoint, body) });
      if (endpoint === TOKEN_SCREENER_ENDPOINT) {
        return {
          data: { data: Array.from({ length: 6 }, (_, index) => discovered(index + 1)) },
          meta: { status: 200 },
        };
      }
      return { data: { data: [] }, meta: { status: 200 } };
    },
  };
  const probe = 909;
  const budgeted = withCallBudget(client, probe);

  const result = await runEligibilityCampaign(budgeted, {
    callsRemaining: probe,
    callBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  assert.equal(result.logicalCallsAttempted, 909,
    `only ${result.logicalCallsAttempted} distinct structural requests were available`);
  assert.ok(result.logicalCallsAttempted > CONTINUATION_LIMIT);
  assert.equal(sent.length, 909);
  assert.equal(new Set(sent.map((item) => item.key)).size, 909, "every structural request must be distinct");
  assert.equal(result.researchRequestsSkippedByBudget, 0, "capacity must reach the probe, not stop early");
  assert.match(result.stopReason, /budget|cap/i);
});

test("ledger repair restores lost responses without disturbing existing entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-repair-"));
  const cachePath = path.join(directory, "cache.json");
  let liveCalls = 0;
  const live = {
    async post() {
      liveCalls += 1;
      return { data: { data: [{ address: `0x${"1".repeat(40)}` }] }, meta: { status: 200 } };
    },
  };

  // A genuine entry from an earlier cycle.
  const seedBody = { chain: "base", date: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" } };
  const cached = createCachedNansenClient(live, { cachePath, now: () => 1_000 });
  await cached.post(FLOWS_ENDPOINT, seedBody);
  assert.equal(liveCalls, 1);
  const seedKey = cacheKeyOf(FLOWS_ENDPOINT, seedBody);
  const before = JSON.parse(await readFile(cachePath, "utf8"));
  assert.ok(before.entries[seedKey]);

  const token = normalizeDiscoveredToken(discovered(1));
  const history = [{
    campaignStartedAt: RUN_STARTED_AT,
    researchFailures: [{
      token,
      failures: [
        // Sent successfully, but the response body was lost when the atomic
        // cache rename failed: the request MUST count as already made.
        {
          kind: "holders",
          windowDays: 0,
          page: 11,
          message: "EPERM: operation not permitted, rename 'E:\\Nansen\\data\\cache.json.tmp' -> 'E:\\Nansen\\data\\cache.json'",
        },
        // A genuine API rejection is NOT a lost response: re-requesting it
        // later is legitimate, so it must not be masked as "sent".
        {
          kind: "buyers",
          windowDays: 180,
          page: 1,
          message: "Nansen request failed with status code 422 (request_schema)",
        },
      ],
    }],
  }];

  const report = await repairLostLedgerEntries(history, { cachePath });
  assert.equal(report.repaired, 1, "the lost response must be recorded");
  assert.equal(report.skippedNotLost, 1, "a genuine API failure must not be masked");
  assert.equal(report.skippedExisting, 0);

  const after = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(after.entries[seedKey], before.entries[seedKey], "existing ledger entries must be untouched");
  assert.equal(Object.keys(after.entries).length, 2);

  const repairedBody = researchBodyFor(token, new Date(RUN_STARTED_AT), { kind: "holders", windowDays: 0, page: 11 });
  const repairedKey = cacheKeyOf(HOLDERS_ENDPOINT, repairedBody);
  assert.ok(after.entries[repairedKey],
    "the repaired key must be exactly the request the campaign generated");
  assert.equal(after.entries[repairedKey].dataLost, true);

  const prior = await createCachedNansenClient(live, { cachePath, now: () => 1_000 })
    .inspect(HOLDERS_ENDPOINT, repairedBody);
  assert.ok(prior, "the campaign dedup check must see the repaired request");
  assert.equal(prior.dataLost, true);
  assert.equal(prior.records.length, 0);

  // Idempotent: a second pass must not duplicate or overwrite anything.
  const again = await repairLostLedgerEntries(history, { cachePath });
  assert.equal(again.repaired, 0);
  assert.equal(again.skippedExisting, 1);
  assert.equal(again.totalEntries, 2);

  // Reconstruction equivalence: a repaired body must hash to the same cache
  // key as the exact body shape the campaign generates for that request.
  const base = createResearchRequests(token, NOW);
  assert.equal(
    cacheKeyOf(WBS_ENDPOINT, { ...base.buyers, date: dateRange(NOW, 180) }),
    cacheKeyOf(WBS_ENDPOINT, researchBodyFor(token, NOW, { kind: "buyers", windowDays: 180, page: 1 })),
  );
  assert.equal(
    cacheKeyOf(FLOWS_ENDPOINT, { ...base.flows, pagination: { ...base.flows.pagination, page: 2 } }),
    cacheKeyOf(FLOWS_ENDPOINT, researchBodyFor(token, NOW, { kind: "flows", windowDays: 7, page: 2 })),
  );
  assert.equal(
    cacheKeyOf(HOLDERS_ENDPOINT, { ...base.holders, pagination: { ...base.holders.pagination, page: 11 } }),
    cacheKeyOf(HOLDERS_ENDPOINT, researchBodyFor(token, NOW, { kind: "holders", windowDays: 0, page: 11 })),
  );
});

test("repaired ledger entries are never re-sent and depth continues on the next page", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-data-lost-"));
  const cachePath = path.join(directory, "cache.json");
  const token = normalizeDiscoveredToken(discovered(1));
  const discoveryBody = { ...DISCOVERY_REQUEST, pagination: { page: 1, per_page: DISCOVERY_PAGE_SIZE } };
  const base = createResearchRequests(token, NOW);
  const buyersPage2 = researchBodyFor(token, NOW, { kind: "buyers", windowDays: 7, page: 2 });

  // Ledger: discovery page, a genuine full buyers page 1, and a repaired
  // page 2 whose response body was lost (sent, records unknown).
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    entries: {
      [cacheKeyOf(TOKEN_SCREENER_ENDPOINT, discoveryBody)]: {
        endpoint: TOKEN_SCREENER_ENDPOINT,
        createdAt: 1_000,
        expiresAt: 0,
        data: { data: [discovered(1)], pagination: null },
        meta: { status: 200 },
      },
      [cacheKeyOf(WBS_ENDPOINT, base.buyers)]: {
        endpoint: WBS_ENDPOINT,
        createdAt: 1_000,
        expiresAt: 0,
        data: { data: Array.from({ length: 25 }, (_, index) => walletRecord(index + 1)) },
        meta: { status: 200 },
      },
      [cacheKeyOf(WBS_ENDPOINT, buyersPage2)]: {
        endpoint: WBS_ENDPOINT,
        createdAt: 1_000,
        expiresAt: 0,
        data: null,
        dataLost: true,
        meta: { status: 200, source: "REPAIRED_LEDGER" },
      },
    },
  }, null, 2));

  const sent = [];
  const live = {
    async post(endpoint, body) {
      sent.push({ endpoint, body, key: fingerprint(endpoint, body) });
      const perPage = body.pagination?.per_page ?? 0;
      const count = perPage > 0 ? perPage : 1;
      return {
        data: { data: Array.from({ length: count }, (_, index) => walletRecord(index + 1)) },
        meta: { status: 200 },
      };
    },
  };
  const cached = createCachedNansenClient(live, { cachePath, now: () => Date.now(), renameAttempts: 2, renameDelayMs: 5 });
  const budgeted = withCallBudget(cached, 554);
  const campaignClient = {
    post: (endpoint, body) => budgeted.post(endpoint, body),
    inspect: (endpoint, body) => cached.inspect(endpoint, body),
  };

  const result = await runEligibilityCampaign(campaignClient, {
    callsRemaining: 554,
    callBudget: budgeted,
    concurrency: 10,
    now: NOW,
  });

  // The BASE shape only: label cohorts shrink the label list and volume
  // cohorts raise the minimum trade size, so requiring all 5 labels AND the
  // original $1 tier isolates the exact request whose page 2 was repaired.
  const baseBuyers7 = (item) => item.endpoint === WBS_ENDPOINT
    && item.body.buy_or_sell === "BUY"
    && item.body.filters?.include_smart_money_labels?.length === 5
    && item.body.filters?.trade_volume_usd?.min === 1
    && Date.parse(item.body.date.to) - Date.parse(item.body.date.from) === 7 * 24 * 60 * 60 * 1_000;

  assert.equal(sent.filter((item) => baseBuyers7(item) && item.body.pagination.page === 2).length, 0,
    "the repaired response must never be requested again");
  assert.equal(sent.filter((item) => baseBuyers7(item) && item.body.pagination.page === 3).length, 1,
    "pagination must continue past the repaired page");

  assert.equal(sent.length, 554, "the run must spend exactly its hard cap");
  assert.equal(budgeted.usage().calls, 554);
  assert.equal(new Set(sent.map((item) => item.key)).size, sent.length, "no request may repeat");
  assert.ok(result.researchRequestsReusedFromCache >= 2,
    "buyers page 1 and the repaired page 2 must both be reused");
  assert.ok(result.discoveryPagesReused >= 1, "the reused discovery page must be reported");
  assert.match(result.stopReason, /budget|cap/i);

  await assert.rejects(
    budgeted.post("/after-the-cap", {}),
    (error) => error instanceof CallBudgetExceededError,
  );
  assert.equal(sent.length, 554, "the next call must never leave the process");
});

test("cache remembers every request made for dedup, while expired entries still go live", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-dedup-"));
  const cachePath = path.join(directory, "cache.json");
  let liveCalls = 0;
  const live = {
    async post(endpoint) {
      liveCalls += 1;
      return { data: { data: [{ address: `0x${"1".repeat(40)}` }] }, meta: { endpoint, status: 200 } };
    },
  };

  const first = createCachedNansenClient(live, { cachePath, now: () => 1_000 });
  await first.post(FLOWS_ENDPOINT, { chain: "base", date: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" } });
  assert.equal(liveCalls, 1);

  // Later, after the TTL expired, the entry is still visible to dedup even
  // though the cache will not serve it.
  const later = createCachedNansenClient(live, { cachePath, now: () => 1_000 + 60 * 60_000 });
  const prior = await later.inspect(FLOWS_ENDPOINT, {
    chain: "base",
    date: { from: "2026-09-05T00:00:00.000Z", to: "2026-09-12T00:00:00.000Z" },
  });
  assert.ok(prior, "an expired entry must still be visible to the dedup check");
  assert.equal(prior.records.length, 1);
  assert.equal(await later.inspect(FLOWS_ENDPOINT, { chain: "bnb" }), null);

  const response = await later.post(FLOWS_ENDPOINT, {
    chain: "base",
    date: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" },
  });
  assert.equal(response.meta.source, "LIVE", "expired entries must never be served as fresh data");
  assert.equal(liveCalls, 2);
});
