import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Activity, ActivityMonitor, ActivityResponse, HistoryPoint, MarketWindow, MonitorStatus, MonitorWallet, Period, Position, Range, WalletConfig, WalletData, WalletEntry, WalletState } from './types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COLORS = ['#d7efea', '#e5e2f7', '#f4ead7', '#dceaf5', '#f5e1e9'];
const EMPTY_STATE: WalletState = { loading: false, stale: false, error: null, loadingMore: false };
const DEFAULT_MONITOR: MonitorStatus = { loading: true, available: false, enabled: false, retentionDays: 30, activityIntervalMs: 5000, snapshotIntervalMs: 60000, addresses: [], wallets: [], error: null };

export function normalizeMonitor(payload: unknown): MonitorStatus {
  if (!payload || typeof payload !== 'object' || !('enabled' in payload) || typeof payload.enabled !== 'boolean') throw new Error('后台监控状态格式无效');
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.addresses) || raw.addresses.some(value => typeof value !== 'string' || !ADDRESS.test(value))) throw new Error('部署者钱包配置格式无效');
  const intervals = raw.intervals && typeof raw.intervals === 'object' ? raw.intervals as Record<string, unknown> : {};
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value: unknown) => typeof value === 'string' ? value : null;
  const addresses = [...new Set((Array.isArray(raw.addresses) ? raw.addresses : []).filter((value): value is string => typeof value === 'string' && ADDRESS.test(value)).map(address => address.toLowerCase()))];
  const wallets: MonitorWallet[] = (Array.isArray(raw.wallets) ? raw.wallets : []).flatMap(row => {
    if (!row || typeof row !== 'object' || typeof row.address !== 'string' || !ADDRESS.test(row.address)) return [];
    const backfill = row.backfill && typeof row.backfill === 'object' ? row.backfill : null;
    return [{ address: row.address.toLowerCase(), lastSuccess: finite(row.lastSuccess), snapshotAt: finite(row.snapshotAt), activityAt: finite(row.activityAt), snapshotError: text(row.snapshotError), activityError: text(row.activityError),
      backfill: backfill ? { complete: backfill.complete === true, cursor: text(backfill.cursor), oldestSeen: finite(backfill.oldestSeen), pages: finite(backfill.pages) || 0, gap: text(backfill.gap) } : null }];
  });
  return { ...DEFAULT_MONITOR, loading: false, available: true, enabled: payload.enabled,
    retentionDays: finite(raw.retentionDays) || 30,
    activityIntervalMs: Math.max(1000, Math.min(60000, finite(raw.activityIntervalMs) || finite(intervals.activityMs) || 5000)),
    snapshotIntervalMs: Math.max(5000, finite(raw.snapshotIntervalMs) || finite(intervals.snapshotMs) || 60000), addresses, wallets };
}

export function walletPollInterval(address: string, monitor: MonitorStatus, kind: 'activity' | 'snapshot' = 'activity'): number {
  return monitor.available && monitor.enabled && monitor.addresses.includes(address.toLowerCase()) ? kind === 'snapshot' ? monitor.snapshotIntervalMs : monitor.activityIntervalMs : 15000;
}

export function dueWallets(wallets: WalletConfig[], monitor: MonitorStatus, lastRequested: ReadonlyMap<string, number>, busy: ReadonlySet<string>, now: number, force = false, kind: 'activity' | 'snapshot' = 'snapshot'): WalletConfig[] {
  return wallets.filter(wallet => !busy.has(wallet.address) && (force || !lastRequested.has(wallet.address) || now - lastRequested.get(wallet.address)! >= walletPollInterval(wallet.address, monitor, kind)));
}

function waitingPeriod(range: Range): Period {
  return { range, start: null, end: null, totalPnl: null, realizedPnl: null, unrealizedPnl: null, complete: false, reason: '正在获取该周期的官方数据。', sourceFidelity: null, observedAt: null, stale: false };
}

