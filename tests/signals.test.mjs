import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignals, LARGE_TRADE_WINDOW_MS, startSignalClock } from '../src/signals.ts';

const NOW = 1800000000000;
const ADDRESS = `0x${'ab'.repeat(20)}`;
function entry() {
  return { wallet: { address: ADDRESS, label: '测试钱包' }, loading: false, loadingMore: false, error: null, stale: false,
    data: { fetchedAt: new Date(NOW).toISOString(), profile: { name: '' },
      sections: Object.fromEntries(['stats', 'history', 'value', 'positions', 'closedPositions', 'activity'].map(key => [key, 'ok'])),
      period: { complete: true, stale: false, observedAt: NOW / 1000 - 4 * 3600, sourceFidelity: '1d' },
      coverage: { positions: { complete: true, error: null }, closedPositions: { complete: true, error: null } },
      storage: { stale: false }, activityMonitor: { error: null, stale: false }, activity: [], warnings: [] } };
}
function trade(timestamp, key = 'fill', amount = 1000) {
  return { type: 'TRADE', side: 'BUY', amount, timestamp, contentKey: key, transactionHash: '0xabc', title: '测试市场', outcome: 'Up', slug: 'test-market' };
}

test('retention, partial history and missing period boundaries remain context rather than incidents', () => {
  const current = entry();
  current.data.coverage.closedPositions.complete = false;
  current.data.period.complete = false;
  current.data.warnings = ['本地仅保留最近30天', '历史加载已达到时间预算', '周期边界数据不足'];
  const before = structuredClone(current);
  assert.deepEqual(buildSignals([current], NOW), []);
  assert.deepEqual(current, before, 'source context and warnings are retained for the data explanation');
});

test('real failures do not time out, and clear when the latest wallet health recovers', () => {
  const failed = entry();
  failed.error = '无法连接数据服务';
  failed.data.activity = [trade(NOW / 1000)];
  assert.deepEqual(buildSignals([failed], NOW).map(signal => signal.kind), ['error', 'large']);
  assert.deepEqual(buildSignals([failed], NOW + LARGE_TRADE_WINDOW_MS).map(signal => signal.kind), ['error']);
  const recovered = structuredClone(failed);
  recovered.error = null;
  assert.deepEqual(buildSignals([recovered], NOW + LARGE_TRADE_WINDOW_MS), []);
});

test('section and collector errors remain visible even without a transport error on the wallet', () => {
  const partial = entry();
  partial.data.sections.positions = 'error';
  assert.equal(buildSignals([partial], NOW)[0].kind, 'error');
  partial.data.sections.positions = 'ok';
  partial.data.activityMonitor.error = '上游正在重试';
  assert.equal(buildSignals([partial], NOW)[0].kind, 'error');
  partial.data.activityMonitor.error = null;
  assert.deepEqual(buildSignals([partial], NOW), []);
});

test('a real mid-page error remains visible but recovery to budget-limited coverage clears it', () => {
  const current = entry();
  current.data.coverage.closedPositions.complete = false;
  current.data.coverage.closedPositions.error = '分页网络连接中断';
  assert.equal(buildSignals([current], NOW)[0].kind, 'error');
  current.data.coverage.closedPositions.error = null;
  assert.deepEqual(buildSignals([current], NOW), [], 'coverage can remain partial after the actual network failure recovers');
});

test('explicit source, collector and snapshot delays each recover without preserving an old incident', () => {
  for (const target of ['period', 'activityMonitor', 'storage']) {
    const current = entry();
    current.data[target].stale = true;
    assert.equal(buildSignals([current], NOW)[0].kind, 'stale');
    current.data[target].stale = false;
    assert.deepEqual(buildSignals([current], NOW), []);
  }
  const current = entry();
  current.stale = true;
  assert.equal(buildSignals([current], NOW)[0].kind, 'stale');
  current.stale = false;
  assert.deepEqual(buildSignals([current], NOW), [], 'normal daily source age is not independently reclassified by the UI');
});

test('large trades use event time, strict five-minute expiry and valid amounts', () => {
  const current = entry();
  const now = NOW / 1000;
  current.data.activity = [trade(now, 'now'), trade(now - 299, 'inside'), trade(now - 300, 'expired'), trade(now - 301, 'old'), trade(null, 'unknown'), trade(NaN, 'invalid'), trade(now + 1, 'future'), trade(now, 'small', 999.99), trade(now, 'invalid-amount', NaN), { ...trade(now, 'redeem'), type: 'REDEEM' }];
  const signals = buildSignals([current], NOW);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.kind === 'large'));
  assert.deepEqual(signals.map(signal => signal.time), [now, now - 299]);
  assert.deepEqual(buildSignals([current], NOW + 301000), [], 'late delivery does not extend an old trade lifetime');
});

test('identical real fills and different wallets retain distinct keys while events are capped newest-first', () => {
  const first = entry();
  first.data.activity = [trade(NOW / 1000, 'identical'), trade(NOW / 1000, 'identical')];
  const second = structuredClone(first); second.wallet.address = `0x${'cd'.repeat(20)}`;
  const duplicates = buildSignals([first, second], NOW);
  assert.equal(duplicates.length, 4);
  assert.equal(new Set(duplicates.map(signal => signal.key)).size, 4);
  first.data.activity = Array.from({ length: 20 }, (_, i) => trade(NOW / 1000 - i, String(i))).reverse();
  const recent = buildSignals([first], NOW);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].time, NOW / 1000);
  assert.equal(recent.at(-1).time, NOW / 1000 - 11);
});

test('the running clock expires a trade without another API response and stops updating after cleanup', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
  const current = entry(); current.data.activity = [trade((NOW - LARGE_TRADE_WINDOW_MS + 1000) / 1000)];
  const sameEntries = [current];
  const frames = [];
  const stop = startSignalClock(now => frames.push(buildSignals(sameEntries, now)));
  try {
    assert.equal(frames.at(-1).length, 1);
    t.mock.timers.tick(1000);
    assert.deepEqual(frames.at(-1), []);
    const callbacks = frames.length;
    stop();
    t.mock.timers.tick(5000);
    assert.equal(frames.length, callbacks);
  } finally { stop(); }
});
