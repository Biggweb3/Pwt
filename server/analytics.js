/**
 * analytics.js — derives performance metrics from locally stored, verified data.
 *
 * Data honesty rules enforced here:
 *  - API-provided metrics (lb-api profit/volume, positions cashPnl) are labelled 'api'.
 *  - Metrics computed from stored rows are labelled 'calculated'.
 *  - Win rate is only derived from CLOSED positions (realizedPnl); open positions
 *    are never treated as wins or losses. If nothing closed in a window: N/A.
 *  - Missing data => null, rendered as "N/A" / "Unavailable" by the UI.
 */
import { db } from './db.js';
import { nowSec } from './util.js';

export const PERIODS = {
  '24h': { label: 'Last 24 hours', seconds: 24 * 3600, lbWindow: '1d' },
  '72h': { label: 'Last 72 hours', seconds: 72 * 3600, lbWindow: null },
  '7d': { label: 'Last 7 days', seconds: 7 * 24 * 3600, lbWindow: '7d' },
  '30d': { label: 'Last 30 days', seconds: 30 * 24 * 3600, lbWindow: '30d' },
  all: { label: 'All time', seconds: null, lbWindow: 'all' },
};

export const periodCutoff = (period, now = nowSec()) =>
  PERIODS[period]?.seconds ? now - PERIODS[period].seconds : null;

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
 * Win/loss stats from positions CLOSED inside the window (calculated).
 * A closed position is a win when realizedPnl > 0, a loss when < 0.
 */
export function winStatsForWindow(walletId, period) {
  const cutoff = periodCutoff(period);
  const rows = db.prepare(`
    SELECT SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) losses,
           SUM(CASE WHEN realized_pnl = 0 THEN 1 ELSE 0 END) flat,
           SUM(realized_pnl) realized_pnl,
           COUNT(*) closed
    FROM closed_positions WHERE wallet = ? AND ts IS NOT NULL ${cutoff ? 'AND ts >= ?' : ''}`)
    .get(...(cutoff ? [walletId, cutoff] : [walletId]));
  const wins = rows.wins || 0;
  const losses = rows.losses || 0;
  const decided = wins + losses;
  return {
    closedInWindow: rows.closed || 0,
    wins,
    losses,
    flat: rows.flat || 0,
    winRate: decided > 0 ? wins / decided : null,   // null => N/A (nothing decided in window)
    realizedPnl: rows.realized_pnl ?? null,
  };
}

/** Position counts (API-provided snapshots). */
export function positionCounts(walletId) {
  const active = db.prepare('SELECT COUNT(*) c, SUM(current_value) v, SUM(cash_pnl) p FROM positions WHERE wallet = ?').get(walletId);
  const closed = db.prepare('SELECT COUNT(*) c FROM closed_positions WHERE wallet = ?').get(walletId);
  return {
    activePositions: active.c || 0,
    openValue: active.v ?? null,
    openUnrealizedPnl: active.p ?? null,
    closedPositions: closed.c || 0,
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
  return {
    period,
    trades: tradeStatsForWindow(walletId, period),
    win: winStatsForWindow(walletId, period),
    positions: positionCounts(walletId),
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
  const w24 = winStatsForWindow(walletId, '24h');
  const t7d = tradeStatsForWindow(walletId, '7d');
  const wAll = winStatsForWindow(walletId, 'all');
  return {
    computedAt: now,
    lastActivityTs: Math.max(lastTrade?.ts || 0, lastActivity?.ts || 0) || null,
    lastTrade: lastTrade ? { ts: lastTrade.ts, title: lastTrade.title, side: lastTrade.side, outcome: lastTrade.outcome, value: lastTrade.value } : null,
    firstObservedTs: firstTrade?.ts || null,
    trades24h: t24.trades,
    volume24h: t24.volume,
    winRate24h: w24.winRate,
    trades7d: t7d.trades,
    volume7d: t7d.volume,
    winRateAll: wAll.winRate,
    closedAll: wAll.closedInWindow,
    activePositions: counts.activePositions,
    openValue: counts.openValue,
    openUnrealizedPnl: counts.openUnrealizedPnl,
    closedPositions: counts.closedPositions,
    api: apiStats || null, // {pnl:{'1d','7d','30d','all'}, volume:{...}, value, marketsTraded}
  };
}
