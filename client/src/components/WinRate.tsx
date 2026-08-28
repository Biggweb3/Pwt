import React, { useEffect, useRef, useState } from 'react';
import { ratePct } from '../lib/format';
import type { PredictionStats, PredictionWindow } from '../lib/types';

/**
 * Every win-rate display in the app goes through this file, so the wording, the
 * sample size and the methodology tooltip are identical on all screens.
 */
export const WINRATE_TOOLTIP = 'Win rate is independently calculated from the trader’s most recent completed predictions. Open and unresolved positions are excluded. Multiple transactions belonging to the same prediction are grouped to prevent double counting.';

/** Confidence is part of the number: 100% of 4 predictions ≠ 100% of 100. */
export function sampleConfidence(analyzed: number): { label: string; cls: string } {
  if (!analyzed || analyzed <= 0) return { label: 'no sample', cls: 'text-slate-500 border-line' };
  if (analyzed < 5) return { label: `very low sample · ${analyzed}`, cls: 'text-warn border-warn/40 bg-warn/10' };
  if (analyzed < 10) return { label: `low sample · ${analyzed}`, cls: 'text-warn border-warn/30 bg-warn/5' };
  if (analyzed < 30) return { label: `small sample · ${analyzed}`, cls: 'text-slate-300 border-line' };
  if (analyzed < 100) return { label: `sample · ${analyzed}`, cls: 'text-slate-300 border-line' };
  return { label: `${analyzed} predictions`, cls: 'text-gain border-gain/30 bg-gain/5' };
}

// -------------------------------------------------------------------- info ---
export function InfoTip({ extra, label = 'How is this win rate calculated?' }: { extra?: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(360, window.innerWidth - 16);
      setPos({
        x: Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8),
        y: Math.min(r.bottom + 8, window.innerHeight - 190),
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        ref={ref} type="button" aria-label={label} title={label}
        onMouseEnter={show} onMouseLeave={() => setOpen(false)} onFocus={show} onBlur={() => setOpen(false)}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => (o ? false : (show(), true))); }}
        className="inline-grid place-items-center w-3.5 h-3.5 rounded-full border border-slate-600 text-slate-400 hover:text-accent hover:border-accent/60 text-[9px] font-bold leading-none align-middle">
        i
      </button>
      {open && pos && (
        <div
          className="fixed z-[70] bg-ink-900 border border-line rounded-md shadow-2xl p-3 text-2xs leading-4 text-slate-300 pointer-events-auto"
          style={{ left: pos.x, top: pos.y, width: Math.min(360, window.innerWidth - 16) }}
          onMouseLeave={() => setOpen(false)}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Win rate methodology</div>
          <p>{WINRATE_TOOLTIP}</p>
          <p className="mt-1.5">
            Formula: <span className="font-mono text-slate-200">wins ÷ (wins + losses) × 100</span> — the sample size is always shown
            with the number, and trading profit/loss is a separate metric that never affects this one.
          </p>
          {extra}
        </div>
      )}
    </>
  );
}

// -------------------------------------------------------------- the number ---
export function WinRateValue({
  win, size = 'md', info = true, className = '',
}: { win: Pick<PredictionWindow, 'winRate' | 'wins' | 'losses' | 'analyzed' | 'limited'> | null | undefined; size?: 'sm' | 'md' | 'lg'; info?: boolean; className?: string }) {
  const rate = win?.winRate ?? null;
  const analyzed = win?.analyzed ?? 0;
  const value = rate == null ? 'N/A' : ratePct(rate);
  const tone = rate == null ? 'text-slate-500' : rate >= 0.5 ? 'text-gain' : 'text-loss';
  const sizeCls = size === 'lg' ? 'text-3xl leading-9' : size === 'md' ? 'text-lg leading-6' : 'text-sm leading-5';
  return (
    <span className={`inline-flex flex-col min-w-0 ${className}`}>
      <span className="flex items-center gap-1.5">
        <span className={`font-mono tabular-nums font-semibold ${tone} ${sizeCls}`}>{value}</span>
        {info && <InfoTip />}
      </span>
      <span className="text-2xs text-slate-500 tabular-nums truncate">
        {rate == null
          ? 'no completed predictions'
          : <>{win?.wins ?? 0}W / {win?.losses ?? 0}L<span className="text-slate-600"> · {analyzed} completed {analyzed === 1 ? 'prediction' : 'predictions'}</span></>}
      </span>
    </span>
  );
}

