import { createHash } from 'node:crypto';

const BASE_URL = 'https://data-api.polymarket.com';
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const CONDITION_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const RANGES = new Set(['1d', '1w', '1m', 'all']);
export const PNL_BASIS = 'polymarket-trade-pnl';
const PROFILE_FIDELITIES = { '1d': '1h', '1w': '3h', '1m': '18h', all: '1d' };

export class ApiError extends Error {
  constructor(message, status = 502, code = 'upstream_error', retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Missing marks mean unavailable, never zero. Do not coerce null or empty strings.
export const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value : '';
const isoNow = () => new Date().toISOString();

export function normalizePosition(row) {
  return {
    id: text(row.token_id), conditionId: text(row.condition_id),
    title: text(row.title), outcome: text(row.outcome),
    size: numberOrNull(row.current_size), avgPrice: numberOrNull(row.avg_price),
    currentPrice: numberOrNull(row.current_price), currentValue: numberOrNull(row.current_value),
    realizedPnl: numberOrNull(row.realized_pnl), unrealizedPnl: numberOrNull(row.unrealized_pnl),
    totalPnl: numberOrNull(row.total_pnl), costBasis: numberOrNull(row.entry_cost_usdc),
    status: text(row.status), redeemable: Boolean(row.redeemable), archived: Boolean(row.archived),
    slug: text(row.slug), eventSlug: text(row.event_slug), icon: text(row.icon),
    timestamp: numberOrNull(row.last_event_at), endDate: text(row.end_date),
  };
}

export function normalizeActivity(rows, pageKey = 'head') {
  const occurrences = new Map();
  const pageId = createHash('sha256').update(pageKey).digest('hex').slice(0, 16);
  return rows.map(row => {
    const key = [row.transaction_hash, row.timestamp, row.token_id, row.type, row.side, row.size, row.usdc_size, row.price].join(':');
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    return {
      id: `${key}:${occurrence}:${pageId}`, contentKey: key, type: text(row.type), side: text(row.side),
      title: text(row.title), outcome: text(row.outcome),
      price: numberOrNull(row.price), size: numberOrNull(row.size), amount: numberOrNull(row.usdc_size),
      timestamp: numberOrNull(row.timestamp), transactionHash: text(row.transaction_hash),
      slug: text(row.slug), eventSlug: text(row.event_slug), icon: text(row.icon),
      isCombo: Boolean(row.is_combo),
    };
  });
}

export function normalizePnl(point) {
  return {
    timestamp: numberOrNull(point?.timestamp), totalPnl: numberOrNull(point?.trade_pnl),
    realizedPnl: numberOrNull(point?.realized_pnl), unrealizedPnl: numberOrNull(point?.unrealized_pnl),
  };
}

const PERIOD_SECONDS = { '1d': 86400, '1w': 7 * 86400, '1m': 30 * 86400 };

export function pnlIsStale(observedAt, sourceFidelity, currentTime = Date.now() / 1000) {
  const hours = { '1d': 48, '18h': 36, '12h': 24, '3h': 6, '1h': 2 }[sourceFidelity] || 2;
  return numberOrNull(observedAt) !== null && currentTime - observedAt > hours * 3600;
}

// Match the profile's own interval/fidelity series. These are published chart
// boundaries (e.g. 23 hours for a 24-point 1D chart), not exact rolling windows.
export function calculateProfilePeriod(points, range, sourceFidelity = null, observedAt = null, currentTime = Date.now() / 1000) {
  const ordered = points.filter(point => numberOrNull(point.timestamp) !== null).sort((a, b) => a.timestamp - b.timestamp);
  const first = ordered[0];
  const last = ordered.at(-1);
  const validBounds = first && last && first.timestamp < last.timestamp;
  const delta = key => validBounds && numberOrNull(first[key]) !== null && numberOrNull(last[key]) !== null ? last[key] - first[key] : null;
  const totalPnl = delta('totalPnl');
  const stale = pnlIsStale(observedAt ?? last?.timestamp, sourceFidelity, currentTime);
  const reason = totalPnl === null ? '官方图表缺少有效起止盈亏值，暂不计算周期盈亏。'
    : `与 Polymarket 个人页同口径，按所选周期图表首尾值相减；实际区间以起止时间为准。${sourceFidelity === '1d' ? '官方历史源为日频，细网格不代表逐小时新观测。' : ''}`;
  return { range, start: first?.timestamp ?? null, end: last?.timestamp ?? null,
    totalPnl, realizedPnl: delta('realizedPnl'), unrealizedPnl: delta('unrealizedPnl'),
    complete: totalPnl !== null, reason: reason + (stale ? '官方源观测已超过其更新频率的宽限期。' : ''),
    sourceFidelity, observedAt, stale, pnlBasis: PNL_BASIS };
}

// The interval endpoints omit their left boundary. Use a wider series and exact
// matching timestamps; never silently call a 23-hour first/last delta "24 hours".
export function calculatePeriod(points, range, sourceFidelity = null, observedAt = null, currentTime = Date.now() / 1000) {
  const duration = PERIOD_SECONDS[range];
  const ordered = points.filter(point => numberOrNull(point.timestamp) !== null).sort((a, b) => a.timestamp - b.timestamp);
  const latest = ordered.at(-1);
  const byTime = new Map(ordered.map(point => [point.timestamp, point]));
  const endPoint = [...ordered].reverse().find(point => latest.timestamp - point.timestamp <= 3600 && byTime.has(point.timestamp - duration)) || latest;
  const start = endPoint ? endPoint.timestamp - duration : null;
  const base = start !== null ? byTime.get(start) : null;
  const delta = key => base && endPoint && numberOrNull(base[key]) !== null && numberOrNull(endPoint[key]) !== null ? endPoint[key] - base[key] : null;
  const result = { range, start, end: endPoint?.timestamp ?? null,
    totalPnl: delta('totalPnl'), realizedPnl: delta('realizedPnl'), unrealizedPnl: delta('unrealizedPnl'),
    complete: false, reason: null, sourceFidelity, observedAt,
    stale: endPoint ? pnlIsStale(Math.min(observedAt ?? endPoint.timestamp, endPoint.timestamp), sourceFidelity, currentTime) : false };
  result.complete = [result.totalPnl, result.realizedPnl, result.unrealizedPnl].every(value => value !== null);
  result.reason = !base ? '官方历史数据未覆盖该周期的完整起止边界，暂不计算周期盈亏。'
    : !result.complete ? '该周期边界存在未发布的盈亏数值，缺失部分不按零计算。'
      : sourceFidelity === '1d' ? '按官方小时网格起止值相减；官方声明历史源为日频，非逐笔结算值。' : null;
  if (result.stale) result.reason = `${result.reason || ''}官方源观测已超过其更新频率的宽限期，周期截至已发布的历史边界。`;
  return result;
}

export function aggregateWindows(openPositions, closedPositions, complete = true) {
  const tokens = new Map();
  // Prefer newer data if a token moved from OPEN to CLOSED during pagination.
  // For equally dated snapshots, prefer the current book to avoid adding it twice.
  for (const row of [...closedPositions, ...openPositions]) {
    const key = row.id || `${row.conditionId}:${row.outcome}`;
    const previous = tokens.get(key);
    if (!previous || (row.timestamp ?? 0) >= (previous.timestamp ?? 0)) tokens.set(key, row);
  }
  const groups = new Map();
  for (const row of tokens.values()) {
    const key = row.conditionId || row.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([id, rows]) => {
    const first = rows[0];
    const sum = key => rows.every(row => numberOrNull(row[key]) !== null) ? rows.reduce((total, row) => total + row[key], 0) : null;
    const slugMatch = /^btc-updown-5m-(\d{10})$/.exec(first.slug) || /^btc-updown-5m-(\d{10})$/.exec(first.eventSlug);
    const windowStart = slugMatch ? Number(slugMatch[1]) : null;
    const times = rows.map(row => row.timestamp).filter(value => value !== null);
    return {
      id, conditionId: first.conditionId, title: first.title, slug: first.slug, eventSlug: first.eventSlug, icon: first.icon,
      outcomes: [...new Set(rows.map(row => row.outcome))], positionCount: rows.length,
      totalPnl: sum('totalPnl'), realizedPnl: sum('realizedPnl'), unrealizedPnl: sum('unrealizedPnl'), currentValue: sum('currentValue'),
      status: rows.some(row => row.status === 'OPEN') ? 'OPEN' : rows.some(row => row.status === 'REDEEMABLE') ? 'REDEEMABLE' : 'CLOSED',
      timestamp: times.length ? Math.max(...times) : null, windowStart, endTime: windowStart !== null ? windowStart + 300 : null,
      isBtc5m: Boolean(slugMatch), complete,
    };
  }).sort((a, b) => (b.windowStart ?? b.timestamp ?? 0) - (a.windowStart ?? a.timestamp ?? 0));
}

function pagination(page) {
  if (!page || !Array.isArray(page.data) || !page.pagination || typeof page.pagination.has_more !== 'boolean') {
    throw new ApiError('Polymarket 返回了无法识别的数据格式。', 502, 'invalid_upstream_data');
  }
  const nextCursor = typeof page.pagination.next_cursor === 'string' && page.pagination.next_cursor ? page.pagination.next_cursor : null;
  if (page.pagination.has_more && !nextCursor) {
    throw new ApiError('Polymarket 分页游标缺失，请稍后重试。', 502, 'invalid_upstream_data');
  }
  return { hasMore: page.pagination.has_more, nextCursor };
}

export function createPolymarketClient({ fetchImpl = globalThis.fetch, now = Date.now, requestTimeout = 12000,
  maxPositionPages = 20, positionPageSize = 1000, positionWalkTimeout = 8000,
  snapshotTtl = 60000, activityTtl = 10000, cacheLimit = 256 } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function cached(key, ttl, work) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = work().then(value => {
      cache.delete(key);
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), value });
      return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }

  async function request(path, params, timeout = requestTimeout) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let response;
    let payload;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, Math.round(timeout))), headers: { Accept: 'application/json' }, redirect: 'error' });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after')) || null;
        throw new ApiError(response.status === 429 ? 'Polymarket 请求频率受限，请稍后重试。' : `Polymarket 数据暂不可用（HTTP ${response.status}）。`, response.status === 429 ? 429 : 502, 'upstream_error', retryAfter);
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('无法连接 Polymarket 数据服务，请检查网络或代理后重试。', 502, error?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unavailable');
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload)) throw new ApiError('Polymarket 返回了无法识别的数据格式。', 502, 'invalid_upstream_data');
    return payload;
  }

  function addressOf(address) {
    if (!ADDRESS_PATTERN.test(address)) throw new ApiError('请输入有效的 0x 开头、40 位十六进制钱包地址。', 400, 'invalid_address');
    return address.toLowerCase();
  }

  async function walkPositions(address, status, condition) {
      const started = now();
      const rows = new Map();
      const cursors = new Set();
      let cursor;
      let complete = false;
      let error = null;
      let reason = null;
      let fetchedPages = 0;
      for (let pageIndex = 0; pageIndex < maxPositionPages; pageIndex++) {
        if (pageIndex > 0 && now() - started >= positionWalkTimeout) { reason = '已达到本次历史加载时间上限。'; break; }
        try {
          const page = await request('/v2/positions', {
            user: address, condition, status, limit: positionPageSize, cursor,
            filter_type: 'TOKENS', filter_amount: 0,
            include_archived: status === 'OPEN' ? true : undefined,
            sort_by: status === 'OPEN' ? 'CURRENT_VALUE' : 'TIMESTAMP', sort_direction: 'DESC',
          }, Math.min(requestTimeout, positionWalkTimeout - (now() - started)));
          const paging = pagination(page);
          if (condition && page.data.some(row => text(row.condition_id).toLowerCase() !== condition)) {
            throw new ApiError('Polymarket 返回了不匹配的市场数据，无法核验此窗口。', 502, 'invalid_upstream_data');
          }
          fetchedPages++;
          for (const row of page.data) rows.set(row.token_id, row);
          if (!paging.hasMore) { complete = true; break; }
          if (cursors.has(paging.nextCursor)) throw new ApiError('Polymarket 返回重复分页游标。');
          cursors.add(paging.nextCursor);
          cursor = paging.nextCursor;
        } catch (failure) {
          if (!fetchedPages) throw failure;
          if (failure.code === 'upstream_timeout' && now() - started >= positionWalkTimeout - 50) reason = '已达到本次历史加载时间上限。';
          else error = failure.message;
          break;
        }
      }
      return { rows: [...rows.values()], complete, error, reason, fetchedAt: isoNow() };
  }

  async function positions(address, status, condition) {
    // Both books share one cache entry and expiry. A closed token must not vanish
    // between a newly refreshed OPEN book and an older cached CLOSED book.
    const pair = await cached(`position-pair:${address}:${condition || 'all'}`, snapshotTtl, async () => {
      const results = await Promise.allSettled([
        walkPositions(address, 'OPEN', condition), walkPositions(address, 'CLOSED', condition),
      ]);
      if (results.every(result => result.status === 'rejected')) throw results[0].reason;
      return results;
    });
    const result = pair[status === 'OPEN' ? 0 : 1];
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }

  async function activity(address, cursor = null) {
    address = addressOf(address);
    if (cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_=-]{1,8192}$/.test(cursor))) throw new ApiError('交易分页游标无效，请刷新后重试。', 400, 'invalid_cursor');
    return cached(`activity:${address}:${cursor || ''}`, activityTtl, async () => {
      const page = await request('/v2/activity', { user: address, limit: 100, cursor, start: 1, sort_direction: 'DESC', exclude_deposits_withdrawals: false });
      const paging = pagination(page);
      return { activity: normalizeActivity(page.data, cursor || 'head'), pagination: paging, fetchedAt: isoNow(),
        profile: page.data[0] ? { name: text(page.data[0].name) || text(page.data[0].pseudonym), avatar: text(page.data[0].profile_image) } : null };
    });
  }

  async function window(address, conditionId) {
    address = addressOf(address);
    if (!CONDITION_PATTERN.test(conditionId)) throw new ApiError('市场标识必须为 0x 开头的 64 位十六进制 conditionId。', 400, 'invalid_condition');
    const condition = conditionId.toLowerCase();
    const keys = ['positions', 'closedPositions'];
    const results = await Promise.allSettled([positions(address, 'OPEN', condition), positions(address, 'CLOSED', condition)]);
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    const data = {};
    const coverage = {};
    const warnings = [];
    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === 'fulfilled') {
        data[key] = result.value.rows.map(normalizePosition);
        coverage[key] = { complete: result.value.complete, count: result.value.rows.length, fetchedAt: result.value.fetchedAt, error: result.value.error };
        if (!result.value.complete) warnings.push(`${key === 'positions' ? '当前' : '历史'}持仓尚未完整加载，窗口盈亏仍待核验。${result.value.error || result.value.reason || ''}`);
      } else {
        data[key] = [];
        coverage[key] = { complete: false, count: 0, fetchedAt: null, error: result.reason.message };
        warnings.push(`${key === 'positions' ? '当前' : '历史'}持仓核验失败：${result.reason.message}`);
      }
    });
    const complete = coverage.positions.complete && coverage.closedPositions.complete;
    const result = aggregateWindows(data.positions, data.closedPositions, complete).find(row => row.conditionId.toLowerCase() === condition) || null;
    if (!result && complete) warnings.push('官方接口未找到该钱包在此窗口的可服务持仓，不能据此断定该窗口盈亏为零。');
    return { window: result, coverage, fetchedAt: isoNow(), warnings };
  }

  async function wallet(address, range = '1m') {
    address = addressOf(address);
    if (!RANGES.has(range)) throw new ApiError('时间范围只能是 1d、1w、1m 或 all。', 400, 'invalid_range');
    const keys = ['stats', 'history', 'value', 'positions', 'closedPositions', 'activity'];
    const results = await Promise.allSettled([
      cached(`stats:${address}`, snapshotTtl, () => request('/v2/user-stats', { user: address })),
      cached(`history:${address}`, snapshotTtl, async () => Object.fromEntries(await Promise.all(Object.entries(PROFILE_FIDELITIES).map(async ([interval, fidelity]) => {
        const result = await request('/v2/user-pnl', { user: address, interval, fidelity });
        if (!Array.isArray(result.data?.points)) throw new ApiError('Polymarket 返回了无法识别的盈亏曲线。', 502, 'invalid_upstream_data');
        return [interval, result.data];
      })))),
      cached(`value:${address}`, snapshotTtl, () => request('/v2/value', { user: address })),
      positions(address, 'OPEN'), positions(address, 'CLOSED'), activity(address),
    ]);
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    const data = {};
    const warnings = [];
    const sections = {};
    const sectionErrors = {};
    const sectionLabels = { stats: '盈亏统计', history: '盈亏曲线', value: '持仓价值', positions: '当前持仓', closedPositions: '历史持仓', activity: '交易明细' };
    results.forEach((result, index) => {
      const key = keys[index];
      sections[key] = result.status === 'fulfilled' ? 'ok' : 'error';
      if (result.status === 'fulfilled') data[key] = result.value;
      else { sectionErrors[key] = result.reason.message; warnings.push(`${sectionLabels[key]}：${result.reason.message}`); }
    });
    if (data.stats && data.stats.data === null) warnings.push('该地址暂无公开用户统计。请确认输入的是 Polymarket 个人资料中的代理钱包地址。');
    const point = data.stats?.data?.all_time_pnl;
    if (data.stats?.data && !point) warnings.push('Polymarket 尚未发布该钱包的盈亏观测值。');
    const coverage = {};
    for (const key of ['positions', 'closedPositions']) {
      coverage[key] = { complete: data[key]?.complete ?? false, count: data[key]?.rows.length ?? 0, fetchedAt: data[key]?.fetchedAt ?? null, error: data[key]?.error || sectionErrors[key] || null };
      if (data[key] && !data[key].complete) warnings.push(`${sectionLabels[key]}只加载了 ${data[key].rows.length} 条，列表不完整；顶部盈亏来自官方全历史统计，不由此列表累加。${data[key].error || data[key].reason || ''}`);
    }
    const summary = {
      totalPnl: numberOrNull(point?.trade_pnl), realizedPnl: numberOrNull(point?.realized_pnl),
      unrealizedPnl: numberOrNull(point?.unrealized_pnl), positionValue: numberOrNull(data.value?.data?.value),
      volume: numberOrNull(point?.volume_usdc), tradeCount: numberOrNull(point?.trade_count),
      observedAt: numberOrNull(point?.timestamp), economicPnl: numberOrNull(point?.economic_pnl),
      walletIncome: numberOrNull(point?.wallet_income), feesPaid: numberOrNull(point?.fees_paid), source: 'polymarket-v2', pnlBasis: PNL_BASIS,
    };
    const profileRow = data.positions?.rows.find(row => row.name) || data.closedPositions?.rows.find(row => row.name);
    const historyByRange = Object.fromEntries(Object.keys(PROFILE_FIDELITIES).map(key => [key, (data.history?.[key]?.points || []).map(normalizePnl)]));
    const sourceFidelity = data.history?.[range]?.source_fidelity ?? null;
    const periods = Object.fromEntries(Object.keys(PERIOD_SECONDS).map(key => [key, calculateProfilePeriod(historyByRange[key], key, data.history?.[key]?.source_fidelity ?? null, summary.observedAt, now() / 1000)]));
    const period = range === 'all' ? { range, start: null, end: summary.observedAt,
      totalPnl: summary.totalPnl, realizedPnl: summary.realizedPnl, unrealizedPnl: summary.unrealizedPnl,
      complete: summary.totalPnl !== null,
      reason: '全历史采用官方个人页 trade_pnl 累计值；不以最早可见观测值作为零基线。', sourceFidelity, observedAt: summary.observedAt, pnlBasis: PNL_BASIS,
      stale: pnlIsStale(summary.observedAt, sourceFidelity, now() / 1000) } : periods[range];
    const openRows = (data.positions?.rows || []).map(normalizePosition);
    const closedRows = (data.closedPositions?.rows || []).map(normalizePosition);
    return {
      address, fetchedAt: isoNow(), source: 'live', range, pnlBasis: PNL_BASIS, historyPnlBasis: PNL_BASIS,
      profile: data.activity?.profile || { name: text(profileRow?.name), avatar: text(profileRow?.profile_image) },
      summary, period, periods,
      history: historyByRange[range], historyByRange, historyAll: historyByRange.all,
      historySourceFidelity: sourceFidelity,
      positions: openRows, closedPositions: closedRows,
      windows: aggregateWindows(openRows, closedRows, coverage.positions.complete && coverage.closedPositions.complete),
      activity: data.activity?.activity || [],
      activityPagination: data.activity?.pagination || { hasMore: false, nextCursor: null },
      activityFetchedAt: data.activity?.fetchedAt || null,
      coverage, sections, warnings,
      methodology: '总盈亏采用与 Polymarket 个人页一致的 trade_pnl；1天/1周/1个月分别使用官方 1h/3h/18h 图表采样序列首尾差，实际区间以起止时间为准。已实现、未实现为官方仓位净盈亏字段，并非 trade_pnl 的拆分，不能相加核对图表总额。每窗口按 conditionId 合并双方持仓的全生命周期 total_pnl，不是所选周期增量，也不是账户图表口径。手续费不再手动调整。持仓价值不含可用现金；单市场列表不覆盖组合持仓。',
    };
  }

  return { wallet, activity, window };
}
