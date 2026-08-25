import type { SystemInfo } from './types';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' }, ...init });
  } catch (err) {
    throw new ApiError('Cannot reach the dashboard server.', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error || `Request failed (HTTP ${res.status})`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

export const postJson = <T>(path: string, payload: unknown) =>
  apiFetch<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

export const del = <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' });
export const patchJson = <T>(path: string, payload: unknown) =>
  apiFetch<T>(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

/** SSE subscription with automatic reconnect. Returns a close function. */
export function connectEvents(handlers: Record<string, (data: unknown) => void>): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    es = new EventSource('/api/events');
    for (const [type, fn] of Object.entries(handlers)) {
      es.addEventListener(type, (ev) => {
        try { fn(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
      });
    }
    es.onerror = () => {
      es?.close();
      if (!closed) retry = setTimeout(open, 3000);
    };
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

/**
 * Browser-bridge sync client.
 * Active only when the server reports it cannot reach Polymarket itself
 * (restricted egress). The browser performs plain public GETs on the user's
 * normal network connection and posts the JSON back; the server performs all
 * normalization/persistence. Public read-only data only — never credentials.
 */
export function startBridgeWorker(getSystem: () => SystemInfo | null): () => void {
  let stopped = false;
  let busy = 0;

  async function runJob(job: { id: string; url: string }) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(job.url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) {
        await postJson('/api/bridge/result', { id: job.id, ok: false, error: `HTTP ${res.status}` });
        return;
      }
      const data = await res.json();
      await postJson('/api/bridge/result', { id: job.id, ok: true, data });
    } catch (err) {
      try {
        await postJson('/api/bridge/result', { id: job.id, ok: false, error: String((err as Error)?.message || err) });
      } catch { /* server gone */ }
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        const sys = getSystem();
        if (sys && sys.mode === 'bridge') {
          const { jobs } = await apiFetch<{ jobs: { id: string; url: string }[] }>('/api/bridge/next');
          if (jobs.length) {
            busy += jobs.length;
            await Promise.all(jobs.map(runJob));
            busy -= jobs.length;
            continue; // immediately look for more
          }
        }
      } catch { /* transient */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  loop();
  return () => { stopped = true; };
}
