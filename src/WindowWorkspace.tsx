import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, LoaderCircle, ShieldCheck } from 'lucide-react';
import { dateTime, money, number, short } from './format';
import type { Amount, MarketWindow, Position, WalletEntry } from './types';
import './window-workspace.css';

type WindowGroup = MarketWindow & { walletCount: number; unknownWallets: number };
type PositionRow = { position: Position; address: string; name: string; fetchedAt: string | null; retained: boolean };
type VerificationItem = { address: string; name: string; window: MarketWindow | null; at: string | null; error: string | null; warnings: string[] };
type Verification = { scope: string; busy: boolean; items: VerificationItem[] };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const sum = (values: Amount[]): Amount => values.every(finite) ? values.reduce<number>((total, value) => total + (value as number), 0) : null;
const color = (value: Amount) => value === null || value === 0 ? '' : value > 0 ? 'ww-positive' : 'ww-negative';
const label = (entry: WalletEntry) => entry.wallet.label || entry.data?.profile.name || short(entry.wallet.address);
const time = (timestamp: number | null) => timestamp === null ? '时间未知' : new Date(timestamp * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const price = (value: Amount) => finite(value) ? `$${value.toFixed(3)}` : '—';

export function groupWorkspaceWindows(entries: WalletEntry[]): WindowGroup[] {
  const groups = new Map<string, Map<string, MarketWindow>>();
  for (const entry of entries) {
    for (const window of entry.data?.windows || []) {
      if (!window.isBtc5m || !window.conditionId) continue;
      if (!groups.has(window.conditionId)) groups.set(window.conditionId, new Map());
      groups.get(window.conditionId)!.set(entry.wallet.address, window);
    }
  }
  return [...groups.entries()].map(([conditionId, members]) => {
    const rows = [...members.values()];
    const missing = entries.filter(entry => !members.has(entry.wallet.address));
    // An empty served list is not evidence of zero economics for this market.
    const unknownWallets = missing.length;
    const amount = (key: 'totalPnl' | 'realizedPnl' | 'unrealizedPnl' | 'currentValue') => unknownWallets ? null : sum(rows.map(row => row[key]));
    return { ...rows[0], id: conditionId, conditionId,
      walletCount: members.size, unknownWallets,
      totalPnl: amount('totalPnl'), realizedPnl: amount('realizedPnl'), unrealizedPnl: amount('unrealizedPnl'), currentValue: amount('currentValue'),
      positionCount: rows.reduce((total, row) => total + row.positionCount, 0),
      outcomes: [...new Set(rows.flatMap(row => row.outcomes))],
      status: rows.some(row => row.status === 'OPEN') ? 'OPEN' as const : rows.some(row => row.status === 'REDEEMABLE') ? 'REDEEMABLE' as const : 'CLOSED' as const,
      complete: unknownWallets === 0 && rows.every(row => row.complete) && entries.every(entry => !entry.stale && !entry.error),
    };
  }).sort((a, b) => (b.windowStart ?? b.timestamp ?? 0) - (a.windowStart ?? a.timestamp ?? 0));
}

export function workspacePositionRows(entries: WalletEntry[], conditionId: string): PositionRow[] {
  const rows = new Map<string, PositionRow>();
  for (const entry of entries) {
    for (const section of ['closedPositions', 'positions'] as const) {
      for (const position of entry.data?.[section] || []) {
        if (position.conditionId !== conditionId) continue;
        const key = `${entry.wallet.address}:${position.id || `${position.conditionId}:${position.outcome}`}`;
        const previous = rows.get(key);
        if (!previous || (position.timestamp ?? 0) >= (previous.position.timestamp ?? 0)) {
          rows.set(key, { position, address: entry.wallet.address, name: label(entry), fetchedAt: entry.data?.coverage[section].fetchedAt || null,
            retained: entry.data?.sections[section] === 'error' });
        }
      }
    }
  }
  return [...rows.values()];
}

export function workspacePositionTotals(rows: PositionRow[]) {
  const realizedPnl = rows.length ? sum(rows.map(row => row.position.realizedPnl)) : null;
  const unrealizedPnl = rows.length ? sum(rows.map(row => row.position.unrealizedPnl)) : null;
  return { realizedPnl, unrealizedPnl, totalPnl: sum([realizedPnl, unrealizedPnl]) };
}

export function windowClock(window: MarketWindow, now: number): string {
  if (!finite(window.windowStart) || !finite(window.endTime)) return '窗口时间未提供';
  const remaining = Math.max(0, Math.ceil((now < window.windowStart ? window.windowStart : window.endTime) - now));
  if (now >= window.endTime) return window.status === 'CLOSED' ? '窗口已结束 · 仓位已平' : '窗口已结束 · 等待数据更新';
  const minutes = Math.floor(remaining / 60).toString().padStart(2, '0');
  const seconds = (remaining % 60).toString().padStart(2, '0');
  return `本机倒计时 ${minutes}:${seconds}${now < window.windowStart ? ' · 距开窗' : ''}`;
}

export function WindowWorkspace({ entries, isDemo, onShowAll }: { entries: WalletEntry[]; isDemo: boolean; onShowAll: () => void }) {
  const groups = useMemo(() => groupWorkspaceWindows(entries), [entries]);
  const walletKey = `${isDemo ? 'demo' : 'live'}:${entries.map(entry => entry.wallet.address).sort().join(',')}`;
  const [selection, setSelection] = useState<{ wallets: string; condition: string }>({ wallets: '', condition: '' });
  const selected = groups.find(group => selection.wallets === walletKey && group.conditionId === selection.condition) || groups[0];
  const selectedId = selected?.conditionId || '';
  const scope = `${walletKey}:${selectedId}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (selectedId && (selection.wallets !== walletKey || selection.condition !== selectedId)) setSelection({ wallets: walletKey, condition: selectedId });
  }, [selectedId, walletKey, selection.wallets, selection.condition]);
  useEffect(() => {
    requestId.current += 1;
    controller.current?.abort();
    setVerification(null);
    return () => { requestId.current += 1; controller.current?.abort(); };
  }, [scope]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000); return () => window.clearInterval(timer); }, []);

  const index = selected ? groups.findIndex(group => group.conditionId === selectedId) : 0;
  const page = Math.floor(Math.max(0, index) / 4) * 4;
  const visible = groups.slice(page, page + 4).reverse();
  const positions = useMemo(() => workspacePositionRows(entries, selectedId), [entries, selectedId]);
  const detailTotals = useMemo(() => workspacePositionTotals(positions), [positions]);
  const absentDetails = entries.filter(entry => !positions.some(row => row.address === entry.wallet.address));
  const retainedDetails = positions.some(row => row.retained);
  const refreshProblem = entries.some(entry => entry.stale || Boolean(entry.error));
  const detailsComplete = Boolean(selected?.complete) && positions.length > 0 && absentDetails.length === 0 && !retainedDetails
    && entries.every(entry => entry.data?.coverage.positions.complete && entry.data?.coverage.closedPositions.complete
      && entry.data.sections.positions === 'ok' && entry.data.sections.closedPositions === 'ok')
    && finite(detailTotals.totalPnl);
  const differsFromWindow = Boolean(selected) && (selected.positionCount !== positions.length
    || (['realizedPnl', 'unrealizedPnl', 'totalPnl'] as const).some(key => selected[key] === null || detailTotals[key] === null
      ? selected[key] !== detailTotals[key] : Math.abs(selected[key]! - detailTotals[key]!) > 0.005));
  const verified = verification?.scope === scope ? verification : null;
  const completeVerification = verified && !verified.busy && verified.items.length === entries.length && verified.items.every(item => item.window?.complete && !item.error);
  const verifiedTotal = verified && !verified.busy && verified.items.length === entries.length && verified.items.every(item => item.window && !item.error)
    ? sum(verified.items.map(item => item.window!.totalPnl)) : null;
  const snapshotTimes = positions.map(row => row.fetchedAt).filter((value): value is string => Boolean(value)).sort();
  const choose = (condition: string) => setSelection({ wallets: walletKey, condition });

  async function verify() {
    if (!selected || isDemo || entries.length === 0 || entries.length > 10 || !/^0x[0-9a-fA-F]{64}$/.test(selectedId)) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const currentRequest = ++requestId.current;
    const capturedScope = scope;
    setVerification({ scope, busy: true, items: [] });
    const items = await Promise.all(entries.map(async (entry): Promise<VerificationItem> => {
      const item: VerificationItem = { address: entry.wallet.address, name: label(entry), window: null, at: null, error: null, warnings: [] };
      try {
        const response = await fetch(`/api/wallet/${encodeURIComponent(entry.wallet.address)}/window/${encodeURIComponent(selectedId)}`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]), headers: { Accept: 'application/json' },
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `核验接口返回 HTTP ${response.status}`);
        if (!payload.window) throw new Error(Array.isArray(payload.warnings) && payload.warnings.length ? payload.warnings.join('；') : '官方接口未找到此钱包的窗口持仓，不能按零计算');
        if (payload.window.conditionId !== selectedId || typeof payload.window.complete !== 'boolean') throw new Error('核验结果市场标识或格式不匹配');
        const window = payload.window as MarketWindow;
        item.window = { ...window,
          totalPnl: finite(window.totalPnl) ? window.totalPnl : null,
          realizedPnl: finite(window.realizedPnl) ? window.realizedPnl : null,
          unrealizedPnl: finite(window.unrealizedPnl) ? window.unrealizedPnl : null,
          complete: window.complete && Boolean(payload.coverage?.positions?.complete) && Boolean(payload.coverage?.closedPositions?.complete)
            && finite(window.totalPnl) && finite(window.realizedPnl) && finite(window.unrealizedPnl),
        };
        item.at = typeof payload.fetchedAt === 'string' && Number.isFinite(Date.parse(payload.fetchedAt)) ? payload.fetchedAt : null;
        item.warnings = Array.isArray(payload.warnings) ? payload.warnings.filter((warning: unknown): warning is string => typeof warning === 'string') : [];
        if (!finite(window.totalPnl) || !finite(window.realizedPnl) || !finite(window.unrealizedPnl)) item.warnings.push('官方尚未发布完整的窗口盈亏数值');
      } catch (error) {
        item.error = error instanceof DOMException && error.name === 'TimeoutError' ? '核验超时（45秒），请重试'
          : error instanceof TypeError ? '无法连接核验接口，请检查网络'
            : error instanceof Error ? error.message : '核验失败，请重试';
      }
      return item;
    }));
    if (abort.signal.aborted || requestId.current !== currentRequest || activeScope.current !== capturedScope) return;
    setVerification({ scope: capturedScope, busy: false, items });
    if (controller.current === abort) controller.current = null;
  }

  return <section className="ww-root" aria-label="BTC 5分钟窗口工作区">
    <div className="ww-strip">
      <div className="ww-strip-title"><h2>BTC 5m 窗口盈亏</h2><span>窗口接口快照 · UTC+8{isDemo ? ' · 演示' : ''}</span><button type="button" className="ww-link" onClick={onShowAll}>全部窗口 <ChevronRight size={12} /></button></div>
      <div className="ww-window-picker" aria-label="选择BTC五分钟窗口">
        {visible.map(group => <button type="button" key={group.conditionId} aria-pressed={group.conditionId === selectedId} onClick={() => choose(group.conditionId)} className={`ww-window ${group.conditionId === selectedId ? 'ww-selected' : ''}`} title={`${dateTime(group.windowStart)} — ${time(group.endTime)} · ${money(group.totalPnl, true)}`}>
          {group.conditionId === selectedId && <Check size={13} className="ww-selected-mark" />}
          <span>{time(group.windowStart)} – {time(group.endTime)}</span><strong className={color(group.totalPnl)}>{money(group.totalPnl, true)}</strong>
          {!group.complete && <small>部分数据</small>}
        </button>)}
        {!groups.length && <div className="ww-empty-inline">{entries.some(entry => entry.loading) ? '正在读取钱包窗口…' : '暂无已加载的 BTC 5m 窗口'}</div>}
      </div>
      <div className="ww-window-nav"><button type="button" aria-label="查看更早四个窗口" title="更早窗口" disabled={page + 4 >= groups.length} onClick={() => choose(groups[page + 4].conditionId)}><ChevronLeft size={16}/></button><button type="button" aria-label="查看更新四个窗口" title="更新窗口" disabled={page === 0} onClick={() => choose(groups[Math.max(0, page - 4)].conditionId)}><ChevronRight size={16}/></button><span>{groups.length ? `${Math.min(page + 4, groups.length)} / ${groups.length}` : '0 窗口'}</span></div>
    </div>
    <div className="ww-detail">
      <header className="ww-detail-header"><div><h2>BTC 5m 仓位明细{selected && <span>（{time(selected.windowStart)} – {time(selected.endTime)}）</span>}</h2><p>当前与已平仓仓位快照 · 窗口全生命周期盈亏</p></div>{selected && <span className={`ww-clock ${selected.endTime !== null && now < selected.endTime ? 'ww-running' : ''}`}>{windowClock(selected, now)}</span>}</header>
      {selected ? <>
        <div className="ww-grid-scroll"><table className="ww-table"><thead><tr><th>钱包</th><th>方向</th><th>状态</th><th>当前数量</th><th>均价</th><th>现价</th><th>已实现盈亏</th><th>未实现盈亏</th></tr></thead><tbody>
          {positions.map(({ position, address, name, retained, fetchedAt }) => <tr key={`${address}:${position.id || position.outcome}`}><td title={`${address} · 仓位快照 ${dateTime(fetchedAt)}`}>{name}{retained && <small className="ww-retained">保留旧快照</small>}</td><td className={/^(up|yes)$/i.test(position.outcome) ? 'ww-positive' : /^(down|no)$/i.test(position.outcome) ? 'ww-negative' : ''}>{position.outcome || '—'}</td><td className="ww-row-state">{position.status === 'CLOSED' ? '已平仓' : position.redeemable ? '待赎回' : '持仓中'}</td><td>{number(position.size)}</td><td>{price(position.avgPrice)}</td><td>{price(position.currentPrice)}</td><td className={color(position.realizedPnl)}>{money(position.realizedPnl, true)}</td><td className={color(position.unrealizedPnl)}>{money(position.unrealizedPnl, true)}</td></tr>)}
        </tbody></table>{!positions.length && <div className="ww-empty">该窗口尚无已加载仓位明细。可独立核验窗口合计，或查看全部窗口。</div>}</div>
        <div className="ww-window-total"><strong>本表明细小计</strong><span>净盈亏 <b className={color(detailTotals.totalPnl)}>{money(detailTotals.totalPnl, true)}</b>{!detailsComplete && <em>部分</em>}</span><span>已实现 <b className={color(detailTotals.realizedPnl)}>{money(detailTotals.realizedPnl, true)}</b></span><span>未实现 <b className={color(detailTotals.unrealizedPnl)}>{money(detailTotals.unrealizedPnl, true)}</b></span></div>
        <div className="ww-snapshot-meta"><span>仓位快照：{snapshotTimes.length ? dateTime(snapshotTimes[0]) : '尚未取得'} · {positions.length} 条</span>{!isDemo && <button type="button" className="ww-verify" disabled={Boolean(verified?.busy) || entries.length > 10 || !/^0x[0-9a-fA-F]{64}$/.test(selectedId)} onClick={() => void verify()}>{verified?.busy ? <LoaderCircle size={13} className="ww-spin"/> : <ShieldCheck size={13}/>} {verified?.busy ? '核验窗口合计…' : '独立核验合计'}</button>}</div>
        {(!detailsComplete || differsFromWindow) && <p className="ww-coverage">本表小计仅由上方去重仓位计算。{retainedDetails ? '包含刷新失败后保留的旧快照，尚非最新窗口盈亏。' : refreshProblem ? '钱包刷新异常，数据可能延迟。' : !detailsComplete ? '明细覆盖可能不完整。' : ''}{absentDetails.length > 0 ? `${absentDetails.length} 个钱包暂无此窗口明细，未计入小计，不代表零盈亏。` : ''}{selected.unknownWallets > 0 ? `窗口接口中 ${selected.unknownWallets} 个钱包的该窗口数据未知，全钱包合计不按零补齐。` : ''}{differsFromWindow ? '窗口条与本表的快照或采集范围不同，数值不能互相替代。' : ''} 独立核验只更新合计，不更新此表明细。</p>}
        {verified && !verified.busy && <div className="ww-verification" role="status"><div><strong>{completeVerification ? '独立核验完成' : '独立核验部分完成'}</strong><b className={color(verifiedTotal)}>{money(verifiedTotal, true)}</b><span>仅窗口合计 · 上表仍为仓位快照</span></div>{verified.items.map(item => <p key={item.address}><span>{item.name}：</span>{item.error ? <span className="ww-negative">{item.error}</span> : <><span>{item.window?.complete ? '完整' : '部分'} · {money(item.window?.totalPnl, true)} · {dateTime(item.at)}</span>{item.warnings.length > 0 && <span className="ww-warning"> · {item.warnings.join('；')}</span>}</>}</p>)}</div>}
      </> : <div className="ww-empty ww-empty-panel"><strong>暂无窗口数据</strong><span>这里显示所选监控钱包已加载的 BTC 5m 仓位。可通过“全部窗口”查看其他市场。</span></div>}
    </div>
  </section>;
}
