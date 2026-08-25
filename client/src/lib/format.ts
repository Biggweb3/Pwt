export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function money(v: number | null | undefined, opts: { compact?: boolean; sign?: boolean } = {}): string {
  if (!isNum(v)) return 'N/A';
  const { compact = true, sign = false } = opts;
  const s = sign && v > 0 ? '+' : '';
  const abs = Math.abs(v);
  if (compact) {
    if (abs >= 1_000_000) return `${s}${v < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 100_000) return `${s}${v < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
    if (abs >= 10_000) return `${s}${v < 0 ? '-' : ''}$${(abs / 1_000).toFixed(2)}K`;
  }
  return `${s}${v < 0 ? '-' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: abs < 100 ? 2 : 0, maximumFractionDigits: abs < 100 ? 2 : 0 })}`;
}

export function signedMoney(v: number | null | undefined): string {
  if (!isNum(v)) return 'N/A';
  return money(v, { sign: true });
}

export function num(v: number | null | undefined): string {
  if (!isNum(v)) return 'N/A';
  return v.toLocaleString('en-US');
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return 'N/A';
  return `${(v * 100).toFixed(digits)}%`;
}

export function shares(v: number | null | undefined): string {
  if (!isNum(v)) return 'N/A';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toFixed(v < 10 ? 2 : 0);
}

export function price(v: number | null | undefined): string {
  if (!isNum(v)) return 'N/A';
  return `${Math.round(v * 100)}¢`;
}

export function shortAddr(a: string | null | undefined, head = 6, tail = 4): string {
  if (!a) return '—';
  return a.length <= head + tail + 2 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Human-friendly relative time: "53 seconds ago", "2 minutes ago", "Yesterday", "12 days ago". */
export function timeAgo(ts: number | null | undefined, now = Math.floor(Date.now() / 1000)): string {
  if (!isNum(ts) || ts <= 0) return '—';
  const d = Math.max(0, now - ts);
  if (d < 5) return 'just now';
  if (d < 60) return `${d} seconds ago`;
  const m = Math.floor(d / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return mo === 1 ? '1 month ago' : `${mo} months ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function exactTime(ts: number | null | undefined): string {
  if (!isNum(ts) || ts <= 0) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function clockTime(ts: number | null | undefined): string {
  if (!isNum(ts) || ts <= 0) return '—';
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function displayName(w: { username?: string | null; pseudonym?: string | null; address?: string }): string {
  return w.username || w.pseudonym || shortAddr(w.address ?? '');
}

export const PERIOD_LABELS: Record<string, string> = {
  '24h': '24H', '72h': '72H', '7d': '7D', '30d': '30D', all: 'ALL',
};
