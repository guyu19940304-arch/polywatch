import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, StoreError } from '../server/store.mjs';

const TEMP_ROOT = resolve(process.env.POLYWATCH_TEST_TMP || process.env.TMPDIR || tmpdir());
const ROOT = join(TEMP_ROOT, 'polywatch-store-tests');
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const DAY = 86400;
const NOW = Date.parse('2026-11-03T08:00:00.000Z');
const SEC = NOW / 1000;
const CUTOFF = SEC - 30 * DAY;
const point = (timestamp, totalPnl = 10) => ({ timestamp, totalPnl, realizedPnl: totalPnl - 2, unrealizedPnl: 2 });
const position = (id, timestamp, status = 'CLOSED') => ({ id, conditionId: `condition-${id}`, timestamp, status, outcome: 'Up', totalPnl: 3, realizedPnl: 3, unrealizedPnl: 0 });
const activity = (timestamp, contentKey = 'fill') => ({ id: 'upstream-page-id', contentKey, timestamp, type: 'TRADE', side: 'BUY', price: 0.5, size: 10, amount: 5, transactionHash: '0xabc', title: 'BTC', outcome: 'Up' });
function snapshot(overrides = {}) {
  const periods = Object.fromEntries([['1d', 1], ['1w', 7], ['1m', 30]].map(([range, days]) => [range, { range, start: SEC - days * DAY - 100, end: SEC - 100,
    totalPnl: days * 10, realizedPnl: days * 10, unrealizedPnl: 0, complete: true, observedAt: SEC - 100, stale: false, reason: null, sourceFidelity: '1d' }]));
  return { address: A, source: 'live', range: '1m', fetchedAt: new Date(NOW - 1000).toISOString(), activityFetchedAt: new Date(NOW - 2000).toISOString(),
    summary: { ...point(SEC), observedAt: SEC - 100, positionValue: 15 }, periods, period: periods['1m'],
    positions: [position('open', CUTOFF - DAY, 'OPEN'), position('redeemable', null, 'REDEEMABLE')],
    closedPositions: [position('old', CUTOFF - 1), position('edge', CUTOFF), position('recent', SEC - 200), position('unknown', null)],
    windows: [{ ...position('old', CUTOFF - 1), complete: true }, { ...position('recent', SEC - 200), complete: true }, { ...position('unknown', null), complete: true }],
    activity: [activity(CUTOFF - 1, 'expired'), activity(CUTOFF, 'edge'), activity(SEC - 200, 'recent'), activity(null, 'unknown')],
    activityPagination: { hasMore: false, nextCursor: null },
    history: [point(CUTOFF - 100), point(CUTOFF), point(SEC - 7 * DAY), point(SEC - DAY), point(SEC - 100)],
    historySourceFidelity: '1d', warnings: [],
    coverage: { positions: { complete: true, count: 2, fetchedAt: new Date(NOW - 1000).toISOString() }, closedPositions: { complete: true, count: 4, fetchedAt: new Date(NOW - 1000).toISOString() } },
    sections: { stats: 'ok', history: 'ok', value: 'ok', positions: 'ok', closedPositions: 'ok', activity: 'ok' }, ...overrides };
}
function setup(t, options = {}) {
  mkdirSync(ROOT, { recursive: true });
  const directory = mkdtempSync(join(ROOT, 'case-'));
  const filename = join(directory, 'monitor.sqlite');
  let ms = NOW;
  let store = createStore({ path: filename, now: () => ms, ...options });
  t.after(() => {
    store.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), ROOT, 'test cleanup must target its own temporary directory');
    assert.ok(basename(absolute).startsWith('case-'), 'test cleanup must target the mkdtemp result');
    rmSync(absolute, { recursive: true, force: true });
  });
  return { get store() { return store; }, filename, setNow: value => { ms = value; }, reopen: () => { store.close(); store = createStore({ path: filename, now: () => ms, ...options }); return store; } };
}

test('latest snapshot and points survive restart; range changes preserve official summaries and original freshness', t => {
  const context = setup(t); const input = snapshot();
  assert.equal(context.store.saveSnapshot(A, input), true);
  const db = context.reopen();
  const result = db.getSnapshot(A, '1d');
  assert.equal(result.range, '1d');
  assert.equal(result.period.totalPnl, 10);
  assert.equal(result.fetchedAt, input.fetchedAt);
  assert.equal(result.activityFetchedAt, input.activityFetchedAt);
  assert.equal(result.persisted, true);
  assert.deepEqual(result.historyAll.map(row => row.timestamp), [CUTOFF, SEC - 7 * DAY, SEC - DAY, SEC - 100]);
  assert.deepEqual(result.history.map(row => row.timestamp), [SEC - DAY, SEC - 100]);
  const month = db.getSnapshot(A, '1m');
  assert.equal(month.period.start, CUTOFF - 100, 'official summary may reference a boundary no longer retained as a raw point');
  assert.equal(month.period.totalPnl, 300);
  assert.equal(month.period.complete, true);
  assert.ok(month.historyAll.every(row => row.timestamp >= CUTOFF));
  assert.equal(db.getSnapshot(B), null);
  assert.deepEqual(input.history.map(row => row.timestamp), [CUTOFF - 100, CUTOFF, SEC - 7 * DAY, SEC - DAY, SEC - 100], 'caller payload is never mutated');
});

