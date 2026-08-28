import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useNow } from '../lib/store';
import { exactTime, money, price, ratePct, shares, shortAddr, signedMoney, timeAgo, isNum } from '../lib/format';
import type { PredictionDetail, PredictionLedger, PredictionRow, PredictionStats } from '../lib/types';
import { AccuracyVsPnl, InfoTip, WinRateBars, WinRateWindows, sampleConfidence } from './WinRate';
import { EmptyState, Modal, OutcomeBadge, Panel, SideBadge, Spinner } from './ui';

const RESULT_CLS: Record<string, string> = {
  WIN: 'text-gain bg-gain/10 border-gain/30',
  LOSS: 'text-loss bg-loss/10 border-loss/30',
  UNDETERMINED: 'text-slate-400 bg-ink-700 border-line',
};

/**
 * "Last N Predictions" — the auditable analytics block. The win rate on top and the
 * table underneath come from the same server-side rows, so any number shown here can
 * be checked line by line against public Polymarket data.
 */
export function PredictionsPanel({ address, stats, updatedAt, ledger: providedLedger }: { address: string; stats: PredictionStats | null; updatedAt?: number | null; ledger?: PredictionLedger }) {
  const [winSize, setWinSize] = useState<number | 'all'>(100);
  const [filter, setFilter] = useState<'' | 'WIN' | 'LOSS' | 'UNDETERMINED'>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [fetched, setLedger] = useState<PredictionLedger | null>(null);
  const ledger = providedLedger ?? fetched;
  const [openRow, setOpenRow] = useState<string | null>(null);
  const now = useNow(5000);

  const win = useMemo(() => {
    if (!stats) return null;
    return winSize === 'all' ? stats.windows.all : stats.windows[String(winSize)] || stats.primary;
  }, [stats, winSize]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (winSize !== 'all') p.set('window', String(winSize));
    if (filter) p.set('result', filter);
    if (search.trim()) p.set('market', search.trim().slice(0, 60));
    return p.toString();
  }, [page, winSize, filter, search]);

  const load = useCallback(() => {
    apiFetch<PredictionLedger>(`/api/wallets/${address}/predictions?${params}`)
      .then(setLedger)
      .catch(() => setLedger({ page: 1, pageSize: 25, total: 0, pages: 1, window: 100, totals: { completed: 0, wins: 0, losses: 0, undetermined: 0 }, predictions: [] }));
  }, [address, params]);

  useEffect(() => { if (!providedLedger) load(); }, [load, updatedAt, providedLedger]);
  useEffect(() => { setPage(1); }, [winSize, filter, search]);

  const conf = sampleConfidence(win?.analyzed ?? 0);

  return (
    <>
      <Panel
        title={<span className="inline-flex items-center gap-1.5">Last {winSize === 'all' ? 'completed' : winSize} predictions <InfoTip /></span>}
        right={
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <span className="text-2xs text-slate-600 tabular-nums">
              {stats ? `recalculated ${stats.computedAt ? timeAgo(stats.computedAt, now) : '—'}` : ''}
            </span>
            <button onClick={load} className="px-2 py-0.5 text-2xs rounded border border-line bg-ink-700 hover:bg-ink-600 text-slate-300" title="Re-read the audit rows from the server">Refresh</button>
          </div>
        }>
        {!stats ? <div className="p-6 text-center"><Spinner /></div> : (
          <div className="space-y-3">
            {/* headline numbers */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <div className="text-2xs uppercase tracking-[0.12em] text-slate-500">Win rate</div>
                <div className={`font-mono text-3xl tabular-nums leading-9 ${win?.winRate == null ? 'text-slate-600' : win.winRate >= 0.5 ? 'text-gain' : 'text-loss'}`}>
                  {win?.winRate == null ? 'N/A' : ratePct(win.winRate)}
                </div>
                <div className="mt-1"><span className={`inline-block text-[9px] px-1 rounded border leading-4 ${conf.cls}`}>{conf.label}</span></div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 lg:col-span-2 content-center">
                <Line label="Total analyzed" value={fmt(win?.analyzed)} />
                <Line label="Wins" value={<span className="text-gain">{fmt(win?.wins)}</span>} />
                <Line label="Losses" value={<span className="text-loss">{fmt(win?.losses)}</span>} />
                <Line label="Undetermined" value={<span className="text-slate-400">{fmt(win?.excluded)}</span>} />
                <div className="col-span-2 text-2xs text-slate-500 leading-4">
                  {win?.winRate == null
                    ? 'No completed prediction has a verified market resolution yet — nothing is counted as a win or a loss.'
                    : <>Win rate = {win.wins} ÷ {win.wins + win.losses} × 100 · denominator counts classified predictions only.</>}
                  {win && win.scanned > win.analyzed ? <> <span className="text-slate-600">({win.scanned} completed records scanned to fill this window)</span></> : null}
                </div>
              </div>
              <div className="lg:col-span-1">
                <WinRateBars win={win} openExcluded={stats.exclusions.openPositions} />
              </div>
            </div>

            {/* windows (10 / 25 / 50 / 100 / 250 / all) */}
            <div>
              <div className="text-2xs uppercase tracking-[0.12em] text-slate-500 mb-1.5 flex items-center gap-1.5">
                Prediction accuracy by window <span className="text-slate-600 normal-case tracking-normal">— click a window to drive the table</span>
              </div>
              <WinRateWindows stats={stats} active={winSize} onPick={setWinSize} />
            </div>

            <AccuracyVsPnl stats={stats} />

            {(stats.exclusions.pendingResolutions > 0) && (
              <div className="text-2xs text-warn/90 bg-warn/5 border border-warn/25 rounded px-2.5 py-1.5">
                ⏳ {stats.exclusions.pendingResolutions} market outcome{stats.exclusions.pendingResolutions === 1 ? '' : 's'} still being verified from Polymarket.
                Those positions stay <b>undetermined</b> — never counted as a win — until the market’s final resolution is confirmed.
              </div>
            )}
            {!stats.coverage.closedHistoryComplete && (
              <div className="text-2xs text-slate-500">
                Note: this trader has more completed positions than one scan pulls ({stats.coverage.sourceWindow.toLocaleString()} most recent).
                The numbers below are computed from what is stored, and deepen as syncing continues.
              </div>
            )}

            {/* audit table */}
            <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-line">
              {(['', 'WIN', 'LOSS', 'UNDETERMINED'] as const).map((f) => (
                <button key={f || 'ALL'} onClick={() => setFilter(f)}
                  className={`px-2 py-0.5 text-2xs font-semibold rounded border ${filter === f ? 'bg-accent/15 border-accent/40 text-accent' : 'border-line text-slate-500 hover:text-slate-300'}`}>
                  {{ '': 'ALL', WIN: 'WINS', LOSS: 'LOSSES', UNDETERMINED: 'EXCLUDED' }[f]}
                </button>
              ))}
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="filter by market…"
                className="ml-auto bg-ink-900 border border-line rounded px-2 py-1 text-2xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-accent/60 w-44" />
            </div>

            {!ledger ? <div className="p-4 text-center"><Spinner /></div> : ledger.predictions.length === 0 ? (
              <EmptyState title="No predictions match this filter" body="Every completed, resolved position appears here once the sync engine has classified it." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[820px]">
                  <thead>
                    <tr className="text-left text-2xs uppercase tracking-wider text-slate-500 border-b border-line">
                      <th className="px-2 py-1.5">Date</th>
                      <th className="px-2 py-1.5">Market</th>
                      <th className="px-2 py-1.5">Prediction</th>
                      <th className="px-2 py-1.5">Final outcome</th>
                      <th className="px-2 py-1.5">Result</th>
                      <th className="px-2 py-1.5 text-right">Txns grouped</th>
                      <th className="px-2 py-1.5 text-right">P&amp;L (separate)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {ledger.predictions.map((r) => (
                      <tr key={r.condition_id} onClick={() => setOpenRow(r.condition_id)}
                        className="hover:bg-ink-800/60 cursor-pointer" title="Click to audit this prediction">
                        <td className="px-2 py-1.5 text-slate-400 tabular-nums whitespace-nowrap" title={r.completed_at ? exactTime(r.completed_at) : 'completion time unknown'}>
                          {r.completed_at ? timeAgo(r.completed_at, now) : '—'}
                          {r.completed_from === 'estimated' ? <span className="text-slate-600"> ≈</span> : null}
                        </td>
                        <td className="px-2 py-1.5 max-w-[280px] truncate text-slate-300" title={r.market_name || ''}>{r.market_name || shortAddr(r.condition_id)}</td>
                        <td className="px-2 py-1.5">{r.predicted_outcome ? <OutcomeBadge outcome={r.predicted_outcome} /> : <span className="text-slate-600 text-2xs">—</span>}</td>
                        <td className="px-2 py-1.5">{r.final_outcome ? <OutcomeBadge outcome={r.final_outcome} /> : <span className="text-slate-600 text-2xs">{r.status === 'OPEN' ? 'open' : 'unresolved'}</span>}</td>
                        <td className="px-2 py-1.5">
                          <span className={`px-1.5 py-px rounded-sm text-2xs font-bold border ${RESULT_CLS[r.result]}`} title={r.reasonLabel || undefined}>
                            {r.result === 'UNDETERMINED' ? (r.status === 'OPEN' ? 'OPEN' : 'EXCLUDED') : r.result}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-slate-400">
                          {r.trades_count}
                          {r.positions_count > 1 ? <span className="text-slate-600"> / {r.positions_count} legs</span> : null}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${isNum(r.total_pnl) ? (r.total_pnl >= 0 ? 'text-gain' : 'text-loss') : 'text-slate-600'}`}>
                          {isNum(r.total_pnl) ? signedMoney(r.total_pnl) : 'N/A'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {ledger && ledger.pages > 1 && (
              <div className="flex items-center justify-between pt-1.5">
                <span className="text-2xs text-slate-500 tabular-nums">{ledger.total.toLocaleString()} rows · page {ledger.page} of {ledger.pages}</span>
                <div className="flex gap-1.5">
                  <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 text-2xs rounded border border-line bg-ink-700 text-slate-300 hover:bg-ink-600 disabled:opacity-40 disabled:cursor-not-allowed">← Previous</button>
                  <button disabled={page >= ledger.pages} onClick={() => setPage((p) => p + 1)}
                    className="px-2.5 py-1 text-2xs rounded border border-line bg-ink-700 text-slate-300 hover:bg-ink-600 disabled:opacity-40 disabled:cursor-not-allowed">Next →</button>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      <PredictionDetailModal address={address} conditionId={openRow} onClose={() => setOpenRow(null)} />
    </>
  );
}

const Line = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div className="text-2xs uppercase tracking-[0.12em] text-slate-500">{label}</div>
    <div className="font-mono text-xl tabular-nums text-slate-100">{value}</div>
  </div>
);
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));

// ===========================================================================
/** Click a row → everything needed to verify that one prediction by hand. */
export function PredictionDetailModal({ address, conditionId, onClose }: { address: string; conditionId: string | null; onClose: () => void }) {
  const [data, setData] = useState<PredictionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conditionId) { setData(null); setError(null); return; }
    let cancelled = false;
    setData(null); setError(null);
    apiFetch<PredictionDetail>(`/api/wallets/${address}/predictions/${encodeURIComponent(conditionId)}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [address, conditionId]);

  const p = data?.prediction;
  return (
    <Modal open={!!conditionId} onClose={onClose} title="Prediction audit trail" width="max-w-3xl">
      {!data && !error && <div className="p-6 text-center"><Spinner /></div>}
      {error && <div className="text-xs text-loss">{error}</div>}
      {p && (
        <div className="space-y-3 text-xs">
          <div className="flex items-start gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-2xs font-bold border ${RESULT_CLS[p.result]}`}>{p.result}</span>
            {p.reasonLabel && <span className="text-2xs text-slate-400">{p.reasonLabel}</span>}
            <span className="ml-auto font-mono text-2xs text-slate-500">{exactTime(p.completed_at ?? 0)}</span>
          </div>

          <div className="text-sm font-semibold text-slate-100 leading-5">
            {p.market_name || shortAddr(p.condition_id)}
            {p.marketUrl && <a href={p.marketUrl} target="_blank" rel="noreferrer" className="ml-2 text-2xs font-normal text-accent hover:underline">open on polymarket.com ↗</a>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line rounded overflow-hidden">
            <Kv label="Prediction" value={p.predicted_outcome || '—'} />
            <Kv label="Final outcome" value={p.final_outcome || (p.status === 'OPEN' ? 'still open' : 'unknown')} />
            <Kv label="Cost basis" value={money(p.cost_usdc)} />
            <Kv label="Trading P&L" value={isNum(p.total_pnl) ? signedMoney(p.total_pnl) : 'N/A'} tone={isNum(p.total_pnl) ? (p.total_pnl >= 0 ? 'text-gain' : 'text-loss') : undefined} />
          </div>

          <div className="text-2xs text-slate-500 leading-4">
            {data.groupingNote} WIN/LOSS came from the market’s final resolution
            {data.resolution?.source ? <> (source: <span className="font-mono">{data.resolution.source}</span>)</> : ''},
            not from the P&amp;L column. {data.prediction.hedged ? 'This market was held on both sides, so it is excluded as a prediction.' : ''}
          </div>

          {data.resolution && (
            <div>
              <div className="text-2xs uppercase tracking-wider text-slate-500 mb-1">Market resolution ({data.resolution.market_state})</div>
              <div className="border border-line rounded divide-y divide-line/60">
                {(data.resolution.outcomes || []).map((o, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                    <OutcomeBadge outcome={o.outcome} />
                    <span className="font-mono text-2xs text-slate-400">@ {price(o.price)}</span>
                    {o.winner && <span className="text-2xs text-gain font-bold">WINNER</span>}
                    <span className="ml-auto font-mono text-[10px] text-slate-600" title={o.token_id || ''}>{o.token_id ? shortAddr(o.token_id, 6, 4) : ''}</span>
                  </div>
                ))}
                {!data.resolution.outcomes?.length && <div className="px-2 py-1.5 text-2xs text-slate-500">{data.resolution.reason || 'no outcome data returned'}</div>}
              </div>
            </div>
          )}

          <div>
            <div className="text-2xs uppercase tracking-wider text-slate-500 mb-1">Position records grouped ({data.positions.length})</div>
            <div className="border border-line rounded divide-y divide-line/60">
              {data.positions.map((pos, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 flex-wrap">
                  <span className={`text-2xs font-bold ${pos.kind === 'open' ? 'text-cyan-300' : 'text-slate-400'}`}>{pos.kind.toUpperCase()}</span>
                  <OutcomeBadge outcome={pos.outcome} />
                  {pos.size != null && <span className="font-mono text-2xs text-slate-400">{shares(pos.size)} sh held</span>}
                  {pos.avg_price != null && <span className="font-mono text-2xs text-slate-400">avg {price(pos.avg_price)}</span>}
                  <span className="font-mono text-2xs text-slate-400">cost {money(pos.initial_value)}</span>
                  {isNum(pos.realized_pnl) && <span className="font-mono text-2xs text-slate-400">realized {signedMoney(pos.realized_pnl)}</span>}
                  {pos.cur_price != null && <span className="font-mono text-2xs text-slate-500">mark {price(pos.cur_price)}</span>}
                  {!!pos.redeemable && <span className="text-2xs text-purple-300">redeemable</span>}
                </div>
              ))}
              {!data.positions.length && <div className="px-2 py-1.5 text-2xs text-slate-500">No position row retained — classified from trade history.</div>}
            </div>
          </div>

          <div>
            <div className="text-2xs uppercase tracking-wider text-slate-500 mb-1">Transactions ({data.transactions.length})</div>
            <div className="max-h-48 overflow-y-auto border border-line rounded">
              <table className="w-full text-2xs">
                <tbody className="divide-y divide-line/60">
                  {data.transactions.map((t, i) => (
                    <tr key={i} className="hover:bg-ink-800/60">
                      <td className="px-2 py-1 text-slate-500 tabular-nums whitespace-nowrap" title={exactTime(t.ts)}>{exactTime(t.ts)}</td>
                      <td className="px-1 py-1"><SideBadge side={t.side} /></td>
                      <td className="px-1 py-1"><OutcomeBadge outcome={t.outcome} /></td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-400">{price(t.price)}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-400">{shares(t.shares)}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-200">{money(t.value)}</td>
                      <td className="px-2 py-1 text-right">
                        {t.tx_hash
                          ? <a href={`https://polygonscan.com/tx/${t.tx_hash}`} target="_blank" rel="noreferrer" className="font-mono text-slate-500 hover:text-accent" title={t.tx_hash}>{shortAddr(t.tx_hash, 6, 4)} ↗</a>
                          : <span className="text-slate-700">—</span>}
                      </td>
                    </tr>
                  ))}
                  {!data.transactions.length && <tr><td className="px-2 py-1.5 text-slate-500">Fills for this market are outside the synced trade window — the verdict is taken from the market resolution instead.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

const Kv = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <div className="bg-ink-850 px-2.5 py-1.5">
    <div className="text-2xs uppercase tracking-[0.1em] text-slate-500">{label}</div>
    <div className={`font-mono text-sm tabular-nums ${tone || 'text-slate-100'}`}>{value}</div>
  </div>
);