function boundedHistory(points: HistoryPoint[], period: Period): HistoryPoint[] {
  if (period.start == null || period.end == null) return [];
  return points.filter(point => Number.isFinite(point.timestamp) && point.timestamp >= period.start! && point.timestamp <= period.end!).sort((a, b) => a.timestamp - b.timestamp);
}

/** Project only the selected period. summary is always the cumulative account total. */
export function projectWalletRange(source: WalletData, range: Range, cached?: WalletData): WalletData {
  if (source.range === range) return source;
  const matchingCache = cached?.address === source.address && cached.range === range ? cached : undefined;
  const period = (range !== 'all' ? source.periods?.[range] : undefined) || matchingCache?.period || waitingPeriod(range);
  const history = range !== 'all' && source.historyAll !== undefined
    ? boundedHistory(source.historyAll, period)
    : matchingCache ? boundedHistory(matchingCache.history, period) : [];
  return { ...source, range, period, history };
}

export function needsRangeFetch(source: WalletData | undefined, range: Range, cached?: WalletData): boolean {
  if (!source) return true;
  if (source.range === range) return false;
  if (cached?.address === source.address && cached.range === range) return false;
  return range === 'all' || !source.periods?.[range] || source.historyAll === undefined;
}

export function walletsFromMonitor(monitor: MonitorStatus): WalletConfig[] {
  // enabled controls the collector, not the deployer's read-only watch list.
  return monitor.addresses.map((address, index) => ({ address, label: `监控钱包 ${index + 1}`, color: COLORS[index % COLORS.length] }));
}

export function configurationFailure(previous: MonitorStatus): MonitorStatus {
  return { ...previous, loading: false, available: false, error: previous.addresses.length
    ? '无法读取部署者钱包配置，暂保留上次配置；会自动重试。'
    : '无法读取部署者钱包配置，请检查服务连接；会自动重试。' };
}

export function retainConfigured<T>(record: Record<string, T>, addresses: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([address]) => addresses.has(address)));
}

export function retireWalletAddresses(addresses: string[], requests: Map<string, AbortController>[], caches: { delete(key: string): boolean }[]) {
  for (const address of addresses) {
    for (const pending of requests) { pending.get(address)?.abort(); pending.delete(address); }
    for (const cache of caches) cache.delete(address);
  }
}

export function mergeActivityRows(previous: Activity[], latest: Activity[]) {
  const latestCounts = new Map<string, number>();
  for (const row of latest) latestCounts.set(row.contentKey, (latestCounts.get(row.contentKey) || 0) + 1);
  const seenPrevious = new Map<string, number>();
  const rows = [...latest];
  let hasOverlap = false;
  for (const row of previous) {
    const occurrence = (seenPrevious.get(row.contentKey) || 0) + 1;
    seenPrevious.set(row.contentKey, occurrence);
    const latestCount = latestCounts.get(row.contentKey) || 0;
    if (latestCount > 0) hasOverlap = true;
    // Content can be identical for multiple fills. Preserve the larger count,
    // rather than collapsing those fills with Set/Map de-duplication.
    if (occurrence > latestCount) rows.push(row);
  }
  return { rows: rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)), hasOverlap };
}

export function appendActivityPage(previous: Activity[], page: Activity[]): Activity[] {
  // Cursor pages are disjoint. The backend namespaces row IDs by cursor, so an
  // identical fill crossing a page boundary must still be retained as a row.
  return [...previous, ...page].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

async function requestJson(url: string, signal: AbortSignal, timeoutMs = 50000) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, timeout.signal]), headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : typeof payload?.error === 'string' ? payload.error : `数据获取失败（HTTP ${response.status}），请稍后重试。`);
    return payload;
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeout.signal.aborted) throw new Error('数据请求超时，请检查网络后重试。');
    if (error instanceof TypeError) throw new Error('无法连接数据服务，请检查服务是否已启动。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeData(payload: WalletData, address: string): WalletData {
  if (payload?.source !== 'live' || payload.address !== address || !payload.summary || !Array.isArray(payload.activity) || !Array.isArray(payload.history) || !payload.sections) {
    throw new Error('数据服务返回格式无效，请刷新后重试。');
  }
  const validPoint = (point: HistoryPoint) => typeof point.timestamp === 'number' && Number.isFinite(point.timestamp);
  return { ...payload, history: payload.history.filter(validPoint), ...(Array.isArray(payload.historyAll) ? { historyAll: payload.historyAll.filter(validPoint) } : {}) };
}

