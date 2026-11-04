import type { WalletEntry } from './types';
import { marketUrl, money, short } from './format.ts';

export const LARGE_TRADE_WINDOW_MS = 5 * 60 * 1000;
const SECTION_NAMES: Record<string, string> = { stats: '盈亏统计', history: '盈亏曲线', value: '持仓价值', positions: '当前持仓', closedPositions: '历史持仓', activity: '交易明细' };

export interface Signal {
  key: string;
  title: string;
  detail: string;
  kind: 'error' | 'stale' | 'large';
  time: number | string | null;
  timePrefix?: string;
  url?: string | null;
}

/** Current health is derived afresh; historical coverage limits are not incidents. */
export function buildSignals(entries: WalletEntry[], nowMs: number): Signal[] {
  const operational: Signal[] = [];
  const large: Signal[] = [];
  for (const entry of entries) {
    const { data, wallet } = entry;
    const name = wallet.label || data?.profile.name || short(wallet.address);
    const failed = Object.entries(data?.sections || {}).filter(([, status]) => status === 'error').map(([section]) => SECTION_NAMES[section] || section);
    const pageFailures = Object.entries(data?.coverage || {}).flatMap(([section, coverage]) => coverage.error ? [`${SECTION_NAMES[section] || section}：${coverage.error}`] : []);
    const failure = data?.activityMonitor?.error || (pageFailures.length ? pageFailures.join('；') : null)
      || (failed.length ? `${failed.join('、')}更新失败，保留上次成功数据，恢复后自动清除。` : null) || entry.error;
    if (failure) {
      operational.push({ key: `${wallet.address}:error`, title: '数据更新失败', detail: `${name}：${failure}`, kind: 'error', time: data?.fetchedAt || null, timePrefix: '最近响应' });
    } else if (data?.period?.stale || data?.storage?.stale || data?.activityMonitor?.stale || entry.stale) {
      const reasons = [data?.period?.stale ? '官方盈亏观测尚未更新' : null, data?.storage?.stale ? '后台快照尚未更新' : null, data?.activityMonitor?.stale ? '交易采集延迟' : null].filter(Boolean);
      const sourceOnly = data?.period?.stale && !data?.storage?.stale && !data?.activityMonitor?.stale && !entry.stale;
      operational.push({ key: `${wallet.address}:stale`, title: sourceOnly ? '官方统计观测延迟' : '数据更新延迟', detail: `${name}：${reasons.join('；') || '当前数据已标记为延迟'}，恢复后自动清除。`, kind: 'stale', time: data?.period?.stale ? data.period.observedAt : data?.fetchedAt || null, timePrefix: data?.period?.stale ? '官方观测' : '最近响应' });
    }
    if (!data) continue;
    const duplicates = new Map<string, number>();
    for (const trade of data.activity) {
      const timestamp = trade.timestamp;
      if (trade.type !== 'TRADE' || typeof trade.amount !== 'number' || !Number.isFinite(trade.amount) || trade.amount < 1000
        || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
      const at = timestamp * 1000;
      // Future/unknown timestamps cannot establish that an event is recent.
      if (at > nowMs || at <= nowMs - LARGE_TRADE_WINDOW_MS) continue;
      const key = trade.contentKey || JSON.stringify([trade.transactionHash, timestamp, trade.title, trade.outcome, trade.side, trade.price, trade.size, trade.amount]);
      const occurrence = duplicates.get(key) || 0;
      duplicates.set(key, occurrence + 1);
      large.push({ key: `${wallet.address}:large:${key}:${occurrence}`, title: '大额成交动态', detail: `${name} 在「${trade.title || '未命名市场'}」${trade.side === 'BUY' ? '买入' : trade.side === 'SELL' ? '卖出' : '成交'} ${money(trade.amount)}${trade.outcome ? ` · ${trade.outcome}` : ''}。`, kind: 'large', time: timestamp, timePrefix: '成交', url: marketUrl(trade) });
    }
  }
  large.sort((a, b) => Number(b.time) - Number(a.time));
  return [...operational, ...large.slice(0, 12)];
}

/** Tick even when the last successful API payload has not changed. */
export function startSignalClock(update: (nowMs: number) => void): () => void {
  update(Date.now());
  const timer = setInterval(() => update(Date.now()), 1000);
  return () => clearInterval(timer);
}
