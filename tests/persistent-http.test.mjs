import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createServer, monitorConfig } from '../server/index.mjs';
import { createStore } from '../server/store.mjs';

const address = `0x${'a'.repeat(40)}`;
const other = `0x${'b'.repeat(40)}`;
const now = 1800000000000;
const seconds = now / 1000;
function snapshot() {
  return { address, fetchedAt: new Date(now - 1000).toISOString(), source: 'live', range: '1m',
    pnlBasis: 'polymarket-trade-pnl', historyPnlBasis: 'polymarket-trade-pnl',
    profile: { name: 'Test', avatar: '' }, summary: { totalPnl: 100, realizedPnl: 80, unrealizedPnl: 20, observedAt: seconds, positionValue: 10, pnlBasis: 'polymarket-trade-pnl' },
    periods: Object.fromEntries([['1d', 86400], ['1w', 604800], ['1m', 2592000]].map(([range, delta]) => [range, { range, start: seconds - delta, end: seconds, totalPnl: 5, realizedPnl: 3, unrealizedPnl: 2, complete: true, pnlBasis: 'polymarket-trade-pnl' }])),
    history: [{ timestamp: seconds - 100, totalPnl: 90, realizedPnl: 75, unrealizedPnl: 15 }, { timestamp: seconds, totalPnl: 100, realizedPnl: 80, unrealizedPnl: 20 }],
    positions: [], closedPositions: [], windows: [], activity: [], warnings: [],
    coverage: { positions: { complete: true, count: 0 }, closedPositions: { complete: true, count: 0 } },
    sections: Object.fromEntries(['stats', 'history', 'value', 'positions', 'closedPositions', 'activity'].map(key => [key, 'ok'])) };
}
async function fixture(t, { seeded = true, failed = false } = {}) {
  const store = createStore({ path: ':memory:', now: () => now });
  if (seeded) { store.saveSnapshot(address, snapshot()); store.ingestActivityGroups(address, [{ contentKey: 'fill', timestamp: seconds, type: 'TRADE', amount: 10 }]); }
  let upstreamCalls = 0;
  const client = { async wallet() { upstreamCalls++; return { direct: true }; } };
  const monitor = { status: () => ({ enabled: true, addresses: [address], retentionDays: 30, intervals: { activityMs: 5000, snapshotMs: 60000 },
    wallets: [{ address, backfill: { complete: false }, activityError: failed ? 'offline' : null, snapshotError: failed ? 'offline' : null }] }) };
  const server = createServer({ client, store, monitor, addresses: [address], now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, store, calls: () => upstreamCalls };
}

test('monitored dashboard reads persisted data without upstream; unconfigured wallets are rejected', async t => {
  const f = await fixture(t);
  const data = await (await fetch(`${f.base}/api/wallet/${address}?range=1w`)).json();
  assert.equal(data.range, '1w'); assert.equal(data.period.totalPnl, 5); assert.equal(data.storage.persisted, true);
  assert.equal(data.activity[0].amount, 10); assert.equal(data.historyAll.length, 2); assert.equal(f.calls(), 0);
  assert.match(data.warnings.join(' '), /30天.*补齐/);
  const rejected = await fetch(`${f.base}/api/wallet/${other}`);
  assert.equal(rejected.status, 403); assert.equal((await rejected.json()).code, 'wallet_not_configured'); assert.equal(f.calls(), 0);
  const status = await (await fetch(`${f.base}/api/monitor`)).json(); assert.equal(status.activityIntervalMs, 5000);
});

test('first sync and malformed local cursors are explicit HTTP errors, never fabricated empty successful wallet data', async t => {
  const f = await fixture(t, { seeded: false });
  const response = await fetch(`${f.base}/api/wallet/${address}`); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'initial_sync');
  const cursor = await fetch(`${f.base}/api/wallet/${address}/activity?cursor=local:invalid`); assert.equal(cursor.status, 400);
  assert.equal((await cursor.json()).code, 'invalid_local_cursor');
  assert.equal((await fetch(`${f.base}/api/wallet/${address}?range=bad`)).status, 400);
});

