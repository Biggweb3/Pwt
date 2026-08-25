import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useEffect } from 'react';
import { useStore, useNow } from '../lib/store';
import { Avatar, Panel, SortHeader, EmptyState, Spinner, StatusPill } from '../components/ui';
import { money, signedMoney, pct, num, timeAgo, isNum } from '../lib/format';

interface CompareRow {
  address: string; username: string | null; profileImage: string | null; status: string;
  lastActivityTs: number | null;
  winRate24h: number | null; winRate7d: number | null; winRateAll: number | null;
  trades24h: number; trades7d: number;
  volume24h: number | null; volume7d: number | null; volumeAll: number | null;
  pnl24h: number | null; pnl7d: number | null; pnlAll: number | null;
  activePositions: number; openValue: number | null;
}

type SortKey = 'winRate24h' | 'winRate7d' | 'winRateAll' | 'trades24h' | 'trades7d' | 'volume7d' | 'pnl7d' | 'pnlAll' | 'activePositions' | 'lastActivityTs';

export function ComparePage() {
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('pnl7d');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const now = useNow(1000);
  const { wallets } = useStore();

  const load = () => apiFetch<{ rows: CompareRow[] }>('/api/compare').then((r) => setRows(r.rows)).catch(() => setRows([]));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const v = (r: CompareRow): number => {
      const x = r[sortKey];
      return isNum(x) ? x : Number.NEGATIVE_INFINITY;
    };
    return [...rows].sort((a, b) => (sortDir === 'desc' ? v(b) - v(a) : v(a) - v(b)));
  }, [rows, sortKey, sortDir]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(k); setSortDir('desc'); }
  };

  if (!sorted) return <div className="py-16 text-center"><Spinner className="w-6 h-6 mx-auto" /></div>;
  if (!sorted.length) return <Panel title="Trader Comparison"><EmptyState title="Nothing to compare" body="Add at least one trader on the dashboard first." /></Panel>;

  return (
    <Panel title="Trader Comparison" pad={false}
      right={<span className="text-2xs text-slate-500">{sorted.length} traders · click headers to sort · P&L and volume windows from Polymarket API</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[1150px]">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-3 py-2 text-2xs uppercase tracking-wider text-slate-500 font-semibold">Trader</th>
              <th className="px-3 py-2 w-20 text-2xs uppercase tracking-wider text-slate-500 font-semibold">Status</th>
              <th className="px-3 py-2 text-right"><SortHeader label="24h Win" align="right" active={sortKey === 'winRate24h'} dir={sortDir} onClick={() => toggle('winRate24h')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="7d Win" align="right" active={sortKey === 'winRate7d'} dir={sortDir} onClick={() => toggle('winRate7d')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="All Win" align="right" active={sortKey === 'winRateAll'} dir={sortDir} onClick={() => toggle('winRateAll')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="24h Trades" align="right" active={sortKey === 'trades24h'} dir={sortDir} onClick={() => toggle('trades24h')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="7d Trades" align="right" active={sortKey === 'trades7d'} dir={sortDir} onClick={() => toggle('trades7d')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="7d Volume" align="right" active={sortKey === 'volume7d'} dir={sortDir} onClick={() => toggle('volume7d')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="24h P&L" align="right" active={sortKey === 'pnl24h' as SortKey} dir={sortDir} onClick={() => toggle('pnl24h' as SortKey)} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="7d P&L" align="right" active={sortKey === 'pnl7d'} dir={sortDir} onClick={() => toggle('pnl7d')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="All P&L" align="right" active={sortKey === 'pnlAll'} dir={sortDir} onClick={() => toggle('pnlAll')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="Active Pos." align="right" active={sortKey === 'activePositions'} dir={sortDir} onClick={() => toggle('activePositions')} /></th>
              <th className="px-3 py-2 text-right"><SortHeader label="Last Activity" align="right" active={sortKey === 'lastActivityTs'} dir={sortDir} onClick={() => toggle('lastActivityTs')} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {sorted.map((r) => (
              <tr key={r.address} className="hover:bg-ink-800/60">
                <td className="px-3 py-2.5">
                  <Link to={`/trader/${r.address}`} className="flex items-center gap-2 group min-w-0">
                    <Avatar src={r.profileImage} name={r.username} size={26} />
                    <span className="font-semibold text-slate-100 group-hover:text-accent truncate max-w-[170px]">{r.username || `${r.address.slice(0, 10)}…`}</span>
                  </Link>
                </td>
                <td className="px-3 py-2.5"><StatusPill status={r.status as never} now={now} /></td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{PctCell(r.winRate24h)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{PctCell(r.winRate7d)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{PctCell(r.winRateAll)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{num(r.trades24h)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{num(r.trades7d)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{money(r.volume7d)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{PnlCell(r.pnl24h)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{PnlCell(r.pnl7d)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{PnlCell(r.pnlAll)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{num(r.activePositions)}</td>
                <td className="px-3 py-2.5 text-right text-xs text-slate-400 tabular-nums">{r.lastActivityTs ? timeAgo(r.lastActivityTs, now) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

const PctCell = (v: number | null) =>
  v == null ? <span className="text-slate-600">N/A</span> : <span className={v >= 0.5 ? 'text-gain' : 'text-loss'}>{pct(v)}</span>;

const PnlCell = (v: number | null) =>
  v == null ? <span className="text-slate-600">N/A</span> : <span className={v >= 0 ? 'text-gain' : 'text-loss'}>{signedMoney(v)}</span>;
