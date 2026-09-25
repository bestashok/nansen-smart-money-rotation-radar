// Pins the campaign/all-time call accounting that the dashboard reports.
//
// The dashboard must not claim that campaign work was something else. The
// "other calls" bucket previously swallowed genuine campaign-cycle calls that
// the legacy ledger never recorded, which made the split read as
// "909 campaign + 102 other live scans" when the truth was
// "952 campaign + 59 plain Run Live Scan".
import assert from "node:assert/strict";
import test from "node:test";
import { campaignCallAccounting, campaignCallsSent } from "../src/server/campaignStore.js";

test("accounting never changes the number enforcement uses", () => {
  const history = [
    { runReport: { nansenApiCallsSent: 10 }, cumulativeCallsBefore: 100, cumulativeCallsAfter: 110 },
    // A legacy run: no totals recorded, so the cap scores it 0.
    { liveApiCalls: 20, cumulativeCallsBefore: 110, cumulativeCallsAfter: 130 },
  ];

  const before = campaignCallsSent(history);
  const accounting = campaignCallAccounting(history);

  assert.equal(before, 10, "the enforcement ledger value must be unaffected");
  assert.equal(accounting.recorded, 10, "accounting reports the same recorded total");
  assert.equal(accounting.actual, 30, "the cumulative ledger shows 30 calls were really spent");
  assert.equal(
    accounting.unrecorded,
    20,
    "the 20 campaign calls the legacy run never recorded are surfaced, not hidden",
  );
});

test("unrecorded campaign calls are never folded into the other-calls bucket", () => {
  // The first run starts at cumulative 0, so every call in this ledger belongs
  // to a campaign cycle and none came from a plain Run Live Scan.
  const history = [
    { runReport: { nansenApiCallsSent: 10 }, cumulativeCallsBefore: 0, cumulativeCallsAfter: 10 },
    // A legacy run: no totals recorded, so the cap scores it 0.
    { liveApiCalls: 20, cumulativeCallsBefore: 10, cumulativeCallsAfter: 30 },
  ];
  const total = 30;

  const accounting = campaignCallAccounting(history);
  const outsideRuns = total - accounting.actual;

  assert.equal(outsideRuns, 0, "no call in this ledger came from a plain Run Live Scan");
  assert.equal(
    accounting.unrecorded,
    20,
    "those 20 are campaign work, so they must not be reported as 'other live scans'",
  );
});

test("plain Run Live Scan calls are separated from unrecorded campaign calls", () => {
  // Campaign cycles spent 30, and 7 more calls happened outside any cycle.
  const history = [
    { runReport: { nansenApiCallsSent: 10 }, cumulativeCallsBefore: 0, cumulativeCallsAfter: 10 },
    { liveApiCalls: 20, cumulativeCallsBefore: 10, cumulativeCallsAfter: 30 },
  ];
  const total = 37;

  const accounting = campaignCallAccounting(history);

  assert.equal(accounting.actual, 30);
  assert.equal(accounting.unrecorded, 20, "campaign work the ledger missed");
  assert.equal(total - accounting.actual, 7, "genuinely other live scans");
  assert.notEqual(accounting.unrecorded, total - accounting.actual, "the two groups stay distinct");
});

test("a run that over-reported does not produce a negative unrecorded count", () => {
  // Runs 8 and 9 recorded more than the cumulative ledger advanced, because a
  // write race dropped increments. That must clamp at 0, never go negative.
  const history = [
    { totalCalls: 10, cumulativeCallsBefore: 742, cumulativeCallsAfter: 749 },
  ];

  const accounting = campaignCallAccounting(history);

  assert.equal(accounting.recorded, 10);
  assert.equal(accounting.actual, 7);
  assert.equal(accounting.unrecorded, 0, "clamped to 0 rather than -3");
});

test("history with no cumulative snapshots reports zero, not NaN", () => {
  const accounting = campaignCallAccounting([
    { runReport: { nansenApiCallsSent: 5 } },
  ]);

  assert.equal(accounting.recorded, 5);
  assert.equal(accounting.actual, 0, "unverifiable runs contribute nothing to the actual count");
  assert.equal(Number.isSafeInteger(accounting.unrecorded), true);
});

test("a history with missing fields never throws", () => {
  const accounting = campaignCallAccounting([{}, null, undefined, { runReport: null }]);

  assert.equal(accounting.recorded, 0);
  assert.equal(accounting.actual, 0);
  assert.equal(accounting.unrecorded, 0);
});
