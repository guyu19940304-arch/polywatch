import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, mergeCollectedSnapshot } from '../server/monitor.mjs';
import { createStore } from '../server/store.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ADDRESS = `0x${'a'.repeat(40)}`;
const START = 1800000000000;
const clone = value => structuredClone(value);
const event = (time, contentKey = 'fill', id = 'presentation-id') => ({ timestamp: time, contentKey, id, type: 'TRADE', amount: 10 });
const page = (activity, nextCursor = null) => ({ activity, pagination: { hasMore: nextCursor !== null, nextCursor }, fetchedAt: new Date(START).toISOString() });
function memoryStore() {
  const states = new Map(), snapshots = new Map(), counts = new Map();
  const batches = [];
  return { states, snapshots, counts, batches, prunes: 0,
    getState: address => states.has(address) ? clone(states.get(address)) : null,
    getSnapshot: address => snapshots.has(address) ? clone(snapshots.get(address)) : null,
    saveState: (address, state) => states.set(address, clone(state)),
    saveSnapshot: (address, payload) => { snapshots.set(address, clone(payload)); return true; },
    ingestActivityGroups(address, rows) {
      batches.push(clone(rows));
      const batch = new Map();
      for (const row of rows) { const key = `${address}:${row.timestamp}:${row.contentKey}`; batch.set(key, (batch.get(key) || 0) + 1); }
      for (const [key, count] of batch) counts.set(key, Math.max(counts.get(key) || 0, count));
      return { inserted: rows.length };
    },
    prune() { this.prunes++; },
  };
}
function fixture(overrides = {}) {
  let time = START;
  const calls = [];
  const store = memoryStore();
  const client = {
    async wallet(address, range) { calls.push(['wallet', address, range]); return { address, fetchedAt: new Date(time).toISOString() }; },
    async activity(address, cursor) { calls.push(['activity', address, cursor]); return page([event(Math.floor(time / 1000) - 10)]); },
    ...overrides,
  };
  return { store, client, calls, now: () => time, advance: amount => { time += amount; } };
}

test('snapshot and activity schedules are independent and no task overlaps itself', async () => {
  let release;
  let walletCalls = 0;
  const f = fixture({ wallet: async () => { walletCalls++; return new Promise(resolve => { release = resolve; }); } });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  const first = monitor.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.status().wallets[0].snapshotRunning, true);
  assert.equal(f.store.counts.size, 1, 'activity is persisted while the snapshot is still waiting');
  f.advance(5000);
  await monitor.tick();
  assert.equal(walletCalls, 1, 'a slow snapshot must not be requested twice');
  assert.equal(f.calls.filter(row => row[0] === 'activity').length, 2);
  release({ address: ADDRESS });
  await first;
  assert.equal(f.store.snapshots.has(ADDRESS), true);
  await monitor.stop();
});

test('an unfinished same-timestamp bucket survives restart and preserves identical cross-page fills', async () => {
  const t = START / 1000 - 10;
  const activity = async (_address, cursor) => cursor === 'page2'
    ? page([event(t, 'same', 'third'), event(t - 1, 'older')])
    : page([event(t, 'same', 'first'), event(t, 'same', 'second')], 'page2');
  const f = fixture({ activity });
  const first = createMonitor({ ...f, addresses: [ADDRESS], maxPagesPerTick: 1, headPagesPerTick: 1, backfillPagesPerTick: 1 });
  await first.tick();
  assert.equal(f.store.counts.size, 0, 'the tail bucket is not yet known complete');
  assert.equal(f.store.states.get(ADDRESS).backfill.carry.length, 2);
  assert.equal(first.status().wallets[0].backfill.complete, false);
  await first.stop();
  f.advance(5000);
  const resumed = createMonitor({ ...f, addresses: [ADDRESS], maxPagesPerTick: 3 });
  await resumed.tick();
  assert.equal(f.store.counts.get(`${ADDRESS}:${t}:same`), 3, 'all three identical fills survive, with no double insertion from overlapping scans');
  assert.equal(resumed.status().wallets[0].backfill.complete, true);
  assert.equal(resumed.status().wallets[0].backfill.pendingRows, 0);
  await resumed.stop();
});

