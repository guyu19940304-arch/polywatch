import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Check, Clock3, Copy, LoaderCircle, Plus, Star, Trash2, TriangleAlert, WifiOff } from 'lucide-react';
import type { Range, WalletEntry } from './types';
import type { TradeRow } from './TradingTable';
import { dateTime, marketUrl, money, number, short } from './format';
import './terminal-panels.css';

const RANGE_NAMES: Record<Range, string> = { '1d': '24h', '1w': '7day', '1m': '30day', all: '全部' };
const valueClass = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'tp-positive' : 'tp-negative';
const walletName = (entry: WalletEntry) => entry.wallet.label || entry.data?.profile.name || short(entry.wallet.address);
const clockTime = (timestamp: number | null) => timestamp == null ? '—' : new Date(timestamp * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export interface WalletWatchlistProps {
  entries: WalletEntry[];
  selected: string;
  onSelect: (address: string) => void;
  onAdd: () => void;
  onRemove: (address: string) => void;
  onCopy: (address: string) => void;
  range: Range;
}

export function WalletWatchlist({ entries, selected, onSelect, onAdd, onRemove, onCopy, range }: WalletWatchlistProps) {
  const headingId = useId();
  return <section className="tp-panel watch-panel" aria-labelledby={headingId}>
    <header className="tp-heading watch-heading">
      <h2 id={headingId}>钱包观察列表 <span>Polymarket</span></h2>
      <div className="watch-toolbar">
        <button className={`tp-text-button ${selected === 'all' ? 'watch-all-selected' : ''}`} aria-pressed={selected === 'all'} onClick={() => onSelect('all')}>全部钱包</button>
        <button className="tp-icon-button" onClick={onAdd} title="添加钱包" aria-label="添加关注钱包"><Plus size={15}/></button>
      </div>
    </header>
    <div className="watch-scroll">
      <table className="watch-table">
        <thead><tr><th scope="col">钱包 / 地址</th><th scope="col" className="tp-numeric">周期 PnL <span>({RANGE_NAMES[range]})</span></th><th scope="col" className="tp-numeric">持仓市值</th><th scope="col"><span className="tp-sr-only">钱包操作</span></th></tr></thead>
        <tbody>{entries.map(entry => {
          const { wallet, data } = entry;
          const name = walletName(entry);
          const pnl = data?.range === range && data.period?.complete ? data.period.totalPnl : null;
          const isSelected = selected === wallet.address;
          const demo = data?.source === 'demo';
          return <tr key={wallet.address} className={isSelected ? 'watch-row-selected' : ''} onClick={() => onSelect(wallet.address)}>
            <td><button className="watch-wallet-button" onClick={event => { event.stopPropagation(); onSelect(wallet.address); }} aria-pressed={isSelected} title={`${name} · ${wallet.address}`}>
              <Star size={15} className="watch-star" fill={isSelected ? 'currentColor' : 'none'}/>
              <span className="watch-wallet-name">{name}{demo && <span className="watch-demo">示例</span>}</span>
              <span className="watch-address">{short(wallet.address)}</span>
              {(entry.error || entry.stale || data?.period?.stale) && <TriangleAlert className="watch-warning" size={12} aria-label="数据可能延迟"/>}
            </button></td>
            <td className={`tp-numeric watch-pnl ${valueClass(pnl)}`} title={entry.loading && !data ? '正在获取数据' : data?.period?.reason || undefined}>{entry.loading && !data ? <span className="watch-loading">同步中</span> : money(pnl, true)}</td>
            <td className="tp-numeric watch-value">{money(data?.summary.positionValue)}</td>
            <td className="watch-actions"><button className="tp-icon-button" title={`复制 ${name} 地址`} aria-label={`复制 ${name} 地址`} onClick={event => { event.stopPropagation(); onCopy(wallet.address); }}><Copy size={12}/></button>{!demo && <button className="tp-icon-button watch-remove" title={`移除 ${name}`} aria-label={`移除 ${name}`} onClick={event => { event.stopPropagation(); onRemove(wallet.address); }}><Trash2 size={12}/></button>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {!entries.length && <div className="tp-empty watch-empty"><span>添加钱包，开始读取公开交易与盈亏。</span><button className="tp-text-button" onClick={onAdd}><Plus size={13}/>添加钱包</button></div>}
  </section>;
}

type Signal = {
  key: string;
  title: string;
  detail: string;
  kind: 'error' | 'stale' | 'coverage' | 'large';
  time: number | string | null;
  timePrefix?: string;
  url?: string | null;
};

export interface SignalsPanelProps {
  entries: WalletEntry[];
  isDemo: boolean;
  expanded?: boolean;
}

export function SignalsPanel({ entries, isDemo, expanded = false }: SignalsPanelProps) {
  const headingId = useId();
  const [showAll, setShowAll] = useState(false);
  const signals = useMemo(() => {
    const operational: Signal[] = [];
    const large: Signal[] = [];
    for (const entry of entries) {
      const data = entry.data;
      const name = walletName(entry);
      if (entry.error) operational.push({ key: `${entry.wallet.address}:error`, title: '数据更新失败', detail: `${name}：${entry.error}`, kind: 'error', time: data?.fetchedAt || null, timePrefix: '最近响应' });
      if (!data) continue;
      if (data.period?.stale) operational.push({ key: `${entry.wallet.address}:stale`, title: '统计快照延迟', detail: `${name} 的官方盈亏观测尚未更新，当前数字可能滞后。`, kind: 'stale', time: data.period.observedAt, timePrefix: '官方观测' });
      if (!data.coverage.positions.complete || !data.coverage.closedPositions.complete) operational.push({ key: `${entry.wallet.address}:coverage`, title: '历史记录未完整加载', detail: `${name}：当前持仓 ${number(data.coverage.positions.count)} 条，历史持仓 ${number(data.coverage.closedPositions.count)} 条；部分记录未加载，窗口盈亏可能不完整。`, kind: 'coverage', time: null });
      else if (data.period && !data.period.complete) operational.push({ key: `${entry.wallet.address}:period`, title: '周期边界数据不足', detail: `${name}：${data.period.reason || '官方历史快照缺少周期边界，暂不计算该周期盈亏。'}`, kind: 'coverage', time: null });
      const duplicates = new Map<string, number>();
      for (const trade of data.activity) {
        if (trade.type !== 'TRADE' || trade.amount == null || trade.amount < 1000) continue;
        const key = trade.contentKey || JSON.stringify([trade.transactionHash, trade.timestamp, trade.title, trade.outcome, trade.side, trade.price, trade.size, trade.amount]);
        const occurrence = duplicates.get(key) || 0;
        duplicates.set(key, occurrence + 1);
        large.push({ key: `${entry.wallet.address}:large:${key}:${occurrence}`, title: '大额成交', detail: `${name} 在「${trade.title || '未命名市场'}」${trade.side === 'BUY' ? '买入' : trade.side === 'SELL' ? '卖出' : '成交'} ${money(trade.amount)}${trade.outcome ? ` · ${trade.outcome}` : ''}。`, kind: 'large', time: trade.timestamp, url: marketUrl(trade) });
      }
    }
    large.sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
    return [...operational, ...large.slice(0, 12)];
  }, [entries]);
  const all = expanded || showAll;
  const visible = all ? signals : signals.slice(0, 3);
  const loading = entries.some(entry => entry.loading) && !entries.some(entry => entry.data);
  return <section className={`tp-panel signal-panel ${expanded ? 'signal-expanded' : ''}`} aria-labelledby={headingId}>
    <header className="tp-heading signal-heading"><h2 id={headingId}>异常提醒</h2><span className="signal-scope">{isDemo ? '示例数据' : '本页监测'}</span></header>
    <div className="signal-list">{visible.map(signal => {
      const Icon = signal.kind === 'error' ? WifiOff : signal.kind === 'stale' ? Clock3 : TriangleAlert;
      return <article key={signal.key} className={`signal-item signal-${signal.kind}`}>
        <Icon size={20} className="signal-icon" aria-hidden="true"/>
        <div className="signal-content"><div className="signal-item-heading"><h3>{signal.title}</h3>{signal.time != null && <time title={`${signal.timePrefix ? `${signal.timePrefix} · ` : ''}${dateTime(signal.time)}`}>{signal.timePrefix && <span>{signal.timePrefix} </span>}{dateTime(signal.time)}</time>}</div><p title={signal.detail}>{signal.detail}</p>{signal.url && <a className="signal-market-link" href={signal.url} target="_blank" rel="noreferrer">查看市场<ArrowUpRight size={11}/></a>}</div>
      </article>;
    })}
    {!signals.length && <div className="tp-empty signal-empty">{loading ? <LoaderCircle size={21} className="tp-spinning"/> : <Check size={21}/>}<strong>{loading ? '正在读取监测数据' : '未发现本页提醒'}</strong><span>{loading ? '数据返回后检查刷新状态与大额成交。' : '当前已加载数据未触发提醒。'}</span></div>}</div>
    <footer className="signal-footer"><span>仅已加载数据 · 单笔成交 ≥ $1,000</span>{!expanded && signals.length > 3 && <button className="tp-text-button" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `展开 ${signals.length} 项`}</button>}<p>仅在当前页面检查，不提供全天候后台告警。</p></footer>
  </section>;
}

export interface TradeTapeProps {
  trades: TradeRow[];
  isDemo: boolean;
  refreshing: boolean;
  onShowAll: () => void;
  pollingSeconds?: number;
}

function tradeSignature(trade: TradeRow) {
  return JSON.stringify([trade.walletAddress.toLowerCase(), trade.transactionHash, trade.timestamp, trade.type, trade.side, trade.slug, trade.eventSlug, trade.title, trade.outcome, trade.price, trade.size, trade.amount]);
}

export function TradeTape({ trades, isDemo, refreshing, onShowAll, pollingSeconds = 15 }: TradeTapeProps) {
  const headingId = useId();
  const [highlighted, setHighlighted] = useState<Set<string>>(() => new Set());
  const seen = useRef<{ scope: string; ready: boolean; counts: Map<string, number>; newest: number }>({ scope: '', ready: false, counts: new Map(), newest: 0 });
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filled = useMemo(() => trades.filter(trade => trade.type === 'TRADE').sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)), [trades]);
  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    return filled.slice(0, 12).map(trade => {
      const signature = tradeSignature(trade);
      const occurrence = (counts.get(signature) || 0) + 1;
      counts.set(signature, occurrence);
      return { trade, signature, occurrence, key: `${signature}:${occurrence}` };
    });
  }, [filled]);
  const scope = `${isDemo ? 'demo' : 'live'}:${[...new Set(trades.map(trade => trade.walletAddress))].sort().join(',')}`;
  const snapshot = rows.map(row => row.key).join('|');
  useEffect(() => {
    if (!rows.length) return;
    const current = seen.current;
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.signature, row.occurrence);
    const newest = Math.max(...rows.map(row => row.trade.timestamp || 0));
    if (!current.ready || current.scope !== scope) {
      seen.current = { scope, ready: true, counts, newest };
      setHighlighted(new Set());
      return;
    }
    const fresh = rows.filter(row => row.occurrence > (current.counts.get(row.signature) || 0) && row.trade.timestamp != null && row.trade.timestamp >= current.newest).map(row => row.key);
    for (const [signature, count] of counts) current.counts.set(signature, Math.max(current.counts.get(signature) || 0, count));
    current.newest = Math.max(current.newest, newest);
    if (current.counts.size > 240) {
      const keep = new Set(rows.map(row => row.signature));
      for (const signature of current.counts.keys()) if (!keep.has(signature)) current.counts.delete(signature);
    }
    if (fresh.length) {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      setHighlighted(new Set(fresh));
      highlightTimer.current = setTimeout(() => setHighlighted(new Set()), 2400);
    }
  }, [snapshot, scope]);
  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);
  return <section className="tp-panel tape-panel" aria-labelledby={headingId}>
    <header className="tp-heading tape-heading"><h2 id={headingId}>实时成交 <span>Polymarket</span></h2><span className={`tape-state ${isDemo ? 'tape-demo' : ''}`}><i/>{isDemo ? '静态示例' : refreshing ? '正在检查' : "每" + pollingSeconds + "秒检查"}</span></header>
    <div className="tape-scroll" tabIndex={0} role="region" aria-label="最新12笔成交，可滚动查看"><table className="tape-table"><thead><tr><th scope="col">时间 <span>UTC+8</span></th><th scope="col">市场 / 钱包</th><th scope="col">方向</th><th scope="col" className="tp-numeric">价格</th><th scope="col" className="tp-numeric">数量</th><th scope="col" className="tp-numeric">金额 <span>USD</span></th></tr></thead><tbody>{rows.map(({ trade, key }) => {
      const url = marketUrl(trade);
      const direction = trade.side === 'BUY' ? '买入' : trade.side === 'SELL' ? '卖出' : '成交';
      return <tr key={key} className={highlighted.has(key) ? 'tape-new-row' : ''}>
        <td className="tape-time" title={dateTime(trade.timestamp)}>{clockTime(trade.timestamp)}</td>
        <td className="tape-market"><div>{url ? <a href={url} target="_blank" rel="noreferrer" title={trade.title}>{trade.title || '未命名市场'}</a> : <span title={trade.title}>{trade.title || '未命名市场'}</span>}</div><small title={`${trade.walletName} · ${trade.walletAddress}`}>{trade.walletName}{trade.outcome && <span> · {trade.outcome}</span>}</small></td>
        <td><span className={`tape-side ${trade.side === 'BUY' ? 'tp-positive' : trade.side === 'SELL' ? 'tp-negative' : ''}`}>{direction}</span></td>
        <td className="tp-numeric">{trade.price == null ? '—' : trade.price.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 })}</td><td className="tp-numeric">{number(trade.size)}</td><td className="tp-numeric tape-amount">{money(trade.amount)}</td>
      </tr>;
    })}</tbody></table>
    {!rows.length && <div className="tp-empty tape-empty">{refreshing ? <LoaderCircle size={22} className="tp-spinning"/> : <Activity size={22}/>}<strong>{refreshing ? '正在读取成交记录' : '暂无买入或卖出成交'}</strong><span>最新成交会按时间倒序显示。</span></div>}</div>
    <footer className="tape-footer"><span>最新 {rows.length} 笔 / 已加载 {number(filled.length)} 笔成交</span><button className="tp-text-button" onClick={onShowAll}>全部成交<ArrowUpRight size={12}/></button></footer>
  </section>;
}
