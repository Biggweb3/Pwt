/**
 * predictions.js — THE win-rate engine. One calculation, one source of truth,
 * used by every screen (trader cards, trader detail, compare table, analytics).
 *
 * What the metric means (and what it does NOT mean)
 * ------------------------------------------------
 *   Prediction Win Rate = WINs / (WINs + LOSSes) over the trader's most recent
 *   *completed* predictions, where a "prediction" is one position lifecycle in
 *   one market, and WIN/LOSS is decided ONLY by the market's final resolution.
 *
 *   It is NOT: profitable-transaction ratio, profitable-sell ratio, currently
 *   green positions, or any profile-level number Polymarket may display.
 *
 * Pipeline (steps 1-11 of the spec, all server-side — never in React):
 *   1  retrieve trader activity          (stored trades + activity rows)
 *   2  retrieve position records         (/positions incl. redeemable, /closed-positions)
 *   3  retrieve market information       (CLOB /markets/{conditionId}, Gamma fallback)
 *   4  GROUP transactions per market     (wallet × market × outcome token → ONE prediction)
 *   5  determine whether the market resolved
 *   6  determine the final outcome       (tokens[].winner — the source of truth)
 *   7  classify WIN / LOSS by the side the trader accumulated (never by P&L)
 *   8  EXCLUDE unresolved / ambiguous    (UNDETERMINED, with a reason)
 *   9  sort completed predictions by completion/resolution time
 *   10 select the most recent N qualifying predictions (N = 10/25/50/100/250/all)
 *   11 win rate = wins / (wins + losses) × 100
 *
 * Hard rules enforced here:
 *   • Trading P&L is computed but NEVER used to decide WIN/LOSS (spec 3/13/17).
 *   • An unresolved market is never a win or a loss, even if the trader profited.
 *   • Multiple buys/sells in one market are one prediction (no double counting).
 *   • Partial exits do not create extra wins/losses (spec 17).
 *   • Anything ambiguous is UNDETERMINED with an explicit reason — never guessed.
 *   • Sample size always travels with the rate; small samples are never hidden.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import {
  db, getResolution, noteResolutionAttempt, pendingResolutionIds, predictionTotals,
  openPredictionCount, pendingResolutionCount, recentCompletedPredictions,
  replacePredictions, upsertMarketResolution,
} from './db.js';
import {
  marketResolutionFallbackUrl, marketResolutionUrl, normalizeClobMarket, normalizeGammaMarket,
} from './polymarketService.js';
import { transportGet } from './transport.js';
import { mapPool, nowSec } from './util.js';

export const PREDICTION_WINDOWS = [10, 25, 50, 100, 250];
/** The headline number: win rate over the most recent 100 completed predictions. */
export const PRIMARY_PREDICTION_WINDOW = 100;
/** How many completed predictions one scan looks at (windows are subsets of this). */
const SCAN_LIMIT = Math.max(...PREDICTION_WINDOWS) * 4;

/** Human-readable explanations for every non-WIN/LOSS record (audit view). */
export const REASON_LABELS = {
  market_open: 'Market has not resolved yet — position still open',
  awaiting_market_resolution: 'Position closed, market has not resolved yet',
  hedged_both_outcomes: 'Hedged: exposure on more than one outcome of the same market',
  resolution_pending: 'Market outcome not looked up yet (queued)',
  resolution_unavailable: 'Market outcome could not be verified from Polymarket',
  flat_resolution: 'Market resolved flat / 50-50 — no single winning outcome',
  voided: 'Market was voided or refunded',
  no_direction: 'No directional exposure detected on this market',
};

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** Outcome labels are compared case-insensitively ("Yes" === "YES"). */
const normOutcome = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : null) || null;

/**
 * Markets are identified by their condition id (Polymarket's market identifier).
 * Rows without one fall back to slug/title so they still group correctly instead
 * of being counted as separate predictions.
 */
