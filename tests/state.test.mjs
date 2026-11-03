import test from 'node:test';
import assert from 'node:assert/strict';
import { activityHealth, activityResponseState, appendActivityPage, decodeWallets, dueWallets, mergeActivityResponse, mergeActivityRows, mergeWalletRefresh, needsRangeFetch, normalizeMonitor, projectWalletRange, walletPollInterval, walletSettings, walletsFromMonitor } from '../src/useWallets.ts';
import { getDemoData, DEMO_WALLETS } from '../src/demo.ts';

test('saved wallet decoding removes invalid and case-insensitive duplicate addresses', () => {
  const wallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const result = decodeWallets(JSON.stringify([
    { address: wallet, label: ' My wallet ' },
    { address: `0x${wallet.slice(2).toUpperCase()}`, label: 'Duplicate' },
    { address: 'https://untrusted.example/' },
    null,
  ]));
  assert.equal(result.length, 1);
  assert.equal(result[0].address, wallet);
  assert.equal(result[0].label, 'My wallet');
});

test('empty saved wallets are respected and damaged settings are not silently accepted', () => {
  assert.deepEqual(decodeWallets('[]'), []);
  for (const value of ['null', '{}', 'oops', '[{"address":"bad"}]']) {
    assert.throws(() => decodeWallets(value));
  }
});

