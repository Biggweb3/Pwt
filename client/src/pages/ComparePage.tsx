import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useStore, useNow } from '../lib/store';
import { Avatar, Panel, SortHeader, EmptyState, Spinner, StatusPill } from '../components/ui';
import { InfoTip, WinRateCell } from '../components/WinRate';
import { money, signedMoney, ratePct, num, timeAgo, isNum } from '../lib/format';

interface CompareRow {
  address: string; username: string | null; profileImage: string | null; status: string;
  lastActivityTs: number | null;
  /** win rate over the trader's most recent 100 completed predictions (shared engine) */
  winRate: number | null; winRateWins: number; winRateLosses: number; winRateAnalyzed: number; winRateLabel: string;
  winRate24h: number | null; winRate24hN: number;
  winRate7d: number | null; winRate7dN: number;
  winRateAll: number | null; winRateAllN: number;
  openExcluded: number; pendingResolutions: number;
  /** separate metric — profitable closed positions, never presented as a win rate */
  profitabilityRate: number | null; profitabilityN: number;
  trades24h: number | null; trades7d: number | null;
  volume24h: number | null; volume7d: number | null; volumeAll: number | null;
  pnl24h: number | null; pnl7d: number | null; pnlAll: number | null; predictionPnl: number | null;
  activePositions: number | null; openValue: number | null;
}

type SortKey =
  | 'winRate' | 'winRateAnalyzed' | 'winRate24h' | 'winRate7d' | 'winRateAll' | 'profitabilityRate'
  | 'trades24h' | 'trades7d' | 'volume7d' | 'pnl24h' | 'pnl7d' | 'pnlAll' | 'predictionPnl'
  | 'activePositions' | 'lastActivityTs';

