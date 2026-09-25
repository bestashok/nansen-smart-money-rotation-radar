import { mapWithConcurrency } from "./concurrency.js";
import {
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_REQUEST,
  normalizeDiscoveredToken,
  TOKEN_SCREENER_ENDPOINT,
} from "./discovery.js";
import { detectRotations } from "./rotationEngine.js";
import { createResearchRequests, dateRange, RESEARCH_ENDPOINTS, SMART_MONEY_LABELS } from "./researchGate.js";
import { CallBudgetExceededError } from "./callBudget.js";
import { CAMPAIGN_CREDIT_COSTS, CreditBudgetExceededError } from "./creditBudget.js";

// Hard maximum number of REAL outbound Nansen HTTP requests (retries included)
// that a single Live Scan 2 campaign run is ever allowed to send. Request
// number 910 can never leave this process. 909 campaign calls + the 91 calls
// made before the campaign started = exactly 1,000 all-time API calls.
export const API_CALL_LIMIT = 909;
// Cumulative buildathon target used for progress reporting across runs.
export const API_CALL_TARGET = 1_000;

// Maximum pagination depth per research request shape. Pages continue only
// while Nansen keeps returning full pages, so no empty filler requests are
// sent once an endpoint runs out of data for a token. The depth was raised so
// a continuation cycle can keep finding fresh, deeper pages of real records
// instead of running out of distinct requests after ~10 pages.
const WBS_PAGE_LIMIT = 50; // who-bought-sold pages (25 wallets each)
const FLOWS_PAGE_LIMIT = 50; // flows pages (30 records each)
const HOLDERS_PAGE_LIMIT = 50; // holders pages (25 records each)

// Distinct research horizons (days) for who-bought-sold and flows requests.
// Every (token, endpoint, window, page) tuple is a separate valid request, so
// the plan keeps supplying new, meaningful calls without ever repeating one
// that was already made in an earlier cycle (those are answered from the
// request ledger instead — see `inspect` below). The earlier cycles exhausted
// the original 9-window vocabulary, so 7 more genuine horizons (2, 5, 10, 21,
// 45, 120, 270 days) were added for the continuation.
const RESEARCH_WINDOWS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365];
const CORE_WINDOW_DAYS = 7;

// Cohort slices of the who-bought-sold evidence: one request per Smart Money
// label ("which Funds bought in the last 30 days?") and per minimum trade-size
// tier ("who traded at least $100k in 90 days?"). Each combination is a
// different, meaningful question against a filter Nansen already accepted
// (subsets/values of the proven base filters), which is how the continuation
// keeps finding fresh, distinct calls after the plain window/page shapes were
// exhausted in earlier cycles.
const COHORT_VOLUME_TIERS = [10_000, 100_000];

// Holder request variants: flips of the same request's already-valid boolean
// parameters (entity-level aggregation and premium-labeled holders only).
const HOLDER_VARIANTS = [null, "entity-aggregate", "entity-premium", "entity-aggregate-premium"];

// Credit accounting for a campaign cycle: the run holds back a small safety
// reserve from the last known Nansen balance so genuine call volume can never
// accidentally drain the account to zero, and it defers 5-credit holder calls
// behind the entire 1-credit vocabulary so a credit-limited run spends every
// credit on the maximum number of distinct, meaningful requests.
export const CREDIT_SAFETY_RESERVE = 5;
export const HOLDER_CREDIT_COST = CAMPAIGN_CREDIT_COSTS[RESEARCH_ENDPOINTS.holders];

// Stop the whole run when the network or rate limiter is clearly unhealthy,
// instead of burning the remaining call budget on doomed requests.
const TRANSPORT_FAILURE_LIMIT = 10;
const RATE_LIMIT_FAILURE_LIMIT = 10;

// Errors that make every further request pointless: abort immediately.
const FATAL_CATEGORIES = new Set([
  "configuration",
  "authentication",
  "access_or_plan",
  "credits",
]);