const marketKeyOf = (r) => {
  if (r.condition_id) return r.condition_id;
  if (r.slug) return `slug:${r.slug}`;
  if (r.title) return `title:${String(r.title).trim().toLowerCase()}`;
  return `asset:${r.asset}`;
};

const EMPTY_TOKEN = () => ({
  asset: null, outcome: null, outcomeIndex: null,
  sharesHeld: 0, sharesBought: 0, sharesSold: 0,
  cost: 0, tradeCost: 0, tradeProceeds: 0, realized: 0, unrealized: 0,
  curPrice: null, avgPrice: null, redeemable: false, isOpen: false, isClosed: false,
  closedAt: null, firstTs: null, lastTs: null, fills: 0,
});

/** Cost basis for a token: position snapshots first, raw fills as the fallback. */
const tokenCost = (t) => (t.cost && t.cost > 0 ? t.cost : t.tradeCost || 0);
const tokenProceeds = (t) => (t.tradeProceeds || 0);

const EMPTY_MARKET = (key) => ({
  key, conditionId: null, title: null, slug: null, eventSlug: null, endDates: [],
  tokens: new Map(), redeemUsdc: 0, redeemTs: null,
  tradesSeen: 0, firstTs: null, lastTs: null, txs: [],
});

const bump = (o, field, v) => { const n = num(v); if (n !== null) o[field] = (o[field] || 0) + n; };
const maxTs = (cur, next) => (next == null ? cur : Math.max(cur ?? 0, Math.round(next)));

/**
 * 4) GROUP — collapse every transaction of a wallet into one record per market,
 *    with one sub-record per outcome token (so 5 buys + 3 sells of the same token
 *    are one position, and YES/NO exposure in the same market is visible as a hedge).
 */
export function collectMarketPositions({ closedRows = [], openRows = [], tradeRows = [], redeemRows = [] } = {}) {
  const markets = new Map();
  const marketFor = (r) => {
    const key = marketKeyOf(r);
    let m = markets.get(key);
    if (!m) { m = EMPTY_MARKET(key); markets.set(key, m); }
    if (r.condition_id) m.conditionId = r.condition_id;
    if (r.title && !m.title) m.title = r.title;
    if (r.slug && !m.slug) m.slug = r.slug;
    if (r.event_slug && !m.eventSlug) m.eventSlug = r.event_slug;
    if (r.end_date) m.endDates.push(r.end_date);
    return m;
  };
  const tokenFor = (m, r) => {
    const tk = r.asset || `idx:${r.outcome_index ?? normOutcome(r.outcome)}`;
    let t = m.tokens.get(tk);
    if (!t) { t = EMPTY_TOKEN(); t.asset = r.asset || null; m.tokens.set(tk, t); }
    if (r.outcome && !t.outcome) t.outcome = r.outcome;
    if (r.outcome_index != null && t.outcomeIndex == null) t.outcomeIndex = r.outcome_index;
    return t;
  };

  // 2a) positions still held (size > 0) — includes resolved-but-not-redeemed ones
  for (const r of openRows) {
    const m = marketFor(r);
    const t = tokenFor(m, r);
    t.isOpen = true;
    bump(t, 'sharesHeld', r.size);
    bump(t, 'cost', r.initial_value);
    bump(t, 'realized', r.realized_pnl);   // partial exits already booked on this token
    bump(t, 'unrealized', r.cash_pnl);
    const cp = num(r.cur_price);
    if (cp !== null) t.curPrice = cp;
    if (r.redeemable) t.redeemable = true;
    if (num(r.avg_price) !== null) t.avgPrice = num(r.avg_price);
    if (!t.outcome && r.outcome) t.outcome = r.outcome;
  }

  // 2b) positions the wallet fully exited (sold out or redeemed)
  for (const r of closedRows) {
    const m = marketFor(r);
    const t = tokenFor(m, r);
    t.isClosed = true;
    bump(t, 'cost', r.total_bought);
    bump(t, 'realized', r.realized_pnl);
    const cp = num(r.cur_price);
    if (cp !== null && !(t.isOpen && t.curPrice !== null)) t.curPrice = cp;
    t.closedAt = maxTs(t.closedAt, r.ts);
    if (!t.outcome && r.outcome) t.outcome = r.outcome;
  }

  // 1) transaction evidence (fills) — direction, timing, grouping audit trail
  for (const r of tradeRows) {
    const m = marketFor(r);
    const t = tokenFor(m, r);
    const shares = num(r.shares) ?? 0;
    const value = num(r.value) ?? 0;
    t.fills += 1; m.tradesSeen += 1;
    if (r.side === 'SELL') { bump(t, 'sharesSold', shares); bump(t, 'tradeProceeds', value); }
    else { bump(t, 'sharesBought', shares); bump(t, 'tradeCost', value); }
    t.firstTs = t.firstTs == null ? r.ts : Math.min(t.firstTs, r.ts);
    t.lastTs = maxTs(t.lastTs, r.ts);
    m.firstTs = m.firstTs == null ? r.ts : Math.min(m.firstTs, r.ts);
    m.lastTs = maxTs(m.lastTs, r.ts);
    if (m.txs.length < 25) m.txs.push({ ts: r.ts, side: r.side, outcome: r.outcome, price: r.price, shares: r.shares, value: r.value, txHash: r.tx_hash });
  }

  // 1b) redemptions = the trader claiming a resolved market (settles + times it)
  for (const r of redeemRows) {
    const m = marketFor(r);
    bump(m, 'redeemUsdc', r.usdc);
    m.redeemTs = maxTs(m.redeemTs, r.ts);
    m.lastTs = maxTs(m.lastTs, r.ts);
  }

  return [...markets.values()];
}

