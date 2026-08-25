import React, { useMemo, useState } from 'react';
import { exactTime, money } from '../lib/format';

interface Point { ts: number; v: number }

/** Hand-rolled SVG area/line chart — no chart library, crisp and fast. */
export function PerfChart({ points, kind, height = 180 }: { points: Point[]; kind: 'pnl' | 'volume'; height?: number }) {
  const [hover, setHover] = useState<Point | null>(null);
  const W = 800, H = height, PAD = { l: 8, r: 8, t: 10, b: 18 };

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const vs = points.map((p) => p.v);
    let min = Math.min(...vs), max = Math.max(...vs);
    if (min === max) { min -= 1; max += 1; }
    if (kind === 'pnl') { min = Math.min(min, 0); max = Math.max(max, 0); }
    const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD.b} L${PAD.l},${H - PAD.b} Z`;
    const zeroY = kind === 'pnl' ? y(0) : null;
    return { x, y, line, area, min, max, zeroY };
  }, [points, kind, H]);

  if (!geom) {
    return <div className="h-[180px] grid place-items-center text-xs text-slate-600 border border-dashed border-line rounded">
      Not enough closed positions to chart performance yet.
    </div>;
  }

  const color = kind === 'pnl'
    ? (points[points.length - 1].v >= 0 ? '#34d399' : '#f87171')
    : '#38bdf8';

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1));
    setHover(points[Math.min(Math.max(idx, 0), points.length - 1)] || null);
  };

  const last = points[points.length - 1];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * (H - PAD.t - PAD.b)} y2={PAD.t + f * (H - PAD.t - PAD.b)}
            stroke="#1c2636" strokeWidth="1" strokeDasharray="3 5" />
        ))}
        {geom.zeroY !== null && (
          <line x1={PAD.l} x2={W - PAD.r} y1={geom.zeroY} y2={geom.zeroY} stroke="#334155" strokeWidth="1" />
        )}
        <path d={geom.area} fill="url(#fillGrad)" />
        <path d={geom.line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
        {hover && (() => {
          const i = points.indexOf(hover);
          return (
            <g>
              <line x1={geom.x(i)} x2={geom.x(i)} y1={PAD.t} y2={H - PAD.b} stroke="#475569" strokeWidth="1" strokeDasharray="2 3" />
              <circle cx={geom.x(i)} cy={geom.y(hover.v)} r="3.5" fill={color} />
            </g>
          );
        })()}
        <circle cx={geom.x(points.length - 1)} cy={geom.y(last.v)} r="3" fill={color} />
      </svg>
      {hover ? (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 bg-ink-900/95 border border-line rounded px-2.5 py-1 text-2xs text-slate-300 font-mono tabular-nums pointer-events-none">
          {exactTime(hover.ts)} — <span style={{ color }}>{money(hover.v, { sign: kind === 'pnl' })}</span>
        </div>
      ) : (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 text-2xs text-slate-600 pointer-events-none">
          {kind === 'pnl' ? 'Cumulative realized P&L (closed positions)' : 'Cumulative trade volume'} — latest {money(last.v, { sign: kind === 'pnl' })}
        </div>
      )}
    </div>
  );
}
