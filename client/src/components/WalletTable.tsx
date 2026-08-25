import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore, useNow } from '../lib/store';
import { Avatar, StatusPill, SortHeader, EmptyState, ErrorState } from './ui';
import { money, signedMoney, pct, num, timeAgo, exactTime, displayName } from '../lib/format';
import type { Wallet } from '../lib/types';

type SortKey = 'added' | 'winRate24h' | 'winRateAll' | 'trades24h' | 'pnl7d' | 'volume7d' | 'activePositions' | 'lastActivity';

const sortVal = (w: Wallet, k: SortKey): number => {
  const s = w.stats;
  switch (k) {
    case 'winRate24h': return s?.winRate24h ?? -1;
    case 'winRateAll': return s?.winRateAll ?? -1;
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

  if (walletsLoading) return <div className="py-12 text-center text-slate-500 text-sm">Loading tracked traders…</div>;
  if (walletsError && !wallets.length) return <ErrorState message={walletsError} onRetry={refreshWallets} />;
  if (!wallets.length) {
    return <EmptyState title="No traders tracked yet"
      body={<>Click <b>+ Add Trader</b> and paste a Polymarket profile URL (e.g. <span className="font-mono">https://polymarket.com/profile/0x…</span>). Tracking starts immediately.</>} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[980px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-3 py-2"><SortHeader label="Trader" active={sortKey === 'added'} dir={sortDir} onClick={() => toggleSort('added')} /></th>
            <th className="px-3 py-2 w-24">Status</th>
            <th className="px-3 py-2 text-right"><SortHeader label="24h Win" align="right" active={sortKey === 'winRate24h'} dir={sortDir} onClick={() => toggleSort('winRate24h')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="All-time Win" align="right" active={sortKey === 'winRateAll'} dir={sortDir} onClick={() => toggleSort('winRateAll')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="24h Trades" align="right" active={sortKey === 'trades24h'} dir={sortDir} onClick={() => toggleSort('trades24h')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="7d P&L" align="right" active={sortKey === 'pnl7d'} dir={sortDir} onClick={() => toggleSort('pnl7d')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="7d Volume" align="right" active={sortKey === 'volume7d'} dir={sortDir} onClick={() => toggleSort('volume7d')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="Active Pos." align="right" active={sortKey === 'activePositions'} dir={sortDir} onClick={() => toggleSort('activePositions')} /></th>
            <th className="px-3 py-2 text-right"><SortHeader label="Last Activity" align="right" active={sortKey === 'lastActivity'} dir={sortDir} onClick={() => toggleSort('lastActivity')} /></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {sorted.map((w) => {
            const s = w.stats;
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
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{pct(s?.winRate24h)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{pct(s?.winRateAll)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{s ? num(s.trades24h) : '—'}</td>
                <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${pnl7 == null ? 'text-slate-600' : pnl7 >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {pnl7 == null ? 'N/A' : signedMoney(pnl7)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">
                  {s ? money(s.api?.volume?.['7d'] ?? s.volume7d) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{s ? num(s.activePositions) : '—'}</td>
                <td className="px-3 py-2.5 text-right">
                  <span className="text-xs text-slate-400 tabular-nums" title={s?.lastActivityTs ? exactTime(s.lastActivityTs) : 'No activity recorded'}>
                    {s?.lastActivityTs ? timeAgo(s.lastActivityTs, now) : '—'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
