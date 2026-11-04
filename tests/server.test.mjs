import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolymarketClient, normalizeActivity, normalizePnl, numberOrNull, calculatePeriod, calculateProfilePeriod, pnlIsStale, aggregateWindows } from '../server/polymarket.mjs';
import { createServer } from '../server/index.mjs';

const ADDRESS = `0x${'a'.repeat(40)}`;
const CONDITION = `0x${'b'.repeat(64)}`;
const point = { timestamp: 1793664000, realized_pnl: 120, unrealized_pnl: -20, position_pnl: 100, trade_pnl: 104,
  economic_pnl: 105, wallet_income: 5, fees_paid: -4, volume_usdc: 1000, trade_count: 8 };
const position = { token_id: 'token1', title: 'Market A?', current_size: 10, current_value: 6,
  realized_pnl: 2, unrealized_pnl: 1, total_pnl: 3, status: 'OPEN', name: 'Trader' };
const event = { transaction_hash: `0x${'1'.repeat(64)}`, timestamp: 1793664000, token_id: 'token1',
  type: 'TRADE', side: 'BUY', title: 'Market A?', size: 10, usdc_size: 6.12, price: 0.6 };
const page = (rows = [], cursor = null) => ({ data: rows, pagination: { has_more: Boolean(cursor), next_cursor: cursor } });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function fixture(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.equal(url.origin, 'https://data-api.polymarket.com');
    const override = overrides[url.pathname];
    if (override) return override(url, options);
    if (url.pathname === '/v2/user-stats') return response({ data: { all_time_pnl: point } });
    if (url.pathname === '/v2/user-pnl') return response({ data: { points: [point], source_fidelity: '1d' } });
    if (url.pathname === '/v2/value') return response({ data: { value: 6 } });
    if (url.pathname === '/v2/positions') return response(page(url.searchParams.get('status') === 'OPEN' ? [position] : []));
    if (url.pathname === '/v2/activity') return response(page([event]));
    throw new Error('Unexpected endpoint');
  };
  return { fetchImpl, calls };
}

test('summary uses full-history official PnL, not loaded positions; fees are not deducted again', async () => {
  const f = fixture();
  const result = await createPolymarketClient(f).wallet(ADDRESS.toUpperCase().replace('0X', '0x'));
  assert.equal(result.address, ADDRESS);
  assert.equal(result.summary.totalPnl, 104);
  assert.equal(result.summary.pnlBasis, 'polymarket-trade-pnl');
  assert.equal(result.historyPnlBasis, 'polymarket-trade-pnl');
  assert.equal(result.summary.realizedPnl, 120);
  assert.equal(result.summary.unrealizedPnl, -20);
  assert.equal(result.summary.positionValue, 6);
  assert.equal(result.summary.feesPaid, -4);
  assert.equal(result.activity[0].amount, 6.12, 'use official cash amount including actual fill economics');
  assert.equal(result.history[0].totalPnl, 104);
  assert.equal(result.warnings.length, 0);
});

test('unknown and unavailable amounts are never converted to zero', async () => {
  for (const value of [null, undefined, '', '2', NaN, Infinity]) assert.equal(numberOrNull(value), null);
  assert.equal(numberOrNull(0), 0);
  const f = fixture({ '/v2/user-stats': () => response({ data: { all_time_pnl: { ...point, unrealized_pnl: null, trade_pnl: null } } }) });
  const result = await createPolymarketClient(f).wallet(ADDRESS);
  assert.equal(result.summary.totalPnl, null);
  assert.equal(result.summary.unrealizedPnl, null);
  assert.equal(result.summary.realizedPnl, 120);
});

test('unknown wallet is explicit and does not fabricate PnL', async () => {
  const f = fixture({ '/v2/user-stats': () => response({ data: null }) });
  const result = await createPolymarketClient(f).wallet(ADDRESS);
  assert.equal(result.summary.totalPnl, null);
  assert.match(result.warnings.join(''), /代理钱包地址/);
});

test('follows position cursors and preserves user, status and archived filters', async () => {
  const f = fixture({ '/v2/positions': url => {
    if (url.searchParams.get('status') === 'CLOSED') return response(page([]));
    assert.equal(url.searchParams.get('user'), ADDRESS);
    assert.equal(url.searchParams.get('include_archived'), 'true');
    assert.equal(url.searchParams.get('filter_amount'), '0');
    return response(url.searchParams.has('cursor') ? page([{ ...position, token_id: 'token2' }]) : page([position], 'nextpage'));
  } });
  const result = await createPolymarketClient(f).wallet(ADDRESS);
  assert.equal(result.positions.length, 2);
  assert.equal(result.coverage.positions.complete, true);
});

