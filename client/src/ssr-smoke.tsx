/**
 * Server-render smoke test for the win-rate UI (run via scripts/test-render.mjs).
 *
 * A headless browser is not available in this environment, so this exercises the
 * React components the way the browser will: real payload shapes, a real render pass,
 * assertions on the produced HTML. It catches crashes in the render path, fields the
 * client expects but the server does not send (the fixture below is type-checked
 * against the API types), and — importantly — that every win-rate number rendered on
 * screen travels with its sample size and the exclusion wording.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccuracyVsPnl, InfoTip, WINRATE_TOOLTIP, WinRateBars, WinRateCell, WinRateWindows, sampleConfidence } from './components/WinRate';
import { PredictionsPanel, PredictionDetailModal } from './components/PredictionsPanel';
import { Panel } from './components/ui';
import { ratePct, sampleText } from './lib/format';
import type { PredictionLedger, PredictionStats } from './lib/types';

const window100 = {
  window: 100, scanned: 122, analyzed: 100, wins: 63, losses: 37, excluded: 4,
  reasons: { hedged_both_outcomes: 2, resolution_pending: 2 },
  winRate: 0.63, limited: false, truncated: false, pnl: 1197,
  label: 'Based on the most recent 100 completed predictions',
};

export const stats: PredictionStats = {
  computedAt: 1787660977,
  primary: window100,
  windows: {
    '10': { window: 10, scanned: 10, analyzed: 10, wins: 6, losses: 4, excluded: 0, winRate: 0.6, limited: false, pnl: 120, label: 'Based on the most recent 10 completed predictions' },
    '25': { window: 25, scanned: 25, analyzed: 25, wins: 16, losses: 9, excluded: 1, winRate: 0.64, limited: false, pnl: 300, label: 'Based on the most recent 25 completed predictions' },
    '50': { window: 50, scanned: 50, analyzed: 50, wins: 32, losses: 18, excluded: 1, winRate: 0.64, limited: false, pnl: 600, label: 'Based on the most recent 50 completed predictions' },
    '100': window100,
    '250': { window: 250, scanned: 122, analyzed: 122, wins: 65, losses: 57, excluded: 4, winRate: 0.5327868852459018, limited: true, pnl: 1197, label: 'Based on 122 completed predictions' },
    all: { window: null, scanned: 122, analyzed: 122, wins: 65, losses: 57, excluded: 4, winRate: 0.5327868852459018, limited: true, pnl: 1197, label: 'Based on 122 completed predictions' },
  },
  periods: {
    '24h': { analyzed: 3, wins: 2, losses: 1, excluded: 0, scanned: 3, winRate: 0.6666666666666666, pnl: 40 },
    '7d': { analyzed: 20, wins: 12, losses: 8, excluded: 1, scanned: 21, winRate: 0.6, pnl: 220 },
  },
  totals: {
    completed: 126, wins: 65, losses: 57, undetermined: 4, analyzed: 122, winRate: 0.5327868852459018,
    costUsdc: 21452.95, realizedPnl: 1197, totalPnl: 1197, oldestCompletedAt: 1786631377, newestCompletedAt: 1787660977,
  },
  exclusions: { openPositions: 20, openPendingResolution: 2, pendingResolutions: 144, note: 'Open positions and markets without a final resolution are never counted as wins or losses.' },
  coverage: { scannedCompleted: 122, scanCap: 1500, sourceWindow: 1500, closedHistoryComplete: true, positionsScanComplete: true },
  profitability: { label: 'Closed positions with positive realized P&L', closed: 130, wins: 130, losses: 0, flat: 0, rate: 1, realizedPnl: 1197 },
};

export const ledger: PredictionLedger = {
  page: 1, pageSize: 25, total: 100, pages: 4, window: 100, windowAnalyzed: 100,
  totals: { completed: 126, wins: 65, losses: 57, undetermined: 4 },
  predictions: [
    {
      condition_id: '0xAAAA0003', market_name: 'Will event #3 on AAAA resolve YES by Friday?', market_slug: 'mkt-AAAA-3', event_slug: 'ev-AAAA-3',
      predicted_outcome: 'YES', predicted_index: 0, final_outcome: 'YES', final_index: 0, result: 'WIN', status: 'COMPLETED',
      reason: null, reasonLabel: null, marketUrl: 'https://polymarket.com/event/ev-AAAA-3',
      cost_usdc: 100, proceeds_usdc: 250, realized_pnl: 150, unrealized_pnl: 0, total_pnl: 150, shares_predicted: 250,
      trades_count: 8, positions_count: 1, hedged: 0, started_at: 1787500000, completed_at: 1787660977, completed_from: 'closed_position',
      resolved_at: 1787660900, source_transactions: [{ ts: 1787500000, side: 'BUY', outcome: 'YES', price: 0.4, shares: 250, value: 100, txHash: '0xtx' }],
      resolution_source: 'clob', in_window: true,
    },
    {
      condition_id: '0xAAAA0104', market_name: 'Will event #104 on AAAA resolve YES by Friday?', market_slug: 'mkt-AAAA-104', event_slug: 'ev-AAAA-104',
      predicted_outcome: 'YES', predicted_index: 0, final_outcome: 'NO', final_index: 1, result: 'LOSS', status: 'COMPLETED',
      reason: null, reasonLabel: null, marketUrl: null, cost_usdc: 80, proceeds_usdc: 0, realized_pnl: 3, unrealized_pnl: null, total_pnl: 3,
      shares_predicted: 200, trades_count: 1, positions_count: 1, hedged: 0, started_at: 1787400000, completed_at: 1787600000, completed_from: 'redeem',
      resolved_at: 1787599000, source_transactions: [], resolution_source: 'clob', in_window: true,
    },
    {
      condition_id: '0xAAAA0900', market_name: 'Open position still running', market_slug: 'mkt-AAAA-900', event_slug: 'ev-AAAA-900',
      predicted_outcome: 'NO', predicted_index: 1, final_outcome: null, final_index: null, result: 'UNDETERMINED', status: 'OPEN',
      reason: 'market_open', reasonLabel: 'Market is still open', marketUrl: null, cost_usdc: 42, proceeds_usdc: null, realized_pnl: null,
      unrealized_pnl: 3.2, total_pnl: 3.2, shares_predicted: 84, trades_count: 1, positions_count: 1, hedged: 0,
      started_at: 1787300000, completed_at: null, completed_from: null, resolved_at: null, source_transactions: [], resolution_source: null,
      in_window: false,
    },
  ],
};

const emptyStats: PredictionStats = {
  ...stats,
  primary: { window: 100, scanned: 0, analyzed: 0, wins: 0, losses: 0, excluded: 0, winRate: null, limited: true, pnl: null, label: 'No completed predictions yet' },
  windows: { '10': { window: 10, scanned: 0, analyzed: 0, wins: 0, losses: 0, excluded: 0, winRate: null, limited: true, pnl: null }, all: { window: null, scanned: 0, analyzed: 0, wins: 0, losses: 0, excluded: 0, winRate: null, limited: true, pnl: null } },
  periods: {},
  totals: { ...stats.totals, completed: 0, wins: 0, losses: 0, undetermined: 0, analyzed: 0, winRate: null },
  exclusions: { openPositions: 5, openPendingResolution: 5, pendingResolutions: 0, note: '' },
};

export type Case = { name: string; html: string };

export { WINRATE_TOOLTIP };

export function buildCases(): Case[] {
  const out: Case[] = [];
  const render = (name: string, node: React.ReactElement) => {
    try {
      out.push({ name, html: renderToStaticMarkup(node) });
    } catch (err) {
      out.push({ name, html: `__RENDER_ERROR__ ${(err as Error).message}` });
    }
  };
  render('tooltip-in-panel-title', <Panel title={<span>Win Rate <InfoTip /></span>}>body</Panel>);
  render('win-rate-cell', <WinRateCell win={stats.primary} />);
  render('win-rate-bars', <WinRateBars win={stats.primary} openExcluded={stats.exclusions.openPositions} />);
  render('win-rate-windows', <WinRateWindows stats={stats} active={100} onPick={() => {}} />);
  render('accuracy-vs-pnl', <AccuracyVsPnl stats={stats} />);
  render('predictions-panel', <PredictionsPanel address="0xabc" stats={stats} updatedAt={1787660977} ledger={ledger} />);
  render('predictions-panel-loading', <PredictionsPanel address="0xabc" stats={stats} />);
  render('predictions-panel-empty', <PredictionsPanel address="0xabc" stats={emptyStats} ledger={{ ...ledger, total: 0, pages: 1, predictions: [] }} />);
  render('detail-modal-closed', <PredictionDetailModal address="0xabc" conditionId={null} onClose={() => {}} />);
  render('sample-text', <span>{sampleText(stats.primary.wins, stats.primary.analyzed)}</span>);
  render('empty-sample-text', <span>{sampleText(emptyStats.primary.wins, emptyStats.primary.analyzed)}</span>);
  render('confidence-thin', <span>{sampleConfidence(1).label}</span>);
  render('rate-formatting', <span>{[ratePct(0.63), ratePct(1), ratePct(0.6666666), ratePct(0.5327868), ratePct(null)].join(' | ')}</span>);
  return out;
}
