/**
 * Vercel serverless entrypoint — the same Express app, prebuilt as one
 * self-contained ESM bundle by scripts/build-vercel-api.mjs
 * (`npm run build:vercel-api`). This file exists so the project also deploys
 * correctly when the Vercel project's Root Directory is set to `client/`
 * (files outside that directory cannot be imported at deploy time).
 *
 * Regenerate after changing anything under server/:  npm run build:vercel-api
 */
export { app as default } from '../server/app.js';
