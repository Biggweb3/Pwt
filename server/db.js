import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// Persistent, lightweight database (built-in node:sqlite — SQLite under the hood).
// Stores only public Polymarket data; no credentials of any kind.
export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS wallets (
  id                TEXT PRIMARY KEY,            -- lowercase proxy wallet address
  address           TEXT NOT NULL UNIQUE,
  username          TEXT,
  pseudonym         TEXT,
  bio               TEXT,
  profile_image     TEXT,
  x_username        TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,
  polymarket_created_at TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending|syncing|live|error
  last_attempt_at   INTEGER,
  last_success_at   INTEGER,
  last_error        TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  sync_cycles       INTEGER NOT NULL DEFAULT 0,
  initial_sync_done INTEGER NOT NULL DEFAULT 0,
  newest_trade_ts   INTEGER,
  newest_activity_ts INTEGER,
  oldest_trade_ts   INTEGER,
  history_complete  INTEGER NOT NULL DEFAULT 0,  -- 1 when backfill reached its floor
  added_at          INTEGER NOT NULL,
  poll_interval     INTEGER NOT NULL DEFAULT ${config.defaultPollInterval},
  stats_json        TEXT                          -- cached dashboard stats (JSON)
);

CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT NOT NULL UNIQUE,
  wallet        TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  side          TEXT NOT NULL,                   -- BUY | SELL
  condition_id  TEXT,
  asset         TEXT,
  title         TEXT,
  slug          TEXT,
  event_slug    TEXT,
  icon          TEXT,
  outcome       TEXT,
  outcome_index INTEGER,
  price         REAL,
  shares        REAL,
  value         REAL,
  tx_hash       TEXT,
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_ts ON trades(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts DESC);

CREATE TABLE IF NOT EXISTS activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT NOT NULL UNIQUE,
  wallet        TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,                   -- TRADE|REDEEM|SPLIT|MERGE|REWARD|CONVERSION|...
  condition_id  TEXT,
  asset         TEXT,
  title         TEXT,
  slug          TEXT,
  event_slug    TEXT,
  icon          TEXT,
  outcome       TEXT,
  outcome_index INTEGER,
  side          TEXT,
  price         REAL,
  shares        REAL,
  usdc          REAL,
  tx_hash       TEXT,
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_wallet_ts ON activity(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);

CREATE TABLE IF NOT EXISTS positions (
  wallet        TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset         TEXT NOT NULL,
  condition_id  TEXT,
  size          REAL,
  avg_price     REAL,
  initial_value REAL,
  current_value REAL,
  cash_pnl      REAL,
  percent_pnl   REAL,
  realized_pnl  REAL,                    -- partial exits already booked on this token
  total_bought  REAL,
  cur_price     REAL,
  redeemable    INTEGER,
  title         TEXT,
  slug          TEXT,
  event_slug    TEXT,
  outcome       TEXT,
  outcome_index INTEGER,
  end_date      TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (wallet, asset)
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet, current_value DESC);

CREATE TABLE IF NOT EXISTS closed_positions (
  wallet        TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset         TEXT NOT NULL,
  condition_id  TEXT,
  avg_price     REAL,
  total_bought  REAL,
  realized_pnl  REAL,
  cur_price     REAL,
  ts            INTEGER,
  title         TEXT,
  slug          TEXT,
  event_slug    TEXT,
  outcome       TEXT,
  outcome_index INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (wallet, asset)
);
CREATE INDEX IF NOT EXISTS idx_closed_wallet_ts ON closed_positions(wallet, ts DESC);

/**
 * Authoritative per-market resolution cache (global, not per wallet — one market is
 * shared by every trader). Written only by predictions.js. A market is looked up once
 * and never re-fetched while it stays resolved; open markets are retried on a delay.
 */
