/**
 * Vercel serverless entrypoint (repo root project).
 *
 * An Express app is itself a Node HTTP request handler, so exporting it turns
 * the whole dashboard API into one serverless function. All /api/* requests
 * are routed here by the rewrite in vercel.json; everything else is served
 * from the static Vite build (client/dist) by the platform.
 *
 * Serverless adaptations live in server/config.js (ephemeral SQLite in /tmp),
 * server/routes.js (POST /api/sync, SSE disabled) and server/syncEngine.js
 * (budget-bounded, request-driven syncing).
 */
export { app as default } from '../server/app.js';
