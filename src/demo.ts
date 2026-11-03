import type { Activity, MarketWindow, Period, Position, Range, WalletConfig, WalletData } from './types';

// Deliberately static, isolated demo fixtures. These are never used as an API fallback.
export const DEMO_WALLETS: WalletConfig[] = [
  { address: '0x0000000000000000000000000000000000000001', label: 'Whale Alpha', color: '#168974' },
  { address: '0x0000000000000000000000000000000000000002', label: 'Steady Capital', color: '#777ac7' },
];
const END = Date.parse('2026-11-03T06:30:00Z') / 1000;
const ISO = new Date(END * 1000).toISOString();
const questions = [
  ['Will Bitcoin reach $100,000?', 'Yes', 0.72, 'BUY', 2000],
  ['Fed rate cut in December?', 'Yes', 0.63, 'BUY', 5000],
  ['NBA champion 2027?', 'No', 0.38, 'SELL', 3000],
  ['Will Bitcoin reach $100,000?', 'No', 0.29, 'SELL', 4000],
  ['NBA champion 2027?', 'Yes', 0.56, 'BUY', 1500],
  ['Will Ethereum reach $5,000?', 'Yes', 0.44, 'BUY', 2400],
  ['Fed rate cut in December?', 'No', 0.37, 'SELL', 1000],
  ['Will Bitcoin reach $100,000?', 'Yes', 0.69, 'BUY', 3200],
] as const;

function position(id: string, title: string, outcome: string, size: number, currentPrice: number, pnl: number): Position {
  const currentValue = Math.round(size * currentPrice * 100) / 100;
  return {
    id, conditionId: id, title, outcome, size,
    avgPrice: (currentValue - pnl) / size, currentPrice, currentValue,
    realizedPnl: 0, unrealizedPnl: pnl, totalPnl: pnl, costBasis: currentValue - pnl,
    status: 'OPEN', redeemable: false, archived: false, slug: '', eventSlug: '', icon: '', timestamp: END,
  };
}

const summaries = [
  { totalPnl: 17820.34, realizedPnl: 13900.12, unrealizedPnl: 3920.22, positionValue: 58940.2, volume: 263180.5, tradeCount: 174 },
  { totalPnl: 6760.28, realizedPnl: 4520.03, unrealizedPnl: 2240.25, positionValue: 27489.1, volume: 124560.45, tradeCount: 92 },
];
const positions = [
  [position('demo-p1', 'Will Bitcoin reach $100,000?', 'Yes', 40000, 0.82, 5200), position('demo-p2', 'NBA champion 2027?', 'No', 40000, 0.653505, -1279.78)],
  [position('demo-p3', 'Fed rate cut in December?', 'Yes', 30000, 0.74, 3100), position('demo-p4', 'Will Ethereum reach $5,000?', 'Yes', 10000, 0.52891, -859.75)],
];

export function getDemoData(range: Range): Record<string, WalletData> {
  const days = range === '1d' ? 1 : range === '1w' ? 7 : range === 'all' ? 90 : 30;
  return Object.fromEntries(DEMO_WALLETS.map((wallet, walletIndex) => {
    const summary = summaries[walletIndex];
    const rangeFraction = range === '1d' ? 0.13 : range === '1w' ? 0.38 : range === '1m' ? 0.72 : 1;
    const pointCount = days === 1 ? 25 : days + 1;
    const history = Array.from({ length: pointCount }, (_, index) => {
      const progress = index / (pointCount - 1);
      const wave = Math.sin(index * 2.9) * 0.035 * Math.sin(Math.PI * progress);
      const factor = Math.max(0, 1 - rangeFraction + rangeFraction * progress + wave * rangeFraction);
      const realizedPnl = Math.round(summary.realizedPnl * factor * 100) / 100;
      const unrealizedPnl = Math.round(summary.unrealizedPnl * factor * 100) / 100;
      return { timestamp: END - days * 86400 * (1 - progress), totalPnl: realizedPnl + unrealizedPnl, realizedPnl, unrealizedPnl };
    });
    const activity: Activity[] = questions.flatMap(([title, outcome, price, side, size], i) => i % 2 === walletIndex ? [{
      id: `demo-trade-${i}`, contentKey: `demo-trade-content-${i}`, type: 'TRADE', side, title, outcome, price, size,
      amount: Math.round(size * price * 100) / 100, timestamp: END - i * 173,
      transactionHash: '', slug: '', eventSlug: '', icon: '', isCombo: false,
    }] : []);
    const periodFor = (requested: Range): Period => {
      const fraction = requested === '1d' ? 0.13 : requested === '1w' ? 0.38 : requested === '1m' ? 0.72 : 1;
      const realizedPnl = Math.round(summary.realizedPnl * fraction * 100) / 100;
      const unrealizedPnl = Math.round(summary.unrealizedPnl * fraction * 100) / 100;
      return { range: requested, start: END - (requested === '1d' ? 1 : requested === '1w' ? 7 : requested === '1m' ? 30 : 90) * 86400,
        end: END, totalPnl: realizedPnl + unrealizedPnl, realizedPnl, unrealizedPnl, complete: true, reason: null, sourceFidelity: 'demo', observedAt: END, stale: false };
    };
    const windows: MarketWindow[] = positions[walletIndex].map((row, i) => ({
      id: row.conditionId, conditionId: row.conditionId,
      title: i === 0 ? 'Bitcoin Up or Down — November 3, 2:25PM–2:30PM' : row.title,
      slug: '', eventSlug: '', icon: '', outcomes: i === 0 ? ['Up', 'Down'] : [row.outcome],
      positionCount: i === 0 ? 2 : 1, totalPnl: row.totalPnl, realizedPnl: row.realizedPnl,
      unrealizedPnl: row.unrealizedPnl, currentValue: row.currentValue, status: 'OPEN',
      timestamp: END, windowStart: i === 0 ? END - 300 : null, endTime: i === 0 ? END : null,
      isBtc5m: i === 0, complete: true,
    }));
    const value: WalletData = {
      address: wallet.address, fetchedAt: ISO, source: 'demo', range,
      profile: { name: wallet.label, avatar: '' },
      summary: { ...summary, observedAt: END, economicPnl: summary.totalPnl, walletIncome: 0, feesPaid: 0, source: 'demo' },
      period: periodFor(range), periods: { '1d': periodFor('1d'), '1w': periodFor('1w'), '1m': periodFor('1m') }, windows,
      history, historySourceFidelity: '1d', positions: positions[walletIndex], closedPositions: [],
      activity, activityPagination: { hasMore: false, nextCursor: null }, activityFetchedAt: ISO,
      coverage: { positions: { complete: true, count: 2, fetchedAt: ISO }, closedPositions: { complete: true, count: 0, fetchedAt: ISO } },
      sections: { stats: 'ok', history: 'ok', value: 'ok', positions: 'ok', closedPositions: 'ok', activity: 'ok' },
      warnings: [], methodology: '演示数据仅用于界面预览。添加钱包后，所有统计和交易均切换为 Polymarket 公开数据。',
    };
    return [wallet.address, value];
  }));
}
