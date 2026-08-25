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

/** Replace the open-positions snapshot for a wallet. */
export function replacePositions(walletId, rows, now) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM positions WHERE wallet = ?').run(walletId);
    const ins = db.prepare(`INSERT INTO positions
      (wallet, asset, condition_id, size, avg_price, initial_value, current_value, cash_pnl, percent_pnl, cur_price, redeemable, title, slug, event_slug, outcome, outcome_index, end_date, updated_at)
      VALUES (@wallet, @asset, @condition_id, @size, @avg_price, @initial_value, @current_value, @cash_pnl, @percent_pnl, @cur_price, @redeemable, @title, @slug, @event_slug, @outcome, @outcome_index, @end_date, @updated_at)`);
    for (const r of rows) ins.run({ ...r, wallet: walletId, updated_at: now });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

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
