/**
 * analytics.js — derives performance metrics from locally stored, verified data.
 *
 * Data honesty rules enforced here:
 *  - API-provided metrics (lb-api profit/volume, positions cashPnl) are labelled 'api'.
 *  - Metrics computed from stored rows are labelled 'calculated'.
 *  - WIN RATE never comes from P&L and never from a profile number: every win-rate
 *    figure in the app is delegated to predictions.js (grouped positions classified
 *    against authoritative market resolutions). Open/unresolved positions are excluded.
 *  - TRADING P&L is a separate metric and is never blended into the win rate.
 *  - Missing data => null, rendered as "N/A" / "Unavailable" by the UI.
 */
import { db } from './db.js';
import { nowSec } from './util.js';
import { computePredictionStats, profitabilityFromClosedPositions } from './predictions.js';

export const PERIODS = {
  '24h': { label: 'Last 24 hours', seconds: 24 * 3600, lbWindow: '1d' },
  '72h': { label: 'Last 72 hours', seconds: 72 * 3600, lbWindow: null },
  '7d': { label: 'Last 7 days', seconds: 7 * 24 * 3600, lbWindow: '7d' },
  '30d': { label: 'Last 30 days', seconds: 30 * 24 * 3600, lbWindow: '30d' },
  all: { label: 'All time', seconds: null, lbWindow: 'all' },
};

export const periodCutoff = (period, now = nowSec()) =>
  PERIODS[period]?.seconds ? now - PERIODS[period].seconds : null;

/** Period cutoffs for every time window at once (used by the prediction stats). */
export const periodCutoffs = (now = nowSec()) =>
  Object.fromEntries(Object.entries(PERIODS)
    .filter(([, p]) => p.seconds)
    .map(([k, p]) => [k, now - p.seconds]));

/** Trade-derived stats for one window (calculated). */
export function tradeStatsForWindow(walletId, period) {
  const cutoff = periodCutoff(period);
  const rows = db.prepare(`
    SELECT COUNT(*) trades,
           SUM(CASE WHEN side='BUY' THEN 1 ELSE 0 END) buys,
           SUM(CASE WHEN side='SELL' THEN 1 ELSE 0 END) sells,
           SUM(value) volume,
           AVG(value) avg_value,
           MAX(value) max_value,
           COUNT(DISTINCT condition_id) markets
    FROM trades WHERE wallet = ? ${cutoff ? 'AND ts >= ?' : ''}`).get(...(cutoff ? [walletId, cutoff] : [walletId]));
  return {
    trades: rows.trades || 0,
    buys: rows.buys || 0,
    sells: rows.sells || 0,
    volume: rows.volume ?? null,
    avgTradeSize: rows.avg_value ?? null,
    largestTrade: rows.max_value ?? null,
    markets: rows.markets || 0,
  };
}

/**
 * Win/loss stats for one window, straight from the prediction engine (predictions.js).
 * `winRate` is wins / (wins + losses) over *classified* predictions only; excluded
 * records are counted separately and never enter the denominator.
 */
export function winStatsForWindow(walletId, period, predictions = null) {
  const key = period === 'all' ? 'all' : period;
  const stats = predictions || computePredictionStats(walletId, { periods: { [key]: periodCutoff(period) } });
  const p = stats.periods[key] || { analyzed: 0, wins: 0, losses: 0, excluded: 0, scanned: 0, winRate: null };
  const primary = stats.primary;
  return {
    basis: 'prediction',   // vs 'profitability': how this number was derived, always stated
    analyzed: p.analyzed,
    wins: p.wins,
    losses: p.losses,
    excluded: p.excluded,
    completedInWindow: p.scanned,
    winRate: p.winRate,
    sampleSize: p.analyzed,
    window: primary.window,
    windowAnalyzed: primary.analyzed,
    windowWinRate: primary.winRate,
    windowLimited: primary.limited,
    windowLabel: primary.label,
    openExcluded: stats.exclusions.openPositions,
    undeterminedAll: stats.totals.undetermined,
    basisLabel: p.analyzed
      ? `${p.wins}W / ${p.losses}L of ${p.analyzed} completed predictions${p.excluded ? ` · ${p.excluded} excluded` : ''}`
      : 'No completed, resolved predictions in this window',
  };
}

