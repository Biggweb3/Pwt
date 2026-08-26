/**
 * Local (browser) memory of which traders this browser tracks.
 *
 * On a persistent server this is just a mirror. On serverless deployments
 * (Vercel) the API's SQLite lives in the function's ephemeral /tmp and is
 * wiped on cold starts — the browser then re-seeds the server from this list,
 * and all history is rebuilt automatically from Polymarket's public APIs.
 */
const KEY = 'pwt:tracked-wallets';

export function loadTracked(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.startsWith('0x')) : [];
  } catch {
    return [];
  }
}

export function saveTracked(addresses: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(addresses.map((a) => a.toLowerCase()))]));
  } catch { /* storage full/blocked — non-fatal */ }
}

export function untrackLocal(address: string) {
  saveTracked(loadTracked().filter((a) => a !== address.toLowerCase()));
}