/**
 * 5/6/7/8) CLASSIFY one grouped market into WIN | LOSS | UNDETERMINED.
 * Pure function of (grouped market, authoritative market resolution) — unit-testable.
 */
export function classifyMarketPosition(market, resolution, now = nowSec()) {
  const tokens = [...market.tokens.values()];
  const active = tokens.filter((t) => tokenCost(t) > 0 || tokenProceeds(t) > 0 || (t.sharesHeld || 0) > 0 || (t.sharesBought || 0) > 0 || t.isOpen || t.isClosed);
  // "held" = the wallet still owns tokens in this market (so the position itself is
  // not finished; it is only finished once the market resolves).
  const held = active.some((t) => t.isOpen && (t.sharesHeld || 0) > 0);
  const base = {
    condition_id: market.conditionId,
    market_name: market.title || null,
    market_slug: market.slug || null,
    event_slug: market.eventSlug || null,
    trades_count: market.tradesSeen,
    positions_count: active.length,
    cost_usdc: round6(active.reduce((s, t) => s + tokenCost(t), 0)),
    proceeds_usdc: round6(active.reduce((s, t) => s + tokenProceeds(t), 0) + (market.redeemUsdc || 0)),
    realized_pnl: round6(active.reduce((s, t) => s + (t.realized || 0), 0)),
    unrealized_pnl: round6(active.reduce((s, t) => s + (t.unrealized || 0), 0)),
    started_at: market.firstTs,
    resolution_source: resolution?.source ?? null,
    source_transactions: market.txs,
  };
  base.total_pnl = round6((base.realized_pnl || 0) + (base.unrealized_pnl || 0));
  const undetermined = (reason, extra = {}) => ({
    ...base,
    result: 'UNDETERMINED',
    status: held ? 'OPEN' : 'COMPLETED',
    reason,
    predicted_outcome: null, predicted_index: null, final_outcome: null, final_index: null,
    shares_predicted: null, hedged: 0,
    completed_at: market.lastTs ?? null, completed_from: 'last_trade',
    resolved_at: null, needs_resolution: 1,
    ...extra,
  });

  if (!active.length) {
    return undetermined('no_direction', { source_transactions: [], needs_resolution: 0, completed_at: market.lastTs ?? null });
  }

  // --- which side was the actual prediction? -----------------------------------
  // Weight = cost basis (USD committed). A trader who committed $1,000 to YES and
  // $4 to NO predicted YES; one genuinely hedged both sides is NOT a prediction.
  const ranked = [...active].sort((a, b) => exposureWeight(b) - exposureWeight(a));
  const predicted = ranked[0];
  if (!predicted || exposureWeight(predicted) <= 0) {
    // Nothing was accumulated on either side (e.g. sells of tokens acquired outside the
    // synced history). We refuse to infer a direction — the record stays UNDETERMINED.
    return undetermined('no_direction', {
      predicted_outcome: normOutcome(predicted?.outcome),
      needs_resolution: 0,
    });
  }
  const totalWeight = ranked.reduce((s, t) => s + exposureWeight(t), 0);
  const secondWeight = ranked[1] ? exposureWeight(ranked[1]) : 0;
  const hedged = ranked.length > 1 && totalWeight > 0 && secondWeight / totalWeight >= 0.3;

  const predictedOutcome = normOutcome(predicted.outcome);
  const predictedIndex = predicted.outcomeIndex ?? null;
  const out = {
    ...base,
    predicted_outcome: predictedOutcome,
    predicted_index: predictedIndex,
    predicted_asset: predicted.asset,
    shares_predicted: round6(predicted.sharesHeld || (predicted.sharesBought || 0) - (predicted.sharesSold || 0)),
    hedged: hedged ? 1 : 0,
  };
  Object.assign(out, computeCompletion(market, resolution, held, now));

  // --- 5/6) do we know how the market actually resolved? -----------------------
  const state = resolution?.market_state ?? null;
  const finalLabel = resolution?.winning_outcome ? normOutcome(resolution.winning_outcome) : null;
  const closedAt = resolution?.closed_at ?? null;

  if (hedged) {
    return { ...out, result: 'UNDETERMINED', status: held ? 'OPEN' : 'COMPLETED', reason: 'hedged_both_outcomes',
      final_outcome: finalLabel, final_index: state === 'resolved' ? resolution.winning_index : null,
      resolved_at: closedAt, needs_resolution: state === 'resolved' ? 0 : 1 };
  }
  if (!resolution || state === 'unknown') {
    // Not verified yet: queued, or backed off after repeated failures. Never guessed.
    return { ...out, result: 'UNDETERMINED', status: held ? 'OPEN' : 'COMPLETED',
      reason: (resolution?.attempts || 0) > 0 ? 'resolution_unavailable' : 'resolution_pending',
      final_outcome: null, final_index: null, resolved_at: null, needs_resolution: 1 };
  }
  if (state === 'flat') return { ...out, result: 'UNDETERMINED', status: 'COMPLETED', reason: 'flat_resolution', final_outcome: finalLabel, final_index: null, resolved_at: closedAt, needs_resolution: 0 };
  if (state === 'voided') return { ...out, result: 'UNDETERMINED', status: 'COMPLETED', reason: 'voided', final_outcome: null, final_index: null, resolved_at: closedAt, needs_resolution: 0 };
  if (state === 'closed_unresolved') return { ...out, result: 'UNDETERMINED', status: held ? 'OPEN' : 'COMPLETED', reason: 'awaiting_market_resolution', final_outcome: null, final_index: null, resolved_at: null, needs_resolution: 1 };

  // --- 8) market still open ⇒ a position here is neither a win nor a loss. ------
  if (state === 'open') {
    return {
      ...out,
      result: 'UNDETERMINED',
      reason: held ? 'market_open' : 'awaiting_market_resolution',
      status: held ? 'OPEN' : 'COMPLETED',
      completed_at: held ? (market.lastTs ?? out.completed_at) : out.completed_at,
      completed_from: held ? 'last_trade' : out.completed_from,
      final_outcome: null, final_index: null, resolved_at: null,
      needs_resolution: 1,
    };
  }

  // --- 7) WIN/LOSS from the final resolution, compared with the held side only. -
  const winningIndex = resolution.winning_index;
  let winLoss = null;
  if (winningIndex != null) winLoss = predictedIndex == null ? null : predictedIndex === winningIndex;
  if (winLoss === null && predicted.asset && resolution.winning_token) {
    winLoss = String(predicted.asset) === String(resolution.winning_token);
  }
  if (winLoss === null && predictedOutcome && finalLabel) winLoss = predictedOutcome === finalLabel;
  if (winLoss === null) {
    return { ...out, result: 'UNDETERMINED', status: held ? 'OPEN' : 'COMPLETED', reason: 'resolution_unavailable',
      final_outcome: finalLabel, final_index: winningIndex ?? null, resolved_at: closedAt, needs_resolution: 1 };
  }
  return {
    ...out,
    result: winLoss ? 'WIN' : 'LOSS',
    // The market decided this one — the position is complete whether it was redeemed,
    // exited earlier, or is still sitting unredeemed in the wallet.
    status: 'COMPLETED',
    reason: held ? null : 'settled_after_exit', // badge only: never changes the verdict
    completed_at: out.completed_at ?? closedAt ?? null,
    completed_from: out.completed_from ?? (closedAt ? 'resolution' : 'estimated'),
    final_outcome: finalLabel, final_index: winningIndex ?? null,
    resolved_at: closedAt,
    needs_resolution: 0,
  };
}

