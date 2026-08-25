/**
 * events.js — SSE hub pushing live updates to connected dashboards.
 * Event types:
 *   wallet:update   {walletId, status}          wallet state changed
 *   trades:new      {walletId, count, sample}   new trades ingested
 *   activity:new    {walletId, count}           new non-trade activity
 *   feed:update     {}                          global feed has new rows
 *   alert           {notification}              alert rule fired
 *   system          {upstreamOk, mode}          connectivity changed
 */
const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, id: Math.random().toString(36).slice(2) };
  clients.add(client);
  send(client, 'hello', { t: Date.now(), clients: clients.size });
  req.on('close', () => clients.delete(client));
}

function send(client, type, data) {
  try {
    client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client gone */ }
}

export function broadcast(type, data) {
  if (!clients.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}

export const sseClientCount = () => clients.size;

// keep connections alive through proxies
setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': hb\n\n'); } catch { clients.delete(c); }
  }
}, 25_000).unref();