// Stage order: proven core evidence first, then wider research windows, then
// per-cohort breadth. Every stage here is a 1-credit request, so a
// credit-constrained cycle spends its whole balance on the maximum number of
// genuine calls. Holder depth (5 credits per request) is deliberately NOT in
// this list: it is deferred until the cheap vocabulary is drained, so a
// 5-credit holder call is only scheduled when it is genuinely required to
// continue research — and only when the remaining balance can cover it.
const STAGES = ["core", "extended", "cohorts"];

function recordsFrom(result) {
  return Array.isArray(result?.data?.data) ? result.data.data : [];
}

function wallet(record) {
  return {
    address: record.address ?? null,
    label: record.address_label ?? null,
    boughtVolumeUsd: record.bought_volume_usd ?? null,
    soldVolumeUsd: record.sold_volume_usd ?? null,
    tradeVolumeUsd: record.trade_volume_usd ?? null,
  };
}

function holder(record) {
  return {
    address: record.address ?? null,
    label: record.address_label ?? null,
    tokenAmount: record.token_amount ?? null,
    ownershipPercentage: record.ownership_percentage ?? null,
    valueUsd: record.value_usd ?? null,
  };
}

function flowIntelligence(record) {
  return {
    smartTraderNetFlowUsd: record.smart_trader_net_flow_usd ?? null,
    smartTraderWalletCount: record.smart_trader_wallet_count ?? null,
    topPnlNetFlowUsd: record.top_pnl_net_flow_usd ?? null,
    whaleNetFlowUsd: record.whale_net_flow_usd ?? null,
  };
}

function mergeWallets(existing, incoming) {
  const seen = new Set(existing.map((item) => item.address));
  for (const item of incoming) {
    if (!item.address || seen.has(item.address)) continue;
    seen.add(item.address);
    existing.push(item);
  }
}

function researchTask(token, kind, body, windowDays, maxPage, variant = null) {
  const page = body.pagination?.page ?? 1;
  return {
    token,
    key: `${token.chain}:${token.contractAddress}`,
    kind,
    variant,
    endpoint: RESEARCH_ENDPOINTS[kind],
    body,
    page,
    perPage: body.pagination?.per_page ?? 0,
    windowDays,
    maxPage,
    deep: maxPage > 0 && page < maxPage,
  };
}

/**
 * The single source of truth for campaign request bodies. Both the planner
 * (stage tasks and deeper pages) and the ledger-repair tool build requests
 * through this function, so a reconstructed body always hashes to the exact
 * cache key of the request that was actually sent.
 *
 * - `variant: null` is the base shape (all Smart Money labels, min $1 trade,
 *   plain holders) at the given window — byte-identical to
 *   `createResearchRequests`.
 * - `label:<name>` restricts include_smart_money_labels to one cohort.
 * - `volume:<usd>` raises the minimum trade-size tier.
 * - holder variants flip the request's own aggregate_by_entity /
 *   premium_labels booleans (both already sent as `false`, so `true` values
 *   are valid for the same parameter).
 */
export function researchBodyFor(token, now, {
  kind,
  windowDays = CORE_WINDOW_DAYS,
  variant = null,
  page = 1,
} = {}) {
  const requests = createResearchRequests(token, now);
  if (kind === "flowIntelligence") return requests.flowIntelligence;

  let body;
  if (kind === "holders") {
    body = { ...requests.holders };
    if (variant === "entity-aggregate") body.aggregate_by_entity = true;
    else if (variant === "entity-premium") body.premium_labels = true;
    else if (variant === "entity-aggregate-premium") {
      body.aggregate_by_entity = true;
      body.premium_labels = true;
    }
    return { ...body, pagination: { ...body.pagination, page } };
  }

  // buyers | sellers | flows: the base shape already carries the 7-day
  // window; wider horizons only swap the date range.
  body = requests[kind];
  if (windowDays !== CORE_WINDOW_DAYS) {
    body = { ...body, date: dateRange(now, windowDays) };
  }
  if (typeof variant === "string" && variant.startsWith("label:")) {
    body = {
      ...body,
      filters: { ...body.filters, include_smart_money_labels: [variant.slice("label:".length)] },
    };
  } else if (typeof variant === "string" && variant.startsWith("volume:")) {
    body = {
      ...body,
      filters: { ...body.filters, trade_volume_usd: { min: Number(variant.slice("volume:".length)) } },
    };
  }
  return { ...body, pagination: { ...body.pagination, page } };
}

