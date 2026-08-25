import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch, ApiError } from '../lib/api';
import { useStore, useNow } from '../lib/store';
import { Avatar, Metric, Panel, SideBadge, OutcomeBadge, StatusPill, TypeBadge, UpdatedAgo, Spinner, EmptyState, ErrorState } from '../components/ui';
import { PerfChart } from '../components/PerfChart';
import { money, signedMoney, pct, num, shares, price, timeAgo, exactTime, displayName, shortAddr, PERIOD_LABELS, isNum } from '../lib/format';
import type { ActivityRow, ClosedPosition, Position, Trade, Wallet, WalletStats, WindowSummary } from '../lib/types';

const PERIOD_SECONDS: Record<string, number | null> = { '24h': 86400, '72h': 259200, '7d': 604800, '30d': 2592000, all: null };

export function TraderPage() {
  const { address = '' } = useParams();
  const nav = useNavigate();
  const { refreshWallets } = useStore();
  const now = useNow(1000);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [overview, setOverview] = useState<(WalletStats & { api?: unknown }) | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState('7d');
  const [summary, setSummary] = useState<WindowSummary | null>(null);
  const [chart, setChart] = useState<{ kind: 'pnl' | 'volume'; points: { ts: number; v: number }[] } | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ wallet: Wallet; overview: WalletStats }>(`/api/wallets/${address}`);
      setWallet(r.wallet);
      setOverview(r.overview);
      setNotFound(false);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setLoadError((err as Error).message);
    }
  }, [address]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    apiFetch<WindowSummary>(`/api/wallets/${address}/summary/${period}`).then(setSummary).catch(() => setSummary(null));
    apiFetch<{ kind: 'pnl' | 'volume'; points: { ts: number; v: number }[] }>(`/api/wallets/${address}/chart?period=${period}`).then(setChart).catch(() => setChart(null));
  }, [address, period]);

  const remove = async () => {
    if (!wallet) return;
    if (!confirm(`Stop tracking ${displayName(wallet)}? Stored history will be deleted.`)) return;
    setRemoving(true);
    try {
      await apiFetch(`/api/wallets/${address}`, { method: 'DELETE' });
      refreshWallets();
      nav('/');
    } catch { setRemoving(false); }
  };

  const resync = () => { apiFetch(`/api/wallets/${address}/resync`, { method: 'POST' }).catch(() => {}); };

  if (notFound) return <ErrorState message="This wallet is not tracked." onRetry={() => nav('/')} />;
  if (!wallet) return <div className="py-16 text-center">{loadError ? <ErrorState message={loadError} onRetry={load} /> : <Spinner className="w-6 h-6 mx-auto" />}</div>;

  const s = overview;
  const api = s?.api ?? null;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------- header --- */}
      <div className="bg-ink-850 border border-line rounded-md p-4 flex flex-wrap items-center gap-4">
        <Avatar src={wallet.profileImage} name={displayName(wallet)} size={52} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-slate-100 truncate">{displayName(wallet)}</h1>
            {wallet.verified && <span className="text-accent text-sm" title="Verified">✔</span>}
            <StatusPill status={wallet.status} lastSuccess={wallet.lastSuccessAt} lastError={wallet.lastError} now={now} />
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="font-mono text-2xs text-slate-500" title={wallet.address}>{shortAddr(wallet.address, 10, 8)}</span>
            <a href={wallet.profileUrl} target="_blank" rel="noreferrer" className="text-2xs text-accent hover:underline">polymarket.com ↗</a>
            <UpdatedAgo ts={wallet.lastSuccessAt} />
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {wallet.lastError && wallet.status === 'error' && (
            <span className="text-2xs text-loss max-w-[260px] truncate" title={wallet.lastError}>⚠ {wallet.lastError}</span>
          )}
          <button onClick={resync} className="px-2.5 py-1.5 text-xs rounded border border-line bg-ink-700 hover:bg-ink-600 text-slate-200">Sync now</button>
          <button onClick={remove} disabled={removing}
            className="px-2.5 py-1.5 text-xs rounded border border-loss/30 bg-loss/10 hover:bg-loss/20 text-loss disabled:opacity-50">
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------- periods ----- */}
      <div className="flex items-center gap-1">
        {Object.entries(PERIOD_LABELS).map(([k, label]) => (
          <button key={k} onClick={() => setPeriod(k)}
            className={`px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${period === k ? 'bg-accent/15 border-accent/50 text-accent' : 'bg-ink-850 border-line text-slate-400 hover:text-slate-200'}`}>
            {label}
          </button>
        ))}
        <span className="ml-auto text-2xs text-slate-600 hidden sm:block">
          win rate derived from positions closed in period · open positions never counted as wins/losses
        </span>
      </div>

      {/* ---------------------------------------------------- metrics ----- */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-line border border-line rounded-md overflow-hidden">
        <Cell>
          <Metric label="Win Rate" value={summary ? pct(summary.win.winRate) : '…'} tone={summary?.win.winRate == null ? 'muted' : summary.win.winRate >= 0.5 ? 'gain' : 'loss'} source="calculated"
            sub={summary ? `${summary.win.wins}W / ${summary.win.losses}L${summary.win.flat ? ` / ${summary.win.flat} flat` : ''}` : ''} />
        </Cell>
        <Cell><Metric label="Trades" value={summary ? num(summary.trades.trades) : '…'} source="synced" sub={summary ? `${summary.trades.buys} buys · ${summary.trades.sells} sells` : ''} /></Cell>
        <Cell><Metric label="Volume" value={summary ? money(summary.apiVolume ?? summary.trades.volume) : '…'} source={summary?.apiVolume != null ? 'api' : 'calculated'} /></Cell>
        <Cell>
          <Metric label="Realized P&L" value={summary ? (isNum(summary.apiPnl) ? signedMoney(summary.apiPnl) : signedMoney(summary.win.realizedPnl)) : '…'}
            tone={summary && isNum(summary.apiPnl ?? summary.win.realizedPnl) ? ((summary.apiPnl ?? summary.win.realizedPnl)! >= 0 ? 'gain' : 'loss') : 'muted'}
            source={summary?.apiPnl != null ? 'api' : 'calculated'} />
        </Cell>
        <Cell><Metric label="Active Positions" value={summary ? num(summary.positions.activePositions) : '…'} source="api" sub={summary?.positions.openValue != null ? `${money(summary.positions.openValue)} open value` : undefined} /></Cell>
        <Cell><Metric label="Resolved Positions" value={summary ? num(summary.win.closedInWindow) : '…'} source="api" sub="closed in period" /></Cell>
      </div>

      {/* ------------------------------------------------- extra stats ---- */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line rounded-md overflow-hidden">
        <Cell><Metric label="Avg Trade Size" value={summary ? money(summary.trades.avgTradeSize) : '…'} source="calculated" /></Cell>
        <Cell><Metric label="Largest Trade" value={summary ? money(summary.trades.largestTrade) : '…'} source="calculated" /></Cell>
        <Cell><Metric label="Markets Traded" value={summary ? num(summary.trades.markets) : '…'} source="calculated" sub={api && (api as { marketsTraded?: number | null }).marketsTraded != null ? `all-time: ${num((api as { marketsTraded?: number | null }).marketsTraded)} (api)` : undefined} /></Cell>
        <Cell>
          <Metric label="All-time P&L" value={api && isNum((api as { pnl?: Record<string, number | null> }).pnl?.all) ? signedMoney((api as { pnl?: Record<string, number | null> }).pnl!.all) : 'N/A'}
            tone={api && isNum((api as { pnl?: Record<string, number | null> }).pnl?.all) ? ((api as { pnl?: Record<string, number | null> }).pnl!.all! >= 0 ? 'gain' : 'loss') : 'muted'} source="api"
            sub={api && isNum((api as { volume?: Record<string, number | null> }).volume?.all) ? `all-time volume ${money((api as { volume?: Record<string, number | null> }).volume!.all)}` : undefined} />
        </Cell>
      </div>

      {/* ------------------------------------------------------- chart ---- */}
      <Panel title="Performance" right={<span className="text-2xs text-slate-500">{PERIOD_LABELS[period]}</span>}>
        {chart ? <PerfChart points={chart.points} kind={chart.kind} /> : <div className="h-[180px] grid place-items-center"><Spinner /></div>}
      </Panel>

      <div className="grid xl:grid-cols-2 gap-4 items-start">
        <PositionsPanel address={address} />
        <ActivityPanel address={address} />
      </div>

      <TradesPanel address={address} />

      {/* ----------------------------------------------------- meta ------- */}
      <div className="text-2xs text-slate-600 leading-5 border-t border-line pt-3">
        First observed activity: {s?.firstObservedTs ? exactTime(s.firstObservedTs) : 'Unavailable'} · Most recent activity:{' '}
        {s?.lastActivityTs ? exactTime(s.lastActivityTs) : 'Unavailable'} · Sync window: {wallet.oldestTradeTs ? `from ${exactTime(wallet.oldestTradeTs)}` : 'n/a'}{' '}
        {wallet.historyComplete ? '(full history)' : '(bounded backfill — all-time totals use Polymarket API)'} · Data: public Polymarket APIs only.
      </div>
    </div>
  );
}

