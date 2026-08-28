import express from 'express';
import { config } from './config.js';
import {
  db, listWallets, getWallet, walletExists, insertWallet, updateWallet, deleteWallet,
  globalFeed, getSetting, setSetting, unreadNotificationCount,
} from './db.js';
import * as pm from './polymarketService.js';
import { computeDashboardStats, windowSummary, pnlSeries, PERIODS, periodCutoff, winRateSeries } from './analytics.js';
import { listPredictions, predictionTotals, resolutionView } from './db.js';
import { computePredictionStats, calculateTraderWinRate, rebuildPredictions, resolveMarketsForWallet, profitabilityFromClosedPositions, REASON_LABELS, PREDICTION_WINDOWS, PRIMARY_PREDICTION_WINDOW } from './predictions.js';
import { syncWalletNow, syncDueWallets } from './syncEngine.js';
import { sseHandler, broadcast } from './events.js';
import { claimJobs, resolveJob, noteBridgeClientSeen, bridgeInUse, pendingJobCount } from './bridge.js';
import { listRules, addRule, setRuleEnabled, updateRuleParams, deleteRule } from './alerts.js';
import { parseTraderInput, normalizeAddress, clampInt, nowSec } from './util.js';
import { transportGet, qs } from './transport.js';

export const api = express.Router();
api.use(express.json({ limit: '8mb' }));
// Also accept classic form-encoded bodies (application/x-www-form-urlencoded).
// Standard Express middleware; lets plain HTML forms / simple scripts drive
// the API without a JSON content-type (no functional difference otherwise).
api.use(express.urlencoded({ extended: false }));

const walletView = (w) => ({
  address: w.id,
  username: w.username,
  pseudonym: w.pseudonym,
  bio: w.bio,
  profileImage: w.profile_image,
  xUsername: w.x_username,
  verified: !!w.verified,
  polymarketCreatedAt: w.polymarket_created_at,
  profileUrl: `${config.profileBase}${w.id}`,
  status: w.status,
  lastAttemptAt: w.last_attempt_at,
  lastSuccessAt: w.last_success_at,
  lastError: w.last_error,
  consecutiveErrors: w.consecutive_errors,
  initialSyncDone: !!w.initial_sync_done,
  pollInterval: w.poll_interval,
  addedAt: w.added_at,
  newestTradeTs: w.newest_trade_ts,
  oldestTradeTs: w.oldest_trade_ts,
  historyComplete: !!w.history_complete,
  stats: safeJson(w.stats_json),
});
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ---------------------------------------------------------------- system ---
api.get('/system', async (req, res) => {
  const upstreamOk = await pm.probeUpstream();
  res.json({
    upstreamOk,
    mode: upstreamOk ? 'server' : 'bridge',
    deployment: config.isServerless ? 'serverless' : 'server',
    bridgeJobsPending: pendingJobCount(),
    pollInterval: parseInt(getSetting('poll_interval', config.defaultPollInterval), 10),
    serverTime: nowSec(),
  });
});

/**
 * Request-driven sync pass. On the long-lived server the background engine
 * already handles this; on serverless (Vercel) the client calls this endpoint
 * periodically to bring due wallets up to date inside a bounded budget.
 */
api.post('/sync', async (req, res) => {
  try {
    const budgetMs = clampInt(req.body?.budgetMs, 2000, 55_000, config.serverlessSyncBudgetMs);
    const result = await syncDueWallets(budgetMs);
    res.json({ ...result, deployment: config.isServerless ? 'serverless' : 'server' });
  } catch (err) {
    res.status(500).json({ error: `Sync pass failed: ${err.message}` });
  }
});

api.get('/settings', (req, res) => {
  res.json({ pollInterval: parseInt(getSetting('poll_interval', config.defaultPollInterval), 10) });
});
api.post('/settings', (req, res) => {
  const interval = clampInt(req.body?.pollInterval, 5, 600, config.defaultPollInterval);
  setSetting('poll_interval', interval);
  for (const w of listWallets()) updateWallet(w.id, { poll_interval: interval });
  res.json({ pollInterval: interval });
});

// --------------------------------------------------------------- wallets ---
api.get('/wallets', (req, res) => {
  res.json(listWallets().map(walletView));
});