function nextPageTask(task) {
  return {
    ...task,
    page: task.page + 1,
    body: { ...task.body, pagination: { ...task.body.pagination, page: task.page + 1 } },
  };
}

function stageTasks(stage, token, now) {
  if (stage === "core") {
    return [
      researchTask(token, "buyers", researchBodyFor(token, now, { kind: "buyers", windowDays: 7 }), 7, WBS_PAGE_LIMIT),
      researchTask(token, "sellers", researchBodyFor(token, now, { kind: "sellers", windowDays: 7 }), 7, WBS_PAGE_LIMIT),
      researchTask(token, "flowIntelligence", researchBodyFor(token, now, { kind: "flowIntelligence", windowDays: 1 }), 1, 0),
      researchTask(token, "flows", researchBodyFor(token, now, { kind: "flows", windowDays: 7 }), 7, FLOWS_PAGE_LIMIT),
    ];
  }
  if (stage === "extended") {
    // Wider research windows built from the same proven request shapes as the
    // core calls, only the date range differs: genuine, distinct, useful.
    // The 7-day window is already covered by the core stage.
    const tasks = [];
    for (const days of RESEARCH_WINDOWS) {
      if (days === CORE_WINDOW_DAYS) continue;
      for (const kind of ["flows", "buyers", "sellers"]) {
        const maxPage = kind === "flows" ? FLOWS_PAGE_LIMIT : WBS_PAGE_LIMIT;
        tasks.push(researchTask(token, kind, researchBodyFor(token, now, { kind, windowDays: days }), days, maxPage));
      }
    }
    return tasks;
  }
  if (stage === "holders") {
    return HOLDER_VARIANTS.map((variant) => researchTask(
      token,
      "holders",
      researchBodyFor(token, now, { kind: "holders", variant }),
      0,
      HOLDERS_PAGE_LIMIT,
      variant,
    ));
  }
  // Cohort stage: one task per (side, window, cohort). Every body differs
  // from the base shape by a single proven filter value, so each request is
  // distinct, valid, and answers a different research question.
  const tasks = [];
  for (const kind of ["buyers", "sellers"]) {
    for (const days of RESEARCH_WINDOWS) {
      for (const label of SMART_MONEY_LABELS) {
        const variant = `label:${label}`;
        tasks.push(researchTask(token, kind, researchBodyFor(token, now, { kind, windowDays: days, variant }), days, WBS_PAGE_LIMIT, variant));
      }
      for (const tier of COHORT_VOLUME_TIERS) {
        const variant = `volume:${tier}`;
        tasks.push(researchTask(token, kind, researchBodyFor(token, now, { kind, windowDays: days, variant }), days, WBS_PAGE_LIMIT, variant));
      }
    }
  }
  return tasks;
}

function createEntry(token) {
  return {
    token,
    buyers: [],
    sellers: [],
    flowIntelligence: [],
    flowPoints: 0,
    flowPoints30d: 0,
    flowPointsByWindow: {},
    holders: [],
    walletWindowCounts: { buyers30d: 0, sellers30d: 0, buyers90d: 0, sellers90d: 0 },
    cohortRecordCounts: {},
    failures: [],
  };
}