const Cell = ({ children }: { children: React.ReactNode }) => <div className="bg-ink-850 px-4 py-3">{children}</div>;

// ===========================================================================
function PositionsPanel({ address }: { address: string }) {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [rows, setRows] = useState<Position[] | ClosedPosition[] | null>(null);

  useEffect(() => {
    setRows(null);
    apiFetch<{ positions: Position[] | ClosedPosition[] }>(`/api/wallets/${address}/positions?kind=${tab}`)
      .then((r) => setRows(r.positions))
      .catch(() => setRows([]));
  }, [address, tab]);

  return (
    <Panel pad={false} title="Positions"
      right={
        <div className="flex gap-1">
          {(['open', 'closed'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2 py-0.5 text-2xs font-semibold rounded border ${tab === t ? 'bg-accent/15 border-accent/40 text-accent' : 'border-line text-slate-500 hover:text-slate-300'}`}>
              {t === 'open' ? 'ACTIVE' : 'RESOLVED'}
            </button>
          ))}
        </div>
      }>
      {!rows ? <div className="p-6 text-center"><Spinner /></div> : rows.length === 0 ? (
        <EmptyState title={tab === 'open' ? 'No open positions' : 'No resolved positions in sync window'} />
      ) : tab === 'open' ? (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead className="sticky top-0 bg-ink-800">
              <tr className="text-left text-2xs uppercase tracking-wider text-slate-500 border-b border-line">
                <th className="px-3 py-2">Market</th><th className="px-2 py-2">Outcome</th>
                <th className="px-2 py-2 text-right">Shares</th><th className="px-2 py-2 text-right">Avg Entry</th>
                <th className="px-2 py-2 text-right">Current</th><th className="px-2 py-2 text-right">Value</th>
                <th className="px-2 py-2 text-right">Unrealized P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {(rows as Position[]).map((p, i) => (
                <tr key={i} className="hover:bg-ink-800/60">
                  <td className="px-3 py-2 max-w-[220px] truncate text-slate-300" title={p.title || ''}>{p.title || '—'}</td>
                  <td className="px-2 py-2"><OutcomeBadge outcome={p.outcome} /></td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">{shares(p.size)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">{price(p.avg_price)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">{price(p.cur_price)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-200">{money(p.current_value)}</td>
                  <td className={`px-2 py-2 text-right font-mono tabular-nums ${isNum(p.cash_pnl) ? (p.cash_pnl >= 0 ? 'text-gain' : 'text-loss') : 'text-slate-600'}`}>
                    {isNum(p.cash_pnl) ? `${signedMoney(p.cash_pnl)}${isNum(p.percent_pnl) ? ` (${p.percent_pnl >= 0 ? '+' : ''}${p.percent_pnl.toFixed(1)}%)` : ''}` : 'N/A'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead className="sticky top-0 bg-ink-800">
              <tr className="text-left text-2xs uppercase tracking-wider text-slate-500 border-b border-line">
                <th className="px-3 py-2">Market</th><th className="px-2 py-2">Outcome</th>
                <th className="px-2 py-2 text-right">Cost</th><th className="px-2 py-2 text-right">Realized P&L</th>
                <th className="px-2 py-2 text-right">Closed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {(rows as ClosedPosition[]).map((p, i) => (
                <tr key={i} className="hover:bg-ink-800/60">
                  <td className="px-3 py-2 max-w-[240px] truncate text-slate-300" title={p.title || ''}>{p.title || '—'}</td>
                  <td className="px-2 py-2"><OutcomeBadge outcome={p.outcome} /></td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">{money(p.total_bought)}</td>
                  <td className={`px-2 py-2 text-right font-mono tabular-nums ${isNum(p.realized_pnl) ? (p.realized_pnl >= 0 ? 'text-gain' : 'text-loss') : 'text-slate-600'}`}>
                    {isNum(p.realized_pnl) ? signedMoney(p.realized_pnl) : 'N/A'}
                  </td>
                  <td className="px-2 py-2 text-right text-slate-500 tabular-nums" title={p.ts ? exactTime(p.ts) : ''}>{p.ts ? timeAgo(p.ts) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ===========================================================================
function ActivityPanel({ address }: { address: string }) {
  const now = useNow(1000);
  const [filter, setFilter] = useState('ALL');
  const [range, setRange] = useState('all');
  const [rows, setRows] = useState<ActivityRow[] | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: '80' });
    if (filter === 'BUYS') p.set('side', 'BUY');
    if (filter === 'SELLS') p.set('side', 'SELL');
    if (filter === 'REDEEMS') p.set('type', 'REDEEM');
    const secs = PERIOD_SECONDS[range];
    if (secs) p.set('from', String(Math.floor(Date.now() / 1000) - secs));
    return p.toString();
  }, [filter, range]);

  useEffect(() => {
    setRows(null);
    apiFetch<{ activity: ActivityRow[] }>(`/api/wallets/${address}/activity?${params}`)
      .then((r) => setRows(r.activity))
      .catch(() => setRows([]));
    const t = setInterval(() => {
      apiFetch<{ activity: ActivityRow[] }>(`/api/wallets/${address}/activity?${params}`).then((r) => setRows(r.activity)).catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [address, params]);

  return (
    <Panel pad={false} title="Recent Activity"
      right={
        <div className="flex gap-1 flex-wrap justify-end">
          {['ALL', 'BUYS', 'SELLS', 'REDEEMS'].map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-2 py-0.5 text-2xs font-semibold rounded border ${filter === f ? 'bg-accent/15 border-accent/40 text-accent' : 'border-line text-slate-500 hover:text-slate-300'}`}>{f}</button>
          ))}
          <select value={range} onChange={(e) => setRange(e.target.value)}
            className="bg-ink-900 border border-line rounded text-2xs text-slate-400 px-1 py-0.5 focus:outline-none">
            {Object.entries(PERIOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      }>
      {!rows ? <div className="p-6 text-center"><Spinner /></div> : rows.length === 0 ? (
        <EmptyState title="No activity for this filter" />
      ) : (
        <ul className="divide-y divide-line/60 max-h-[430px] overflow-y-auto">
          {rows.map((a, i) => (
            <li key={`${a.tx_hash || i}-${i}`} className="px-3 py-2 hover:bg-ink-800/60">
              <div className="flex items-center gap-1.5 flex-wrap">
                {a.type === 'TRADE' ? <><SideBadge side={a.side} /><OutcomeBadge outcome={a.outcome} /></> : <TypeBadge type={a.type} />}
                {a.type === 'TRADE' && isNum(a.price) && <span className="font-mono text-2xs text-slate-400">@ {price(a.price)}</span>}
                {isNum(a.shares) && <span className="font-mono text-2xs text-slate-400">{shares(a.shares)} sh</span>}
                {isNum(a.usdc) && <span className="font-mono text-xs text-slate-200 tabular-nums ml-auto">{money(a.usdc)}</span>}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="text-2xs text-slate-400 truncate flex-1" title={a.title || ''}>{a.title || '—'}</span>
                <span className="text-2xs text-slate-600 tabular-nums shrink-0 cursor-default" title={exactTime(a.ts)}>{timeAgo(a.ts, now)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ===========================================================================
function TradesPanel({ address }: { address: string }) {
  const [page, setPage] = useState(1);
  const [side, setSide] = useState('');
  const [range, setRange] = useState('all');
  const [data, setData] = useState<{ trades: Trade[]; total: number; pages: number } | null>(null);
  const now = useNow(5000);

  const params = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '10' });
    if (side) p.set('side', side);
    const secs = PERIOD_SECONDS[range];
    if (secs) p.set('from', String(Math.floor(Date.now() / 1000) - secs));
    return p.toString();
  }, [page, side, range]);

  useEffect(() => {
    apiFetch<{ trades: Trade[]; total: number; pages: number }>(`/api/wallets/${address}/trades?${params}`)
      .then(setData)
      .catch(() => setData({ trades: [], total: 0, pages: 1 }));
    const t = setInterval(() => {
      apiFetch<{ trades: Trade[]; total: number; pages: number }>(`/api/wallets/${address}/trades?${params}`).then(setData).catch(() => {});
    }, 12000);
    return () => clearInterval(t);
  }, [address, params]);

  useEffect(() => { setPage(1); }, [side, range]);

  return (
    <Panel pad={false} title="Recent Bets / Trades"
      right={
        <div className="flex gap-1 flex-wrap justify-end">
          {['', 'BUY', 'SELL'].map((f) => (
            <button key={f} onClick={() => setSide(f)}
              className={`px-2 py-0.5 text-2xs font-semibold rounded border ${side === f ? 'bg-accent/15 border-accent/40 text-accent' : 'border-line text-slate-500 hover:text-slate-300'}`}>
              {f === '' ? 'ALL' : f === 'BUY' ? 'BUYS' : 'SELLS'}
            </button>
          ))}
          <select value={range} onChange={(e) => setRange(e.target.value)}
            className="bg-ink-900 border border-line rounded text-2xs text-slate-400 px-1 py-0.5 focus:outline-none">
            {Object.entries(PERIOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      }>
      {!data ? <div className="p-6 text-center"><Spinner /></div> : data.trades.length === 0 ? (
        <EmptyState title="No trades for this filter" body="Try a wider time range, or wait for the next sync." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[860px]">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-slate-500 border-b border-line bg-ink-800/50">
                  <th className="px-3 py-2">Time</th><th className="px-2 py-2">Market</th><th className="px-2 py-2">Action</th>
                  <th className="px-2 py-2">Outcome</th><th className="px-2 py-2 text-right">Price</th>
                  <th className="px-2 py-2 text-right">Shares</th><th className="px-2 py-2 text-right">Value</th>
                  <th className="px-2 py-2 text-right">Status</th><th className="px-2 py-2">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {data.trades.map((t, i) => (
                  <tr key={`${t.tx_hash}-${i}`} className="hover:bg-ink-800/60">
                    <td className="px-3 py-2 text-slate-400 tabular-nums whitespace-nowrap" title={exactTime(t.ts)}>{timeAgo(t.ts, now)}</td>
                    <td className="px-2 py-2 max-w-[260px] truncate text-slate-300" title={t.title || ''}>
                      {t.slug ? <a className="hover:text-accent" href={`https://polymarket.com/event/${t.event_slug || t.slug}`} target="_blank" rel="noreferrer">{t.title}</a> : (t.title || '—')}
                    </td>
                    <td className="px-2 py-2"><SideBadge side={t.side} /></td>
                    <td className="px-2 py-2"><OutcomeBadge outcome={t.outcome} /></td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">{price(t.price)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">{shares(t.shares)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-100">{money(t.value)}</td>
                    <td className="px-2 py-2 text-right"><span className="text-2xs text-gain font-semibold">FILLED</span></td>
                    <td className="px-2 py-2 font-mono text-2xs">
                      {t.tx_hash
                        ? <a href={`https://polygonscan.com/tx/${t.tx_hash}`} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-accent" title={t.tx_hash}>{shortAddr(t.tx_hash, 6, 4)}</a>
                        : <span className="text-slate-700">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-line">
            <span className="text-2xs text-slate-500 tabular-nums">
              {data.total.toLocaleString()} trades · page {page} of {data.pages}
            </span>
            <div className="flex gap-1.5">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="px-2.5 py-1 text-2xs rounded border border-line bg-ink-700 text-slate-300 hover:bg-ink-600 disabled:opacity-40 disabled:cursor-not-allowed">← Previous</button>
              <button disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}
                className="px-2.5 py-1 text-2xs rounded border border-line bg-ink-700 text-slate-300 hover:bg-ink-600 disabled:opacity-40 disabled:cursor-not-allowed">Next →</button>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
