export type Range = '1d' | '1w' | '1m' | 'all';
export type Amount = number | null;

export interface WalletConfig {
  address: string;
  label: string;
  color: string;
}

export interface HistoryPoint {
  timestamp: number;
  totalPnl: Amount;
  realizedPnl: Amount;
  unrealizedPnl: Amount;
}

export interface Position {
  id: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: Amount;
  avgPrice: Amount;
  currentPrice: Amount;
  currentValue: Amount;
  realizedPnl: Amount;
  unrealizedPnl: Amount;
  totalPnl: Amount;
  costBasis: Amount;
  status: string;
  redeemable: boolean;
  archived: boolean;
  slug: string;
  eventSlug: string;
  icon: string;
  timestamp: number | null;
}

export interface Activity {
  id: string;
  contentKey: string;
  type: string;
  side: string;
  title: string;
  outcome: string;
  price: Amount;
  size: Amount;
  amount: Amount;
  timestamp: number | null;
  transactionHash: string;
  slug: string;
  eventSlug: string;
  icon: string;
  isCombo: boolean;
}

export interface Pagination {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ActivityMonitor {
  error: string | null;
  gap: string | null;
  stale: boolean;
  retentionDays: number;
}

export interface ActivityResponse {
  activity: Activity[];
  pagination: Pagination;
  fetchedAt: string;
  monitor?: ActivityMonitor;
}

export interface WalletSummary {
  totalPnl: Amount;
  realizedPnl: Amount;
  unrealizedPnl: Amount;
  positionValue: Amount;
  volume: Amount;
  tradeCount: Amount;
  observedAt: number | null;
  economicPnl: Amount;
  walletIncome: Amount;
  feesPaid: Amount;
  source: 'polymarket-v2' | 'demo';
}

export interface Coverage {
  complete: boolean;
  count: number;
  fetchedAt: string | null;
}

export interface Period {
  range: Range;
  start: number | null;
  end: number | null;
  totalPnl: Amount;
  realizedPnl: Amount;
  unrealizedPnl: Amount;
  complete: boolean;
  reason: string | null;
  sourceFidelity: string | null;
  observedAt: number | null;
  stale: boolean;
}

export interface MarketWindow {
  id: string;
  conditionId: string;
  title: string;
  slug: string;
  eventSlug: string;
  icon: string;
  outcomes: string[];
  positionCount: number;
  totalPnl: Amount;
  realizedPnl: Amount;
  unrealizedPnl: Amount;
  currentValue: Amount;
  status: 'OPEN' | 'REDEEMABLE' | 'CLOSED';
  timestamp: number | null;
  windowStart: number | null;
  endTime: number | null;
  isBtc5m: boolean;
  complete: boolean;
}

export interface WalletData {
  address: string;
  fetchedAt: string;
  source: 'live' | 'demo';
  range: Range;
  profile: { name: string; avatar: string };
  summary: WalletSummary;
  period: Period;
  periods: Record<'1d' | '1w' | '1m', Period>;
  windows: MarketWindow[];
  history: HistoryPoint[];
  /** All locally retained snapshots (up to 30 days), with Unix-second timestamps. */
  historyAll?: HistoryPoint[];
  historySourceFidelity: string | null;
  positions: Position[];
  closedPositions: Position[];
  activity: Activity[];
  activityPagination: Pagination;
  activityFetchedAt: string | null;
  activityMonitor?: ActivityMonitor;
  coverage: { positions: Coverage; closedPositions: Coverage };
  sections: Record<'stats' | 'history' | 'value' | 'positions' | 'closedPositions' | 'activity', 'ok' | 'error'>;
  sectionFetchedAt?: Partial<Record<'stats' | 'history' | 'value' | 'positions' | 'closedPositions' | 'activity', string | null>>;
  persisted?: boolean;
  storage?: { persisted: boolean; retentionDays: number; stale: boolean; snapshotAt: string; activityAt: string | null };
  warnings: string[];
  methodology: string;
}

export interface WalletState {
  loading: boolean;
  stale: boolean;
  error: string | null;
  loadingMore: boolean;
}

export interface WalletEntry extends WalletState {
  wallet: WalletConfig;
  data: WalletData | null;
}

export interface MonitorWallet {
  address: string;
  lastSuccess: number | null;
  snapshotAt: number | null;
  activityAt: number | null;
  snapshotError: string | null;
  activityError: string | null;
  backfill: { complete: boolean; cursor: string | null; oldestSeen: number | null; pages: number; gap: string | null } | null;
}

export interface MonitorStatus {
  loading: boolean;
  available: boolean;
  enabled: boolean;
  retentionDays: number;
  activityIntervalMs: number;
  snapshotIntervalMs: number;
  addresses: string[];
  /** Collector timestamps are Unix milliseconds, unlike portfolio snapshots. */
  wallets: MonitorWallet[];
  error: string | null;
}
