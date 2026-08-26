import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, connectEvents, postJson, startBridgeWorker } from './api';
import { loadTracked, saveTracked, untrackLocal } from './tracked';
import type { FeedItem, Notification, SystemInfo, Wallet } from './types';

interface Toast { id: number; message: string; kind: string }

interface Store {
  system: SystemInfo | null;
  wallets: Wallet[];
  walletsLoading: boolean;
  walletsError: string | null;
  feed: FeedItem[];
  unread: number;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  refreshWallets: () => Promise<void>;
  refreshFeed: () => Promise<void>;
  markAllRead: () => Promise<void>;
  setPollInterval: (sec: number) => Promise<void>;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(true);
  const [walletsError, setWalletsError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sysRef = useRef<SystemInfo | null>(null);
  sysRef.current = system;

  const refreshWallets = useCallback(async () => {
    try {
      const rows = await apiFetch<Wallet[]>('/api/wallets');
      setWallets(rows);
      setWalletsError(null);
    } catch (err) {
      setWalletsError((err as Error).message);
    } finally {
      setWalletsLoading(false);
    }
  }, []);

  const refreshFeed = useCallback(async () => {
    try {
      const { feed: rows } = await apiFetch<{ feed: FeedItem[] }>('/api/feed/global?limit=60');
      setFeed(rows);
    } catch { /* keep stale feed on transient errors */ }
  }, []);

  const refreshSystem = useCallback(async () => {
    try {
      const s = await apiFetch<SystemInfo>('/api/system');
      setSystem(s);
    } catch { /* ignore */ }
  }, []);

  // ---- debounced refresh helpers (many SSE events can arrive in bursts) ----
  const walletsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedWallets = useCallback(() => {
    if (walletsTimer.current) return;
    walletsTimer.current = setTimeout(() => { walletsTimer.current = null; refreshWallets(); }, 400);
  }, [refreshWallets]);
  const debouncedFeed = useCallback(() => {
    if (feedTimer.current) return;
    feedTimer.current = setTimeout(() => { feedTimer.current = null; refreshFeed(); }, 400);
  }, [refreshFeed]);

  const pushToast = useCallback((message: string, kind: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 9000);
  }, []);

  // ---- SSE live updates -------------------------------------------------
  // Serverless deployments cannot hold SSE streams open (and the platform
  // would bill a function invocation per reconnect), so we only connect when
  // the server reports a classic long-lived deployment.
  const deployment = system?.deployment;
  useEffect(() => {
    if (deployment === 'serverless') return; // polling loop below drives refreshes
    if (deployment !== 'server') return;     // wait for /api/system before connecting
    const close = connectEvents({
      'wallet:update': () => debouncedWallets(),
      'trades:new': () => { debouncedWallets(); debouncedFeed(); },
      'activity:new': () => debouncedFeed(),
      'feed:update': () => debouncedFeed(),
      alert: (data) => {
        const n = (data as { notification: Notification }).notification;
        if (n) { setUnread((u) => u + 1); pushToast(n.message, n.kind); }
      },
      system: (data) => setSystem((prev) => ({ ...(prev as SystemInfo), ...(data as SystemInfo) })),
    });
    return close;
  }, [deployment, debouncedWallets, debouncedFeed, pushToast]);

  // ---- serverless sync driver --------------------------------------------
  // Replaces the server's background sync engine: ask the API to bring due
  // wallets up to date, then re-read everything. Budgeted server-side.
  useEffect(() => {
    if (deployment !== 'serverless') return;
    let stopped = false;
    const tick = async () => {
      try { await postJson('/api/sync', {}); } catch { /* transient */ }
      if (stopped) return;
      refreshWallets();
      refreshFeed();
    };
    const t = setInterval(tick, 20000);
    const warm = setTimeout(tick, 1500); // kick a pass shortly after load
    return () => { stopped = true; clearInterval(t); clearTimeout(warm); };
  }, [deployment, refreshWallets, refreshFeed]);

  // ---- tracked-wallet memory & serverless auto-reseed --------------------
  // The browser remembers which traders it tracks. If the serverless API
  // loses its ephemeral database (cold start), missing wallets are re-added
  // (one at a time) and fully rebuilt from public Polymarket data.
  const reseedingRef = useRef<Set<string>>(new Set());
  const reseedFailsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!system || walletsLoading) return;
    const stored = loadTracked();
    if (system.deployment !== 'serverless') {
      if (wallets.length || stored.length) saveTracked(wallets.map((w) => w.address));
      return;
    }
    const onServer = new Set(wallets.map((w) => w.address));
    const missing = stored.filter((a) => !onServer.has(a) && !reseedingRef.current.has(a));
    if (missing.length) {
      const address = missing[0];
      reseedingRef.current.add(address);
      postJson('/api/wallets', { input: address })
        .then(() => { reseedFailsRef.current.delete(address); })
        .catch((err) => {
          const status = (err as { status?: number })?.status;
          if (status === 409) return; // another tab seeded it first — fine
          const fails = (reseedFailsRef.current.get(address) || 0) + 1;
          reseedFailsRef.current.set(address, fails);
          if (status === 400 || status === 404 || fails >= 3) untrackLocal(address); // give up quietly
        })
        .finally(() => {
          reseedingRef.current.delete(address);
          refreshWallets();
        });
    } else if (wallets.length) {
      saveTracked(wallets.map((w) => w.address));
    }
  }, [system, wallets, walletsLoading, refreshWallets]);

  // ---- initial load ------------------------------------------------------
  useEffect(() => {
    refreshSystem();
    refreshWallets();
    refreshFeed();
    apiFetch<{ unread: number }>('/api/notifications?limit=1').then((r) => setUnread(r.unread)).catch(() => {});
    const t = setInterval(() => { refreshWallets(); refreshFeed(); }, 15000); // freshness fallback
    return () => clearInterval(t);
  }, [refreshSystem, refreshWallets, refreshFeed]);

  // ---- browser bridge worker (only when the server has no egress) --------
  useEffect(() => {
    if (!system || system.mode !== 'bridge') return;
    const stop = startBridgeWorker(() => sysRef.current);
    return stop;
  }, [system?.mode]);

  const markAllRead = useCallback(async () => {
    await postJson('/api/notifications/read-all', {});
    setUnread(0);
  }, []);

  const setPollInterval = useCallback(async (sec: number) => {
    const r = await postJson<{ pollInterval: number }>('/api/settings', { pollInterval: sec });
    setSystem((s) => (s ? { ...s, pollInterval: r.pollInterval } : s));
    refreshWallets();
  }, [refreshWallets]);

  const value = useMemo<Store>(() => ({
    system, wallets, walletsLoading, walletsError, feed, unread, toasts,
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    refreshWallets, refreshFeed, markAllRead, setPollInterval,
  }), [system, wallets, walletsLoading, walletsError, feed, unread, toasts, refreshWallets, refreshFeed, markAllRead, setPollInterval]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Re-rendering clock for relative timestamps. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
