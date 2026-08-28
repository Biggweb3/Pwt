# Polymarket Intel — Wallet Intelligence Terminal

A production-quality dashboard for monitoring and comparing **multiple public Polymarket
traders from one screen**. Paste profile URLs (or wallets/usernames), and the app resolves
them, backfills their public history, and continuously monitors their activity, positions
and performance — with a live global feed across all tracked traders.

> Analytics tool for **public** Polymarket data only. It never requests, stores, or exposes
> private keys, seed phrases, passwords, cookies, or any private account information.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  POLYMARKET INTEL   Dashboard · Compare · [search] · [+ Add Trader]     │
├───────────────────────────────┬─────────────────────────────────────────┤
│ Tracked Traders: 12  Live: 11 │ ● LIVE ACTIVITY — all traders           │
│ Errors: 1  24h Vol: $214K     │   Trader A  BUY YES $2,400   18s ago    │
├───────────────────────────────┤   Trader F  SELL NO $830     41s ago    │
│ Trader | 24hWin | 7dP&L | …   │   Trader C  BUY YES $5,100   1m ago     │
└───────────────────────────────┴─────────────────────────────────────────┘
```

## Features

- **Add Trader** — accepts `https://polymarket.com/profile/…`, raw `0x` addresses, or a
  display username (resolved via Polymarket's public search). Validation, loading/error
  states, duplicate detection (409), candidate disambiguation, one-click suggestions.
- **Dashboard** — per-trader status (🟢 LIVE / 🟡 UPDATING / 🔴 ERROR), prediction win
  rate (with its sample size), 24h trades, 7d P&L, 7d volume, active positions, last
  activity; sortable columns; remove a trader straight from the row (✕ → Confirm).
- **Global live feed** — newest trades/redemptions across *all* tracked traders.
- **Trader detail page** — 24H/72H/7D/30D/ALL performance, cumulative P&L chart *and* a
  rolling prediction-accuracy chart, active/resolved positions, filterable activity feed,
  paginated trades table (10/page, prev/next, backend-paginated), plus the
  **“Last 100 Predictions”** analytics block (see *Win rate* below).
- **Comparison view** — matrix of win rates (each with its sample size), trades, volume,
  P&L across windows; sortable. Profitable-position rate is shown separately for contrast.
- **Live monitoring** — incremental sync engine with configurable poll interval
  (10s/30s/60s), per-wallet state, exponential backoff, and SSE push to the UI.
  One failing wallet never blocks the others.
- **Alerts** — rule engine (`new_trade`, `large_trade ≥ $X`, `market_entry` keyword,
  `position_closed`, `winrate_cross ≥ X%`) with in-app notifications + toasts. Designed
  to be extended with push channels later.
- **Data honesty** — metrics are labelled `api` (straight from Polymarket) vs
  `calculated` (derived from synced public rows). Win rate is calculated from final
  market **resolutions**, never from profit; open positions are never wins or losses;
  missing data shows `N/A` / `Unavailable` — never invented.

## Win rate = prediction accuracy (independently calculated)

**Definition, and the only one used anywhere in the app:** *the share of a trader’s most
recent 100 completed predictions whose market resolved in their favour* —
`wins ÷ (wins + losses) × 100`. Not profitable trades. Not Polymarket’s profile numbers.

Polymarket’s public API exposes no per-wallet win rate (verified against
`data-api`/`lb-api`/`gamma` while implementing this), so the number is derived here and
labelled `calculated`. `GET /api/wallets/:addr/win-rate` returns the methodology, the
independently calculated figure, the Polymarket-reported figures next to it (P&L, volume,
markets traded — with an explicit `unavailableReason` for win rate), and a
`profitabilityCrossCheck` that shows what “win = made money” *would* have said. They are
displayed side by side and never merged.

The pipeline (`server/predictions.js`, run from the sync engine — never in React):

1. read the wallet’s activity/trade history and its position + closed-position snapshots
   (both paged newest-first; `redeemable=true` positions are unioned in, because a
   loser that was never redeemed otherwise disappears from the data set);
2. fetch each market’s final resolution (CLOB `GET /markets/{conditionId}`, Gamma
   `GET /markets/slug/{slug}` as fallback) and cache it globally by condition id;
3. group every transaction of a wallet **per market** (`condition_id` → slug → title →
   asset): 8 buys and 3 partial sells in one market = **one prediction**;
4. take the accumulated outcome token by cost basis → that is the trader’s *prediction*
   (YES/NO); ≥30 % of the cost on the other side of the same market = hedged = excluded;
5. classify **only** from the market’s final resolution: `predicted_index === winning_index`
   → WIN, otherwise LOSS. Profit, `curPrice`, and early selling are never consulted;
6. anything without a final resolution — open position, market still open, unreadable
   market, 50/50 or voided outcome — is `UNDETERMINED` and stays **out of the
   denominator**, with the reason stored;
7. order completed predictions by resolution/completion time, newest first (fallback
   chain: closed position → redemption → market resolution → last trade, marked ≈);
8. take the most recent N (10 / 25 / 50 / **100** / 250 / all-time) *classified* rows —
   never padded, so 8 of 8 renders as “100% — Based on 8 completed predictions”.

Every row is persisted (`predictions` table: wallet, market, predicted outcome, final
outcome, result, resolved time, grouped source transactions), so clicking any win rate in
the UI opens the audit table (Date / Market / Prediction / Final outcome / Result) and,
per row, the resolution record plus every grouped fill and its Polygon tx hash.

API surface: `GET /api/wallets/:addr/win-rate`, `GET /api/wallets/:addr/predictions`
(filters `result`, `status`, `window`, `market`, `page`), `GET …/predictions/:conditionId`
(audit trail), `POST …/predictions/rebuild` (re-verify now), `GET …/accuracy` (hit-rate
series used by the chart), and `GET /api/compare`. `server/analytics.js` and every screen
call into this one engine; no component divides wins by losses.

## Architecture

```
Browser (React + TypeScript + Tailwind, Vite)
   │  relative /api URLs (SSE for live events)
   ▼
Node.js server (Express) ── REST API ── SSE hub ── sync engine (per-wallet jobs,
   │                                                  backoff, concurrency cap)
   ├─ polymarketService   isolated Polymarket integration (single swap point)
   ├─ analytics           windowed metrics derived from stored rows
   ├─ alerts              rule evaluation on newly ingested rows only
   └─ SQLite (node:sqlite) wallets · trades · activity · positions ·
                           closed_positions · alert_rules · notifications
```

- **Backend**: Node.js ≥ 22.5 (uses the built-in `node:sqlite`), Express 5. No ORM,
  no native modules — the server installs in seconds and the DB is a single file
  (`data/pwt.db`).
- **Frontend**: React 18 + TypeScript + Tailwind, built with Vite, served statically
  by the same Node server (single port, relative URLs — proxy-friendly).
- **Idempotent sync**: every trade/activity row gets a stable dedupe key
  (`sha1(txHash|asset|side|price|shares|timestamp)`); re-fetching the same window can
  never create duplicates.
- **Incremental sync**: after the bounded initial backfill (default: 31 days,
  ≤ 2,500 trades) only rows newer than the newest stored timestamp are requested
  (`start=` window). Positions, closed positions, and leaderboard stats refresh on
  slower cadences. All-time P&L/volume come from Polymarket's own leaderboard API,
  so deep history never needs to be downloaded.

### Transport modes

1. **Server mode (default)** — the server polls Polymarket's public APIs directly.
2. **Bridge mode (automatic fallback)** — if the server has no egress to Polymarket
   (some sandboxes/restricted networks), the app detects this via a connectivity probe
   and delegates the *same public read-only GETs* to the connected browser, which posts
   responses back. All normalization, dedupe and persistence still happen server-side.
   The UI shows a `BRIDGE SYNC` badge and banner when this is active. In a normal
   deployment nothing special is needed — server mode is used automatically.

## Deploying on Vercel

The dashboard ships with **serverless support** so the API runs as a Vercel
Function next to the static frontend — just import the repo, no extra services
required. Two deployment shapes are supported automatically:

| Vercel project *Root Directory* | API entrypoint | Notes |
| --- | --- | --- |
| repository root (recommended) | `api/index.js` | configured by `./vercel.json` |
| `client/` | `client/api/index.js` | self-contained bundle, configured by `client/vercel.json` |

Both route `/api/*` to the same Express app used by `npm start`; everything
else is served from the static Vite build with an SPA fallback.

If you change anything under `server/`, regenerate the client-root bundle with
`npm run build:vercel-api` (CI fails if the committed bundle is stale).

**Serverless adaptations** (all automatic, detected via `GET /api/system` →
`deployment: "serverless"`):

- **Storage** — SQLite lives in the function's ephemeral `/tmp`; a cold start
  starts with a blank database. Your browser remembers the tracked traders and
  transparently re-seeds + rebuilds them from Polymarket's public APIs, so the
  dashboard self-heals (watch the `SERVERLESS SYNC` badge). For durable
  multi-device storage, back `DATA_DIR` with a persistent volume or swap in a
  hosted database; alert-rule history is the only data not rebuilt.
- **Syncing** — there is no always-on process, so the browser drives
  `POST /api/sync` (time-budgeted, idempotent) every ~20 s instead of the
  background engine; the initial sync after adding a trader runs inline.
- **Live updates** — SSE is disabled server-side (501); the client polls.

Two Vercel project settings worth checking after the first deploy:

1. **Deployment Protection** (Settings → Deployment Protection): if enabled,
   your deployment URL requires a Vercel login — fine for personal use, but
   anonymous visitors (and API clients) get a login wall instead of the app.
2. **Node.js runtime**: functions are pinned to `nodejs22.x` (`node:sqlite`
   needs Node ≥ 22.13).

## Polymarket data sources (verified against docs.polymarket.com + live responses)

| Purpose | Endpoint |
| --- | --- |
| Profile metadata | `GET gamma-api.polymarket.com/public-profile?address=` |
| Username → wallet | `GET gamma-api.polymarket.com/public-search?q=&search_profiles=true` |
| Trades (taker) | `GET data-api.polymarket.com/trades?user=&limit=&offset=&start=&end=&side=` |
| Activity (trade/redeem/split/merge/…) | `GET data-api.polymarket.com/activity?user=&type=&start=` |
| Open positions | `GET data-api.polymarket.com/positions?user=&sortBy=CURRENT&redeemable=true` |
| Closed positions (realized P&L) | `GET data-api.polymarket.com/closed-positions?user=&sortBy=TIMESTAMP&sortDirection=DESC` |
| **Final market resolution** (win/loss authority) | `GET clob.polymarket.com/markets/{conditionId}` → `tokens[].winner` |
| …fallback | `GET gamma-api.polymarket.com/markets/slug/{slug}` → `outcomePrices`, `umaResolutionStatus` |
| Portfolio value | `GET data-api.polymarket.com/value?user=` |
| Markets traded count | `GET data-api.polymarket.com/traded?user=` |
| P&L windows (API-provided) | `GET lb-api.polymarket.com/profit?window=1d|7d|30d|all&address=` |
| Volume windows (API-provided) | `GET lb-api.polymarket.com/volume?window=1d|7d|30d|all&address=` |
| Top traders (suggestions) | `GET data-api.polymarket.com/v1/leaderboard?period=1d` |

Notes that materially change the numbers (all verified against live responses):

- `/closed-positions` sorts **ascending** unless `sortBy=TIMESTAMP&sortDirection=DESC` is
  passed — otherwise a paged backfill only ever sees the oldest settlements and recent
  losses are invisible.
- `/positions?sortBy=CURRENT` ranks by current value, so zero-value losers fall off the
  end of a capped page; `redeemable=true` is fetched as a second pass to catch markets
  that resolved while the trader still holds the tokens (winners *and* losers).
- `closed-positions.realizedPnl` can be positive on a market the trader lost (it reflects
  exit price, not the resolution), so it is never used to classify a prediction.
- `/trades` defaults to `takerOnly=true`, hiding half of a market-maker-ish trader’s
  fills; the engine requests `takerOnly=false` so position grouping sees everything.
- Resolution lookups are one request per market, so they are cached globally by
  `condition_id` forever, budgeted per cycle, retried with backoff, and never guessed —
  a market whose outcome cannot be read leaves the prediction `UNDETERMINED`.

All endpoints are public and unauthenticated. Published rate limits (data-api: general
1,000 req/10s, `/trades` 200 req/10s, `/positions` 150 req/10s) are respected: default
poll is 30s/wallet with a concurrency cap of 3 and staggered sub-refreshes, and CLOB
resolution lookups run 6 at a time inside the per-cycle budget. Polymarket
exposes no public per-wallet WebSocket stream (the user channel requires authentication),
so incremental polling is the officially sanctioned mechanism — which is what the sync
engine implements.

## Getting started

```bash
npm install              # server deps (express)
npm run build            # build the React client (client/dist)
npm start                # serves API + UI on http://0.0.0.0:3000
```

Development with hot reload:

```bash
npm run dev              # Node server with --watch (port 3000)
npm run dev:client       # Vite dev server (port 5173, proxies /api → 3000)
```

### Configuration (`.env`, all optional)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (binds 0.0.0.0) |
| `DATA_DIR` | `./data` | SQLite location |
| `POLL_INTERVAL` | `30` | Default seconds between wallet syncs |
| `INITIAL_HISTORY_DAYS` | `31` | Backfill depth on first add |
| `INITIAL_MAX_TRADES` | `2500` | Backfill safety cap |
| `MAX_CONCURRENT_SYNCS` | `3` | Parallel wallet syncs |
| `PREDICTION_CLOSED_LIMIT` | `1500` | Closed positions classified per wallet (prediction engine) |
| `PREDICTION_POSITION_PAGES` | `4` | Pages of open positions scanned (incl. `redeemable=true`) |
| `RESOLUTION_LOOKUPS_PER_CYCLE` | `40` | Market-resolution lookups per steady-state cycle (cached per condition id forever) |
| `RESOLUTION_LOOKUPS_INITIAL` | `160` | …budget for a wallet’s first sync |
| `RESOLUTION_RETRY_SEC` | `300` | Retry delay for a market whose outcome is not readable yet |
| `RESOLUTION_MAX_ATTEMPTS` | `12` | Give up after N attempts (row stays UNDETERMINED, never guessed) |

### Scripts (test utilities)

- `npm test` — the win-rate suite in three layers: unit + persisted-pipeline tests, the
  render test, and the full end-to-end test against the mock upstream (below).
- `npm run test:winrate` — `scripts/test-winrate.mjs`: 107 assertions over the pure
  classifier and the persisted pipeline (grouping, partial exits, unredeemed losers,
  hedged markets, unresolved markets, known answers 63/100 → 63% and 60W/40L → 60%,
  window capping, delete-cascade, upstream URL shapes).
- `npm run test:render` — `scripts/test-render.mjs`: server-renders every win-rate
  component with API-shaped fixtures (type-checked against `client/src/lib/types.ts`) and
  asserts the tooltip wording, sample sizes, exclusion notes and empty/limited states.
- `npm run test:e2e` — `scripts/e2e-winrate.mjs`: boots the real server against
  `scripts/mock-polymarket.mjs`, adds a trader, waits for the sync, then checks 107
  assertions across all endpoints — including delete → re-add.
- `npm run test:serverless` — the same engine through the prebuilt Vercel bundle
  (`client/api/index.js`), including a cold-start re-seed.
- `scripts/mock-polymarket.mjs` — local mock of the Polymarket APIs. Besides the real
  captured fixtures for `0xb1ca909e…` it generates three traders with a *known* answer:
  63 W / 37 L over the most recent 100 completed predictions (every one of which reports
  positive realized P&L, so a P&L-based “win rate” would read 100%), 8/8 completed
  (must not be padded), and zero completed (must read `N/A`). Useful for manual testing:
  `node scripts/mock-polymarket.mjs 3200` then
  `POLYMARKET_DATA_API=http://127.0.0.1:3200 POLYMARKET_GAMMA_API=… POLYMARKET_LB_API=… POLYMARKET_CLOB_API=… node server/index.js`
- `scripts/bridge-sim.mjs` — simulates the browser bridge worker against the same fixtures.
- `scripts/build-vercel-api.mjs` — bundles the API into `client/api/index.js` for
  client-root Vercel deployments (`npm run build:vercel-api`).
- `scripts/e2e-serverless.mjs` — end-to-end test of a serverless entrypoint
  (`node scripts/e2e-serverless.mjs api/index.js 3300 --mock`, or without `--mock`
  to add a real trader from the live Polymarket leaderboard).

## Data integrity rules (enforced by design)

- Never invent trades, P&L, or win rates — every number traces to a Polymarket response.
- Open positions are never treated as wins/losses; win rate derives from **final market
  resolutions** only (realized P&L is a separate metric and is never used to decide a
  win), and is `N/A` when nothing was decided in the window. Ambiguous records become
  `UNDETERMINED` with a stored reason instead of a guess.
- Shares ≠ dollars: `price`, `shares`, and `value = price × shares` are kept distinct.
- Dedupe keys make ingestion idempotent; timestamps are shown relative *and* exact
  (hover), and data freshness is always labelled ("Updated 12 seconds ago").
- Failures are per-wallet (status + backoff), never dashboard-wide; stale data is
  explicitly marked as stale.

## Security

- No credentials are requested, stored, or proxied — only public endpoints are called.
- Server-side credentials live in `.env` (none are required for this app); nothing
  secret is ever shipped to the client bundle.
- Input validation/sanitization on add-trader (URL/address/username parsing only).
