import path from 'node:path';
import fs from 'node:fs';
import fileURLToPathFn from 'node:url';

const __dirname = path.dirname(fileURLToPathFn.fileURLToPath(import.meta.url));
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

/**
 * True when running as a Vercel serverless function (Vercel always sets
 * process.env.VERCEL). In that environment:
 *  - the filesystem is read-only except /tmp (SQLite lives there)
 *  - there is no long-lived process, so background pollers/SSE are disabled
 *    and syncs run inside requests (see routes.js POST /api/sync)
 */
export const isServerless = !!process.env.VERCEL;

// Serverless filesystems are read-only outside /tmp.
const defaultDataDir = isServerless ? '/tmp/pwt-data' : './data';
const resolveFromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));
const dataDir = resolveFromRoot(process.env.DATA_DIR || defaultDataDir);

export const config = {
  root,
  port: int(process.env.PORT, 3000),
  dataDir,
  dbFile: path.join(dataDir, 'pwt.db'),
  isServerless,
  // Public, documented Polymarket API hosts (see docs.polymarket.com).
  hosts: {
    data: process.env.POLYMARKET_DATA_API || 'https://data-api.polymarket.com',
    gamma: process.env.POLYMARKET_GAMMA_API || 'https://gamma-api.polymarket.com',
    lb: process.env.POLYMARKET_LB_API || 'https://lb-api.polymarket.com',
    // CLOB market endpoint is the authoritative source for "has this market
    // resolved, and which outcome token won" (tokens[].winner).
    clob: process.env.POLYMARKET_CLOB_API || 'https://clob.polymarket.com',
  },
  profileBase: 'https://polymarket.com/profile/',
  // ---- prediction (win-rate) engine -------------------------------------------------
  // How many completed-position records one wallet is classified from, and how many
  // open positions are scanned (paged, 500/page) when rebuilding predictions.
  predictionClosedPositions: int(process.env.PREDICTION_CLOSED_LIMIT, 1500),
  predictionPositionPages: int(process.env.PREDICTION_POSITION_PAGES, 4),
  // Market-resolution lookups are cached forever in `market_resolutions`; these only
  // bound how much new lookup work a single sync cycle may do (bridge mode included).
  resolutionLookupsPerCycle: int(process.env.RESOLUTION_LOOKUPS_PER_CYCLE, 40),
  resolutionLookupsInitial: int(process.env.RESOLUTION_LOOKUPS_INITIAL, 160),
  resolutionConcurrency: 6,
  resolutionRetrySec: int(process.env.RESOLUTION_RETRY_SEC, 300),   // retry open markets after this
  resolutionMaxAttempts: 12,                                        // then stop hammering, mark unreachable
  // Second-opinion thresholds: a position is only classified when the market itself
  // resolved; `curPrice` inside this band means the market is still trading.
  pinnedEpsilon: 0.005,
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
  maxClosedPositions: 1500,     // backfill cap for closed positions
  bridgeJobTimeoutMs: 60000,    // unclaimed bridge jobs expire after this
  // Overall wall-clock budget for an initial sync when it must complete inside
  // one request (serverless). Generous history is traded for convergence.
  serverlessInitialSyncBudgetMs: int(process.env.SERVERLESS_SYNC_BUDGET_MS, 40_000),
  serverlessSyncBudgetMs: int(process.env.SERVERLESS_SYNC_BUDGET_MS, 40_000),
};

fs.mkdirSync(config.dataDir, { recursive: true });