test('pagination cap and later-page failure disclose partial lists, never partial headline PnL', async () => {
  const f = fixture({ '/v2/positions': url => response(url.searchParams.get('status') === 'CLOSED' ? page([]) : page([position], 'nextpage')) });
  const capped = await createPolymarketClient({ ...f, maxPositionPages: 1 }).wallet(ADDRESS);
  assert.equal(capped.coverage.positions.complete, false);
  assert.equal(capped.summary.totalPnl, 104);
  assert.equal(capped.coverage.positions.error, null, 'intentional pagination limits are not upstream errors');
  assert.match(capped.warnings.join(''), /列表不完整/);
  const failed = fixture({ '/v2/positions': url => {
    if (url.searchParams.get('status') === 'CLOSED') return response(page([]));
    return url.searchParams.has('cursor') ? response({}, 503) : response(page([position], 'nextpage'));
  } });
  const result = await createPolymarketClient(failed).wallet(ADDRESS);
  assert.equal(result.positions.length, 1);
  assert.equal(result.coverage.positions.complete, false);
  assert.match(result.coverage.positions.error, /503/);
  assert.match(result.warnings.join(''), /503/);
});

test('partial upstream failure keeps other sections and marks failed stats unavailable', async () => {
  const f = fixture({ '/v2/user-stats': () => response({}, 503) });
  const result = await createPolymarketClient(f).wallet(ADDRESS);
  assert.equal(result.sections.stats, 'error');
  assert.equal(result.summary.totalPnl, null);
  assert.equal(result.activity.length, 1);
  assert.match(result.warnings.join(''), /盈亏统计/);
});

