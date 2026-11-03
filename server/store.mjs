import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { calculatePeriod } from './polymarket.mjs';

const DAY = 86400;
const RANGES = new Set(['1d', '1w', '1m', 'all']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export class StoreError extends Error {
  constructor(message, code = 'invalid_local_cursor', status = 400) {
    super(message); this.name = 'StoreError'; this.code = code; this.status = status;
  }
}

/** Synchronous, local-only SQLite store. No secrets or upstream credentials are required. */
export function createStore({ path, now = Date.now, retentionDays = 30 } = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('SQLite 数据库路径不能为空。');
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw new RangeError('保留天数必须为 1 至 30 天。');
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  let closed = false;
  db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS snapshots (address TEXT PRIMARY KEY, payload TEXT NOT NULL, source_at INTEGER NOT NULL, saved_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS pnl_points (address TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, source_at INTEGER NOT NULL, PRIMARY KEY(address, timestamp)) WITHOUT ROWID, STRICT;
    CREATE TABLE IF NOT EXISTS activities (address TEXT NOT NULL, timestamp INTEGER NOT NULL, content_key TEXT NOT NULL, occurrence INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(address, timestamp, content_key, occurrence)) WITHOUT ROWID, STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS activity_id ON activities(address, id);
    CREATE INDEX IF NOT EXISTS activity_feed ON activities(address, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS activity_expiry ON activities(timestamp);
    CREATE INDEX IF NOT EXISTS pnl_expiry ON pnl_points(timestamp);
    CREATE TABLE IF NOT EXISTS collector_states (address TEXT PRIMARY KEY, payload TEXT NOT NULL, saved_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS activity_sync (address TEXT PRIMARY KEY, fetched_at TEXT NOT NULL) STRICT;`);
  const schema = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
  if (schema && schema.value !== '1') { db.close(); throw new Error('数据库版本不受支持，禁止覆盖已有数据。'); }
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('schema_version','1')").run();
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('cursor_secret',?)").run(randomBytes(32).toString('hex'));
  const secret = Buffer.from(db.prepare("SELECT value FROM metadata WHERE key = 'cursor_secret'").get().value, 'hex');
  const query = {
    snapshot: db.prepare('SELECT payload, source_at FROM snapshots WHERE address=?'),
    putSnapshot: db.prepare('INSERT INTO snapshots(address,payload,source_at,saved_at) VALUES (?,?,?,?) ON CONFLICT(address) DO UPDATE SET payload=excluded.payload,source_at=excluded.source_at,saved_at=excluded.saved_at'),
    putPoint: db.prepare('INSERT INTO pnl_points(address,timestamp,payload,source_at) VALUES (?,?,?,?) ON CONFLICT(address,timestamp) DO UPDATE SET payload=excluded.payload,source_at=excluded.source_at WHERE excluded.source_at >= pnl_points.source_at'),
    points: db.prepare('SELECT payload FROM pnl_points WHERE address=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp'),
    activity: db.prepare('SELECT payload FROM activities WHERE address=? AND timestamp=? AND content_key=? AND occurrence=?'),
    putActivity: db.prepare('INSERT INTO activities(address,timestamp,content_key,occurrence,id,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(address,timestamp,content_key,occurrence) DO UPDATE SET payload=excluded.payload'),
    feed: db.prepare('SELECT timestamp,id,payload FROM activities WHERE address=? AND timestamp>=? AND timestamp<=? AND (? IS NULL OR timestamp<? OR (timestamp=? AND id<?)) ORDER BY timestamp DESC,id DESC LIMIT ?'),
    state: db.prepare('SELECT payload FROM collector_states WHERE address=?'),
    putState: db.prepare('INSERT INTO collector_states(address,payload,saved_at) VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET payload=excluded.payload,saved_at=excluded.saved_at'),
    sync: db.prepare('SELECT fetched_at FROM activity_sync WHERE address=?'),
    putSync: db.prepare('INSERT INTO activity_sync(address,fetched_at) VALUES (?,?) ON CONFLICT(address) DO UPDATE SET fetched_at=excluded.fetched_at'),
  };

  function addressOf(address) {
    if (typeof address !== 'string' || !ADDRESS.test(address)) throw new StoreError('无效的钱包地址。', 'invalid_address');
    return address.toLowerCase();
  }
  function clock() {
    const ms = now();
    if (!Number.isFinite(ms)) throw new TypeError('存储时钟无效。');
    const seconds = Math.floor(ms / 1000);
    return { ms, seconds, cutoff: seconds - retentionDays * DAY };
  }
  function recent(row, at) { return row && timestamp(row.timestamp) && row.timestamp >= at.cutoff && row.timestamp <= at.seconds + 300; }
  function windowRecent(row, at) {
    const eventTime = [row?.timestamp, row?.endTime, row?.windowStart].find(timestamp);
    return eventTime !== undefined && eventTime >= at.cutoff && eventTime <= at.seconds + 300;
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function trimSnapshot(input, at) {
    const payload = clone(input);
    const oldPositions = Array.isArray(payload.positions) ? payload.positions : [];
    const oldClosed = Array.isArray(payload.closedPositions) ? payload.closedPositions : [];
    const oldWindows = Array.isArray(payload.windows) ? payload.windows : [];
    payload.positions = oldPositions.filter(row => row && (row.status === 'OPEN' || row.status === 'REDEEMABLE' || recent(row, at)));
    payload.closedPositions = oldClosed.filter(row => recent(row, at));
    payload.windows = oldWindows.filter(row => windowRecent(row, at));
    payload.activity = (Array.isArray(payload.activity) ? payload.activity : []).filter(row => recent(row, at));
    payload.history = (Array.isArray(payload.history) ? payload.history : []).filter(row => recent(row, at));
    if (Array.isArray(payload.historyAll)) payload.historyAll = payload.historyAll.filter(row => recent(row, at));
    const closedTrimmed = Boolean(payload.retention?.closedPositionsTrimmed) || oldClosed.length !== payload.closedPositions.length;
    const windowsTrimmed = Boolean(payload.retention?.windowsTrimmed) || oldWindows.length !== payload.windows.length;
    const positionsTrimmed = Boolean(payload.retention?.positionsTrimmed) || oldPositions.length !== payload.positions.length;
    payload.retention = { days: retentionDays, cutoff: at.cutoff, historyLimited: true, positionsTrimmed, closedPositionsTrimmed: closedTrimmed, windowsTrimmed };
    if (payload.coverage?.closedPositions) payload.coverage.closedPositions = {
      ...payload.coverage.closedPositions, count: payload.closedPositions.length,
      complete: Boolean(payload.coverage.closedPositions.complete) && !closedTrimmed,
    };
    if (payload.coverage?.positions) payload.coverage.positions = { ...payload.coverage.positions, count: payload.positions.length, complete: Boolean(payload.coverage.positions.complete) && !positionsTrimmed };
    // An old side removed by retention can make a still-visible market subtotal incomplete.
    const removedConditions = new Set(oldClosed.filter(row => !recent(row, at)).map(row => row.conditionId));
    if (removedConditions.size) payload.windows = payload.windows.map(row => removedConditions.has(row.conditionId) ? { ...row, complete: false } : row);
    const warning = `本地仅保留最近 ${retentionDays} 天的历史明细和曲线；官方周期/累计摘要及当前持仓快照单独保留。`;
    payload.warnings = [...new Set([...(Array.isArray(payload.warnings) ? payload.warnings : []), warning])];
    return payload;
  }
  function trimState(state, at) {
    const value = clone(state);
    for (const key of ['head', 'backfill']) {
      if (value?.[key] && Array.isArray(value[key].carry)) value[key].carry = value[key].carry.filter(row => recent(row, at));
    }
    if (Array.isArray(value?.carry)) value.carry = value.carry.filter(row => recent(row, at));
    return value;
  }
  function pointOf(point) {
    return { timestamp: point.timestamp, totalPnl: amount(point.totalPnl), realizedPnl: amount(point.realizedPnl), unrealizedPnl: amount(point.unrealizedPnl) };
  }

  function saveSnapshot(address, input) {
    address = addressOf(address);
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.source !== 'live' || addressOf(input.address) !== address) throw new StoreError('只能保存该钱包的真实数据快照。', 'invalid_snapshot');
    const sourceAt = Date.parse(input.fetchedAt);
    if (!Number.isFinite(sourceAt)) throw new StoreError('快照必须具有有效的原始 fetchedAt。', 'invalid_snapshot');
    const at = clock();
    const existing = query.snapshot.get(address);
    if (existing && existing.source_at > sourceAt) return false;
    const payload = trimSnapshot(input, at);
    const points = [...payload.history, ...(payload.historyAll || [])];
    // Keep one copy of points in their indexed table, not a large JSON array every minute.
    payload.history = []; delete payload.historyAll;
    transaction(() => {
      query.putSnapshot.run(address, JSON.stringify(payload), Math.trunc(sourceAt), Math.trunc(at.ms));
      for (const point of points) query.putPoint.run(address, point.timestamp, JSON.stringify(pointOf(point)), Math.trunc(sourceAt));
    });
    return true;
  }

  function getSnapshot(address, range = '1d') {
    address = addressOf(address);
    if (!RANGES.has(range)) throw new StoreError('无效的统计周期。', 'invalid_range');
    const row = query.snapshot.get(address);
    if (!row) return null;
    const at = clock();
    const payload = trimSnapshot(JSON.parse(row.payload), at);
    const historyAll = query.points.all(address, at.cutoff, at.seconds + 300).map(row => JSON.parse(row.payload));
    const periods = {};
    for (const key of ['1d', '1w', '1m']) {
      const original = payload.periods?.[key] || (payload.period?.range === key ? payload.period : null);
      periods[key] = original ? clone(original) : calculatePeriod(historyAll, key, payload.historySourceFidelity, payload.summary?.observedAt, at.seconds);
      const observation = [periods[key].end, periods[key].observedAt].filter(timestamp);
      periods[key].stale = Boolean(periods[key].stale) || (observation.length > 0 && at.seconds - Math.min(...observation) > 7200);
    }
    const summary = payload.summary || {};
    const period = range === 'all' ? {
      range, start: null, end: summary.observedAt ?? null, totalPnl: amount(summary.totalPnl), realizedPnl: amount(summary.realizedPnl), unrealizedPnl: amount(summary.unrealizedPnl),
      complete: [summary.totalPnl, summary.realizedPnl, summary.unrealizedPnl].every(value => amount(value) !== null),
      reason: `全历史累计为最后官方摘要；本地原始曲线仅保留最近${retentionDays}天。`, sourceFidelity: payload.historySourceFidelity, observedAt: summary.observedAt ?? null,
      stale: timestamp(summary.observedAt) && at.seconds - summary.observedAt > 7200,
    } : periods[range];
    return { ...payload, range, period, periods, historyAll,
      history: range === 'all' ? historyAll : historyAll.filter(point => timestamp(period.start) && timestamp(period.end) && point.timestamp >= period.start && point.timestamp <= period.end),
      persisted: true,
    };
  }

  /** Each input batch contains whole timestamp buckets, including every identical fill. */
  function ingestActivityGroups(address, rows) {
    address = addressOf(address);
    if (!Array.isArray(rows)) throw new TypeError('交易批次必须为数组。');
    const at = clock();
    const counts = new Map();
    const result = { inserted: 0, updated: 0, ignored: 0, unchanged: 0 };
    transaction(() => {
      for (const row of rows) {
        if (!recent(row, at)) { result.ignored++; continue; }
        const contentKey = typeof row.contentKey === 'string' && row.contentKey ? row.contentKey : JSON.stringify([row.transactionHash, row.timestamp, row.type, row.side, row.slug, row.outcome, row.price, row.size, row.amount, row.isCombo]);
        const key = JSON.stringify([row.timestamp, contentKey]);
        const occurrence = counts.get(key) || 0;
        counts.set(key, occurrence + 1);
        const id = `local-${createHash('sha256').update(JSON.stringify([address, row.timestamp, contentKey, occurrence])).digest('hex')}`;
        const payload = JSON.stringify({ ...row, contentKey, id });
        const previous = query.activity.get(address, row.timestamp, contentKey, occurrence);
        if (!previous) result.inserted++;
        else if (previous.payload === payload) { result.unchanged++; continue; }
        else result.updated++;
        query.putActivity.run(address, row.timestamp, contentKey, occurrence, id, payload);
      }
      query.putSync.run(address, new Date(at.ms).toISOString());
    });
    return result;
  }
  function encodeCursor(value) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `local:${payload}.${signature}`;
  }
  function decodeCursor(cursor, address, limit) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^local:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const [raw, signature] = cursor.slice(6).split('.');
      const expected = createHmac('sha256', secret).update(raw).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (value.v !== 1 || value.address !== address || value.limit !== limit || !timestamp(value.timestamp) || !/^local-[0-9a-f]{64}$/.test(value.id)) throw new Error();
      return value;
    } catch { throw new StoreError('本地交易分页游标无效或不属于当前钱包，请重新加载。'); }
  }
  function readActivities(address, cursor = null, limit = 100) {
    address = addressOf(address);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new StoreError('每页数量必须为 1 至 1000。', 'invalid_limit');
    const anchor = cursor == null ? null : decodeCursor(cursor, address, limit);
    const at = clock();
    const rows = query.feed.all(address, at.cutoff, at.seconds + 300, anchor?.timestamp ?? null, anchor?.timestamp ?? null, anchor?.timestamp ?? null, anchor?.id ?? null, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const fetchedAt = query.sync.get(address)?.fetched_at || null;
    return { activity: page.map(row => JSON.parse(row.payload)), pagination: { hasMore,
      nextCursor: hasMore ? encodeCursor({ v: 1, address, limit, timestamp: last.timestamp, id: last.id }) : null }, fetchedAt,
      retention: { days: retentionDays, cutoff: at.cutoff } };
  }
  function saveState(address, state) {
    address = addressOf(address);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('采集状态必须为对象。');
    const at = clock();
    query.putState.run(address, JSON.stringify(trimState(state, at)), Math.trunc(at.ms));
  }
  function getState(address) {
    const row = query.state.get(addressOf(address));
    return row ? trimState(JSON.parse(row.payload), clock()) : null;
  }
  function prune() {
    const at = clock();
    const removed = transaction(() => {
      const activities = db.prepare('DELETE FROM activities WHERE timestamp < ?').run(at.cutoff).changes;
      const points = db.prepare('DELETE FROM pnl_points WHERE timestamp < ?').run(at.cutoff).changes;
      for (const row of db.prepare('SELECT address,payload FROM snapshots').all()) db.prepare('UPDATE snapshots SET payload=? WHERE address=?').run(JSON.stringify(trimSnapshot(JSON.parse(row.payload), at)), row.address);
      for (const row of db.prepare('SELECT address,payload FROM collector_states').all()) db.prepare('UPDATE collector_states SET payload=? WHERE address=?').run(JSON.stringify(trimState(JSON.parse(row.payload), at)), row.address);
      return { activities: Number(activities), points: Number(points), cutoff: at.cutoff };
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(200); PRAGMA wal_checkpoint(TRUNCATE);');
    return removed;
  }
  function stats() {
    const fileBytes = file => { try { return statSync(file).size; } catch { return 0; } };
    const count = table => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return { retentionDays, cutoff: clock().cutoff, wallets: count('snapshots'), activities: count('activities'), pnlPoints: count('pnl_points'), states: count('collector_states'),
      bytes: filename === ':memory:' ? 0 : fileBytes(filename) + fileBytes(`${filename}-wal`) + fileBytes(`${filename}-shm`) };
  }
  function close() { if (!closed) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); closed = true; } }
  return { saveSnapshot, getSnapshot, ingestActivityGroups, readActivities, saveState, getState, prune, stats, close };
}
