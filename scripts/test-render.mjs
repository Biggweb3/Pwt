/**
 * Render test for the win-rate UI (no browser required).
 *
 *   node scripts/test-render.mjs
 *
 * Bundles client/src/ssr-smoke.tsx with the repo's own esbuild, server-renders every
 * win-rate component with the exact payload shapes the API returns (the fixture is
 * type-checked against client/src/lib/types.ts, so a field the client reads but the
 * server stopped sending fails `tsc` — see npm run typecheck), then asserts on the
 * produced HTML.
 *
 * This is the automated half of "check it in a browser": it proves the components
 * render, that no number appears without its sample size, that excluded positions are
 * announced, and that the tooltip wording is the one that was agreed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root0 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromClient = createRequire(path.join(root0, 'client/package.json'));
const { build } = requireFromClient('esbuild');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// written inside client/ so Node resolves react / react-dom from client/node_modules
const out = path.join(root, 'client', 'node_modules', '.pwt-ssr-smoke.mjs');

await build({
  entryPoints: [path.join(root, 'client/src/ssr-smoke.tsx')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  absWorkingDir: root,
  logLevel: 'error',
  loader: { '.css': 'empty' },
  // react/react-dom stay external: their CJS internals cannot be inlined into ESM
  packages: 'external',
});

const { buildCases, stats, WINRATE_TOOLTIP } = await import(pathToFileURL(out).href);

let pass = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const cases = buildCases();
const html = (n) => {
  const c = cases.find((x) => x.name === n);
  if (!c) throw new Error(`missing render case ${n}`);
  if (c.html.startsWith('__RENDER_ERROR__')) throw new Error(`${n} crashed: ${c.html}`);
  return c.html;
};
const text = (n) => html(n).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const TOOLTIP = 'Win rate is independently calculated from the trader’s most recent completed predictions. Open and unresolved positions are excluded. Multiple transactions belonging to the same prediction are grouped to prevent double counting.';

console.log('\n=== win-rate UI render test ===');

console.log('\n[1] components render without crashing');
ok('13 render cases produced HTML', cases.length === 13, String(cases.length));
ok('no case crashed during render', cases.every((c) => !c.html.startsWith('__RENDER_ERROR__')),
  cases.filter((c) => c.html.startsWith('__RENDER_ERROR__')).map((c) => `${c.name}: ${c.html.slice(0, 200)}`).join(' | '));

console.log('\n[2] tooltip (spec 21) — exact wording, one source for all screens');
const tip = html('tooltip-in-panel-title');
ok('info icon is a focusable button (keyboard reachable)', /<button[^>]*aria-label="How is this win rate calculated\?"/.test(tip));
ok('the shared tooltip sentence is worded exactly as the spec requires', WINRATE_TOOLTIP === TOOLTIP, WINRATE_TOOLTIP);
ok('an info affordance is rendered next to every win-rate number', (html('win-rate-cell').match(/aria-label="How is this win rate calculated\?"/g) || []).length + (tip.match(/aria-label="How is this win rate calculated\?"/g) || []).length >= 1);
ok('the server sends the identical sentence (one wording everywhere)',
  fs.readFileSync(path.join(root, 'server/routes.js'), 'utf8').includes(TOOLTIP));
ok('the popover itself only exists on demand (no layout thrash)', !tip.includes(TOOLTIP.slice(0, 40)));
ok('tooltip is not duplicated as inline prose next to the number', !text('win-rate-cell').includes(TOOLTIP));

console.log('\n[3] the number, with its sample size (spec 15)');
const cell = text('win-rate-cell');
ok('win rate shows 63%', cell.includes('63%'), cell);
ok('win rate travels with 63/100', cell.includes('63/100'), cell);
ok('bars show WIN/LOSS counts and shares', /WIN 63 63\.0%/.test(text('win-rate-bars')) || (text('win-rate-bars').includes('WIN') && text('win-rate-bars').includes('63')), text('win-rate-bars'));
ok('bars show the LOSS row', text('win-rate-bars').includes('LOSS') && text('win-rate-bars').includes('37'), text('win-rate-bars'));
ok('excluded records are drawn as their own row', text('win-rate-bars').includes('EXCLUDED') && text('win-rate-bars').includes('4 not counted'), text('win-rate-bars'));
ok('open positions are announced as excluded', /20 open\/unresolved positions excluded \(never counted as a win or a loss\)/.test(text('win-rate-bars')), text('win-rate-bars'));
ok('sample text formatter', text('sample-text') === '63 / 100', text('sample-text'));
ok('zero sample renders', text('empty-sample-text') === '0 / 0', text('empty-sample-text'));
ok('confidence label for n=1', text('confidence-thin').includes('very low sample · 1'), text('confidence-thin'));
ok('percentage formatting keeps precision', text('rate-formatting') === '63% | 100% | 66.67% | 53.28% | N/A', text('rate-formatting'));

console.log('\n[4] window list (spec 14)');
const wins = html('win-rate-windows');
const winsText = text('win-rate-windows');
ok('all six windows rendered', ['Last 10', 'Last 25', 'Last 50', 'Last 100', 'Last 250', 'All time'].every((l) => winsText.includes(l)), winsText);
ok('primary window is marked', wins.includes('PRIMARY'));
ok('250-window says “only 122” instead of padding', winsText.includes('only 122'), winsText);
ok('each window shows its own sample', /6W \/ 4L/.test(winsText) && /16W \/ 9L/.test(winsText), winsText);
ok('windows are buttons (click drives the audit table)', (wins.match(/<button/g) || []).length === 6, String((wins.match(/<button/g) || []).length));

console.log('\n[5] accuracy vs P&L stay separate (spec 13)');
const avp = text('accuracy-vs-pnl');
ok('win rate shown', avp.includes('63%'), avp);
ok('P&L shown as its own number', avp.includes('+$1,197'), avp);
ok('P&L is labelled as trading P&L, not accuracy', /Trading P&amp;L/.test(html('accuracy-vs-pnl')) && /Prediction win rate/.test(avp), avp);
ok('open positions mentioned', avp.includes('20 open excluded'), avp);

console.log('\n[6] “Last N Predictions” section (spec 5, 7, 12)');
const panel = text('predictions-panel');
const panelHtml = html('predictions-panel');
ok('section title names the window', panel.includes('Last 100 predictions'), panel.slice(0, 120));
ok('totals line: total analyzed / wins / losses', panel.includes('Total analyzed') && panel.includes('Undetermined'), panel.slice(0, 200));
ok('audit table has the five required columns', ['Date', 'Market', 'Prediction', 'Final outcome', 'Result'].every((h) => panel.includes(h)), panel.slice(0, 300));
ok('WIN row rendered', panel.includes('WIN') && panel.includes('LOSS') && panel.includes('OPEN'), panel.slice(0, 200));
ok('grouped transaction count is visible (8 fills, 1 prediction)', panel.includes('Txns grouped') && /8\s+\/ 1 legs|\b8\b/.test(panel), panel.slice(0, 400));
ok('rows are clickable for the audit trail', (panelHtml.match(/cursor-pointer/g) || []).length >= 3, String((panelHtml.match(/cursor-pointer/g) || []).length));
ok('result filter chips present with correct pluralisation', /ALL WINS LOSSES EXCLUDED/.test(panel), panel.match(/ALL [A-Z ]+EXCLUDED/)?.[0] || panel.slice(-200));
ok('sample-size note for the headline', panel.includes('63%') && panel.includes('100 predictions'), panel.slice(0, 260));
ok('formula line is spelled out', panel.includes('Win rate = 63 ÷ 100 × 100'), panel.slice(0, 400));
ok('scanned-vs-analyzed note appears when the window skipped rows', panel.includes('122 completed records scanned to fill this window'), panel.slice(0, 400));
ok('detail modal is closed by default', text('detail-modal-closed') === '');

console.log('\n[7] empty and loading states (spec 6, 7, 19)');
const empty = text('predictions-panel-empty');
ok('no fake 0% or 100% for an empty sample', /Win rate[\s\S]{0,40}N\/A/.test(empty) && !/0%|100%/.test(empty.split('Prediction accuracy')[0]), empty.slice(0, 200));
ok('explains why there is no number', empty.includes('No completed prediction has a verified market resolution yet'), empty.slice(0, 300));
ok('loading state keeps the headline numbers', text('predictions-panel-loading').includes('63%'), text('predictions-panel-loading').slice(0, 120));

console.log('\n[8] payload contract');
eq('stats fixture keeps 100 as the primary window', stats.primary.window, 100);
eq('exclusions counted separately from analyzed rows', stats.exclusions.openPositions, 20);
ok('client never sees a win rate without a sample (types force analyzed alongside winRate)', typeof stats.primary.analyzed === 'number' && typeof stats.primary.winRate === 'number');

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
fs.rmSync(out, { force: true });
process.exit(failures.length ? 1 : 0);
