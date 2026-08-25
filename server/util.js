import crypto from 'node:crypto';

export const nowSec = () => Math.floor(Date.now() / 1000);

export const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : s);

/** Normalize a Polymarket address: 0x-prefixed, lowercase. Returns null if invalid. */
export function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return s.toLowerCase();
  return null;
}

/**
 * Parse user input into { kind: 'address'|'username'|'url', value }.
 * Accepts:
 *  - raw 0x address
 *  - https://polymarket.com/profile/0x...
 *  - https://polymarket.com/profile/<username>
 *  - polymarket.com/@user style is not used; bare username also allowed.
 */
export function parseTraderInput(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  const addr = normalizeAddress(s);
  if (addr) return { kind: 'address', value: addr };

  let u = null;
  try {
    if (/^https?:\/\//i.test(s)) u = new URL(s);
    else if (/^[\w.-]+\.[a-z]{2,}\/profile\//i.test(s)) u = new URL('https://' + s);
  } catch { /* not a url */ }

  if (u) {
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'polymarket.com') return null;
    const m = u.pathname.match(/^\/profile\/([^/]+)/i);
    if (!m) return null;
    const seg = decodeURIComponent(m[1]);
    const a = normalizeAddress(seg);
    if (a) return { kind: 'address', value: a };
    if (/^[\w.\-@]{2,64}$/.test(seg)) return { kind: 'username', value: seg.replace(/^@/, '') };
    return null;
  }

  // Bare username (no URL)
  if (/^@?[\w.\-]{2,64}$/.test(s)) return { kind: 'username', value: s.replace(/^@/, '') };
  return null;
}

export function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/** Stable dedupe key for a trade row (tx hash alone is not unique: one tx can settle many fills). */
export function tradeDedupeKey(t) {
  return sha1([t.transactionHash || 'nohash', t.asset || '', t.side || '', t.price ?? '', t.shares ?? '', t.ts].join('|'));
}

export function activityDedupeKey(a) {
  return sha1([a.type || '', a.transactionHash || 'nohash', a.asset || '', a.side || '', a.price ?? '', a.shares ?? '', a.usdc ?? '', a.ts].join('|'));
}

export const clampInt = (v, min, max, d) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(Math.max(n, min), max);
};

export function pick(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k] ?? null;
  return o;
}

/** Simple async pool: run fn(item) with at most `n` concurrent. */
export async function mapPool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
