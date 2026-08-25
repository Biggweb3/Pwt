/**
 * bridge.js — browser-bridge transport for restricted networks.
 *
 * The primary data path is server-side polling of Polymarket's public APIs.
 * In environments where the server has no egress to Polymarket (detected by
 * polymarketService.probeUpstream), the same requests are delegated to the
 * connected browser, which performs plain public GETs and posts the JSON back.
 *
 * The browser never sees anything private: it relays public read-only URLs,
 * and ALL normalization, dedupe and persistence happens server-side through
 * the exact same ingestion pipeline as server mode.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

let bridgeActive = false;
let lastClientSeenAt = 0;

const pending = new Map(); // jobId -> { url, resolve, timer, createdAt, claimed }

export function setBridgeActive(active) {
  if (bridgeActive === active) return;
  bridgeActive = active;
  console.log(`[bridge] mode: ${active ? 'browser-bridge (server has no Polymarket egress)' : 'server-side polling'}`);
}
export const bridgeInUse = () => bridgeActive;
export const noteBridgeClientSeen = () => { lastClientSeenAt = Date.now(); };
export const bridgeClientSeenRecently = () => Date.now() - lastClientSeenAt < 90_000;

/** Delegate one GET to the browser; resolves with { ok, data } | { ok:false, error }. */
export function bridgeRequest(url) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: bridgeClientSeenRecently() ? 'bridge fetch timed out' : 'no sync client connected (browser tab closed?)' });
    }, config.bridgeJobTimeoutMs);
    pending.set(id, { url, resolve, timer, createdAt: Date.now(), claimed: false });
  });
}

/** Claim up to `limit` unclaimed jobs (long-polled by the browser worker). */
export function claimJobs(limit = 6) {
  const out = [];
  for (const [id, job] of pending) {
    if (job.claimed) continue;
    job.claimed = true;
    out.push({ id, url: job.url });
    if (out.length >= limit) break;
  }
  return out;
}

/** Resolve a job with the browser's result. */
export function resolveJob(id, { ok, data = null, error = null }) {
  const job = pending.get(id);
  if (!job) return false;
  clearTimeout(job.timer);
  pending.delete(id);
  job.resolve(ok ? { ok: true, data } : { ok: false, error: error || 'browser fetch failed' });
  return true;
}

export const pendingJobCount = () => pending.size;
