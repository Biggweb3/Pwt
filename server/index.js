/**
 * index.js — long-lived server entrypoint (local dev / self-hosting).
 *
 * On Vercel this file never runs; the serverless entrypoint is api/index.js
 * (repo root) or the prebuilt client/api/index.js bundle, which export the
 * same Express app from server/app.js without any background loops.
 */
import { app } from './app.js';
import { config } from './config.js';
import { probeUpstream, upstreamState } from './polymarketService.js';
import { setBridgeActive } from './bridge.js';
import { startSyncEngine } from './syncEngine.js';
import { broadcast } from './events.js';
import { getSetting } from './db.js';

// Upstream connectivity probe drives server-mode vs browser-bridge mode.
async function probeLoop() {
  const ok = await probeUpstream(true);
  const prev = upstreamState();
  setBridgeActive(!ok);
  if (prev !== null && prev !== ok) broadcast('system', { upstreamOk: ok, mode: ok ? 'server' : 'bridge' });
}

const port = config.port;
app.listen(port, '0.0.0.0', async () => {
  console.log(`[pwt] Polymarket Intel server listening on 0.0.0.0:${port}`);
  console.log(`[pwt] db: ${config.dbFile}`);
  console.log(`[pwt] default poll interval: ${getSetting('poll_interval', config.defaultPollInterval)}s`);
  await probeLoop();
  console.log(`[pwt] polymarket upstream: ${upstreamState() ? 'reachable (server-side polling)' : 'NOT reachable (browser-bridge fallback)'}`);
  startSyncEngine();
  setInterval(() => { probeLoop().catch(() => {}); }, 60_000);
});