/** Exposure weight used to pick the predicted side (cost basis, then shares). */
function exposureWeight(t) {
  const cost = tokenCost(t);
  if (cost > 0) return cost;
  const shares = Math.max(t.sharesHeld || 0, t.sharesBought || 0);
  const px = t.avgPrice ?? t.curPrice ?? 0.5;
  return shares * px;
}

/** 9) completion timing — prefer the position's own settlement, else resolution. */
function computeCompletion(market, resolution, stillHeld, now) {
  const closedTss = [...market.tokens.values()].map((t) => t.closedAt).filter((v) => v != null);
  const exitOnly = closedTss.length > 0 && !stillHeld;
  if (exitOnly) return { completed_at: Math.max(...closedTss), completed_from: 'closed_position' };
  if (market.redeemTs) return { completed_at: market.redeemTs, completed_from: 'redeem' };
  if (resolution?.closed_at) return { completed_at: resolution.closed_at, completed_from: 'resolution' };
  if (market.lastTs) return { completed_at: market.lastTs, completed_from: 'last_trade' };
  const endEpoch = market.endDates.map((d) => (d ? Math.floor(new Date(d).getTime() / 1000) : null)).filter((v) => Number.isFinite(v));
  if (endEpoch.length) return { completed_at: Math.max(...endEpoch), completed_from: 'estimated' };
  return { completed_at: null, completed_from: null };
}

