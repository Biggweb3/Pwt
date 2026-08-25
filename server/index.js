import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { api } from './routes.js';
import { probeUpstream, upstreamState } from './polymarketService.js';
import { setBridgeActive } from './bridge.js';
import { startSyncEngine } from './syncEngine.js';
import { broadcast } from './events.js';
import { getSetting } from './db.js';

const app = express();
app.disable('x-powered-by');
app.use('/api', api);

// Static frontend (built Vite app) with SPA fallback
const distDir = path.join(config.root, 'client', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text/plain').send('Polymarket Intel API is running. Build the client with `npm run build`.'));
}

app.use((err, req, res, next) => {
  console.error('[api-error]', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

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