/** Compact inline variant for table cells: "63% · 63/100". */
export function WinRateCell({ win }: { win: { winRate: number | null; wins?: number; losses?: number; analyzed: number } | null | undefined }) {
  const rate = win?.winRate ?? null;
  if (rate == null) return <span className="text-slate-600" title="No completed, resolved predictions">N/A</span>;
  const tone = rate >= 0.5 ? 'text-gain' : 'text-loss';
  return (
    <span className={`font-mono tabular-nums ${tone}`}>
      {ratePct(rate)}
      <span className="text-slate-500 font-sans"> · {win?.wins ?? 0}/{win?.analyzed ?? 0}</span>
    </span>
  );
}

// ------------------------------------------------------------------- bars ----
/**
 * Visual breakdown, e.g.
 *   WIN  ████████████████████ 63%
 *   LOSS ██████████ 37%
 * Excluded (unresolved / undetermined) records are drawn as their own row so the
 * viewer can see what was left out of the denominator.
 */
export function WinRateBars({ win, openExcluded = 0, label }: { win: PredictionWindow | null | undefined; openExcluded?: number; label?: string }) {
  if (!win || (!win.wins && !win.losses && !win.excluded)) {
    return <div className="text-xs text-slate-600 py-2">No completed, resolved predictions to chart yet.</div>;
  }
  const decided = win.wins + win.losses;
  const total = Math.max(decided + win.excluded, 1);
  const pctOf = (n: number) => `${((n / (decided || 1)) * 100).toFixed(1)}%`;
  const widthOf = (n: number) => `${(n / total) * 100}%`;
  const rows = [
    { k: 'WIN', n: win.wins, cls: 'bg-gain', text: 'text-gain', share: decided ? pctOf(win.wins) : '0%' },
    { k: 'LOSS', n: win.losses, cls: 'bg-loss', text: 'text-loss', share: decided ? pctOf(win.losses) : '0%' },
    ...(win.excluded ? [{ k: 'EXCLUDED', n: win.excluded, cls: 'bg-slate-600', text: 'text-slate-400', share: `${win.excluded} not counted` }] : []),
  ];
  return (
    <div className="space-y-1.5">
      {label && <div className="text-2xs text-slate-500">{label}</div>}
      {rows.map((r) => (
        <div key={r.k} className="flex items-center gap-2">
          <span className={`w-[70px] shrink-0 text-2xs font-semibold tracking-wider ${r.text}`}>{r.k}</span>
          <span className="flex-1 h-3.5 bg-ink-800 rounded-sm overflow-hidden border border-line">
            <span className={`block h-full ${r.cls} transition-all duration-500`} style={{ width: r.n ? widthOf(r.n) : '0%' }} />
          </span>
          <span className="w-[92px] shrink-0 text-right text-2xs font-mono tabular-nums text-slate-300">
            {r.n} <span className="text-slate-500">{r.share}</span>
          </span>
        </div>
      ))}
      {openExcluded > 0 && (
        <div className="text-2xs text-slate-500 pt-0.5">
          + {openExcluded} open/unresolved position{openExcluded === 1 ? '' : 's'} excluded (never counted as a win or a loss)
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- windows ----
export const WINDOW_CHOICES = [10, 25, 50, 100, 250] as const;

export function WinRateWindows({ stats, active, onPick, primaryWindow = 100 }: {
  stats: PredictionStats; active?: number | 'all' | null; onPick?: (n: number | 'all') => void; primaryWindow?: number;
}) {
  const cells: { key: number | 'all'; label: string; win: PredictionWindow }[] = [
    ...WINDOW_CHOICES.map((n) => ({ key: n as number | 'all', label: `Last ${n}`, win: stats.windows[String(n)] || emptyWindow(n) })),
    { key: 'all', label: 'All time', win: stats.windows.all || emptyWindow(null) },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-line border border-line rounded-md overflow-hidden">
      {cells.map((c) => {
        const isActive = active === c.key || (active == null && c.key === primaryWindow);
        const conf = sampleConfidence(c.win.analyzed);
        return (
          <button key={String(c.key)} onClick={() => onPick?.(c.key)} disabled={!onPick}
            className={`bg-ink-850 px-3 py-2 text-left transition-colors ${onPick ? 'hover:bg-ink-800' : 'cursor-default'} ${isActive && onPick ? 'ring-1 ring-inset ring-accent/40' : ''}`}>
            <div className="flex items-center justify-between gap-1">
              <span className="text-2xs uppercase tracking-[0.12em] text-slate-500">{c.label}</span>
              {c.key === primaryWindow && <span className="text-[9px] px-1 rounded bg-accent/10 text-accent border border-accent/30 leading-3">PRIMARY</span>}
            </div>
            <div className={`font-mono text-xl tabular-nums mt-0.5 ${c.win.winRate == null ? 'text-slate-600' : c.win.winRate >= 0.5 ? 'text-gain' : 'text-loss'}`}>
              {c.win.winRate == null ? 'N/A' : ratePct(c.win.winRate)}
            </div>
            <div className="text-2xs text-slate-500 tabular-nums">
              {c.win.analyzed ? `${c.win.wins}W / ${c.win.losses}L` : 'no data'}
              {c.win.limited && c.key !== 'all' ? <span className="text-slate-600"> · only {c.win.analyzed}</span> : null}
            </div>
            <div className={`mt-1 inline-block text-[9px] px-1 rounded border leading-4 ${conf.cls}`}>{conf.label}</div>
          </button>
        );
      })}
    </div>
  );
}

const emptyWindow = (n: number | null): PredictionWindow => ({
  window: n, scanned: 0, analyzed: 0, wins: 0, losses: 0, excluded: 0, winRate: null, limited: n != null, pnl: null,
});

/**
 * Win rate and P&L side by side — never merged (a trader can be right often and still
 * lose money, or wrong often and still be profitable).
 */
export function AccuracyVsPnl({ stats }: { stats: PredictionStats }) {
  const p = stats.primary;
  const pnl = stats.totals.totalPnl;
  const rate = p.winRate;
  const profitable = pnl != null && pnl >= 0;
  const tension = rate != null && pnl != null && ((rate >= 0.55 && pnl < 0) || (rate < 0.45 && pnl > 0));
  return (
    <div className="grid grid-cols-2 gap-px bg-line border border-line rounded-md overflow-hidden">
      <div className="bg-ink-850 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-2xs uppercase tracking-[0.12em] text-slate-500">Prediction win rate <InfoTip /></div>
        <div className={`font-mono text-2xl tabular-nums mt-0.5 ${rate == null ? 'text-slate-600' : rate >= 0.5 ? 'text-gain' : 'text-loss'}`}>
          {rate == null ? 'N/A' : ratePct(rate)}
        </div>
        <div className="text-2xs text-slate-500">{p.analyzed ? `${p.wins} of ${p.analyzed} completed predictions correct` : 'nothing completed yet'}</div>
      </div>
      <div className="bg-ink-850 px-3 py-2.5">
        <div className="text-2xs uppercase tracking-[0.12em] text-slate-500">Trading P&amp;L</div>
        <div className={`font-mono text-2xl tabular-nums mt-0.5 ${pnl == null ? 'text-slate-600' : profitable ? 'text-gain' : 'text-loss'}`}>
          {pnl == null ? 'N/A' : `${profitable ? '+' : '−'}$${Math.abs(pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
        </div>
        <div className="text-2xs text-slate-500">
          tracked across {stats.totals.completed} completed predictions{stats.exclusions.openPositions ? ` · ${stats.exclusions.openPositions} open excluded` : ''}
        </div>
      </div>
      {tension && (
        <div className="col-span-2 bg-ink-800 px-3 py-1.5 text-2xs text-warn border-t border-line">
          ⚠ Being right more often and making money are different things here — high hit rate, negative P&amp;L (or the reverse) usually means
          small wins against one large loss, or a low hit rate with big winners.
        </div>
      )}
    </div>
  );
}
