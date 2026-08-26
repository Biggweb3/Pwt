export type WalletStatus = 'pending' | 'syncing' | 'live' | 'error';

export interface ApiStats {
  pnl: Record<string, number | null>;
  volume: Record<string, number | null>;
  value?: number | null;
  marketsTraded?: number | null;
  fetchedAt?: number;
}

export interface WalletStats {
  computedAt: number;
  lastActivityTs: number | null;
  lastTrade: { ts: number; title: string | null; side: string; outcome: string | null; value: number | null } | null;
  firstObservedTs: number | null;
  trades24h: number;
  volume24h: number | null;
  winRate24h: number | null;
  trades7d: number;
  volume7d: number | null;
  winRateAll: number | null;
  closedAll: number;
  activePositions: number;
  openValue: number | null;
  openUnrealizedPnl: number | null;
  closedPositions: number;
  api: ApiStats | null;
}

export interface Wallet {
  address: string;
  username: string | null;
  pseudonym: string | null;
  bio: string | null;
  profileImage: string | null;
  xUsername: string | null;
  verified: boolean;
  polymarketCreatedAt: string | null;
  profileUrl: string;
  status: WalletStatus;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  initialSyncDone: boolean;
  pollInterval: number;
  addedAt: number;
  newestTradeTs: number | null;
  oldestTradeTs: number | null;
  historyComplete: boolean;
  stats: WalletStats | null;
}

export interface Trade {
  ts: number;
  side: 'BUY' | 'SELL';
  condition_id: string | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  icon: string | null;
  outcome: string | null;
  price: number | null;
  shares: number | null;
  value: number | null;
  tx_hash: string | null;
}

export interface ActivityRow {
  ts: number;
  type: string;
  side: 'BUY' | 'SELL' | null;
  condition_id: string | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  icon: string | null;
  outcome: string | null;
  price: number | null;
  shares: number | null;
  usdc: number | null;
  tx_hash: string | null;
}

export interface FeedItem {
  ts: number;
  type: string;
  side: string | null;
  title: string | null;
  slug: string | null;
  outcome: string | null;
  price: number | null;
  shares: number | null;
  value: number | null;
  txHash: string | null;
  wallet: string;
  username: string | null;
  profileImage: string | null;
}

export interface Position {
  condition_id: string | null;
  size: number | null;
  avg_price: number | null;
  initial_value: number | null;
  current_value: number | null;
  cash_pnl: number | null;
  percent_pnl: number | null;
  cur_price: number | null;
  redeemable?: number | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  outcome: string | null;
  end_date?: string | null;
}

export interface ClosedPosition {
  condition_id: string | null;
  avg_price: number | null;
  total_bought: number | null;
  realized_pnl: number | null;
  cur_price: number | null;
  ts: number | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  outcome: string | null;
  outcome_index: number | null;
}

export interface WindowSummary {
  period: string;
  trades: { trades: number; buys: number; sells: number; volume: number | null; avgTradeSize: number | null; largestTrade: number | null; markets: number };
  win: { closedInWindow: number; wins: number; losses: number; flat: number; winRate: number | null; realizedPnl: number | null };
  positions: { activePositions: number; openValue: number | null; openUnrealizedPnl: number | null; closedPositions: number };
  apiPnl?: number | null;
  apiVolume?: number | null;
}

export interface AlertRule {
  id: number;
  enabled: number;
  kind: string;
  wallet: string | null;
  params: Record<string, unknown>;
  created_at: number;
}

export interface Notification {
  id: number;
  ts: number;
  wallet: string | null;
  kind: string;
  message: string;
  read: number;
}

export interface SystemInfo {
  upstreamOk: boolean;
  mode: 'server' | 'bridge';
  /** 'serverless' when the API runs as a Vercel function (no background sync/SSE). */
  deployment?: 'server' | 'serverless';
  bridgeJobsPending: number;
  pollInterval: number;
  serverTime: number;
}