/**
 * One controlled Live Scan 2 cycle.
 *
 * Budget accounting:
 * - `callBudget` (optional) is the live hard-cap handle (usage() =>
 *   { limit, calls, remainingCalls }). Every real outbound attempt,
 *   including 429 retries, decrements it at the send guard.
 * - `creditBudget` (optional) guards actual credit spend and makes the
 *   planner credit-aware: holder requests (5 credits each) are deferred
 *   behind the whole 1-credit vocabulary, and a request is never sent when
 *   its documented credit cost would exceed the remaining balance (`Nansen
 *   credits left (last call)` style accounting, with a small safety reserve
 *   kept by the caller). The run stops as soon as even the cheapest request
 *   cannot be afforded.
 * - `creditSafetyReserve` is only reported; the caller subtracts it from the
 *   known balance when sizing `creditBudget`'s limit.
 * - Requests served from cache, skipped tasks, requests refused by a
 *   budget guard, and requests answered from the request ledger
 *   (`nansenClient.inspect`) never reach the network and never consume
 *   the call budget.
 * - `callsRemaining` is the hard maximum for THIS cycle: the caller
 *   passes whatever is left of `API_CALL_LIMIT` (e.g. 599 after 276
 *   calls were already made), so request number `runCallLimit + 1` can
 *   never leave the process.
 *
 * Cross-cycle deduplication:
 * - When the client exposes `inspect(endpoint, body)` (the cached client
 *   does), a request that was already made in an earlier cycle is
 *   answered from its stored response instead of being repeated: the
 *   records still feed the research result, and pagination continues at
 *   the first page that was never requested.
 * - A repaired ledger entry (`inspect().dataLost === true`) means the
 *   request was sent but its response body was lost to a ledger write
 *   failure: it is never repeated either, and pagination continues one
 *   page deeper based on that next page's own result.
 *
 * The run always stops with a `stopReason` explaining why fewer than the
 * full budget was used, if that happens.
 */