const round6 = (v) => (Number.isFinite(v) ? +v.toFixed(6) : null);

/**
 * Rebuild every prediction row for one wallet from stored data.
 * Deterministic: same stored rows + same resolutions ⇒ same numbers.
 */
export function rebuildPredictions(walletId, { now = nowSec(), resolutionLoader = getResolution } = {}) {
  const closedRows = db.prepare('SELECT * FROM closed_positions WHERE wallet = ?').all(walletId);
  const openRows = db.prepare('SELECT * FROM positions WHERE wallet = ?').all(walletId);
  const tradeRows = db.prepare(`SELECT ts, side, condition_id, asset, title, slug, event_slug, outcome, outcome_index, price, shares, value, tx_hash
    FROM trades WHERE wallet = ? ORDER BY ts DESC LIMIT ?`).all(walletId, config.initialMaxTrades * 2);
  const redeemRows = db.prepare(`SELECT ts, condition_id, asset, title, slug, event_slug, outcome, outcome_index, usdc
    FROM activity WHERE wallet = ? AND type = 'REDEEM'`).all(walletId);

  const markets = collectMarketPositions({ closedRows, openRows, tradeRows, redeemRows });
  const rows = [];
  for (const m of markets) {
    const res = m.conditionId ? loadResolution(m.conditionId, resolutionLoader) : null;
    const classified = classifyMarketPosition(m, res, now);
    if (!classified) continue;
    const id = crypto.createHash('sha1').update(`${walletId}|${m.key}`).digest('hex');
    rows.push({
      prediction_id: id,
      wallet: walletId,
      condition_id: m.conditionId || m.key,
      market_name: classified.market_name,
      market_slug: classified.market_slug,
      event_slug: classified.event_slug,
      predicted_outcome: classified.predicted_outcome,
      predicted_index: classified.predicted_index,
      final_outcome: classified.final_outcome,
      final_index: classified.final_index,
      result: classified.result,
      status: classified.status,
      reason: classified.reason,
      cost_usdc: classified.cost_usdc,
      proceeds_usdc: classified.proceeds_usdc,
      realized_pnl: classified.realized_pnl,
      unrealized_pnl: classified.unrealized_pnl,
      total_pnl: classified.total_pnl,
      shares_predicted: classified.shares_predicted,
      trades_count: classified.trades_count,
      positions_count: classified.positions_count,
      hedged: classified.hedged,
      started_at: classified.started_at,
      completed_at: classified.completed_at,
      completed_from: classified.completed_from,
      resolved_at: classified.resolved_at,
      source_transactions: JSON.stringify(classified.source_transactions || []),
      resolution_source: classified.resolution_source,
      needs_resolution: classified.needs_resolution,
    });
  }
  replacePredictions(walletId, rows, now);
  return { markets: markets.length, rows: rows.length };
}

