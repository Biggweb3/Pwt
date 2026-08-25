/**
 * alerts.js — notification rules architecture.
 *
 * Rules are evaluated in the ingestion pipeline whenever NEW rows arrive
 * (never on re-fetched duplicates). Fired alerts become `notifications` rows
 * and are broadcast over SSE, so browser toasts / future push channels can
 * subscribe to a single source.
 *
 * Rule kinds:
 *   new_trade        — any new trade by a wallet (or any tracked wallet)
 *   large_trade      — trade value >= params.minValue
 *   market_entry     — trade in a market whose title matches params.keyword
 *   position_closed  — REDEEM activity seen for the wallet
 *   winrate_cross    — all-time win rate crosses params.threshold (%) after a sync
 */
import { db } from './db.js';
import { nowSec } from './util.js';
import { broadcast } from './events.js';

const money = (v) => (v == null ? '' : `$${Math.round(v).toLocaleString('en-US')}`);

export function listRules() {
  return db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all()
    .map((r) => ({ ...r, params: r.params ? JSON.parse(r.params) : {} }));
}

export function addRule({ kind, wallet = null, params = {} }) {
  const allowed = ['new_trade', 'large_trade', 'market_entry', 'position_closed', 'winrate_cross'];
  if (!allowed.includes(kind)) throw new Error(`Unknown rule kind: ${kind}`);
  const info = db.prepare('INSERT INTO alert_rules (enabled, kind, wallet, params, created_at) VALUES (1, ?, ?, ?, ?)')
    .run(kind, wallet, JSON.stringify(params || {}), nowSec());
  return db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(info.lastInsertRowid);
}

export const setRuleEnabled = (id, enabled) =>
  db.prepare('UPDATE alert_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
export const deleteRule = (id) => db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);

function rulesFor(kind, walletId) {
  return db.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND kind = ? AND (wallet IS NULL OR wallet = ?)")
    .all(kind, walletId)
    .map((r) => ({ ...r, params: r.params ? JSON.parse(r.params) : {} }));
}

export function pushNotification({ wallet = null, kind, message, meta = null }) {
  const ts = nowSec();
  const info = db.prepare('INSERT INTO notifications (ts, wallet, kind, message, meta) VALUES (?,?,?,?,?)')
    .run(ts, wallet, kind, message, meta ? JSON.stringify(meta) : null);
  const notification = { id: info.lastInsertRowid, ts, wallet, kind, message, meta };
  broadcast('alert', { notification });
  return notification;
}

/** Evaluate trade-based rules for freshly inserted trades. */
export function evaluateNewTrades(walletId, username, newTrades) {
  if (!newTrades?.length) return;
  const anyRules = rulesFor('new_trade', walletId).length
    || rulesFor('large_trade', walletId).length
    || rulesFor('market_entry', walletId).length;
  if (!anyRules) return;

  for (const t of newTrades) {
    const who = username || walletId;
    for (const rule of rulesFor('new_trade', walletId)) {
      pushNotification({
        wallet: walletId, kind: 'new_trade',
        message: `${who} ${t.side === 'BUY' ? 'bought' : 'sold'} ${money(t.value)} of ${t.outcome || ''} on “${t.title || 'a market'}”.`,
        meta: { trade: { ts: t.ts, side: t.side, value: t.value, title: t.title, outcome: t.outcome } },
      });
    }
    for (const rule of rulesFor('large_trade', walletId)) {
      const min = Number(rule.params.minValue);
      if (Number.isFinite(min) && t.value != null && t.value >= min) {
        pushNotification({
          wallet: walletId, kind: 'large_trade',
          message: `${who} placed a ${money(t.value)} trade (${t.side} ${t.outcome || ''}) on “${t.title || 'a market'}”.`,
          meta: { ruleId: rule.id, trade: { ts: t.ts, value: t.value } },
        });
      }
    }
    for (const rule of rulesFor('market_entry', walletId)) {
      const kw = String(rule.params.keyword || '').toLowerCase().trim();
      if (kw && t.title && t.title.toLowerCase().includes(kw)) {
        pushNotification({
          wallet: walletId, kind: 'market_entry',
          message: `${who} entered “${t.title}” (${t.side} ${t.outcome || ''}, ${money(t.value)}).`,
          meta: { ruleId: rule.id },
        });
      }
    }
  }
}

/** Evaluate redemption (position closed / resolved) rules. */
export function evaluateNewActivity(walletId, username, newActivity) {
  if (!newActivity?.length) return;
  const rules = rulesFor('position_closed', walletId);
  if (!rules.length) return;
  for (const a of newActivity) {
    if (a.type !== 'REDEEM') continue;
    pushNotification({
      wallet: walletId, kind: 'position_closed',
      message: `${username || walletId} closed/redeemed a position in “${a.title || 'a market'}” (${money(a.usdc)}).`,
      meta: { ts: a.ts },
    });
  }
}

/** Evaluate win-rate threshold rules after analytics refresh. */
export function evaluateWinRate(walletId, username, winRateAll) {
  if (winRateAll == null) return;
  for (const rule of rulesFor('winrate_cross', walletId)) {
    const threshold = Number(rule.params.threshold);
    if (!Number.isFinite(threshold)) continue;
    const pct = winRateAll * 100;
    const lastStateKey = `winrate_state_${rule.id}_${walletId}`;
    const prev = db.prepare('SELECT value FROM settings WHERE key = ?').get(lastStateKey)?.value;
    const state = pct >= threshold ? 'above' : 'below';
    if (prev && prev !== state) {
      pushNotification({
        wallet: walletId, kind: 'winrate_cross',
        message: `${username || walletId}'s all-time win rate crossed ${threshold}% (now ${pct.toFixed(1)}%).`,
        meta: { ruleId: rule.id, direction: state },
      });
    }
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(lastStateKey, state);
  }
}
