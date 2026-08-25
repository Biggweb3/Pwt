/**
 * syncEngine.js — background synchronization for all tracked wallets.
 *
 * Design goals (per spec):
 *  - each wallet has independent state; one failing wallet never blocks others
 *  - idempotent ingestion (stable dedupe keys) so re-fetching never duplicates
 *  - incremental sync: after the initial backfill we only request rows newer
 *    than the newest stored timestamp (`start=` window), not full history
 *  - configurable poll interval with exponential backoff on failure
 *  - transport-agnostic: each HTTP request is executed either server-side or,
 *    when the server has no egress to Polymarket, delegated to the connected
 *    browser via the bridge (see bridge.js)
 */
import { config } from './config.js';
import { db, getWallet, updateWallet, insertTrades, insertActivity, replacePositions, upsertClosedPositions } from './db.js';
import * as pm from './polymarketService.js';
import { computeDashboardStats } from './analytics.js';
import { evaluateNewTrades, evaluateNewActivity, evaluateWinRate } from './alerts.js';
import { broadcast } from './events.js';
import { nowSec, tradeDedupeKey, activityDedupeKey } from './util.js';
import { transportGet, qs } from './transport.js';

const syncing = new Set();
let started = false;

const execGet = transportGet;
const D = config.hosts.data;

