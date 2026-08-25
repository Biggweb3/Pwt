import React from 'react';
import { timeAgo, exactTime } from '../lib/format';
import { useNow } from '../lib/store';
import type { WalletStatus } from '../lib/types';

// ---------------------------------------------------------------- panels ---
export function Panel({ title, right, children, className = '', pad = true }: {
  title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean;
}) {
  return (
    <section className={`bg-ink-850 border border-line rounded-md overflow-hidden ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line bg-ink-800/60">
          <h2 className="text-[11px] font-semibold tracking-[0.14em] uppercase text-slate-400">{title}</h2>
          {right}
        </header>
      )}
      <div className={pad ? 'p-3' : ''}>{children}</div>
    </section>
  );
}

export function Metric({ label, value, sub, tone = 'default', source }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'default' | 'gain' | 'loss' | 'muted'; source?: string;
}) {
  const toneCls = tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : tone === 'muted' ? 'text-slate-500' : 'text-slate-100';
  return (
    <div className="min-w-0" title={source}>
      <div className="text-2xs uppercase tracking-[0.12em] text-slate-500">{label}{source ? <span className="ml-1 text-slate-600">· {source}</span> : null}</div>
      <div className={`font-mono text-lg leading-6 tabular-nums truncate ${toneCls}`}>{value}</div>
      {sub ? <div className="text-2xs text-slate-500 truncate">{sub}</div> : null}
    </div>
  );
}

// -------------------------------------------------------------- avatars ---
export function Avatar({ src, name, size = 32 }: { src?: string | null; name?: string | null; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  const initials = (name || '?').slice(0, 2).toUpperCase();
  return src && !failed ? (
    <img src={src} alt={name || ''} width={size} height={size}
      className="rounded-full object-cover border border-line shrink-0"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)} loading="lazy" />
  ) : (
    <div className="rounded-full bg-ink-700 border border-line grid place-items-center text-slate-400 font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.36 }}>{initials}</div>
  );
}

// --------------------------------------------------------------- status ---
export function StatusPill({ status, lastSuccess, lastError, now }: {
  status: WalletStatus; lastSuccess?: number | null; lastError?: string | null; now?: number;
}) {
  const t = now ?? Math.floor(Date.now() / 1000);
  if (status === 'live') {
    return <span className="inline-flex items-center gap-1.5 text-gain text-2xs font-medium" title={lastSuccess ? `Last successful update: ${exactTime(lastSuccess)}` : 'Live'}>
      <Dot color="bg-gain" pulse /> LIVE</span>;
  }
  if (status === 'syncing') {
    return <span className="inline-flex items-center gap-1.5 text-warn text-2xs font-medium"><Dot color="bg-warn" pulse /> UPDATING</span>;
  }
  if (status === 'error') {
    return <span className="inline-flex items-center gap-1.5 text-loss text-2xs font-medium" title={lastError || 'Sync error'}>
      <Dot color="bg-loss" /> ERROR</span>;
  }
  return <span className="inline-flex items-center gap-1.5 text-slate-400 text-2xs font-medium"><Dot color="bg-slate-500" pulse /> PENDING</span>;
}

export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex w-1.5 h-1.5">
      {pulse && <span className={`absolute inline-flex w-full h-full rounded-full ${color} opacity-60 animate-ping`} />}
      <span className={`relative inline-flex w-1.5 h-1.5 rounded-full ${color}`} />
    </span>
  );
}

/** "Updated N seconds ago" with exact timestamp on hover. */
export function UpdatedAgo({ ts, prefix = 'Updated', interval = 1000 }: { ts: number | null | undefined; prefix?: string; interval?: number }) {
  const now = useNow(interval);
  if (!ts) return <span className="text-2xs text-slate-600">no data yet</span>;
  return (
    <span className="text-2xs text-slate-500 tabular-nums" title={exactTime(ts)}>
      {prefix} {timeAgo(ts, now)}
    </span>
  );
}

// --------------------------------------------------------------- badges ---
export function SideBadge({ side }: { side: string | null }) {
  if (side === 'BUY') return <span className="px-1.5 py-px rounded-sm text-2xs font-bold bg-gain/10 text-gain border border-gain/25">BUY</span>;
  if (side === 'SELL') return <span className="px-1.5 py-px rounded-sm text-2xs font-bold bg-loss/10 text-loss border border-loss/25">SELL</span>;
  return <span className="px-1.5 py-px rounded-sm text-2xs font-bold bg-ink-700 text-slate-400 border border-line">{side || '—'}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-slate-600 text-2xs">—</span>;
  const up = outcome.toUpperCase();
  const cls = up === 'YES' ? 'bg-accent/10 text-accent border-accent/25'
    : up === 'NO' ? 'bg-orange-400/10 text-orange-300 border-orange-400/25'
    : 'bg-ink-700 text-slate-300 border-line';
  return <span className={`px-1.5 py-px rounded-sm text-2xs font-semibold border ${cls}`}>{outcome.toUpperCase()}</span>;
}

export function TypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    TRADE: 'text-slate-300 bg-ink-700 border-line',
    REDEEM: 'text-purple-300 bg-purple-400/10 border-purple-400/25',
    SPLIT: 'text-cyan-300 bg-cyan-400/10 border-cyan-400/25',
    MERGE: 'text-cyan-300 bg-cyan-400/10 border-cyan-400/25',
    CONVERSION: 'text-amber-300 bg-amber-400/10 border-amber-400/25',
    REWARD: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/25',
  };
  return <span className={`px-1.5 py-px rounded-sm text-2xs font-semibold border ${map[type] || map.TRADE}`}>{type}</span>;
}

// ---------------------------------------------------------------- misc ---
export function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return <span className={`inline-block ${className} rounded-full border-2 border-slate-600 border-t-accent animate-spin`} />;
}

export function EmptyState({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="py-10 px-4 text-center">
      <div className="text-sm font-semibold text-slate-300">{title}</div>
      {body ? <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto leading-5">{body}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="py-8 px-4 text-center">
      <div className="text-sm font-semibold text-loss">Something went wrong</div>
      <div className="mt-1 text-xs text-slate-500">{message}</div>
      {onRetry && <button onClick={onRetry} className="mt-3 px-3 py-1.5 text-xs rounded border border-line bg-ink-700 hover:bg-ink-600 text-slate-200">Retry</button>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, width = 'max-w-lg' }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode; width?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/70 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={`w-full ${width} bg-ink-850 border border-line rounded-lg shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1" aria-label="Close">×</button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function SortHeader({ label, active, dir, onClick, align = 'left' }: {
  label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; align?: 'left' | 'right';
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''} text-2xs uppercase tracking-[0.1em] font-semibold hover:text-slate-200 transition-colors ${active ? 'text-accent' : 'text-slate-500'}`}>
      {label}
      <span className="text-[9px]">{active ? (dir === 'desc' ? '▼' : '▲') : ''}</span>
    </button>
  );
}