const loadResolution = (conditionId, loader) => {
  const r = loader(conditionId);
  if (!r) return null;
  return { ...r, outcomes: safeParse(r.outcomes_json) };
};

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ---------------------------------------------------------------------------
// Market resolution lookups (budgeted + cached forever)
// ---------------------------------------------------------------------------
/**
 * Look up authoritative resolutions for the markets this wallet's predictions still
 * need. One market is fetched at most ~once ever (cached in `market_resolutions`),
 * open markets are re-checked on a delay, and a per-cycle budget keeps the
 * browser-bridge transport responsive.
 */
export async function resolveMarketsForWallet(walletId, { budget = config.resolutionLookupsPerCycle, deadline = Infinity } = {}) {
  const now = nowSec();
  const ids = pendingResolutionIds(walletId, now, {
    retrySec: config.resolutionRetrySec,
    maxAttempts: config.resolutionMaxAttempts,
    limit: Math.max(0, Math.min(budget, config.resolutionLookupsPerCycle * 4)),
  });
  if (!ids.length) return { lookedUp: 0, resolved: 0, pending: pendingResolutionCount(walletId) };
  const metaByCondition = new Map();
  for (const row of db.prepare('SELECT DISTINCT condition_id, market_slug FROM predictions WHERE wallet = ? AND needs_resolution = 1').all(walletId)) {
    if (row.condition_id) metaByCondition.set(row.condition_id, row.market_slug);
  }
  let resolvedCount = 0;
  const out = await mapPool(ids.slice(0, budget), config.resolutionConcurrency, async (conditionId) => {
    if (Date.now() >= deadline) return 'skipped';
    const slug = metaByCondition.get(conditionId) || null;
    try {
      let rec;
      try {
        rec = normalizeClobMarket(await transportGet(marketResolutionUrl(conditionId)), conditionId);
      } catch (err) {
        if (!slug) throw err;
        rec = normalizeGammaMarket(await transportGet(marketResolutionFallbackUrl(slug)), conditionId);
      }
      const prev = getResolution(conditionId);
      upsertMarketResolution({
        ...rec,
        outcomes_json: rec.outcomes ? JSON.stringify(rec.outcomes) : null,
        closed_at: rec.closed_at ?? deriveClosedAt(prev),
        attempts: (prev?.attempts || 0) + 1,
        last_attempt_at: nowSec(),
        fetched_at: nowSec(),
      });
      return rec.resolved ? 'resolved' : 'open';
    } catch (err) {
      noteResolutionAttempt(conditionId, nowSec(), String(err?.message || err).slice(0, 160));
      return 'failed';
    }
  });
  resolvedCount = out.filter((r) => r === 'resolved').length;
  return { lookedUp: out.length, resolved: resolvedCount, failed: out.filter((r) => r === 'failed').length, pending: pendingResolutionCount(walletId) };
}

