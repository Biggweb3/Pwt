import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { Avatar } from './ui';

interface Result {
  traders: { id: string; username: string | null; pseudonym: string | null; profile_image: string | null; status: string }[];
  markets: { title: string; slug: string | null; icon: string | null }[];
}

/** Global search across tracked traders (name / wallet) and traded markets. Debounced. */
export function SearchBox() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) { setResults(null); return; }
    setBusy(true);
    debounce.current = setTimeout(async () => {
      try {
        const r = await apiFetch<Result>(`/api/search?q=${encodeURIComponent(q.trim())}`);
        setResults(r);
        setOpen(true);
      } catch { /* ignore */ } finally { setBusy(false); }
    }, 220);
  }, [q]);

  return (
    <div ref={boxRef} className="relative w-full max-w-sm">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)}
        placeholder="Search traders, wallets, markets…"
        className="w-full bg-ink-900 border border-line rounded px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-accent/60"
        spellCheck={false}
      />
      {busy && <span className="absolute right-2.5 top-2 w-3.5 h-3.5 rounded-full border-2 border-slate-700 border-t-accent animate-spin" />}
      {open && results && (
        <div className="absolute top-full mt-1 left-0 right-0 z-40 bg-ink-850 border border-line rounded-md shadow-2xl overflow-hidden max-h-[60vh] overflow-y-auto">
          {results.traders.length > 0 && <div className="px-3 pt-2 pb-1 text-2xs uppercase tracking-wider text-slate-500">Traders</div>}
          {results.traders.map((t) => (
            <button key={t.id} onClick={() => { setOpen(false); setQ(''); nav(`/trader/${t.id}`); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-ink-700 text-left">
              <Avatar src={t.profile_image} name={t.username || t.pseudonym} size={20} />
              <span className="text-sm text-slate-200">{t.username || t.pseudonym || t.id}</span>
              <span className="ml-auto font-mono text-2xs text-slate-500">{t.id.slice(0, 8)}…</span>
            </button>
          ))}
          {results.markets.length > 0 && <div className="px-3 pt-2 pb-1 text-2xs uppercase tracking-wider text-slate-500 border-t border-line">Markets traded</div>}
          {results.markets.map((m, i) => (
            <div key={i} className="px-3 py-1.5 text-xs text-slate-400 truncate" title={m.title}>◈ {m.title}</div>
          ))}
          {!results.traders.length && !results.markets.length && (
            <div className="px-3 py-3 text-xs text-slate-500">No matches among tracked data.</div>
          )}
        </div>
      )}
    </div>
  );
}
