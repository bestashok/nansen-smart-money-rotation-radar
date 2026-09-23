# Nansen Smart Money Rotation Radar

An autonomous multi-chain scanner that uses Nansen for both token discovery and wallet-level research. It identifies probable rotations when the same wallet is observed selling one discovered token and buying another. It never claims a direct transfer unless evidence proves one.

## One-click Windows start

1. Copy `.env.example` to `.env` and enter `NANSEN_API_KEY`.
2. Double-click `Start Radar.bat`.
3. The launcher installs dependencies when needed, starts the API and dashboard, waits for readiness, and opens `http://localhost:5173`.
4. Click **Run Live Scan**.

For development, run `npm install` and `npm run dev`.

## Live endpoints

- `GET /api/health`
- `POST /api/scan`
- `GET /api/status`
- `GET /api/results`
- `GET /api/rotations`
- `GET /api/usage`
- `GET /api/history`

Runtime scan output, a 15-minute Nansen response cache, and API usage are stored under `data/` and excluded from Git. Cache hits do not consume the live-call counter. HTTP 429 responses use bounded retries with `Retry-After` support. The API key remains server-side and `.env` is ignored.

## Evidence and scoring

Discovery requests up to 25 qualifying tokens; fewer tokens and zero tokens are normal. Research uses Nansen Flow Intelligence, Flows, Who Bought/Sold BUY, Who Bought/Sold SELL, and Holders. The 0–100 score exposes netflow, buyer conviction, rotation confirmation, market quality, holder quality, and penalties. States are `ROTATION_IN`, `EARLY_ACCUMULATION`, `WATCH`, `NEUTRAL`, `DISTRIBUTION`, and `HIGH_RISK`—never BUY or SELL.

## Verification

Run `npm test` and `npm run build`. The dashboard scan has a hard 200-credit ceiling and currently selects at most two discovered tokens, reserving no more than 190 credits without cache hits or retries. Every retry is separately budgeted, so the cap cannot be exceeded. The dedicated `npm run gate:rotation` command has a conservative Free-plan budget guard and refuses to exceed 100 credits; its verified run reserved 90 credits and researched four real tokens.