/** Once a market has a closed_at we never lose it (resolution time does not move). */
const deriveClosedAt = (prev) => (prev && prev.closed_at ? prev.closed_at : null);

// ---------------------------------------------------------------------------
// Stats: win-rate windows + auditable counts
// ---------------------------------------------------------------------------
/**
 * Walk the newest completed predictions until `size` WIN/LOSS records are collected.
 * `scanned` is how many completed records had to be examined to fill the window and
 * `excluded` how many of them could not be classified — so a 100-window built from
 * 118 records is visible, and 63/100 is never silently reported as 63/118.
 */
export function windowFromRows(rows, size) {
  let wins = 0; let losses = 0; let excluded = 0; let scanned = 0; let pnl = 0;
  const reasons = {};
  for (const r of rows) {
    scanned++;
    if (r.result === 'WIN') wins++;
    else if (r.result === 'LOSS') losses++;
    else { excluded++; reasons[r.reason || 'unclassified'] = (reasons[r.reason || 'unclassified'] || 0) + 1; }
    pnl += r.total_pnl || 0;
    if (wins + losses >= size) break;
  }
  const analyzed = wins + losses;
  return {
    window: Number.isFinite(size) ? size : null,
    scanned,
    analyzed,
    wins,
    losses,
    excluded,
    reasons,
    winRate: analyzed > 0 ? wins / analyzed : null,
    // true when fewer qualifying predictions exist than the window asks for:
    // the UI must then say "based on N completed predictions" instead of pretending.
    limited: Number.isFinite(size) ? analyzed < size : false,
    truncated: Number.isFinite(size) && scanned >= rows.length && analyzed < size,
    pnl: round6(pnl),
  };
}

/**
 * The full analytics payload for one wallet. Every screen reads this shape so the
 * number shown on a card, a table row and the detail page is the same number.
 */
/**
 * Sample-size sentence shown next to every rate (spec 6/7): never padded, and never
 * phrased as a percentage of 100 when fewer than 100 predictions exist.
 */
export function predictionLabel(win) {
  if (!win || win.analyzed === 0) {
    return win && win.scanned
      ? `No completed prediction has a verified market resolution yet (${win.scanned} completed ${win.scanned === 1 ? 'record' : 'records'} scanned)`
      : 'No completed predictions yet';
  }
  return win.limited
    ? `Based on ${win.analyzed} completed prediction${win.analyzed === 1 ? '' : 's'}`
    : `Based on the most recent ${win.analyzed} completed predictions`;
}

