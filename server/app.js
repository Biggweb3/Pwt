/**
 * app.js — the Express application, independent of how it is served.
 *
 * Two serving modes share this exact app:
 *   1. Long-lived server (`node server/index.js`, also used by `npm run dev`):
 *      listens on a port, runs the upstream probe loop and the background
 *      sync engine, and serves the built client with an SPA fallback.
 *   2. Vercel serverless function (api/index.js at the repo root, or the
 *      prebuilt bundle at client/api/index.js): the app object itself is the
 *      request handler. Background loops cannot survive between invocations,
 *      so syncing is request-driven (POST /api/sync) and SSE is disabled —
 *      see routes.js and syncEngine.js for the serverless adaptations.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { api } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', api);

  // Unknown /api routes fall through the router -> JSON 404 (never HTML).
  app.use('/api', (req, res) => res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` }));

  // Static frontend (built Vite app) with SPA fallback — long-lived server
  // mode only; on Vercel the platform serves the static build itself.
  const distDir = path.join(config.root, 'client', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  } else if (!config.isServerless) {
    app.get('/', (req, res) => res.type('text/plain').send('Polymarket Intel API is running. Build the client with `npm run build`.'));
  }

  app.use((err, req, res, next) => {
    console.error('[api-error]', err?.message || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export const app = createApp();
