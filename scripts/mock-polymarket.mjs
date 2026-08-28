/**
 * Test utility: a small deterministic mock of the public Polymarket APIs, used to
 * exercise the whole server (sync engine → prediction engine → REST/SSE) without
 * network access, and to assert win-rate maths against a KNOWN ground truth.
 *
 * Wallets (all synthetic except the last, which replays the real captured fixture):
 *   0xAAA…A1  "63/37 Marla"   120 completed predictions: the newest 100 are 63W/37L
 *                             (older 20 are all losses → proves the window is used),
 *                             + 18 open positions, + 6 undetermined markets, and every
 *                             closed position reports POSITIVE realized P&L (so a
 *                             P&L-derived "win rate" would read 100%).
 *   0xBBB…B2  "Small sample"  8 completed predictions, 8W/0L → 100% with a visible
 *                             sample size of 8 (must NOT be padded to 100).
 *   0xCCC…C3  "Fresh account" only open positions → win rate N/A, never 0% or 100%.
 *   0xb1ca…1705 real fixture captures (trades/positions/closed/profile/…).
 *
 *   node scripts/mock-polymarket.mjs [PORT]
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 3200);
const NOW = Math.floor(Date.now() / 1000);

const MARLA = `0x${'a'.repeat(39)}1`;   // 40 hex chars, like a real proxy wallet
const SMALL = `0x${'b'.repeat(39)}2`;
const FRESH = `0x${'c'.repeat(39)}3`;
const REAL = '0xb1ca909e848cc24ec4e220ce1c453bc290c51705';

let fixtures = null;
try {
  fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
} catch { /* fixtures are optional */ }

// ---------------------------------------------------------------------------
// scenario generation
// ---------------------------------------------------------------------------
/**
 * @param {object} spec
 *  wins/losses inside the "recent" block, olderLosses appended after it,
 *  open, undetermined counts, plus the deliberate traps.
 */
