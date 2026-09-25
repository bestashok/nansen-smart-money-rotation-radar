// Regression coverage for the 2026-09-25 overshoot to 1,011 genuine Nansen
// calls. See docs/POSTMORTEM.md.
//
// The defect: `loadUsage()` reported an unreadable ledger as a cumulative
// count of 0, and the campaign route guarded that read with `?? null`, which
// does not catch 0. A transient read failure therefore computed
// `remainingCumulative = 1000 - 0 = 1000` and granted the entire budget for
// the run. These tests pin the corrected behaviour: an unknown count must fail
// CLOSED (zero remaining), and it must never be silently written over.
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_CALL_TARGET } from "../src/server/eligibilityCampaign.js";
import { readUsage, trackNansenUsage } from "../src/server/apiUsage.js";

// Mirrors the guard in the campaign route. Kept in step with app.js on
// purpose: this is the expression whose fail-open behaviour caused the bug.
function remainingCumulative(usage) {
  const cumulativeReal = usage.cumulativeRealNansenApiCalls ?? null;
  return cumulativeReal == null ? 0 : Math.max(0, API_CALL_TARGET - cumulativeReal);
}

test("an unreadable ledger reports an unknown count, never zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-unreadable-"));
  const usagePath = path.join(directory, "usage.json");
  // Malformed JSON survives the read but fails JSON.parse on every retry.
  await writeFile(usagePath, "{ this is not json", "utf8");

  const usage = await readUsage({ usagePath });

  assert.equal(usage.ledgerUnreadable, true, "an unparseable ledger must be flagged unreadable");
  assert.equal(
    usage.cumulativeRealNansenApiCalls,
    null,
    "an unreadable ledger must report null, not 0, so callers can tell it apart from 'no calls yet'",
  );
  assert.equal(remainingCumulative(usage), 0, "an unknown count must fail closed to zero remaining");
});

test("a ledger that does not exist yet is a trustworthy zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-absent-"));
  const usagePath = path.join(directory, "never-written.json");

  const usage = await readUsage({ usagePath });

  assert.equal(usage.ledgerUnreadable, undefined);
  assert.equal(usage.cumulativeRealNansenApiCalls, 0);
  // Nothing has been sent, so the full target really is available.
  assert.equal(remainingCumulative(usage), API_CALL_TARGET);
});

test("an unreadable ledger cannot re-open the all-time budget (the 1,011-call bug)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-regression-"));
  const usagePath = path.join(directory, "usage.json");
  await writeFile(usagePath, "not-json", "utf8");

  // What the run would have been allowed to send, before the fix.
  const runCallLimit = 247;
  const spendableCredits = 300;
  const beforeFixRemaining = API_CALL_TARGET - (0 ?? null);
  const allowedBeforeFix = Math.min(runCallLimit, spendableCredits, beforeFixRemaining);

  // What it is allowed now.
  const allowedAfterFix = Math.min(
    runCallLimit,
    spendableCredits,
    remainingCumulative(await readUsage({ usagePath })),
  );

  assert.equal(allowedBeforeFix, 247, "documents the original defect: the full run budget was granted");
  assert.equal(allowedAfterFix, 0, "an unreadable ledger must now permit zero calls");
});

test("a corrupt ledger is refused loudly rather than reset to a phantom count", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-refuse-"));
  const usagePath = path.join(directory, "usage.json");
  await writeFile(usagePath, "{ truncated", "utf8");

  const tracked = trackNansenUsage({
    async post(endpoint) {
      return { data: { data: [] }, meta: { endpoint, status: 200 } };
    },
  }, { usagePath });

  // Recording must fail loudly. `null + 1` would silently reset the cumulative
  // counter to 1, destroying the accounting the hard cap depends on.
  await assert.rejects(
    () => tracked.post("/endpoint", {}),
    /Refusing to record a Nansen call/,
  );

  // The corrupt ledger stays flagged unknown, not rewritten to 1.
  const usage = await readUsage({ usagePath });
  assert.equal(usage.ledgerUnreadable, true);
  assert.equal(
    usage.cumulativeRealNansenApiCalls,
    null,
    "the corrupt ledger must stay flagged unknown rather than being reset to 1",
  );
  assert.equal(remainingCumulative(usage), 0);
});

test("a failed write does not poison later reads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-recover-"));
  const badPath = path.join(directory, "bad.json");
  await writeFile(badPath, "{ truncated", "utf8");

  const bad = trackNansenUsage({
    async post(endpoint) { return { data: { data: [] }, meta: { endpoint, status: 200 } }; },
  }, { usagePath: badPath });
  await assert.rejects(() => bad.post("/endpoint", {}), /Refusing to record/);

  // A healthy, independent ledger must still be readable afterwards.
  const goodPath = path.join(directory, "good.json");
  const good = trackNansenUsage({
    async post(endpoint) { return { data: { data: [] }, meta: { endpoint, status: 200 } }; },
  }, { usagePath: goodPath });
  await good.post("/endpoint", {});

  const usage = await readUsage({ usagePath: goodPath });
  assert.equal(usage.cumulativeRealNansenApiCalls, 1, "reads must survive an earlier failed write");
  assert.equal(remainingCumulative(usage), API_CALL_TARGET - 1);
});

test("a read-only directory surfaces an error instead of a phantom zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nansen-perm-"));
  const usagePath = path.join(directory, "usage.json");
  await writeFile(usagePath, JSON.stringify({ cumulativeRealNansenApiCalls: 500, calls: [] }), "utf8");
  // Make the file unreadable. Windows may ignore this for the current user, so
  // the test tolerates either outcome and only asserts we never see a wrong 0.
  await chmod(usagePath, 0o000).catch(() => {});

  const usage = await readUsage({ usagePath });

  if (usage.ledgerUnreadable) {
    assert.equal(usage.cumulativeRealNansenApiCalls, null);
    assert.equal(remainingCumulative(usage), 0);
  } else {
    assert.equal(usage.cumulativeRealNansenApiCalls, 500, "a readable ledger must report its true count");
    assert.equal(remainingCumulative(usage), API_CALL_TARGET - 500);
  }
});