/**
 * Add a trader. Input may be a profile URL (https://polymarket.com/profile/...),
 * a raw wallet address, or a display username (resolved via Gamma public search).
 */
api.post('/wallets', async (req, res) => {
  const input = String(req.body?.input || '').trim();
  const parsed = parseTraderInput(input);
  if (!parsed) return res.status(400).json({ error: 'Enter a valid Polymarket profile URL (https://polymarket.com/profile/…) or wallet address.' });

  try {
    let address = null;
    let candidates = [];
    if (parsed.kind === 'address') {
      address = parsed.value;
    } else {
      // Username -> wallet via Gamma public search (through the active transport).
      try {
        const searchUrl = qs(`${config.hosts.gamma}/public-search`, { q: parsed.value, search_profiles: true, limit_per_type: 5 });
        const sr = await transportGet(searchUrl);
        candidates = (Array.isArray(sr?.profiles) ? sr.profiles : [])
          .map((p) => ({
            address: normalizeAddress(String(p.proxyWallet || '')),
            name: p.name || null,
            pseudonym: p.pseudonym || null,
            profileImage: p.profileImage || null,
          }))
          .filter((p) => p.address);
      } catch (err) {
        return res.status(502).json({ error: `Could not resolve username on Polymarket (${err.message}).` });
      }
      const q = parsed.value.toLowerCase();
      const exact = candidates.find((c) => (c.name || '').toLowerCase() === q)
        || candidates.find((c) => (c.pseudonym || '').toLowerCase() === q)
        || (candidates.length === 1 ? candidates[0] : null);
      if (!exact) {
        return res.status(404).json({
          error: candidates.length
            ? `No exact username match for “${parsed.value}”. Try the profile URL instead (https://polymarket.com/profile/…).`
            : `No Polymarket profile found for “${parsed.value}”.`,
          candidates,
        });
      }
      address = exact.address;
    }
    address = normalizeAddress(address);
    if (!address) return res.status(400).json({ error: 'Resolved address is invalid.' });
    if (walletExists(address)) return res.status(409).json({ error: 'This trader is already tracked.', address });

    // Validate that the address has Polymarket activity before tracking it.
    let probe = null;
    try {
      probe = await transportGet(qs(`${config.hosts.data}/activity`, { user: address, limit: 1 }));
    } catch (err) {
      return res.status(502).json({ error: `Could not reach Polymarket to verify the profile (${err.message}).` });
    }
    if (!Array.isArray(probe)) return res.status(502).json({ error: 'Unexpected response from Polymarket while verifying profile.' });

    let profile = null;
    try {
      const raw = await transportGet(qs(`${config.hosts.gamma}/public-profile`, { address }));
      if (raw && raw.proxyWallet) profile = {
        name: raw.name || null,
        pseudonym: raw.pseudonym || null,
        bio: raw.bio || null,
        profileImage: raw.profileImage || raw.profileImageOptimized || null,
        xUsername: raw.xUsername || null,
        verifiedBadge: !!raw.verifiedBadge,
        createdAt: raw.createdAt || null,
      };
    } catch { /* optional */ }

    insertWallet({
      id: address, address,
      username: profile?.name || null,
      pseudonym: profile?.pseudonym || null,
      bio: profile?.bio || null,
      profile_image: profile?.profileImage || null,
      x_username: profile?.xUsername || null,
      verified: profile?.verifiedBadge ? 1 : 0,
      polymarket_created_at: profile?.createdAt || null,
      added_at: nowSec(),
      poll_interval: parseInt(getSetting('poll_interval', config.defaultPollInterval), 10),
    });
    if (probe.length === 0) {
      updateWallet(address, { last_error: 'Profile has no public activity yet.', status: 'error' });
    } else if (config.isServerless) {
      // No background process survives the response — run the initial sync
      // inline within a bounded budget so the trader is usable immediately.
      try { await syncWalletNow(address, { budgetMs: config.serverlessInitialSyncBudgetMs }); } catch { /* surfaced via wallet status */ }
    } else {
      // kick off the initial historical sync without blocking the response
      syncWalletNow(address).catch(() => {});
    }
    res.status(201).json({ wallet: walletView(getWallet(address)), candidates: [] });
  } catch (err) {
    res.status(502).json({ error: `Polymarket request failed: ${err.message}` });
  }
});