test('history page budget remains partial and advances across ticks while newest page is refreshed', async () => {
  const cursorCalls = [];
  const f = fixture({ activity: async (_address, cursor) => {
    cursorCalls.push(cursor);
    const index = cursor ? Number(cursor.slice(1)) : 0;
    return page([event(START / 1000 - 10 - index, `fill-${index}`)], `p${index + 1}`);
  } });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS], maxPagesPerTick: 3 });
  await monitor.tick();
  assert.equal(cursorCalls.length <= 3, true);
  const firstPages = monitor.status().wallets[0].backfill.pages;
  assert.equal(monitor.status().wallets[0].backfill.complete, false);
  f.advance(5000);
  await monitor.tick();
  assert.equal(cursorCalls.filter(cursor => cursor === null).length, 2, 'fresh heads remain visible while the historical walk is active');
  assert.equal(monitor.status().wallets[0].backfill.pages > firstPages, true, 'history is not starved by the head catch-up');
  assert.equal(cursorCalls.length <= 6, true);
  await monitor.stop();
});

test('30-day boundary stops history without storing older records or claiming chain-level completeness', async () => {
  const cutoff = START / 1000 - 30 * 86400;
  const f = fixture({ activity: async () => page([event(cutoff + 2, 'recent'), event(cutoff - 1, 'expired')], 'more-older') });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  await monitor.tick();
  const status = monitor.status();
  assert.equal(status.wallets[0].backfill.complete, true);
  assert.equal(status.wallets[0].backfill.exhausted, false);
  assert.equal(f.store.batches.flat().some(row => row.timestamp < cutoff), false);
  assert.match(status.coverageClaim, /不是链上逐笔审计/);
  assert.equal(status.retentionDays, 30);
  await monitor.stop();
});

test('unknown timestamps never enter history and prevent an unqualified complete claim', async () => {
  const f = fixture({ activity: async () => page([event(null), event(START / 1000 - 1, 'known')]) });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  await monitor.tick();
  assert.equal(f.store.batches.flat().every(row => Number.isInteger(row.timestamp)), true);
  assert.equal(monitor.status().wallets[0].backfill.complete, false);
  assert.match(monitor.status().wallets[0].backfill.gap, /未知时间戳/);
  await monitor.stop();
});

test('a repeated upstream cursor is explicit, blocked, and cannot inflate a partial bucket', async () => {
  const t = START / 1000 - 10;
  const f = fixture({ activity: async () => page([event(t, 'same')], 'repeat') });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS], maxPagesPerTick: 5 });
  await monitor.tick();
  const state = monitor.status().wallets[0];
  assert.equal(state.head.blocked, true);
  assert.equal(state.head.complete, false);
  assert.match(state.activityError, /重复游标/);
  assert.equal(f.store.counts.size, 0);
  await monitor.stop();
});

test('a known gap in a later head refresh remains visible after historical traversal completed', async () => {
  let unknown = false;
  const f = fixture({ activity: async () => page([
    ...(unknown ? [event(null)] : []), event(START / 1000 - 1, 'known'),
  ]) });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  await monitor.tick();
  assert.equal(monitor.status().wallets[0].backfill.complete, true);
  assert.equal(monitor.status().wallets[0].coverage.currentGap, null);
  unknown = true;
  f.advance(5000);
  await monitor.tick();
  const status = monitor.status().wallets[0];
  assert.equal(status.activityError, null, 'an HTTP success can still have incomplete record coverage');
  assert.equal(status.head.blocked, false);
  assert.equal(status.backfill.complete, true);
  assert.equal(status.coverage.complete, false);
  assert.match(status.coverage.currentGap, /未知时间戳/);
  unknown = false;
  f.advance(5000);
  await monitor.tick();
  assert.equal(monitor.status().wallets[0].coverage.complete, false, 'a later clean page cannot repair the known earlier omission');
  assert.match(monitor.status().wallets[0].coverage.currentGap, /未知时间戳/);
  await monitor.stop();
});