export async function runEligibilityCampaign(nansenClient, {
  creditLimit: _creditLimit = 200, // retained for API compatibility; the run budget is call-based
  callsRemaining = API_CALL_TARGET,
  callBudget = null,
  creditBudget = null,
  creditSafetyReserve = CREDIT_SAFETY_RESERVE,
  concurrency,
  now = new Date(),
} = {}) {
  const startedAt = performance.now();
  const runCallLimit = Math.max(1, Math.min(
    API_CALL_LIMIT,
    Math.floor(callsRemaining),
    callBudget?.usage()?.limit ?? Number.POSITIVE_INFINITY,
  ));

  const entries = new Map();
  const pairSuccess = new Map();
  const dispatchedTokens = new Set();
  const disabledShapes = new Set();
  const taskQueue = [];
  const queuedRequestKeys = new Set();
  const seen = new Set();
  const tokens = [];

  let stopReason = null;
  let stagesQueued = false;
  let holdersQueued = false;
  let nextPage = 1;
  let discoveryDone = false;
  let discoveryCause = null;
  let discoveryPages = 0;
  let discoveryPagesReused = 0;
  let postsAttempted = 0;
  let tasksDispatched = 0;
  let tasksSucceeded = 0;
  let tasksSkippedByBudget = 0;
  let tasksReusedFromCache = 0;
  let maximumConcurrentRequests = 0;
  let transportStreak = 0;
  let rateLimitStreak = 0;

  function setStop(reason) {
    if (!stopReason) stopReason = reason;
  }

  // Structural guarantee that no identical (endpoint, body) request is ever
  // scheduled twice within one run, regardless of queue order.
  function enqueue(task) {
    const key = `${task.endpoint}\n${JSON.stringify(task.body)}`;
    if (queuedRequestKeys.has(key)) return false;
    queuedRequestKeys.add(key);
    taskQueue.push(task);
    return true;
  }

  // Read-only lookup into the request ledger. Returns null (i.e. "go live")
  // when the client cannot answer, when the request was never made, or when
  // the ledger itself is unavailable: never a reason to skip work.
  async function inspectPrior(endpoint, body) {
    if (typeof nansenClient.inspect !== "function") return null;
    try {
      return await nansenClient.inspect(endpoint, body);
    } catch {
      return null;
    }
  }

  function remainingCalls() {
    return Math.min(
      callBudget?.usage()?.remainingCalls ?? Number.POSITIVE_INFINITY,
      runCallLimit - postsAttempted,
    );
  }

  function shapeKey(task) {
    // One key per request shape (endpoint + cohort/variant), independent of
    // window or page: a shape Nansen rejects as malformed will be rejected
    // for every token and horizon, so the first rejection disables it all.
    return `${task.kind}:${task.variant ?? "base"}`;
  }

  function canAfford(endpoint) {
    if (!creditBudget) return true;
    return creditBudget.canAfford(CAMPAIGN_CREDIT_COSTS[endpoint] ?? 1);
  }

  function callBudgetReason() {
    return runCallLimit >= API_CALL_LIMIT
      ? `Hard run cap reached: ${runCallLimit} Nansen requests sent for this run.`
      : `Run budget reached: ${runCallLimit} Nansen requests sent for this run (the campaign is capped at ${API_CALL_LIMIT} calls in total).`;
  }

  function creditBudgetReason() {
    const usage = creditBudget.usage();
    const reserve = Number.isFinite(creditSafetyReserve) ? creditSafetyReserve : 0;
    const reserveNote = reserve > 0
      ? ` (the last ${reserve} credits are kept as a safety reserve)`
      : "";
    return `Campaign credit budget exhausted: ${usage.reservedCredits}/${usage.limit} credits reserved${reserveNote}.`;
  }

  function exhaustionReason() {
    const base = discoveryCause ?? "Discovery ended without further qualifying tokens.";
    const skipped = tasksSkippedByBudget > 0
      ? ` ${tasksSkippedByBudget} queued request(s) were skipped by the budget.`
      : "";
    return `${base} No further distinct Nansen research requests were available at the configured depth (research pages up to ${WBS_PAGE_LIMIT}, holder pages up to ${HOLDERS_PAGE_LIMIT}).${skipped}`;
  }

  function classifyFailure(error, task = null) {
    if (error instanceof CallBudgetExceededError) return setStop(callBudgetReason());
    if (error instanceof CreditBudgetExceededError) return setStop(creditBudgetReason());
    if (FATAL_CATEGORIES.has(error?.category)) return setStop(`Early stop: ${error.message}`);
    if (error?.category === "request_schema" && task) {
      // An unrecognised parameter shape will fail for every token: disable
      // this request shape after the first rejection so the rest of the
      // budget is not wasted on identical doomed requests.
      return disabledShapes.add(shapeKey(task));
    }
    if (error?.category === "transport") {
      transportStreak += 1;
      if (transportStreak >= TRANSPORT_FAILURE_LIMIT) {
        setStop(`Stopped after ${TRANSPORT_FAILURE_LIMIT} consecutive network transport failures.`);
      }
      return;
    }
    if (error?.status === 429) {
      rateLimitStreak += 1;
      if (rateLimitStreak >= RATE_LIMIT_FAILURE_LIMIT) {
        setStop(`Stopped after ${RATE_LIMIT_FAILURE_LIMIT} consecutive rate-limited responses after retries were exhausted.`);
      }
    }
  }

  function entryFor(task) {
    let entry = entries.get(task.key);
    if (!entry) {
      entry = createEntry(task.token);
      entries.set(task.key, entry);
    }
    return entry;
  }

  async function discoverNextPage() {
    const request = {
      ...DISCOVERY_REQUEST,
      pagination: { page: nextPage, per_page: DISCOVERY_PAGE_SIZE },
    };
    let result;
    const prior = await inspectPrior(TOKEN_SCREENER_ENDPOINT, request);
    if (prior) {
      // This exact discovery request was already made in an earlier cycle:
      // reuse what it returned instead of repeating the identical call.
      discoveryPagesReused += 1;
      result = { data: prior.data };
    } else {
      if (remainingCalls() < 1) return setStop(callBudgetReason());
      if (!canAfford(TOKEN_SCREENER_ENDPOINT)) return setStop(creditBudgetReason());
      postsAttempted += 1;
      try {
        result = await nansenClient.post(TOKEN_SCREENER_ENDPOINT, request);
      } catch (error) {
        classifyFailure(error);
        if (!stopReason) setStop(`Discovery failed: ${error.message}`);
        return;
      }
      discoveryPages += 1;
    }
    const records = recordsFrom(result);
    let newTokens = 0;
    for (const record of records) {
      const token = normalizeDiscoveredToken(record);
      const key = `${token.chain}:${token.contractAddress}`;
      if (!token.chain || !token.contractAddress || seen.has(key)) continue;
      seen.add(key);
      tokens.push(token);
      newTokens += 1;
    }
    const pagination = result.data?.pagination ?? null;
    if (pagination?.is_last_page === true) {
      discoveryDone = true;
      discoveryCause = "Token discovery reached the last screener page.";
    } else if (records.length === 0) {
      discoveryDone = true;
      discoveryCause = "Token discovery returned no further records.";
    } else if (!pagination && records.length < DISCOVERY_PAGE_SIZE) {
      discoveryDone = true;
      discoveryCause = "Token discovery returned a partial final page.";
    } else if (newTokens === 0) {
      discoveryDone = true;
      discoveryCause = "Token discovery returned no new qualifying tokens.";
    }
    nextPage += 1;
  }

  async function worker(task) {
    if (stopReason) {
      tasksSkippedByBudget += 1;
      return { __skipped: true };
    }
    if (disabledShapes.has(shapeKey(task))) {
      tasksSkippedByBudget += 1;
      return { __skipped: true };
    }
    // Requests already made in an earlier cycle (or earlier in this one) are
    // answered from the request ledger without touching the network: their
    // stored records still feed the research result, and absorb() continues
    // pagination at the first page that was never requested.
    const prior = await inspectPrior(task.endpoint, task.body);
    if (prior) {
      tasksReusedFromCache += 1;
      return {
        data: prior.data,
        dataLost: prior.dataLost === true,
        meta: {
          ...(prior.meta ?? {}),
          source: prior.dataLost === true ? "REPAIRED_LEDGER" : "REUSED_FROM_CACHE",
        },
      };
    }
    if (remainingCalls() < 1) {
      tasksSkippedByBudget += 1;
      return { __skipped: true };
    }
    if (!canAfford(task.endpoint)) {
      tasksSkippedByBudget += 1;
      return { __skipped: true };
    }
    postsAttempted += 1;
    tasksDispatched += 1;
    try {
      const result = await nansenClient.post(task.endpoint, task.body);
      transportStreak = 0;
      rateLimitStreak = 0;
      tasksSucceeded += 1;
      return result;
    } catch (error) {
      classifyFailure(error, task);
      throw error;
    }
  }

  function absorb(task, outcome) {
    if (outcome.status === "fulfilled" && outcome.value?.__skipped) return;
    dispatchedTokens.add(task.key);

    if (outcome.status === "rejected") {
      entryFor(task).failures.push({
        kind: task.kind,
        windowDays: task.windowDays,
        page: task.page,
        message: outcome.reason?.message ?? String(outcome.reason),
      });
      return;
    }

    const records = recordsFrom(outcome.value);
    const entry = entryFor(task);

    if (task.kind === "buyers" || task.kind === "sellers") {
      if (task.windowDays === CORE_WINDOW_DAYS) {
        // Core-window evidence (base shape AND cohort slices of it: the
        // label/tier filters are subsets of the base query, and merged
        // addresses deduplicate automatically).
        mergeWallets(entry[task.kind], records.map(wallet));
        const flags = pairSuccess.get(task.key) ?? { buyers: false, sellers: false };
        flags[task.kind] = true;
        pairSuccess.set(task.key, flags);
      } else if (task.variant) {
        // Cohort windows are counted per cohort so they never inflate the
        // base window counts.
        const cohortKey = `${task.variant}:${task.kind}${task.windowDays}d`;
        entry.cohortRecordCounts[cohortKey] = (entry.cohortRecordCounts[cohortKey] ?? 0) + records.length;
      } else {
        const windowKey = `${task.kind}${task.windowDays}d`;
        entry.walletWindowCounts[windowKey] = (entry.walletWindowCounts[windowKey] ?? 0) + records.length;
      }
    } else if (task.kind === "flowIntelligence") {
      entry.flowIntelligence.push(...records.map(flowIntelligence));
    } else if (task.kind === "flows") {
      if (task.windowDays === CORE_WINDOW_DAYS) {
        if (task.page === 1) entry.flowPoints = records.length;
        else entry.flowPoints += records.length;
      } else {
        entry.flowPointsByWindow[task.windowDays] = (entry.flowPointsByWindow[task.windowDays] ?? 0) + records.length;
        if (task.windowDays === 30) entry.flowPoints30d = entry.flowPointsByWindow[30];
      }
    } else if (task.kind === "holders") {
      mergeWallets(entry.holders, records.map(holder));
    }

    // Keep paginating only while Nansen returns full pages: deeper pages are
    // requested only when more real records exist. Reused (already-made)
    // pages take the same path, which is how depth resumes at the first
    // unseen page instead of repeating earlier ones. A repaired ledger entry
    // (`dataLost`) proves the request WAS made but its response body was
    // lost, so its record count is unknown: continue one page deeper rather
    // than repeating it, and let that page's own result (full, partial or
    // empty) terminate the chain honestly.
    const lostResponse = outcome.value?.dataLost === true;
    if (task.deep && task.perPage > 0 && task.page < task.maxPage
      && (lostResponse || records.length >= task.perPage)) {
      enqueue(nextPageTask(task));
    }
  }

  while (true) {
    if (stopReason) break;
    if (remainingCalls() < 1) {
      setStop(callBudgetReason());
      break;
    }
    if (creditBudget && !creditBudget.canAfford(1)) {
      setStop(creditBudgetReason());
      break;
    }

    if (taskQueue.length === 0) {
      if (!discoveryDone) {
        await discoverNextPage();
        continue;
      }
      if (!stagesQueued) {
        // Queue every 1-credit stage up front (the cheap vocabulary extends
        // far beyond any plausible balance, so it always drains first). Only
        // after it is fully drained — and no full page is still producing
        // deeper work — does the planner consider the 5-credit holder stage.
        stagesQueued = true;
        for (const stage of STAGES) {
          for (const token of tokens) {
            for (const task of stageTasks(stage, token, now)) enqueue(task);
          }
        }
        continue;
      }
      if (!holdersQueued) {
        // The 1-credit vocabulary is exhausted. Holder depth is the only
        // remaining shape, so it is genuinely required to continue — but it
        // is still only scheduled if the remaining balance covers the 5-credit
        // cost, so a request whose documented credit cost exceeds the balance
        // can never be planned.
        if (creditBudget && !creditBudget.canAfford(HOLDER_CREDIT_COST)) {
          setStop(creditBudgetReason());
          break;
        }
        holdersQueued = true;
        for (const token of tokens) {
          for (const task of stageTasks("holders", token, now)) enqueue(task);
        }
        continue;
      }
      setStop(exhaustionReason());
      break;
    }

    const allowance = remainingCalls();
    const batch = taskQueue.splice(0, Math.min(taskQueue.length, allowance));
    const pool = await mapWithConcurrency(batch, worker, { concurrency });
    maximumConcurrentRequests = Math.max(maximumConcurrentRequests, pool.maximumConcurrentRequests);
    for (const [index, outcome] of pool.results.entries()) {
      absorb(batch[index], outcome);
    }
  }

  const allEntries = [...entries.values()];
  const researchedTokens = allEntries.filter(
    (item) => item.buyers.length > 0 && item.sellers.length > 0,
  );
  const rotations = detectRotations(researchedTokens);
  const researchFailures = allEntries
    .filter((item) => item.failures.length > 0)
    .map((item) => ({ token: item.token, failures: item.failures }));

  return {
    campaignStartedAt: now.toISOString(),
    campaignCompletedAt: new Date().toISOString(),
    durationMs: performance.now() - startedAt,
    targetApiCalls: API_CALL_TARGET,
    apiCallLimit: API_CALL_LIMIT,
    runCallLimit,
    logicalCallsAttempted: postsAttempted,
    creditLimit: creditBudget?.usage()?.limit ?? null,
    creditSafetyReserve,
    researchRequestsDispatched: tasksDispatched,
    researchRequestsSucceeded: tasksSucceeded,
    researchRequestsSkippedByBudget: tasksSkippedByBudget,
    researchRequestsReusedFromCache: tasksReusedFromCache,
    discoveryPages,
    discoveryPagesReused,
    stopReason: stopReason ?? "Run ended without a recorded stop reason.",
    tokensDiscovered: tokens.length,
    tokensPairedForResearch: [...pairSuccess.values()].filter((pair) => pair.buyers && pair.sellers).length,
    tokensWithWalletEvidence: researchedTokens.length,
    tokensSkippedByBudget: tokens.length - dispatchedTokens.size,
    maximumConcurrentRequests,
    researchedTokens,
    researchFailures,
    rotations,
  };
}
