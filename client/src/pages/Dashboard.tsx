import { useMemo } from 'react';
import { useStore, useNow } from '../lib/store';
import { WalletTable } from '../components/WalletTable';
import { GlobalFeed } from '../components/GlobalFeed';
import { Panel, Dot } from '../components/ui';
import { money, num, ratePct, timeAgo } from '../lib/format';
import { InfoTip } from '../components/WinRate';

export function Dashboard() {
  const { wallets, feed } = useStore();
  const now = useNow(1000);

  const overview = useMemo(() => {
    const live = wallets.filter((w) => w.status === 'live').length;
    const errors = wallets.filter((w) => w.status === 'error').length;
    const syncing = wallets.filter((w) => w.status === 'syncing').length;
    let trades24 = 0, vol24 = 0, hasVol = false;
    let analyzed = 0; let wins = 0; let openExcluded = 0; let pending = 0;
    const rates: number[] = [];
    for (const w of wallets) {
      const s = w.stats;
      if (!s) continue;
      trades24 += s.trades24h || 0;
      const v = s.api?.volume?.['1d'] ?? s.volume24h;
      if (v != null) { vol24 += v; hasVol = true; }
      // aggregated across the same per-trader windows the trader pages show
      const p = s.predictions;
      if (p) {
        analyzed += p.primary.analyzed;
        wins += p.primary.wins;
        openExcluded += p.exclusions.openPositions;
        pending += p.exclusions.pendingResolutions;
        if (p.primary.winRate != null && p.primary.analyzed > 0) rates.push(p.primary.winRate);
      }
    }
    rates.sort((a, b) => a - b);
    const median = rates.length ? (rates.length % 2 ? rates[(rates.length - 1) / 2] : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2) : null;
    const feed24 = feed.filter((f) => now - f.ts < 86400).length;
    return { live, errors, syncing, trades24, vol24, hasVol, feed24, analyzed, wins, median, openExcluded, pending, tradersWithSample: rates.length };
  }, [wallets, feed, now]);

  const newestFeedTs = feed[0]?.ts ?? null;

  return (
    <div className="space-y-4">
      {/* overview strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-line border border-line rounded-md overflow-hidden">
        <Stat label="Tracked Traders" value={num(wallets.length)} sub={overview.syncing ? `${overview.syncing} syncing` : undefined} />
        <Stat label="Live" value={<span className="text-gain inline-flex items-center gap-1.5"><Dot color="bg-gain" />{num(overview.live)}</span>} />
        <Stat label="Errors" value={<span className={overview.errors ? 'text-loss' : 'text-slate-500'}>{num(overview.errors)}</span>} />
        <Stat label="24h Volume" value={overview.hasVol ? money(overview.vol24) : 'N/A'} sub="API + calculated" />
        <Stat label="Median Win Rate" value={overview.median == null ? 'N/A' : ratePct(overview.median)}
          sub={<span className="inline-flex items-center gap-1">{overview.tradersWithSample}/{wallets.length} traders with a completed sample <InfoTip /></span>} />
        <Stat label="Completed Predictions" value={num(overview.analyzed)}
          sub={`${num(overview.wins)} wins · ${num(overview.openExcluded)} open excluded${overview.pending ? ` · ${num(overview.pending)} verifying` : ''}`} />
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
        <Panel title="Tracked Traders" pad={false}
          right={<span className="text-2xs text-slate-500">click a row for full analytics</span>}>
          <WalletTable />
        </Panel>

        <Panel title={<span className="inline-flex items-center gap-2"><Dot color="bg-accent" pulse /> Live Activity — all traders</span>} pad={false}
          right={newestFeedTs ? <span className="text-2xs text-slate-500 tabular-nums">latest {timeAgo(newestFeedTs, now)}</span> : null}>
          <GlobalFeed limit={40} />
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="bg-ink-850 px-4 py-3">
      <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="font-mono text-xl tabular-nums text-slate-100 mt-0.5">{value}</div>
      {sub && <div className="text-2xs text-slate-600">{sub}</div>}
    </div>
  );
}
