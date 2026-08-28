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

/**
 * Open positions (every row has size > 0, including resolved-but-not-redeemed ones,
 * which is exactly the set that `closed-positions` never shows). `redeemable=true`
 * narrows to positions in markets that already resolved.
 */
export const positionsUrl = (address, opts = {}) =>
  `${config.hosts.data}/positions${qs({
    user: address,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
    sortBy: opts.sortBy ?? 'CURRENT',
    sortDirection: opts.sortDirection ?? 'DESC',
    redeemable: opts.redeemable === undefined ? undefined : String(!!opts.redeemable),
  })}`;

export const fetchPositions = (address, opts = {}) => fetchJson(positionsUrl(address, opts));

/**
 * Positions the wallet has fully exited (size back to 0) — newest completion first.
 * NOTE: this endpoint defaults to ASCENDING order, so omitting the sort params
 * returns the OLDEST closed positions. That was one of the root causes of the
 * "everyone is at 100%" bug (fresh closures were never ingested).
 */
export const closedPositionsUrl = (address, opts = {}) =>
  `${config.hosts.data}/closed-positions${qs({
    user: address,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  })}`;

export const fetchClosedPositions = (address, opts = {}) => fetchJson(closedPositionsUrl(address, opts));

// ---------------------------------------------------------------------------
// Market resolution — the authoritative source for WIN/LOSS.
//
// Primary: CLOB `GET /markets/{conditionId}` -> { closed, is_50_50_outcome,
//   tokens: [{ token_id, outcome, price, winner }] }  (`winner` is the resolved flag)
// Fallback: Gamma `GET /markets/slug/{slug}` -> { closed, outcomes, outcomePrices,
//   clobTokenIds, closedTime, umaResolutionStatus }
// Both are public, unauthenticated and CORS-enabled (the fallback also keeps the
// browser-bridge transport working if the CLOB host is ever unreachable).
// ---------------------------------------------------------------------------
export const marketResolutionUrl = (conditionId) => `${config.hosts.clob}/markets/${encodeURIComponent(conditionId)}`;
export const marketResolutionFallbackUrl = (slug) =>
  `${config.hosts.gamma}/markets/slug/${encodeURIComponent(slug)}`;

export const fetchMarketResolution = async (conditionId, slug = null) => {
  try {
    return normalizeClobMarket(await fetchJson(marketResolutionUrl(conditionId)), conditionId);
  } catch (err) {
    if (!slug) throw err;
    return normalizeGammaMarket(await fetchJson(marketResolutionFallbackUrl(slug)), conditionId);
  }
};

const jsonArr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};

/** Raw CLOB /markets/{conditionId} -> internal resolution record. */
export function normalizeClobMarket(raw, conditionId) {
  const tokens = Array.isArray(raw?.tokens) ? raw.tokens : [];
  const outcomes = tokens.map((t, i) => ({
    index: i,
    outcome: t.outcome || (i === 0 ? 'Yes' : 'No'),
    token_id: t.token_id != null ? String(t.token_id) : null,
    price: num(t.price),
    winner: t.winner === true,
  }));
  const winnerIdx = outcomes.findIndex((o) => o.winner);
  const closed = raw?.closed === true;
  const fiftyFifty = raw?.is_50_50_outcome === true;
  let state = 'unknown';
  if (winnerIdx >= 0) state = 'resolved';
  else if (fiftyFifty && closed) state = 'flat';
  else if (raw?.archived === true) state = 'voided';
  else if (closed) state = 'closed_unresolved';
  else if (raw?.active === false) state = 'voided';
  return {
    condition_id: conditionId || raw?.condition_id || null,
    slug: raw?.market_slug || null,
    question: raw?.question || null,
    market_state: state,
    closed,
    resolved: state === 'resolved',
    winning_index: state === 'resolved' ? winnerIdx : null,
    winning_outcome: state === 'resolved' ? outcomes[winnerIdx].outcome : null,
    winning_token: state === 'resolved' ? outcomes[winnerIdx].token_id : null,
    outcomes,
    closed_at: null,
    source: 'clob',
    reason: state === 'resolved' ? null
      : state === 'flat' ? 'market resolved 50/50 (payout split)'
      : state === 'closed_unresolved' ? 'market closed, outcome not published yet'
      : state === 'voided' ? 'market voided / archived without a winner'
      : 'market still open',
  };
}

/** Raw Gamma /markets (or /markets/slug/{slug}) -> internal resolution record. */
export function normalizeGammaMarket(raw, conditionId) {
  const labels = jsonArr(raw?.outcomes).map(String);
  const prices = jsonArr(raw?.outcomePrices).map((p) => num(p) ?? 0);
  const tokenIds = jsonArr(raw?.clobTokenIds).map((t) => String(t));
  const outcomes = labels.map((label, i) => ({
    index: i,
    outcome: label,
    token_id: tokenIds[i] ?? null,
    price: prices[i] ?? null,
    winner: (prices[i] ?? 0) >= 1 - config.pinnedEpsilon,
  }));
  const maxPrice = outcomes.length ? Math.max(...outcomes.map((o) => o.price ?? 0)) : 0;
  const closed = raw?.closed === true;
  const status = String(raw?.umaResolutionStatus || '').toLowerCase();
  let state = 'unknown';
  if (closed && maxPrice >= 1 - config.pinnedEpsilon) {
    const winners = outcomes.filter((o) => (o.price ?? 0) >= 1 - config.pinnedEpsilon);
    state = winners.length === 1 ? 'resolved' : 'flat';
  } else if (status === 'resolved' && maxPrice >= 1 - config.pinnedEpsilon) state = 'resolved';
  else if (closed && outcomes.length && outcomes.every((o) => Math.abs((o.price ?? 0) - 0.5) < 0.02)) state = 'flat';
  else if (closed) state = 'closed_unresolved';
  else if (raw?.archived === true || status === 'denied' || status === 'refunded') state = 'voided';
  const winnerIdx = state === 'resolved' ? outcomes.findIndex((o) => (o.price ?? 0) >= 1 - config.pinnedEpsilon) : null;
  const closedAt = raw?.closedTime ? Math.floor(new Date(String(raw.closedTime).replace(' ', 'T')).getTime() / 1000)
    : raw?.umaEndDate ? Math.floor(new Date(raw.umaEndDate).getTime() / 1000)
    : null;
  return {
    condition_id: conditionId || raw?.conditionId || null,
    slug: raw?.slug || null,
    question: raw?.question || null,
    market_state: state,
    closed,
    resolved: state === 'resolved',
    winning_index: state === 'resolved' ? winnerIdx : null,
    winning_outcome: state === 'resolved' ? outcomes[winnerIdx].outcome : null,
    winning_token: state === 'resolved' ? outcomes[winnerIdx].token_id : null,
    outcomes,
    closed_at: Number.isFinite(closedAt) ? closedAt : null,
    source: 'gamma',
    reason: state === 'resolved' ? null
      : state === 'flat' ? 'market resolved flat/50-50 (no single winner)'
      : state === 'closed_unresolved' ? `outcome prices not final (uma: ${status || 'n/a'})`
      : state === 'voided' ? 'market voided / refunded'
      : 'market still open',
  };
}

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
    realized_pnl: num(raw.realizedPnl),
    total_bought: num(raw.totalBought),
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
