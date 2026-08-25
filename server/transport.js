/**
 * transport.js — executes a Polymarket GET either server-side (normal mode) or
 * by delegating to the connected browser (bridge mode, used when the server
 * itself has no egress to Polymarket). All callers get identical JSON.
 */
import { config } from './config.js';
import { bridgeInUse, bridgeRequest, noteBridgeClientSeen } from './bridge.js';

export class TransportError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
  }
}

export async function transportGet(url, { timeoutMs = config.requestTimeoutMs } = {}) {
  if (bridgeInUse()) {
    noteBridgeClientSeen();
    const res = await bridgeRequest(url);
    if (!res.ok) throw new TransportError(res.error || 'bridge fetch failed');
    return res.data;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    throw new TransportError(err?.name === 'AbortError' ? 'request timed out' : `network error: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new TransportError(`HTTP ${res.status} from Polymarket`, { status: res.status });
  try {
    return await res.json();
  } catch (err) {
    throw new TransportError(`invalid JSON from Polymarket: ${err.message}`);
  }
}

export const qs = (base, params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
};
