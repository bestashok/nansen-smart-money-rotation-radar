# Postmortem: 1,011 genuine Nansen calls (11 over the 1,000 target)

**Date of run:** 2026-09-25 19:54 IST
**Status:** disclosed, not remediated. No further live Nansen calls were made after this run.
**Ledger:** `data/api-usage.json` is unaltered. `cumulativeRealNansenApiCalls = 1011`.

## Summary

The final campaign run sent **247** requests and took the all-time genuine call count from
**764 to 1,011**. The buildathon target is a **1,000-call ceiling**, so the run **overshot by
11 calls**.

The 909-call campaign cap held exactly as designed. The 1,000-call all-time guard did not.

## What held and what did not

| Guard | Intended | Actual | Result |
|---|---|---|---|
| 909 campaign cap, enforced at the send site (`withCallBudget`) | 909 | campaign ledger = **909** | **Held.** Request 910 was never sent. |
| 1,000 all-time guard (`1000 - cumulativeReal`) | stop at 1,000 | reached **1,011** | **Failed open by 11.** |

The run's own stop reason was:

> `Run budget reached: 247 Nansen requests sent for this run (the campaign is capped at 909 calls in total).`

All 247 calls succeeded: 247 successful, 0 failed, 0 retries.

## The run that breached it

| | Value |
|---|---|
| All-time count before the run | 764 |
| Correct remaining budget (`1,000 - 764`) | **236** |
| Actual requests sent | **247** |
| Overshoot | **11** |

The run was permitted 247 requests instead of 236.

## Root cause

Two defects combined, in two different files.

### 1. A read failure is reported as zero, not as unknown

`src/server/apiUsage.js`, `loadUsage()`:

```js
async function loadUsage(usagePath) {
  try {
    return JSON.parse(await readFile(usagePath, "utf8"));
  } catch {
    return { cumulativeRealNansenApiCalls: 0, calls: [] };
  }
}
```

When the ledger cannot be read or parsed — a Windows file lock, a partially visible write, a
transient `EPERM`/`EBUSY` — the catch block returns a count of **`0`**, not `null` and not
`undefined`.

### 2. The "unknown" fallback is unreachable

`src/server/app.js`, the campaign route:

```js
const cumulativeReal = (await readUsage()).cumulativeRealNansenApiCalls ?? null;
const remainingCumulative = cumulativeReal == null
  ? Number.POSITIVE_INFINITY
  : Math.max(0, 1000 - cumulativeReal);
```

The intent was: if the cumulative count is unknown, do not wrongly cap an in-progress run. But
the nullish-coalescing operator only maps `null` and `undefined` to the fallback. Because
`loadUsage` returns `0` on failure, the expression evaluates to `0`, the `cumulativeReal == null`
branch is never taken, and the run is granted the **entire 1,000-call budget**:

```
remainingCumulative = 1000 - 0 = 1000
boundedRunCallLimit = min(247 runCallLimit, spendableCredits, 1000) = 247
```

The correct allowance was 236. A transient ledger read failure silently disabled the all-time
cap for the whole run.

### Why the code comment was wrong

The comment above that block claimed the fallback exists "so the rule degrades safely rather than
stopping the run." It did the opposite: failing to read the ledger granted the maximum possible
allowance. The guard was **fail-open**, so any transient I/O error removed the ceiling instead of
preserving it.

This is the more serious finding. A cap that fails open is not a cap.

## Why the 909 cap was unaffected

The 909 cap is enforced at the request send site in `callBudget.js`, deep inside the
retry/cache/credit layers. It counts requests as they leave the process and does not depend on
reading the usage ledger at all. It therefore kept working while the all-time guard — which
depends on a ledger read at run start — failed.

## Impact and scope

- **11 requests over a 1,000-call ceiling.** These reached Nansen and cannot be recalled.
- The overshoot is visible in `data/api-usage.json` and in the final run record in
  `data/campaign-history.json` (before 764, after 1011).
- The call record was not edited, trimmed, or reconciled after the fact. Correcting the number
  would misrepresent what was actually sent.

## What was not done

No code change was made to remediate this. The fail-open fallback described above is still present
in `src/server/apiUsage.js` and `src/server/app.js`. No live Nansen calls were made after the
overshoot, so the defect could not be triggered again, but it remains a live defect in the
codebase and should be treated as such.

The correct remediation, for the record, is to fail **closed**: an unreadable ledger must produce a
remaining budget of `0`, never `1000`.

## Timeline

| Time (IST) | Event |
|---|---|
| 2026-09-25 19:48 | Commit `6279d98` — dashboard made to report the 1,000 all-time total |
| 2026-09-25 19:54 | Final campaign run started; `764 → 1,011` |
| 2026-09-25 19:56 | Overshoot discovered during ledger review |
| after 19:56 | No further Nansen calls made; this disclosure written |