// ---------------------------------------------------------------------------
// ingestion helpers (idempotent)
// ---------------------------------------------------------------------------
function existingKeys(table, keys) {
  if (!keys.length) return new Set();
  const found = new Set();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT dedupe_key FROM ${table} WHERE dedupe_key IN (${ph})`).all(...chunk)) {
      found.add(row.dedupe_key);
    }
  }
  return found;
}

/** Ingest raw /trades rows. Returns newly added normalized trades. */
export function ingestTradesRaw(walletId, rawRows) {
  const now = nowSec();
  const rows = (rawRows || []).map((r) => pm.normalizeTrade(r, walletId)).filter((r) => r.ts);
  for (const r of rows) r.dedupe_key = tradeDedupeKey(r);
  const have = existingKeys('trades', rows.map((r) => r.dedupe_key));
  const fresh = rows.filter((r) => !have.has(r.dedupe_key)).map((r) => ({ ...r, fetched_at: now }));
  if (fresh.length) insertTrades(fresh);
  return fresh;
}

export function ingestActivityRaw(walletId, rawRows) {
  const now = nowSec();
  const rows = (rawRows || []).map((r) => pm.normalizeActivity(r, walletId)).filter((r) => r.ts);
  for (const r of rows) r.dedupe_key = activityDedupeKey(r);
  const have = existingKeys('activity', rows.map((r) => r.dedupe_key));
  const fresh = rows.filter((r) => !have.has(r.dedupe_key)).map((r) => ({ ...r, fetched_at: now }));
  if (fresh.length) insertActivity(fresh);
  return fresh;
}

export function ingestPositionsRaw(walletId, rawRows) {
  const rows = (rawRows || []).map(pm.normalizePosition).filter((r) => r.asset);
  replacePositions(walletId, rows, nowSec());
  return rows.length;
}

export function ingestClosedPositionsRaw(walletId, rawRows) {
  const rows = (rawRows || []).map(pm.normalizeClosedPosition).filter((r) => r.asset);
  upsertClosedPositions(walletId, rows, nowSec());
  return rows.length;
}

/** Refresh API-provided stats (lb-api windows, portfolio value, markets traded). */
async function refreshApiStats(walletId, address) {
  const windows = ['1d', '7d', '30d', 'all'];
  const stats = { pnl: {}, volume: {}, fetchedAt: nowSec() };
  const amt = async (path, w) => {
    try {
      const rows = await execGet(qs(`${config.hosts.lb}/${path}`, { window: w, address, limit: 1 }));
      const row = Array.isArray(rows) && rows.length ? rows[0] : null;
      const n = row ? Number(row.amount) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };
  for (const w of windows) {
    const [p, v] = await Promise.all([amt('profit', w), amt('volume', w)]);
    stats.pnl[w] = p;
    stats.volume[w] = v;
  }
  try {
    const rows = await execGet(qs(`${config.hosts.data}/value`, { user: address }));
    const row = Array.isArray(rows) ? rows[0] : null;
    stats.value = row && Number.isFinite(Number(row.value)) ? Number(row.value) : null;
  } catch { stats.value = null; }
  try {
    const row = await execGet(qs(`${config.hosts.data}/traded`, { user: address }));
    stats.marketsTraded = row && Number.isFinite(Number(row.traded)) ? Number(row.traded) : null;
  } catch { stats.marketsTraded = null; }
  return stats;
}

function refreshProfile(wallet, rawProfile) {
  if (!rawProfile) return;
  const patch = {};
  if (rawProfile.name && rawProfile.displayUsernamePublic !== false) patch.username = rawProfile.name;
  else if (!wallet.username && rawProfile.pseudonym) patch.username = rawProfile.pseudonym;
  if (rawProfile.pseudonym) patch.pseudonym = rawProfile.pseudonym;
  if (rawProfile.profileImage) patch.profile_image = rawProfile.profileImage;
  if (rawProfile.bio) patch.bio = rawProfile.bio;
  if (rawProfile.xUsername) patch.x_username = rawProfile.xUsername;
  patch.verified = rawProfile.verifiedBadge ? 1 : 0;
  if (rawProfile.createdAt) patch.polymarket_created_at = rawProfile.createdAt;
  if (Object.keys(patch).length) updateWallet(wallet.id, patch);
}

// ---------------------------------------------------------------------------
// full sync cycle for one wallet
// ---------------------------------------------------------------------------
async function runCycle(wallet) {
  const address = wallet.address;
  const now = nowSec();
  updateWallet(wallet.id, { status: 'syncing', last_attempt_at: now });
  broadcast('wallet:update', { walletId: wallet.id, status: 'syncing' });

  let newTrades = [];
  let newActivity = [];
  let apiStats = null;

  try {
    if (!wallet.initial_sync_done) {
      // ---- initial historical sync ---------------------------------------
      // profile metadata (non-fatal if unavailable)
      try {
        const raw = await execGet(qs(`${config.hosts.gamma}/public-profile`, { address }));
        refreshProfile(wallet, raw && raw.proxyWallet ? {
          proxyWallet: raw.proxyWallet, name: raw.name || null, pseudonym: raw.pseudonym || null,
          bio: raw.bio || null, profileImage: raw.profileImage || raw.profileImageOptimized || null,
          xUsername: raw.xUsername || null, verifiedBadge: !!raw.verifiedBadge,
          displayUsernamePublic: raw.displayUsernamePublic ?? true, createdAt: raw.createdAt || null,
        } : null);
      } catch { /* profile is optional; some addresses have none */ }

      // trades backfill (bounded by config)
      const floorTs = now - config.initialHistoryDays * 86400;
      let offset = 0;
      let total = 0;
      let historyComplete = false;
      while (offset < config.initialMaxTrades) {
        const page = await execGet(qs(`${D}/trades`, { user: address, limit: 500, offset, takerOnly: true }));
        if (!Array.isArray(page)) break;
        newTrades.push(...ingestTradesRaw(wallet.id, page));
        total += page.length;
        if (page.length < 500) { historyComplete = true; break; }
        const oldest = page[page.length - 1]?.timestamp;
        if (oldest && oldest < floorTs) break;
        offset += 500;
      }

      // activity backfill (trades + redeems etc.), capped at 1000 rows
      for (const offsetA of [0, 500]) {
        const page = await execGet(qs(`${D}/activity`, { user: address, limit: 500, offset: offsetA, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }));
        if (!Array.isArray(page)) break;
        newActivity.push(...ingestActivityRaw(wallet.id, page));
        if (page.length < 500) break;
      }

      // positions snapshot + closed positions
      const pos = await execGet(qs(`${D}/positions`, { user: address, limit: 500, sortBy: 'CURRENT', sortDirection: 'DESC' }));
      ingestPositionsRaw(wallet.id, Array.isArray(pos) ? pos : []);
      let closedOffset = 0;
      while (closedOffset < config.maxClosedPositions) {
        const page = await execGet(qs(`${D}/closed-positions`, { user: address, limit: 500, offset: closedOffset }));
        if (!Array.isArray(page) || !page.length) break;
        ingestClosedPositionsRaw(wallet.id, page);
        if (page.length < 500) break;
        closedOffset += 500;
      }

      apiStats = await refreshApiStats(wallet.id, address);
      db.prepare('UPDATE wallets SET history_complete = ? WHERE id = ?').run(historyComplete ? 1 : 0, wallet.id);
      db.prepare('UPDATE wallets SET initial_sync_done = 1 WHERE id = ?').run(wallet.id);
    } else {
      // ---- incremental sync ----------------------------------------------
      const w = getWallet(wallet.id);
      if (w.newest_trade_ts) {
        const page = await execGet(qs(`${D}/trades`, { user: address, limit: 500, start: w.newest_trade_ts, takerOnly: true }));
        if (Array.isArray(page)) newTrades.push(...ingestTradesRaw(wallet.id, page));
      }
      if (w.newest_activity_ts) {
        const page = await execGet(qs(`${D}/activity`, { user: address, limit: 500, start: w.newest_activity_ts, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }));
        if (Array.isArray(page)) newActivity.push(...ingestActivityRaw(wallet.id, page));
      }

      const cycles = w.sync_cycles + 1;
      if (cycles % config.positionsRefreshEvery === 0) {
        const pos = await execGet(qs(`${D}/positions`, { user: address, limit: 500, sortBy: 'CURRENT', sortDirection: 'DESC' }));
        ingestPositionsRaw(wallet.id, Array.isArray(pos) ? pos : []);
      }
      if (cycles % config.closedRefreshEvery === 0) {
        const page = await execGet(qs(`${D}/closed-positions`, { user: address, limit: 500 }));
        if (Array.isArray(page) && page.length) ingestClosedPositionsRaw(wallet.id, page);
      }
      if (cycles % config.statsRefreshEvery === 0) {
        apiStats = await refreshApiStats(wallet.id, address);
      }
      // occasionally refresh profile metadata (name/avatar can change)
      if (cycles % 40 === 0) {
        try {
          const raw = await execGet(qs(`${config.hosts.gamma}/public-profile`, { address }));
          if (raw && raw.proxyWallet) refreshProfile(getWallet(wallet.id), {
            proxyWallet: raw.proxyWallet, name: raw.name || null, pseudonym: raw.pseudonym || null,
            bio: raw.bio || null, profileImage: raw.profileImage || raw.profileImageOptimized || null,
            xUsername: raw.xUsername || null, verifiedBadge: !!raw.verifiedBadge,
            displayUsernamePublic: raw.displayUsernamePublic ?? true, createdAt: raw.createdAt || null,
          });
        } catch { /* non-fatal */ }
      }
    }

    // ---- post-processing ---------------------------------------------------
    const tb = db.prepare('SELECT MIN(ts) lo, MAX(ts) hi FROM trades WHERE wallet = ?').get(wallet.id);
    const ab = db.prepare('SELECT MAX(ts) hi FROM activity WHERE wallet = ?').get(wallet.id);
    const prevStats = safeJson(getWallet(wallet.id).stats_json);
    const stats = computeDashboardStats(wallet.id, apiStats || prevStats?.api || null);
    updateWallet(wallet.id, {
      status: 'live',
      last_success_at: nowSec(),
      last_error: null,
      consecutive_errors: 0,
      sync_cycles: (wallet.sync_cycles || 0) + 1,
      newest_trade_ts: tb.hi || null,
      oldest_trade_ts: tb.lo || null,
      newest_activity_ts: ab.hi || null,
      stats_json: JSON.stringify(stats),
    });

    if (newTrades.length) {
      const wNow = getWallet(wallet.id);
      evaluateNewTrades(wallet.id, wNow.username || wNow.pseudonym, newTrades);
      broadcast('trades:new', {
        walletId: wallet.id,
        count: newTrades.length,
        sample: newTrades.slice(0, 3).map((t) => ({ ts: t.ts, side: t.side, value: t.value, title: t.title, outcome: t.outcome })),
      });
    }
    if (newActivity.length) {
      const wNow = getWallet(wallet.id);
      evaluateNewActivity(wallet.id, wNow.username || wNow.pseudonym, newActivity);
      broadcast('activity:new', { walletId: wallet.id, count: newActivity.length });
    }
    if (newTrades.length || newActivity.length) broadcast('feed:update', {});
    evaluateWinRate(wallet.id, getWallet(wallet.id).username || getWallet(wallet.id).pseudonym, stats.winRateAll);
    broadcast('wallet:update', { walletId: wallet.id, status: 'live', stats });
    return { ok: true, newTrades: newTrades.length, newActivity: newActivity.length };
  } catch (err) {
    const w = getWallet(wallet.id);
    const consecutive = (w.consecutive_errors || 0) + 1;
    updateWallet(wallet.id, {
      status: 'error',
      last_error: String(err?.message || err).slice(0, 300),
      consecutive_errors: consecutive,
    });
    broadcast('wallet:update', { walletId: wallet.id, status: 'error', error: String(err?.message || err).slice(0, 200) });
    return { ok: false, error: String(err?.message || err) };
  }
}

const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** Effective delay before the next attempt (exponential backoff on errors). */
function effectiveInterval(w) {
  const base = w.poll_interval || config.defaultPollInterval;
  const errs = Math.min(w.consecutive_errors || 0, 5);
  return Math.min(base * Math.pow(2, errs), 600);
}

export function isDue(w, now) {
  if (syncing.has(w.id)) return false;
  if (w.status === 'syncing') return false;
  const last = w.last_attempt_at || 0;
  return now - last >= effectiveInterval(w);
}

export async function syncWalletNow(walletId) {
  const w = getWallet(walletId);
  if (!w || syncing.has(walletId)) return null;
  syncing.add(walletId);
  try {
    return await runCycle(w);
  } finally {
    syncing.delete(walletId);
  }
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------
async function tick() {
  const wallets = db.prepare('SELECT * FROM wallets').all();
  if (!wallets.length) return;
  const now = nowSec();
  const due = wallets.filter((w) => isDue(w, now));
  const slots = Math.max(0, config.maxConcurrentSyncs - syncing.size);
  for (const w of due.slice(0, slots)) {
    syncWalletNow(w.id).catch((err) => console.error(`[sync] ${w.id}:`, err?.message || err));
  }
}

export function startSyncEngine() {
  if (started) return;
  started = true;
  setInterval(() => { tick().catch(() => {}); }, 3000);
  setTimeout(() => { tick().catch(() => {}); }, 500);
}

export const activeSyncCount = () => syncing.size;
