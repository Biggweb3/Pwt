import { Link } from 'react-router-dom';
import { useStore, useNow } from '../lib/store';
import { Avatar, SideBadge, OutcomeBadge, TypeBadge, EmptyState } from './ui';
import { timeAgo, exactTime, money, isNum } from '../lib/format';

/** Combined live feed across ALL tracked traders. */
export function GlobalFeed({ limit = 30 }: { limit?: number }) {
  const { feed, wallets } = useStore();
  const now = useNow(1000);
  if (!feed.length) {
    return <EmptyState title="No activity yet" body="Add traders to start streaming their public trades here in real time." />;
  }
  return (
    <ul className="divide-y divide-line/70 max-h-[70vh] overflow-y-auto">
      {feed.slice(0, limit).map((f, i) => (
        <li key={`${f.txHash || ''}-${f.ts}-${i}`} className="px-3 py-2 hover:bg-ink-800/60 transition-colors">
          <div className="flex items-center gap-2">
            <Avatar src={f.profileImage} name={f.username} size={22} />
            <Link to={`/trader/${f.wallet}`} className="text-xs font-semibold text-slate-200 hover:text-accent truncate max-w-[35%]">
              {f.username || `${f.wallet.slice(0, 6)}…`}
            </Link>
            <span className="ml-auto text-2xs text-slate-500 tabular-nums shrink-0" title={exactTime(f.ts)}>
              {timeAgo(f.ts, now)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            {f.type === 'TRADE' ? (
              <>
                <SideBadge side={f.side} />
                <OutcomeBadge outcome={f.outcome} />
                {isNum(f.value) && <span className="font-mono text-xs text-slate-100 tabular-nums">{money(f.value)}</span>}
              </>
            ) : (
              <>
                <TypeBadge type={f.type} />
                {isNum(f.value) && f.value > 0 && <span className="font-mono text-xs text-slate-100 tabular-nums">{money(f.value)}</span>}
              </>
            )}
          </div>
          {f.title && (
            <div className="mt-0.5 text-2xs text-slate-400 truncate" title={f.title}>
              {f.title}
            </div>
          )}
        </li>
      ))}
      {wallets.length === 0 && null}
    </ul>
  );
}
