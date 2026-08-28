import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore, useNow } from '../lib/store';
import { apiFetch } from '../lib/api';
import { untrackLocal } from '../lib/tracked';
import { Avatar, StatusPill, SortHeader, EmptyState, ErrorState } from './ui';
import { InfoTip, WinRateCell } from './WinRate';
import { money, signedMoney, num, timeAgo, exactTime, displayName, ratePct } from '../lib/format';
import type { Wallet } from '../lib/types';

type SortKey = 'added' | 'winRate24h' | 'winRateAll' | 'winRate100' | 'trades24h' | 'pnl7d' | 'volume7d' | 'activePositions' | 'lastActivity';

const sortVal = (w: Wallet, k: SortKey): number => {
  const s = w.stats;
  const p = s?.predictions;
  switch (k) {
    case 'winRate24h': return p?.periods?.['24h']?.winRate ?? -1;
    case 'winRateAll': return p?.totals?.winRate ?? -1;
    case 'winRate100': return p?.primary?.winRate ?? -1;
    case 'trades24h': return s?.trades24h ?? -1;
    case 'pnl7d': return s?.api?.pnl?.['7d'] ?? Number.NEGATIVE_INFINITY;
    case 'volume7d': return s?.api?.volume?.['7d'] ?? s?.volume7d ?? Number.NEGATIVE_INFINITY;
    case 'activePositions': return s?.activePositions ?? -1;
    case 'lastActivity': return s?.lastActivityTs ?? -1;
    default: return w.addedAt;
  }
};