type SnapshotSection = keyof WalletData['sections'];

function sectionOrigin(data: WalletData, section: SnapshotSection): string | null {
  const valid = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? value : null;
  // The database transaction feed has its own clock, independent of its snapshot.
  if (section === 'activity') return valid(data.activityFetchedAt);
  if (data.sectionFetchedAt && Object.prototype.hasOwnProperty.call(data.sectionFetchedAt, section)) return valid(data.sectionFetchedAt[section]);
  if (section === 'positions' || section === 'closedPositions') return valid(data.coverage[section]?.fetchedAt);
  // A failed legacy response's fetch time does not date its retained data.
  return data.sections[section] === 'ok' ? valid(data.fetchedAt) : null;
}

function hasSectionData(data: WalletData, section: SnapshotSection): boolean {
  if (section === 'stats') return [data.summary.totalPnl, data.summary.realizedPnl, data.summary.unrealizedPnl].some(value => typeof value === 'number' && Number.isFinite(value));
  if (section === 'value') return typeof data.summary.positionValue === 'number' && Number.isFinite(data.summary.positionValue);
  if (section === 'history') return Array.isArray(data.history) && Boolean(data.period);
  return Array.isArray(data[section]);
}

function preferPreviousSection(next: WalletData, previous: WalletData, section: SnapshotSection): boolean {
  const nextAt = Date.parse(sectionOrigin(next, section) || '');
  const previousAt = Date.parse(sectionOrigin(previous, section) || '');
  if (hasSectionData(previous, section) && Number.isFinite(previousAt) && Number.isFinite(nextAt) && previousAt > nextAt) return true;
  if (next.sections[section] !== 'error') return false;
  const retainedSource = next.persisted || next.storage?.persisted || Object.prototype.hasOwnProperty.call(next.sectionFetchedAt || {}, section);
  if (retainedSource && hasSectionData(next, section) && Number.isFinite(nextAt) && (!Number.isFinite(previousAt) || nextAt >= previousAt)) return false;
  return hasSectionData(previous, section);
}

// When a book comes from a browser snapshot, its derived windows must use the
// selected books too; retaining next.windows would pair different source data.
function windowsFromBooks(positions: Position[], closedPositions: Position[]): MarketWindow[] {
  const tokens = new Map<string, Position>();
  for (const row of [...closedPositions, ...positions]) {
    const key = row.id || `${row.conditionId}:${row.outcome}`;
    if (!tokens.has(key) || (row.timestamp ?? 0) >= (tokens.get(key)!.timestamp ?? 0)) tokens.set(key, row);
  }
  const groups = new Map<string, Position[]>();
  for (const row of tokens.values()) { const key = row.conditionId || row.id; groups.set(key, [...(groups.get(key) || []), row]); }
  return [...groups.entries()].map(([id, rows]): MarketWindow => {
    const first = rows[0];
    const sum = (key: 'totalPnl' | 'realizedPnl' | 'unrealizedPnl' | 'currentValue') => rows.every(row => typeof row[key] === 'number' && Number.isFinite(row[key])) ? rows.reduce((value, row) => value + row[key]!, 0) : null;
    const match = /^btc-updown-5m-(\d{10})$/.exec(first.slug) || /^btc-updown-5m-(\d{10})$/.exec(first.eventSlug);
    const start = match ? Number(match[1]) : null;
    const times = rows.map(row => row.timestamp).filter((value): value is number => value != null);
    return { id, conditionId: first.conditionId, title: first.title, slug: first.slug, eventSlug: first.eventSlug, icon: first.icon,
      outcomes: [...new Set(rows.map(row => row.outcome))], positionCount: rows.length,
      totalPnl: sum('totalPnl'), realizedPnl: sum('realizedPnl'), unrealizedPnl: sum('unrealizedPnl'), currentValue: sum('currentValue'),
      status: rows.some(row => row.status === 'OPEN') ? 'OPEN' : rows.some(row => row.status === 'REDEEMABLE') ? 'REDEEMABLE' : 'CLOSED',
      timestamp: times.length ? Math.max(...times) : null, windowStart: start, endTime: start == null ? null : start + 300, isBtc5m: Boolean(match), complete: false };
  }).sort((a, b) => (b.windowStart ?? b.timestamp ?? 0) - (a.windowStart ?? a.timestamp ?? 0));
}