function buildWallet(seedKey, spec) {
  const markets = new Map();   // conditionId -> market (for /markets/:id)
  const trades = [];
  const activity = [];
  const positions = [];        // still held
  const closed = [];           // exited (closed-positions endpoint)
  let n = 0;
  const mkMarket = (kind, winIdx, predIdx, extra = {}) => {
    const i = n++;
    const conditionId = `0x${seedKey}${String(i).padStart(4, '0')}`;
    const slug = `mkt-${seedKey}-${i}`;
    const resolved = kind !== 'open' && kind !== 'unresolvable';
    const completedTs = NOW - 3 * 86400 - i * 2 * 3600;
    const market = {
      conditionId, slug,
      question: `Will event #${i} on ${seedKey} resolve YES by Friday?`,
      winningIndex: resolved ? winIdx : null,
      closed: resolved,
      endTs: resolved ? completedTs : null,
      unresolvable: kind === 'unresolvable',
      tokens: [0, 1].map((k) => ({
        token_id: `${conditionId}-t${k}`,
        outcome: k === 0 ? 'YES' : 'NO',
        price: resolved ? (k === winIdx ? 1 : 0) : 0.47 + (i % 7) / 100,
        winner: resolved ? k === winIdx : false,
      })),
    };
    market.predictedIndex = predIdx;
    market.hedged = !!extra.hedge;
    markets.set(conditionId, market);
    const asset = market.tokens[predIdx].token_id;
    const outcome = market.tokens[predIdx].outcome;
    const avgPrice = extra.avgPrice ?? (0.4 + ((i % 9) / 20));
    const fillCount = extra.fills ?? 1;
    let bought = 0;
    for (let f = 0; f < fillCount; f++) {
      const shares = 250 + f * 25 + (i % 5) * 10;
      const ts = completedTs - 4 * 86400 + f * 600;
      bought += shares * avgPrice;
      const trade = {
        proxyWallet: extra.wallet, side: 'BUY', asset, conditionId, size: shares, price: +avgPrice.toFixed(3),
        timestamp: ts, title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`, outcome, outcomeIndex: predIdx,
        transactionHash: `0xtx${seedKey}${i}f${f}`,
      };
      trades.push(trade);
      activity.push({ ...trade, type: 'TRADE', usdcSize: +(shares * avgPrice).toFixed(2) });
    }
    // partial exits create several closed-rows for the SAME asset — the engine must
    // still see one prediction.
    const sells = extra.sells ?? 0;
    let sold = 0;
    for (let s = 0; s < sells; s++) {
      const shares = 60 + s * 10;
      const ts = completedTs - 86400 + s * 300;
      sold += shares;
      const sell = {
        proxyWallet: extra.wallet, side: 'SELL', asset, conditionId, size: shares, price: +(avgPrice + 0.12).toFixed(3),
        timestamp: ts, title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`, outcome, outcomeIndex: predIdx,
        transactionHash: `0xtx${seedKey}${i}s${s}`,
      };
      trades.push(sell);
      activity.push({ ...sell, type: 'TRADE', usdcSize: +(shares * (avgPrice + 0.12)).toFixed(2) });
      closed.push({
        proxyWallet: extra.wallet, asset, conditionId, avgPrice: +avgPrice.toFixed(3), totalBought: +(shares * avgPrice).toFixed(2),
        realizedPnl: +(shares * 0.1).toFixed(2), curPrice: resolved ? (predIdx === winIdx ? 1 : 0) : 0.5,
        title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`, outcome, outcomeIndex: predIdx,
        oppositeOutcome: predIdx === 0 ? 'NO' : 'YES', oppositeAsset: market.tokens[1 - predIdx].token_id,
        endDate: new Date((completedTs) * 1000).toISOString(), timestamp: ts,
      });
    }
    const netShares = bought / avgPrice - sold;
    if (kind === 'open' || kind === 'unresolvable' || extra.hold) {
      market.held = true;
      positions.push({
        proxyWallet: extra.wallet, asset, conditionId, size: +netShares.toFixed(2), avgPrice: +avgPrice.toFixed(3),
        initialValue: +(netShares * avgPrice).toFixed(2), currentValue: +(netShares * (resolved ? (predIdx === winIdx ? 1 : 0) : 0.5)).toFixed(2),
        cashPnl: +(netShares * 0.1).toFixed(2), percentPnl: 12.5, realizedPnl: 0, totalBought: +bought.toFixed(2),
        curPrice: resolved ? (predIdx === winIdx ? 1 : 0) : 0.5,
        redeemable: resolved ? true : false, title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`,
        outcome, outcomeIndex: predIdx, endDate: new Date((completedTs + 86400) * 1000).toISOString(),
      });
      if (resolved) {
        activity.push({
          proxyWallet: extra.wallet, type: 'REDEEM', conditionId, asset, size: +netShares.toFixed(2),
          usdcSize: +(netShares * (predIdx === winIdx ? 1 : 0)).toFixed(2),
          timestamp: completedTs + 900, title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`, outcome, outcomeIndex: predIdx,
          transactionHash: `0xtx${seedKey}${i}r`,
        });
      }
    } else {
      closed.push({
        proxyWallet: extra.wallet, asset, conditionId, avgPrice: +avgPrice.toFixed(3), totalBought: +bought.toFixed(2),
        // TRAP: every settled position claims a positive realized P&L.
        realizedPnl: +(2 + (i % 17)).toFixed(2),
        curPrice: resolved ? (predIdx === winIdx ? 1 : 0) : 0.5,
        title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`, outcome, outcomeIndex: predIdx,
        oppositeOutcome: predIdx === 0 ? 'NO' : 'YES', oppositeAsset: market.tokens[1 - predIdx].token_id,
        endDate: new Date((completedTs) * 1000).toISOString(), timestamp: completedTs,
      });
      activity.push({
        proxyWallet: extra.wallet, type: 'REDEEM', conditionId, asset, size: +(bought / avgPrice).toFixed(2),
        usdcSize: +(bought / avgPrice * (predIdx === winIdx ? 1 : 0)).toFixed(2),
        timestamp: completedTs + 60, title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`,
        outcome, outcomeIndex: predIdx, transactionHash: `0xtx${seedKey}${i}r`,
      });
    }
    // hedged: a second, large position on the opposite token of the same market
    if (extra.hedge) {
      const shares = bought / avgPrice * 0.9;
      const other = market.tokens[1 - predIdx];
      trades.push({
        proxyWallet: extra.wallet, side: 'BUY', asset: other.token_id, conditionId, size: +shares.toFixed(2), price: avgPrice,
        timestamp: completedTs - 3 * 86400, title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`,
        outcome: other.outcome, outcomeIndex: 1 - predIdx, transactionHash: `0xtx${seedKey}${i}h`,
      });
      closed.push({
        proxyWallet: extra.wallet, asset: other.token_id, conditionId, avgPrice: +avgPrice.toFixed(3), totalBought: +(shares * avgPrice).toFixed(2),
        realizedPnl: 1.5, curPrice: resolved ? ((1 - predIdx) === winIdx ? 1 : 0) : 0.5,
        title: market.question, slug, eventSlug: `ev-${seedKey}-${i}`, outcome: other.outcome, outcomeIndex: 1 - predIdx,
        oppositeOutcome: other.outcome === 'YES' ? 'NO' : 'YES', oppositeAsset: asset,
        endDate: new Date(completedTs * 1000).toISOString(), timestamp: completedTs - 60,
      });
    }
    return market;
  };

  // 1) the "most recent 100" block: index 0 == most recent. Exactly `wins` of these
  //    must be WINs so the suite has a known answer, whatever modifiers are applied.
  const total = spec.wins + spec.losses;
  const plan = new Array(total).fill(null);
  // deliberate traps / coverage cases, placed at fixed positions
  const specials = [
    [0, 'W', {}],
    [1, 'L', {}],
    [2, 'W', { holds: true }],            // settled while still held (unredeemed winner)
    [3, 'W', { fills: 8 }],               // 8 fills in one market -> ONE prediction
    [4, 'L', { sells: 3 }],               // 3 partial sells -> ONE prediction, still a LOSS
    [5, 'W', { sells: 1 }],               // exited early, market later resolved in favour
    [6, 'L', { holds: true }],            // unredeemed loser (zero current value)
    [7, 'W', { predIdx: 1 }],             // traded the NO side and won
    [8, 'L', { predIdx: 1 }],             // traded the NO side and lost
    [9, 'W', { avgPrice: 0.05 }],          // 95% longshot hit
    [10, 'L', { avgPrice: 0.95 }],         // 95% favourite missed
  ];
  let wUsed = 0, lUsed = 0;
  for (const [i, result, opt] of specials) {
    if (i >= total) continue;                                                        // no room for this case
    if (result === 'W' ? wUsed >= spec.wins : lUsed >= spec.losses) continue;         // keep the known answer exact
    const predIdx = opt.predIdx ?? (i % 2);
    plan[i] = {
      result, predIdx, winIdx: result === 'W' ? predIdx : 1 - predIdx,
      kind: 'settled',
      extra: { wallet: spec.wallet, fills: opt.fills, sells: opt.sells, hold: opt.holds, avgPrice: opt.avgPrice, hedge: opt.hedge },
    };
    if (result === 'W') wUsed++; else lUsed++;
  }
  const needW = Math.max(0, spec.wins - wUsed);
  const free = plan.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  // exact, deterministic even interleave: precisely `needW` wins, the rest losses.
  free.forEach((idx, k) => {
    const isW = Math.floor(((k + 1) * needW) / free.length) > Math.floor((k * needW) / free.length);
    const predIdx = idx % 2;
    plan[idx] = { result: isW ? 'W' : 'L', predIdx, winIdx: isW ? predIdx : 1 - predIdx, kind: 'settled', extra: { wallet: spec.wallet } };
  });
  const list = plan;

  list.forEach((m) => mkMarket(m.kind, m.winIdx, m.predIdx, m.extra));

  // 2) undetermined / excluded cases
  for (let k = 0; k < spec.undetermined; k++) {
    if (k % 3 === 0) mkMarket('settled', 0, 0, { wallet: spec.wallet, hedge: true });        // hedged both sides
    else if (k % 3 === 1) mkMarket('unresolvable', 0, 0, { wallet: spec.wallet, hold: true }); // no resolution available
    else mkMarket('settled', 0, 0, { wallet: spec.wallet, sells: 1, avgPrice: 0.5 });          // flat 50/50 exit
  }
  // 3) open positions (market unresolved) → excluded from the denominator
  for (let k = 0; k < spec.open; k++) mkMarket('open', null, k % 2, { wallet: spec.wallet, hold: true });
  // 4) older completed losses, outside the 100-window → must not be dropped from
  //    the all-time number, but must not dilute the primary one either
  for (let k = 0; k < spec.olderLosses; k++) mkMarket('settled', 1, 0, { wallet: spec.wallet });

  return { markets, trades, activity, positions, closed };
}

const SCENARIOS = new Map();
function register(address, spec) {
  const name = address.slice(2, 6).toUpperCase();
  const built = buildWallet(name, { ...spec, wallet: address });
  SCENARIOS.set(address.toLowerCase(), { address, ...built, spec });
}
register(MARLA, { wins: 63, losses: 37, undetermined: 6, open: 18, olderLosses: 20, username: 'Sixty-Three Marla' });
register(SMALL, { wins: 8, losses: 0, undetermined: 0, open: 3, olderLosses: 0, username: 'Small Sample Sam' });
register(FRESH, { wins: 0, losses: 0, undetermined: 0, open: 5, olderLosses: 0, username: 'Fresh Fish' });

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------
const send = (res, data, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
};
const pageBy = (rows, u, key = 'timestamp') => {
  const limit = Math.min(Number(u.searchParams.get('limit') || 500), 500);
  const offset = Number(u.searchParams.get('offset') || 0);
  const start = Number(u.searchParams.get('start') || 0);
  const end = Number(u.searchParams.get('end') || 0);
  let out = rows.slice();
  if (start) out = out.filter((r) => r.timestamp >= start);
  if (end) out = out.filter((r) => r.timestamp <= end);
  const dir = (u.searchParams.get('sortDirection') || 'DESC').toUpperCase();
  // /closed-positions sorts ASCENDING unless told otherwise — mirror the real quirk.
  const asc = key === 'closed' ? (u.searchParams.get('sortBy') ? dir === 'ASC' : false) : dir === 'ASC';
  out.sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]));
  return out.slice(offset, offset + limit);
};