/**
 * PROFITABILITY (not a win rate): share of closed positions whose realized P&L was
 * positive. Kept only so the UI can show, side by side, what Polymarket's own
 * position data would imply — and why it is not the same thing as being right.
 */
export function profitabilityForWindow(walletId, period) {
  const cutoff = periodCutoff(period);
  const row = profitabilityFromClosedPositions(walletId, cutoff);
  return { ...row, period };
}

/** Position counts (API-provided snapshots). */
export function positionCounts(walletId) {
  const active = db.prepare('SELECT COUNT(*) c, SUM(current_value) v, SUM(cash_pnl) p FROM positions WHERE wallet = ?').get(walletId);
  const closed = db.prepare('SELECT COUNT(*) c FROM closed_positions WHERE wallet = ?').get(walletId);
  const redeemable = db.prepare('SELECT COUNT(*) c FROM positions WHERE wallet = ? AND redeemable = 1').get(walletId);
  return {
    activePositions: active.c || 0,
    openValue: active.v ?? null,
    openUnrealizedPnl: active.p ?? null,
    closedPositions: closed.c || 0,
    redeemablePositions: redeemable.c || 0,
  };
}

/** Cumulative realized P&L series from closed positions (for the chart). */
export function pnlSeries(walletId, { minTs = null, maxPoints = 400 } = {}) {
  const rows = db.prepare(`
    SELECT ts, realized_pnl FROM closed_positions
    WHERE wallet = ? AND ts IS NOT NULL AND realized_pnl IS NOT NULL ${minTs ? 'AND ts >= ?' : ''}
    ORDER BY ts ASC`).all(...(minTs ? [walletId, minTs] : [walletId]));
  // If there are no closed positions, fall back to cumulative trade volume so the
  // chart still conveys activity — clearly labelled by the UI.
  if (!rows.length) {
    const trades = db.prepare(`
      SELECT ts, value FROM trades WHERE wallet = ? AND value IS NOT NULL ${minTs ? 'AND ts >= ?' : ''}
      ORDER BY ts ASC`).all(...(minTs ? [walletId, minTs] : [walletId]));
    let cum = 0;
    const pts = trades.map((t) => { cum += t.value; return { ts: t.ts, v: cum }; });
    return { kind: 'volume', points: downsample(pts, maxPoints) };
  }
  let cum = 0;
  const pts = rows.map((r) => { cum += r.realized_pnl; return { ts: r.ts, v: cum }; });
  return { kind: 'pnl', points: downsample(pts, maxPoints) };
}

/**
 * Win/loss sequence for the accuracy chart: newest-first completed predictions turned
 * into a chronological +1 / -1 series (independent of P&L by construction).
 */
export function winRateSeries(walletId, { window = 20, minTs = null } = {}) {
  const rows = db.prepare(`
    SELECT completed_at, result, total_pnl FROM predictions
    WHERE wallet = ? AND status = 'COMPLETED' AND result IN ('WIN','LOSS') AND completed_at IS NOT NULL
      ${minTs ? 'AND completed_at >= ?' : ''}
    ORDER BY completed_at ASC`).all(...(minTs ? [walletId, minTs] : [walletId]));
  if (rows.length < 2) return { kind: 'accuracy', window, points: [] };
  const out = [];
  let wins = 0; let pnl = 0;
  for (let i = 0; i < rows.length; i++) {
    wins += rows[i].result === 'WIN' ? 1 : 0;
    pnl += rows[i].total_pnl || 0;
    if (i >= window) { wins -= rows[i - window].result === 'WIN' ? 1 : 0; pnl -= rows[i - window].total_pnl || 0; }
    const n = Math.min(i + 1, window);
    out.push({ ts: rows[i].completed_at, accuracy: wins / n, pnl, sample: n });
  }
  return { kind: 'accuracy', window, points: out };
}

