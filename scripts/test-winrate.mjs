/**
 * test-winrate.mjs — unit + pipeline tests for the independently calculated win rate.
 *
 *   node scripts/test-winrate.mjs
 *
 * Two layers are covered on purpose:
 *   • the PURE classifier (collectMarketPositions + classifyMarketPosition) with
 *     hand-written fixtures whose expected result is known, and
 *   • the persisted pipeline (rebuildPredictions → computePredictionStats) against a
 *     throwaway SQLite database, which is what the API and the UI actually read.
 *
 * Every case here exists because the previous implementation could get it wrong
 * (win rate derived from realized P&L, taker-only fills, ascending closed-position
 * paging). Run this before considering the feature complete.
 */
process.env.DATA_DIR = process.env.DATA_DIR || `/tmp/pwt-winrate-test-${process.pid}`;
process.env.POLL_INTERVAL = '30';

const { collectMarketPositions, classifyMarketPosition, rebuildPredictions, computePredictionStats, windowFromRows, profitabilityFromClosedPositions } = await import('../server/predictions.js');
const { db, insertWallet, upsertClosedPositions, replacePositions, replacePredictions } = await import('../server/db.js');
const { winStatsForWindow, windowSummary, computeDashboardStats } = await import('../server/analytics.js');

let pass = 0; let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.error(`  ✘ ${label}${extra ? ` — got ${extra}` : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, JSON.stringify(a) + (b === undefined ? '' : ` ≠ ${JSON.stringify(b)}`));
const near = (a, b, label, eps = 1e-9) => ok(Math.abs((a ?? NaN) - b) < eps, label, `${a} ≠ ${b}`);
const head = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

const T0 = 1_780_000_000; // fixed clock: tests must not depend on "now"

// --------------------------------------------------------------------------
// fixture builders (shapes match data-api.polymarket.com responses)
// --------------------------------------------------------------------------
const openPos = (o = {}) => ({
  wallet: 'w1', asset: o.asset || 'tok-yes', condition_id: o.cid || '0xmkt', title: o.title || 'Market',
  slug: o.slug || 'market', event_slug: 'market', size: o.size ?? 100, avg_price: o.avg ?? 0.5,
  initial_value: o.cost ?? 50, current_value: o.cv ?? 0, cash_pnl: o.pnl ?? 0, percent_pnl: null,
  realized_pnl: o.realized ?? null, total_bought: o.cost ?? 50, cur_price: o.cur ?? 0,
  redeemable: o.redeemable ? 1 : 0, outcome: o.outcome || 'Yes', outcome_index: o.idx ?? 0,
  end_date: '2026-08-01', updated_at: T0,
});
const closedPos = (o = {}) => ({
  wallet: 'w1', asset: o.asset || 'tok-yes', condition_id: o.cid || '0xmkt', avg_price: o.avg ?? 0.5,
  total_bought: o.cost ?? 50, realized_pnl: o.realized ?? 0, cur_price: o.cur ?? 1, ts: o.ts ?? T0,
  title: o.title || 'Market', slug: o.slug || 'market', event_slug: 'market', outcome: o.outcome || 'Yes',
  outcome_index: o.idx ?? 0, updated_at: T0,
});
const fill = (o = {}) => ({
  ts: o.ts ?? T0, side: o.side || 'BUY', condition_id: o.cid || '0xmkt', asset: o.asset || 'tok-yes',
  title: o.title || 'Market', slug: 'market', event_slug: 'market', outcome: o.outcome || 'Yes',
  outcome_index: o.idx ?? 0, price: o.price ?? 0.5, shares: o.shares ?? 100, value: o.value ?? 50, tx_hash: o.tx || null,
});
const resolved = (winnerIdx, extra = {}) => ({ market_state: 'resolved', closed: 1, resolved: 1, winning_index: winnerIdx, winning_outcome: winnerIdx === 0 ? 'Yes' : 'No', winning_token: extra.winningToken ?? (winnerIdx === 0 ? 'tok-yes' : 'tok-no'), source: 'clob', attempts: 1, closed_at: extra.closedAt ?? T0 + 100, ...extra });

/** Group a single market's rows and classify them. */
const classifyOne = ({ closed = [], open = [], trades = [], redeems = [], resolution = null, now = T0 + 500 }) => {
  const [market] = collectMarketPositions({ closedRows: closed, openRows: open, tradeRows: trades, redeemRows: redeems });
  if (!market) return null;
  return classifyMarketPosition(market, resolution, now);
};

// --------------------------------------------------------------------------
head('1. Grouping: a trade is not a prediction (spec 2, 16, 17)');
// --------------------------------------------------------------------------
{
  // 5 buys + 3 sells of the SAME token in the same market, held to a YES resolution
  const buys = Array.from({ length: 5 }, (_, i) => fill({ ts: T0 + i, side: 'BUY', shares: 100, value: 50 }));
  const sells = Array.from({ length: 3 }, (_, i) => fill({ ts: T0 + 10 + i, side: 'SELL', shares: 30, value: 20 }));
  const r = classifyOne({ closed: [closedPos({ realized: 99999 })], trades: [...buys, ...sells] , resolution: resolved(0) });
  eq(r.result, 'WIN', '8 transactions in one market ⇒ exactly one WIN (not 8)');
  eq(r.positions_count, 1, 'one outcome token grouped');
  eq(r.trades_count, 8, 'all 8 fills recorded as evidence for that one prediction');
  ok(r.source_transactions.length > 0, 'prediction keeps its source transactions (auditable)');
}
{
  // partial exit then resolution: still one prediction
  const r = classifyOne({
    closed: [closedPos({ realized: 120 })],
    trades: [fill({ side: 'BUY', shares: 1000, value: 500 }), fill({ side: 'SELL', shares: 300, value: 200, ts: T0 + 5 })],
    resolution: resolved(0),
  });
  eq(r.result, 'WIN', 'partial sell + market resolves in favour ⇒ WIN');
  eq(r.trades_count, 2, 'partial exit does not create a second prediction');
}

// --------------------------------------------------------------------------
head('2. Market resolution is the source of truth, never P&L (spec 3, 13, 18)');
// --------------------------------------------------------------------------
{
  // sold at a profit, market resolved against them ⇒ LOSS (the old code called this a win)
  const r = classifyOne({ closed: [closedPos({ realized: +5000, cur: 0.7 })], resolution: resolved(1) });
  eq(r.result, 'LOSS', 'profitable early exit in a market that resolved NO against a YES position ⇒ LOSS');
  near(r.realized_pnl, 5000, 'P&L is reported separately and does not change the verdict');
}
{
  // lost money, market resolved in their favour ⇒ WIN
  const r = classifyOne({ closed: [closedPos({ realized: -800, cur: 1 })], resolution: resolved(0) });
  eq(r.result, 'WIN', 'losing money while being directionally right ⇒ WIN');
}
{
  // held a losing position, never redeemed (the classic "invisible loss")
  const r = classifyOne({ open: [openPos({ size: 1000, cur: 0, redeemable: true, pnl: -500 })], resolution: resolved(1) });
  eq(r.result, 'LOSS', 'unredeemed losing position in a resolved market ⇒ LOSS');
  eq(r.status, 'COMPLETED', 'resolved market ⇒ the prediction is complete');
}

// --------------------------------------------------------------------------
head('3. Unresolved markets are never wins or losses (spec 7, 18)');
// --------------------------------------------------------------------------
{
  const r = classifyOne({ open: [openPos({ cur: 0.62 })], resolution: { market_state: 'open', closed: 0, resolved: 0, attempts: 1, source: 'clob' } });
  eq(r.result, 'UNDETERMINED', 'open position in an unresolved market is not classified');
  eq(r.status, 'OPEN', '…and is marked open so the UI can show it as excluded');
  eq(r.reason, 'market_open', 'with an explicit exclusion reason');
  eq(r.needs_resolution, 1, 'kept in the resolution queue so it classifies itself later');
}
{
  const r = classifyOne({ closed: [closedPos({ realized: 250, cur: 0.735 })], resolution: { market_state: 'open', closed: 0, resolved: 0, attempts: 1, source: 'clob' } });
  eq(r.result, 'UNDETERMINED', 'position closed before resolution is NOT a win even though it profited');
  eq(r.reason, 'awaiting_market_resolution', 'reason says the market is what is missing');
  eq(r.status, 'COMPLETED', 'the position itself is finished, so it is scanned as completed');
}
{
  const r = classifyOne({ closed: [closedPos()], resolution: null });
  eq(r.result, 'UNDETERMINED', 'no resolution data yet ⇒ never guessed');
  eq(r.reason, 'resolution_pending', '…and says so explicitly');
  eq(r.needs_resolution, 1, 'queued for lookup');
  const r2 = classifyOne({ closed: [closedPos()], resolution: { market_state: 'unknown', resolved: 0, attempts: 3, source: 'clob' } });
  eq(r2.reason, 'resolution_unavailable', 'after failed lookups the reason switches to unavailable');
}

// --------------------------------------------------------------------------
head('4. Ambiguity is excluded, not forced (spec 19)');
// --------------------------------------------------------------------------
{
  const r = classifyOne({
    closed: [closedPos({ asset: 'tok-yes', outcome: 'Yes', idx: 0, cost: 1000 }), closedPos({ asset: 'tok-no', outcome: 'No', idx: 1, cost: 900 })],
    resolution: resolved(0),
  });
  eq(r.result, 'UNDETERMINED', 'hedged both sides of one market ⇒ undetermined, not 1 win + 1 loss');
  eq(r.positions_count, 2, 'both tokens are still visible on the record');
  eq(r.hedged, 1, 'flagged as hedged');
}
{
  const r = classifyOne({
    closed: [closedPos({ asset: 'tok-yes', cost: 1000 }), closedPos({ asset: 'tok-no', outcome: 'No', idx: 1, cost: 1 })],
    resolution: resolved(0),
  });
  eq(r.result, 'WIN', 'a $1 dust leg does not turn a $1,000 YES position into a hedge');
}
{
  const r = classifyOne({ closed: [closedPos()], resolution: { market_state: 'flat', closed: 1, resolved: 0, attempts: 1, source: 'clob', reason: '50/50' } });
  eq(r.result, 'UNDETERMINED', '50/50 resolution is not a clean win ⇒ excluded');
  eq(r.reason, 'flat_resolution', 'with a reason the UI can show');
}
{
  // only sells of tokens we never saw bought: no direction can be read
  const r = classifyOne({ trades: [fill({ side: 'SELL', shares: 100, value: 40 })], resolution: resolved(0) });
  eq(r.result, 'UNDETERMINED', 'sells with no observed acquisition ⇒ no direction inferred');
  eq(r.reason, 'no_direction', '…and the reason is recorded');
}

// --------------------------------------------------------------------------
head('5. The win-rate formula and the windows (spec 1, 5, 6, 14, 15)');
// --------------------------------------------------------------------------
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ result: i < 63 ? 'WIN' : 'LOSS', completed_at: T0 - i, total_pnl: 1 }));
  const w = windowFromRows(rows, 100);
  eq(`${w.wins}/${w.analyzed}`, '63/100', '63 wins of 100 completed predictions');
  near(w.winRate, 0.63, 'win rate = 63 / 100 = 63%');
  eq(w.limited, false, 'a full 100-sample window is not flagged as limited');
  const w60 = windowFromRows(Array.from({ length: 100 }, (_, i) => ({ result: i < 60 ? 'WIN' : 'LOSS', completed_at: T0 - i, total_pnl: 0 })), 100);
  near(w60.winRate, 0.60, '60W/40L ⇒ 60% (not 100%)');
}
{
  const rows = [
    ...Array.from({ length: 48 }, () => ({ result: 'WIN', completed_at: 1, total_pnl: 0 })),
    ...Array.from({ length: 24 }, () => ({ result: 'LOSS', completed_at: 1, total_pnl: 0 })),
    ...Array.from({ length: 10 }, () => ({ result: 'UNDETERMINED', completed_at: 1, total_pnl: 0, reason: 'resolution_pending' })),
  ];
  const w = windowFromRows(rows, 100);
  near(w.winRate, 48 / 72, 'the spec 7 example: 48/72 = 66.67% (never 48/100 or 72/100)');
  eq(w.excluded, 10, 'undetermined records are counted as excluded, not as losses');
  eq(w.analyzed, 72, 'denominator is wins + losses only');
  ok(Object.keys(w.reasons).includes('resolution_pending'), 'the excluded records carry their reasons for the audit view');
}
{
  const rows = [...Array.from({ length: 29 }, () => ({ result: 'WIN', completed_at: 1, total_pnl: 0 })), ...Array.from({ length: 13 }, () => ({ result: 'LOSS', completed_at: 1, total_pnl: 0 }))];
  const w = windowFromRows(rows, 100);
  near(w.winRate, 29 / 42, 'only 42 qualifying predictions ⇒ 69.05% (no padding, no fabrication)');
  eq(w.analyzed, 42, 'sample size reported as 42');
  eq(w.limited, true, '…and flagged as fewer than the requested window');
}
{
  const w = windowFromRows(Array.from({ length: 8 }, () => ({ result: 'WIN', completed_at: 1, total_pnl: 0 })), 100);
  eq(w.winRate, 1, '100% is representable…');
  eq(w.analyzed, 8, '…only when the sample (8/8) is reported with it');
  const empty = windowFromRows([], 100);
  eq(empty.winRate, null, 'no completed predictions ⇒ N/A, never 0% and never 100%');
}
{
  // window ordering: the most recent qualifying predictions are the ones that count
  const rows = [
    { result: 'WIN', completed_at: 5, total_pnl: 0 },
    { result: 'WIN', completed_at: 4, total_pnl: 0 },
    { result: 'LOSS', completed_at: 3, total_pnl: 0 },
    { result: 'LOSS', completed_at: 2, total_pnl: 0 },
    { result: 'LOSS', completed_at: 1, total_pnl: 0 },
  ];
  eq(windowFromRows(rows, 2).winRate, 1, 'last 2 predictions ⇒ both wins ⇒ 100%');
  near(windowFromRows(rows, 5).winRate, 0.4, 'last 5 predictions ⇒ 40%');
}

// --------------------------------------------------------------------------
head('6. Persisted pipeline: rebuild → stats → API shapes');
// --------------------------------------------------------------------------
{
  const wallet = { id: 'w1', address: 'w1', username: 'tester', pseudonym: null, bio: null, profile_image: null, x_username: null, verified: 0, polymarket_created_at: null, added_at: T0, poll_interval: 30 };
  db.prepare('DELETE FROM wallets').run();
  insertWallet(wallet);

  // 100 markets: 63 resolve in the trader's favour, 37 against.
  // Every market gets 3 buys + 1 sell so any "one trade = one prediction" mistake
  // would show up as 400 records instead of 100.
  const closedRows = [];
  const resolutions = [];
  for (let i = 0; i < 100; i++) {
    const won = i < 63;
    const cid = `0xm${i}`;
    const asset = won ? 'tok-yes' : 'tok-yes';
    closedRows.push({
      wallet: 'w1', asset: `${asset}-${cid}`, condition_id: cid, avg_price: 0.5, total_bought: 100,
      realized_pnl: won ? 100 : 50,          // ← BOTH sides show positive P&L on purpose:
      cur_price: won ? 1 : 0.4, ts: T0 - i * 100, title: `Market ${i}`, slug: `market-${i}`,
      event_slug: `market-${i}`, outcome: 'Yes', outcome_index: 0, updated_at: T0,
    });
    resolutions.push({ condition_id: cid, slug: `market-${i}`, question: `Market ${i}?`, market_state: 'resolved', closed: 1, resolved: 1, winning_index: won ? 0 : 1, winning_outcome: won ? 'Yes' : 'No', winning_token: won ? `${asset}-${cid}` : `tok-no-${cid}`, outcomes_json: null, closed_at: T0 - i * 100 + 10, source: 'clob', reason: null, attempts: 1, last_attempt_at: T0, fetched_at: T0 });
  }
  for (const r of resolutions) db.prepare(`INSERT INTO market_resolutions (condition_id, slug, question, market_state, closed, resolved, winning_index, winning_outcome, winning_token, outcomes_json, closed_at, source, reason, attempts, last_attempt_at, fetched_at)
    VALUES (@condition_id, @slug, @question, @market_state, @closed, @resolved, @winning_index, @winning_outcome, @winning_token, @outcomes_json, @closed_at, @source, @reason, @attempts, @last_attempt_at, @fetched_at)
    ON CONFLICT(condition_id) DO UPDATE SET market_state=excluded.market_state, resolved=excluded.resolved, winning_index=excluded.winning_index, winning_outcome=excluded.winning_outcome, winning_token=excluded.winning_token, closed_at=excluded.closed_at`).run(r);
  // those 18 "open" ones live in positions (held), not closed_positions
  const openRows = Array.from({ length: 18 }, (_, i) => openPos({ cid: `0xp${i}`, asset: `p-${i}`, title: `Pending ${i}`, slug: `pending-${i}`, cur: 0.6, redeemable: false }));
  // 10 positions exited before their market resolved — timestamps deliberately
  // interleaved with the settled ones, so the engine must skip them while filling the
  // 100-window instead of dividing by the number of records it scanned.
  for (let i = 0; i < 10; i++) {
    closedRows.push({ wallet: 'w1', asset: `u-${i}`, condition_id: `0xu${i}`, avg_price: 0.5, total_bought: 40, realized_pnl: 12, cur_price: 0.6, ts: T0 - i * 1000 + 50, title: `Unresolved ${i}`, slug: `unresolved-${i}`, event_slug: `unresolved-${i}`, outcome: 'Yes', outcome_index: 0, updated_at: T0 });
  }
  upsertClosedPositions('w1', closedRows, T0);
  replacePositions('w1', openRows, T0);

  const built = rebuildPredictions('w1', { now: T0 });
  eq(built.rows, 128, '128 market-level predictions built (100 settled + 18 held-open + 10 exited-before-resolution), NOT 400+ from raw fills');

  const stats = computePredictionStats('w1', { now: T0, periods: {} });
  eq(stats.primary.analyzed, 100, 'the 100-window is fully populated');
  eq(stats.primary.wins, 63, '63 wins');
  eq(stats.primary.losses, 37, '37 losses');
  near(stats.primary.winRate, 0.63, 'displayed win rate = 63%');
  eq(stats.exclusions.openPositions, 18, '18 open/unresolved positions reported as excluded');
  eq(stats.primary.excluded, 10, '10 exited-before-resolution records inside the scan are excluded, not counted as losses');
  eq(stats.primary.scanned, 110, '110 completed records scanned to fill a 100-prediction window (shown, not hidden)');
  eq(stats.totals.completed, 110, 'completed = settled + exited-before-resolution (open positions are separate)');
  eq(stats.totals.undetermined, 10, '…and those 10 are the undetermined ones');
  eq(stats.windows['10'].analyzed, 10, 'last-10 window present');
  eq(stats.windows['250'].analyzed, 100, 'last-250 window only finds 100 ⇒ limited');
  eq(stats.windows['250'].limited, true, '…and says so');
  ok(stats.windows.all.winRate === stats.primary.winRate, 'all-time equals the 100 window when exactly 100 exist (same engine)');
  eq(stats.primary.label.includes('100'), true, 'label states the sample size');

  // The bug this whole change fixes: P&L says everyone won.
  const profit = profitabilityFromClosedPositions('w1');
  eq(profit.rate, 1, 'profitability cross-check would (wrongly) report 100%');
  ok(profit.rate !== stats.primary.winRate, 'independently calculated win rate differs from the profitability number');

  // window summary used by the detail page
  const sum = windowSummary('w1', 'all');
  near(sum.win.winRate, 0.63, 'period summary uses the prediction engine');
  eq(sum.win.basis, 'prediction', 'summary labels its basis');
  eq(sum.win.completedInWindow, 110, '…and shows how many completed records were scanned');
  ok(typeof sum.profitability.rate === 'number' && sum.profitability.rate === 1, 'profitability is exposed as its own separate metric');

  const dash = computeDashboardStats('w1');
  near(dash.winRateAll, 0.63, 'dashboard convenience field = prediction rate');
  near(dash.predictions.primary.winRate, 0.63, 'dashboard prediction block = same number');
  eq(dash.predictions.windows['50'].analyzed, 50, 'dashboard exposes every window');

  // every displayed record is auditable
  const audit = db.prepare(`SELECT result, market_name, predicted_outcome, final_outcome, completed_at, source_transactions FROM predictions WHERE wallet = 'w1' AND result = 'WIN' ORDER BY completed_at DESC LIMIT 1`).get();
  ok(!!audit.market_name && !!audit.predicted_outcome && !!audit.final_outcome, 'audit rows carry date/market/prediction/final outcome/result');
  ok(audit.predicted_outcome === 'YES' && audit.final_outcome === 'YES', 'WIN row shows the held side matched the resolution');
}

// --------------------------------------------------------------------------
head('7. Small / empty / edge wallets');
// --------------------------------------------------------------------------
{
  db.prepare('DELETE FROM closed_positions WHERE wallet = ?').run('w1');
  db.prepare('DELETE FROM positions WHERE wallet = ?').run('w1');
  const empty = rebuildPredictions('w1', { now: T0 });
  eq(empty.rows, 0, 'no positions ⇒ no predictions');
  const stats = computePredictionStats('w1', { now: T0, periods: {} });
  eq(stats.primary.winRate, null, 'win rate is N/A (not 0%, not 100%) with no completed predictions');
  eq(stats.totals.completed, 0, 'analyzed count is honestly zero');
  const win = winStatsForWindow('w1', '24h');
  eq(win.winRate, null, 'period win rate also N/A');
  ok(/no completed/i.test(win.basisLabel), 'and it explains why');
}
{
  // one tiny wallet: 1 win out of 1 ⇒ 100% *with* sample size 1/1
  upsertClosedPositions('w1', [{ wallet: 'w1', asset: 'solo', condition_id: '0xsolo', avg_price: 0.4, total_bought: 10, realized_pnl: 15, cur_price: 1, ts: T0, title: 'Solo', slug: 'solo', event_slug: 'solo', outcome: 'Yes', outcome_index: 0, updated_at: T0 }], T0);
  db.prepare(`INSERT INTO market_resolutions (condition_id, market_state, closed, resolved, winning_index, winning_outcome, closed_at, source, attempts, last_attempt_at, fetched_at)
    VALUES ('0xsolo','resolved',1,1,0,'Yes',?,'clob',1,?,?) ON CONFLICT(condition_id) DO UPDATE SET market_state='resolved', resolved=1, winning_index=0`).run(T0 + 1, T0, T0);
  rebuildPredictions('w1', { now: T0 });
  const s = computePredictionStats('w1', { now: T0, periods: {} });
  eq(s.primary.winRate, 1, '1/1 ⇒ 100%');
  eq(`${s.primary.wins}/${s.primary.analyzed}`, '1/1', 'sample size 1/1 travels with it');
  eq(s.primary.limited, true, '…and the window is flagged as limited');
}
{
  // delete cascade: removing the wallet must not leave orphan predictions behind
  db.prepare('DELETE FROM wallets WHERE id = ?').run('w1');
  eq(db.prepare(`SELECT COUNT(*) c FROM predictions WHERE wallet = 'w1'`).get().c, 0, 'deleting a trader deletes its predictions (no orphans)');
  eq(db.prepare(`SELECT COUNT(*) c FROM closed_positions WHERE wallet = 'w1'`).get().c, 0, '…and its closed positions');
  ok(db.prepare(`SELECT COUNT(*) c FROM market_resolutions`).get().c > 0, 'shared market resolutions stay cached for other traders');
}

head('resolution persistence (a rejected write once left every market “unresolved”)');
{
  const { upsertMarketResolution, getResolution, resolutionView } = await import('../server/db.js');
  // exactly what normalizeClobMarket produces: booleans and an array of outcomes
  upsertMarketResolution({
    condition_id: '0xbind', slug: 'bind-test', question: 'q', market_state: 'resolved',
    closed: true, resolved: true, winning_index: 1, winning_outcome: 'NO', winning_token: 'tok-no',
    outcomes: [{ index: 0, outcome: 'YES', token_id: 'tok-yes', price: 0, winner: false },
               { index: 1, outcome: 'NO', token_id: 'tok-no', price: 1, winner: true }],
    closed_at: null, source: 'clob', reason: null, attempts: 3, last_attempt_at: T0, fetched_at: T0,
  });
  const row = getResolution('0xbind');
  eq(row.resolved, 1, 'boolean flags are stored as 0/1 instead of throwing');
  eq(row.closed, 1, '…for closed too');
  eq(row.winning_index, 1, 'winning outcome index survives the round trip');
  eq(row.winning_outcome, 'NO', 'winning outcome label survives');
  eq(resolutionView('0xbind').outcomes.length, 2, 'the outcome list is readable again');
  eq(resolutionView('0xbind').outcomes[1].winner, true, '…including the winner flag');
  // an unresolved market must never look resolved after a re-write
  upsertMarketResolution({ condition_id: '0xbind', market_state: 'open', closed: false, resolved: false, attempts: 4, last_attempt_at: T0, fetched_at: T0, reason: 'market still open' });
  eq(getResolution('0xbind').resolved, 0, 'a later “still open” observation overwrites cleanly');
  ok(getResolution('0xbind').reason === 'market still open', '…and records why');
}

head('upstream request builders (a broken URL silently starves the win-rate inputs)');
{
  const pm = await import('../server/polymarketService.js');
  const sampleArgs = {
    positionsUrl: ['0xabc', { limit: 500, offset: 0, sortBy: 'CURRENT', sortDirection: 'DESC' }],
    closedPositionsUrl: ['0xabc', { limit: 500, offset: 500 }],
    marketResolutionUrl: ['0xcond'],
    marketResolutionFallbackUrl: ['some-slug'],
    tradesUrl: ['0xabc', { limit: 500, offset: 0 }],
    activityUrl: ['0xabc', { limit: 500, offset: 0 }],
  };
  for (const [name, args] of Object.entries(sampleArgs)) {
    if (typeof pm[name] !== 'function') continue;
    let url = '';
    try { url = pm[name](...args); } catch (err) { ok(false, `${name}() throws`, err.message); continue; }
    ok(typeof url === 'string' && /^https?:\/\//.test(url), `${name}() returns an absolute URL`, url);
    ok(!url.includes('?0='), `${name}() does not serialise its base URL as query params`, url.slice(0, 90));
    ok(!url.includes('%3A%2F%2F'), `${name}() leaves "://" intact`, url.slice(0, 90));
  }
  // the exact params the prediction engine depends on
  const pos = new URL(pm.positionsUrl('0xabc', { limit: 500, offset: 0, redeemable: true }));
  eq(pos.searchParams.get('redeemable'), 'true', 'positions request asks for redeemable (settled-but-unredeemed) positions');
  eq(pos.searchParams.get('user'), '0xabc', 'positions request carries the wallet');
  const cl = new URL(pm.closedPositionsUrl('0xabc', { limit: 500, offset: 0 }));
  eq(cl.searchParams.get('sortBy'), 'TIMESTAMP', 'closed positions are explicitly sorted…');
  eq(cl.searchParams.get('sortDirection'), 'DESC', '…newest first (the endpoint defaults to oldest)');
  const tr = new URL(pm.tradesUrl ? pm.tradesUrl('0xabc', { takerOnly: false }) : 'http://x/?takerOnly=false');
  if (pm.tradesUrl) eq(tr.searchParams.get('takerOnly'), 'false', 'trade history includes maker fills (takerOnly=false)');
}

console.log(`\n${fail ? '\u001b[31m' : '\u001b[32m'}${pass} passed, ${fail} failed\u001b[0m`);
process.exit(fail ? 1 : 0);