test('collector failure retains saved money with original timestamp and a visible warning', async t => {
  const f = await fixture(t, { failed: true });
  const data = await (await fetch(`${f.base}/api/wallet/${address}?range=1d`)).json();
  assert.equal(data.summary.totalPnl, 100); assert.equal(data.fetchedAt, snapshot().fetchedAt);
  assert.equal(data.sections.activity, 'error'); assert.match(data.warnings.join(' '), /offline/);
  const feed = await (await fetch(`${f.base}/api/wallet/${address}/activity`)).json();
  assert.equal(feed.monitor.error, 'offline'); assert.equal(feed.activity[0].amount, 10);
});

test('large persistent snapshots use gzip and keep a readable JSON response', async t => {
  const f = await fixture(t); const data = snapshot(); data.profile.name = 'readable '.repeat(2000); f.store.saveSnapshot(address, data);
  const response = await fetch(`${f.base}/api/wallet/${address}`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip'); assert.equal((await response.json()).profile.name, data.profile.name);
});

test('monitor configuration validates retention, address list and polling limits before startup', () => {
  assert.equal(monitorConfig({}).enabled, false);
  assert.deepEqual(monitorConfig({}).addresses, []);
  assert.deepEqual(monitorConfig({ MONITOR_ENABLED: 'false', WATCH_WALLETS: address }).addresses, [address]);
  assert.throws(() => monitorConfig({ MONITOR_ENABLED: 'true' }), /WATCH_WALLETS/);
  assert.deepEqual(monitorConfig({ MONITOR_ENABLED: 'true', WATCH_WALLETS: `${address},${address}` }).addresses, [address]);
  for (const env of [{ RETENTION_DAYS: '60' }, { MONITOR_ENABLED: 'yes' }, { MONITOR_ENABLED: 'true', WATCH_WALLETS: 'bad' }, { MONITOR_ENABLED: 'false', WATCH_WALLETS: 'bad' }, { ACTIVITY_INTERVAL_MS: '20' }]) assert.throws(() => monitorConfig(env));
});

test('deployment allowlist protects snapshot, activity and window reads even without a collector', async t => {
  const calls = [];
  const client = Object.fromEntries(['wallet', 'activity', 'window'].map(method => [method, async value => { calls.push([method, value]); return { address: value }; }]));
  const server = createServer({ client, addresses: [address.toUpperCase()] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ['', '/activity', `/window/0x${'c'.repeat(64)}`]) {
    const blocked = await fetch(`${base}/api/wallet/${other}${suffix}`);
    assert.equal(blocked.status, 403); assert.equal((await blocked.json()).code, 'wallet_not_configured');
    assert.equal((await fetch(`${base}/api/wallet/${other}${suffix}`, { method: 'HEAD' })).status, 403);
    assert.equal(calls.length, 0);
  }
  for (const suffix of ['', '/activity', `/window/0x${'c'.repeat(64)}`]) {
    assert.equal((await fetch(`${base}/api/wallet/${address.toUpperCase()}${suffix}`)).status, 200);
  }
  assert.deepEqual(calls, [['wallet', address], ['activity', address], ['window', address]]);
  const status = await (await fetch(`${base}/api/monitor`)).json();
  assert.equal(status.enabled, false); assert.deepEqual(status.addresses, [address]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/monitor', `/api/wallet/${address}`]) {
      assert.equal((await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: [other] }) })).status, 405);
    }
  }
  assert.deepEqual((await (await fetch(`${base}/api/monitor`)).json()).addresses, [address]);
});

test('runtime publishes deployment addresses when collection is disabled and an empty deployment fails closed', async t => {
  for (const addresses of ['', address]) {
    const runtime = await createRuntime({ env: { MONITOR_ENABLED: 'false', WATCH_WALLETS: addresses } });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    t.after(() => runtime.stop());
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    const status = await (await fetch(`${base}/api/monitor`)).json();
    assert.deepEqual(status.addresses, addresses ? [address] : []);
    assert.equal(status.enabled, false);
    assert.equal((await fetch(`${base}/api/wallet/${addresses ? other : address}`)).status, 403);
  }
});