test('out-of-order pages and oversized carry buckets fail safely without writing fabricated complete data', async () => {
  const t = START / 1000;
  for (const [activity, options, expected] of [
    [async () => page([event(t - 2), event(t - 1)]), {}, /时间顺序异常/],
    [async () => page([event(t), event(t), event(t)], 'next'), { maxCarryRows: 2 }, /安全上限/],
  ]) {
    const f = fixture({ activity });
    const monitor = createMonitor({ ...f, ...options, addresses: [ADDRESS] });
    await monitor.tick();
    assert.match(monitor.status().wallets[0].activityError, expected);
    assert.equal(f.store.counts.size, 0);
    assert.equal(monitor.status().wallets[0].backfill.complete, false);
    await monitor.stop();
  }
});

test('network errors back off activity without cancelling a successful snapshot and resume checkpoints', async () => {
  let fail = true, requests = 0;
  const f = fixture({ activity: async () => { requests++; if (fail) throw new Error('upstream offline'); return page([event(START / 1000 - 10)]); } });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  await monitor.tick();
  assert.equal(f.store.snapshots.has(ADDRESS), true);
  assert.equal(monitor.status().wallets[0].activityError, 'upstream offline');
  assert.equal(monitor.status().wallets[0].coverage.complete, false);
  assert.match(monitor.status().wallets[0].coverage.currentGap, /最新覆盖边界待恢复/);
  f.advance(5000);
  await monitor.tick();
  assert.equal(requests, 1);
  fail = false;
  f.advance(5000);
  await monitor.tick();
  assert.equal(requests, 2);
  assert.equal(monitor.status().wallets[0].activityError, null);
  assert.equal(monitor.status().wallets[0].backfill.complete, true);
  await monitor.stop();
});

test('repeated scans retain max multiplicity when more identical fills arrive at an existing timestamp', async () => {
  let count = 2;
  const t = START / 1000 - 10;
  const f = fixture({ activity: async () => page(Array.from({ length: count }, (_, index) => event(t, 'same', String(index)))) });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  await monitor.tick();
  assert.equal(f.store.counts.get(`${ADDRESS}:${t}:same`), 2);
  count = 3;
  f.advance(5000);
  await monitor.tick();
  assert.equal(f.store.counts.get(`${ADDRESS}:${t}:same`), 3);
  f.advance(5000);
  await monitor.tick();
  assert.equal(f.store.counts.get(`${ADDRESS}:${t}:same`), 3);
  await monitor.stop();
});