api.delete('/wallets/:address', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  deleteWallet(id);
  res.json({ ok: true });
});

api.post('/wallets/:address/resync', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  syncWalletNow(id).catch(() => {});
  res.json({ ok: true });
});

// -------------------------------------------------------- wallet details ---
api.get('/wallets/:address', (req, res) => {
  const id = normalizeAddress(req.params.address);
  const w = id && getWallet(id);
  if (!w) return res.status(404).json({ error: 'Unknown wallet.' });
  const stats = computeDashboardStats(id);
  res.json({
    wallet: walletView(w),
    overview: {
      ...stats,
      api: safeJson(w.stats_json)?.api || null,
      predictionsUpdatedAt: w.predictions_updated_at ?? null,
      closedHistoryComplete: !!w.closed_history_complete,
      positionsScanComplete: !!w.positions_scan_complete,
    },
  });
});

api.get('/wallets/:address/summary/:period', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const period = PERIODS[req.params.period] ? req.params.period : '24h';
  const summary = windowSummary(id, period);
  const apiStats = safeJson(getWallet(id).stats_json)?.api || null;
  res.json({
    period,
    ...summary,
    apiPnl: apiStats?.pnl?.[PERIODS[period].lbWindow] ?? null,
    apiVolume: apiStats?.volume?.[PERIODS[period].lbWindow] ?? null,
  });
});

api.get('/wallets/:address/chart', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const period = PERIODS[req.params.period] ? req.params.period : 'all';
  const minTs = periodCutoff(period);
  res.json(pnlSeries(id, { minTs }));
});

/** Backend-paginated trades (spec: 10/page, prev/next, no huge client downloads). */
api.get('/wallets/:address/trades', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const page = clampInt(req.query.page, 1, 100000, 1);
  const pageSize = clampInt(req.query.pageSize, 1, 100, 10);
  const side = req.query.side === 'BUY' || req.query.side === 'SELL' ? req.query.side : null;
  const from = clampInt(req.query.from, 0, Number.MAX_SAFE_INTEGER, null);
  const to = clampInt(req.query.to, 0, Number.MAX_SAFE_INTEGER, null);
  const market = typeof req.query.market === 'string' && req.query.market ? req.query.market : null;

  const where = ['wallet = ?'];
  const params = [id];
  if (side) { where.push('side = ?'); params.push(side); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (market) { where.push('(title LIKE ? OR condition_id = ?)'); params.push(`%${market}%`, market); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) c FROM trades WHERE ${whereSql}`).get(...params).c;
  const rows = db.prepare(`SELECT ts, side, condition_id, title, slug, event_slug, icon, outcome, price, shares, value, tx_hash
    FROM trades WHERE ${whereSql} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  res.json({
    page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)),
    trades: rows,
  });
});

