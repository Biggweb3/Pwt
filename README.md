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
- **Dashboard** — per-trader status (🟢 LIVE / 🟡 UPDATING / 🔴 ERROR), win rate, 24h
  trades, 7d P&L, 7d volume, active positions, last activity; sortable columns.
- **Global live feed** — newest trades/redemptions across *all* tracked traders.
- **Trader detail page** — 24H/72H/7D/30D/ALL performance, cumulative P&L chart,
  active/resolved positions, filterable activity feed, paginated trades table
  (10/page, prev/next, backend-paginated).
- **Comparison view** — matrix of win rates, trades, volume, P&L across windows; sortable.
- **Live monitoring** — incremental sync engine with configurable poll interval
  (10s/30s/60s), per-wallet state, exponential backoff, and SSE push to the UI.
  One failing wallet never blocks the others.
- **Alerts** — rule engine (`new_trade`, `large_trade ≥ $X`, `market_entry` keyword,
  `position_closed`, `winrate_cross ≥ X%`) with in-app notifications + toasts. Designed
  to be extended with push channels later.
- **Data honesty** — metrics are labelled `api` (straight from Polymarket) vs
  `calculated` (derived from synced public rows). Win rate only counts *closed*
  positions (realized P&L); open positions are never wins/losses; missing data shows
  `N/A` / `Unavailable` — never invented.

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

## Polymarket data sources (verified against docs.polymarket.com + live responses)

| Purpose | Endpoint |
| --- | --- |
| Profile metadata | `GET gamma-api.polymarket.com/public-profile?address=` |
| Username → wallet | `GET gamma-api.polymarket.com/public-search?q=&search_profiles=true` |
| Trades (taker) | `GET data-api.polymarket.com/trades?user=&limit=&offset=&start=&end=&side=` |
| Activity (trade/redeem/split/merge/…) | `GET data-api.polymarket.com/activity?user=&type=&start=` |
| Open positions | `GET data-api.polymarket.com/positions?user=&sortBy=CURRENT` |
| Closed positions (realized P&L) | `GET data-api.polymarket.com/closed-positions?user=` |
| Portfolio value | `GET data-api.polymarket.com/value?user=` |
| Markets traded count | `GET data-api.polymarket.com/traded?user=` |
| P&L windows (API-provided) | `GET lb-api.polymarket.com/profit?window=1d|7d|30d|all&address=` |
| Volume windows (API-provided) | `GET lb-api.polymarket.com/volume?window=1d|7d|30d|all&address=` |
| Top traders (suggestions) | `GET data-api.polymarket.com/v1/leaderboard?period=1d` |

All endpoints are public and unauthenticated. Published rate limits (data-api: general
1,000 req/10s, `/trades` 200 req/10s, `/positions` 150 req/10s) are respected: default
poll is 30s/wallet with a concurrency cap of 3 and staggered sub-refreshes. Polymarket
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

### Scripts (test utilities)

- `scripts/mock-polymarket.mjs` — local mock of the Polymarket APIs using real captured
  fixtures; exercise server mode offline:
  `POLYMARKET_DATA_API=http://127.0.0.1:3200 POLYMARKET_GAMMA_API=… POLYMARKET_LB_API=… node server/index.js`
- `scripts/bridge-sim.mjs` — simulates the browser bridge worker against the same fixtures.

## Data integrity rules (enforced by design)

- Never invent trades, P&L, or win rates — every number traces to a Polymarket response.
- Open positions are never treated as wins/losses; win rate derives from closed
  positions' realized P&L only, and is `N/A` when nothing was decided in the window.
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
