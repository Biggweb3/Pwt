/**
 * End-to-end test of the serverless (Vercel) API entrypoint.
 *
 *   node scripts/e2e-serverless.mjs <entryFile> [port] [--mock] [--keep]
 *
 * <entryFile>  the function module whose default export is the Express app
 *              (api/index.js for a repo-root Vercel project, or the prebuilt
 *              client/api/index.js bundle for a client-root project).
 * --mock       point the server at scripts/mock-polymarket.mjs (must be
 *              started separately: `node scripts/mock-polymarket.mjs 3200`).
 *              Without --mock the REAL public Polymarket APIs are used and
 *              the trader under test is taken from the live leaderboard.
 *
 * The harness emulates how Vercel invokes the function (plain Node HTTP
 * handler, VERCEL=1, ephemeral DATA_DIR under /tmp) and asserts the whole
 * add-trader → sync → query → delete flow.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const entry = path.resolve(root, args.shift() || 'api/index.js');
const port = Number(args.find((a) => /^\d+$/.test(a)) || 3300);
const useMock = args.includes('--mock');
const keep = args.includes('--keep');
const serveOnly = args.includes('--serve-only');

process.env.VERCEL = '1';
process.env.DATA_DIR = process.env.DATA_DIR || `/tmp/pwt-e2e-${Date.now()}`;
if (useMock) {
  const mock = 'http://127.0.0.1:3200';
  process.env.POLYMARKET_DATA_API = mock;
  process.env.POLYMARKET_GAMMA_API = mock;
  process.env.POLYMARKET_LB_API = mock;
  // market resolutions (WIN/LOSS authority) come from the same mock
  process.env.POLYMARKET_CLOB_API = mock;
  process.env.RESOLUTION_LOOKUPS_INITIAL = '4000';
  process.env.RESOLUTION_LOOKUPS_PER_CYCLE = '4000';
}
const DATA_API = process.env.POLYMARKET_DATA_API || 'https://data-api.polymarket.com';

const { default: handler } = await import(pathToFileURL(entry).href);
const server = http.createServer(handler);
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}`;

if (serveOnly) { // helper mode for the cold-start simulation below
  console.log('[e2e-serve] READY');
  await new Promise(() => {}); // park forever — nothing after this runs
}

let passed = 0; let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; console.error(`  ✘ ${label} ${extra}`); }
};

async function req(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n[e2e] entry=${path.relative(root, entry)}  mode=${useMock ? 'mock-upstream' : 'REAL polymarket'}  db=${process.env.DATA_DIR}\n`);

try {
  // ---------------------------------------------------------------- system
  {
    const r = await req('GET', '/api/system');
    ok(r.status === 200, `GET /api/system → 200 (${r.status})`);
    ok(r.json?.deployment === 'serverless', `deployment === 'serverless' (${r.json?.deployment})`);
    ok(r.json?.upstreamOk === true, `upstream reachable (${r.json?.upstreamOk})`);
  }

  // ------------------------------------------------------- pick the trader
  let traderInput; let traderName;
  if (useMock) {
    traderInput = '0xb1ca909e848cc24ec4e220ce1c453bc290c51705';
    traderName = 'mock fixture wallet';
  } else {
    const lb = await req('GET', `${DATA_API}/v1/leaderboard?period=1d&limit=10`);
    const rows = Array.isArray(lb.json) ? lb.json : [];
    ok(rows.length > 0, `live leaderboard returned rows (${rows.length})`);
    const top = rows.find((r) => r.proxyWallet) || rows[0];
    traderInput = String(top.proxyWallet);
    traderName = `${top.userName || top.name || 'unnamed'} (pnl ${top.pnl}, vol ${Number(top.vol).toLocaleString()})`;
  }
  console.log(`\n[e2e] adding public leaderboard trader: ${traderName} ${traderInput}\n`);

  // ------------------------------------------------------------ add trader
  let address = null;
  {
    const r = await req('POST', '/api/wallets', { input: `https://polymarket.com/profile/${traderInput}` });
    ok(r.status === 201, `POST /api/wallets → 201 (${r.status}) ${r.status !== 201 ? JSON.stringify(r.json).slice(0, 200) : ''}`);
    address = r.json?.wallet?.address;
    ok(!!address, `wallet accepted: ${address}`);
  }
  {
    const dup = await req('POST', '/api/wallets', { input: traderInput });
    ok(dup.status === 409, `duplicate add rejected with 409 (${dup.status})`);
  }

  // -------------------------------------------------- converge to live state
  let wallet = null;
  for (let i = 0; i < (useMock ? 5 : 30); i++) {
    const r = await req('GET', '/api/wallets');
    wallet = (r.json || []).find((w) => w.address === address);
    if (wallet?.status === 'live' || wallet?.status === 'error') break;
    await req('POST', '/api/sync', {});
    await wait(1000);
  }
  ok(wallet?.status === 'live', `wallet status converged to live (${wallet?.status}${wallet?.lastError ? ': ' + wallet.lastError : ''})`);

  // ------------------------------------------------------------- read paths
  {
    const r = await req('GET', `/api/wallets/${address}`);
    ok(r.status === 200 && !!r.json?.overview, `GET /api/wallets/:addr overview (${r.status})`);
    const t = await req('GET', `/api/wallets/${address}/trades?pageSize=10`);
    ok(t.status === 200 && t.json?.total > 0, `GET trades paginated, total=${t.json?.total}`);
    const p = await req('GET', `/api/wallets/${address}/positions`);
    ok(p.status === 200 && Array.isArray(p.json?.positions), `GET positions (${p.status}, ${p.json?.positions?.length} rows)`);
    const a = await req('GET', `/api/wallets/${address}/activity?limit=20`);
    ok(a.status === 200 && Array.isArray(a.json?.activity), `GET activity (${a.status}, ${a.json?.activity?.length} rows)`);
    const c = await req('GET', `/api/wallets/${address}/chart?period=all`);
    ok(c.status === 200 && Array.isArray(c.json?.points), `GET chart (${c.status}, ${c.json?.points?.length} points)`);
    const s = await req('GET', `/api/wallets/${address}/summary/24h`);
    ok(s.status === 200, `GET summary/24h (${s.status})`);
    const f = await req('GET', '/api/feed/global?limit=10');
    ok(f.status === 200 && f.json?.feed?.length > 0, `GET global feed (${f.status}, ${f.json?.feed?.length} items)`);
    const cmp = await req('GET', '/api/compare');
    ok(cmp.status === 200 && cmp.json?.rows?.length === 1, `GET compare rows (${cmp.status})`);
    const sugg = await req('GET', '/api/suggestions');
    ok(sugg.status === 200, `GET suggestions (${s.status})`);
    const srch = await req('GET', `/api/search?q=${address.slice(0, 8)}`);
    ok(srch.status === 200 && srch.json?.traders?.length > 0, `GET search finds trader (${srch.status})`);
  }

  // ------------------------------------- win rate inside a serverless request
  // The synthetic mock wallet has a KNOWN answer (63 wins / 37 losses over its most
  // recent 100 completed predictions), so this proves the whole engine works in the
  // deployment Vercel actually runs — where there is no background poller.
  if (useMock) {
    console.log('\n[e2e] serverless win-rate engine (ground-truth wallet)…');
    const marla = `0x${'a'.repeat(39)}1`;
    const add = await req('POST', '/api/wallets', { input: `https://polymarket.com/profile/${marla}` });
    ok(add.status === 201, `ground-truth trader added (${add.status})`);
    let wr = null;
    for (let i = 0; i < 10; i++) {
      wr = await req('GET', `/api/wallets/${marla}/win-rate`);
      if ((wr.json?.stats?.primary?.analyzed ?? 0) >= 100) break;
      await req('POST', '/api/sync', {});
      await wait(800);
    }
    const prim = wr.json?.stats?.primary;
    ok(prim?.analyzed === 100, `100 completed predictions classified (${prim?.analyzed})`);
    ok(prim?.wins === 63 && prim?.losses === 37, `63W / 37L from market resolutions (${prim?.wins}W/${prim?.losses}L)`);
    ok(prim?.winRate === 0.63, `win rate is exactly 63% (${prim?.winRate})`);
    ok(wr.json?.methodology?.tooltip?.startsWith('Win rate is independently calculated'), 'methodology + tooltip shipped with the payload');
    ok(wr.json?.comparison?.profitabilityCrossCheck?.rate === 1 && prim?.winRate === 0.63, 'profitability (100%) kept separate from accuracy (63%)');
    ok(wr.json?.comparison?.polymarketReported?.winRate === null, 'no fabricated Polymarket-reported win rate');
    ok(wr.json?.stats?.exclusions?.openPositions > 0, `open positions excluded (${wr.json?.stats?.exclusions?.openPositions})`);
    const wins10 = await req('GET', `/api/wallets/${marla}/predictions?window=10&result=WIN`);
    ok(wins10.json?.total === 6, `audit table: 6 wins inside the last-10 window (${wins10.json?.total})`);
    const detail = await req('GET', `/api/wallets/${marla}/predictions/${encodeURIComponent('0xAAAA0003')}`);
    ok(detail.status === 200 && detail.json?.transactions?.length === 8, `audit detail groups 8 fills into one prediction (${detail.json?.transactions?.length})`);
    const cmp2 = await req('GET', '/api/compare');
    const row = (cmp2.json?.rows || []).find((x) => x.address === marla);
    ok(row?.winRate === 0.63 && row?.winRateAnalyzed === 100, 'compare table uses the same engine (63%, n=100)');
    const cached = await req('POST', `/api/wallets/${marla}/predictions/rebuild`, {});
    ok(cached.status === 200 && cached.json?.primary?.winRate === 0.63, `rebuild is stable (${cached.json?.primary?.winRate})`);
    const d2 = await req('DELETE', `/api/wallets/${marla}`);
    ok(d2.status === 200, 'ground-truth trader removed again');
  }

  // --------------------------------------------------- serverless behaviours
  {
    const sync = await req('POST', '/api/sync', {});
    ok(sync.status === 200 && typeof sync.json?.remaining === 'number', `POST /api/sync → 200 (${sync.status})`);
    const sse = await req('GET', '/api/events');
    ok(sse.status === 501, `GET /api/events disabled on serverless (${sse.status})`);
    const bad = await req('GET', '/api/nope');
    ok(bad.status === 404 && bad.json?.error, `unknown api route → JSON 404 (${bad.status})`);
  }

  // ------------------------------------------------- ephemeral-DB re-seed simulation
  if (!keep) {
    // Simulate a serverless cold start: a BRAND-NEW instance (fresh process,
    // blank /tmp database) must accept the same re-seed POST the browser's
    // auto-recovery performs and rebuild everything from public APIs.
    console.log('\n[e2e] simulating cold start (fresh instance, blank database)…');
    const { spawn } = await import('node:child_process');
    const coldPort = port + 1;
    const childEnv = { ...process.env, DATA_DIR: `/tmp/pwt-e2e-cold-${Date.now()}` };
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), entry, String(coldPort), ...(useMock ? ['--mock', '--serve-only'] : ['--serve-only'])], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let ready = false;
      child.stdout.on('data', (d) => { if (String(d).includes('READY')) ready = true; });
      for (let i = 0; i < 60 && !ready; i++) await wait(500);
      ok(ready, 'cold instance started');
      const again = await req('POST', `http://127.0.0.1:${coldPort}/api/wallets`, { input: traderInput });
      ok(again.status === 201, `re-seeding a fresh instance works (${again.status})`);
      let coldWallet = null;
      for (let i = 0; i < (useMock ? 5 : 30); i++) {
        const list = await req('GET', `http://127.0.0.1:${coldPort}/api/wallets`);
        coldWallet = (list.json || []).find((w) => w.address === address);
        if (coldWallet?.status === 'live' || coldWallet?.status === 'error') break;
        await req('POST', `http://127.0.0.1:${coldPort}/api/sync`, {});
        await wait(1000);
      }
      ok(coldWallet?.status === 'live', `cold-start re-seed rebuilt trader to live (${coldWallet?.status})`);
    } finally {
      child.kill('SIGKILL');
    }
  }

  // ----------------------------------------------------------------- cleanup
  {
    const d = await req('DELETE', `/api/wallets/${address}`);
    ok(d.status === 200, `DELETE wallet (${d.status})`);
    const list = await req('GET', '/api/wallets');
    ok(!(list.json || []).some((w) => w.address === address), `wallet removed from list`);
  }
} finally {
  console.log(`\n[e2e] ${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
}