export function ComparePage() {
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('winRate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const now = useNow(1000);

  const load = () => apiFetch<{ rows: CompareRow[] }>('/api/compare').then((r) => setRows(r.rows)).catch(() => setRows([]));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const v = (r: CompareRow): number => {
      const x = (r as unknown as Record<string, unknown>)[sortKey];
      return isNum(x) ? (x as number) : Number.NEGATIVE_INFINITY;
    };
    return [...rows].sort((a, b) => (sortDir === 'desc' ? v(b) - v(a) : v(a) - v(b)));
  }, [rows, sortKey, sortDir]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(k); setSortDir('desc'); }
  };

  if (!sorted) return <div className="py-16 text-center"><Spinner className="w-6 h-6 mx-auto" /></div>;
  if (!sorted.length) return <Panel title="Trader Comparison"><EmptyState title="Nothing to compare" body="Add at least one trader on the dashboard first." /></Panel>;

  const head = (label: string, key: SortKey, extra?: React.ReactNode, cls = 'px-3 py-2 text-right') => (
    <th className={cls}>
      <span className="flex items-center justify-end gap-1">
        <SortHeader label={label} align="right" active={sortKey === key} dir={sortDir} onClick={() => toggle(key)} />
        {extra}
      </span>
    </th>
  );

  return (
    <div className="space-y-4">
      <Panel title="Trader Comparison" pad={false}
        right={<span className="text-2xs text-slate-500">{sorted.length} traders · win rates are independently calculated from completed predictions · P&amp;L / volume from the Polymarket API</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1150px]">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-3 py-2 text-2xs uppercase tracking-wider text-slate-500 font-semibold">Trader</th>
                <th className="px-3 py-2 w-20 text-2xs uppercase tracking-wider text-slate-500 font-semibold">Status</th>
                {head('Win Rate · Last 100', 'winRate', <InfoTip />)}
                {head('Sample', 'winRateAnalyzed', undefined, 'px-3 py-2 text-right w-24')}
                {head('Win · 24h', 'winRate24h')}
                {head('Win · 7d', 'winRate7d')}
                {head('Win · All', 'winRateAll')}
                {head('Profitable pos.', 'profitabilityRate')}
                {head('24h Trades', 'trades24h')}
                {head('7d Trades', 'trades7d')}
                {head('7d Volume', 'volume7d')}
                {head('24h P&L', 'pnl24h')}
                {head('7d P&L', 'pnl7d')}
                {head('All P&L', 'pnlAll')}
                {head('Active Pos.', 'activePositions')}
                {head('Last Activity', 'lastActivityTs')}
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {sorted.map((r) => (
                <tr key={r.address} className="hover:bg-ink-800/60">
                  <td className="px-3 py-2.5">
                    <Link to={`/trader/${r.address}`} className="flex items-center gap-2 group min-w-0">
                      <Avatar src={r.profileImage} name={r.username} size={26} />
                      <span className="font-semibold text-slate-100 group-hover:text-accent truncate max-w-[170px]">
                        {r.username || `${r.address.slice(0, 10)}…`}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5"><StatusPill status={r.status as never} now={now} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    <WinRateCell win={{ winRate: r.winRate, wins: r.winRateWins, losses: r.winRateLosses, analyzed: r.winRateAnalyzed }} />
                    <div className="text-[10px] text-slate-600 font-sans" title={r.winRateLabel}>{r.winRateLabel}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-2xs tabular-nums text-slate-500">
                    {num(r.winRateAnalyzed)}
                    {r.openExcluded ? <div className="text-slate-600">{num(r.openExcluded)} open excl.</div> : null}
                    {r.pendingResolutions ? <div className="text-warn/70">{num(r.pendingResolutions)} verifying</div> : null}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums"><SampleCell rate={r.winRate24h} n={r.winRate24hN} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums"><SampleCell rate={r.winRate7d} n={r.winRate7dN} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums"><SampleCell rate={r.winRateAll} n={r.winRateAllN} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-400"
                    title="Closed positions with positive realized P&L — deliberately NOT the win rate">
                    {isNum(r.profitabilityRate) ? ratePct(r.profitabilityRate) : 'N/A'}
                    <span className="text-slate-600 font-sans"> · {num(r.profitabilityN)}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{num(r.trades24h)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{num(r.trades7d)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{money(r.volume7d)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums"><PnlCell v={r.pnl24h} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums"><PnlCell v={r.pnl7d} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    <PnlCell v={r.pnlAll} />
                    {isNum(r.predictionPnl) && <div className="text-[10px] text-slate-600 font-sans">{signedMoney(r.predictionPnl)} on completed predictions</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{num(r.activePositions)}</td>
                  <td className="px-3 py-2.5 text-right text-xs text-slate-400 tabular-nums">{r.lastActivityTs ? timeAgo(r.lastActivityTs, now) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="text-2xs text-slate-600 leading-5">
        <b className="text-slate-500">Win Rate</b> = wins ÷ (wins + losses) over each trader’s most recent completed predictions whose market has a verified
        resolution. The <b className="text-slate-500">Sample</b> column shows how many predictions were classified; open positions and unresolved markets are
        excluded and listed separately, never padded.{' '}
        <b className="text-slate-500">Profitable pos.</b> is displayed only for contrast — it comes from realized P&amp;L and is never used as a win rate.
        P&amp;L and volume are Polymarket API values (<span className="font-mono">api</span>); win rates are <span className="font-mono">calculated</span> from
        synced public trade and resolution data.
      </div>
    </div>
  );
}

/** rate with its sample size, always together */
const SampleCell = ({ rate, n }: { rate: number | null; n: number }) => (
  isNum(rate)
    ? <span className={rate >= 0.5 ? 'text-gain' : 'text-loss'}>{ratePct(rate)}<span className="text-slate-600 font-sans"> · {num(n)}</span></span>
    : <span className="text-slate-500">N/A<span className="text-slate-600 font-sans"> · {num(n)}</span></span>
);

const PnlCell = ({ v }: { v: number | null }) => (
  v == null ? <span className="text-slate-600">N/A</span> : <span className={v >= 0 ? 'text-gain' : 'text-loss'}>{signedMoney(v)}</span>
);
