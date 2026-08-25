/**
 * polymarketService — the ONLY module that talks to Polymarket.
 *
 * All endpoints below are the documented, public, unauthenticated Polymarket APIs
 * (see docs.polymarket.com — "Data API", "Gamma API", rate limits page):
 *
 *   GET {data}/trades?user=&limit=&offset=&takerOnly=&side=&start=&end=
 *   GET {data}/activity?user=&limit=&offset=&type=&start=&end=&sortBy=&sortDirection=
 *   GET {data}/positions?user=&limit=&offset=&sortBy=CURRENT&sortDirection=DESC
 *   GET {data}/closed-positions?user=&limit=&offset=
 *   GET {data}/value?user=                      -> total open-portfolio value
 *   GET {data}/traded?user=                     -> total distinct markets traded
 *   GET {data}/v1/leaderboard?period=&limit=    -> top traders (suggestions)
 *   GET {gamma}/public-profile?address=         -> profile metadata
 *   GET {gamma}/public-search?q=&search_profiles=true  -> username -> wallet
 *   GET {lb}/profit?window=&address=            -> API-provided P&L for window
 *   GET {lb}/volume?window=&address=            -> API-provided volume for window
 *
 * The rest of the app only ever sees the normalized shapes produced here, so the
 * integration can be swapped if Polymarket changes its APIs.
 */
import { config } from './config.js';
import { nowSec } from './util.js';

export class PolymarketApiError extends Error {
  constructor(message, { status = 0, url = '', retryable = false } = {}) {
    super(message);
    this.name = 'PolymarketApiError';
    this.status = status;
    this.url = url;
    this.retryable = retryable;
  }
}

const UA = 'PolymarketIntelDashboard/1.0 (public read-only analytics)';

async function fetchJson(url, { timeoutMs = config.requestTimeoutMs } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': UA },
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw new PolymarketApiError(
      aborted ? `Timed out after ${timeoutMs}ms` : `Network error: ${err?.cause?.code || err?.message || err}`,
      { url, retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const retryable = res.status >= 500 || res.status === 429;
    throw new PolymarketApiError(`HTTP ${res.status}${body ? ` — ${body}` : ''}`, { status: res.status, url, retryable });
  }
  try {
    return await res.json();
  } catch (err) {
    throw new PolymarketApiError(`Invalid JSON response: ${err.message}`, { url, retryable: true });
  }
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------------------------------------------------------------------------
// Connectivity probe (server decides between server-mode and browser-bridge)
// ---------------------------------------------------------------------------
let upstreamOk = null;
let lastProbeAt = 0;

export async function probeUpstream(force = false) {
  const now = Date.now();
  if (!force && upstreamOk !== null && now - lastProbeAt < (upstreamOk ? 600_000 : 120_000)) return upstreamOk;
  lastProbeAt = now;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${config.hosts.data}/trades${qs({ limit: 1 })}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': UA },
    });
    clearTimeout(t);
    upstreamOk = res.ok;
  } catch {
    upstreamOk = false;
  }
  return upstreamOk;
}
export const upstreamState = () => upstreamOk;

// ---------------------------------------------------------------------------
// Raw endpoint calls (all return parsed JSON, throw PolymarketApiError)
// ---------------------------------------------------------------------------
export const fetchTrades = (address, opts = {}) =>
  fetchJson(`${config.hosts.data}/trades${qs({
    user: address,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
    takerOnly: true,
    side: opts.side,
    start: opts.start,
    end: opts.end,
  })}`);

export const fetchActivity = (address, opts = {}) =>
  fetchJson(`${config.hosts.data}/activity${qs({
    user: address,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
    type: opts.type,
    side: opts.side,
    start: opts.start,
    end: opts.end,
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  })}`);

export const fetchPositions = (address, opts = {}) =>
  fetchJson(`${config.hosts.data}/positions${qs({
    user: address,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
    sortBy: 'CURRENT',
    sortDirection: 'DESC',
  })}`);

export const fetchClosedPositions = (address, opts = {}) =>
  fetchJson(`${config.hosts.data}/closed-positions${qs({
    user: address,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
    sortBy: opts.sortBy ?? 'TIMESTAMP',
    sortDirection: 'DESC',
  })}`);

export async function fetchPortfolioValue(address) {
  const rows = await fetchJson(`${config.hosts.data}/value${qs({ user: address })}`);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row && typeof row.value === 'number' ? row.value : null;
}

export async function fetchMarketsTraded(address) {
  const row = await fetchJson(`${config.hosts.data}/traded${qs({ user: address })}`);
  return row && Number.isFinite(row.traded) ? row.traded : null;
}

export const fetchLeaderboardProfit = (address, window_) =>
  fetchJson(`${config.hosts.lb}/profit${qs({ window: window_, address, limit: 1 })}`);
export const fetchLeaderboardVolume = (address, window_) =>
  fetchJson(`${config.hosts.lb}/volume${qs({ window: window_, address, limit: 1 })}`);

export async function fetchTopTraders(period = '1d', limit = 8) {
  const rows = await fetchJson(`${config.hosts.data}/v1/leaderboard${qs({ period, limit })}`);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    address: String(r.proxyWallet || '').toLowerCase(),
    username: r.userName || null,
    vol: Number(r.vol) || 0,
    pnl: Number(r.pnl) || 0,
    profileImage: r.profileImage || null,
  })).filter((r) => r.address);
}