api.get('/wallets/:address/activity', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const limit = clampInt(req.query.limit, 1, 500, 80);
  const type = typeof req.query.type === 'string' && req.query.type ? req.query.type.toUpperCase() : null;
  const side = req.query.side === 'BUY' || req.query.side === 'SELL' ? req.query.side : null;
  const from = clampInt(req.query.from, 0, Number.MAX_SAFE_INTEGER, null);
  const to = clampInt(req.query.to, 0, Number.MAX_SAFE_INTEGER, null);

  const where = ['wallet = ?'];
  const params = [id];
  if (type) { where.push('type = ?'); params.push(type); }
  if (side) { where.push('side = ?'); params.push(side); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  const rows = db.prepare(`SELECT ts, type, side, condition_id, title, slug, event_slug, icon, outcome, price, shares, usdc, tx_hash
    FROM activity WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...params, limit);
  res.json({ activity: rows });
});

api.get('/wallets/:address/positions', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const kind = req.query.kind === 'closed' ? 'closed' : 'open';
  if (kind === 'closed') {
    const rows = db.prepare(`SELECT condition_id, avg_price, total_bought, realized_pnl, cur_price, ts, title, slug, event_slug, outcome, outcome_index
      FROM closed_positions WHERE wallet = ? ORDER BY ts DESC NULLS LAST LIMIT 200`).all(id);
    return res.json({ positions: rows });
  }
  const rows = db.prepare(`SELECT condition_id, size, avg_price, initial_value, current_value, cash_pnl, percent_pnl, cur_price, redeemable, title, slug, event_slug, outcome, end_date
    FROM positions WHERE wallet = ? ORDER BY current_value DESC NULLS LAST LIMIT 500`).all(id);
  res.json({ positions: rows, updatedAt: rows[0] ? db.prepare('SELECT updated_at FROM positions WHERE wallet = ? LIMIT 1').get(id)?.updated_at : null });
});

/**
 * The independently calculated win rate — one endpoint, one definition, used by
 * every screen. Also returns the "Polymarket reported" figures next to ours so a
 * discrepancy is visible instead of silent (spec 8), and the raw evidence behind
 * the difference (spec 9/23).
 */
api.get('/wallets/:address/win-rate', async (req, res) => {
  const id = normalizeAddress(req.params.address);
  const w = id && getWallet(id);
  if (!w) return res.status(404).json({ error: 'Unknown wallet.' });
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    if (force) {
      await resolveMarketsForWallet(id, { budget: config.resolutionLookupsPerCycle * 3 });
      rebuildPredictions(id);
    }
    const stats = await calculateTraderWinRate(id, { wallet: w });
    const apiStats = safeJson(w.stats_json)?.api || null;
    res.json({
      address: id,
      methodology: {
        definition: 'Percentage of the trader’s most recent completed predictions that resolved in their favour.',
        window: PRIMARY_PREDICTION_WINDOW,
        windows: PREDICTION_WINDOWS,
        excludes: ['open / unresolved positions', 'markets without a final resolution', 'hedged (both sides of one market)', 'positions with no readable direction'],
        groupsBy: ['wallet', 'market (condition id)', 'outcome token', 'position lifecycle'],
        neverUsed: ['trading profit or loss', 'Polymarket profile numbers', 'current mark-to-market prices'],
        tooltip: 'Win rate is independently calculated from the trader’s most recent completed predictions. Open and unresolved positions are excluded. Multiple transactions belonging to the same prediction are grouped to prevent double counting.',
      },
      // PRIMARY METRIC (independently calculated) vs what Polymarket itself publishes
      comparison: {
        independentlyCalculated: {
          winRate: stats.primary.winRate,
          wins: stats.primary.wins,
          losses: stats.primary.losses,
          analyzed: stats.primary.analyzed,
          label: stats.primary.label,
        },
        polymarketReported: {
          // Polymarket's public per-wallet APIs expose profit and volume windows only —
          // there is no public "win rate" endpoint to trust or distrust. Verified while
          // implementing this: profiles show P&L/volume/markets-traded, not a hit rate.
          winRate: null,
          unavailableReason: 'Polymarket’s public API does not expose a per-wallet win rate.',
          pnl: apiStats?.pnl ?? null,
          volume: apiStats?.volume ?? null,
          marketsTraded: apiStats?.marketsTraded ?? null,
          portfolioValue: apiStats?.value ?? null,
        },
        // What the trader’s closed positions would say if "win" meant "made money".
        // Displayed for contrast only — it is explicitly NOT the win rate.
        profitabilityCrossCheck: {
          label: 'Closed positions with positive realized P&L',
          rate: stats.profitability.rate,
          wins: stats.profitability.wins,
          losses: stats.profitability.losses,
          flat: stats.profitability.flat,
          closed: stats.profitability.closed,
          note: 'Profitability of closed positions — not prediction accuracy. Not used anywhere as a win rate.',
        },
      },
      stats,
    });
  } catch (err) {
    res.status(500).json({ error: `Win-rate calculation failed: ${err.message}` });
  }
});

/**
 * Auditable prediction ledger: the exact rows behind the win rate, newest first.
 * Filters: result=WIN|LOSS|UNDETERMINED, status=COMPLETED|OPEN, market=<text>,
 * window=<N> (the “last N classified predictions” sample the headline number uses).
 * The window is applied BEFORE the result filter, so “wins in the last 10” really
 * means wins among that sample rather than the 10 newest wins of all time.
 */
api.get('/wallets/:address/predictions', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const RESULT = String(req.query.result || '').toUpperCase();
  const result = ['WIN', 'LOSS', 'UNDETERMINED'].includes(RESULT) ? RESULT : null;
  const STATUS = String(req.query.status || '').toUpperCase();
  const status = STATUS === 'OPEN' || STATUS === 'COMPLETED' ? STATUS : null;
  const windowSize = clampInt(req.query.window, 1, 1000, PRIMARY_PREDICTION_WINDOW);
  const page = clampInt(req.query.page, 1, 100000, 1);
  const pageSize = clampInt(req.query.pageSize, 1, 100, 25);
  const market = typeof req.query.market === 'string' && req.query.market.trim() ? req.query.market.trim().slice(0, 120) : null;

  const { rows } = listPredictions(id, { limit: 100000, offset: 0 });
  const all = rows.map((r) => ({
    ...r,
    source_transactions: safeJson(r.source_transactions) || [],
    reasonLabel: r.reason ? REASON_LABELS[r.reason] || r.reason : null,
    marketUrl: r.market_slug ? `https://polymarket.com/event/${r.event_slug || r.market_slug}` : null,
  }));
  const classified = all.filter((r) => r.result === 'WIN' || r.result === 'LOSS');
  const inWindow = new Set(classified.slice(0, windowSize).map((r) => r.condition_id));

  // “Excluded / undetermined” is about rows that never entered the denominator, so it
  // is deliberately not window-scoped; everything else is scoped first, then filtered.
  const wantsExcluded = result === 'UNDETERMINED' || status === 'OPEN';
  let scoped = wantsExcluded
    ? all.filter((r) => r.result === 'UNDETERMINED')
    : classified.filter((r) => inWindow.has(r.condition_id));
  if (status) scoped = scoped.filter((r) => r.status === status);
  if (result && result !== 'UNDETERMINED') scoped = scoped.filter((r) => r.result === result);
  if (market) {
    const needle = market.toLowerCase();
    scoped = scoped.filter((r) => (r.market_name || '').toLowerCase().includes(needle) || (r.condition_id || '') === market);
  }
  scoped = scoped.map((r) => ({ ...r, in_window: inWindow.has(r.condition_id) }));

  const totals = predictionTotals(id);
  res.json({
    page, pageSize,
    total: scoped.length,
    pages: Math.max(1, Math.ceil(scoped.length / pageSize)),
    window: windowSize,
    windowAnalyzed: Math.min(windowSize, classified.length),
    totals: {
      completed: totals?.completed || 0, wins: totals?.wins || 0, losses: totals?.losses || 0,
      undetermined: totals?.undetermined || 0,
    },
    predictions: scoped.slice((page - 1) * pageSize, page * pageSize),
  });
});

