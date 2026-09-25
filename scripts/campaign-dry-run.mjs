// Local dry run of the full Live Scan 2 pipeline with ZERO real Nansen calls.
//
// How it stays safe:
//   - runs in a throwaway temp directory, so data/api-usage.json,
//     data/cache.json and data/campaign-history.json in the repo are untouched
//   - NANSEN_BASE_URL points at a fake Nansen server bound to 127.0.0.1
//   - NANSEN_API_KEY is a placeholder; no request can reach api.nansen.ai
//
// What it proves:
//   - the run stops at exactly 909 real requests and never sends 910
//   - live progress messages ("Nansen API calls: N/909") are published
//   - 429 retries are attempted and counted as sent calls
//   - the completion report (sent/successful/failed/retries/remaining) is
//     internally consistent and matches the persisted usage file
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const REQUEST_CAP = 909;

// ---------------------------------------------------------------- temp CWD
// Must happen BEFORE importing any server module: apiUsage/cache/campaignStore
// resolve their data/* paths against process.cwd() at module load.
const tempDir = await mkdtemp(path.join(os.tmpdir(), "nansen-dry-run-"));
process.chdir(tempDir);

// ------------------------------------------------------- fake Nansen server
let requestCount = 0;
let rateLimitedCount = 0;

function tokenRecord(page, index) {
  const id = page * 100 + index;
  return {
    token_symbol: `T${id}`,
    chain: "base",
    token_address: `0x${String(id).padStart(40, "0")}`,
    market_cap_usd: 5_000_000,
    liquidity: 500_000,
    netflow: 100_000 - id,
  };
}

function walletRecords(side, page, perPage) {
  return Array.from({ length: perPage }, (_, index) => ({
    address: `wallet-${side}-${page}-${index}`,
    address_label: "Smart Trader",
    bought_volume_usd: side === "BUY" ? 10_000 + index : 0,
    sold_volume_usd: side === "SELL" ? 10_000 + index : 0,
  }));
}