test('wallet persistence applies the ten-wallet limit and safe labels', () => {
  const result = decodeWallets(JSON.stringify(Array.from({ length: 12 }, (_, index) => ({
    address: `0x${index.toString(16).padStart(40, '0')}`, label: 'a'.repeat(100), color: 'url(untrusted)',
  }))));
  assert.equal(result.length, 10);
  assert.equal(result[0].label.length, 32);
  assert.ok(result.every(wallet => /^#[0-9a-f]{6}$/.test(wallet.color)));
});

test('a clean browser starts in demo while an explicitly saved empty list is a preserved choice', () => {
  const clean = walletSettings(null);
  const explicitDemo = walletSettings('[]');
  assert.deepEqual(clean.wallets, []);
  assert.equal(clean.hasSavedSettings, false);
  assert.deepEqual(explicitDemo.wallets, []);
  assert.equal(explicitDemo.hasSavedSettings, true);
});

test('only an enabled available monitor can initialize an unsaved wallet list', () => {
  const address = `0x${'12'.repeat(20)}`;
  const monitor = normalizeMonitor({ enabled: true, addresses: [address] });
  const wallets = walletsFromMonitor(monitor, false, []);
  assert.equal(wallets[0].address, address);
  assert.equal(wallets[0].label, '监控钱包 1');
  assert.equal(walletsFromMonitor({ ...monitor, enabled: false }, false, []), null);
  assert.equal(walletsFromMonitor({ ...monitor, available: false }, false, []), null);
  assert.equal(walletsFromMonitor({ ...monitor, addresses: [] }, false, []), null);
});

test('monitor responses preserve explicit demo, custom settings and changes made while loading', () => {
  const monitor = normalizeMonitor({ enabled: true, addresses: [`0x${'12'.repeat(20)}`] });
  const custom = walletSettings(JSON.stringify([{ address: `0x${'34'.repeat(20)}`, label: 'Custom' }]));
  assert.equal(walletsFromMonitor(monitor, true, []), null, 'explicit [] must stay in demo');
  assert.equal(walletsFromMonitor(monitor, custom.hasSavedSettings, custom.wallets), null);
  assert.equal(walletsFromMonitor(monitor, false, custom.wallets), null, 'an in-flight response cannot replace a current nonempty choice');
  const first = walletsFromMonitor(monitor, false, []);
  const saved = walletSettings(JSON.stringify(first));
  const changedMonitor = { ...monitor, addresses: [`0x${'56'.repeat(20)}`] };
  assert.equal(walletsFromMonitor(changedMonitor, saved.hasSavedSettings, saved.wallets), null, 'periodic status updates must not reinitialize the list');
});

test('monitor initialization respects the same ten-wallet cap as manual configuration', () => {
  const addresses = Array.from({ length: 12 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
  const monitor = normalizeMonitor({ enabled: true, addresses });
  const wallets = walletsFromMonitor(monitor, false, []);
  assert.equal(wallets.length, 10);
  assert.equal(wallets[9].label, '监控钱包 10');
});

test('demo data stays explicitly marked and its holdings and totals reconcile', () => {
  const data = getDemoData('1m');
  let total = 0;
  for (const wallet of DEMO_WALLETS) {
    const value = data[wallet.address];
    assert.equal(value.source, 'demo');
    assert.equal(value.summary.source, 'demo');
    assert.ok(Math.abs(value.summary.totalPnl - value.summary.realizedPnl - value.summary.unrealizedPnl) < 0.001);
    assert.ok(Math.abs(value.positions.reduce((sum, position) => sum + position.currentValue, 0) - value.summary.positionValue) < 0.001);
    assert.ok(Math.abs(value.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0) - value.summary.unrealizedPnl) < 0.001);
    total += value.summary.totalPnl;
  }
  assert.equal(Math.round(total * 100), 2458062);
});

test('demo selected-period gains follow the same boundary-difference rule as live data', () => {
  for (const range of ['1d', '1w', '1m', 'all']) {
    for (const data of Object.values(getDemoData(range))) {
      const first = data.history[0];
      const last = data.history.at(-1);
      assert.equal(first.timestamp, data.period.start);
      assert.equal(last.timestamp, data.period.end);
      assert.ok(Math.abs(last.totalPnl - first.totalPnl - data.period.totalPnl) < 0.025);
      assert.equal(data.period.complete, true);
    }
  }
});

const sample = getDemoData('1d')[DEMO_WALLETS[0].address];
function trade(contentKey, id, timestamp = 100) {
  return { ...sample.activity[0], contentKey, id, timestamp };
}
function walletPage(rows, nextCursor, hasMore = true) {
  return { ...sample, source: 'live', activity: rows, warnings: [], activityPagination: { hasMore, nextCursor } };
}

test('cursor append retains identical fills on adjacent pages', () => {
  const rows = appendActivityPage([trade('same-fill', 'same:0:head')], [trade('same-fill', 'same:0:cursor')]);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(row => row.id)).size, 2);
});

test('polling merges duplicate contents as a multiset rather than losing fills', () => {
  const previous = [trade('same', 'same:0:head'), trade('same', 'same:1:head'), trade('same', 'same:0:cursor')];
  const latest = [trade('new', 'new:0:head', 101), trade('same', 'same:0:head')];
  const merged = mergeActivityRows(previous, latest);
  assert.equal(merged.hasOverlap, true);
  assert.equal(merged.rows.filter(row => row.contentKey === 'same').length, 3);
  assert.equal(merged.rows.length, 4);
  assert.equal(new Set(merged.rows.map(row => row.id)).size, 4);
  const moreSame = [0, 1, 2, 3].map(index => trade('same', `same:${index}:head`));
  assert.equal(mergeActivityRows(previous, moreSame).rows.length, 4);
});

test('overlapping refresh retains loaded historical tail and its cursor', () => {
  const previous = walletPage([trade('shared', 'shared:0:head', 100), trade('old', 'old:0:cursor', 90)], 'tail-cursor');
  const latest = walletPage([trade('new', 'new:0:head', 110), trade('shared', 'shared:0:head', 100)], 'head-cursor');
  const merged = mergeWalletRefresh(latest, previous);
  assert.deepEqual(merged.activity.map(row => row.contentKey), ['new', 'shared', 'old']);
  assert.equal(merged.activityPagination.nextCursor, 'tail-cursor');
  assert.equal(merged.warnings.length, 0);
});

test('refresh with no overlap resets rows and cursor instead of hiding a high-frequency gap', () => {
  const previous = walletPage(Array.from({ length: 200 }, (_, i) => trade(`old-${i}`, `old-${i}:0:cursor`, 100 - i)), 'old-tail');
  const latest = walletPage(Array.from({ length: 100 }, (_, i) => trade(`new-${i}`, `new-${i}:0:head`, 400 - i)), 'new-head');
  const merged = mergeWalletRefresh(latest, previous);
  assert.deepEqual(merged.activity, latest.activity);
  assert.equal(merged.activityPagination.nextCursor, 'new-head');
  assert.ok(merged.warnings.some(warning => warning.includes('交易列表已重置')));
});

test('a complete fresh activity response replaces older rows and failed activity retains them', () => {
  const previous = walletPage([trade('shared', 'shared:0:head'), trade('removed', 'removed:0:cursor')], 'old-tail');
  const latest = walletPage([trade('shared', 'shared:0:head')], null, false);
  const complete = mergeWalletRefresh(latest, previous);
  assert.equal(complete.activity.length, 1);
  assert.equal(complete.activityPagination.hasMore, false);
  const failed = mergeWalletRefresh({ ...latest, activity: [], sections: { ...latest.sections, activity: 'error' } }, previous);
  assert.deepEqual(failed.activity, previous.activity);
  assert.equal(failed.activityPagination.nextCursor, 'old-tail');
});

test('monitor supports both status shapes and applies cadence only to configured wallets', () => {
  const watched = DEMO_WALLETS[0].address;
  const unconfigured = DEMO_WALLETS[1].address;
  const nested = normalizeMonitor({ enabled: true, retentionDays: 30, addresses: [watched, watched, 'bad'], intervals: { activityMs: 5000, snapshotMs: 60000 }, wallets: [{ address: watched, activityAt: 123456, backfill: { complete: false, pages: 3 } }] });
  const flat = normalizeMonitor({ enabled: true, retentionDays: 30, addresses: [watched], activityIntervalMs: 5000, snapshotIntervalMs: 60000 });
  assert.deepEqual(nested.addresses, [watched]);
  assert.equal(nested.wallets[0].activityAt, 123456, 'collector status keeps millisecond timestamps');
  assert.equal(nested.wallets[0].backfill.pages, 3);
  assert.equal(walletPollInterval(watched, nested), 5000);
  assert.equal(walletPollInterval(watched, nested, 'snapshot'), 60000);
  assert.equal(walletPollInterval(unconfigured, nested), 15000);
  assert.equal(walletPollInterval(watched, { ...nested, available: false }), 15000);
  assert.equal(walletPollInterval(watched, { ...nested, enabled: false }), 15000);
  assert.equal(flat.activityIntervalMs, nested.activityIntervalMs);
  assert.throws(() => normalizeMonitor({ error: 'Not configured' }));
});

test('5-second activity polling does not repeatedly download monitored full snapshots', () => {
  const monitor = normalizeMonitor({ enabled: true, addresses: [DEMO_WALLETS[0].address], activityIntervalMs: 5000, snapshotIntervalMs: 60000 });
  const last = new Map(DEMO_WALLETS.map(wallet => [wallet.address, 0]));
  assert.deepEqual(dueWallets(DEMO_WALLETS, monitor, last, new Set(), 5000).map(wallet => wallet.address), []);
  assert.deepEqual(dueWallets(DEMO_WALLETS, monitor, last, new Set(), 15000).map(wallet => wallet.address), [DEMO_WALLETS[1].address]);
  assert.equal(dueWallets(DEMO_WALLETS, monitor, last, new Set(), 60000).length, 2);
  assert.deepEqual(dueWallets(DEMO_WALLETS, monitor, last, new Set(), 5000, false, 'activity').map(wallet => wallet.address), [DEMO_WALLETS[0].address]);
});

test('snapshot, head and pagination locks exclude only their own wallet, even on manual refresh', () => {
  const monitor = normalizeMonitor({ enabled: true, addresses: [DEMO_WALLETS[0].address] });
  const busy = new Set([DEMO_WALLETS[0].address]);
  const last = new Map(DEMO_WALLETS.map(wallet => [wallet.address, 0]));
  assert.deepEqual(dueWallets(DEMO_WALLETS, monitor, last, busy, 90000, true).map(wallet => wallet.address), [DEMO_WALLETS[1].address]);
  assert.deepEqual(dueWallets(DEMO_WALLETS, monitor, last, busy, 90000, false, 'activity').map(wallet => wallet.address), [DEMO_WALLETS[1].address]);
});

test('rapid range projections immediately expose correct period metrics and bounded local history', () => {
  const month = getDemoData('1m')[DEMO_WALLETS[0].address];
  const source = { ...sample, historyAll: month.history };
  for (const range of ['1w', '1m', '1d', '1w']) {
    const projected = projectWalletRange(source, range);
    assert.equal(projected.range, range);
    assert.equal(projected.period.range, range);
    assert.equal(projected.period.totalPnl, source.periods[range].totalPnl);
    assert.strictEqual(projected.summary, source.summary, 'cumulative summary is never replaced with period totals');
    assert.ok(projected.history.every(point => point.timestamp >= projected.period.start && point.timestamp <= projected.period.end));
    assert.equal(needsRangeFetch(source, range), false, 'a valid local projection does not trigger a heavy range request');
  }
  assert.equal(source.range, '1d');
  assert.equal(source.history.length, 25);
  assert.equal(projectWalletRange(source, '1w').history.length, 8);
  assert.equal(projectWalletRange(source, '1m').history.length, 31);
});

test('range projection without all-history does not relabel the old chart or another wallet cache', () => {
  const projected = projectWalletRange(sample, '1w');
  assert.equal(projected.period.totalPnl, sample.periods['1w'].totalPnl);
  assert.deepEqual(projected.history, []);
  assert.equal(needsRangeFetch(sample, '1w'), true);
  const otherWallet = getDemoData('1w')[DEMO_WALLETS[1].address];
  assert.deepEqual(projectWalletRange(sample, '1w', otherWallet).history, []);
  const cache = getDemoData('1w')[DEMO_WALLETS[0].address];
  assert.equal(projectWalletRange(sample, '1w', cache).history.length, cache.history.length);
  assert.equal(needsRangeFetch(sample, '1w', cache), false);
});

test('30-day retained snapshots never masquerade as all-time history or unknown period gains', () => {
  const source = { ...sample, historyAll: getDemoData('1m')[sample.address].history };
  const all = projectWalletRange(source, 'all');
  assert.deepEqual(all.history, []);
  assert.equal(all.period.totalPnl, null);
  assert.equal(all.period.complete, false);
  const incomplete = projectWalletRange({ ...source, periods: { ...source.periods, '1w': undefined } }, '1w');
  assert.equal(incomplete.period.totalPnl, null);
  assert.deepEqual(incomplete.history, []);
});

test('an older cached full snapshot cannot overwrite newer activity rows or local cursor', () => {
  const previous = { ...walletPage([trade('new', 'new:0:head', 200)], 'local:new-cursor'), activityFetchedAt: '2026-11-03T06:31:00Z' };
  const olderSnapshot = { ...walletPage([trade('old', 'old:0:head', 100)], 'old-cursor', false), activityFetchedAt: '2026-11-03T06:30:00Z' };
  const merged = mergeWalletRefresh(olderSnapshot, previous);
  assert.deepEqual(merged.activity, previous.activity);
  assert.equal(merged.activityPagination.nextCursor, 'local:new-cursor');
  assert.equal(merged.activityFetchedAt, previous.activityFetchedAt);
  assert.equal(merged.warnings.length, 0);
});

test('history failure in a new range retains a correctly projected prior period rather than wrong-range numbers', () => {
  const previous = { ...sample, historyAll: getDemoData('1m')[sample.address].history };
  const next = { ...getDemoData('1w')[sample.address], history: [], sections: { ...sample.sections, history: 'error' } };
  const merged = mergeWalletRefresh(next, previous);
  assert.equal(merged.range, '1w');
  assert.equal(merged.period.range, '1w');
  assert.equal(merged.period.totalPnl, previous.periods['1w'].totalPnl);
  assert.equal(merged.history.length, 8);
});

const idleState = { loading: false, loadingMore: false, stale: false, error: null };
const healthyMonitor = { error: null, gap: null, stale: false, retentionDays: 30 };

test('readable HTTP 200 activity stays visible while a failed collector is reported as stale', () => {
  const previous = { ...walletPage([trade('shared', 'shared:0:head', 100)], 'local:tail'), activityFetchedAt: '2026-11-03T06:30:00Z' };
  const payload = { activity: [trade('new', 'new:0:head', 101), trade('shared', 'shared:0:head', 100)], pagination: { hasMore: true, nextCursor: 'local:head' }, fetchedAt: '2026-11-03T06:31:00Z', monitor: { ...healthyMonitor, error: '上游限流，采集重试中' } };
  const merged = mergeActivityResponse(previous, payload);
  assert.deepEqual(merged.activity.map(row => row.contentKey), ['new', 'shared']);
  assert.equal(merged.sections.activity, 'error');
  assert.ok(merged.warnings.some(warning => warning.includes('上游限流')));
  const state = activityResponseState({ ...idleState, loading: true }, undefined, activityHealth(payload.monitor), false);
  assert.equal(state.loading, false);
  assert.equal(state.stale, true);
  assert.ok(state.error.includes('采集异常'));
});

test('collector staleness without a transport error is not treated as healthy', () => {
  const health = activityHealth({ ...healthyMonitor, stale: true });
  assert.equal(health.stale, true);
  assert.ok(health.error.includes('已延迟'));
  const payload = { activity: sample.activity, pagination: sample.activityPagination, fetchedAt: sample.activityFetchedAt, monitor: { ...healthyMonitor, stale: true } };
  assert.equal(mergeActivityResponse(sample, payload).sections.activity, 'error');
  assert.equal(activityResponseState(idleState, undefined, health, false).stale, true);
});

test('normal initial backfill gaps are warnings and do not fail readable activity', () => {
  const monitor = { ...healthyMonitor, gap: '首次回填尚未完成，正在读取更早记录' };
  const health = activityHealth(monitor);
  assert.equal(health.error, null);
  assert.equal(health.stale, false);
  const payload = { activity: sample.activity, pagination: sample.activityPagination, fetchedAt: sample.activityFetchedAt, monitor };
  const merged = mergeActivityResponse(sample, payload);
  assert.equal(merged.sections.activity, 'ok');
  assert.ok(merged.warnings.some(warning => warning.includes('首次回填')));
  assert.equal(activityResponseState(idleState, undefined, health, false).error, null);
});

test('activity recovery clears only its own error and preserves failed snapshot state', () => {
  const oldHealth = activityHealth({ ...healthyMonitor, stale: true });
  const healthy = activityHealth(healthyMonitor);
  const recovered = activityResponseState({ ...idleState, stale: true, error: oldHealth.error }, oldHealth.error, healthy, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.stale, false);
  const unrelated = activityResponseState({ ...idleState, stale: true, error: '持仓快照更新失败' }, oldHealth.error, healthy, true);
  assert.equal(unrelated.error, '持仓快照更新失败');
  assert.equal(unrelated.stale, true);
  const previous = { ...sample, warnings: ['交易监控：旧活动错误', '交易历史：旧缺口', '持仓数据尚未完整加载'], sections: { ...sample.sections, stats: 'error', activity: 'error' } };
  const merged = mergeActivityResponse(previous, { activity: sample.activity, pagination: sample.activityPagination, fetchedAt: sample.activityFetchedAt, monitor: healthyMonitor });
  assert.equal(merged.sections.activity, 'ok');
  assert.equal(merged.sections.stats, 'error');
  assert.deepEqual(merged.warnings, ['持仓数据尚未完整加载']);
});

test('paginated database rows are retained while their collector health and gap remain visible', () => {
  const previous = walletPage([trade('same', 'same:0:head', 100)], 'local:page-2');
  const payload = { activity: [trade('same', 'same:0:page-2', 100)], pagination: { hasMore: true, nextCursor: 'local:page-3' }, fetchedAt: sample.fetchedAt, monitor: { ...healthyMonitor, stale: true, gap: '最新成交仍在追平' } };
  const merged = mergeActivityResponse(previous, payload, true);
  assert.equal(merged.activity.length, 2);
  assert.equal(merged.activityPagination.nextCursor, 'local:page-3');
  assert.equal(merged.sections.activity, 'error');
  assert.ok(merged.warnings.some(warning => warning.includes('追平')));
  const state = activityResponseState({ ...idleState, loadingMore: true }, undefined, activityHealth(payload.monitor), false);
  assert.equal(state.loadingMore, false);
  assert.equal(state.stale, true);
});

function timedSnapshot(value, clock, failed = []) {
  const timestamp = Date.parse(clock) / 1000;
  const history = [{ timestamp, totalPnl: value, realizedPnl: value, unrealizedPnl: 0 }];
  const period = { ...sample.period, start: timestamp - 86400, end: timestamp, totalPnl: value, realizedPnl: value, unrealizedPnl: 0, observedAt: timestamp };
  return { ...sample, persisted: true, fetchedAt: clock,
    summary: { ...sample.summary, totalPnl: value, realizedPnl: value, unrealizedPnl: 0, positionValue: value * 10, observedAt: timestamp },
    sections: Object.fromEntries(Object.keys(sample.sections).map(key => [key, failed.includes(key) ? 'error' : 'ok'])),
    sectionFetchedAt: Object.fromEntries(Object.keys(sample.sections).map(key => [key, clock])),
    history, historyAll: history, historySourceFidelity: `source-${value}`, period,
    periods: { ...sample.periods, '1d': period },
    positions: [{ ...sample.positions[0], totalPnl: value, currentValue: value * 10, timestamp }],
    closedPositions: [{ ...sample.positions[0], id: 'closed-position', totalPnl: value + 1, timestamp }],
    coverage: { positions: { complete: true, count: 1, fetchedAt: clock }, closedPositions: { complete: true, count: 1, fetchedAt: clock } },
  };
}

test('newer persisted retained stats are not overwritten by older browser values on collector error', () => {
  const previous = timedSnapshot(10, '2026-11-03T01:00:00Z');
  const next = timedSnapshot(20, '2026-11-03T02:00:00Z', ['stats', 'value']);
  const merged = mergeWalletRefresh(next, previous);
  assert.equal(merged.summary.totalPnl, 20);
  assert.equal(merged.summary.positionValue, 200);
  assert.equal(merged.summary.observedAt, next.summary.observedAt);
  assert.equal(merged.sectionFetchedAt.stats, '2026-11-03T02:00:00Z');
  assert.equal(merged.sectionFetchedAt.value, '2026-11-03T02:00:00Z');
  assert.equal(merged.sections.stats, 'error', 'retained data does not hide collection failure');
});

test('newer retained history and books keep their own coverage and fidelity metadata', () => {
  const previous = timedSnapshot(10, '2026-11-03T01:00:00Z');
  const next = timedSnapshot(20, '2026-11-03T02:00:00Z', ['history', 'positions', 'closedPositions']);
  const merged = mergeWalletRefresh(next, previous);
  assert.strictEqual(merged.history, next.history);
  assert.strictEqual(merged.historyAll, next.historyAll);
  assert.strictEqual(merged.period, next.period);
  assert.equal(merged.historySourceFidelity, 'source-20');
  assert.strictEqual(merged.positions, next.positions);
  assert.strictEqual(merged.closedPositions, next.closedPositions);
  assert.equal(merged.coverage.positions.fetchedAt, next.coverage.positions.fetchedAt);
  assert.equal(merged.sectionFetchedAt.history, next.sectionFetchedAt.history);
});

test('newer browser sections retain matching origin timestamps when a persisted snapshot is older', () => {
  const previous = timedSnapshot(30, '2026-11-03T03:00:00Z');
  const next = timedSnapshot(20, '2026-11-03T02:00:00Z', ['stats', 'value', 'history', 'positions', 'closedPositions']);
  const merged = mergeWalletRefresh(next, previous);
  assert.equal(merged.summary.totalPnl, 30);
  assert.equal(merged.summary.positionValue, 300);
  assert.equal(merged.historySourceFidelity, 'source-30');
  assert.strictEqual(merged.historyAll, previous.historyAll);
  assert.strictEqual(merged.positions, previous.positions);
  assert.strictEqual(merged.closedPositions, previous.closedPositions);
  for (const section of ['stats', 'value', 'history', 'positions', 'closedPositions']) assert.equal(merged.sectionFetchedAt[section], '2026-11-03T03:00:00Z');
  assert.equal(merged.coverage.positions.fetchedAt, '2026-11-03T03:00:00Z');
  assert.equal(merged.coverage.positions.complete, false);
  assert.equal(merged.period.totalPnl, 30);
});

test('stats and value choose sources independently without stamping old values as freshly fetched', () => {
  const previous = timedSnapshot(30, '2026-11-03T03:00:00Z');
  previous.sectionFetchedAt.stats = '2026-11-03T01:00:00Z';
  const next = timedSnapshot(20, '2026-11-03T02:00:00Z', ['stats', 'value']);
  const merged = mergeWalletRefresh(next, previous);
  assert.equal(merged.summary.totalPnl, 20);
  assert.equal(merged.summary.positionValue, 300);
  assert.equal(merged.sectionFetchedAt.stats, '2026-11-03T02:00:00Z');
  assert.equal(merged.sectionFetchedAt.value, '2026-11-03T03:00:00Z');
  const legacy = { ...next, persisted: false, sectionFetchedAt: undefined };
  const retained = mergeWalletRefresh(legacy, previous);
  assert.equal(retained.summary.totalPnl, 30);
  assert.equal(retained.sectionFetchedAt.stats, '2026-11-03T01:00:00Z');
});

test('newer zero values are valid retained data while unknown failed stats do not erase usable values', () => {
  const previous = timedSnapshot(10, '2026-11-03T01:00:00Z');
  const zero = timedSnapshot(0, '2026-11-03T02:00:00Z', ['stats', 'value']);
  assert.equal(mergeWalletRefresh(zero, previous).summary.totalPnl, 0);
  const unknown = { ...zero, summary: { ...zero.summary, totalPnl: null, realizedPnl: null, unrealizedPnl: null, positionValue: null } };
  const merged = mergeWalletRefresh(unknown, previous);
  assert.equal(merged.summary.totalPnl, 10);
  assert.equal(merged.summary.positionValue, 100);
  assert.equal(merged.sectionFetchedAt.stats, '2026-11-03T01:00:00Z');
});

test('windows derived from independently selected books do not retain mismatched server sums', () => {
  const previous = timedSnapshot(30, '2026-11-03T03:00:00Z');
  const next = timedSnapshot(40, '2026-11-03T04:00:00Z', ['positions']);
  previous.positions = [{ ...previous.positions[0], id: 'open', conditionId: 'shared-window', totalPnl: 30 }];
  next.positions = [{ ...next.positions[0], id: 'open', conditionId: 'shared-window', totalPnl: 20 }];
  next.sectionFetchedAt.positions = '2026-11-03T02:00:00Z';
  next.closedPositions = [{ ...next.closedPositions[0], id: 'closed', conditionId: 'shared-window', totalPnl: 40 }];
  const merged = mergeWalletRefresh(next, previous);
  assert.equal(merged.windows.find(window => window.id === 'shared-window').totalPnl, 70);
  assert.equal(merged.windows.find(window => window.id === 'shared-window').complete, false);
  assert.equal(merged.sectionFetchedAt.positions, '2026-11-03T03:00:00Z');
  assert.equal(merged.sectionFetchedAt.closedPositions, '2026-11-03T04:00:00Z');
});