CREATE TABLE IF NOT EXISTS market_resolutions (
  condition_id    TEXT PRIMARY KEY,
  slug            TEXT,
  question        TEXT,
  market_state    TEXT NOT NULL DEFAULT 'unknown',  -- resolved|open|flat|voided|not_found|unreachable
  closed          INTEGER NOT NULL DEFAULT 0,       -- market is closed for trading
  resolved        INTEGER NOT NULL DEFAULT 0,       -- we know the final outcome
  winning_index   INTEGER,                          -- index of the winning outcome
  winning_outcome TEXT,                             -- label of the winning outcome
  winning_token   TEXT,                             -- CLOB token id of the winning outcome
  outcomes_json   TEXT,                             -- JSON: [{outcome,index,token_id,price,winner}]
  closed_at       INTEGER,                           -- when the market closed/resolved (best available)
  source          TEXT,                             -- 'clob'|'gamma'
  reason          TEXT,                             -- why not resolved / why lookup failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  fetched_at      INTEGER NOT NULL
);

/**
 * One row per (wallet, market) *prediction*: every trade/position belonging to the
 * same market outcome is grouped into this single auditable record, so 5 buys + 3
 * sells in one market never become 8 wins/losses.
 *   result = WIN | LOSS | UNDETERMINED
 *   status = COMPLETED (position settled/closed) | OPEN (still holding, market live)
 */
