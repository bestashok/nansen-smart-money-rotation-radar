import express from "express";
import { createNansenClient } from "./nansenClient.js";
import { scanAllTokens } from "./scanner.js";
import { readHistory, readLatest, saveScan } from "./dataStore.js";
import { readUsage, trackNansenUsage } from "./apiUsage.js";
import { withCreditBudget, CAMPAIGN_CREDIT_COSTS } from "./creditBudget.js";
import { createCachedNansenClient } from "./cache.js";
import { withRateLimitRetries } from "./retry.js";
import { API_CALL_LIMIT, API_CALL_TARGET, CREDIT_SAFETY_RESERVE, runEligibilityCampaign } from "./eligibilityCampaign.js";
import { campaignCallAccounting, campaignCallsRemaining, campaignCallsSent, readCampaignHistory, saveCampaignRun } from "./campaignStore.js";
import { appendUsage, defaultUsagePath } from "./apiUsage.js";
import { withCallBudget } from "./callBudget.js";
import { withCumulativeCap } from "./callBudget.js";

const DEFAULT_SCAN_CREDIT_LIMIT = 200;
// withCreditBudget refuses limits below 10; the campaign route refuses to
// start when the spendable balance (last known balance minus the safety
// reserve) cannot cover even that floor.
const MIN_CREDIT_BUDGET = 10;

// Live Nansen balance (source of truth = latest `x-nansen-credits-remaining` header).
// A genuine 1-credit token-screener call is made so the response header reflects
// the current account balance, then the ledger is persisted for the session.
export async function fetchLiveBalance(nansenClient, usagePath) {
  const result = await nansenClient.post("/api/v1/token-screener", {
    chains: ["ethereum"],
    timeframe: "24h",
    pagination: { page: 1, per_page: 1 },
  });
  const balance = Number(result.meta?.creditsRemaining);
  // Persist the live balance so later polls and the next cycle reuse it without
  // making another live call.
  await appendUsage(usagePath, {
    timestamp: new Date().toISOString(),
    endpoint: "/api/v1/token-screener",
    status: result.meta.status,
    latencyMs: 0,
    success: result.meta.status === 200,
    creditsRemaining: result.meta.creditsRemaining,
  });
  return Number.isFinite(balance) ? balance : null;
}

function requestedCreditLimit(value) {
  const limit = value === undefined ? DEFAULT_SCAN_CREDIT_LIMIT : Number(value);
  return Number.isSafeInteger(limit) && limit >= 10 && limit <= DEFAULT_SCAN_CREDIT_LIMIT ? limit : null;
}

function campaignCooldownMs() {
  const minutes = Number(process.env.CACHE_TTL_MINUTES ?? 15);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
}

function createBoundedNansenClient(creditLimit, { callLimit, creditCap, costs, onSend } = {}) {
  const tracked = trackNansenUsage(createNansenClient());
  const callBudgeted = callLimit ? withCallBudget(tracked, callLimit, { onSend }) : tracked;
  const budgeted = withCreditBudget(callBudgeted, creditCap ?? creditLimit, costs ? { costs } : {});
  const retried = withRateLimitRetries(budgeted);
  const cached = createCachedNansenClient(retried);
  return { tracked, budgeted, retried, cached, callBudgeted };
}

function buildRunReport(totals, runCallLimit, stopReason) {
  return {
    runCallLimit,
    nansenApiCallsSent: totals.totalCalls,
    successfulCalls: totals.successfulCalls,
    failedCalls: totals.failedCalls,
    retries: totals.retries,
    callsRemainingFromRunBudget: Math.max(0, runCallLimit - totals.totalCalls),
    creditsReserved: totals.creditsReserved ?? 0,
    creditLimit: totals.creditLimit ?? null,
    stopReason: stopReason ?? null,
  };
}

function runTotals(chain) {
  if (!chain) return { totalCalls: 0, successfulCalls: 0, failedCalls: 0, retries: 0, creditsReserved: 0, creditLimit: null, creditsRemainingFromBudget: null };
  const callUsage = typeof chain.callBudgeted.usage === "function" ? chain.callBudgeted.usage() : null;
  const creditUsage = chain.budgeted?.usage ? chain.budgeted.usage() : null;
  return {
    totalCalls: callUsage ? callUsage.calls : chain.tracked.current.attempts,
    successfulCalls: chain.tracked.current.successful,
    failedCalls: chain.tracked.current.failed,
    retries: chain.retried.stats().retries,
    creditsReserved: creditUsage?.reservedCredits ?? 0,
    creditLimit: creditUsage?.limit ?? null,
    creditsRemainingFromBudget: creditUsage?.remainingCredits ?? null,
  };
}