test('retention trims all historical arrays including unknown timestamps but keeps current holdings', t => {
  const { store } = setup(t); store.saveSnapshot(A, snapshot());
  const result = store.getSnapshot(A, 'all');
  assert.deepEqual(result.positions.map(row => row.id), ['open', 'redeemable']);
  assert.deepEqual(result.closedPositions.map(row => row.id), ['edge', 'recent']);
  assert.deepEqual(result.windows.map(row => row.id), ['recent']);
  assert.deepEqual(result.activity.map(row => row.contentKey), ['edge', 'recent']);
  assert.equal(result.coverage.closedPositions.complete, false);
  assert.equal(result.coverage.closedPositions.count, 2);
  assert.equal(result.retention.closedPositionsTrimmed, true);
  assert.equal(result.retention.days, 30);
  assert.equal(result.period.totalPnl, 10, 'full-history aggregate is not rebuilt from the retained subset');
  assert.equal(result.period.start, null);
});

test('closed timestamp buckets retain identical fills with max multiplicity and stable IDs across rescans/restarts', t => {
  const context = setup(t); const fill = activity(SEC - 10);
  let result = context.store.ingestActivityGroups(A, [fill, fill]);
  assert.equal(result.inserted, 2);
  const initial = context.store.readActivities(A).activity;
  assert.equal(new Set(initial.map(row => row.id)).size, 2);
  result = context.store.ingestActivityGroups(A, [{ ...fill, id: 'different-page' }]);
  assert.equal(result.inserted, 0);
  assert.equal(context.store.readActivities(A).activity.length, 2, 'smaller repeated batch cannot erase a previously observed duplicate');
  context.store.ingestActivityGroups(A, [fill, fill, fill]);
  assert.equal(context.store.readActivities(A).activity.length, 3);
  const reopened = context.reopen();
  assert.ok(initial.every(row => reopened.readActivities(A).activity.some(next => next.id === row.id)));
  reopened.ingestActivityGroups(B, [fill]);
  assert.notEqual(reopened.readActivities(B).activity[0].id, initial[0].id);
});

test('signed local keyset pagination survives restart and new head arrivals without repeating rows', t => {
  const context = setup(t);
  context.store.ingestActivityGroups(A, [activity(SEC - 10, 'a'), activity(SEC - 10, 'b'), activity(SEC - 11, 'c'), activity(SEC - 12, 'd')]);
  const first = context.store.readActivities(A, null, 2);
  assert.equal(first.activity.length, 2); assert.equal(first.pagination.hasMore, true);
  assert.match(first.pagination.nextCursor, /^local:/);
  context.store.ingestActivityGroups(A, [activity(SEC, 'new')]);
  const next = context.reopen().readActivities(A, first.pagination.nextCursor, 2);
  assert.deepEqual(next.activity.map(row => row.contentKey), ['c', 'd']);
  assert.equal(next.pagination.hasMore, false);
  assert.equal(next.pagination.nextCursor, null);
  assert.equal(new Set([...first.activity, ...next.activity].map(row => row.id)).size, 4);
});

test('invalid, tampered, upstream, cross-wallet and wrong-limit cursors are rejected', t => {
  const { store } = setup(t);
  store.ingestActivityGroups(A, [activity(SEC - 1, 'a'), activity(SEC - 2, 'b')]);
  const cursor = store.readActivities(A, null, 1).pagination.nextCursor;
  for (const bad of ['', 'upstream-cursor', 'local:bad', cursor.slice(0, -8) + 'abcdefgh', 'local:' + 'x'.repeat(3000)]) assert.throws(() => store.readActivities(A, bad, 1), error => error instanceof StoreError && error.status === 400);
  assert.throws(() => store.readActivities(B, cursor, 1), /当前钱包/);
  assert.throws(() => store.readActivities(A, cursor, 2), /当前钱包/);
  assert.throws(() => store.readActivities(A, null, 0), /每页数量/);
  assert.throws(() => store.readActivities('0x123'), /钱包地址/);
});