test('total network failure throws instead of returning demo or zero balances', async () => {
  const client = createPolymarketClient({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(client.wallet(ADDRESS), error => error.status === 502 && error.code === 'upstream_unavailable');
});

test('activity cache expires independently of portfolio cache and concurrent requests coalesce', async () => {
  let now = 100000;
  const f = fixture();
  const client = createPolymarketClient({ ...f, now: () => now });
  await Promise.all([client.wallet(ADDRESS), client.wallet(ADDRESS)]);
  assert.equal(f.calls.length, 9);
  now += 15000;
  await client.wallet(ADDRESS);
  assert.equal(f.calls.length, 10);
  assert.equal(f.calls.at(-1).url.pathname, '/v2/activity');
  now += 60000;
  await client.wallet(ADDRESS);
  assert.equal(f.calls.length, 19, 'open and closed books refresh together');
  now += 300000;
  await client.wallet(ADDRESS);
  assert.equal(f.calls.length, 28);
});

test('activity cursor requests retain full history, direction and deposit inclusion', async () => {
  const f = fixture();
  await createPolymarketClient(f).activity(ADDRESS, 'valid_cursor-123');
  const params = f.calls[0].url.searchParams;
  assert.equal(params.get('cursor'), 'valid_cursor-123');
  assert.equal(params.get('start'), '1');
  assert.equal(params.get('sort_direction'), 'DESC');
  assert.equal(params.get('exclude_deposits_withdrawals'), 'false');
});

test('repeated fills in one transaction are retained with unique IDs', () => {
  const rows = normalizeActivity([event, event, { ...event, size: 5 }]);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
  const anotherPage = normalizeActivity([event], 'next-page-cursor');
  assert.notEqual(anotherPage[0].id, rows[0].id, 'identical records on different pages must not collide');
  assert.equal(anotherPage[0].contentKey, rows[0].contentKey, 'polling overlap uses a content multiset, not a set');
});

test('address, range and cursor validation rejects requests before upstream access', async () => {
  const f = fixture();
  const client = createPolymarketClient(f);
  for (const address of ['https://evil.example', '0x123', ADDRESS + '?user=x']) await assert.rejects(client.wallet(address), error => error.status === 400);
  await assert.rejects(client.wallet(ADDRESS, 'bad'), error => error.status === 400);
  await assert.rejects(client.activity(ADDRESS, 'https://evil.example'), error => error.status === 400);
  assert.equal(f.calls.length, 0);
});

test('rate limit metadata is retained and malformed pagination is rejected', async () => {
  const limited = createPolymarketClient({ fetchImpl: async () => response({}, 429, { 'Retry-After': '20' }) });
  await assert.rejects(limited.activity(ADDRESS), error => error.status === 429 && error.retryAfter === 20);
  const invalid = createPolymarketClient({ fetchImpl: async () => response({ data: [], pagination: { has_more: true, next_cursor: null } }) });
  await assert.rejects(invalid.activity(ADDRESS), error => error.code === 'invalid_upstream_data');
});

test('HTTP routes expose health and validated API; unsupported methods and paths return proper status', async t => {
  const server = createServer({ client: createPolymarketClient(fixture()), addresses: [ADDRESS] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const result = await fetch(`${base}/api/wallet/${ADDRESS}`);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).summary.totalPnl, 104);
  assert.equal((await fetch(`${base}/api/wallet/invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
});

test('24h, 7day and 30day use exact start/end deltas, never the all-time balance', () => {
  const end = 1793678400;
  const points = [
    { timestamp: end - 30 * 86400, totalPnl: -100, realizedPnl: -90, unrealizedPnl: -10 },
    { timestamp: end - 7 * 86400, totalPnl: 50, realizedPnl: 60, unrealizedPnl: -10 },
    { timestamp: end - 86400, totalPnl: 90, realizedPnl: 100, unrealizedPnl: -10 },
    { timestamp: end, totalPnl: 120, realizedPnl: 130, unrealizedPnl: -10 },
  ];
  for (const [range, days, expected] of [['1d', 1, 30], ['1w', 7, 70], ['1m', 30, 220]]) {
    const p = calculatePeriod(points, range, '1d', end, end + 3600);
    assert.equal(p.complete, true);
    assert.equal(p.totalPnl, expected);
    assert.equal(p.end - p.start, days * 86400);
    assert.equal(p.sourceFidelity, '1d');
    assert.equal(p.stale, false);
  }
});

test('23h of data cannot become a 24h PnL; missing boundary and null marks stay unavailable', () => {
  const end = 1793678400;
  const points = [{ timestamp: end - 23 * 3600, totalPnl: 2, realizedPnl: 2, unrealizedPnl: 0 },
    { timestamp: end, totalPnl: 10, realizedPnl: 10, unrealizedPnl: 0 }];
  const short = calculatePeriod(points, '1d', '1d', end, end);
  assert.equal(short.complete, false);
  assert.equal(short.totalPnl, null);
  const missingMark = calculatePeriod([{ timestamp: end - 86400, totalPnl: null, realizedPnl: 2, unrealizedPnl: null }, points[1]], '1d', '1d', end, end);
  assert.equal(missingMark.totalPnl, null);
  assert.equal(missingMark.realizedPnl, 8);
  assert.equal(missingMark.complete, false);
  assert.equal(calculatePeriod([], '1w').totalPnl, null);
});

test('period discloses stale observations and never interpolates an off-grid endpoint', () => {
  const end = 1793678400;
  const points = [{ timestamp: end - 86400, totalPnl: 2, realizedPnl: 2, unrealizedPnl: 0 },
    { timestamp: end, totalPnl: 10, realizedPnl: 10, unrealizedPnl: 0 },
    { timestamp: end + 500, totalPnl: 20, realizedPnl: 20, unrealizedPnl: 0 }];
  const p = calculatePeriod(points, '1d', '1h', end, end + 10800);
  assert.equal(p.end, end);
  assert.equal(p.totalPnl, 8);
  assert.equal(p.stale, true);
  assert.match(p.reason, /宽限期/);
});

test('profile PnL matches interval chart boundaries and never substitutes position/economic PnL', async () => {
  const end = point.timestamp;
  const configurations = { '1d': ['1h', 23 * 3600, 4], '1w': ['3h', 165 * 3600, 14], '1m': ['18h', 708 * 3600, 44], all: ['1d', 90 * 86400, 1] };
  const f = fixture({ '/v2/user-pnl': url => {
    const [fidelity, duration, startPnl] = configurations[url.searchParams.get('interval')];
    assert.equal(url.searchParams.get('fidelity'), fidelity);
    return response({ data: { source_fidelity: '1d', points: [{ ...point, timestamp: end - duration, trade_pnl: startPnl }, point] } });
  } });
  const client = createPolymarketClient({ ...f, now: () => (end + 4 * 3600) * 1000 });
  const result = await client.wallet(ADDRESS, '1d');
  assert.equal(result.summary.totalPnl, 104);
  assert.equal(result.period.totalPnl, 100);
  assert.equal(result.period.end - result.period.start, 23 * 3600);
  assert.equal(result.period.complete, true);
  assert.equal(result.period.stale, false, 'daily observations are not called stale after only four hours');
  assert.equal(result.periods['1w'].totalPnl, 90);
  assert.equal(result.periods['1m'].totalPnl, 60);
  assert.equal(result.historyByRange['1w'][0].totalPnl, 14);
  assert.equal((await client.wallet(ADDRESS, 'all')).period.totalPnl, 104, 'ALL is cumulative trade_pnl, not first/last difference');
  assert.equal(normalizePnl({ ...point, trade_pnl: undefined }).totalPnl, null);
  const unavailable = calculateProfilePeriod([{ timestamp: end - 23 * 3600, totalPnl: null }, normalizePnl(point)], '1d');
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.totalPnl, null);
  assert.equal(calculateProfilePeriod([normalizePnl(point)], '1d').totalPnl, null);
});

test('PnL freshness follows the observation source rather than the resampled grid', () => {
  const observed = 1793664000;
  assert.equal(pnlIsStale(observed, '1d', observed + 4 * 3600), false);
  assert.equal(pnlIsStale(observed, '1d', observed + 49 * 3600), true);
  assert.equal(pnlIsStale(observed, '1h', observed + 3 * 3600), true);
  assert.equal(pnlIsStale(null, '1d', observed), false);
});

test('a walk budget is partial coverage without being labelled an upstream failure', async () => {
  let clock = 0;
  const f = fixture({ '/v2/positions': url => {
    if (url.searchParams.get('status') === 'CLOSED') return response(page([]));
    clock = 9000;
    return response(page([position], 'nextpage'));
  } });
  const result = await createPolymarketClient({ ...f, now: () => clock }).wallet(ADDRESS);
  assert.equal(result.coverage.positions.complete, false);
  assert.equal(result.coverage.positions.error, null);
  assert.match(result.warnings.join(''), /时间上限/);
});

test('each BTC 5m condition combines both outcomes once, including current and closed tokens', () => {
  const up = { id: 'up', conditionId: 'condition1', title: 'BTC', slug: 'btc-updown-5m-1793680500', outcome: 'Up',
    status: 'OPEN', timestamp: 100, totalPnl: 10, realizedPnl: 2, unrealizedPnl: 8, currentValue: 50 };
  const down = { ...up, id: 'down', outcome: 'Down', status: 'CLOSED', totalPnl: -3, realizedPnl: -3, unrealizedPnl: 0, currentValue: 0 };
  const duplicateOld = { ...up, status: 'CLOSED', timestamp: 99, totalPnl: 999 };
  const windows = aggregateWindows([up], [down, duplicateOld]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].totalPnl, 7);
  assert.equal(windows[0].positionCount, 2);
  assert.equal(windows[0].realizedPnl, -1);
  assert.equal(windows[0].isBtc5m, true);
  assert.equal(windows[0].endTime - windows[0].windowStart, 300);
  assert.equal(windows[0].status, 'OPEN');
});

test('window grouping uses condition IDs rather than titles, preserves unknown marks and coverage', () => {
  const rows = [{ id: 'a', conditionId: 'c1', title: 'Same title', slug: 'unknown', status: 'CLOSED', outcome: 'Yes',
    timestamp: 1, totalPnl: null, realizedPnl: 1, unrealizedPnl: null, currentValue: 0 },
  { id: 'b', conditionId: 'c2', title: 'Same title', slug: 'unknown', status: 'CLOSED', outcome: 'Yes',
    timestamp: 2, totalPnl: 2, realizedPnl: 2, unrealizedPnl: 0, currentValue: 0 }];
  const windows = aggregateWindows([], rows, false);
  assert.equal(windows.length, 2);
  assert.equal(windows.find(row => row.id === 'c1').totalPnl, null);
  assert.equal(windows.every(row => !row.complete), true);
  assert.equal(windows.every(row => !row.isBtc5m), true);
});

test('single-window verification filters every page by condition and uses independent complete coverage', async () => {
  const f = fixture({ '/v2/positions': url => {
    assert.equal(url.searchParams.get('condition'), CONDITION);
    assert.equal(url.searchParams.get('user'), ADDRESS);
    const row = { ...position, condition_id: CONDITION };
    if (url.searchParams.get('status') === 'OPEN') {
      assert.equal(url.searchParams.get('include_archived'), 'true');
      return response(page([row]));
    }
    assert.equal(url.searchParams.has('include_archived'), false);
    if (!url.searchParams.has('cursor')) return response(page([{ ...row, token_id: 'closed1', realized_pnl: 5, unrealized_pnl: 0, total_pnl: 5 }], 'nextpage'));
    return response(page([{ ...row, token_id: 'closed2', realized_pnl: -1, unrealized_pnl: 0, total_pnl: -1 }]));
  } });
  const result = await createPolymarketClient(f).window(ADDRESS, CONDITION);
  assert.equal(result.window.conditionId, CONDITION);
  assert.equal(result.window.complete, true);
  assert.equal(result.window.totalPnl, 7);
  assert.equal(result.window.positionCount, 3);
  assert.equal(result.coverage.closedPositions.count, 2);
  assert.equal(result.warnings.length, 0);
});

test('single-window validation rejects malformed condition without calling upstream', async () => {
  const f = fixture();
  const client = createPolymarketClient(f);
  for (const condition of ['0x123', 'https://evil.example', CONDITION + ',x']) {
    await assert.rejects(client.window(ADDRESS, condition), error => error.status === 400 && error.code === 'invalid_condition');
  }
  assert.equal(f.calls.length, 0);
});

test('single-window missing/partial/wrong-market results cannot masquerade as complete zero PnL', async () => {
  const empty = createPolymarketClient(fixture({ '/v2/positions': () => response(page([])) }));
  assert.equal((await empty.window(ADDRESS, CONDITION)).window, null);
  const partial = createPolymarketClient(fixture({ '/v2/positions': url => url.searchParams.get('status') === 'CLOSED'
    ? response({}, 503) : response(page([{ ...position, condition_id: CONDITION }])) }));
  const result = await partial.window(ADDRESS, CONDITION);
  assert.equal(result.window.complete, false);
  assert.equal(result.coverage.closedPositions.complete, false);
  assert.match(result.warnings.join(''), /失败/);
  const wrong = createPolymarketClient(fixture());
  const mismatched = await wrong.window(ADDRESS, CONDITION);
  assert.equal(mismatched.window, null);
  assert.equal(mismatched.coverage.positions.complete, false);
  assert.match(mismatched.warnings.join(''), /不匹配/);
});

test('HTTP single-window endpoint exposes validation and complete verified result', async t => {
  const client = createPolymarketClient(fixture({ '/v2/positions': () => response(page([{ ...position, condition_id: CONDITION }])) }));
  const server = createServer({ client, addresses: [ADDRESS] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/wallet/${ADDRESS}/window/`;
  assert.equal((await fetch(base + 'bad')).status, 400);
  const result = await fetch(base + CONDITION);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).window.complete, true);
});

test('OPEN-to-CLOSED migration refreshes both books as one snapshot with a shared expiry', async () => {
  let now = 100000;
  let migrated = false;
  const f = fixture({ '/v2/positions': url => {
    const status = url.searchParams.get('status');
    if (status === 'CLOSED') now += 4000; // A slower closed-book response must not create separate expiry times.
    const belongs = migrated ? status === 'CLOSED' : status === 'OPEN';
    return response(page(belongs ? [{ ...position, condition_id: CONDITION, status, total_pnl: migrated ? 9 : 3,
      realized_pnl: migrated ? 9 : 2, unrealized_pnl: migrated ? 0 : 1 }] : []));
  } });
  const client = createPolymarketClient({ ...f, now: () => now });
  const first = await client.wallet(ADDRESS);
  assert.equal(first.windows[0].totalPnl, 3);
  assert.equal(first.windows[0].complete, true);
  migrated = true;
  now = 162000; // Before the pair expiry: return both old books coherently.
  const before = await client.wallet(ADDRESS);
  assert.equal(before.positions.length, 1);
  assert.equal(before.closedPositions.length, 0);
  assert.equal(before.windows[0].totalPnl, 3);
  now = 165000; // After the shared expiry: fetch both current books together.
  const after = await client.wallet(ADDRESS);
  assert.equal(after.positions.length, 0);
  assert.equal(after.closedPositions.length, 1);
  assert.equal(after.windows[0].totalPnl, 9);
  assert.equal(after.windows[0].complete, true);
  assert.equal(f.calls.filter(call => call.url.pathname === '/v2/positions').length, 4);
});
