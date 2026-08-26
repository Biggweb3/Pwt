/**
 * Live-site end-to-end test — run against the production Vercel deployment.
 *
 *   node scripts/e2e-live.mjs <https://your-deployment.vercel.app> [--keep]
 *
 * Verifies the deployed API (the original bug was every /api/* call returning
 * HTTP 404 because only the static frontend was deployed), then adds a real
 * public trader from Polymarket's live leaderboard, verifies the sync
 * pipeline, and cleans up afterwards (unless --keep).
 */
const base = (process.argv[2] || '').replace(/\/+$/, '');
const keep = process.argv.includes('--keep');
if (!base || !base.startsWith('http')) {
  console.error('usage: node scripts/e2e-live.mjs https://<deployment>.vercel.app [--keep]');
  process.exit(2);
}

let passed = 0; let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; console.error(`  ✘ ${label} ${extra}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, timeoutMs = 120_000) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers, location: res.headers.get('location') || '' };
}

// ---------------------------------------------------------------- wait for deploy
console.log(`\n[live] target: ${base}\n`);
let system = null;
for (let i = 0; i < 30; i++) {
  try {
    const r = await req('GET', `${base}/api/system`, null, 15_000);
    if (r.status === 200 && r.json?.deployment) { system = r.json; break; }
    if (r.status === 401 || r.status === 403 || (r.location || '').includes('vercel.com/login')) {
      console.error(`\n[live] BLOCKED: the deployment answered ${r.status} with a Vercel login redirect.`);
      console.error('[live] => Deployment Protection is enabled. In the Vercel dashboard go to:');
      console.error('[live]    Project → Settings → Deployment Protection → set to "Disabled" (or Standard)');
      console.error('[live]    then run this test again.');
      process.exit(1);
    }
    if (r.status === 404) {
      console.error(`\n[live] STILL 404 (${i + 1}/30): the new deployment has not gone live yet, or the API was not deployed.`);
      console.error('[live] Body:', (r.text || '').slice(0, 160));
    }
  } catch (e) {
    console.log(`[live] waiting for deployment… (${e.message})`);
  }
  await wait(10_000);
}
ok(!!system, `GET /api/system reachable (was HTTP 404 before the fix)`);
if (!system) { console.error('\n[live] giving up'); process.exit(1); }
ok(system.deployment === 'serverless', `API runs serverless (${system.deployment})`);
ok(system.upstreamOk === true, `serverless API reaches Polymarket (${system.upstreamOk})`);

// ---------------------------------------------------------------- pick trader
const lb = await req('GET', 'https://data-api.polymarket.com/v1/leaderboard?period=1d&limit=10');
const rows = Array.isArray(lb.json) ? lb.json : [];
ok(rows.length > 0, `public leaderboard responded (${rows.length} rows)`);
const top = rows.find((r) => r.proxyWallet);
const trader = String(top?.proxyWallet || '');
ok(!!trader, `picked public trader: ${top?.userName || 'unnamed'} — https://polymarket.com/profile/${trader}`);

// ------------------------------------------------------------------ add trader
const add = await req('POST', `${base}/api/wallets`, { input: `https://polymarket.com/profile/${trader}` });
ok(add.status === 201, `POST /api/wallets → 201 (got ${add.status}: ${(add.text || '').slice(0, 140)})`);
if (add.status !== 201) process.exit(1);

let wallet = null;
for (let i = 0; i < 40; i++) {
  const list = await req('GET', `${base}/api/wallets`);
  wallet = (Array.isArray(list.json) ? list.json : []).find((w) => w.address === trader);
  if (wallet?.status === 'live' || wallet?.status === 'error') break;
  await req('POST', `${base}/api/sync`, {});
  await wait(3000);
}
ok(wallet?.status === 'live', `trader synced to live on the LIVE site (${wallet?.status}${wallet?.lastError ? ': ' + wallet.lastError : ''})`);
if (wallet?.status === 'live') {
  const t = await req('GET', `${base}/api/wallets/${trader}/trades?pageSize=5`);
  ok(t.status === 200 && t.json?.total > 0, `trade history ingested (${t.json?.total} trades)`);
  const s = await req('GET', `${base}/api/wallets/${trader}`);
  ok(s.status === 200 && !!s.json?.overview, `overview computed (winRateAll=${s.json?.overview?.winRateAll}, openPositions=${s.json?.overview?.activePositions})`);
  console.log(`\n[live] verified on the live site: https://polymarket.com/profile/${trader}`);
}

if (!keep) {
  const d = await req('DELETE', `${base}/api/wallets/${trader}`);
  ok(d.status === 200, `cleanup: removed test trader (${d.status})`);
}

console.log(`\n[live] ${passed} passed, ${failed} failed — ${base}`);
process.exit(failed ? 1 : 0);
