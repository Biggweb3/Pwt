/**
 * Bundles the serverless API entrypoint (server/vercelEntry.js) together with
 * the whole server/ tree and its dependencies into ONE self-contained ESM
 * file at client/api/index.js. That file is committed so the app deploys on
 * Vercel even when the project's Root Directory is `client/` (Vercel only
 * uploads files under the root directory, so the api function cannot import
 * from ../server at deploy time).
 *
 *   npm run build:vercel-api
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [path.join(root, 'server/vercelEntry.js')],
  outfile: path.join(root, 'client/api/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22.0',
  format: 'esm',
  legalComments: 'none',
  sourcemap: false,
  minify: true,
  logLevel: 'info',
  banner: {
    // Some bundled CommonJS dependencies call require() at runtime.
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});

const { stat } = await import('node:fs/promises');
const size = (await stat(path.join(root, 'client/api/index.js'))).size;
console.log(`[build-vercel-api] wrote client/api/index.js (${(size / 1024).toFixed(0)} KB)`);
