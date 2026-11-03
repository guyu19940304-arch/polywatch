import { useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, Check, ChevronRight, CircleHelp, Layers, ListOrdered, RefreshCw, ShieldCheck, X, Zap } from 'lucide-react';
import { useWallets } from './useWallets';
import { Stats } from './Stats';
import { HistoryChart, combineHistory } from './HistoryChart';
import { TradingTable } from './TradingTable';
import { WindowTable } from './WindowTable';
import { WalletWatchlist, SignalsPanel, TradeTape } from './TerminalPanels';
import { WindowWorkspace } from './WindowWorkspace';
import { short, dateTime } from './format';
import type { WalletData, Range } from './types';

type View = 'overview' | 'activity' | 'positions' | 'windows' | 'events';
const NAV = [
  { id: 'overview', label: '钱包监控', icon: Activity },
  { id: 'windows', label: '窗口分析', icon: BarChart3 },
  { id: 'positions', label: '持仓分析', icon: Layers },
  { id: 'activity', label: '交易流水', icon: ListOrdered },
  { id: 'events', label: '事件追踪', icon: Zap },
] as const;
const RANGES: { id: Range; label: string }[] = [{ id: '1d', label: '24h' }, { id: '1w', label: '7day' }, { id: '1m', label: '30day' }];
const RANGE_LABEL = { '1d': '24 小时', '1w': '7 天', '1m': '30 天', all: '全部' };

function Methodology({ onClose, background }: { onClose: () => void; background: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="info-dialog" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }} aria-labelledby="methodology-title">
    <div className="modal-top"><span className="eyebrow">DATA METHODOLOGY</span><button className="icon-button" aria-label="关闭说明" onClick={onClose}><X size={19}/></button></div>
    <h2 id="methodology-title">盈亏统计口径</h2>
    <p><b>周期总盈亏</b>：官方累计仓位盈亏在所选时间段内的变化。24h / 7day / 30day 为滚动周期，依据可用快照计算；边界缺失时显示“—”并提示。</p>
    <p><b>累计总盈亏</b> = 已实现盈亏 + 未实现盈亏。手续费沿用官方口径，不重复扣除；奖励、返佣、存取款不并入仓位盈亏。</p>
    <p><b>窗口盈亏</b>：同一市场 conditionId 的 Up / Down 等结果仓位合并，包含已平仓和当前持仓；每个窗口显示该窗口的累计盈亏，独立于顶部周期选择。BTC 5m 按市场 slug 识别。</p>
    <p><b>更新速度</b>：{background ? '后台持续采集，前台每5秒读取成交，盈亏及持仓快照每60秒更新。关闭网页不影响后台任务。' : '前台每15秒检查新交易，盈亏快照缓存60秒；页面隐藏时暂停刷新。'}官方索引和盈亏统计可能延迟，实际观测时间显示在界面中。</p>
    <p><b>历史与提醒</b>：{background ? '本地数据库滚动保留30天的交易与历史快照，首次启动后逐页补齐；当前仍在持有的仓位及最新官方累计摘要保留用于计算。' : '当前为前台监测，尚未开启持久化采集。'}提醒显示在页面内，没有外部消息推送。</p>
    <p>监控钱包由部署者统一指定，页面仅用于查看公开数据。部分数据缺失时不将其当作零收益。</p>
    <div className="modal-footer"><a href="https://data-api.polymarket.com/v2/docs" target="_blank" rel="noreferrer">官方数据接口文档 ↗</a><button className="button primary" onClick={onClose}>知道了</button></div>
  </dialog>;
}

