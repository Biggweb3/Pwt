/**
 * Browser-based live-site test runner (served from the sandbox preview).
 *
 *   node scripts/live-runner.mjs [port]
 *
 * Serves a static page that runs IN THE USER'S BROWSER (which has normal
 * internet access) and performs the live deployment test:
 *   1. reads Polymarket's public leaderboard (CORS-enabled public API),
 *   2. adds the chosen public trader to the LIVE Vercel site with a classic
 *      form POST (no CORS preflight needed; the API accepts urlencoded),
 *   3. triggers a sync pass.
 * Results are then visible on the live dashboard itself (and verifiable via
 * plain GETs once Deployment Protection allows anonymous reads).
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8080);

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PolyIntel — live site test runner</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b0e14; color:#cbd5e1; margin:0; padding:24px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 18px; color:#f1f5f9; letter-spacing:.02em;}
  h1 b { color:#22d3ee; }
  p,li,button,input { font-size: 13px; }
  input[type=url] { width: 100%; box-sizing:border-box; padding:8px 10px; background:#111827; border:1px solid #334155; border-radius:6px; color:#e2e8f0; }
  button { background:rgba(34,211,238,.12); border:1px solid rgba(34,211,238,.45); color:#22d3ee; border-radius:6px; padding:6px 12px; cursor:pointer; font-weight:600; margin-top:8px; }
  button:hover { background:rgba(34,211,238,.22); }
  button:disabled { opacity:.4; cursor:default; }
  .row { display:flex; align-items:center; gap:10px; padding:8px; border:1px solid #1f2937; border-radius:8px; margin-top:8px; background:#0f1522;}
  .row .who { flex:1; }
  .muted { color:#64748b; }
  .ok { color:#34d399; }
  .err { color:#f87171; }
  pre { background:#0f1522; border:1px solid #1f2937; padding:10px; border-radius:8px; overflow:auto; font-size:12px; max-height: 240px;}
  .step { color:#94a3b8; margin-top:20px;}
  .step b { color:#e2e8f0; }
</style></head><body><div class="wrap">
<h1><b>POLYMARKET INTEL</b> — live deployment test</h1>
<p class="muted">This page runs in <b>your browser</b> and performs the add-trader flow against the live Vercel site —
the same flow that returned <code>HTTP 404</code> before the fix. Nothing is installed and only public data is touched.</p>

<label class="step"><b>1 · Live site</b> — your deployment URL</label>
<input id="base" type="url" value="https://polyintel-theweb3profs-projects.vercel.app"/>
<button id="ping">Check API status</button> <span id="pingOut" class="muted"></span>

<div class="step"><b>2 · Public leaderboard</b> — pick a trader from Polymarket's live leaderboard</div>
<button id="lb">Load today's top traders</button>
<div id="traders"></div>

<div class="step"><b>3 · Verify</b></div>
<p class="muted">After adding, open <a id="siteLink" style="color:#22d3ee" href="#" target="_blank" rel="noreferrer">the live dashboard</a> — the trader appears and syncs to <span class="ok">live</span>.
If Vercel Deployment Protection is disabled, the agent can also verify the API responses directly.</p>
<pre id="log">ready.</pre>

<script>
const $ = (id) => document.getElementById(id);
const log = (s, cls) => { $('log').textContent += '\\n' + s; console.log(s); };
const base = () => $('base').value.trim().replace(/\\/+$/, '');

$('ping').onclick = async () => {
  $('pingOut').textContent = ' …';
  try {
    const r = await fetch(base() + '/api/system', { redirect: 'manual' });
    if (r.status === 0 || r.type === 'opaqueredirect') throw new Error('redirected (login wall)');
    const j = await r.json().catch(() => null);
    if (!j) throw new Error('non-JSON response');
    $('pingOut').innerHTML = '<span class="ok">API OK — deployment=' + (j.deployment||'?') + ', upstream=' + j.upstreamOk + '</span>';
    log('GET /api/system → 200 ' + JSON.stringify(j));
  } catch (e) {
    $('pingOut').innerHTML = '<span class="err">not readable from here (' + e.message + '). Note: browsers need CORS to READ cross-origin — this is expected. Use the buttons; results show on the dashboard.</span>';
  }
};

$('lb').onclick = async () => {
  $('traders').innerHTML = '<p class="muted">loading leaderboard…</p>';
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?period=1d&limit=8');
    const rows = await r.json();
    $('traders').innerHTML = '';
    rows.filter(x => x.proxyWallet).forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'row';
      div.innerHTML = '<div class="who"><b>#'+(i+1)+' '+(t.userName||'unnamed')+'</b><br>'+
        '<span class="muted">pnl $'+Number(t.pnl||0).toLocaleString()+' · vol $'+Number(t.vol||0).toLocaleString()+'</span></div>';
      const btn = document.createElement('button');
      btn.textContent = 'Track on live site →';
      btn.onclick = () => addTrader(t, btn);
      div.appendChild(btn);
      $('traders').appendChild(div);
    });
    log('leaderboard loaded: ' + rows.length + ' traders');
  } catch (e) { $('traders').innerHTML = '<span class="err">leaderboard failed: '+e.message+'</span>'; }
};

async function addTrader(t, btn) {
  btn.disabled = true; btn.textContent = 'adding…';
  const input = 'https://polymarket.com/profile/' + t.proxyWallet;
  log('POST ' + base() + '/api/wallets  ← ' + input + ' (' + (t.userName||'unnamed') + ')');
  try {
    // urlencoded form POST: a CORS "simple request" — sends cross-origin without preflight
    const r = await fetch(base() + '/api/wallets', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'input=' + encodeURIComponent(input),
    });
    log('→ request sent (fetch no-cors; HTTP status not readable cross-origin — check the dashboard)');
    btn.textContent = 'sent ✓ (check dashboard)';
    // give the serverless function time for the inline initial sync, then poke a sync pass
    setTimeout(async () => {
      try { await fetch(base() + '/api/sync', { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }); } catch {}
      log('→ POST /api/sync sent');
    }, 2000);
    $('siteLink').href = base() + '/trader/' + t.proxyWallet;
  } catch (e) {
    log('→ FAILED: ' + e.message);
    btn.textContent = 'failed — retry'; btn.disabled = false;
  }
}
</script>
</div></body></html>`;

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(PORT, '0.0.0.0', () => console.log(`[live-runner] http://0.0.0.0:${PORT}`));
