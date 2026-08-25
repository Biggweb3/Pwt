import React, { useEffect, useState } from 'react';
import { apiFetch, postJson } from '../lib/api';
import { Modal, Spinner, Avatar } from './ui';
import { money } from '../lib/format';
import { useStore } from '../lib/store';
import type { Wallet } from '../lib/types';

interface Candidate { address: string; name: string | null; pseudonym: string | null; profileImage: string | null }
interface Suggestion { address: string; username: string | null; vol: number; pnl: number; profileImage: string | null }

export function AddTraderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refreshWallets } = useStore();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [added, setAdded] = useState<Wallet | null>(null);

  useEffect(() => {
    if (!open) { setInput(''); setError(null); setCandidates([]); setAdded(null); return; }
    apiFetch<{ suggestions: Suggestion[] }>('/api/suggestions')
      .then((r) => setSuggestions(r.suggestions || []))
      .catch(() => setSuggestions([]));
  }, [open]);

  const submit = async (value?: string) => {
    const v = (value ?? input).trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    setCandidates([]);
    setAdded(null);
    try {
      const r = await postJson<{ wallet: Wallet }>('/api/wallets', { input: v });
      setAdded(r.wallet);
      setInput('');
      refreshWallets();
    } catch (err) {
      const e = err as { message: string; status: number; body?: { candidates?: Candidate[] } };
      setError({ message: e.message, status: e.status });
      if (e.body?.candidates?.length) setCandidates(e.body.candidates);
    } finally {
      setBusy(false);
    }
  };

  const trackCandidate = (c: Candidate) => submit(`https://polymarket.com/profile/${c.address}`);

  return (
    <Modal open={open} onClose={onClose} title="Add Trader" width="max-w-xl">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
        <div className="flex gap-2">
          <input
            autoFocus value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="https://polymarket.com/profile/…  or  0x wallet address  or  username"
            className="flex-1 bg-ink-900 border border-line rounded px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-accent/60 font-mono"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !input.trim()}
            className="px-4 py-2 rounded bg-accent/15 border border-accent/40 text-accent text-sm font-semibold hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2">
            {busy ? <Spinner className="w-3.5 h-3.5" /> : '+'} {busy ? 'Resolving…' : 'Track'}
          </button>
        </div>

        <p className="text-2xs text-slate-500 leading-4">
          Paste a public Polymarket profile URL — the profile is resolved to its wallet automatically.
          Only public on-chain activity is read. Duplicates are detected and rejected.
        </p>

        {error && (
          <div className={`rounded border px-3 py-2 text-xs leading-5 ${error.status === 409 ? 'border-warn/40 bg-warn/10 text-warn' : 'border-loss/40 bg-loss/10 text-loss'}`}>
            {error.status === 409 ? '⚠ ' : ''}{error.message}
          </div>
        )}

        {candidates.length > 0 && (
          <div>
            <div className="text-2xs uppercase tracking-wider text-slate-500 mb-1.5">Possible matches — click to track</div>
            <ul className="divide-y divide-line border border-line rounded">
              {candidates.map((c) => (
                <li key={c.address}>
                  <button onClick={() => trackCandidate(c)} className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-ink-700/50 text-left">
                    <Avatar src={c.profileImage} name={c.name || c.pseudonym} size={24} />
                    <span className="text-sm text-slate-200">{c.name || c.pseudonym || c.address}</span>
                    <span className="ml-auto font-mono text-2xs text-slate-500">{c.address.slice(0, 10)}…</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {added && (
          <div className="rounded border border-gain/40 bg-gain/10 px-3 py-2 text-xs text-gain">
            ✓ Now tracking <b>{added.username || added.pseudonym || added.address}</b>. Historical sync started — data will appear within seconds.
          </div>
        )}

        {!added && suggestions.length > 0 && !error && (
          <div>
            <div className="text-2xs uppercase tracking-wider text-slate-500 mb-1.5">Active today (top volume) — one-click add</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {suggestions.slice(0, 6).map((s) => (
                <button key={s.address} onClick={() => submit(`https://polymarket.com/profile/${s.address}`)} disabled={busy}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line bg-ink-800 hover:bg-ink-700 hover:border-accent/40 text-left disabled:opacity-50">
                  <Avatar src={s.profileImage} name={s.username} size={22} />
                  <span className="text-xs text-slate-200 truncate flex-1">{s.username || `${s.address.slice(0, 8)}…`}</span>
                  <span className="font-mono text-2xs text-slate-500">{money(s.vol)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
