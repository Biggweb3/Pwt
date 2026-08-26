import React, { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useStore } from './lib/store';
import { Dashboard } from './pages/Dashboard';
import { TraderPage } from './pages/TraderPage';
import { ComparePage } from './pages/ComparePage';
import { AddTraderModal } from './components/AddTraderModal';
import { AlertsModal, Toasts } from './components/Notifications';
import { SearchBox } from './components/SearchBox';
import { Dot } from './components/ui';

export default function App() {
  const { system, wallets, unread, setPollInterval } = useStore();
  const [addOpen, setAddOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);

  const live = wallets.filter((w) => w.status === 'live').length;
  const errors = wallets.filter((w) => w.status === 'error').length;

  return (
    <div className="min-h-screen bg-ink-950 text-slate-200 font-sans">
      {/* ------------------------------------------------------ header --- */}
      <header className="sticky top-0 z-40 border-b border-line bg-ink-900/95 backdrop-blur">
        <div className="max-w-[1500px] mx-auto px-4 h-14 flex items-center gap-4">
          <NavLink to="/" className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded bg-accent/15 border border-accent/40 grid place-items-center text-accent font-black text-xs">P</span>
            <span className="font-bold tracking-tight text-slate-100">POLYMARKET <span className="text-accent">INTEL</span></span>
          </NavLink>

          <nav className="flex items-center gap-1 text-sm shrink-0">
            <NavLink to="/" end className={({ isActive }) => navCls(isActive)}>Dashboard</NavLink>
            <NavLink to="/compare" className={({ isActive }) => navCls(isActive)}>Compare</NavLink>
          </nav>

          <div className="flex-1 max-w-md ml-2 hidden md:block"><SearchBox /></div>

          <div className="ml-auto flex items-center gap-2.5">
            {/* monitoring status + poll interval */}
            <div className="hidden sm:flex items-center gap-2 border border-line rounded px-2 py-1 bg-ink-850">
              <Dot color={errors ? 'bg-loss' : live ? 'bg-gain' : 'bg-slate-500'} pulse={!!live} />
              <span className="text-2xs text-slate-500 tabular-nums">{live}/{wallets.length || 0} live{errors ? ` · ${errors} err` : ''}</span>
              <select
                value={system?.pollInterval ?? 30}
                onChange={(e) => setPollInterval(Number(e.target.value))}
                title="Poll interval per trader"
                className="bg-ink-900 border border-line rounded text-2xs text-slate-300 px-1 py-0.5 focus:outline-none">
                {[10, 30, 60].map((s) => <option key={s} value={s}>{s}s poll</option>)}
              </select>
            </div>

            {/* upstream mode */}
            <div title={system?.deployment === 'serverless'
              ? 'Serverless deployment: the dashboard API runs as a Vercel function and syncs Polymarket on demand — no always-on server needed.'
              : system?.upstreamOk
                ? 'Server is polling Polymarket directly.'
                : 'Server cannot reach Polymarket from this host — public reads are relayed through your browser and ingested server-side.'}
              className={`hidden lg:block text-2xs px-2 py-1 rounded border font-semibold tracking-wider ${system?.deployment === 'serverless' ? 'border-accent/30 text-accent bg-accent/5' : system?.upstreamOk ? 'border-gain/30 text-gain bg-gain/5' : 'border-warn/40 text-warn bg-warn/5'}`}>
              {system == null ? '…' : system.deployment === 'serverless' ? 'SERVERLESS SYNC' : system.upstreamOk ? 'SERVER SYNC' : 'BRIDGE SYNC'}
            </div>

            <button onClick={() => setAlertsOpen(true)} className="relative px-2 py-1.5 rounded border border-line bg-ink-850 hover:bg-ink-700 text-slate-300" title="Alerts & notifications">
              <BellIcon />
              {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-accent text-ink-950 text-2xs font-bold grid place-items-center">{unread}</span>}
            </button>

            <button onClick={() => setAddOpen(true)}
              className="px-3 py-1.5 rounded bg-accent/15 border border-accent/50 text-accent text-sm font-semibold hover:bg-accent/25 transition-colors whitespace-nowrap">
              + Add Trader
            </button>
          </div>
        </div>
        {/* mobile search */}
        <div className="md:hidden px-4 pb-2"><SearchBox /></div>
      </header>

      {/* bridge-mode banner */}
      {system && system.mode === 'bridge' && (
        <div className="bg-warn/10 border-b border-warn/30 text-warn text-2xs px-4 py-1.5 text-center">
          Restricted network: this server cannot reach Polymarket directly, so public data reads are relayed through your browser.
          Keep this tab open for live monitoring. In a normal deployment the server polls Polymarket itself — no action needed.
        </div>
      )}

      {/* -------------------------------------------------------- body --- */}
      <main className="max-w-[1500px] mx-auto px-4 py-4">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/trader/:address" element={<TraderPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>

      <footer className="max-w-[1500px] mx-auto px-4 pb-6 text-2xs text-slate-600 leading-5">
        Public Polymarket data only — no keys, seeds, cookies or credentials are ever requested or stored.
        Metrics labelled <span className="text-slate-500">api</span> come straight from Polymarket; <span className="text-slate-500">calculated</span> metrics are derived
        from synced public trades/positions. Open positions are never counted as wins or losses. Unavailable data is shown as N/A.
      </footer>

      <AddTraderModal open={addOpen} onClose={() => setAddOpen(false)} />
      <AlertsModal open={alertsOpen} onClose={() => setAlertsOpen(false)} />
      <Toasts />
    </div>
  );
}

const navCls = (active: boolean) =>
  `px-2.5 py-1 rounded text-sm font-medium transition-colors ${active ? 'bg-ink-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`;

function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