CREATE TABLE IF NOT EXISTS predictions (
  prediction_id    TEXT PRIMARY KEY,
  wallet           TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  condition_id     TEXT NOT NULL,
  market_name      TEXT,
  market_slug      TEXT,
  event_slug       TEXT,
  predicted_outcome TEXT,
  predicted_index  INTEGER,
  final_outcome    TEXT,
  final_index      INTEGER,
  result           TEXT NOT NULL,             -- WIN | LOSS | UNDETERMINED
  status           TEXT NOT NULL,             -- COMPLETED | OPEN
  reason           TEXT,                      -- exclusion / ambiguity reason code
  cost_usdc        REAL,                       -- total cost basis of the position(s)
  proceeds_usdc    REAL,                       -- sold + redeemed value
  realized_pnl     REAL,                       -- trading P&L (never used for WIN/LOSS)
  unrealized_pnl   REAL,
  total_pnl        REAL,
  shares_predicted REAL,                       -- shares still held on predicted token
  trades_count     INTEGER NOT NULL DEFAULT 0, -- transactions grouped into this prediction
  positions_count  INTEGER NOT NULL DEFAULT 0, -- outcome tokens grouped into it
  hedged           INTEGER NOT NULL DEFAULT 0, -- exposure on more than one outcome
  started_at       INTEGER,                    -- first transaction in the market
  completed_at     INTEGER,                    -- position completion time (sort key)
  completed_from   TEXT,                       -- 'closed_position'|'redeem'|'resolution'|'last_trade'
  resolved_at      INTEGER,                    -- market resolution time
  source_transactions TEXT,                    -- JSON: transactions behind this prediction
  resolution_source   TEXT,                    -- 'clob'|'gamma'|null
  needs_resolution    INTEGER NOT NULL DEFAULT 0, -- 1 while this row still lacks an authoritative outcome
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pred_wallet_result ON predictions(wallet, result, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pred_wallet_status ON predictions(wallet, status, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pred_wallet_cond ON predictions(wallet, condition_id);

CREATE TABLE IF NOT EXISTS alert_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  kind       TEXT NOT NULL,      -- new_trade | large_trade | market_entry | position_closed | winrate_cross
  wallet     TEXT,               -- null = any tracked wallet
  params     TEXT,               -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  wallet  TEXT,
  kind    TEXT NOT NULL,
  message TEXT NOT NULL,
  meta    TEXT,
  read    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------- migrations (additive only; safe to re-run on every boot) ----------
const hasColumn = (table, column) =>
  db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;

/** Add a column if an older database file predates it (never destructive). */
function ensureColumn(table, column, decl) {
  try {
    if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch { /* older SQLite without pragma_table_info — columns stay absent and callers tolerate null */ }
}

ensureColumn('wallets', 'closed_newest_ts', 'INTEGER');
ensureColumn('wallets', 'closed_history_complete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('wallets', 'positions_scan_complete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('wallets', 'predictions_updated_at', 'INTEGER');
ensureColumn('wallets', 'predictions_json', 'TEXT');
ensureColumn('positions', 'realized_pnl', 'REAL');
ensureColumn('positions', 'total_bought', 'REAL');

// ---------- generic helpers ----------
export const getSetting = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};
export const setSetting = (key, value) => {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
};

// ---------- wallets ----------
export const insertWallet = (w) =>
  db.prepare(`INSERT INTO wallets (id, address, username, pseudonym, bio, profile_image, x_username, verified,
    polymarket_created_at, status, added_at, poll_interval)
    VALUES (@id, @address, @username, @pseudonym, @bio, @profile_image, @x_username, @verified,
    @polymarket_created_at, 'pending', @added_at, @poll_interval)`).run(w);

export const getWallet = (id) => db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
export const listWallets = () => db.prepare('SELECT * FROM wallets ORDER BY added_at ASC').all();
export const walletExists = (id) => !!db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(id);

export function updateWallet(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE wallets SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export const deleteWallet = (id) => db.prepare('DELETE FROM wallets WHERE id = ?').run(id);

export const countWallets = () => db.prepare('SELECT COUNT(*) c FROM wallets').get().c;

// ---------- trades ----------
const insTrade = db.prepare(`INSERT OR IGNORE INTO trades
  (dedupe_key, wallet, ts, side, condition_id, asset, title, slug, event_slug, icon, outcome, outcome_index, price, shares, value, tx_hash, fetched_at)
  VALUES (@dedupe_key, @wallet, @ts, @side, @condition_id, @asset, @title, @slug, @event_slug, @icon, @outcome, @outcome_index, @price, @shares, @value, @tx_hash, @fetched_at)`);

/** Insert trades; returns { inserted } (rows actually added). Idempotent via dedupe_key. */
export function insertTrades(rows) {
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) if (insTrade.run(r).changes > 0) inserted++;
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { inserted };
}

const insActivity = db.prepare(`INSERT OR IGNORE INTO activity
  (dedupe_key, wallet, ts, type, condition_id, asset, title, slug, event_slug, icon, outcome, outcome_index, side, price, shares, usdc, tx_hash, fetched_at)
  VALUES (@dedupe_key, @wallet, @ts, @type, @condition_id, @asset, @title, @slug, @event_slug, @icon, @outcome, @outcome_index, @side, @price, @shares, @usdc, @tx_hash, @fetched_at)`);

export function insertActivity(rows) {
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) if (insActivity.run(r).changes > 0) inserted++;
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { inserted };
}

/**
 * Replace the open-positions snapshot for a wallet. The caller pages through the
 * whole endpoint (up to a configured cap) so that zero-value resolved-but-unredeemed
 * positions — the ones Polymarket's `closed-positions` never shows — survive the
 * snapshot instead of silently disappearing.
 */
export function replacePositions(walletId, rows, now, { complete = true } = {}) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM positions WHERE wallet = ?').run(walletId);
    const ins = db.prepare(`INSERT INTO positions
      (wallet, asset, condition_id, size, avg_price, initial_value, current_value, cash_pnl, percent_pnl, realized_pnl, total_bought, cur_price, redeemable, title, slug, event_slug, outcome, outcome_index, end_date, updated_at)
      VALUES (@wallet, @asset, @condition_id, @size, @avg_price, @initial_value, @current_value, @cash_pnl, @percent_pnl, @realized_pnl, @total_bought, @cur_price, @redeemable, @title, @slug, @event_slug, @outcome, @outcome_index, @end_date, @updated_at)`);
    for (const r of rows) ins.run({ realized_pnl: null, total_bought: null, ...r, wallet: walletId, updated_at: now });
    db.prepare('UPDATE wallets SET positions_scan_complete = ? WHERE id = ?').run(complete ? 1 : 0, walletId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/** Newest closed-position timestamp stored (drives the incremental `start` window). */
export const getClosedBounds = (walletId) =>
  db.prepare('SELECT MIN(ts) lo, MAX(ts) hi, COUNT(*) c FROM closed_positions WHERE wallet = ?').get(walletId);

export function upsertClosedPositions(walletId, rows, now) {
  const ins = db.prepare(`INSERT INTO closed_positions
    (wallet, asset, condition_id, avg_price, total_bought, realized_pnl, cur_price, ts, title, slug, event_slug, outcome, outcome_index, updated_at)
    VALUES (@wallet, @asset, @condition_id, @avg_price, @total_bought, @realized_pnl, @cur_price, @ts, @title, @slug, @event_slug, @outcome, @outcome_index, @updated_at)
    ON CONFLICT(wallet, asset) DO UPDATE SET
      condition_id=excluded.condition_id, avg_price=excluded.avg_price, total_bought=excluded.total_bought,
      realized_pnl=excluded.realized_pnl, cur_price=excluded.cur_price, ts=excluded.ts, title=excluded.title,
      slug=excluded.slug, event_slug=excluded.event_slug, outcome=excluded.outcome, outcome_index=excluded.outcome_index,
      updated_at=excluded.updated_at`);
  db.exec('BEGIN');
  try {
    for (const r of rows) ins.run({ ...r, wallet: walletId, updated_at: now });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ---------- market resolutions (authoritative outcome cache) ----------
const insResolution = db.prepare(`INSERT INTO market_resolutions
  (condition_id, slug, question, market_state, closed, resolved, winning_index, winning_outcome, winning_token,
   outcomes_json, closed_at, source, reason, attempts, last_attempt_at, fetched_at)
  VALUES (@condition_id, @slug, @question, @market_state, @closed, @resolved, @winning_index, @winning_outcome, @winning_token,
   @outcomes_json, @closed_at, @source, @reason, @attempts, @last_attempt_at, @fetched_at)
  ON CONFLICT(condition_id) DO UPDATE SET
    slug=excluded.slug, question=excluded.question, market_state=excluded.market_state, closed=excluded.closed,
    resolved=excluded.resolved, winning_index=excluded.winning_index, winning_outcome=excluded.winning_outcome,
    winning_token=excluded.winning_token, outcomes_json=excluded.outcomes_json, closed_at=excluded.closed_at,
    source=excluded.source, reason=excluded.reason, attempts=excluded.attempts,
    last_attempt_at=excluded.last_attempt_at, fetched_at=excluded.fetched_at`);

/**
 * Persist (or refresh) one market's resolution record.
 * Values are coerced at the boundary: upstream flags arrive as booleans (and outcome
 * lists as arrays), which SQLite refuses to bind — silently failing a resolution
 * write is exactly the kind of bug that leaves every prediction "unresolved", so the
 * conversion lives here rather than in each caller.
 */
const bindable = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export function upsertMarketResolution(r) {
  const base = {
    condition_id: null, slug: null, question: null, market_state: 'unknown', closed: 0, resolved: 0,
    winning_index: null, winning_outcome: null, winning_token: null, outcomes: null, outcomes_json: null,
    closed_at: null, source: null, reason: null, attempts: 0, last_attempt_at: null, fetched_at: null,
    ...r,
  };
  const outcomesJson = base.outcomes_json ?? (base.outcomes != null ? JSON.stringify(base.outcomes) : null);
  insResolution.run({
    condition_id: bindable(base.condition_id),
    slug: bindable(base.slug),
    question: bindable(base.question),
    market_state: bindable(base.market_state) || 'unknown',
    closed: bindable(base.closed) || 0,
    resolved: bindable(base.resolved) || 0,
    winning_index: bindable(base.winning_index),
    winning_outcome: bindable(base.winning_outcome),
    winning_token: bindable(base.winning_token),
    outcomes_json: outcomesJson,
    closed_at: bindable(base.closed_at),
    source: bindable(base.source),
    reason: bindable(base.reason),
    attempts: bindable(base.attempts) || 0,
    last_attempt_at: bindable(base.last_attempt_at),
    fetched_at: bindable(base.fetched_at) ?? Math.floor(Date.now() / 1000),
  });
}

/** One resolution record, with the outcome list parsed back into `outcomes`. */
export function resolutionView(conditionId) {
  const row = getResolution(conditionId);
  if (!row) return null;
  let outcomes = null;
  if (row.outcomes_json) { try { outcomes = JSON.parse(row.outcomes_json); } catch { outcomes = null; } }
  return { ...row, outcomes };
}

/** Bump the attempt counter for a market whose lookup failed (backoff bookkeeping). */
export function noteResolutionAttempt(conditionId, now, reason = null) {
  db.prepare(`INSERT INTO market_resolutions (condition_id, market_state, closed, resolved, attempts, last_attempt_at, reason, fetched_at)
      VALUES (?, 'unknown', 0, 0, 1, ?, ?, ?)
      ON CONFLICT(condition_id) DO UPDATE SET attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at,
        reason = COALESCE(excluded.reason, market_resolutions.reason), fetched_at = excluded.fetched_at`)
    .run(conditionId, now, reason, now);
}

export const getResolution = (conditionId) =>
  db.prepare('SELECT * FROM market_resolutions WHERE condition_id = ?').get(conditionId);

/** Condition ids still needing (re)resolution for one wallet, oldest prediction first. */
export function pendingResolutionIds(walletId, now, { retrySec, maxAttempts, limit }) {
  return db.prepare(`
    SELECT p.condition_id AS condition_id, MIN(p.updated_at) AS seen
    FROM predictions p
    LEFT JOIN market_resolutions r ON r.condition_id = p.condition_id
    WHERE p.wallet = ?
      AND p.needs_resolution = 1
      AND (r.condition_id IS NULL
           OR (r.resolved = 0 AND r.attempts < ? AND (r.last_attempt_at IS NULL OR r.last_attempt_at <= ?)))
    GROUP BY p.condition_id
    ORDER BY p.completed_at DESC
    LIMIT ?`)
    .all(walletId, maxAttempts, now - retrySec, limit)
    .map((r) => r.condition_id);
}

// ---------- predictions (grouped, classified position outcomes) ----------
const insPrediction = db.prepare(`INSERT INTO predictions
  (prediction_id, wallet, condition_id, market_name, market_slug, event_slug, predicted_outcome, predicted_index,
   final_outcome, final_index, result, status, reason, cost_usdc, proceeds_usdc, realized_pnl, unrealized_pnl,
   total_pnl, shares_predicted, trades_count, positions_count, hedged, started_at, completed_at, completed_from,
   resolved_at, source_transactions, resolution_source, needs_resolution, updated_at)
  VALUES (@prediction_id, @wallet, @condition_id, @market_name, @market_slug, @event_slug, @predicted_outcome, @predicted_index,
   @final_outcome, @final_index, @result, @status, @reason, @cost_usdc, @proceeds_usdc, @realized_pnl, @unrealized_pnl,
   @total_pnl, @shares_predicted, @trades_count, @positions_count, @hedged, @started_at, @completed_at, @completed_from,
   @resolved_at, @source_transactions, @resolution_source, @needs_resolution, @updated_at)`);

/**
 * Rebuild all predictions for a wallet atomically (the set is derived from stored
 * position/trade rows, so a full rebuild is idempotent and cheaper to reason about
 * than diffing). `needs_resolution` drives the progressive market-lookup queue.
 */
export function replacePredictions(walletId, rows, now) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM predictions WHERE wallet = ?').run(walletId);
    for (const r of rows) insPrediction.run({ ...r, wallet: walletId, updated_at: now });
    db.prepare('UPDATE wallets SET predictions_updated_at = ? WHERE id = ?').run(now, walletId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function listPredictions(walletId, { result = null, status = null, limit = 250, offset = 0 } = {}) {
  const where = ['wallet = ?'];
  const params = [walletId];
  if (result) { where.push('result = ?'); params.push(result); }
  if (status) { where.push('status = ?'); params.push(status); }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM predictions WHERE ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT condition_id, market_name, market_slug, event_slug, predicted_outcome, predicted_index,
           final_outcome, final_index, result, status, reason, cost_usdc, proceeds_usdc, realized_pnl,
           unrealized_pnl, total_pnl, shares_predicted, trades_count, positions_count, hedged,
           started_at, completed_at, completed_from, resolved_at, source_transactions, resolution_source
    FROM predictions WHERE ${whereSql}
    ORDER BY (completed_at IS NULL), completed_at DESC, market_name ASC
    LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows };
}

export const predictionCounts = (walletId) => db.prepare(`
  SELECT result, status, COUNT(*) c, SUM(COALESCE(total_pnl,0)) pnl, SUM(COALESCE(cost_usdc,0)) cost
  FROM predictions WHERE wallet = ? GROUP BY result, status`).all(walletId);

/**
 * Completed predictions, newest first — the input for every win-rate window.
 * `cutoff` restricts to a time period (used by the 24h/7d/30d summaries).
 */
export function recentCompletedPredictions(walletId, limit = 400, cutoff = null) {
  const where = ["wallet = ?", "status = 'COMPLETED'"];
  const params = [walletId];
  if (cutoff) { where.push('completed_at IS NOT NULL AND completed_at >= ?'); params.push(cutoff); }
  return db.prepare(`
    SELECT result, completed_at, realized_pnl, total_pnl, cost_usdc, reason, status
    FROM predictions WHERE ${where.join(' AND ')}
    ORDER BY completed_at DESC LIMIT ?`).all(...params, limit);
}

export const predictionTotals = (walletId, cutoff = null) => {
  const where = ["wallet = ?", "status = 'COMPLETED'"];
  const params = [walletId];
  if (cutoff) { where.push('completed_at IS NOT NULL AND completed_at >= ?'); params.push(cutoff); }
  return db.prepare(`
    SELECT SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) losses,
           SUM(CASE WHEN result='UNDETERMINED' THEN 1 ELSE 0 END) undetermined,
           COUNT(*) completed,
           SUM(COALESCE(total_pnl,0)) pnl,
           SUM(COALESCE(realized_pnl,0)) realized_pnl,
           SUM(COALESCE(cost_usdc,0)) cost,
           MIN(completed_at) oldest, MAX(completed_at) newest
    FROM predictions WHERE ${where.join(' AND ')}`).get(...params);
};

export const openPredictionCount = (walletId) =>
  db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN needs_resolution=1 THEN 1 ELSE 0 END) pending
              FROM predictions WHERE wallet = ? AND status = 'OPEN'`).get(walletId);

export const pendingResolutionCount = (walletId) =>
  db.prepare(`SELECT COUNT(DISTINCT condition_id) c FROM predictions WHERE wallet = ? AND needs_resolution = 1`)
    .get(walletId).c || 0;

// ---------- queries used by API/analytics ----------
export const getTradeBounds = (walletId) =>
  db.prepare('SELECT MIN(ts) lo, MAX(ts) hi, COUNT(*) c FROM trades WHERE wallet = ?').get(walletId);

export const getActivityBounds = (walletId) =>
  db.prepare('SELECT MIN(ts) lo, MAX(ts) hi FROM activity WHERE wallet = ?').get(walletId);

export function globalFeed(limit = 60, sinceTs = null) {
  return db.prepare(`
    SELECT a.ts, a.type, a.side, a.title, a.slug, a.outcome, a.price, a.shares, a.usdc, a.tx_hash, a.condition_id,
           w.username, w.pseudonym, w.profile_image, w.id AS wallet
    FROM activity a JOIN wallets w ON w.id = a.wallet
    WHERE a.type IN ('TRADE','REDEEM','SPLIT','MERGE','CONVERSION')
      ${sinceTs ? 'AND a.ts > ?' : ''}
    ORDER BY a.ts DESC LIMIT ?`).all(...(sinceTs ? [sinceTs, limit] : [limit]));
}

export const unreadNotificationCount = () => db.prepare('SELECT COUNT(*) c FROM notifications WHERE read = 0').get().c;
