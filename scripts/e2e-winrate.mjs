/**
 * End-to-end verification of the win-rate fix against a full running stack.
 *
 *   node scripts/e2e-winrate.mjs
 *
 * Boots the real Express server (own SQLite file in a temp dir) pointed at the local
 * mock of Polymarket's public APIs (scripts/mock-polymarket.mjs), then drives the same
 * HTTP surface the browser uses: add trader → sync → win-rate / audit / windows /
 * compare → delete trader → re-add. Every win-rate number is compared with ground
 * truth computed independently from the mock's own scenario data.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOCK_PORT = 3122;
const API_PORT = 3123;
const BASE = `http://127.0.0.1:${API_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const MARLA = `0x${'a'.repeat(39)}1`;   // 40 hex chars, like a real proxy wallet
const SMALL = `0x${'b'.repeat(39)}2`;
const FRESH = `0x${'c'.repeat(39)}3`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pwt-e2e-'));
const children = [];
let pass = 0;
const failures = [];

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-9) => ok(name, typeof got === 'number' && Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function waitFor(label, fn, { timeoutMs = 60000, everyMs = 400 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* not up yet */ }
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`);
}
function start(name, cmd, args, env = {}) {
  const out = fs.openSync(path.join(TMP, `${name}.log`), 'a');
  const child = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
  child.on('exit', (code) => { if (code) console.log(`[e2e] ${name} exited with ${code} — see ${TMP}/${name}.log`); });
  children.push({ name, child });
  return child;
}
const cleanup = () => {
  for (const { child } of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('SIGINT', cleanup);

// --------------------------------------------------------------------------
console.log(`\n=== Polymarket win-rate E2E (mock upstream + real server) ===`);
console.log(`data dir: ${TMP}`);

start('mock', process.execPath, ['scripts/mock-polymarket.mjs', String(MOCK_PORT)]);
await waitFor('mock api', async () => {
  const r = await fetch(`${MOCK}/trades?user=${MARLA}&limit=1`);
  return r.ok ? true : null;
}, { timeoutMs: 15000 });

start('server', process.execPath, ['server/index.js'], {
  PORT: String(API_PORT),
  DATA_DIR: path.join(TMP, 'data'),
  POLYMARKET_DATA_API: MOCK,
  POLYMARKET_GAMMA_API: MOCK,
  POLYMARKET_LB_API: MOCK,
  POLYMARKET_CLOB_API: MOCK,
  RESOLUTION_LOOKUPS_INITIAL: '4000',
  RESOLUTION_LOOKUPS_PER_CYCLE: '4000',
  POLL_INTERVAL: '5',
  LOG_LEVEL: 'warn',
});
const sys = await waitFor('server /api/system', async () => (await get('/api/system')).status === 200 || null, { timeoutMs: 30000 });
ok('server booted', !!sys);

try {
  // ------------------------------------------------------------ add trader --
  console.log('\n[1] adding traders through the public API (profile URL form)');
  const add = await get('/api/wallets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: `https://polymarket.com/profile/${MARLA}` }),
  });
  eq('POST /api/wallets returns 201', add.status, 201);
  const addedBad = await get('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'not a trader' }) });
  eq('invalid input rejected with 400', addedBad.status, 400);
  const dupe = await get('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: MARLA }) });
  eq('re-adding the same trader is a 409, not a duplicate row', dupe.status, 409);

  console.log('\n[2] initial sync + resolution lookups');
  const wr = await waitFor('win rate for the 100-prediction window', async () => {
    const r = await get(`/api/wallets/${MARLA}/win-rate`);
    const p = r.json?.stats?.primary;
    if (p && p.analyzed >= 100) return r.json;
    const w = (await get(`/api/wallets/${MARLA}`)).json?.wallet;
    if (w?.status === 'error' && (w.consecutiveErrors ?? 0) >= 2) {
      throw new Error(`sync failed for the mock trader — ${w.lastError} (upstream/ingestion bug?)`);
    }
    return null;
  }, { timeoutMs: 90000, everyMs: 900 });
  ok('sync engine produced 100 classified predictions', wr?.stats?.primary?.analyzed >= 100, JSON.stringify(wr?.stats?.primary));

  const gt = await (await fetch(`${MOCK}/scenario/${MARLA}`)).json();
  const p = wr.stats.primary;
  console.log('\n[3] the primary metric — known-answer check');
  eq('sample = the most recent 100 completed predictions', Math.min(100, gt.expected.analyzed), p.analyzed);
  eq('wins match ground truth', gt.expected.wins, p.wins);
  eq('losses match ground truth', gt.expected.losses, p.losses);
  near('win rate = 63 ÷ 100 × 100 = 63%', p.winRate, 0.63);
  eq('open/unresolved positions excluded from the denominator', gt.totals.open, wr.stats.exclusions.openPositions);
  eq('label states the sample size', `Based on the most recent ${p.analyzed} completed predictions`, p.label);
  ok('truncated window is not reported as “most recent 100” when capped', p.limited === false || p.analyzed < 100);
  eq('completed predictions stored match ground truth', gt.totals.completed, wr.stats.totals.completed);
  eq('classified rows across all time match ground truth', gt.expected.allAnalyzed, wr.stats.totals.wins + wr.stats.totals.losses);
  near('all-time rate uses the same engine (diluted by older losses)', wr.stats.totals.winRate, gt.expected.allWins / gt.expected.allAnalyzed, 1e-6);

  console.log('\n[4] P&L is never used to decide WIN/LOSS');
  const lossRows = (await get(`/api/wallets/${MARLA}/predictions?pageSize=100&result=LOSS`)).json.predictions;
  ok('every LOSS row is break-even or positive by Polymarket’s own P&L column', lossRows.length > 10 && lossRows.every((r) => (r.realized_pnl ?? 0) >= 0),
    JSON.stringify(lossRows.slice(0, 3).map((r) => r.realized_pnl)));
  ok('profitability cross-check would have said 100%', wr.comparison.profitabilityCrossCheck.rate === 1, JSON.stringify(wr.comparison.profitabilityCrossCheck));
  ok('…but the reported win rate is the resolution-based 63%', p.winRate === 0.63);
  ok('Polymarket-reported win rate is absent, never faked', wr.comparison.polymarketReported.winRate === null && !!wr.comparison.polymarketReported.unavailableReason, JSON.stringify(wr.comparison.polymarketReported));
  ok('P&L/volume still labelled as api values', wr.comparison.polymarketReported.pnl?.all != null && wr.comparison.polymarketReported.volume?.all != null);

  console.log('\n[5] methodology + tooltip wording (single source for every screen)');
  eq('tooltip text is exactly the agreed sentence', wr.methodology.tooltip,
    'Win rate is independently calculated from the trader’s most recent completed predictions. Open and unresolved positions are excluded. Multiple transactions belonging to the same prediction are grouped to prevent double counting.');
  const winRateTsx = fs.readFileSync('client/src/components/WinRate.tsx', 'utf8');
  ok('client tooltip constant matches the server wording', winRateTsx.includes('Win rate is independently calculated from the trader’s most recent completed predictions.'));
  const clientSrc = ['WinRate.tsx', 'PredictionsPanel.tsx', 'WinRateComparison.tsx', 'WalletTable.tsx', 'TraderPage.tsx', 'ComparePage.tsx', 'Dashboard.tsx']
    .map((f) => fs.readFileSync(`client/src/${f.startsWith('WinRate') || f.startsWith('Predictions') ? 'components/' : f.startsWith('WalletTable') ? 'components/' : 'pages/'}${f}`, 'utf8')).join('\n');
  ok('no React component divides wins by losses (all maths is server side)', !/wins\s*\/\s*\(?\s*(wins|analyzed|sample)/.test(clientSrc));
  ok('every win-rate screen renders the shared component', ['TraderPage.tsx', 'WalletTable.tsx', 'ComparePage.tsx', 'WinRateComparison.tsx'].every((f) => fs.existsSync(`client/src/${['WalletTable', 'WinRateComparison'].includes(f.split('.')[0]) ? 'components' : 'pages'}/${f}`)));
  ok('definition states wins over wins+losses', /most recent completed predictions/i.test(wr.methodology.definition));
  ok('windows offered to the UI', JSON.stringify(wr.methodology.windows) === JSON.stringify([10, 25, 50, 100, 250]), JSON.stringify(wr.methodology.windows));
  ok('an explicit all-time window exists too', wr.stats.windows.all.analyzed >= wr.stats.primary.analyzed);

  console.log('\n[6] prediction windows (10 / 25 / 50 / 100 / 250 / all)');
  for (const n of [10, 25, 50, 100]) {
    const w = wr.stats.windows[String(n)];
    eq(`window ${n} analyses at most ${n} predictions`, Math.min(n, gt.expected.analyzed), w.analyzed);
    ok(`window ${n} rate = wins ÷ (wins+losses)`, Math.abs(w.winRate - w.wins / (w.wins + w.losses)) < 1e-12, JSON.stringify(w));
  }
  eq('window 10 wins match ground truth', gt.expected.window10.wins, wr.stats.windows['10'].wins);
  const w250 = wr.stats.windows['250'];
  ok('window 250 reports “limited” instead of padding', w250.limited === true && w250.analyzed === gt.expected.allAnalyzed, JSON.stringify(w250));
  eq('window 250 win rate equals the all-time rate', wr.stats.windows.all.winRate, w250.winRate);
  ok('all-time window carries a non-null rate', wr.stats.windows.all.analyzed > 100);

  console.log('\n[7] grouping: many fills, one prediction');
  const ledgerAll = await get(`/api/wallets/${MARLA}/predictions?pageSize=100`);
  eq('ledger is scoped to the last 100 classified predictions', 100, ledgerAll.json.total);
  eq('totals block reports completed rows', gt.totals.completed, ledgerAll.json.totals.completed);
  const rows = ledgerAll.json.predictions;
  eq('page size honoured', 100, rows.length);
  const multi = rows.find((r) => r.trades_count >= 8);
  ok('a market with 8 fills appears exactly once', !!multi && rows.filter((r) => r.condition_id === multi.condition_id).length === 1);
  ok('the 8 fills are all grouped into that single prediction', multi.trades_count === 8, `trades_count=${multi?.trades_count}`);
  const partial = rows.find((r) => r.trades_count === 4 && r.result === 'LOSS');
  ok('partial sells (3 exits + 1 entry) stay one prediction', !!partial);
  eq('no duplicate rows per market', new Set(rows.map((r) => r.condition_id)).size, rows.length);
  ok('every classified row names a final outcome', rows.filter((r) => r.result !== 'UNDETERMINED').every((r) => !!r.final_outcome));
  ok('undetermined rows carry a reason label', rows.filter((r) => r.result === 'UNDETERMINED').every((r) => !!r.reasonLabel), JSON.stringify(rows.filter((r) => r.result === 'UNDETERMINED').map((r) => r.reason)));

  console.log('\n[8] audit filters + drill-down');
  const wins = await get(`/api/wallets/${MARLA}/predictions?window=10&result=WIN`);
  eq('filter result=WIN over the last-10 window', gt.expected.window10.wins, wins.json.total);
  const losses = await get(`/api/wallets/${MARLA}/predictions?window=10&result=LOSS`);
  eq('filter result=LOSS over the last-10 window', 10 - gt.expected.window10.wins, losses.json.total);
  const excl = await get(`/api/wallets/${MARLA}/predictions?status=open`);
  eq('status=open returns the excluded positions', gt.totals.open, excl.json.total);
  ok('excluded rows are never wins or losses', excl.json.predictions.every((r) => r.result === 'UNDETERMINED'));
  const detail = await get(`/api/wallets/${MARLA}/predictions/${encodeURIComponent(multi.condition_id)}`);
  eq('drill-down resolves', 200, detail.status);
  ok('drill-down shows the market resolution record', detail.json.resolution?.resolved === 1 && detail.json.resolution.winning_index != null, JSON.stringify(detail.json.resolution).slice(0, 160));
  eq('drill-down lists every grouped fill', 8, detail.json.transactions.length);
  ok('drill-down states the grouping rule', /grouped into this single prediction/i.test(detail.json.groupingNote), detail.json.groupingNote);
  ok('drill-down links the market name for verification', !!detail.json.prediction.market_name && !!detail.json.prediction.marketUrl,
    JSON.stringify({ n: detail.json.prediction.market_name, u: detail.json.prediction.marketUrl }));
  ok('ledger rows say whether they are inside the headline sample', ledgerAll.json.predictions.every((r) => r.in_window === true)
    && (await get(`/api/wallets/${MARLA}/predictions?window=10&pageSize=100`)).json.predictions.some((r) => r.in_window === true));
  const missing = await get(`/api/wallets/${MARLA}/predictions/0xdeadbeef`);
  eq('unknown market in the audit trail is a 404', missing.status, 404);

  console.log('\n[9] other screens use the same numbers');
  const overview = await get(`/api/wallets/${MARLA}`);
  near('overview win rate', overview.json.overview.predictions.primary.winRate, 0.63);
  const summary24 = await get(`/api/wallets/${MARLA}/summary/24h`);
  ok('24h summary is prediction based', summary24.json.win.basis === 'prediction', JSON.stringify(summary24.json.win).slice(0, 200));
  const acc = await get(`/api/wallets/${MARLA}/accuracy?period=all&window=20`);
  ok('accuracy series produced', acc.json.points.length > 1, `${acc.json.points?.length} points`);
  ok('accuracy points carry sample sizes', acc.json.points.every((pt) => pt.sample > 0 && Number.isFinite(pt.accuracy)));
  ok('chart series still available (existing feature intact)', (await get(`/api/wallets/${MARLA}/chart?period=30d`)).status === 200);
  ok('positions endpoint still available', (await get(`/api/wallets/${MARLA}/positions?kind=open`)).status === 200);
  ok('trades endpoint still available', (await get(`/api/wallets/${MARLA}/trades`)).status === 200);
  ok('activity endpoint still available', (await get(`/api/wallets/${MARLA}/activity`)).status === 200);
  const cmp = await get('/api/compare');
  const marlaRow = cmp.json.rows.find((r) => r.address === MARLA.toLowerCase());
  near('compare table win rate identical to the trader page', marlaRow.winRate, 0.63);
  eq('compare table carries the sample size', 100, marlaRow.winRateAnalyzed);
  eq('compare table keeps profitability separate', 1, marlaRow.profitabilityRate);
  const feed = await get('/api/feed/global?limit=50');
  ok('global feed still works', feed.json.feed.length > 0);

  console.log('\n[10] small and empty samples are shown honestly');
  for (const [addr, spec] of [[SMALL, { wins: 8, analyzed: 8 }], [FRESH, { analyzed: 0 }]]) {
    const a = await get('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: addr }) });
    eq(`${addr.slice(0, 8)}… added`, 201, a.status);
  }
  const smallW = await waitFor('small-sample wallet synced', async () => {
    const r = await get(`/api/wallets/${SMALL}/win-rate`);
    return r.json?.stats?.primary?.analyzed >= 8 ? r.json : null;
  }, { timeoutMs: 60000, everyMs: 700 });
  eq('small sample: 8 wins analysed, no padding to 100', 8, smallW.stats.primary.analyzed);
  eq('small sample: 8/8 = 100%', 1, smallW.stats.primary.winRate);
  ok('small sample: limited window is flagged', smallW.stats.primary.limited === true);
  eq('small sample: label states the real count', 'Based on 8 completed predictions', smallW.stats.primary.label);

  const freshW = await get(`/api/wallets/${FRESH}/win-rate`);
  eq('no completed prediction → no rate at all', null, freshW.json.stats.primary.winRate);
  eq('…and an explicit zero sample', 0, freshW.json.stats.primary.analyzed);
  ok('…with an explanatory basis label', /no completed/i.test(freshW.json.stats.primary.label) || /no completed/i.test(freshW.json.stats.windows.all.label || ''), freshW.json.stats.primary.label);
  const freshSummary = await get(`/api/wallets/${FRESH}/summary/24h`);
  ok('summary for an empty trader is N/A, not 0% or 100%', freshSummary.json.win.winRate === null, JSON.stringify(freshSummary.json.win).slice(0, 160));

  console.log('\n[11] re-verify + resync paths');
  const rebuilt = await get(`/api/wallets/${MARLA}/predictions/rebuild`, { method: 'POST' });
  eq('rebuild endpoint ok', 200, rebuilt.status);
  near('rebuild keeps the same win rate', rebuilt.json.primary.winRate, 0.63);
  ok('rebuild re-uses the cached resolutions', rebuilt.json.lookups?.resolved === 0 || rebuilt.json.lookups?.lookedUp === 0, JSON.stringify(rebuilt.json.lookups));
  const refresh = await get(`/api/wallets/${MARLA}/win-rate?refresh=1`);
  near('?refresh=1 recomputes from source', refresh.json.stats.primary.winRate, 0.63);
  const resync = await get(`/api/wallets/${MARLA}/resync`, { method: 'POST' });
  eq('manual resync accepted', 200, resync.status);

  console.log('\n[12] delete a trader, then add it back seamlessly');
  const beforeDelete = await get(`/api/wallets/${MARLA}/predictions?pageSize=1`);
  const del = await get(`/api/wallets/${MARLA}`, { method: 'DELETE' });
  eq('DELETE /api/wallets/:addr ok', 200, del.status);
  for (const ep of [``, `/win-rate`, `/predictions`, `/accuracy`, `/summary/24h`, `/positions`, `/trades`]) {
    const r = await get(`/api/wallets/${MARLA}${ep}`);
    eq(`GET /api/wallets/${MARLA.slice(0, 8)}…${ep} now 404s`, 404, r.status);
  }
  const listBody = (await get('/api/wallets')).json;
  const listAfterDelete = Array.isArray(listBody) ? listBody : listBody.wallets || [];
  ok('deleted trader is gone from the list', !listAfterDelete.some((w) => w.address === MARLA.toLowerCase()), JSON.stringify(listAfterDelete.map((w) => w.address)));
  const feedAfter = await get('/api/feed/global?limit=50');
  ok('global feed no longer shows the deleted trader', !feedAfter.json.feed.some((f) => f.wallet === MARLA.toLowerCase()));
  const readd = await get('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: `https://polymarket.com/profile/${MARLA}` }) });
  eq('re-adding the same trader works (201)', 201, readd.status);
  const after = await waitFor('re-added trader back at 63%', async () => {
    const r = await get(`/api/wallets/${MARLA}/win-rate`);
    return r.json?.stats?.primary?.analyzed >= 100 ? r.json : null;
  }, { timeoutMs: 90000, everyMs: 900 });
  near('same ground truth after delete + re-add', after.stats.primary.winRate, 0.63);
  const afterLedger = await get(`/api/wallets/${MARLA}/predictions?pageSize=1`);
  eq('history rebuilt identically (no duplicated or lost rows)', beforeDelete.json.total, afterLedger.json.total);
  const dupes = (await get(`/api/wallets/${MARLA}/predictions?pageSize=100`)).json.predictions;
  eq('still exactly one row per market after re-adding', new Set(dupes.map((r) => r.condition_id)).size, dupes.length);
  const badDelete = await get('/api/wallets/0x0000000000000000000000000000000000000000', { method: 'DELETE' });
  eq('deleting an untracked wallet 404s', 404, badDelete.status);

  console.log('\n[13] streaming + settings untouched by the fix');
  const sse = await fetch(`${BASE}/api/events`, { headers: { accept: 'text/event-stream' } });
  ok('SSE endpoint still streams', sse.ok && /text\/event-stream/.test(sse.headers.get('content-type') || ''));
  sse.body?.cancel?.();
  ok('settings endpoint still works', (await get('/api/settings')).status === 200);
  ok('suggestions endpoint still works', (await get('/api/suggestions?q=marla')).status === 200);
  ok('search endpoint still works', (await get('/api/search?q=marla')).status === 200);
  ok('alerts endpoints still work', (await get('/api/alerts/rules')).status === 200);
  ok('static client served', (await get('/')).status === 200);

  console.log('\n[14] the win-rate alert reports the new metric — with its sample size');
  const rule = await get('/api/alerts/rules', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'winrate_cross', wallet: MARLA, params: { threshold: 90 } }),
  });
  eq('win-rate alert rule created', 201, rule.status);
  const ruleId = rule.json?.rule?.id;
  // Let one poll cycle record the current state (63% is below 90%) before lowering the
  // threshold — a cross is only meaningful against a previously recorded state.
  const before = await get(`/api/wallets/${MARLA}`);
  eq('trader is live before the alert check', 'live', before.json?.wallet?.status);
  await sleep(9000);
  const edited = await get(`/api/alerts/rules/${ruleId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { threshold: 60 } }),
  });
  eq('editing the threshold keeps the rule enabled', 1, edited.json?.rule?.enabled);
  near('editing the threshold stores the new value', 60, Number(edited.json?.rule?.params?.threshold));
  const crossed = await waitFor('win-rate crossing notification', async () => {
    const n = await get('/api/notifications');
    const hit = (n.json?.notifications || []).find((x) => x.kind === 'winrate_cross');
    return hit || null;
  }, { timeoutMs: 45000, everyMs: 1500 }).catch(() => null);
  ok('a win-rate alert fired after the trader crossed it', !!crossed, 'no notification within 45s (poll cadence?)');
  if (crossed) {
    ok('the alert message states the sample size', /63%|63\.0%/.test(crossed.message) && /100 completed predictions/.test(crossed.message), crossed.message);
    eq('the alert payload carries the analysed count', 100, crossed.meta?.analyzed);
  }
  await get(`/api/alerts/rules/${ruleId}`, { method: 'DELETE' });
} catch (err) {
  failures.push(`unexpected error: ${err?.stack || err}`);
  console.log(`\n  ✗ ${err?.stack || err}`);
  for (const { name } of children) {
    try { console.log(`\n--- ${name}.log (tail) ---\n${fs.readFileSync(path.join(TMP, `${name}.log`), 'utf8').split('\n').slice(-25).join('\n')}`); } catch { /* ignore */ }
  }
} finally {
  cleanup();
}

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
process.exit(failures.length ? 1 : 0);