/** Single prediction: everything needed to verify one row against public data. */
api.get('/wallets/:address/predictions/:conditionId', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const cid = String(req.params.conditionId || '');
  const row = db.prepare(`SELECT * FROM predictions WHERE wallet = ? AND (condition_id = ? OR market_slug = ?)`).get(id, cid, cid);
  if (!row) return res.status(404).json({ error: 'Unknown prediction for this wallet.' });
  // `resolutionView` parses the cached outcome list so the audit table can show the
  // per-outcome prices/winners exactly as Polymarket published them.
  const resolution = row.condition_id ? resolutionView(row.condition_id) : null;
  const trades = db.prepare(`SELECT ts, side, outcome, outcome_index, price, shares, value, tx_hash FROM trades
    WHERE wallet = ? AND (condition_id = ? OR slug = ?) ORDER BY ts DESC LIMIT 200`).all(id, row.condition_id, row.market_slug || '');
  const positions = db.prepare(`SELECT 'open' AS kind, asset, size, avg_price, initial_value, current_value, cash_pnl, realized_pnl, cur_price, redeemable, outcome, outcome_index FROM positions WHERE wallet = ? AND (condition_id = ? OR slug = ?)
    UNION ALL
    SELECT 'closed' AS kind, asset, NULL AS size, avg_price, total_bought AS initial_value, NULL AS current_value, realized_pnl, realized_pnl, cur_price, NULL AS redeemable, outcome, outcome_index FROM closed_positions WHERE wallet = ? AND (condition_id = ? OR slug = ?)`)
    .all(id, row.condition_id, row.market_slug || '', id, row.condition_id, row.market_slug || '');
  res.json({
    prediction: {
      ...row,
      source_transactions: safeJson(row.source_transactions) || [],
      reasonLabel: row.reason ? REASON_LABELS[row.reason] || row.reason : null,
      marketUrl: row.market_slug ? `https://polymarket.com/event/${row.event_slug || row.market_slug}` : null,
    },
    resolution: resolution ? { ...resolution, outcomes: safeJson(resolution.outcomes_json) } : null,
    positions,
    transactions: trades,
    groupingNote: `${trades.length} fill(s) and ${positions.length} position record(s) were grouped into this single prediction; repeated buys/sells in the same market never count twice.`,
  });
});

