import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { money, num, ratePct, signedMoney, timeAgo, isNum } from '../lib/format';
import type { PredictionStats, WinRatePayload } from '../lib/types';
import { Panel, Spinner } from './ui';
import { InfoTip } from './WinRate';

/**
 * Side-by-side: the number this app calculates vs the numbers Polymarket itself
 * publishes. Never merged, never silently overwritten — a discrepancy stays visible
 * and is explainable (spec 8/9).
 */
export function WinRateComparison({ address, stats, updatedAt }: { address: string; stats: PredictionStats | null; updatedAt?: number | null }) {
  const [data, setData] = useState<WinRatePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    apiFetch<WinRatePayload>(`/api/wallets/${address}/win-rate${refresh ? '?refresh=1' : ''}`)
      .then((r) => { setData(r); setError(null); })
      .catch((err) => setError((err as Error).message));
  }, [address]);

  useEffect(() => { load(); }, [load, updatedAt]);

  const reverify = async () => {
    setBusy(true);
    try {
      await apiFetch(`/api/wallets/${address}/predictions/rebuild`, { method: 'POST' });
      load(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ours = data?.comparison.independentlyCalculated ?? (stats ? {
    winRate: stats.primary.winRate, wins: stats.primary.wins, losses: stats.primary.losses,
    analyzed: stats.primary.analyzed, label: stats.primary.label,
  } : null);
  const theirs = data?.comparison.polymarketReported ?? null;
  const cross = data?.comparison.profitabilityCrossCheck ?? (stats?.profitability ? {
    label: stats.profitability.label, rate: stats.profitability.rate, wins: stats.profitability.wins,
    losses: stats.profitability.losses, flat: stats.profitability.flat, closed: stats.profitability.closed,
    note: 'Profitability of closed positions — not prediction accuracy.',
  } : null);
  const differs = isNum(ours?.winRate) && isNum(cross?.rate) && Math.abs((ours!.winRate ?? 0) - (cross?.rate ?? 0)) > 0.05;

  return (
    <Panel title="Independently calculated vs Polymarket reported" pad={false}
      right={
        <div className="flex items-center gap-2">
          {data && <span className="text-2xs text-slate-600 tabular-nums">calculated {timeAgo(data.stats.computedAt)} ago</span>}
          <button onClick={reverify} disabled={busy}
            className="px-2 py-0.5 text-2xs rounded border border-line bg-ink-700 hover:bg-ink-600 text-slate-300 disabled:opacity-50"
            title="Re-check the market resolutions behind these numbers and reclassify every prediction">
            {busy ? <span className="inline-flex items-center gap-1"><Spinner className="w-3 h-3" /> verifying…</span> : 'Re-verify'}
          </button>
        </div>
      }>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-px bg-line">
        {/* ours */}
        <div className="bg-ink-850 p-3">
          <div className="flex items-center gap-1.5 text-2xs uppercase tracking-[0.12em] text-accent">Independently calculated <InfoTip /></div>
          {!ours ? <div className="py-4"><Spinner /></div> : (
            <>
              <div className={`font-mono text-3xl tabular-nums leading-9 mt-1 ${ours.winRate == null ? 'text-slate-600' : ours.winRate >= 0.5 ? 'text-gain' : 'text-loss'}`}>
                {ours.winRate == null ? 'N/A' : ratePct(ours.winRate)}
              </div>
              <div className="text-2xs text-slate-500 mt-0.5">{ours.label}</div>
              <div className="text-2xs text-slate-500 mt-1 leading-4">
                {ours.wins} wins · {ours.losses} losses · {ours.analyzed + (stats?.primary.excluded ?? 0) > 0 ? `${num(stats?.primary.scanned ?? 0)} completed records scanned` : 'nothing scanned'}
              </div>
            </>
          )}
        </div>

        {/* theirs */}
        <div className="bg-ink-850 p-3">
          <div className="text-2xs uppercase tracking-[0.12em] text-slate-500">Polymarket reported</div>
          <div className="font-mono text-3xl tabular-nums leading-9 mt-1 text-slate-400">
            {theirs?.winRate == null ? 'N/A' : ratePct(theirs.winRate)}
          </div>
          <div className="text-2xs text-slate-500 mt-0.5 leading-4">
            {theirs?.unavailableReason
              || 'Compared against Polymarket’s published profile statistics.'}
          </div>
          {theirs && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
              <Row k="All-time P&L" v={isNum(theirs.pnl?.all) ? signedMoney(theirs.pnl!.all) : 'N/A'} />
              <Row k="30d P&L" v={isNum(theirs.pnl?.['30d']) ? signedMoney(theirs.pnl!['30d']) : 'N/A'} />
              <Row k="Volume" v={isNum(theirs.volume?.all) ? money(theirs.volume!.all) : 'N/A'} />
              <Row k="Markets traded" v={isNum(theirs.marketsTraded) ? num(theirs.marketsTraded) : 'N/A'} />
            </dl>
          )}
        </div>

        {/* the old, wrong interpretation — shown on purpose */}
        <div className="bg-ink-850 p-3">
          <div className="text-2xs uppercase tracking-[0.12em] text-slate-500" title={cross?.note || ''}>Profitable closed positions</div>
          <div className={`font-mono text-3xl tabular-nums leading-9 mt-1 ${!isNum(cross?.rate) ? 'text-slate-600' : 'text-slate-300'}`}>
            {isNum(cross?.rate) ? ratePct(cross.rate) : 'N/A'}
          </div>
          <div className="text-2xs text-slate-500 mt-0.5 leading-4">
            {cross ? `${cross.wins} of ${cross.wins + cross.losses + cross.flat} closed positions made money (${num(cross.closed)} closed records)` : 'no closed-position data yet'}
          </div>
          <div className="text-2xs text-slate-600 mt-1 leading-4">
            This is what a “win rate” based on realized P&amp;L looks like — it is <b>not</b> prediction accuracy and is never used as one.
          </div>
        </div>
      </div>

      {error && <div className="px-3 py-1.5 text-2xs text-loss border-t border-line">{error}</div>}
      {differs && (
        <div className="px-3 py-1.5 text-2xs text-warn/90 bg-warn/5 border-t border-line">
          ⚠ The profitability view above would report {ratePct(cross!.rate!)} while the trader’s actual prediction win rate is{' '}
          {ratePct(ours!.winRate!)} — the gap is why this app calculates win rate from market resolutions instead.
        </div>
      )}
      {data?.methodology && (
        <div className="px-3 py-2 text-2xs text-slate-500 border-t border-line leading-4">
          <b className="text-slate-400">Definition used everywhere:</b> {data.methodology.definition}
          {' '}Excluded: {data.methodology.excludes.join('; ')}. Never used: {data.methodology.neverUsed.join('; ')}.
        </div>
      )}
    </Panel>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-2 border-b border-line/50 pb-0.5">
    <dt className="text-slate-500">{k}</dt><dd className="font-mono tabular-nums text-slate-300">{v}</dd>
  </div>
);
