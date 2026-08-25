import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useStore } from '../lib/store';
import { Modal } from './ui';
import { timeAgo, exactTime } from '../lib/format';
import type { AlertRule, Notification } from '../lib/types';

const KIND_LABEL: Record<string, string> = {
  new_trade: 'New trade',
  large_trade: 'Trade above amount',
  market_entry: 'Enters market',
  position_closed: 'Position closed',
  winrate_cross: 'Win-rate threshold',
};

export function AlertsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { unread, markAllRead } = useStore();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [kind, setKind] = useState('large_trade');
  const [minValue, setMinValue] = useState('1000');
  const [keyword, setKeyword] = useState('');
  const [threshold, setThreshold] = useState('60');

  const load = useCallback(() => {
    apiFetch<{ rules: AlertRule[] }>('/api/alerts/rules').then((r) => setRules(r.rules)).catch(() => {});
    apiFetch<{ notifications: Notification[] }>('/api/notifications?limit=40').then((r) => setNotifications(r.notifications)).catch(() => {});
  }, []);
  useEffect(() => { if (open) { load(); markAllRead(); } }, [open, load, markAllRead]);

  const addRule = async () => {
    const params: Record<string, unknown> = {};
    if (kind === 'large_trade') params.minValue = Number(minValue) || 0;
    if (kind === 'market_entry') params.keyword = keyword.trim();
    if (kind === 'winrate_cross') params.threshold = Number(threshold) || 0;
    try {
      await apiFetch('/api/alerts/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, params }) });
      load();
    } catch { /* ignore */ }
  };
  const toggle = async (r: AlertRule) => {
    await apiFetch(`/api/alerts/rules/${r.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !r.enabled }) });
    load();
  };
  const remove = async (r: AlertRule) => {
    await apiFetch(`/api/alerts/rules/${r.id}`, { method: 'DELETE' });
    load();
  };

  return (
    <Modal open={open} onClose={onClose} title="Alerts & Notifications" width="max-w-2xl">
      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <div className="text-2xs uppercase tracking-wider text-slate-500 mb-2">New rule (any tracked trader)</div>
          <div className="space-y-2">
            <select value={kind} onChange={(e) => setKind(e.target.value)}
              className="w-full bg-ink-900 border border-line rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-accent/60">
              <option value="new_trade">Any new trade</option>
              <option value="large_trade">Trade above amount ($)</option>
              <option value="market_entry">Enters market containing keyword</option>
              <option value="position_closed">Closes / redeems a position</option>
              <option value="winrate_cross">All-time win rate crosses threshold (%)</option>
            </select>
            {kind === 'large_trade' && (
              <input value={minValue} onChange={(e) => setMinValue(e.target.value)} placeholder="Min value in USD, e.g. 1000"
                className="w-full bg-ink-900 border border-line rounded px-2 py-1.5 text-sm font-mono text-slate-200 focus:outline-none focus:border-accent/60" />
            )}
            {kind === 'market_entry' && (
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Keyword, e.g. Fed"
                className="w-full bg-ink-900 border border-line rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-accent/60" />
            )}
            {kind === 'winrate_cross' && (
              <input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="Threshold %"
                className="w-full bg-ink-900 border border-line rounded px-2 py-1.5 text-sm font-mono text-slate-200 focus:outline-none focus:border-accent/60" />
            )}
            <button onClick={addRule} className="px-3 py-1.5 rounded bg-accent/15 border border-accent/40 text-accent text-xs font-semibold hover:bg-accent/25">Add rule</button>
          </div>

          <div className="mt-4 text-2xs uppercase tracking-wider text-slate-500 mb-1">Active rules</div>
          {rules.length === 0 && <div className="text-xs text-slate-600">No rules yet.</div>}
          <ul className="space-y-1">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-xs bg-ink-800 border border-line rounded px-2 py-1.5">
                <button onClick={() => toggle(r)} title={r.enabled ? 'Disable' : 'Enable'}
                  className={`w-2 h-2 rounded-full ${r.enabled ? 'bg-gain' : 'bg-slate-600'}`} />
                <span className="text-slate-300">{KIND_LABEL[r.kind] || r.kind}</span>
                <span className="text-slate-500 font-mono">
                  {r.kind === 'large_trade' ? `≥ $${(r.params as { minValue?: number }).minValue}` :
                   r.kind === 'market_entry' ? `“${(r.params as { keyword?: string }).keyword}”` :
                   r.kind === 'winrate_cross' ? `${(r.params as { threshold?: number }).threshold}%` : ''}
                </span>
                <button onClick={() => remove(r)} className="ml-auto text-slate-600 hover:text-loss">✕</button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="text-2xs uppercase tracking-wider text-slate-500 mb-2">Recent notifications</div>
          {notifications.length === 0 && <div className="text-xs text-slate-600">Nothing fired yet. Alerts appear here and as toasts.</div>}
          <ul className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-1">
            {notifications.map((n) => (
              <li key={n.id} className="text-xs bg-ink-800 border border-line rounded px-2.5 py-2">
                <div className="text-slate-300 leading-4">{n.message}</div>
                <div className="text-2xs text-slate-600 mt-0.5 tabular-nums" title={exactTime(n.ts)}>{timeAgo(n.ts)}</div>
              </li>
            ))}
          </ul>
          {unread > 0 && <div className="text-2xs text-slate-600 mt-2">{unread} unread before opening this panel.</div>}
        </div>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] space-y-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div key={t.id} onClick={() => dismissToast(t.id)}
          className="cursor-pointer bg-ink-800 border border-accent/40 rounded-md px-3 py-2.5 shadow-2xl text-xs text-slate-200 leading-4 animate-[fadein_.2s_ease-out]">
          <span className="text-accent font-semibold uppercase text-2xs tracking-wider mr-1.5">Alert</span>
          {t.message}
        </div>
      ))}
    </div>
  );
}