export function mergeWalletRefresh(next: WalletData, previous: WalletData | undefined): WalletData {
  if (!previous) return next;
  const merged = { ...next, summary: { ...next.summary }, sectionFetchedAt: { ...next.sectionFetchedAt } };
  const usePrevious = Object.fromEntries((Object.keys(next.sections) as SnapshotSection[]).map(section => [section, preferPreviousSection(next, previous, section)])) as Record<SnapshotSection, boolean>;
  for (const section of Object.keys(usePrevious) as SnapshotSection[]) merged.sectionFetchedAt[section] = sectionOrigin(usePrevious[section] ? previous : next, section);
  if (usePrevious.stats) merged.summary = { ...previous.summary, positionValue: next.summary.positionValue };
  if (usePrevious.value) merged.summary.positionValue = previous.summary.positionValue;
  if (usePrevious.history) {
    const projected = projectWalletRange(previous, next.range);
    merged.history = projected.history;
    merged.historyAll = previous.historyAll;
    merged.period = projected.period;
    merged.periods = previous.periods;
    merged.historySourceFidelity = previous.historySourceFidelity;
  }
  let replacedBook = false;
  for (const section of ['positions', 'closedPositions'] as const) {
    if (usePrevious[section]) {
      replacedBook = true;
      merged[section] = previous[section];
      merged.coverage = { ...merged.coverage, [section]: { ...previous.coverage[section], complete: next.sections[section] === 'error' ? false : previous.coverage[section].complete } };
    }
  }
  if (replacedBook) merged.windows = windowsFromBooks(merged.positions, merged.closedPositions);
  if (usePrevious.activity) {
    merged.activity = previous.activity;
    merged.activityPagination = previous.activityPagination;
    merged.activityFetchedAt = previous.activityFetchedAt;
  } else if (previous.activity.length) {
    const refresh = mergeActivityRows(previous.activity, next.activity);
    if (!refresh.hasOverlap) {
      // More than one head page may have arrived between polls. Continuing with
      // the old tail cursor would silently skip all intervening rows.
      merged.warnings = [...merged.warnings, '最新交易与已加载历史未衔接，交易列表已重置；请重新加载更早交易。'];
    } else if (next.activityPagination.hasMore) {
      merged.activity = refresh.rows;
      merged.activityPagination = previous.activityPagination;
    }
  }
  return merged;
}

export function activityHealth(monitor?: ActivityMonitor) {
  const error = typeof monitor?.error === 'string' && monitor.error.trim() ? `后台交易采集异常：${monitor.error.trim()}`
    : monitor?.stale ? '后台交易采集已延迟，当前显示已保存记录。' : null;
  const warnings = [
    ...(error ? [`交易监控：${error}`] : []),
    ...(typeof monitor?.gap === 'string' && monitor.gap.trim() ? [`交易历史：${monitor.gap.trim()}`] : []),
  ];
  return { error, stale: Boolean(error), warnings };
}