export default function App() {
  const model = useWallets();
  const { wallets, entries, isDemo, range, setRange, refreshing, monitor, configurationLoading, configurationError } = model;
  const [view, setView] = useState<View>('overview');
  const [selected, setSelected] = useState('all');
  const [toast, setToast] = useState('');
  const [info, setInfo] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const activeSelection = selected === 'all' || !wallets.some(w => w.address === selected) ? 'all' : selected;
  const selection = activeSelection === 'all' ? entries : entries.filter(e => e.wallet.address === activeSelection);
  const background = monitor.enabled && selection.length > 0 && selection.every(e => monitor.addresses.includes(e.wallet.address));
  const configurationPending = configurationLoading && wallets.length === 0;
  const configurationEmpty = !configurationLoading && !configurationError && wallets.length === 0;
  const emptyWalletMessage = configurationPending ? '正在读取监控钱包' : configurationError ? '暂时无法读取监控钱包' : '部署者尚未配置监控钱包';
  const available = selection.filter(e => e.data).map(e => ({ wallet: e.wallet, data: e.data! }));
  const complete = available.length === selection.length && selection.length > 0;
  const aligned = complete && available.every(e => e.data.range === range && e.data.period?.start === available[0].data.period?.start && e.data.period?.end === available[0].data.period?.end);
  const sum = (get: (data: WalletData) => number | null | undefined) => !complete || available.some(e => get(e.data) == null) ? null : available.reduce((n, e) => n + get(e.data)!, 0);
  const summary = { totalPnl: aligned ? sum(d => d.period?.totalPnl) : null, realizedPnl: aligned ? sum(d => d.period?.realizedPnl) : null };
  const allPnl = sum(d => d.summary.totalPnl);
  const history = aligned && available.every(e => e.data.period?.complete) ? combineHistory(available.map(e => e.data.history)) : [];
  const historyEnd = history.at(-1);
  const historyBaseline = aligned && summary.totalPnl != null && historyEnd?.totalPnl != null && historyEnd.timestamp === available[0]?.data.period.end ? historyEnd.totalPnl - summary.totalPnl : undefined;
  const trades = available.flatMap(({ wallet, data }) => data.activity.map(t => ({ ...t, walletName: wallet.label || data.profile.name || short(wallet.address), walletAddress: wallet.address }))).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const positions = available.flatMap(({ wallet, data }) => data.positions.map(p => ({ ...p, walletName: wallet.label || data.profile.name || short(wallet.address), walletAddress: wallet.address }))).sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
  const errors = selection.filter(e => e.error);
  const warnings = [...new Set(available.flatMap(e => e.data.warnings))];
  const statsTimes = available.map(e => e.data.summary.observedAt).filter((t): t is number => t != null);
  const observedAt = complete && statsTimes.length === available.length ? Math.min(...statsTimes) : null;
  const covered = complete && available.every(e => e.data.coverage.positions.complete && e.data.coverage.closedPositions.complete);
  const scopeName = wallets.length === 0 ? emptyWalletMessage : activeSelection === 'all' ? `全部钱包 · ${entries.length}` : available[0]?.wallet.label || short(activeSelection);
  const connectionWarning = errors.length > 0 || Boolean(configurationError) || configurationEmpty;
  const connectionLabel = configurationPending ? '正在连接' : configurationError ? '连接异常' : configurationEmpty ? '尚未配置' : refreshing ? '同步中' : errors.length ? '数据延迟' : background ? '后台采集' : '只读监测';
  const loadMore = async () => { await Promise.all(selection.filter(e => e.data?.activityPagination.hasMore).map(e => model.loadMore(e.wallet.address))); };
  const copy = async (address: string) => {
    try { await navigator.clipboard.writeText(address); setToast('钱包地址已复制'); } catch { setToast('复制失败，请手动复制钱包地址'); }
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };

  return <div className="terminal">
    <header className="terminal-header">
      <a href="#" className="brand" aria-label="Polywatch 首页" onClick={e => { e.preventDefault(); setView('overview'); }}><strong>Polywatch<span>/</span></strong><span className="brand-subtitle">机构量化终端</span></a>
      <nav className="main-nav" aria-label="主导航">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}><Icon size={14}/>{label}</button>)}</nav>
      <div className="header-controls"><span className={`connection-state ${connectionWarning ? 'is-warning' : ''}`}><i/>{connectionLabel}</span><div className="segmented period-selector" aria-label="统计周期">{RANGES.map(({ id, label }) => <button key={id} className={range === id ? 'selected' : ''} aria-pressed={range === id} onClick={() => setRange(id)} disabled={!wallets.length}>{label}</button>)}</div><button className="icon-button header-refresh" onClick={() => void model.refresh()} disabled={refreshing || configurationLoading} title="刷新数据" aria-label="刷新数据"><RefreshCw size={15} className={refreshing || configurationLoading ? 'spin' : ''}/></button></div>
    </header>
    <main className="terminal-main">
      <div className="workspace-line"><div><span className="workspace-mark">WORKSPACE</span><ChevronRight size={11}/><span>{scopeName}</span><span className="workspace-source">POLYMARKET / POLYGON</span></div><span className="workspace-readonly"><ShieldCheck size={12}/>只读查看</span></div>
      {configurationPending && <div className="notice" role="status"><RefreshCw size={14} className="spin"/><span>正在读取部署者指定的监控钱包。</span></div>}
      {configurationError && <div className="notice warning" role="alert">监控名单暂时无法更新：{configurationError}</div>}
      {configurationEmpty && <div className="notice" role="status"><ShieldCheck size={14}/><span>部署者尚未配置监控钱包。配置完成后，刷新即可查看。</span></div>}
      {errors.length > 0 && <div className="notice warning" role="alert">{errors.map(e => `${e.wallet.label || short(e.wallet.address)}：${e.error}`).join('；')}</div>}
      <div className="summary-grid"><Stats summary={summary} periodLabel={RANGE_LABEL[range]} allPnl={allPnl}/><WalletWatchlist entries={entries} selected={activeSelection} onSelect={setSelected} onCopy={address => void copy(address)} range={range} emptyMessage={emptyWalletMessage}/></div>
      {wallets.length > 0 && <><div className="data-context"><div><ShieldCheck size={12}/><span>官方统计 {dateTime(observedAt)}</span><span className="context-separator"/><span>{covered ? '持仓记录已完整加载' : complete ? '历史记录部分加载' : '等待持仓记录'}</span></div><button className="text-button" onClick={() => setInfo(true)}>统计口径<CircleHelp size={12}/></button></div>
      {complete && !aligned && !refreshing && <div className="notice warning">各钱包官方快照的时间边界不同，暂不合计周期收益；请选择单个钱包查看。</div>}
      <details className="data-details"><summary><span>数据边界与来源说明</span><span>{warnings.length ? `${warnings.length} 项提示` : '实际统计区间'}</span><ChevronRight size={11}/></summary><div>{available.filter(e => e.data.range === range).map(({ wallet, data }) => <p key={wallet.address}>{available.length > 1 ? `${wallet.label} · ` : ''}统计区间 {dateTime(data.period?.start)} 至 {dateTime(data.period?.end)}（UTC+8）{data.period?.reason && <span> · {data.period.reason}</span>}</p>)}{warnings.map(w => <p key={w}>{w}</p>)}{!available.length && <p>等待钱包数据返回。</p>}</div></details>
      {view === 'overview' ? <>
        <div className="analysis-grid"><HistoryChart history={history} range={range} onRange={setRange} demo={isDemo} baseline={historyBaseline}/><SignalsPanel entries={selection} isDemo={isDemo}/></div>
        <div className="execution-grid"><WindowWorkspace entries={selection} isDemo={isDemo} onShowAll={() => setView('windows')}/><TradeTape pollingSeconds={background ? monitor.activityIntervalMs / 1000 : 15} trades={trades} isDemo={isDemo} refreshing={refreshing} onShowAll={() => setView('activity')}/></div>
      </> : <div className="detail-workspace"><div className="detail-title"><h1>{NAV.find(n => n.id === view)?.label}</h1><span>{scopeName}</span><button className="text-button" onClick={() => setView('overview')}>返回监控总览<ChevronRight size={12}/></button></div>
        {view === 'windows' ? <WindowTable key={selection.map(e => e.wallet.address).sort().join(',')} entries={selection}/> : view === 'events' ? <SignalsPanel entries={selection} isDemo={isDemo} expanded/> : <TradingTable pollSeconds={background ? (view === 'positions' ? monitor.snapshotIntervalMs : monitor.activityIntervalMs) / 1000 : 15} trades={trades} positions={positions} mode={view === 'positions' ? 'positions' : 'activity'} hasMore={selection.some(e => e.data?.activityPagination.hasMore)} onMore={() => void loadMore()} loadingMore={selection.some(e => e.loadingMore)} demo={isDemo} refreshing={refreshing}/>}
      </div>}</>}
      <footer className="terminal-footer"><div><span className={`footer-dot ${connectionWarning ? 'is-warning' : ''}`}/><span>{wallets.length ? `最近同步 ${dateTime(model.lastUpdated)}` : emptyWalletMessage}</span>{wallets.length > 0 && <><span className="footer-divider">/</span><span>{background ? `后台持续采集 · 成交${monitor.activityIntervalMs / 1000}s / 盈亏${monitor.snapshotIntervalMs / 1000}s · 保留30天` : '前台轮询 15s · 盈亏快照 60s'}</span></>}</div><div><span>只读公开数据</span><span className="footer-divider">/</span><span>USD</span><span className="footer-divider">/</span><span>UTC+8</span></div></footer>
    </main>
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
    {info && <Methodology onClose={() => setInfo(false)} background={background}/>}
  </div>;
}