export function WalletTable() {
  const { wallets, walletsLoading, walletsError, refreshWallets } = useStore();
  const now = useNow(1000);
  const nav = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>('lastActivity');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const rows = [...wallets];
    rows.sort((a, b) => {
      const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
      return sortDir === 'desc' ? vb - va : va - vb;
    });
    return rows;
  }, [wallets, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(k); setSortDir('desc'); }
  };

  /** Remove a trader straight from the dashboard (history deleted server-side too). */
  const removeTrader = async (w: Wallet) => {
    const name = displayName(w);
    if (!window.confirm(`Stop tracking ${name}?\n\nAll synced history for this trader is deleted from this dashboard.`)) return;
    setRemoving(w.address);
    setConfirmDel(null);
    try {
      await apiFetch(`/api/wallets/${w.address}`, { method: 'DELETE' });
      untrackLocal(w.address);            // keep the browser from auto-re-adding it
      await refreshWallets();
      if (window.location.pathname.toLowerCase().includes(w.address.toLowerCase())) nav('/');
    } catch (err) {
      window.alert(`Could not remove ${name}: ${(err as Error).message}`);
    } finally {
      setRemoving(null);
    }
  };

  if (walletsLoading) return <div className="py-12 text-center text-slate-500 text-sm">Loading tracked traders…</div>;
  if (walletsError && !wallets.length) return <ErrorState message={walletsError} onRetry={refreshWallets} />;
  if (!wallets.length) {
    return <EmptyState title="No traders tracked yet"
      body={<>Click <b>+ Add Trader</b> and paste a Polymarket profile URL (e.g. <span className="font-mono">https://polymarket.com/profile/0x…</span>). Tracking starts immediately.</>} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[1080px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-3 py-2"><SortHeader label="Trader" active={sortKey === 'added'} dir={sortDir} onClick={() => toggleSort('added')} /></th>
            <th className="px-3 py-2 w-24">Status</th>
            <th className="px-3 py-2 text-right w-36">
              <span className="flex items-center justify-end gap-1">
                <span className="text-2xs uppercase tracking-[0.1em] text-slate-500">Win · Last 100</span>
                <InfoTip extra={<span className="block mt-1.5 text-slate-400">Each row uses the same engine as the trader page — no separate calculation per screen.</span>} />
              </span>
            </th>
            <th className="px-3 py-2 text-right w-32"><SortHeader label="Win · 24h" align="right" active={sortKey === 'winRate24h'} dir={sortDir} onClick={() => toggleSort('winRate24h')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="Win · All" align="right" active={sortKey === 'winRateAll'} dir={sortDir} onClick={() => toggleSort('winRateAll')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="24h Trades" align="right" active={sortKey === 'trades24h'} dir={sortDir} onClick={() => toggleSort('trades24h')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="7d P&L" align="right" active={sortKey === 'pnl7d'} dir={sortDir} onClick={() => toggleSort('pnl7d')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="7d Volume" align="right" active={sortKey === 'volume7d'} dir={sortDir} onClick={() => toggleSort('volume7d')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="Open" align="right" active={sortKey === 'activePositions'} dir={sortDir} onClick={() => toggleSort('activePositions')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="Last Activity" align="right" active={sortKey === 'lastActivity'} dir={sortDir} onClick={() => toggleSort('lastActivity')} /></th>
            <th className="px-3 py-2 w-9" aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {sorted.map((w) => {
            const s = w.stats;
            const p = s?.predictions;
            const pnl7 = s?.api?.pnl?.['7d'] ?? null;
            return (
              <tr key={w.address} onClick={() => nav(`/trader/${w.address}`)}
                className="cursor-pointer hover:bg-ink-800/70 transition-colors group">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar src={w.profileImage} name={displayName(w)} size={30} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Link to={`/trader/${w.address}`} onClick={(e) => e.stopPropagation()}
                          className="font-semibold text-slate-100 group-hover:text-accent truncate max-w-[180px]">
                          {displayName(w)}
                        </Link>
                        {w.verified && <span title="Verified" className="text-accent text-xs">✔</span>}
                      </div>
                      <div className="font-mono text-2xs text-slate-500">{w.address.slice(0, 10)}…{w.address.slice(-6)}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5"><StatusPill status={w.status} lastSuccess={w.lastSuccessAt} lastError={w.lastError} now={now} /></td>
                {/* primary win rate + sample size, always together */}
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                  {p ? (
                    <>
                      <WinRateCell win={p.primary} />
                      {p.primary.limited && p.primary.analyzed > 0 && (
                        <div className="text-[10px] text-slate-600 font-sans">only {p.primary.analyzed} completed</div>
                      )}
                    </>
                  ) : <span className="text-slate-600">syncing…</span>}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                  <WinRateCell win={p?.periods?.['24h'] ? { winRate: p.periods['24h'].winRate, wins: p.periods['24h'].wins, analyzed: p.periods['24h'].analyzed } : null} />
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                  <WinRateCell win={p?.windows?.all ? { winRate: p.windows.all.winRate, wins: p.windows.all.wins, analyzed: p.windows.all.analyzed } : null} />
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{s ? num(s.trades24h) : '—'}</td>
                <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${pnl7 == null ? 'text-slate-600' : pnl7 >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {pnl7 == null ? 'N/A' : signedMoney(pnl7)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">
                  {s ? money(s.api?.volume?.['7d'] ?? s.volume7d) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">
                  {s ? num(s.activePositions) : '—'}
                  {p && p.exclusions.openPositions > 0 ? <div className="text-[10px] text-slate-600 font-sans">excluded from win rate</div> : null}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className="text-xs text-slate-400 tabular-nums" title={s?.lastActivityTs ? exactTime(s.lastActivityTs) : 'No activity recorded'}>
                    {s?.lastActivityTs ? timeAgo(s.lastActivityTs, now) : '—'}
                  </span>
                </td>
                <td className="px-2 py-2.5 text-right">
                  {confirmDel === w.address ? (
                    <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => removeTrader(w)} disabled={removing === w.address}
                        className="px-1.5 py-0.5 rounded text-2xs font-semibold bg-loss/15 border border-loss/40 text-loss hover:bg-loss/25 disabled:opacity-50">
                        {removing === w.address ? 'Removing…' : 'Confirm'}
                      </button>
                      <button onClick={() => setConfirmDel(null)} className="px-1.5 py-0.5 rounded text-2xs border border-line text-slate-400 hover:text-slate-200">Cancel</button>
                    </span>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDel(w.address); }} disabled={removing === w.address}
                      title={`Stop tracking ${displayName(w)}`} aria-label={`Remove ${displayName(w)}`}
                      className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded border border-line text-slate-500 hover:text-loss hover:border-loss/40 disabled:opacity-40">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-3 py-2 border-t border-line text-2xs text-slate-600">
        Win rate = share of the trader’s most recent <b className="text-slate-500">completed</b> predictions whose market resolved in their favour.
        Open positions, unresolved markets and double-counted fills are excluded — click a row for the full audit trail.
      </div>
    </div>
  );
}

/** Used by the dashboard summary strip. */
export const winRateLabel = (v: number | null | undefined) => (v == null ? 'N/A' : ratePct(v));