export function mergeActivityResponse(previous: WalletData, payload: ActivityResponse, append = false): WalletData {
  const health = activityHealth(payload.monitor);
  const warnings = previous.warnings.filter(warning => !warning.startsWith('交易监控：') && !warning.startsWith('交易历史：') && (append || !warning.includes('交易列表已重置')));
  // A readable database page is useful even when its upstream collector failed.
  // Merge those records first; the collector's health is applied separately.
  const head: WalletData = { ...previous, activity: payload.activity, activityPagination: payload.pagination, activityFetchedAt: payload.fetchedAt,
    warnings, sections: { ...previous.sections, activity: 'ok' } };
  const merged = append ? { ...previous, warnings, activity: appendActivityPage(previous.activity, payload.activity), activityPagination: payload.pagination }
    : mergeWalletRefresh(head, previous);
  return { ...merged, activityMonitor: payload.monitor, warnings: [...new Set([...merged.warnings, ...health.warnings])], sections: { ...merged.sections, activity: health.error ? 'error' : 'ok' } };
}

export function activityResponseState(previous: WalletState, previousActivityError: string | undefined, health: ReturnType<typeof activityHealth>, snapshotFailed: boolean): WalletState {
  const unrelatedError = previous.error && previous.error !== previousActivityError ? previous.error : null;
  const error = unrelatedError || health.error || (snapshotFailed ? '部分盈亏或持仓数据尚未恢复。' : null);
  return { ...previous, loading: false, loadingMore: false, error, stale: health.stale || snapshotFailed || Boolean(unrelatedError) };
}

function snapshotFailed(data: WalletData | undefined): boolean {
  return Boolean(data && Object.entries(data.sections).some(([section, status]) => section !== 'activity' && status === 'error'));
}

