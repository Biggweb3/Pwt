import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load .env if present (no dependency needed for a handful of vars)
try {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* ignore */ }

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export const config = {
  root,
  port: int(process.env.PORT, 3000),
  dataDir: path.resolve(root, process.env.DATA_DIR || './data'),
  dbFile: path.resolve(root, process.env.DATA_DIR || './data', 'pwt.db'),
  // Public, documented Polymarket API hosts (see docs.polymarket.com).
  hosts: {
    data: process.env.POLYMARKET_DATA_API || 'https://data-api.polymarket.com',
    gamma: process.env.POLYMARKET_GAMMA_API || 'https://gamma-api.polymarket.com',
    lb: process.env.POLYMARKET_LB_API || 'https://lb-api.polymarket.com',
  },
  profileBase: 'https://polymarket.com/profile/',
  defaultPollInterval: Math.min(Math.max(int(process.env.POLL_INTERVAL, 30), 5), 300),
  initialHistoryDays: int(process.env.INITIAL_HISTORY_DAYS, 31),
  initialMaxTrades: int(process.env.INITIAL_MAX_TRADES, 2500),
  // Safety caps for background refresh fan-out (kept far below published
  // Cloudflare limits: data-api general 1000 req/10s, /trades 200 req/10s).
  maxConcurrentSyncs: int(process.env.MAX_CONCURRENT_SYNCS, 3),
  requestTimeoutMs: 12000,
  positionsRefreshEvery: 4,     // refresh positions every N sync cycles
  closedRefreshEvery: 8,        // refresh closed positions every N cycles
  statsRefreshEvery: 10,        // refresh lb-api stats every N cycles
  maxClosedPositions: 1000,     // backfill cap for closed positions
  bridgeJobTimeoutMs: 60000,    // unclaimed bridge jobs expire after this
};

fs.mkdirSync(config.dataDir, { recursive: true });