export function computePredictionStats(walletId, { now = nowSec(), periods = {} } = {}) {
  const scanCap = Math.max(SCAN_LIMIT, config.predictionClosedPositions);
  const rows = recentCompletedPredictions(walletId, scanCap);
  const windows = {};
  for (const n of PREDICTION_WINDOWS) windows[String(n)] = { ...windowFromRows(rows, n), label: '' };
  windows.all = { ...windowFromRows(rows, Number.POSITIVE_INFINITY), label: '' };
  for (const k of Object.keys(windows)) windows[k].label = predictionLabel(windows[k]);

  const primary = windows[String(PRIMARY_PREDICTION_WINDOW)];
  const totals = predictionTotals(walletId) || {};
  const openEx = openPredictionCount(walletId);
  const pending = pendingResolutionCount(walletId);

  // Period-scoped rates (same engine, same classification, filtered by completion
  // time). Computed with an exact aggregate so a busy 24h window is never capped.
  const periodStats = {};
  for (const [key, cutoff] of Object.entries(periods)) {
    const t = predictionTotals(walletId, cutoff || null) || {};
    const wins = t.wins || 0; const losses = t.losses || 0; const analyzed = wins + losses;
    periodStats[key] = {
      analyzed, wins, losses,
      excluded: t.undetermined || 0,
      scanned: t.completed || 0,
      winRate: analyzed > 0 ? wins / analyzed : null,
      pnl: t.pnl ?? null,
    };
  }

  const anyClassified = windows.all.analyzed > 0;
  return {
    computedAt: now,
    primary: {
      ...primary,
      label: predictionLabel(primary),
      window: PRIMARY_PREDICTION_WINDOW,
    },
    windows,
    periods: periodStats,
    totals: {
      completed: totals.completed || 0,
      wins: totals.wins || 0,
      losses: totals.losses || 0,
      undetermined: totals.undetermined || 0,
      analyzed: (totals.wins || 0) + (totals.losses || 0),
      winRate: anyClassified ? (totals.wins || 0) / ((totals.wins || 0) + (totals.losses || 0)) : null,
      costUsdc: totals.cost ?? null,
      realizedPnl: totals.realized_pnl ?? null,
      totalPnl: totals.pnl ?? null,
      oldestCompletedAt: totals.oldest ?? null,
      newestCompletedAt: totals.newest ?? null,
    },
    // Kept separate from every rate above: it answers "how many closed positions made
    // money", which is NOT prediction accuracy (spec 13/18). Computed here as well so
    // cached payloads can show the contrast without a second query.
    profitability: profitabilityFromClosedPositions(walletId),
    exclusions: {
      openPositions: openEx.c || 0,
      openPendingResolution: openEx.pending || 0,
      pendingResolutions: pending,
      note: 'Open positions and markets without a final resolution are never counted as wins or losses.',
    },
    coverage: {
      scannedCompleted: rows.length,
      scanCap,
      sourceWindow: config.predictionClosedPositions,
      closedHistoryComplete: true, // refined by the sync engine from paging results
    },
  };
}

/**
 * calculateTraderWinRate — the spec-mandated entry point.
 * Everything a screen needs to show the independently calculated win rate,
 * its sample size, the excluded records and the trading P&L alongside it.
 */
export async function calculateTraderWinRate(walletId, { sync = false, wallet = null, budget } = {}) {
  if (sync) {
    const w = wallet || db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
    if (w) {
      await resolveMarketsForWallet(walletId, { budget, deadline: Infinity });
      rebuildPredictions(walletId);
    }
  }
  const periods = {};
  for (const [k, secs] of Object.entries({ '24h': 86400, '72h': 259200, '7d': 604800, '30d': 2592000 })) {
    periods[k] = nowSec() - secs;
  }
  const stats = computePredictionStats(walletId, { periods });
  const legacy = profitabilityFromClosedPositions(walletId);
  return { ...stats, profitability: legacy };
}

/**
 * What Polymarket's own position data would say if win rate meant "made money"
 * (realized P&L > 0 on closed positions). Kept ONLY as the clearly-labelled
 * "profitability" cross-check so the difference vs. prediction accuracy is visible.
 */
export function profitabilityFromClosedPositions(walletId, cutoff = null) {
  const row = db.prepare(`
    SELECT SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) losses,
           SUM(CASE WHEN realized_pnl = 0 THEN 1 ELSE 0 END) flat,
           SUM(realized_pnl) realized_pnl, COUNT(*) closed
    FROM closed_positions WHERE wallet = ? ${cutoff ? 'AND ts >= ?' : ''}`)
    .get(...(cutoff ? [walletId, cutoff] : [walletId]));
  const wins = row.wins || 0;
  const losses = row.losses || 0;
  const decided = wins + losses;
  return {
    label: 'Profitable closed positions (P&L based — not a prediction win rate)',
    closed: row.closed || 0,
    wins, losses, flat: row.flat || 0,
    rate: decided > 0 ? wins / decided : null,
    realizedPnl: row.realized_pnl ?? null,
  };
}
