import { useMemo } from 'react';
import { useStore, useNow } from '../lib/store';
import { WalletTable } from '../components/WalletTable';
import { GlobalFeed } from '../components/GlobalFeed';
import { Panel, Dot } from '../components/ui';
import { money, num, timeAgo } from '../lib/format';

export function Dashboard() {
  const { wallets, feed } = useStore();
  const now = useNow(1000);

  const overview = useMemo(() => {
    const live = wallets.filter((w) => w.status === 'live').length;
    const errors = wallets.filter((w) => w.status === 'error').length;
    const syncing = wallets.filter((w) => w.status === 'syncing').length;
    let trades24 = 0, vol24 = 0, hasVol = false;
    for (const w of wallets) {
      const s = w.stats;
      if (!s) continue;
      trades24 += s.trades24h || 0;
      const v = s.api?.volume?.['1d'] ?? s.volume24h;
      if (v != null) { vol24 += v; hasVol = true; }
    }
    const feed24 = feed.filter((f) => now - f.ts < 86400).length;
    return { live, errors, syncing, trades24, vol24, hasVol, feed24 };
  }, [wallets, feed, now]);

  const newestFeedTs = feed[0]?.ts ?? null;

  return (
    <div className="space-y-4">
      {/* overview strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-line border border-line rounded-md overflow-hidden">
        <Stat label="Tracked Traders" value={num(wallets.length)} />
        <Stat label="Live" value={<span className="text-gain inline-flex items-center gap-1.5"><Dot color="bg-gain" />{num(overview.live)}</span>} />
        <Stat label="Errors" value={<span className={overview.errors ? 'text-loss' : 'text-slate-500'}>{num(overview.errors)}</span>} />
        <Stat label="24h Volume" value={overview.hasVol ? money(overview.vol24) : 'N/A'} sub="API + calculated" />
        <Stat label="24h Trades" value={num(overview.trades24)} sub={`${overview.feed24} feed events shown`} />
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

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-ink-850 px-4 py-3">
      <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="font-mono text-xl tabular-nums text-slate-100 mt-0.5">{value}</div>
      {sub && <div className="text-2xs text-slate-600">{sub}</div>}
    </div>
  );
}
