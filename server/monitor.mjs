import { aggregateWindows } from './polymarket.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86400;
const message = error => error instanceof Error ? error.message : String(error);
const timestamp = row => typeof row?.timestamp === 'number' && Number.isFinite(row.timestamp) && Number.isInteger(row.timestamp) && row.timestamp >= 0;
const SECTION_NAMES = { stats: '盈亏统计', value: '持仓价值', history: '盈亏曲线', positions: '当前持仓', closedPositions: '历史持仓', activity: '交易接口' };

/** Preserve last-known successful sections, while keeping their error and age visible. */
export function mergeCollectedSnapshot(next, previous) {
  const result = { ...next, summary: { ...next.summary }, sections: { ...next.sections },
    coverage: structuredClone(next.coverage || {}), sectionFetchedAt: { ...next.sectionFetchedAt },
    warnings: [...(next.warnings || [])] };
  for (const key of Object.keys(SECTION_NAMES)) {
    const failed = next.sections?.[key] === 'error';
    const source = failed ? previous : next;
    result.sectionFetchedAt[key] = source?.sectionFetchedAt?.[key]
      ?? (key === 'positions' || key === 'closedPositions' ? source?.coverage?.[key]?.fetchedAt : key === 'activity' ? source?.activityFetchedAt : source?.fetchedAt)
      ?? null;
    if (failed) result.warnings.push(`${SECTION_NAMES[key]}刷新失败；${previous ? '保留可用的上次数据，原观测时间未更新。' : '尚无可用历史快照。'}`);
  }
  if (previous && next.sections?.stats === 'error') {
    result.summary = { ...previous.summary, positionValue: next.summary?.positionValue ?? null };
  }
  if (previous && next.sections?.value === 'error') result.summary.positionValue = previous.summary?.positionValue ?? null;
  if (previous && next.sections?.history === 'error') {
    result.historyAll = structuredClone(previous.historyAll || previous.history || []);
    result.historySourceFidelity = previous.historySourceFidelity ?? null;
    const reason = '曲线接口刷新失败，保留原区间的历史快照，尚未重新核验。';
    const stalePeriod = period => period ? { ...period, complete: false, stale: true,
      reason: period.reason?.includes(reason) ? period.reason : [period.reason, reason].filter(Boolean).join('；') } : null;
    result.periods = Object.fromEntries(Object.entries(previous.periods || {}).map(([key, period]) => [key, stalePeriod(period)]));
    result.period = result.periods[next.range || '1m'] || stalePeriod(previous.period);
    result.history = result.period && typeof result.period.start === 'number' && typeof result.period.end === 'number'
      ? result.historyAll.filter(point => timestamp(point) && point.timestamp >= result.period.start && point.timestamp <= result.period.end)
      : structuredClone(previous.history || []);
  }
  let retainedBook = false;
  for (const key of ['positions', 'closedPositions']) {
    if (next.sections?.[key] !== 'error') continue;
    retainedBook = true;
    result[key] = structuredClone(previous?.[key] || []);
    result.coverage[key] = { ...(previous?.coverage?.[key] || {}), complete: false, count: result[key].length,
      fetchedAt: previous?.coverage?.[key]?.fetchedAt ?? null };
  }
  if (retainedBook) {
    result.windows = aggregateWindows(result.positions || [], result.closedPositions || [], false);
    result.warnings.push('窗口盈亏由当前可用仓位快照合并，包含保留或缺失的数据块，均标记为部分；可独立核验窗口。');
  }
  if (next.sections?.activity === 'error') {
    // The independently persisted, closed timestamp buckets remain the activity source.
    result.activity = [];
    result.activityPagination = { hasMore: false, nextCursor: null };
    result.activityFetchedAt = previous?.activityFetchedAt ?? null;
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}

function scanState() {
  return { cursor: null, carry: [], seenCursors: [], pages: 0, oldestSeen: null, newestSeen: null,
    startedAt: null, gap: null, blocked: false, finished: false, complete: false };
}

function initialState(saved, cutoff) {
  const initial = { version: 1, lastSuccess: null, snapshotAt: null, activityAt: null,
    snapshotError: null, activityError: null, coverage: { gaps: [], source: 'public-api', cutoff },
    head: { ...scanState(), active: false, completedThrough: null, target: null },
    backfill: { ...scanState(), cutoff, exhausted: false } };
  if (!saved || saved.version !== 1) return initial;
  return { ...initial, ...saved, coverage: { ...initial.coverage, ...saved.coverage },
    head: { ...initial.head, ...saved.head }, backfill: { ...initial.backfill, ...saved.backfill } };
}

/** A bounded, public-API collector. No claim of canonical on-chain fill identity. */
export function createMonitor({ client, store, addresses = [], now = Date.now,
  activityIntervalMs = 5000, snapshotIntervalMs = 60000, headPagesPerTick = 2,
  backfillPagesPerTick = 2, maxPagesPerTick = 5, overlapSeconds = 300,
  maxCarryRows = 20000, maxBackoffMs = 300000, pruneIntervalMs = 3600000 } = {}) {
  if (!client?.wallet || !client?.activity || !store?.saveState || !store?.ingestActivityGroups) throw new Error('Monitor requires a wallet/activity client and a persistent store.');
  if (![activityIntervalMs, snapshotIntervalMs, pruneIntervalMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('Monitor intervals must be positive.');
  if (![headPagesPerTick, backfillPagesPerTick, maxPagesPerTick, maxCarryRows].every(value => Number.isInteger(value) && value > 0)) throw new Error('Monitor page and carry limits must be positive integers.');
  const configured = [...new Set(addresses.map(address => {
    if (typeof address !== 'string' || !ADDRESS.test(address)) throw new Error('Invalid monitored wallet address.');
    return address.toLowerCase();
  }))];
  const retentionDays = 30;
  const cutoff = () => Math.floor(now() / 1000) - retentionDays * DAY;
  const runtimes = new Map(configured.map(address => [address, {
    address, state: initialState(store.getState(address), cutoff()),
    nextActivityAt: 0, nextSnapshotAt: 0, activityFailures: 0, snapshotFailures: 0,
    activityTask: null, snapshotTask: null,
  }]));
  let enabled = false;
  let stopping = false;
  let stopPromise = null;
  let timer = null;
  let lastPrunedAt = -Infinity;
  let monitorError = null;

  function persist(runtime) { store.saveState(runtime.address, runtime.state); }
  function gap(runtime, scan, reason, block = false) {
    scan.gap = reason;
    scan.complete = false;
    if (block) scan.blocked = true;
    if (!runtime.state.coverage.gaps.includes(reason)) runtime.state.coverage.gaps = [...runtime.state.coverage.gaps, reason].slice(-20);
    persist(runtime);
  }

  // No tail timestamp bucket is written until an earlier timestamp is observed
  // or the server explicitly says the feed has ended. Carry survives restarts.
  function consume(runtime, scan, page, kind) {
    const fail = reason => { gap(runtime, scan, reason, true); throw new Error(reason); };
    if (!page || !Array.isArray(page.activity) || typeof page.pagination?.hasMore !== 'boolean') fail(`${kind}：上游活动分页格式无效。`);
    const nextCursor = page.pagination.nextCursor;
    if (page.pagination.hasMore && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.startsWith('local:'))) fail(`${kind}：上游分页游标缺失或无效。`);
    if (page.pagination.hasMore && (nextCursor === scan.cursor || scan.seenCursors.includes(nextCursor))) fail(`${kind}：上游返回重复游标，历史覆盖存在缺口。`);
    const unknownCount = page.activity.filter(row => !timestamp(row)).length;
    if (unknownCount) gap(runtime, scan, `${kind}：存在未知时间戳记录，未写入历史；覆盖不能标记完整。`);
    const valid = page.activity.filter(timestamp);
    const combined = [...scan.carry, ...valid];
    for (let index = 1; index < combined.length; index++) {
      if (combined[index].timestamp > combined[index - 1].timestamp) fail(`${kind}：记录时间顺序异常，停止该游标扫描以避免错误合并。`);
    }
    const buckets = [];
    for (const row of combined) {
      const last = buckets.at(-1);
      if (last?.[0].timestamp === row.timestamp) last.push(row);
      else buckets.push([row]);
    }
    const tail = buckets.at(-1) || [];
    if (tail.length > maxCarryRows) fail(`${kind}：单时间戳桶超过 ${maxCarryRows} 条安全上限，未截断入账；需扩大容量后重扫。`);
    const exhausted = !page.pagination.hasMore;
    const retentionCutoff = cutoff();
    const crossesRetention = valid.some(row => row.timestamp < retentionCutoff);
    const crossesHeadTarget = kind === '实时续扫' && valid.some(row => row.timestamp < scan.target);
    const completeBuckets = exhausted ? buckets : buckets.slice(0, -1);
    const closedRows = completeBuckets.flat().filter(row => row.timestamp >= retentionCutoff);
    // Store max-count semantics make a crash after ingestion but before saveState safe to replay.
    store.ingestActivityGroups(runtime.address, closedRows);
    scan.carry = exhausted || crossesRetention || crossesHeadTarget ? [] : tail;
    if (scan.cursor) scan.seenCursors = [...scan.seenCursors, scan.cursor].slice(-64);
    scan.cursor = exhausted ? null : nextCursor;
    scan.pages += 1;
    if (valid.length) {
      scan.newestSeen = Math.max(scan.newestSeen ?? valid[0].timestamp, valid[0].timestamp);
      scan.oldestSeen = Math.min(scan.oldestSeen ?? valid.at(-1).timestamp, valid.at(-1).timestamp);
    }
    if (kind === '历史补录' && (exhausted || crossesRetention)) {
      scan.finished = true;
      scan.complete = !scan.gap;
      scan.exhausted = exhausted;
      scan.cutoff = retentionCutoff;
      scan.cursor = null;
    }
    if (kind === '实时续扫' && (exhausted || crossesRetention || crossesHeadTarget)) {
      scan.active = false;
      scan.finished = true;
      scan.complete = !scan.gap;
      scan.completedThrough = scan.newestSeen ?? Math.floor(now() / 1000);
      scan.cursor = null;
    }
    runtime.state.activityAt = now();
    runtime.state.lastSuccess = now();
    runtime.state.coverage.cutoff = retentionCutoff;
    persist(runtime);
  }

  async function collectActivity(runtime) {
    const state = runtime.state;
    let requests = 0;
    let headUsedLatest = false;
    async function fetchPage(cursor) {
      if (requests >= maxPagesPerTick) return null;
      requests++;
      return client.activity(runtime.address, cursor);
    }
    // A separate fresh head page keeps new activity visible while a long catch-up
    // walk continues. Its unfinished tail is left to the durable walks below.
    const latest = await fetchPage(null);
    if (state.head.active || state.head.blocked) consume(runtime, scanState(), latest, '最新页');
    if (!state.head.active && !state.head.blocked) {
      const previousThrough = state.head.completedThrough;
      state.head = { ...scanState(), active: true, completedThrough: previousThrough,
        target: (previousThrough ?? Math.floor(now() / 1000)) - overlapSeconds, startedAt: now() };
      consume(runtime, state.head, latest, '实时续扫');
      headUsedLatest = true;
    }
    const historyReserve = !state.backfill.finished && !state.backfill.blocked ? 1 : 0;
    for (let pages = headUsedLatest ? 1 : 0;
      pages < headPagesPerTick && state.head.active && !state.head.blocked && requests < maxPagesPerTick - historyReserve; pages++) {
      const page = await fetchPage(state.head.cursor);
      consume(runtime, state.head, page, '实时续扫');
    }
    if (!state.backfill.startedAt) state.backfill.startedAt = now();
    for (let pages = 0; pages < backfillPagesPerTick && !state.backfill.finished && !state.backfill.blocked; pages++) {
      // Reuse the head response for the first historical page; it does not cost
      // another request and still has its own independent carry/checkpoint.
      const page = state.backfill.pages === 0 && state.backfill.cursor === null ? latest : await fetchPage(state.backfill.cursor);
      if (!page) break;
      consume(runtime, state.backfill, page, '历史补录');
    }
    state.activityError = null;
    persist(runtime);
  }

  async function collectSnapshot(runtime) {
    const received = await client.wallet(runtime.address, '1m');
    const payload = mergeCollectedSnapshot(received, store.getSnapshot(runtime.address, '1m'));
    if (store.saveSnapshot(runtime.address, payload) === false) throw new Error('钱包快照未通过存储校验，未标记采集成功。');
    runtime.state.snapshotAt = now();
    runtime.state.lastSuccess = now();
    const failed = Object.keys(SECTION_NAMES).filter(key => received.sections?.[key] === 'error');
    runtime.state.snapshotError = failed.length ? `部分接口异常：${failed.map(key => SECTION_NAMES[key]).join('、')}；保留可用历史数据并标记数据块时间。` : null;
    persist(runtime);
  }

  function schedule(runtime, kind) {
    const activity = kind === 'activity';
    const taskKey = activity ? 'activityTask' : 'snapshotTask';
    const nextKey = activity ? 'nextActivityAt' : 'nextSnapshotAt';
    const failureKey = activity ? 'activityFailures' : 'snapshotFailures';
    const errorKey = activity ? 'activityError' : 'snapshotError';
    const interval = activity ? activityIntervalMs : snapshotIntervalMs;
    const work = activity ? collectActivity : collectSnapshot;
    const promise = work(runtime).then(() => {
      runtime[failureKey] = 0;
      runtime[nextKey] = now() + interval;
    }).catch(error => {
      runtime[failureKey] += 1;
      runtime.state[errorKey] = message(error);
      runtime[nextKey] = now() + Math.min(maxBackoffMs, interval * 2 ** Math.min(runtime[failureKey], 10));
      try { persist(runtime); } catch (storageError) { monitorError = message(storageError); }
    }).finally(() => { runtime[taskKey] = null; });
    runtime[taskKey] = promise;
    return promise;
  }

  async function tick() {
    if (stopping) return;
    const tasks = [];
    for (const runtime of runtimes.values()) {
      if (!runtime.snapshotTask && now() >= runtime.nextSnapshotAt) tasks.push(schedule(runtime, 'snapshot'));
      if (!runtime.activityTask && now() >= runtime.nextActivityAt) tasks.push(schedule(runtime, 'activity'));
    }
    if (now() - lastPrunedAt >= pruneIntervalMs) {
      try { store.prune(); lastPrunedAt = now(); } catch (error) { monitorError = message(error); }
    }
    await Promise.all(tasks);
  }

  function start() {
    if (enabled || configured.length === 0) return;
    enabled = true;
    stopping = false;
    stopPromise = null;
    const run = () => { void tick().catch(error => { monitorError = message(error); }); };
    run();
    timer = setInterval(run, Math.min(activityIntervalMs, snapshotIntervalMs, 1000));
    timer.unref?.();
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    enabled = false;
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    stopPromise = (async () => {
      await Promise.all([...runtimes.values()].flatMap(runtime => [runtime.snapshotTask, runtime.activityTask]).filter(Boolean));
      for (const runtime of runtimes.values()) persist(runtime);
    })();
    return stopPromise;
  }

  function publicScan(scan) {
    const { carry, seenCursors, ...rest } = scan;
    return { ...rest, pendingRows: carry.length };
  }
  function status() {
    return { enabled, retentionDays, addresses: [...configured],
      intervals: { activityMs: activityIntervalMs, snapshotMs: snapshotIntervalMs }, monitorError,
      coverageClaim: '仅表示公开 API 可服务历史的遍历状态，不是链上逐笔审计完整性。',
      wallets: [...runtimes.values()].map(runtime => ({ address: runtime.address,
        lastSuccess: runtime.state.lastSuccess, snapshotAt: runtime.state.snapshotAt, activityAt: runtime.state.activityAt,
        snapshotError: runtime.state.snapshotError, activityError: runtime.state.activityError,
        snapshotRunning: Boolean(runtime.snapshotTask), activityRunning: Boolean(runtime.activityTask),
        nextActivityAt: runtime.nextActivityAt, nextSnapshotAt: runtime.nextSnapshotAt,
        coverage: { ...runtime.state.coverage, gaps: [...runtime.state.coverage.gaps],
          complete: runtime.state.backfill.complete && runtime.state.head.complete && !runtime.state.head.active
            && !runtime.state.activityError && runtime.state.coverage.gaps.length === 0,
          currentGap: runtime.state.activityError ? `活动采集失败，最新覆盖边界待恢复：${runtime.state.activityError}`
            : runtime.state.head.blocked ? runtime.state.head.gap
              : runtime.state.head.active ? '实时增量尚在补录，最新页已独立采集。'
                : runtime.state.head.gap || runtime.state.coverage.gaps.at(-1)
                  || (!runtime.state.backfill.complete ? runtime.state.backfill.gap || '最近30天公开历史尚未遍历完成。' : null) },
        head: publicScan(runtime.state.head), backfill: publicScan(runtime.state.backfill) })) };
  }
  return { start, stop, tick, status };
}