function respond(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

const fakeNansen = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    requestCount += 1;
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}

    // Every 40th request is rate limited once; its retry lands on a
    // non-multiple and succeeds. Retry-After: 0 keeps the dry run fast.
    if (requestCount % 40 === 0) {
      rateLimitedCount += 1;
      return respond(res, 429, { message: "rate limit exceeded" }, { "retry-after": "0" });
    }

    const endpoint = req.url;
    if (endpoint === "/api/v1/token-screener") {
      const page = body?.pagination?.page ?? 1;
      if (page > 3) return respond(res, 200, { data: [], pagination: { page, is_last_page: true } });
      const data = Array.from({ length: 20 }, (_, index) => tokenRecord(page, index));
      return respond(res, 200, { data, pagination: { page, is_last_page: page === 3 } });
    }
    if (endpoint === "/api/v1/tgm/who-bought-sold") {
      // Always a FULL page so lazy deep pagination keeps requesting pages.
      const page = body?.pagination?.page ?? 1;
      return respond(res, 200, { data: walletRecords(body?.buy_or_sell === "SELL" ? "SELL" : "BUY", page, 25) });
    }
    if (endpoint === "/api/v1/tgm/flows") {
      const page = body?.pagination?.page ?? 1;
      const data = Array.from({ length: 30 }, (_, index) => ({
        date: `2026-09-${String(((page * 30 + index) % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        value_usd: 1_000 + index,
      }));
      return respond(res, 200, { data });
    }
    if (endpoint === "/api/v1/tgm/flow-intelligence") {
      return respond(res, 200, { data: [{ smart_trader_net_flow_usd: 250_000 }] });
    }
    if (endpoint === "/api/v1/tgm/holders") {
      const page = body?.pagination?.page ?? 1;
      const data = Array.from({ length: 25 }, (_, index) => ({
        address: `holder-${page}-${index}`,
        address_label: "Fund",
        token_amount: 1_000_000 - index,
      }));
      return respond(res, 200, { data });
    }
    return respond(res, 404, { message: `unknown endpoint ${endpoint}` });
  });
});
fakeNansen.listen(0, "127.0.0.1");
await once(fakeNansen, "listening");

// ------------------------------------------------- env, then real app chain
process.env.NANSEN_API_KEY = "dry-run-placeholder-key";
process.env.NANSEN_BASE_URL = `http://127.0.0.1:${fakeNansen.address().port}`;

const { createApp } = await import("../src/server/app.js");
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  // ------------------------------------------------------------- start run
  const acceptedResponse = await fetch(`${baseUrl}/api/campaign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creditLimit: 200 }),
  });
  assert.equal(acceptedResponse.status, 202, `unexpected status ${acceptedResponse.status}`);
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.maximumLogicalCalls, REQUEST_CAP);
  assert.equal(accepted.apiCallLimit, REQUEST_CAP);

  // ------------------------------------------- poll live progress + finish
  const progressMessages = [];
  let finalStatus = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    if (status.message && progressMessages.at(-1) !== status.message) {
      progressMessages.push(status.message);
    }
    if (status.phase === "CAMPAIGN_COMPLETE" || status.phase === "FAILED") {
      finalStatus = status;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(finalStatus, "campaign did not finish within 120s");
  assert.equal(finalStatus.phase, "CAMPAIGN_COMPLETE", finalStatus.message);

  // ---------------------------------------------------------- report checks
  const campaign = await (await fetch(`${baseUrl}/api/campaign`)).json();
  const report = campaign.latest?.runReport;
  assert.ok(report, "campaign history has no runReport");

  const usage = JSON.parse(
    await readFile(path.join(tempDir, "data", "api-usage.json"), "utf8"),
  );

  // Hard cap: the fake server is the ground truth for "requests that were
  // actually sent". Request 910 must never appear.
  assert.ok(
    requestCount <= REQUEST_CAP,
    `fake Nansen received ${requestCount} requests, which exceeds the ${REQUEST_CAP} hard cap`,
  );
  assert.equal(requestCount, REQUEST_CAP, `expected the cap to bind at ${REQUEST_CAP}, saw ${requestCount}`);

  // Report consistency.
  assert.equal(report.runCallLimit, REQUEST_CAP);
  assert.equal(report.nansenApiCallsSent, requestCount);
  assert.equal(report.successfulCalls + report.failedCalls, report.nansenApiCallsSent);
  assert.ok(report.retries >= 1, "expected at least one counted 429 retry");
  assert.equal(report.callsRemainingFromRunBudget, REQUEST_CAP - report.nansenApiCallsSent);
  assert.ok(report.stopReason, "report must explain why the run stopped");
  assert.match(report.stopReason, /budget|cap/i);

  // Persisted usage matches the report exactly (all responses reached the
  // fake server, so genuine usage == sent).
  assert.equal(usage.cumulativeRealNansenApiCalls, report.nansenApiCallsSent);
  assert.equal(usage.calls.length, report.nansenApiCallsSent);

  // Live progress was observable while the run was in flight. The onSend
  // format is "Nansen API calls: N/909 (run N/909)" with an optional credits
  // suffix when the balance is known (never in the dry run: temp workspace).
  const progressLines = progressMessages.filter((message) => /^Nansen API calls: \d+\/909 \(run \d+\/909\)/.test(message));
  assert.ok(progressLines.length > 0, "expected live 'Nansen API calls: N/909 (run N/909)' progress messages");
  assert.ok(
    progressMessages.some((message) => message.includes(`${report.nansenApiCallsSent}/909 calls sent this run`)),
    "expected a completion message summarising the run",
  );

  console.log("\nDRY RUN PASSED (zero real Nansen calls)");
  console.log(`  requests sent to fake Nansen : ${requestCount}/${REQUEST_CAP} (910 was never sent)`);
  console.log(`  rate-limited (retried)       : ${rateLimitedCount} (${report.retries} retries counted)`);
  console.log(`  successful / failed          : ${report.successfulCalls} / ${report.failedCalls}`);
  console.log(`  run budget remaining         : ${report.callsRemainingFromRunBudget}`);
  console.log(`  usage file entries           : ${usage.calls.length}`);
  console.log(`  stop reason                  : ${report.stopReason}`);
  console.log(`  temp workspace               : ${tempDir}`);
} finally {
  server.close();
  fakeNansen.close();
}
process.exit(0);