test('rolling cutoff is inclusive, reads hide expired data before prune, and prune removes JSON and carry residue', t => {
  const context = setup(t); const store = context.store; const input = snapshot();
  store.saveSnapshot(A, input);
  const ingest = store.ingestActivityGroups(A, [activity(CUTOFF - 1, 'old'), activity(CUTOFF, 'edge'), activity(null, 'unknown'), activity(SEC, 'fresh')]);
  assert.equal(ingest.ignored, 2); assert.equal(ingest.inserted, 2);
  store.saveState(A, { version: 1, head: { cursor: 'upstream', carry: [activity(CUTOFF, 'edge'), activity(null), activity(SEC, 'fresh')], completedThrough: SEC }, backfill: { cursor: 'older', carry: [activity(CUTOFF - 1)] }, coverage: { gaps: ['known gap'] } });
  assert.equal(store.readActivities(A).activity.length, 2);
  context.setNow(NOW + 1000);
  assert.equal(store.readActivities(A).activity.length, 1);
  assert.equal(store.getSnapshot(A).closedPositions.some(row => row.id === 'edge'), false);
  assert.deepEqual(store.getState(A).head.carry.map(row => row.contentKey), ['fresh']);
  const result = store.prune();
  assert.equal(result.activities, 1); assert.equal(result.points, 1);
  assert.equal(store.stats().activities, 1);
  assert.equal(store.getSnapshot(A).fetchedAt, input.fetchedAt);
  assert.equal(store.readActivities(A).fetchedAt, new Date(NOW).toISOString(), 'read/prune must not pretend to be a successful poll');
  const raw = new DatabaseSync(context.filename, { readOnly: true });
  try {
    const saved = JSON.parse(raw.prepare('SELECT payload FROM snapshots WHERE address=?').get(A).payload);
    const state = JSON.parse(raw.prepare('SELECT payload FROM collector_states WHERE address=?').get(A).payload);
    assert.ok(saved.closedPositions.every(row => row.timestamp >= CUTOFF + 1));
    assert.equal(saved.history.length, 0, 'large raw history lives only in the indexed points table');
    assert.deepEqual(state.head.carry.map(row => row.contentKey), ['fresh']);
    assert.deepEqual(state.backfill.carry, []);
    assert.equal(state.head.cursor, 'upstream');
    assert.deepEqual(state.coverage.gaps, ['known gap']);
  } finally { raw.close(); }
});

test('read after long offline interval retains last-known balances but reports stale periods and no expired history', t => {
  const context = setup(t); const input = snapshot(); context.store.saveSnapshot(A, input);
  context.setNow(NOW + 31 * DAY * 1000);
  const result = context.store.getSnapshot(A, '1m');
  assert.equal(result.fetchedAt, input.fetchedAt);
  assert.equal(result.period.end, input.period.end);
  assert.equal(result.period.totalPnl, input.period.totalPnl);
  assert.equal(result.period.stale, true);
  assert.deepEqual(result.historyAll, []);
  assert.deepEqual(result.closedPositions, []);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.activity, []);
  assert.equal(result.positions.length, 2);
});

test('points upsert once per timestamp, older snapshots cannot overwrite newer state, and malformed writes fail', t => {
  const { store } = setup(t); const input = snapshot();
  store.saveSnapshot(A, input); const count = store.stats().pnlPoints;
  store.saveSnapshot(A, { ...input, fetchedAt: new Date(NOW).toISOString(), history: [point(SEC - 100, 99)] });
  assert.equal(store.stats().pnlPoints, count);
  assert.equal(store.getSnapshot(A).historyAll.at(-1).totalPnl, 99);
  assert.equal(store.saveSnapshot(A, input), false);
  assert.equal(store.getSnapshot(A).historyAll.at(-1).totalPnl, 99);
  assert.throws(() => store.saveSnapshot(A, { ...input, source: 'demo' }), /真实数据/);
  assert.throws(() => store.saveSnapshot(A, { ...input, address: B }), /真实数据/);
  assert.throws(() => store.saveSnapshot(A, { ...input, fetchedAt: null }), /fetchedAt/);
  assert.throws(() => store.getSnapshot(A, '2d'), /统计周期/);
  assert.throws(() => createStore({ path: ':memory:', retentionDays: 31 }), /30/);
});

test('activity batches commit atomically and failed writes do not advance freshness', t => {
  const context = setup(t); const { store } = context;
  store.ingestActivityGroups(A, [activity(SEC - 10, 'before')]);
  const previous = store.readActivities(A);
  context.setNow(NOW + 5000);
  const cyclic = activity(SEC - 5, 'cyclic'); cyclic.self = cyclic;
  assert.throws(() => store.ingestActivityGroups(A, [activity(SEC - 5, 'would-insert'), cyclic]), /circular/i);
  const after = store.readActivities(A);
  assert.deepEqual(after.activity, previous.activity);
  assert.equal(after.fetchedAt, previous.fetchedAt);
  store.ingestActivityGroups(A, []);
  assert.equal(store.readActivities(A).fetchedAt, new Date(NOW + 5000).toISOString(), 'explicit successful empty collection can record a real check');
});

test('null PnL stays unavailable, shorter retention works, and unconfirmed non-current rows cannot survive forever', t => {
  const { store } = setup(t, { retentionDays: 7 });
  const input = snapshot({ positions: [position('unconfirmed-old', CUTOFF - 1, ''), position('held', null, 'OPEN')], history: [point(SEC - 8 * DAY), { ...point(SEC - 100), totalPnl: null, unrealizedPnl: null }] });
  store.saveSnapshot(A, input);
  const result = store.getSnapshot(A);
  assert.equal(result.retention.days, 7);
  assert.deepEqual(result.positions.map(row => row.id), ['held']);
  assert.equal(result.coverage.positions.complete, false);
  assert.equal(result.historyAll.length, 1);
  assert.equal(result.historyAll[0].totalPnl, null);
  assert.equal(result.historyAll[0].unrealizedPnl, null);
});
