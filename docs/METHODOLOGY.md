# Research Methodology

## Research question

The project tests a specific on-chain hypothesis:

> When the same Smart Money wallet is observed selling Token A and buying Token B during the same research window, Token B may be a probable rotation destination.

This is deliberately narrower than claiming a direct transfer of funds. The system measures overlapping behavior, not transaction-level causality.

## 1. Universe construction

Token candidates come only from Nansen Token Screener. There is no manual token input, static candidate list, CoinGecko/CMC fallback, or fabricated result.

| Parameter | Value |
| --- | --- |
| Chains | Ethereum, Base, Solana, BNB Chain, Arbitrum |
| Timeframe | 24 hours |
| Trader type | Smart Money |
| Stablecoins | Excluded |
| Market cap | $1M–$1B |
| Minimum liquidity | $100K |
| Minimum volume | $100K |
| Minimum netflow | $1K |
| Minimum qualifying traders | 3 |
| Ranking | Netflow descending |

Discovery uses Nansen's `page`, `per_page`, and `is_last_page` fields. Each request asks for 20 records. Pages continue until one of four terminal conditions:

1. Nansen returns `is_last_page: true`.
2. Nansen returns no records.
3. A page adds no new chain/address pair.
4. The selected credit budget refuses the next live request.

This creates no fixed token-count ceiling while preventing infinite or unfunded pagination.

## 2. Per-token evidence collection

For each token that can be fully funded by the remaining conservative budget, the scanner requests five evidence sets.

| Evidence | Endpoint | Window | Normalized output |
| --- | --- | --- | --- |
| Segment summary | `/api/v1/tgm/flow-intelligence` | 1 day | Smart Trader netflow, average flow, wallet count; Top PnL, exchange and whale context |
| Flow history | `/api/v1/tgm/flows` | 7 days | Date, token amount/value, holders, inflow/outflow counts |
| Smart Money buyers | `/api/v1/tgm/who-bought-sold` with `BUY` | 7 days | Address, Nansen label, bought/trade volume |
| Smart Money sellers | `/api/v1/tgm/who-bought-sold` with `SELL` | 7 days | Address, Nansen label, sold/trade volume |
| Holder structure | `/api/v1/tgm/holders` | Current endpoint view | Address, label, ownership, value and balance changes |

Buyer/seller filters include `Fund`, `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, and `180D Smart Trader`. A token passes research only when all five evidence requests succeed and both BUY and SELL results contain wallet addresses. Missing evidence is reported as a failure; it is never filled with mock data.

## 3. Controlled parallelism

Tokens are researched through a bounded worker pool. The default concurrency is 10 and can be changed through `NANSEN_CONCURRENCY`.

The credit-aware scanner works in batches:

1. Calculate conservative remaining credits.
2. Start only as many tokens as can each fund the complete 90-credit research set.
3. Wait for the batch.
4. Recalculate the remaining budget, including cache savings and retry costs.
5. Continue or label remaining candidates as budget-skipped.

A failed token is isolated; other workers continue.

## 4. Address normalization

EVM addresses beginning with `0x` are compared case-insensitively. Non-EVM addresses, including Solana addresses, remain case-sensitive. Tokens are identified by the combination of chain and contract address.

## 5. Rotation inference

For each ordered pair of researched tokens `(A, B)`:

```text
overlap(A → B) = unique seller wallets in A ∩ buyer wallets in B
```

If the intersection is non-empty, the engine records a `PROBABLE_SMART_MONEY_ROTATION` containing:

- source and destination tokens
- total source sellers and destination buyers
- every overlapping wallet and available Nansen label
- observed source sold volume for those wallets
- observed destination bought volume for those wallets
- destination netflow
- confidence and a causality disclaimer

Confidence is deterministic:

```text
20 base
+ 15 × overlapping-wallet count
+ 15 when destination netflow is positive
+ 10 when overlapping destination buy volume exceeds source sell volume
capped at 100
```

The score is confidence in the observed behavioral overlap—not a probability of future return.

## 6. Destination score

The destination score is bounded from 0 to 100.

### Positive components

| Component | Formula | Maximum |
| --- | --- | ---: |
| Smart Money netflow | Positive netflow scales to full credit at $250K | 25 |
| Smart Buyer conviction | Buyer USD volume scales to full credit at $250K | 20 |
| Rotation confirmation | 5 points per incoming overlapping wallet | 25 |
| Market quality | Liquidity scales to full credit at $2M | 15 |
| Holder quality | Starts at 15; reduced when top-10 ownership exceeds 25% | 15 |

### Penalties

| Condition | Penalty |
| --- | ---: |
| Seller volume exceeds 1.5× buyer volume | -10 |
| Liquidity below $150K | -8 |
| Top-10 ownership exceeds 50% | -10 |

### Evidence states

States are assigned in this order:

1. `HIGH_RISK` when concentration is dangerous or score is below 25.
2. `DISTRIBUTION` when seller volume exceeds 1.5× buyer volume.
3. `ROTATION_IN` when an incoming edge exists and score is at least 65.
4. `EARLY_ACCUMULATION` when netflow is positive and score is at least 50.
5. `WATCH` when score is at least 35.
6. `NEUTRAL` otherwise.

The project intentionally never emits BUY or SELL recommendations.

## 7. Credit accounting

The dashboard accepts 10–200 credits, with 200 as an absolute server-side maximum. Before each live call, the budget wrapper reserves a conservative endpoint cost. A request is refused before transmission if it could exceed the cap.

Retries are real requests, so every retry is separately reserved and logged. Cache hits bypass the live client, consume no reserved credits, and do not increment genuine API usage.

## 8. Reproducibility and audit trail

Every completed scan records:

- start and completion timestamps
- total, discovery, and research duration
- tokens discovered, selected, analyzed, failed, and skipped
- discovered token list and normalized evidence
- rotation edges and scoring components
- current live calls, cache hits, rate-limit events, and average latency
- conservative credit reservation history

Latest results, scan history, cache, and request usage are persisted locally as JSON. They are excluded from Git because they may contain runtime wallet evidence and usage metadata.

## 9. Longitudinal Market Snapshot Campaign

The normal scan optimizes for deep evidence and spends approximately 90 conservative credits per token. The Market Snapshot Campaign instead optimizes for cross-token breadth while retaining the same 200-credit ceiling.

A 200-credit campaign cycle allocates up to 20 lowest-cost calls:

1. One Token Screener snapshot.
2. BUY and SELL wallet evidence for up to nine discovered tokens.
3. Any remaining call slots add Flow Intelligence or Flows context.
4. The rotation engine compares every token with complete BUY and SELL evidence.
5. The timestamped cycle and any real edges are persisted locally.

Cycles are separated by at least the configured 15-minute cache window. This makes repeated calls distinct market observations rather than immediate duplicate traffic. A call-target guard wraps the live request tracker, so HTTP retries cannot push cumulative usage past 1,000.

The campaign does not run automatically. The user explicitly starts every bounded cycle and can select any limit from 10 through 200 credits.

## 10. Interpretation limits

- Wallet overlap does not prove proceeds from one sale funded the other purchase.
- Nansen labels and endpoint coverage define the observable universe.
- The seven-day research window can miss longer or shorter rotations.
- Small credit budgets reduce cross-token coverage and therefore reduce the chance of observing overlap.
- Scores are explainable heuristics, not backtested expected returns.
- Market conditions can change after the observation window.

The correct interpretation is “probable observed Smart Money rotation,” not financial advice.