/** Public profile metadata; returns null when the address has no Polymarket profile. */
export async function fetchPublicProfile(address) {
  try {
    const p = await fetchJson(`${config.hosts.gamma}/public-profile${qs({ address })}`);
    if (!p || typeof p !== 'object') return null;
    return {
      proxyWallet: String(p.proxyWallet || address).toLowerCase(),
      name: p.name || null,
      pseudonym: p.pseudonym || null,
      bio: p.bio || null,
      profileImage: p.profileImage || p.profileImageOptimized || null,
      xUsername: p.xUsername || null,
      verifiedBadge: !!p.verifiedBadge,
      displayUsernamePublic: p.displayUsernamePublic ?? true,
      createdAt: p.createdAt || null,
    };
  } catch (err) {
    if (err instanceof PolymarketApiError && err.status === 404) return null;
    throw err;
  }
}

/** Resolve a display username to candidate profiles via Gamma public search. */
export async function searchProfiles(query, limit = 5) {
  const res = await fetchJson(`${config.hosts.gamma}/public-search${qs({
    q: query, search_profiles: true, limit_per_type: limit,
  })}`);
  const profiles = Array.isArray(res?.profiles) ? res.profiles : [];
  return profiles.map((p) => ({
    address: String(p.proxyWallet || '').toLowerCase(),
    name: p.name || null,
    pseudonym: p.pseudonym || null,
    profileImage: p.profileImage || null,
  })).filter((p) => p.address);
}

// ---------------------------------------------------------------------------
// Normalization — internal shapes used everywhere else in the app
// ---------------------------------------------------------------------------
const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** Raw data-api /trades row -> internal trade. */
export function normalizeTrade(raw, walletId) {
  const price = num(raw.price);
  const shares = num(raw.size);
  const ts = num(raw.timestamp) ?? nowSec();
  return {
    wallet: walletId,
    ts: Math.round(ts),
    side: raw.side === 'SELL' ? 'SELL' : 'BUY',
    condition_id: raw.conditionId || null,
    asset: raw.asset ? String(raw.asset) : null,
    title: raw.title || null,
    slug: raw.slug || null,
    event_slug: raw.eventSlug || null,
    icon: raw.icon || null,
    outcome: raw.outcome || null,
    outcome_index: Number.isFinite(num(raw.outcomeIndex)) ? raw.outcomeIndex : null,
    price,
    shares,
    value: price !== null && shares !== null ? +(price * shares).toFixed(6) : null,
    tx_hash: raw.transactionHash || null,
  };
}

/** Raw data-api /activity row -> internal activity row. */
export function normalizeActivity(raw, walletId) {
  const ts = num(raw.timestamp) ?? nowSec();
  return {
    wallet: walletId,
    ts: Math.round(ts),
    type: raw.type || 'TRADE',
    condition_id: raw.conditionId || null,
    asset: raw.asset ? String(raw.asset) : null,
    title: raw.title || null,
    slug: raw.slug || null,
    event_slug: raw.eventSlug || null,
    icon: raw.icon || null,
    outcome: raw.outcome || null,
    outcome_index: Number.isFinite(num(raw.outcomeIndex)) ? raw.outcomeIndex : null,
    side: raw.side === 'SELL' ? 'SELL' : raw.side === 'BUY' ? 'BUY' : null,
    price: num(raw.price),
    shares: num(raw.size),
    usdc: num(raw.usdcSize),
    tx_hash: raw.transactionHash || null,
  };
}

export function normalizePosition(raw) {
  return {
    asset: String(raw.asset ?? ''),
    condition_id: raw.conditionId || null,
    size: num(raw.size),
    avg_price: num(raw.avgPrice),
    initial_value: num(raw.initialValue),
    current_value: num(raw.currentValue),
    cash_pnl: num(raw.cashPnl),
    percent_pnl: num(raw.percentPnl),
    cur_price: num(raw.curPrice),
    redeemable: raw.redeemable ? 1 : 0,
    title: raw.title || null,
    slug: raw.slug || null,
    event_slug: raw.eventSlug || null,
    outcome: raw.outcome || null,
    outcome_index: Number.isFinite(num(raw.outcomeIndex)) ? raw.outcomeIndex : null,
    end_date: raw.endDate || null,
  };
}

export function normalizeClosedPosition(raw) {
  return {
    asset: String(raw.asset ?? ''),
    condition_id: raw.conditionId || null,
    avg_price: num(raw.avgPrice),
    total_bought: num(raw.totalBought),
    realized_pnl: num(raw.realizedPnl),
    cur_price: num(raw.curPrice),
    ts: num(raw.timestamp) ? Math.round(raw.timestamp) : null,
    title: raw.title || null,
    slug: raw.slug || null,
    event_slug: raw.eventSlug || null,
    outcome: raw.outcome || null,
    outcome_index: Number.isFinite(num(raw.outcomeIndex)) ? raw.outcomeIndex : null,
  };
}

/** lb-api window amount for a wallet (profit or volume), null when absent. */
export async function fetchWindowAmount(kind, address, window_) {
  try {
    const rows = kind === 'profit'
      ? await fetchLeaderboardProfit(address, window_)
      : await fetchLeaderboardVolume(address, window_);
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    return row && Number.isFinite(num(row.amount)) ? num(row.amount) : null;
  } catch {
    return null;
  }
}