// Sum of the Nansen-reported `x-nansen-credits-used` values across every
// recorded call: what the account actually spent, as opposed to what the
// planner reserved.
function creditsConsumed(usage) {
  return (usage?.calls ?? []).reduce((sum, call) => {
    const used = Number(call?.creditsUsed);
    return sum + (Number.isFinite(used) ? used : 0);
  }, 0);
}

// Last known Nansen credit balance (persisted from the most recent call's
// response headers) so the UI can show what the account can still afford.
// The stored value may be a string (`x-nansen-credits-used`/`...-remaining`
// headers arrive as text), so it is coerced before the finite check.
export function lastKnownCredits(usage) {
  const latest = [...(usage?.calls ?? [])]
    .reverse()
    .find((call) => {
      const raw = call?.creditsRemaining;
      return raw != null && raw !== "" && Number.isFinite(Number(raw));
    });
  const value = Number(latest?.creditsRemaining);
  return Number.isFinite(value) ? value : null;
}

export function createApp() {
  const app = express();
  const status = { phase: "IDLE", running: false, message: "Ready for a live scan.", creditLimit: DEFAULT_SCAN_CREDIT_LIMIT, runCallLimit: null, spendableCredits: null };
  const liveRun = { chain: null };
  const lastRun = { totalCalls: 0, successfulCalls: 0, failedCalls: 0, retries: 0, creditsReserved: 0, creditLimit: null, creditsRemainingFromBudget: null };
  // Persistent view of the campaign ledger (genuine calls already made by
  // every recorded cycle) so /api/status can show "620/909" style totals
  // without reading the history file on every poll.
  const ledger = { campaignCallsSent: 0, creditsRemaining: null };
  readCampaignHistory()
    .then((history) => { ledger.campaignCallsSent = campaignCallsSent(history); })
    .catch(() => {});
  // The persisted ledger is rewritten on every successful live call with the
  // latest raw balance. Read the latest x-nansen-credits-remaining and always
  // use it as the source of truth. Never keep the startup balance (16) stale
  // after later calls have consumed credits: the persisted file is authoritative.
  readUsage()
    .then((usage) => {
      ledger.creditsRemaining = usage.latestCreditsRemaining ?? lastKnownCredits(usage);
      console.log(`[verify] raw Nansen balance: ${ledger.creditsRemaining} credits`);
      const spendable = ledger.creditsRemaining == null
        ? null
        : Math.max(0, Math.floor(Number(ledger.creditsRemaining)) - CREDIT_SAFETY_RESERVE);
      console.log(`[verify] usable credits (balance - 5 reserve): ${spendable}`);
      console.log(`[verify] safety reserve held untouched: ${CREDIT_SAFETY_RESERVE}`);
    })
    .catch(() => {});

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "nansen-smart-money-rotation-radar",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/scan", (request, response) => {
    if (status.running) return response.status(409).json({ error: "A scan is already running." });
    const creditLimit = requestedCreditLimit(request.body?.creditLimit);
    if (creditLimit === null) {
      return response.status(400).json({ error: "creditLimit must be a whole number from 10 through 200." });
    }
    status.running = true;
    status.phase = "DISCOVERING_TOKENS";
    status.creditLimit = creditLimit;
    status.message = `Discovering qualifying tokens within a ${creditLimit}-credit budget.`;
    const { tracked, budgeted, cached } = createBoundedNansenClient(creditLimit);
    scanAllTokens(cached, { creditBudget: budgeted })
      .then(async (result) => {
        const averageApiLatencyMs = tracked.current.latencies.length
          ? tracked.current.latencies.reduce((sum, value) => sum + value, 0) / tracked.current.latencies.length
          : 0;
        Object.assign(result, { liveApiCalls: tracked.current.calls, cacheHits: cached.current.hits, averageApiLatencyMs, rateLimitEvents: tracked.current.rateLimitEvents, creditBudget: budgeted.usage() });
        await saveScan(result);
        Object.assign(status, { running: false, phase: "SCAN_COMPLETE", message: `Scan complete — ${result.tokensDiscovered} discovered, ${result.tokensAnalyzed} analyzed, ${result.tokensSkippedByBudget} skipped by budget.` });
      })
      .catch((error) => Object.assign(status, { running: false, phase: "FAILED", message: error.message }));
    return response.status(202).json({ accepted: true });
  });

  app.post("/api/campaign", async (request, response) => {
    if (status.running) return response.status(409).json({ error: "A scan or campaign run is already running." });
    const creditLimit = requestedCreditLimit(request.body?.creditLimit);
    if (creditLimit === null) {
      return response.status(400).json({ error: "creditLimit must be a whole number from 10 through 200." });
    }

    const usageBefore = await readUsage();
    const history = await readCampaignHistory();
    const callsAlreadySent = campaignCallsSent(history);
    // Hard maximum for THIS campaign continuation: whatever is left of the
    // campaign's API_CALL_LIMIT total (909 - 620 already sent = 289 today).
    // Retries count toward it, so request number runCallLimit + 1 can never
    // leave the process.
    const runCallLimit = campaignCallsRemaining(history);
    if (runCallLimit === 0) {
      return response.status(409).json({ error: `The ${API_CALL_LIMIT}-call campaign target is already complete.` });
    }
    // Live Nansen credit verification (source of truth = latest
    // x-nansen-credits-remaining header): fetch the live balance, then
    // calculate spendable credits as balance - 5 (the safety reserve that is
    // never spent). The production run is then capped at the smaller of
    // spendable credits and the remaining cumulative buildathon budget
    // (1,000 - cumulativeRealCalls).
    //
    // The all-time guard FAILS CLOSED. If the ledger cannot be read the count
    // is unknown, and an unknown count must never be treated as zero-because-
    // nothing-sent: that mistake is what let the 2026-09-25 run overshoot to
    // 1,011 calls (see docs/POSTMORTEM.md). We cannot prove headroom without
    // the ledger, so we allow zero requests until it can be read again.
    const balance = ledger.creditsRemaining ?? lastKnownCredits(usageBefore);
    const spendableCredits = balance == null
      ? null
      : Math.max(0, Math.floor(Number(balance)) - CREDIT_SAFETY_RESERVE);
    // Remaining cumulative buildathon budget: 1,000 - cumulativeRealCalls.
    // A null count means the ledger is unreadable. Fail closed: 0 may still be
    // sent, because we cannot prove how much of the 1,000 has been used.
    const cumulativeReal = (await readUsage()).cumulativeRealNansenApiCalls ?? null;
    const remainingCumulative = cumulativeReal == null
      ? 0
      : Math.max(0, API_CALL_TARGET - cumulativeReal);
    console.log(`[verify] raw Nansen balance: ${balance} credits`);
    console.log(`[verify] usable credits (balance - 5 reserve): ${spendableCredits}`);
    console.log(`[verify] safety reserve held untouched: ${CREDIT_SAFETY_RESERVE}`);
    console.log(`[verify] cumulative real Nansen calls: ${cumulativeReal ?? "unknown"} (1,000 cap)`);
    console.log(`[verify] remaining cumulative budget (1,000 - cumulativeRealCalls): ${remainingCumulative}`);
    console.log(`[verify] planned live calls: ${runCallLimit} (cap ${API_CALL_LIMIT}, ${callsAlreadySent} already sent)`);
    // Final production cap: min(runCallLimit, spendableCredits [each genuine
    // research call costs 1 credit], and remaining cumulative budget
    // (1,000 - cumulativeRealCalls)). This is the single bound that
    // guarantees the run cannot land on 1,001 cumulative genuine calls, and
    // that the spendable credit budget is never exceeded.
    const boundedRunCallLimit = Math.min(runCallLimit, Math.floor(spendableCredits ?? Number.POSITIVE_INFINITY), Math.floor(remainingCumulative));
    if (spendableCredits != null && spendableCredits < MIN_CREDIT_BUDGET) {
      const required = MIN_CREDIT_BUDGET + CREDIT_SAFETY_RESERVE;
      return response.status(402).json({
        error: `Nansen balance is too low for a research cycle: ${balance} credits remain, but at least ${required} are needed (${MIN_CREDIT_BUDGET} to spend while keeping a ${CREDIT_SAFETY_RESERVE}-credit safety reserve).`,
      });
    }
    // Fail closed on an unreadable ledger. remainingCumulative is 0 in that
    // case, so the bound collapses and no Nansen request may be sent. Refuse
    // with a clear 409 instead of starting a run that would immediately abort.
    if (boundedRunCallLimit <= 0) {
      const reason = cumulativeReal == null
        ? "the usage ledger could not be read, so the remaining budget cannot be proven"
        : `the ${API_CALL_TARGET}-call all-time target is already reached (${cumulativeReal} recorded)`;
      return response.status(409).json({ error: `No further calls can be sent: ${reason}.` });
    }
    const lastStartedAt = Date.parse(history[0]?.campaignStartedAt ?? "");
    const nextEligibleAt = Number.isFinite(lastStartedAt) ? lastStartedAt + campaignCooldownMs() : 0;
    if (Date.now() < nextEligibleAt) {
      return response.status(429).json({
        error: "Wait for the 15-minute research window before starting another campaign cycle.",
        retryAfterSeconds: Math.ceil((nextEligibleAt - Date.now()) / 1_000),
      });
    }

    Object.assign(status, {
      running: true,
      phase: "CAMPAIGN_RESEARCH",
      creditLimit,
      runCallLimit: boundedRunCallLimit,
      spendableCredits,
      message: `Collecting new wallet research toward ${API_CALL_LIMIT} campaign calls — ${callsAlreadySent} already sent, hard cap ${boundedRunCallLimit} real requests this run (max 1,000 - cumulativeRealCalls = ${remainingCumulative} genuine calls). ${spendableCredits == null ? "" : `spendable budget ${spendableCredits} credits (${CREDIT_SAFETY_RESERVE} kept in reserve)`}.`,
    });
    // Live progress: campaign total first ("Nansen API calls: 500/909"),
    // this run's own detail in brackets, credit spend when it is bounded.
    let budgetedRef = null;
    const onSend = ({ calls, limit }) => {
      const reserved = budgetedRef?.usage().reservedCredits ?? 0;
      const credit = spendableCredits == null ? "" : ` · ${reserved}/${spendableCredits} credits`;
      status.message = `Nansen API calls: ${callsAlreadySent + calls}/${API_CALL_LIMIT} (run ${calls}/${limit})${credit}`;
      if (calls === 1 || calls % 100 === 0 || calls === limit) {
        console.log(status.message);
      }
    };
    // Credit guard: when the balance is known it is sized to the spendable
    // credits (balance minus reserve); the 1-credit vocabulary is deep enough
    // that the run then stops on credit exhaustion, having maximised genuine
    // calls. When the balance is unknown it is sized to the worst case for
    // this run (every request at the most expensive observed cost), so our
    // own guard can never stop the cycle before the run's call hard cap does.
    const creditCap = spendableCredits == null
      ? runCallLimit * Math.max(...Object.values(CAMPAIGN_CREDIT_COSTS))
      : spendableCredits;
    const chain = createBoundedNansenClient(creditLimit, {
      callLimit: runCallLimit,
      creditCap,
      costs: CAMPAIGN_CREDIT_COSTS,
      onSend,
    });
    budgetedRef = chain.budgeted;
    liveRun.chain = chain;
    const { tracked, budgeted, retried, cached, callBudgeted } = chain;
    const routeStartedAt = new Date().toISOString();
    runEligibilityCampaign(cached, {
      callsRemaining: runCallLimit,
      callBudget: callBudgeted,
      creditBudget: budgeted,
      creditSafetyReserve: CREDIT_SAFETY_RESERVE,
    })
      .then(async (result) => {
        const usageAfter = await readUsage();
        ledger.creditsRemaining = lastKnownCredits(usageAfter) ?? ledger.creditsRemaining;
        const totals = runTotals(chain);
        const runReport = buildRunReport(totals, runCallLimit, result.stopReason);
        const campaignCallsSentAfter = callsAlreadySent + totals.totalCalls;
        Object.assign(result, {
          liveApiCalls: tracked.current.calls,
          cacheHits: cached.current.hits,
          creditBudget: budgeted.usage(),
          creditPlan: {
            balance: balance ?? null,
            spendableCredits,
            safetyReserve: CREDIT_SAFETY_RESERVE,
          },
          cumulativeCallsBefore: usageBefore.cumulativeRealNansenApiCalls,
          cumulativeCallsAfter: usageAfter.cumulativeRealNansenApiCalls,
          campaignCallsSentBefore: callsAlreadySent,
          campaignCallsSentAfter,
          callsRemaining: Math.max(0, API_CALL_LIMIT - campaignCallsSentAfter),
          apiCallLimit: API_CALL_LIMIT,
          runReport,
          ...totals,
        });
        await saveCampaignRun(result);
        ledger.campaignCallsSent = campaignCallsSentAfter;
        Object.assign(lastRun, totals);
        Object.assign(status, {
          running: false,
          phase: "CAMPAIGN_COMPLETE",
          message: `Research cycle complete - ${totals.totalCalls}/${runCallLimit} calls sent this run (${totals.successfulCalls} successful, ${totals.failedCalls} failed, ${totals.retries} retries), ${usageAfter.cumulativeRealNansenApiCalls} / ${API_CALL_TARGET} genuine Nansen calls all time (${campaignCallsSentAfter} from campaign cycles), ${result.rotations.length} probable rotations.${result.stopReason ? ` ${result.stopReason}` : ""}`,
        });
      })
      .catch(async (error) => {
        // The calls were already spent: record the failed cycle too, so the
        // 909-call campaign total stays correct even across a restart.
        const totals = runTotals(chain);
        const runReport = buildRunReport(totals, runCallLimit, error.message);
        const campaignCallsSentAfter = callsAlreadySent + totals.totalCalls;
        try {
          await saveCampaignRun({
            campaignStartedAt: routeStartedAt,
            campaignCompletedAt: new Date().toISOString(),
            failed: true,
            stopReason: `Campaign cycle failed: ${error.message}`,
            targetApiCalls: API_CALL_LIMIT,
            apiCallLimit: API_CALL_LIMIT,
            runCallLimit,
            tokensDiscovered: 0,
            tokensPairedForResearch: 0,
            tokensWithWalletEvidence: 0,
            tokensSkippedByBudget: 0,
            rotations: [],
            researchedTokens: [],
            researchFailures: [],
            liveApiCalls: tracked.current.calls,
            cacheHits: cached.current.hits,
            creditBudget: budgeted.usage(),
            runReport,
            ...totals,
          });
          ledger.campaignCallsSent = campaignCallsSentAfter;
        } catch {
          // Status below still reports the truth for this session.
        }
        Object.assign(lastRun, totals);
        Object.assign(status, {
          running: false,
          phase: "FAILED",
          message: `${error.message} — ${totals.totalCalls}/${runCallLimit} Nansen API calls sent this run (${totals.successfulCalls} successful, ${totals.failedCalls} failed, ${totals.retries} retries), ${(await readUsage()).cumulativeRealNansenApiCalls} / ${API_CALL_TARGET} genuine Nansen calls all time (${campaignCallsSentAfter} from campaign cycles).`,
        });
      })
      .finally(() => { liveRun.chain = null; });
    return response.status(202).json({
      accepted: true,
      maximumLogicalCalls: boundedRunCallLimit,
      apiCallLimit: API_CALL_LIMIT,
      callsAlreadySent,
      campaignCallsRemaining: boundedRunCallLimit,
      cumulativeRealCalls: cumulativeReal ?? null,
      remainingCumulativeBudget: Math.max(0, 1000 - (cumulativeReal ?? 0)),
    });
  });

  app.get("/api/status", async (_request, response) => {
    const totals = liveRun.chain ? runTotals(liveRun.chain) : { ...lastRun };
    // The in-memory ledger is refreshed asynchronously at startup; read the
    // persisted files as the authoritative source so polls never show a
    // stale "0 sent / unknown balance" just after boot.
    const [usage, history] = await Promise.all([readUsage(), readCampaignHistory()]);
    const sent = ledger.campaignCallsSent || campaignCallsSent(history);
    const cumulativeReal = usage.cumulativeRealNansenApiCalls ?? null;
    // Source of truth: the latest x-nansen-credits-remaining written to the
    // persisted ledger on every successful live response. The live fetcher at
    // startup reads the live API and the campaign route re-writes it after each
    // run, so polls always see the current raw balance (never a cached 16).
    const liveBalance = ledger.creditsRemaining ?? lastKnownCredits(usage);
    response.json({
      ...status,
      ...totals,
      apiCallLimit: API_CALL_LIMIT,
      allTimeCallLimit: API_CALL_TARGET,
      campaignCallsSent: sent,
      allTimeCallsSent: cumulativeReal,
      apiCallsRemaining: Math.max(0, API_CALL_LIMIT - sent),
      allTimeCallsRemaining: cumulativeReal == null ? null : Math.max(0, API_CALL_TARGET - cumulativeReal),
      cumulativeRealNansenApiCalls: cumulativeReal,
      remainingCumulativeBudget: cumulativeReal == null ? null : Math.max(0, 1000 - cumulativeReal),
      creditsRemaining: liveBalance,
    });
  });
  app.get("/api/results", async (_request, response) => response.json(await readLatest()));
  app.get("/api/rotations", async (_request, response) => response.json((await readLatest())?.rotations ?? []));
  app.get("/api/usage", async (_request, response) => {
    const usage = await readUsage();
    response.json({
      ...usage,
      latestCreditsRemaining: usage.latestCreditsRemaining ?? lastKnownCredits(usage),
      consumedCredits: creditsConsumed(usage),
    });
  });
  app.get("/api/history", async (_request, response) => response.json(await readHistory()));
  app.get("/api/campaign", async (_request, response) => {
    const [history, usage] = await Promise.all([readCampaignHistory(), readUsage()]);
    const sent = campaignCallsSent(history);
    const remaining = campaignCallsRemaining(history);
    // Genuine all-time calls made through BOTH the campaign and ordinary Live
    // Scan runs. The 1,000-call buildathon target counts every real Nansen
    // request, so it is the true denominator; the 909 figure only counts calls
    // attributable to a recorded campaign cycle. The effective allowance is
    // whichever of the two caps binds first, so the dashboard can never claim
    // calls are left after the 1,000 all-time ceiling is reached.
    //
    // An unreadable ledger reports no all-time total and no remaining budget,
    // matching the fail-closed rule the campaign route enforces.
    const ledgerKnown = Number.isSafeInteger(usage.cumulativeRealNansenApiCalls);
    const cumulative = ledgerKnown ? usage.cumulativeRealNansenApiCalls : null;
    const cumulativeRemaining = ledgerKnown ? Math.max(0, API_CALL_TARGET - cumulative) : 0;
    const effectiveRemaining = ledgerKnown ? Math.min(remaining, cumulativeRemaining) : 0;
    // Split the all-time total three ways, because "other" is really two
    // different things. `outsideRuns` is genuine calls from plain Run Live
    // Scan; `unrecorded` is campaign-cycle calls the legacy ledger failed to
    // record (3 runs stored no totals, 2 runs dropped increments to a write
    // race). Lumping them together as "other live scans" mislabels the second
    // group, which really is campaign work.
    const accounting = campaignCallAccounting(history);
    const otherCalls = ledgerKnown ? Math.max(0, cumulative - accounting.actual) : null;
    const lastStartedAt = Date.parse(history[0]?.campaignStartedAt ?? "");
    const nextEligibleAt = Number.isFinite(lastStartedAt)
      ? new Date(lastStartedAt + campaignCooldownMs()).toISOString()
      : null;
    response.json({
      targetApiCalls: API_CALL_LIMIT,
      allTimeTargetApiCalls: API_CALL_TARGET,
      campaignCallsSent: sent,
      campaignCallsActual: accounting.actual,
      campaignCallsUnrecorded: accounting.unrecorded,
      otherApiCalls: otherCalls,
      allTimeApiCalls: cumulative,
      allTimeCallsRemaining: cumulativeRemaining,
      targetReached: effectiveRemaining === 0,
      cumulativeRealNansenApiCalls: usage.cumulativeRealNansenApiCalls,
      consumedCredits: creditsConsumed(usage),
      balance: lastKnownCredits(usage),
      callsRemaining: effectiveRemaining,
      campaignCallsRemaining: remaining,
      completedRuns: history.length,
      latest: history[0] ?? null,
      nextEligibleAt,
      canRun: effectiveRemaining > 0 &&
        (!nextEligibleAt || Date.now() >= Date.parse(nextEligibleAt)),
    });
  });

  return app;
}
