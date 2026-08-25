/**
 * Test utility: minimal local mock of the Polymarket public APIs, serving the
 * same REAL fixtures captured during development. Lets us exercise the
 * server-side polling path (no bridge) end to end.
 *
 *   node scripts/mock-polymarket.mjs [PORT]
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 3200);
const W = '0xb1ca909e848cc24ec4e220ce1c453bc290c51705';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://x`);
  const send = (data) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(data));
  };
  switch (u.pathname) {
    case '/public-profile': return send(fixtures.profile);
    case '/public-search': return send(fixtures.search);
    case '/profit': return send(fixtures.lbProfit);
    case '/volume': return send(fixtures.lbVolume);
    case '/trades': return send(fixtures.trades);
    case '/activity': return send(fixtures.activity);
    case '/positions': return send(fixtures.positions);
    case '/closed-positions': return send(fixtures.closedPositions);
    case '/value': return send(fixtures.value);
    case '/traded': return send(fixtures.traded);
    case '/v1/leaderboard': return send([]);
    default: return send([]);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[mock-polymarket] on ${PORT} (wallet ${W})`));