export function useWallets() {
  const [configuredWallets, setConfiguredWallets] = useState<WalletConfig[]>([]);
  const [range, setRangeState] = useState<Range>('1d');
  const [monitor, setMonitor] = useState<MonitorStatus>(DEFAULT_MONITOR);
  const [liveData, setLiveData] = useState<Record<string, WalletData>>({});
  const [states, setStates] = useState<Record<string, WalletState>>({});
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const configsRef = useRef(configuredWallets);
  const configurationRefresh = useRef<() => Promise<void>>(async () => {});
  const rangeRef = useRef(range);
  const dataRef = useRef(liveData);
  const activeRequests = useRef(new Map<string, AbortController>());
  const headRequests = useRef(new Map<string, AbortController>());
  const lastRequested = useRef(new Map<string, number>());
  const lastHeadRequested = useRef(new Map<string, number>());
  const headErrors = useRef(new Map<string, string>());
  const rangeCache = useRef(new Map<string, Partial<Record<Range, WalletData>>>());
  const monitorRef = useRef(monitor);
  const moreRequests = useRef(new Map<string, AbortController>());
  const loadedCursors = useRef(new Map<string, Set<string>>());
  const generation = useRef(0);
  const alive = useRef(true);
  configsRef.current = configuredWallets;
  rangeRef.current = range;
  dataRef.current = liveData;
  monitorRef.current = monitor;

  const abortRequests = useCallback(() => {
    ++generation.current;
    for (const request of activeRequests.current.values()) request.abort();
    activeRequests.current.clear();
    for (const request of headRequests.current.values()) request.abort();
    headRequests.current.clear();
    for (const request of moreRequests.current.values()) request.abort();
    moreRequests.current.clear();
  }, []);

  const setRange = useCallback((next: Range) => {
    if (next === rangeRef.current) return;
    // Invalidate immediately on the click, before effect cleanup can run. A slow
    // response for the previous range must never replace the selected period.
    rangeRef.current = next;
    abortRequests();
    setStates(current => Object.fromEntries(Object.entries(current).map(([key, state]) => [key, { ...state, loading: false, loadingMore: false }])));
    setRangeState(next);
  }, [abortRequests]);

  const applyConfiguration = useCallback((next: MonitorStatus) => {
    const wallets = walletsFromMonitor(next);
    const allowed = new Set(wallets.map(wallet => wallet.address));
    const revoked = configsRef.current.filter(wallet => !allowed.has(wallet.address)).map(wallet => wallet.address);
    configsRef.current = wallets;
    retireWalletAddresses(revoked, [activeRequests.current, headRequests.current, moreRequests.current],
      [loadedCursors.current, lastRequested.current, lastHeadRequested.current, headErrors.current, rangeCache.current]);
    if (revoked.length) {
      dataRef.current = retainConfigured(dataRef.current, allowed);
      setLiveData(current => retainConfigured(current, allowed));
      setStates(current => retainConfigured(current, allowed));
    }
    if (!wallets.length) setLastUpdated(null);
    setConfiguredWallets(current => current.length === wallets.length && current.every((wallet, index) => wallet.address === wallets[index].address) ? current : wallets);
  }, []);

  const runRequests = useCallback(async (force = false, ensureRange = false) => {
    if (!alive.current || document.hidden) return;
    const busy = new Set([...activeRequests.current.keys(), ...headRequests.current.keys(), ...moreRequests.current.keys()]);
    const requestedRange = rangeRef.current;
    const due = new Set(dueWallets(configsRef.current, monitorRef.current, lastRequested.current, busy, Date.now(), force).map(wallet => wallet.address));
    const wallets = configsRef.current.filter(wallet => !busy.has(wallet.address) && (due.has(wallet.address) || !dataRef.current[wallet.address] && Date.now() - (lastRequested.current.get(wallet.address) || 0) >= walletPollInterval(wallet.address, monitorRef.current) || ensureRange && needsRangeFetch(dataRef.current[wallet.address], requestedRange, rangeCache.current.get(wallet.address)?.[requestedRange])));
    const revision = generation.current;
    if (!wallets.length) return;
    setStates(current => ({ ...current, ...Object.fromEntries(wallets.map(wallet => [wallet.address, {
      ...(current[wallet.address] || EMPTY_STATE), loading: true,
    }])) }));
    await Promise.allSettled(wallets.map(async wallet => {
      const controller = new AbortController();
      activeRequests.current.set(wallet.address, controller);
      lastRequested.current.set(wallet.address, Date.now());
      try {
        const payload = normalizeData(await requestJson(`/api/wallet/${wallet.address}?range=${requestedRange}`, controller.signal), wallet.address);
        if (!alive.current || revision !== generation.current || controller.signal.aborted || rangeRef.current !== requestedRange || !configsRef.current.some(config => config.address === wallet.address)) return;
        rangeCache.current.set(wallet.address, { ...rangeCache.current.get(wallet.address), [requestedRange]: payload });
        lastHeadRequested.current.set(wallet.address, Date.now());
        if (payload.sections.activity !== 'error') headErrors.current.delete(wallet.address);
        setLiveData(current => {
          const previous = current[wallet.address];
          const refreshed = mergeWalletRefresh(payload, previous);
          if (refreshed.activity === payload.activity && (!previous || !payload.activityPagination.hasMore || !mergeActivityRows(previous.activity, payload.activity).hasOverlap)) {
            loadedCursors.current.delete(wallet.address);
          }
          const next = { ...current, [wallet.address]: refreshed };
          dataRef.current = next; return next;
        });
        const failed = Object.values(payload.sections).some(status => status === 'error');
        setStates(current => ({ ...current, [wallet.address]: {
          ...EMPTY_STATE, stale: failed, error: failed ? '部分数据更新失败，已保留上次成功的数据。' : null,
        } }));
        setLastUpdated(payload.fetchedAt);
      } catch (error) {
        if (!alive.current || revision !== generation.current || controller.signal.aborted) return;
        setStates(current => ({ ...current, [wallet.address]: {
          ...EMPTY_STATE, stale: Boolean(dataRef.current[wallet.address]), error: error instanceof Error ? error.message : '数据获取失败，请稍后重试。',
        } }));
      } finally {
        if (activeRequests.current.get(wallet.address) === controller) activeRequests.current.delete(wallet.address);
      }
    }));
  }, []);

  const refresh = useCallback(async () => { await configurationRefresh.current(); await runRequests(true); }, [runRequests]);

  const pollActivity = useCallback(async () => {
    const status = monitorRef.current;
    if (!alive.current || document.hidden || !status.available || !status.enabled) return;
    const busy = new Set([...activeRequests.current.keys(), ...headRequests.current.keys(), ...moreRequests.current.keys()]);
    const watched = configsRef.current.filter(wallet => status.addresses.includes(wallet.address) && dataRef.current[wallet.address]);
    const wallets = dueWallets(watched, status, lastHeadRequested.current, busy, Date.now(), false, 'activity');
    const revision = generation.current;
    await Promise.allSettled(wallets.map(async wallet => {
      const controller = new AbortController();
      headRequests.current.set(wallet.address, controller);
      lastHeadRequested.current.set(wallet.address, Date.now());
      setStates(current => ({ ...current, [wallet.address]: { ...(current[wallet.address] || EMPTY_STATE), loading: true } }));
      try {
        const payload = await requestJson(`/api/wallet/${wallet.address}/activity`, controller.signal, 15000);
        if (!Array.isArray(payload.activity) || typeof payload.pagination?.hasMore !== 'boolean') throw new Error('最新交易数据格式无效，请稍后重试。');
        if (!alive.current || controller.signal.aborted || revision !== generation.current) return;
        const previousError = headErrors.current.get(wallet.address);
        const health = activityHealth(payload.monitor);
        if (health.error) headErrors.current.set(wallet.address, health.error);
        else headErrors.current.delete(wallet.address);
        const hasSnapshotFailure = snapshotFailed(dataRef.current[wallet.address]);
        setLiveData(current => {
          const previous = current[wallet.address];
          if (!previous) return current;
          const refreshed = mergeActivityResponse(previous, payload);
          if (refreshed.activity === payload.activity && (!payload.pagination.hasMore || !mergeActivityRows(previous.activity, payload.activity).hasOverlap)) loadedCursors.current.delete(wallet.address);
          const next = { ...current, [wallet.address]: refreshed };
          dataRef.current = next;
          return next;
        });
        setStates(current => {
          const prior = current[wallet.address] || EMPTY_STATE;
          return { ...current, [wallet.address]: activityResponseState(prior, previousError, health, hasSnapshotFailure) };
        });
        setLastUpdated(payload.fetchedAt);
      } catch (error) {
        if (!alive.current || controller.signal.aborted || revision !== generation.current) return;
        const message = error instanceof Error ? error.message : '最新交易获取失败，请稍后重试。';
        const previousHeadError = headErrors.current.get(wallet.address);
        headErrors.current.set(wallet.address, message);
        setStates(current => {
          const prior = current[wallet.address] || EMPTY_STATE;
          return { ...current, [wallet.address]: { ...prior, loading: false, stale: true, error: prior.error && prior.error !== previousHeadError ? prior.error : message } };
        });
      } finally {
        if (headRequests.current.get(wallet.address) === controller) headRequests.current.delete(wallet.address);
      }
    }));
  }, []);

  const loadMore = useCallback(async (address: string) => {
    const current = dataRef.current[address];
    if (!current?.activityPagination.hasMore || !current.activityPagination.nextCursor || moreRequests.current.has(address) || activeRequests.current.has(address) || headRequests.current.has(address)) return;
    const cursor = current.activityPagination.nextCursor;
    if (loadedCursors.current.get(address)?.has(cursor)) {
      setStates(state => ({ ...state, [address]: { ...(state[address] || EMPTY_STATE), error: '数据服务返回了重复的交易分页游标，已停止重复加载。请稍后重试。' } }));
      return;
    }
    const controller = new AbortController();
    const revision = generation.current;
    moreRequests.current.set(address, controller);
    setStates(state => ({ ...state, [address]: { ...(state[address] || EMPTY_STATE), loadingMore: true } }));
    try {
      const payload = await requestJson(`/api/wallet/${address}/activity?cursor=${encodeURIComponent(cursor)}`, controller.signal);
      if (!Array.isArray(payload.activity) || typeof payload.pagination?.hasMore !== 'boolean') throw new Error('历史交易数据格式无效，请稍后重试。');
      if (controller.signal.aborted || !alive.current || revision !== generation.current) return;
      const cursors = loadedCursors.current.get(address) || new Set<string>();
      cursors.add(cursor);
      loadedCursors.current.set(address, cursors);
      const previousError = headErrors.current.get(address);
      const health = activityHealth(payload.monitor);
      if (health.error) headErrors.current.set(address, health.error);
      else headErrors.current.delete(address);
      const hasSnapshotFailure = snapshotFailed(dataRef.current[address]);
      setLiveData(state => {
        if (!state[address]) return state;
        const next = { ...state, [address]: mergeActivityResponse(state[address], payload, true) };
        dataRef.current = next; return next;
      });
      setStates(state => ({ ...state, [address]: activityResponseState(state[address] || EMPTY_STATE, previousError, health, hasSnapshotFailure) }));
    } catch (error) {
      if (controller.signal.aborted || !alive.current || revision !== generation.current) return;
      setStates(state => ({ ...state, [address]: { ...(state[address] || EMPTY_STATE), loadingMore: false, error: error instanceof Error ? error.message : '加载更多交易失败，请重试。' } }));
    } finally {
      if (moreRequests.current.get(address) === controller) moreRequests.current.delete(address);
    }
  }, []);

  const walletKey = configuredWallets.map(wallet => wallet.address).join(',');
  useEffect(() => {
    alive.current = true;
    // Configuration changes cancel all old requests; clear their UI locks even
    // when an unchanged wallet is not due for another full snapshot yet.
    setStates(current => Object.fromEntries(Object.entries(current).map(([key, state]) => [key, { ...state, loading: false, loadingMore: false }])));
    const run = () => {
      if (!document.hidden) {
        // Snapshot requests claim their per-wallet slot synchronously. Other
        // wallets can still poll lightweight activity while a snapshot is slow.
        void runRequests();
        void pollActivity();
      }
    };
    if (!document.hidden) { void runRequests(false, true); void pollActivity(); }
    const interval = setInterval(run, 1000);
    const visibility = () => {
      if (document.hidden) {
        abortRequests();
        setStates(current => Object.fromEntries(Object.entries(current).map(([key, state]) => [key, { ...state, loading: false, loadingMore: false }])));
      } else { void runRequests(false, true); void pollActivity(); }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive.current = false;
      abortRequests();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [walletKey, range, runRequests, pollActivity, abortRequests]);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const readStatus = async () => {
      if (disposed || document.hidden || controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const next = normalizeMonitor(await requestJson('/api/monitor', request.signal, 8000));
        if (!disposed && !request.signal.aborted) {
          monitorRef.current = next; setMonitor(next);
          applyConfiguration(next);
        }
      } catch {
        if (!disposed && !request.signal.aborted) {
          const next = configurationFailure(monitorRef.current);
          monitorRef.current = next; setMonitor(next);
        }
      } finally { if (controller === request) controller = null; }
    };
    configurationRefresh.current = readStatus;
    void readStatus();
    const interval = setInterval(() => { void readStatus(); }, 30000);
    const visibility = () => { if (!document.hidden) void readStatus(); else { controller?.abort(); controller = null; } };
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; controller?.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); if (configurationRefresh.current === readStatus) configurationRefresh.current = async () => {}; };
  }, [applyConfiguration]);

  const isDemo = false;
  const wallets = configuredWallets;
  const projectedData = useMemo(() => Object.fromEntries(Object.entries(liveData).map(([address, value]) => [address, projectWalletRange(value, range, rangeCache.current.get(address)?.[range])])), [liveData, range]);
  const data = projectedData;
  const entries: WalletEntry[] = wallets.map(wallet => {
    const value = data[wallet.address] || null;
    return {
      wallet, ...(states[wallet.address] || EMPTY_STATE),
      data: value,
    };
  });
  return { wallets, entries, data, states, isDemo, range, setRange, monitor,
    configurationLoading: monitor.loading, configurationError: monitor.error,
    refreshing: entries.some(entry => entry.loading), lastUpdated,
    refresh, loadMore,
  };
}