test('stop waits for ongoing work; start is idempotent and empty monitor remains disabled', async () => {
  const empty = createMonitor({ ...fixture(), addresses: [] });
  empty.start();
  assert.equal(empty.status().enabled, false);
  await empty.stop();
  let release;
  let calls = 0;
  const f = fixture({ activity: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  monitor.start(); monitor.start();
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release(page([]));
  await stopping;
  assert.equal(calls, 1);
  assert.equal(monitor.status().enabled, false);
  await monitor.tick();
  assert.equal(calls, 1);
});

test('collector checkpoints and closed duplicate buckets integrate with the actual SQLite store', async () => {
  const now = () => START;
  const store = createStore({ path: ':memory:', now, retentionDays: 30 });
  const t = START / 1000 - 10;
  const client = {
    async wallet(address) { return { address, source: 'live', fetchedAt: new Date(START).toISOString(), summary: {}, history: [], activity: [] }; },
    async activity(_address, cursor) { return cursor === 'tail' ? page([event(t), event(t - 1, 'older')]) : page([event(t), event(t)], 'tail'); },
  };
  const first = createMonitor({ client, store, addresses: [ADDRESS], now, maxPagesPerTick: 1, headPagesPerTick: 1, backfillPagesPerTick: 1 });
  try {
    await first.tick();
    assert.equal(store.readActivities(ADDRESS).activity.length, 0);
    assert.equal(store.getState(ADDRESS).backfill.carry.length, 2);
    assert.equal(first.status().wallets[0].snapshotError, null);
    await first.stop();
    const resumed = createMonitor({ client, store, addresses: [ADDRESS], now });
    await resumed.tick();
    const rows = store.readActivities(ADDRESS).activity;
    assert.equal(rows.filter(row => row.timestamp === t).length, 3);
    assert.equal(new Set(rows.map(row => row.id)).size, 4);
    assert.equal(resumed.status().wallets[0].backfill.complete, true);
    await resumed.stop();
    await first.stop();
    assert.equal(store.getState(ADDRESS).backfill.complete, true, 'repeated stop on an old instance cannot overwrite a newer checkpoint');
  } finally { await first.stop(); store.close(); }
});

function completeSnapshot(at = START) {
  const sec = Math.floor(at / 1000), conditionId = `0x${'b'.repeat(64)}`;
  const periods = Object.fromEntries([['1d', 1], ['1w', 7], ['1m', 30]].map(([range, days]) => [range,
    { range, start: sec - days * 86400, end: sec, totalPnl: 10, realizedPnl: 8, unrealizedPnl: 2, complete: true, stale: false, observedAt: sec, sourceFidelity: '1d', reason: null }]));
  return { address: ADDRESS, source: 'live', fetchedAt: new Date(at).toISOString(), range: '1m',
    summary: { totalPnl: 10, realizedPnl: 8, unrealizedPnl: 2, positionValue: 30, observedAt: sec, volume: 100 },
    periods, period: periods['1m'], historyAll: [{ timestamp: sec - 86400, totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0 }, { timestamp: sec, totalPnl: 10, realizedPnl: 8, unrealizedPnl: 2 }],
    history: [{ timestamp: sec, totalPnl: 10, realizedPnl: 8, unrealizedPnl: 2 }], historySourceFidelity: '1d',
    positions: [{ id: 'held', conditionId, title: 'BTC', outcome: 'Up', timestamp: sec, status: 'OPEN', totalPnl: 10, realizedPnl: 8, unrealizedPnl: 2, currentValue: 30, slug: 'btc-updown-5m-1800000000' }],
    closedPositions: [], windows: [], activity: [], activityPagination: { hasMore: false, nextCursor: null }, activityFetchedAt: new Date(at).toISOString(), warnings: [],
    coverage: { positions: { complete: true, count: 1, fetchedAt: new Date(at).toISOString() }, closedPositions: { complete: true, count: 0, fetchedAt: new Date(at).toISOString() } },
    sections: { stats: 'ok', value: 'ok', history: 'ok', positions: 'ok', closedPositions: 'ok', activity: 'ok' } };
}

test('partial snapshot retains good stats/books/history through a real database restart without marking old sections fresh', async () => {
  const tempRoot = resolve(process.env.POLYWATCH_TEST_TMP || process.env.TMPDIR || tmpdir());
  const root = join(tempRoot, 'polywatch-monitor-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'partial-'));
  const filename = join(directory, 'monitor.sqlite');
  let time = START, partial = false, monitor;
  let store = createStore({ path: filename, now: () => time });
  const original = completeSnapshot();
  const client = { async activity() { return page([]); }, async wallet() {
    if (!partial) return clone(original);
    const next = completeSnapshot(time);
    return { ...next, summary: { totalPnl: null, realizedPnl: null, unrealizedPnl: null, positionValue: 99, observedAt: null },
      positions: [], closedPositions: [{ ...original.positions[0], id: 'down', outcome: 'Down', status: 'CLOSED', timestamp: time / 1000, totalPnl: -3, realizedPnl: -3, unrealizedPnl: 0, currentValue: 0 }],
      history: [], historyAll: [], periods: {}, period: null,
      sections: { ...next.sections, stats: 'error', positions: 'error', history: 'error' } };
  } };
  try {
    monitor = createMonitor({ client, store, addresses: [ADDRESS], now: () => time });
    await monitor.tick(); await monitor.stop(); store.close();
    time += 60000; partial = true;
    store = createStore({ path: filename, now: () => time });
    monitor = createMonitor({ client, store, addresses: [ADDRESS], now: () => time });
    await monitor.tick();
    assert.match(monitor.status().wallets[0].snapshotError, /部分接口异常/);
    await monitor.stop(); store.close();
    store = createStore({ path: filename, now: () => time });
    const saved = store.getSnapshot(ADDRESS, '1d');
    assert.equal(saved.summary.totalPnl, 10);
    assert.equal(saved.summary.positionValue, 99, 'successful value section stays fresh independently');
    assert.equal(saved.summary.observedAt, START / 1000);
    assert.equal(saved.positions[0].id, 'held');
    assert.equal(saved.closedPositions[0].id, 'down');
    assert.equal(saved.windows[0].totalPnl, 7);
    assert.equal(saved.windows[0].complete, false);
    assert.equal(saved.coverage.positions.complete, false);
    assert.equal(saved.coverage.positions.fetchedAt, original.fetchedAt);
    assert.equal(saved.sectionFetchedAt.stats, original.fetchedAt);
    assert.equal(saved.sectionFetchedAt.positions, original.fetchedAt);
    assert.equal(saved.sectionFetchedAt.history, original.fetchedAt);
    assert.equal(saved.sections.stats, 'error');
    assert.equal(saved.sections.positions, 'error');
    assert.equal(saved.sections.history, 'error');
    assert.equal(saved.period.end, original.periods['1d'].end);
    assert.equal(saved.period.totalPnl, 10);
    assert.equal(saved.period.stale, true);
    assert.equal(saved.period.complete, false);
    assert.equal(saved.historyAll.length, 2);
    assert.equal(saved.fetchedAt, new Date(time).toISOString(), 'assembly time may advance but per-section timestamps do not');
  } finally {
    await monitor?.stop(); store.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), root, 'test cleanup must target its own temporary directory');
    assert.ok(basename(absolute).startsWith('partial-'), 'test cleanup must target the mkdtemp result');
    rmSync(absolute, { recursive: true, force: true });
  }
});

test('value and history failures retain their own prior sources even when stats succeed', () => {
  const previous = completeSnapshot();
  const next = completeSnapshot(START + 60000);
  next.summary = { ...next.summary, totalPnl: 42, positionValue: null };
  next.sections.value = 'error'; next.sections.history = 'error';
  const merged = mergeCollectedSnapshot(next, previous);
  assert.equal(merged.summary.totalPnl, 42);
  assert.equal(merged.summary.positionValue, 30);
  assert.equal(merged.summary.observedAt, (START + 60000) / 1000);
  assert.equal(merged.period.observedAt, START / 1000);
  assert.equal(merged.period.end, previous.period.end);
  assert.equal(merged.period.stale, true);
  assert.equal(merged.historySourceFidelity, '1d');
  assert.equal(merged.sectionFetchedAt.value, previous.fetchedAt);
  assert.equal(merged.sectionFetchedAt.stats, next.fetchedAt);
  assert.equal(next.summary.positionValue, null, 'merging does not mutate the received payload');
});

test('first partial snapshot stays explicitly partial; failed activity does not fabricate a complete snapshot ledger', async () => {
  const received = completeSnapshot();
  received.sections.stats = 'error'; received.sections.positions = 'error'; received.sections.activity = 'error';
  received.summary.totalPnl = null; received.positions = []; received.activity = [event(START / 1000)];
  const f = fixture({ wallet: async () => received });
  const monitor = createMonitor({ ...f, addresses: [ADDRESS] });
  await monitor.tick();
  const saved = f.store.snapshots.get(ADDRESS);
  assert.equal(saved.summary.totalPnl, null);
  assert.equal(saved.sectionFetchedAt.stats, null);
  assert.equal(saved.coverage.positions.complete, false);
  assert.deepEqual(saved.activity, []);
  assert.equal(saved.sections.activity, 'error');
  assert.match(monitor.status().wallets[0].snapshotError, /部分接口异常/);
  await monitor.stop();
});