/** Rebuild the classification now (debug / "re-verify" action). */
api.post('/wallets/:address/predictions/rebuild', async (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  try {
    const lookups = await resolveMarketsForWallet(id, { budget: config.resolutionLookupsPerCycle * 3 });
    const built = rebuildPredictions(id);
    const stats = computePredictionStats(id);
    const fresh = computeDashboardStats(id, safeJson(getWallet(id).stats_json)?.api || null);
    updateWallet(id, { stats_json: JSON.stringify(fresh) });
    broadcast('wallet:update', { walletId: id, status: getWallet(id).status, stats: fresh });
    res.json({ ...built, lookups, primary: stats.primary, totals: stats.totals, exclusions: stats.exclusions });
  } catch (err) {
    res.status(500).json({ error: `Rebuild failed: ${err.message}` });
  }
});

/** Accuracy-over-time series (predictions only; money is a separate chart). */
api.get('/wallets/:address/accuracy', (req, res) => {
  const id = normalizeAddress(req.params.address);
  if (!id || !walletExists(id)) return res.status(404).json({ error: 'Unknown wallet.' });
  const window = clampInt(req.query.window, 5, 200, 20);
  const period = PERIODS[req.query.period] ? req.query.period : 'all';
  res.json(winRateSeries(id, { window, minTs: periodCutoff(period) }));
});

// ----------------------------------------------------------------- feeds ---
api.get('/feed/global', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 60);
  const rows = globalFeed(limit);
  res.json({
    feed: rows.map((r) => ({
      ts: r.ts, type: r.type, side: r.side, title: r.title, slug: r.slug, outcome: r.outcome,
      price: r.price, shares: r.shares, value: r.usdc ?? (r.price != null && r.shares != null ? r.price * r.shares : null),
      txHash: r.tx_hash, wallet: r.wallet,
      username: r.username || r.pseudonym, profileImage: r.profile_image,
    })),
  });
});

// ---------------------------------------------------------------- search ---
api.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ traders: [], markets: [] });
  const like = `%${q}%`;
  const traders = db.prepare(`SELECT id, username, pseudonym, profile_image, status FROM wallets
    WHERE id LIKE ? OR COALESCE(username,'') LIKE ? OR COALESCE(pseudonym,'') LIKE ? LIMIT 8`).all(like, like, like);
  const markets = db.prepare(`SELECT DISTINCT title, slug, icon FROM trades
    WHERE title IS NOT NULL AND title LIKE ? ORDER BY ts DESC LIMIT 8`).all(like);
  res.json({ traders, markets });
});