function scenarioFor(u) {
  const user = (u.searchParams.get('user') || u.searchParams.get('address') || '').toLowerCase();
  if (SCENARIOS.has(user)) return SCENARIOS.get(user);
  if (fixtures && user === REAL) return { real: true };
  return null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://mock`);
  const sc = scenarioFor(u);
  const p = u.pathname;

  // ---- test-only: ground truth for a wallet, computed from the scenario ----
  const gt = p.match(/^\/scenario\/([^/]+)$/);
  if (gt) {
    const sc2 = SCENARIOS.get(decodeURIComponent(gt[1]).toLowerCase());
    if (!sc2) return send(res, { error: 'no such scenario' }, 404);
    const rows = [...sc2.markets.values()].map((m) => ({
      conditionId: m.conditionId, ts: NOW - 3 * 86400 - Number(m.conditionId.slice(-4)) * 3600 * 2,
      resolved: m.closed, winningIndex: m.winningIndex, predictedIndex: m.predictedIndex,
      unresolvable: !!m.unresolvable, held: !!m.held, hedged: !!m.hedged,
    })).sort((a, b) => b.ts - a.ts);
    const completed = rows.filter((r) => r.resolved);
    const classified = completed.filter((r) => !r.hedged).map((r) => ({ ...r, result: r.predictedIndex === r.winningIndex ? 'W' : 'L' }));
    const recent = classified.slice(0, 100);
    return send(res, {
      address: sc2.address, markets: rows,
      totals: {
        markets: rows.length, completed: completed.length, classified: classified.length,
        open: rows.filter((r) => !r.resolved).length,
        unresolvable: rows.filter((r) => r.unresolvable).length,
        hedged: rows.filter((r) => r.hedged).length,
        resolvedUnclassified: completed.filter((r) => r.hedged).length,
      },
      expected: {
        analyzed: recent.length,
        wins: recent.filter((r) => r.result === 'W').length,
        losses: recent.filter((r) => r.result === 'L').length,
        winRate: recent.length ? recent.filter((r) => r.result === 'W').length / recent.length : null,
        allWins: classified.filter((r) => r.result === 'W').length,
        allAnalyzed: classified.length,
        window10: {
          analyzed: 10,
          wins: classified.slice(0, 10).filter((r) => r.result === 'W').length,
        },
      },
    });
  }

  // ---- resolution authority (CLOB) & gamma fallback ----------------------
  const clobMkt = p.match(/^\/markets\/([^/]+)$/);
  if (clobMkt) {
    const cid = decodeURIComponent(clobMkt[1]);
    for (const s of SCENARIOS.values()) {
      const m = s.markets.get(cid);
      if (!m) continue;
      if (m.unresolvable) return send(res, { error: 'market not found' }, 404);
      return send(res, {
        condition_id: m.conditionId, question: m.question, market_slug: m.slug, closed: m.closed,
        active: !m.closed, accepting_orders: !m.closed, is_50_50_outcome: false, neg_risk: false,
        end_date_iso: m.endTs ? new Date(m.endTs * 1000).toISOString() : null, tokens: m.tokens,
      });
    }
    return send(res, { error: 'unknown market' }, 404);
  }
  const gammaSlug = p.match(/^\/markets\/slug\/([^/]+)$/);
  if (gammaSlug) {
    const slug = decodeURIComponent(gammaSlug[1]);
    for (const s of SCENARIOS.values()) {
      for (const m of s.markets.values()) {
        if (m.slug !== slug) continue;
        return send(res, {
          id: 1000 + slug.length, question: m.question, slug: m.slug, conditionId: m.conditionId, closed: m.closed,
          closedTime: m.endTs ? new Date(m.endTs * 1000).toISOString() : null, umaResolutionStatus: m.closed ? 'resolved' : '',
          outcomes: JSON.stringify(['YES', 'NO']),
          outcomePrices: JSON.stringify(m.closed ? [m.winningIndex === 0 ? 1 : 0, m.winningIndex === 1 ? 1 : 0] : [0.5, 0.5]),
          clobTokenIds: JSON.stringify(m.tokens.map((t) => t.token_id)), archived: false,
        });
      }
    }
    return send(res, { error: 'unknown slug' }, 404);
  }
  if (p === '/public-profile') {
    if (sc?.real) return send(res, fixtures.profile);
    const name = sc ? sc.spec.username : 'unknown';
    return send(res, {
      proxyWallet: u.searchParams.get('address'), name, pseudonym: name?.toLowerCase?.().replace(/\W+/g, '-') || 'anon',
      bio: 'synthetic mock trader for the win-rate test suite', profileImage: null, xUsername: null,
      verifiedBadge: false, displayUsernamePublic: true, createdAt: new Date((NOW - 400 * 86400) * 1000).toISOString(),
    });
  }
  if (p === '/public-search') {
    return send(res, { profiles: [...SCENARIOS.values()].map((s) => ({ proxyWallet: s.address, name: s.spec.username, pseudonym: s.spec.username, bio: '', profileImage: null, verifiedBadge: false })) });
  }
  if (p === '/profit' || p === '/volume') {
    if (sc?.real) return send(res, p === '/profit' ? fixtures.lbProfit : fixtures.lbVolume);
    const w = u.searchParams.get('window');
    const base = p === '/profit' ? 1800 : 42000;
    const mult = w === 'all' ? 30 : w === '30d' ? 8 : w === '7d' ? 2.5 : 1;
    return send(res, [{ proxyWallet: u.searchParams.get('address'), amount: +(base * mult).toFixed(2), value: +(base * mult).toFixed(2) }]);
  }
  if (p === '/traded') return send(res, { traded: sc?.real ? fixtures.traded?.traded ?? 0 : 1200 });
  if (p === '/value') return send(res, sc?.real ? fixtures.value : [{ user: u.searchParams.get('address'), value: 12345.67 }]);
  if (p === '/v1/leaderboard') return send(res, []);

  if (sc?.real) {
    switch (p) {
      case '/trades': return send(res, fixtures.trades);
      case '/activity': return send(res, fixtures.activity);
      case '/positions': return send(res, fixtures.positions);
      case '/closed-positions': return send(res, fixtures.closedPositions);
      default: return send(res, []);
    }
  }
  if (!sc) return send(res, []);

  switch (p) {
    case '/trades': return send(res, pageBy(sc.trades, u));
    case '/activity': return send(res, pageBy(sc.activity, u));
    case '/closed-positions': return send(res, pageBy(sc.closed, u, 'closed'));
    case '/positions': {
      const wantRedeemable = u.searchParams.get('redeemable');
      let rows = sc.positions;
      if (wantRedeemable === 'true') rows = rows.filter((r) => r.redeemable);
      else if (wantRedeemable === 'false') rows = rows.filter((r) => !r.redeemable);
      // the real endpoint orders by current value unless asked otherwise
      const sortBy = (u.searchParams.get('sortBy') || 'CURRENT').toUpperCase();
      const sorted = rows.slice().sort((a, b) => (sortBy === 'CURRENT' ? b.currentValue - a.currentValue : b.timestamp - a.timestamp));
      const limit = Math.min(Number(u.searchParams.get('limit') || 500), 500);
      const offset = Number(u.searchParams.get('offset') || 0);
      return send(res, sorted.slice(offset, offset + limit));
    }
    default: return send(res, []);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-polymarket] on :${PORT}`);
  for (const [addr, s] of SCENARIOS) {
    console.log(`  ${addr}  closed=${s.closed.length} positions=${s.positions.length} trades=${s.trades.length} markets=${s.markets.size} (planned ${s.spec.wins}W/${s.spec.losses}L in the recent window, ${s.spec.open} open, ${s.spec.undetermined} undetermined)`);
  }
  if (fixtures) console.log(`  ${REAL}  real fixtures`);
});
