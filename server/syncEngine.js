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
import { rebuildPredictions, resolveMarketsForWallet } from './predictions.js';
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

export function ingestPositionsRaw(walletId, rawRows, complete = true) {
  const rows = (rawRows || []).map(pm.normalizePosition).filter((r) => r.asset);
  replacePositions(walletId, rows, nowSec(), { complete });
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
// position / closed-position paging for the prediction engine
// ---------------------------------------------------------------------------
/**
 * Open positions, paged. Two passes on purpose:
 *   • default snapshot (value DESC) — what the dashboard shows as "active positions"
 *   • `redeemable=true` — markets that already resolved while the wallet still holds
 *     the tokens. These have zero current value, so a value-ordered snapshot alone
 *     would drop them, and dropping them drops the LOSSES (a trader who lost usually
 *     just leaves the worthless tokens sitting there). That bias was a big part of why
 *     win rates looked like 100%.
 */
async function fetchPositionSnapshot(address, { pages = 2, outOfTime = () => false } = {}) {
  const byAsset = new Map();
  let complete = true;
  for (const opts of [{}, { redeemable: true }]) {
    for (let i = 0; i < pages; i++) {
      if (outOfTime()) { complete = false; break; }
      let page;
      try {
        page = await execGet(pm.positionsUrl(address, { limit: 500, offset: i * 500, sortBy: 'CURRENT', sortDirection: 'DESC', ...opts }));
      } catch (err) {
        if (!opts.redeemable) throw err;      // primary snapshot must still fail the cycle
        complete = false; break;              // optional pass unsupported — keep what we have
      }
      if (!Array.isArray(page)) { complete = false; break; }
      for (const r of page) if (r && r.asset) byAsset.set(String(r.asset), r);
      if (page.length < 500) break;
      if (i === pages - 1) complete = false;  // capped: more pages exist
    }
  }
  return { rows: [...byAsset.values()], complete };
}

/**
 * Closed positions, paged NEWEST FIRST. The endpoint sorts ascending by default, so
 * this always passes sortBy/sortDirection explicitly — without it only the oldest
 * records ever arrive and fresh settlements are never seen.
 * `afterTs` stops the walk once we are past the newest stored record (incremental).
 */
async function fetchClosedPages(address, { max, afterTs = null, outOfTime = () => false } = {}) {
  const rows = [];
  let offset = 0;
  let reachedEnd = false;
  while (offset < max) {
    if (outOfTime()) break;
    let page;
    try {
      page = await execGet(pm.closedPositionsUrl(address, { limit: 500, offset }));
    } catch (err) {
      if (offset === 0) throw err;
      break;                                  // partial result still usable
    }
    if (!Array.isArray(page)) break;
    if (!page.length) { reachedEnd = true; break; }
    rows.push(...page);
    offset += page.length;
    const oldest = Number(page[page.length - 1]?.timestamp);
    if (afterTs && Number.isFinite(oldest) && oldest <= afterTs) { reachedEnd = true; break; }
    if (page.length < 500) { reachedEnd = true; break; }
  }
  return { rows, complete: reachedEnd };
}

// ---------------------------------------------------------------------------
// full sync cycle for one wallet
// ---------------------------------------------------------------------------
async function runCycle(wallet, { deadline = Number.POSITIVE_INFINITY } = {}) {
  const address = wallet.address;
  const now = nowSec();
  const outOfTime = () => Date.now() >= deadline;
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

      // trades backfill (bounded by config and by the time budget when given)
      const floorTs = now - config.initialHistoryDays * 86400;
      let offset = 0;
      let total = 0;
      let historyComplete = false;
      // takerOnly=false = every fill (maker + taker): position reconstruction and the
      // trade table must not miss the half of the history that a taker-only view hides.
      while (offset < config.initialMaxTrades) {
        if (outOfTime()) break; // serverless budget: converge now, deepen later via resync
        const page = await execGet(qs(`${D}/trades`, { user: address, limit: 500, offset, takerOnly: false }));
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
        if (outOfTime()) break;
        const page = await execGet(qs(`${D}/activity`, { user: address, limit: 500, offset: offsetA, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }));
        if (!Array.isArray(page)) break;
        newActivity.push(...ingestActivityRaw(wallet.id, page));
        if (page.length < 500) break;
      }

      // position snapshots + closed positions — the raw material for predictions
      if (!outOfTime()) {
        const pos = await fetchPositionSnapshot(address, { pages: Math.max(1, Math.floor(config.predictionPositionPages / 2)), outOfTime });
        ingestPositionsRaw(wallet.id, pos.rows, pos.complete);
        const closed = await fetchClosedPages(address, { max: config.predictionClosedPositions, outOfTime });
        ingestClosedPositionsRaw(wallet.id, closed.rows);
        const newestClosed = closed.rows.reduce((m, r) => Math.max(m, Number(r.timestamp) || 0), 0) || null;
        db.prepare('UPDATE wallets SET closed_history_complete = ?, closed_newest_ts = ? WHERE id = ?')
          .run(closed.complete ? 1 : 0, newestClosed, wallet.id);
      }

      apiStats = await refreshApiStats(wallet.id, address);
      db.prepare('UPDATE wallets SET history_complete = ? WHERE id = ?').run(historyComplete ? 1 : 0, wallet.id);
      db.prepare('UPDATE wallets SET initial_sync_done = 1 WHERE id = ?').run(wallet.id);
    } else {
      // ---- incremental sync ----------------------------------------------
      const w = getWallet(wallet.id);
      if (w.newest_trade_ts) {
        const page = await execGet(qs(`${D}/trades`, { user: address, limit: 500, start: w.newest_trade_ts, takerOnly: false }));
        if (Array.isArray(page)) newTrades.push(...ingestTradesRaw(wallet.id, page));
      }
      if (w.newest_activity_ts) {
        const page = await execGet(qs(`${D}/activity`, { user: address, limit: 500, start: w.newest_activity_ts, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }));
        if (Array.isArray(page)) newActivity.push(...ingestActivityRaw(wallet.id, page));
      }

      const cycles = w.sync_cycles + 1;
      if (cycles % config.positionsRefreshEvery === 0) {
        const pos = await fetchPositionSnapshot(address, { pages: Math.max(1, Math.floor(config.predictionPositionPages / 2)), outOfTime });
        ingestPositionsRaw(wallet.id, pos.rows, pos.complete);
      }
      if (cycles % config.closedRefreshEvery === 0) {
        // Only walk back as far as the newest closed position already stored, so a
        // 10k-trade wallet does not re-download its whole history every cycle.
        const afterTs = w.closed_newest_ts ? w.closed_newest_ts - 60 : null;
        const closed = await fetchClosedPages(address, { max: 1000, afterTs, outOfTime });
        if (closed.rows.length) {
          ingestClosedPositionsRaw(wallet.id, closed.rows);
          const newestClosed = closed.rows.reduce((m, r) => Math.max(m, Number(r.timestamp) || 0), afterTs || 0) || null;
          db.prepare('UPDATE wallets SET closed_history_complete = ?, closed_newest_ts = ? WHERE id = ?')
            .run(closed.complete ? 1 : 0, newestClosed, wallet.id);
        }
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

    // ---- prediction engine (win rate) --------------------------------------
    // Order matters: rebuild from what is stored, resolve any markets we still lack
    // outcomes for, then rebuild so the fresh resolutions are applied. Predictions are
    // the ONLY source of every win-rate number in the app.
    const isInitial = !wallet.initial_sync_done;
    let predictionMeta = { classified: 0, lookedUp: 0, pending: 0 };
    try {
      rebuildPredictions(wallet.id);
      const res = await resolveMarketsForWallet(wallet.id, {
        budget: isInitial ? config.resolutionLookupsInitial : config.resolutionLookupsPerCycle,
        deadline: outOfTime() ? Date.now() : deadline,
      });
      if (res.lookedUp > 0) rebuildPredictions(wallet.id);
      predictionMeta = { classified: res.lookedUp, lookedUp: res.resolved || 0, pending: res.pending || 0 };
    } catch (err) {
      // Never fail a sync because a market's metadata was unavailable: the affected
      // predictions simply stay UNDETERMINED (and are retried next cycle).
      console.warn(`[predictions] ${wallet.id}: ${err?.message || err}`);
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
    // Alerts use the independently calculated prediction win rate, with its sample size.
    evaluateWinRate(wallet.id, getWallet(wallet.id).username || getWallet(wallet.id).pseudonym, stats.predictions?.primary?.winRate ?? null, stats.predictions?.primary?.analyzed ?? 0);
    broadcast('wallet:update', { walletId: wallet.id, status: 'live', stats });
    broadcast('predictions:update', {
      walletId: wallet.id,
      winRate: stats.predictions?.primary?.winRate ?? null,
      analyzed: stats.predictions?.primary?.analyzed ?? 0,
      pendingResolutions: predictionMeta.pending,
    });
    return {
      ok: true,
      newTrades: newTrades.length,
      newActivity: newActivity.length,
      predictions: stats.predictions?.primary ?? null,
      marketsResolved: predictionMeta.lookedUp,
      pendingResolutions: predictionMeta.pending,
    };
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

export async function syncWalletNow(walletId, opts = {}) {
  const w = getWallet(walletId);
  if (!w || syncing.has(walletId)) return null;
  syncing.add(walletId);
  try {
    const deadline = Number.isFinite(opts.budgetMs) ? Date.now() + opts.budgetMs : undefined;
    return await runCycle(w, { deadline });
  } finally {
    syncing.delete(walletId);
  }
}

/**
 * Request-driven sync pass (serverless mode): synchronously bring due /
 * unfinished wallets up to date within a wall-clock budget, one at a time.
 * Returns { synced: [...], remaining } so callers can keep polling.
 */
export async function syncDueWallets(budgetMs = config.serverlessSyncBudgetMs) {
  const deadline = Date.now() + Math.max(2000, budgetMs);
  const results = [];
  const now = () => nowSec();
  const pick = () => {
    const t = now();
    return db.prepare('SELECT * FROM wallets ORDER BY added_at ASC').all().filter((w) => {
      if (syncing.has(w.id)) return false;
      if (!w.initial_sync_done) return true;
      // A wallet stuck in 'syncing' (invocation frozen mid-sync) is re-eligible.
      if (w.status === 'syncing' && t - (w.last_attempt_at || 0) > 120) return true;
      return isDue(w, t);
    });
  };
  while (Date.now() < deadline - 1500) {
    const candidates = pick();
    if (!candidates.length) break;
    // Finish interrupted initial syncs first, then the oldest due wallet.
    const w = candidates.find((c) => !c.initial_sync_done) || candidates[0];
    const remaining = Math.max(1000, deadline - Date.now());
    const r = await syncWalletNow(w.id, { budgetMs: remaining });
    results.push({ wallet: w.id, ...(r || { ok: false, error: 'sync already in progress' }) });
  }
  return { synced: results, remaining: pick().length };
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