// --------------------------------------------------------------- compare ---
api.get('/compare', (req, res) => {
  const rows = listWallets().map((w) => {
    const live = computePredictionStats(w.id, { periods: { '24h': nowSec() - 86400, '7d': nowSec() - 7 * 86400 } });
    const cached = safeJson(w.stats_json) || {};
    const api = cached.api || {};
    const primary = live.primary;
    const profit = profitabilityFromClosedPositions(w.id);
    return {
      address: w.id,
      username: w.username || w.pseudonym,
      profileImage: w.profile_image,
      status: w.status,
      lastActivityTs: cached.lastActivityTs ?? null,
      // Prediction win rate (independently calculated) — with its sample size.
      winRate: primary.winRate,
      winRateWins: primary.wins,
      winRateLosses: primary.losses,
      winRateAnalyzed: primary.analyzed,
      winRateLabel: primary.label,
      winRate24h: live.periods['24h']?.winRate ?? null,
      winRate24hN: live.periods['24h']?.analyzed ?? 0,
      winRate7d: live.periods['7d']?.winRate ?? null,
      winRate7dN: live.periods['7d']?.analyzed ?? 0,
      winRateAll: live.windows.all.winRate,
      winRateAllN: live.windows.all.analyzed,
      openExcluded: live.exclusions.openPositions,
      pendingResolutions: live.exclusions.pendingResolutions,
      // Trading money — deliberately separate from accuracy.
      profitabilityRate: profit.rate,
      profitabilityN: profit.wins + profit.losses,
      trades24h: cached.trades24h ?? null,
      trades7d: cached.trades7d ?? null,
      volume24h: api.volume?.['1d'] ?? cached.volume24h ?? null,
      volume7d: api.volume?.['7d'] ?? cached.volume7d ?? null,
      volumeAll: api.volume?.all ?? null,
      pnl24h: api.pnl?.['1d'] ?? null,
      pnl7d: api.pnl?.['7d'] ?? null,
      pnlAll: api.pnl?.all ?? null,
      predictionPnl: live.totals.totalPnl,
      activePositions: cached.activePositions ?? null,
      openValue: cached.openValue ?? null,
    };
  });
  res.json({ rows, basis: 'prediction' });
});

// ----------------------------------------------------- suggestions / misc ---
api.get('/suggestions', async (req, res) => {
  try {
    const rows = await transportGet(qs(`${config.hosts.data}/v1/leaderboard`, { period: '1d', limit: 8 }));
    const traders = (Array.isArray(rows) ? rows : []).map((r) => ({
      address: normalizeAddress(String(r.proxyWallet || '')),
      username: r.userName || null,
      vol: Number(r.vol) || 0,
      pnl: Number(r.pnl) || 0,
      profileImage: r.profileImage || null,
    })).filter((t) => t.address);
    const tracked = new Set(listWallets().map((w) => w.id));
    res.json({ suggestions: traders.filter((t) => !tracked.has(t.address)) });
  } catch (err) {
    res.json({ suggestions: [], error: err.message });
  }
});

// ------------------------------------------------------------- alerting ---
api.get('/alerts/rules', (req, res) => res.json({ rules: listRules() }));
api.post('/alerts/rules', (req, res) => {
  try {
    const rule = addRule({
      kind: String(req.body?.kind || ''),
      wallet: req.body?.wallet ? normalizeAddress(req.body.wallet) : null,
      params: req.body?.params || {},
    });
    res.status(201).json({ rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
api.patch('/alerts/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  // Only touch what the caller actually sent, so editing a threshold never silently
  // disables the rule (and toggling never wipes its parameters).
  if ('enabled' in body) setRuleEnabled(id, !!body.enabled);
  const rule = 'params' in body ? updateRuleParams(id, body.params || {}) : null;
  res.json({ ok: true, rule: rule || undefined });
});
api.delete('/alerts/rules/:id', (req, res) => {
  deleteRule(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

api.get('/notifications', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const rows = db.prepare('SELECT * FROM notifications ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
  res.json({ notifications: rows.map((n) => ({ ...n, meta: safeJson(n.meta) })), unread: unreadNotificationCount() });
});
api.post('/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  res.json({ ok: true });
});

// ------------------------------------------------- browser bridge transport ---
api.get('/bridge/next', (req, res) => {
  noteBridgeClientSeen();
  res.json({ jobs: claimJobs(6), bridge: bridgeInUse() });
});
api.post('/bridge/result', (req, res) => {
  const { id, ok, data, error } = req.body || {};
  const found = resolveJob(String(id || ''), { ok: !!ok, data, error });
  res.json({ ok: found });
});

// ------------------------------------------------------------------- SSE ---
// Serverless functions cannot hold streams open between requests — the client
// detects this via GET /api/system (deployment=serverless) and polls instead.
api.get('/events', (req, res, next) => {
  if (config.isServerless) return res.status(501).json({ error: 'SSE is not available in serverless mode; data refreshes via POST /api/sync.' });
  return sseHandler(req, res, next);
});