function downsample(pts, maxPoints) {
  if (pts.length <= maxPoints) return pts;
  const step = Math.ceil(pts.length / maxPoints);
  const out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

/** Full window summary used by the trader detail page. */
export function windowSummary(walletId, period) {
  const cutoff = periodCutoff(period);
  const key = period === 'all' ? 'all' : period;
  const predictions = computePredictionStats(walletId, { periods: { [key]: cutoff } });
  return {
    period,
    periodLabel: PERIODS[period]?.label || period,
    trades: tradeStatsForWindow(walletId, period),
    win: winStatsForWindow(walletId, period, predictions),
    predictions,
    profitability: profitabilityForWindow(walletId, period),
    positions: positionCounts(walletId),
    pnl: {
      realized: db.prepare('SELECT SUM(realized_pnl) v FROM closed_positions WHERE wallet = ?' + (cutoff ? ' AND ts >= ?' : ''))
        .get(...(cutoff ? [walletId, cutoff] : [walletId]))?.v ?? null,
      fromPredictions: db.prepare(`SELECT SUM(total_pnl) v FROM predictions WHERE wallet = ? AND status = 'COMPLETED'` + (cutoff ? ' AND completed_at >= ?' : ''))
        .get(...(cutoff ? [walletId, cutoff] : [walletId]))?.v ?? null,
    },
  };
}

/** Dashboard-level cached stats for one wallet (stored in wallets.stats_json). */
export function computeDashboardStats(walletId, apiStats = null) {
  const now = nowSec();
  const lastTrade = db.prepare('SELECT ts, title, side, outcome, value FROM trades WHERE wallet = ? ORDER BY ts DESC LIMIT 1').get(walletId);
  const lastActivity = db.prepare('SELECT ts FROM activity WHERE wallet = ? ORDER BY ts DESC LIMIT 1').get(walletId);
  const firstTrade = db.prepare('SELECT ts FROM trades WHERE wallet = ? ORDER BY ts ASC LIMIT 1').get(walletId);
  const counts = positionCounts(walletId);
  const t24 = tradeStatsForWindow(walletId, '24h');
  const t7d = tradeStatsForWindow(walletId, '7d');
  const predictions = computePredictionStats(walletId, { now, periods: periodCutoffs(now) });
  const walletRow = db.prepare('SELECT closed_history_complete, positions_scan_complete FROM wallets WHERE id = ?').get(walletId);
  predictions.coverage.closedHistoryComplete = !!walletRow?.closed_history_complete;
  predictions.coverage.positionsScanComplete = walletRow?.positions_scan_complete !== 0;
  return {
    computedAt: now,
    lastActivityTs: Math.max(lastTrade?.ts || 0, lastActivity?.ts || 0) || null,
    lastTrade: lastTrade ? { ts: lastTrade.ts, title: lastTrade.title, side: lastTrade.side, outcome: lastTrade.outcome, value: lastTrade.value } : null,
    firstObservedTs: firstTrade?.ts || null,
    trades24h: t24.trades,
    volume24h: t24.volume,
    trades7d: t7d.trades,
    volume7d: t7d.volume,
    activePositions: counts.activePositions,
    openValue: counts.openValue,
    openUnrealizedPnl: counts.openUnrealizedPnl,
    closedPositions: counts.closedPositions,
    redeemablePositions: counts.redeemablePositions,
    // Everything about win rate lives in this block — one engine, one definition.
    predictions,
    // Legacy convenience fields (same values as the engine, no second calculation).
    winRateAll: predictions.totals.winRate,
    winRate24h: predictions.periods['24h']?.winRate ?? null,
    closedAll: predictions.totals.completed,
    api: apiStats || null, // {pnl:{'1d','7d','30d','all'}, volume:{...}, value, marketsTraded}
  };
}
