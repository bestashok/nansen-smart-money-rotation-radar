# Judging Guide

## 60-second review path

1. Watch the [product demo](../demo/nansen-rotation-radar-demo.mp4).
2. Read the architecture and pipeline in the [README](../README.md).
3. Inspect the exact inference and scoring formulas in [METHODOLOGY.md](METHODOLOGY.md).
4. Run `npm test` and `npm run build`.
5. Add a Nansen key to `.env`, launch `Start Radar.bat`, and run a credit-capped live scan.

## Feature-to-evidence map

| Criterion | Implementation evidence |
| --- | --- |
| Nansen-native discovery | `src/server/discovery.js` calls Token Screener and paginates until a real terminal condition |
| Nansen-native research | `src/server/researchGate.js` calls Flow Intelligence, Flows, Who Bought/Sold BUY/SELL, and Holders |
| Novel insight | `src/server/rotationEngine.js` detects ordered cross-token seller/buyer wallet overlap |
| Explainability | `src/server/scoringEngine.js` returns named components, penalties, state, and explanation |
| Cost safety | `src/server/creditBudget.js` enforces the 10–200 server-side hard cap before transmission |
| 1,000-call compliance | `src/server/eligibilityCampaign.js` collects broad, timestamped wallet snapshots; `src/server/callBudget.js` stops exactly at the target |
| Performance | `src/server/concurrency.js` bounds parallel research across tokens |
| Reliability | 15-minute cache, bounded 429 retries, partial-token isolation, persistent status/history |
| Transparency | Dashboard shows discovered, analyzed, skipped, failed, call, latency, credit, and timing data |
| Security | API key stays in ignored `.env`; frontend receives evidence only |
| Accessibility | `Start Radar.bat` provides one-click Windows launch |

## Development gates completed

- Live Token Screener returned real qualifying tokens without hard-coded candidates.
- Live Who Bought/Sold responses exposed wallet addresses and Nansen labels.
- Full controlled research completed across a real discovered token set.
- Wallet overlap logic was verified against real evidence and synthetic unit boundaries without fabricating a positive rotation.
- A strict 100-credit gate refused requests beyond its allowance.
- The dashboard scan enforces an absolute 200-credit maximum.
- Market Snapshot Campaign broadens BUY/SELL evidence to as many as nine tokens per 200-credit cycle.
- Concurrent usage persistence is serialized so campaign calls cannot be lost from the cumulative counter.
- Current release: 32 automated tests passing and production build passing.

## Honest-result policy

The best demo result is not necessarily a positive rotation. If the selected tokens contain no seller/buyer wallet overlap, the application displays a zero-rotation state. That negative result demonstrates that the product does not manufacture edges for presentation.

## Public versus local data

The source repository is public. The user's Nansen API key, runtime cache, wallet evidence, scan history, latest results, and cumulative usage remain local and are ignored by Git. Anyone reviewing or cloning the project must supply their own Nansen key to run a fresh scan.
