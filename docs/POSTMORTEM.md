# Postmortem: 1,011 genuine Nansen calls (11 over the 1,000 target)

**Date of run:** 2026-09-25 19:54 IST
**Status:** disclosed and remediated. The 1,011 calls stand; the defect is fixed.
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

## Remediation

The defect has been fixed. The all-time guard now **fails closed**.

### 1. An unreadable ledger is reported as unknown, not as zero

`src/server/apiUsage.js`, `loadUsage()` now distinguishes three cases:

| Situation | Result |
|---|---|
| File does not exist (`ENOENT`) | `cumulativeRealNansenApiCalls: 0` — a real, trustworthy zero |
| File unreadable or unparseable | `cumulativeRealNansenApiCalls: null`, `ledgerUnreadable: true` |
| File valid | the parsed ledger |

Reads and parses are retried (`LEDGER_READ_ATTEMPTS = 5`, `LEDGER_READ_BACKOFF_MS = 20`) because
the failures that caused this were transient Windows locks that clear within milliseconds.

### 2. The all-time guard treats unknown as zero remaining

`src/server/app.js`:

```js
const cumulativeReal = (await readUsage()).cumulativeRealNansenApiCalls ?? null;
const remainingCumulative = cumulativeReal == null
  ? 0                                                    // was: Number.POSITIVE_INFINITY
  : Math.max(0, API_CALL_TARGET - cumulativeReal);
```

The `Number.POSITIVE_INFINITY` branch was the fail-open path. It is now `0`. An unreadable ledger
allows no requests at all, because remaining headroom cannot be proven.

### 3. The bound collapses cleanly instead of aborting mid-run

A collapsed bound now returns a `409` before the run starts:

```js
if (boundedRunCallLimit <= 0) { /* clear reason, no requests sent */ }
```

### 4. Recording refuses to corrupt the ledger

`appendUsage()` previously would have executed `null + 1`, silently resetting the cumulative
counter to `1`. It now throws instead, and `readUsage()` no longer lets a failed write poison
subsequent reads.

### 5. Display follows the same rule

`/api/campaign` reports no all-time total and no remaining budget when the ledger is unreadable,
instead of showing a phantom `1,000` remaining.

## Verification of the fix

Replaying the exact failing scenario — a 247-call run with 300 spendable credits and an unreadable
ledger:

| | Before | After |
|---|---|---|
| `remainingCumulative` | 1000 | **0** |
| `boundedRunCallLimit` | 247 | **0** |
| Outcome | 11 calls over the cap | 0 calls, `409` |

`test/ledgerFailClosed.test.js` pins this behaviour, including a direct assertion that the
pre-fix expression granted the full 247-call budget.

## Not done

- The 1,011 calls are not retracted or reconciled. The record reflects what was actually sent.
- No live Nansen calls were made after the overshoot, so the fix has not been exercised against
  the live API. It is verified by unit tests and a simulated reproduction only.

## Timeline

| Time (IST) | Event |
|---|---|
| 2026-09-25 19:48 | Commit `6279d98` — dashboard made to report the 1,000 all-time total |
| 2026-09-25 19:54 | Final campaign run started; `764 → 1,011` |
| 2026-09-25 19:56 | Overshoot discovered during ledger review |
| after 19:56 | No further Nansen calls made; this disclosure written |
