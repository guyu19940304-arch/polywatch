import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { PNL_BASIS, calculatePeriod, calculateProfilePeriod, pnlIsStale } from './polymarket.mjs';

const DAY = 86400;
const RANGES = new Set(['1d', '1w', '1m', 'all']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const LEGACY_BASIS = 'polymarket-position-pnl';
const basisOf = payload => payload.historyPnlBasis || payload.pnlBasis || payload.summary?.pnlBasis || LEGACY_BASIS;
// Versioned, lossless encoding; small records stay plain JSON. Old JSON remains readable.
function encodePayload(value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) < 512) return json;
  const compressed = `z1:${deflateRawSync(json).toString('base64')}`;
  return Buffer.byteLength(compressed) + 32 < Buffer.byteLength(json) ? compressed : json;
}
function decodePayload(value) {
  return JSON.parse(value.startsWith('z1:') ? inflateRawSync(Buffer.from(value.slice(3), 'base64')).toString() : value);
}
function activityPayload(row) {
  const { id, contentKey, ...payload } = row;
  return encodePayload(payload);
}
function decodeActivity(row) { return { ...decodePayload(row.payload), contentKey: row.content_key, id: row.id }; }
function stableJSON(value) {
  if (Array.isArray(value)) return value.map(stableJSON);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJSON(value[key])]));
  return value;
}
function logicalRow(table, row) {
  const value = { ...row };
  if (table === 'metadata' && value.key === 'schema_version') value.value = '2';
  if (table === 'pnl_points' && !value.basis) value.basis = LEGACY_BASIS;
  if ('payload' in value) value.payload = table === 'activities' ? decodeActivity(value) : decodePayload(value.payload);
  return JSON.stringify(stableJSON(value));
}

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
  const hasMetadata = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='metadata'").get();
  const existingVersion = hasMetadata ? db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value : null;
  if (existingVersion && !['1', '2'].includes(existingVersion)) { db.close(); throw new Error('数据库版本不受支持，禁止覆盖已有数据。'); }
  db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    PRAGMA journal_size_limit = 16777216;
    PRAGMA synchronous = NORMAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS snapshots (address TEXT PRIMARY KEY, payload TEXT NOT NULL, source_at INTEGER NOT NULL, saved_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS pnl_points (address TEXT NOT NULL, basis TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, source_at INTEGER NOT NULL, PRIMARY KEY(address, basis, timestamp)) WITHOUT ROWID, STRICT;
    CREATE TABLE IF NOT EXISTS activities (address TEXT NOT NULL, timestamp INTEGER NOT NULL, content_key TEXT NOT NULL, occurrence INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(address, timestamp, content_key, occurrence)) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS activity_id ON activities(address, id);
    CREATE INDEX IF NOT EXISTS activity_feed ON activities(address, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS activity_expiry ON activities(timestamp);
    CREATE INDEX IF NOT EXISTS pnl_expiry ON pnl_points(timestamp);
    CREATE TABLE IF NOT EXISTS collector_states (address TEXT PRIMARY KEY, payload TEXT NOT NULL, saved_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS activity_sync (address TEXT PRIMARY KEY, fetched_at TEXT NOT NULL) STRICT;`);
  const schema = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
  if (schema && !['1', '2'].includes(schema.value)) { db.close(); throw new Error('数据库版本不受支持，禁止覆盖已有数据。'); }
  if (!db.prepare('PRAGMA table_info(pnl_points)').all().some(column => column.name === 'basis')) {
    // Only the small point table is migrated online. Large activity tables are never rebuilt on startup.
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE pnl_points_v2 (address TEXT NOT NULL, basis TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, source_at INTEGER NOT NULL, PRIMARY KEY(address,basis,timestamp)) WITHOUT ROWID, STRICT;
      INSERT INTO pnl_points_v2 SELECT address,'${LEGACY_BASIS}',timestamp,payload,source_at FROM pnl_points;
      DROP TABLE pnl_points;
      ALTER TABLE pnl_points_v2 RENAME TO pnl_points;
      CREATE INDEX pnl_expiry ON pnl_points(timestamp);
      COMMIT;`);
  }
  db.prepare("INSERT INTO metadata(key,value) VALUES ('schema_version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value != excluded.value").run();
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('cursor_secret',?)").run(randomBytes(32).toString('hex'));
  const secret = Buffer.from(db.prepare("SELECT value FROM metadata WHERE key = 'cursor_secret'").get().value, 'hex');
  const query = {
    snapshot: db.prepare('SELECT payload, source_at FROM snapshots WHERE address=?'),
    putSnapshot: db.prepare('INSERT INTO snapshots(address,payload,source_at,saved_at) VALUES (?,?,?,?) ON CONFLICT(address) DO UPDATE SET payload=excluded.payload,source_at=excluded.source_at,saved_at=excluded.saved_at WHERE excluded.source_at != snapshots.source_at OR excluded.payload != snapshots.payload'),
    putPoint: db.prepare('INSERT INTO pnl_points(address,basis,timestamp,payload,source_at) VALUES (?,?,?,?,?) ON CONFLICT(address,basis,timestamp) DO UPDATE SET payload=excluded.payload,source_at=excluded.source_at WHERE excluded.source_at >= pnl_points.source_at AND excluded.payload != pnl_points.payload'),
    points: db.prepare('SELECT payload FROM pnl_points WHERE address=? AND basis=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp'),
    activity: db.prepare('SELECT payload FROM activities WHERE address=? AND timestamp=? AND content_key=? AND occurrence=?'),
    putActivity: db.prepare('INSERT INTO activities(address,timestamp,content_key,occurrence,id,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(address,timestamp,content_key,occurrence) DO UPDATE SET payload=excluded.payload'),
    feed: db.prepare('SELECT timestamp,id,content_key,payload FROM activities WHERE address=? AND timestamp>=? AND timestamp<=? AND (? IS NULL OR timestamp<? OR (timestamp=? AND id<?)) ORDER BY timestamp DESC,id DESC LIMIT ?'),
    state: db.prepare('SELECT payload FROM collector_states WHERE address=?'),
    putState: db.prepare('INSERT INTO collector_states(address,payload,saved_at) VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET payload=excluded.payload,saved_at=excluded.saved_at WHERE excluded.payload != collector_states.payload'),
    sync: db.prepare('SELECT fetched_at FROM activity_sync WHERE address=?'),
    putSync: db.prepare('INSERT INTO activity_sync(address,fetched_at) VALUES (?,?) ON CONFLICT(address) DO UPDATE SET fetched_at=excluded.fetched_at WHERE excluded.fetched_at != activity_sync.fetched_at'),
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
    if (payload.historyByRange && typeof payload.historyByRange === 'object') payload.historyByRange = Object.fromEntries(
      Object.entries(payload.historyByRange).filter(([range, rows]) => RANGES.has(range) && Array.isArray(rows)).map(([range, rows]) => [range, rows.filter(row => recent(row, at))]));
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
    const points = [...payload.history, ...(payload.historyAll || []), ...Object.values(payload.historyByRange || {}).flat()];
    const basis = basisOf(payload);
    payload.historyPnlBasis = basis;
    // Keep one copy of points in their indexed table, not a large JSON array every minute.
    payload.history = []; delete payload.historyAll;
    transaction(() => {
      query.putSnapshot.run(address, encodePayload(payload), Math.trunc(sourceAt), Math.trunc(at.ms));
      for (const point of points) query.putPoint.run(address, basis, point.timestamp, JSON.stringify(pointOf(point)), Math.trunc(sourceAt));
    });
    return true;
  }

  function getSnapshot(address, range = '1d') {
    address = addressOf(address);
    if (!RANGES.has(range)) throw new StoreError('无效的统计周期。', 'invalid_range');
    const row = query.snapshot.get(address);
    if (!row) return null;
    const at = clock();
    const payload = trimSnapshot(decodePayload(row.payload), at);
    const oldHistoryBasis = basisOf(payload);
    const oldStatsBasis = payload.summary?.pnlBasis || payload.pnlBasis || LEGACY_BASIS;
    const migrationReason = '盈亏口径升级中：旧持仓口径仅在数据库保留，等待官网 trade_pnl 新快照，暂不展示旧金额。';
    if (oldStatsBasis !== PNL_BASIS) {
      payload.summary = { ...payload.summary, totalPnl: null, realizedPnl: null, unrealizedPnl: null, pnlBasis: PNL_BASIS };
      payload.pnlBasis = PNL_BASIS;
      payload.sections = { ...payload.sections, stats: 'error' };
      payload.sectionFetchedAt = { ...payload.sectionFetchedAt, stats: null };
    }
    if (oldHistoryBasis !== PNL_BASIS) {
      payload.history = []; payload.historyByRange = {}; payload.periods = {}; payload.period = null;
      payload.historyPnlBasis = PNL_BASIS;
      payload.sections = { ...payload.sections, history: 'error' };
      payload.sectionFetchedAt = { ...payload.sectionFetchedAt, history: null };
    }
    if (oldStatsBasis !== PNL_BASIS || oldHistoryBasis !== PNL_BASIS) payload.warnings.push(migrationReason);
    const historyAll = oldHistoryBasis !== PNL_BASIS ? [] : Array.isArray(payload.historyByRange?.all) ? payload.historyByRange.all
      : query.points.all(address, oldHistoryBasis, at.cutoff, at.seconds + 300).map(row => decodePayload(row.payload));
    const periods = {};
    for (const key of ['1d', '1w', '1m']) {
      const original = payload.periods?.[key] || (payload.period?.range === key ? payload.period : null);
      periods[key] = original ? clone(original) : basisOf(payload) === 'polymarket-trade-pnl'
        ? calculateProfilePeriod(payload.historyByRange?.[key] || [], key, payload.historySourceFidelity, payload.summary?.observedAt, at.seconds)
        : calculatePeriod(historyAll, key, payload.historySourceFidelity, payload.summary?.observedAt, at.seconds);
      periods[key].stale = Boolean(periods[key].stale) || pnlIsStale(periods[key].observedAt, periods[key].sourceFidelity || payload.historySourceFidelity, at.seconds);
      if (oldHistoryBasis !== PNL_BASIS) periods[key].reason = migrationReason;
    }
    const summary = payload.summary || {};
    const period = range === 'all' ? {
      range, start: null, end: summary.observedAt ?? null, totalPnl: amount(summary.totalPnl), realizedPnl: amount(summary.realizedPnl), unrealizedPnl: amount(summary.unrealizedPnl),
      complete: amount(summary.totalPnl) !== null, pnlBasis: summary.pnlBasis || payload.pnlBasis || PNL_BASIS,
      reason: `全历史累计为最后官方摘要；本地原始曲线仅保留最近${retentionDays}天。`, sourceFidelity: payload.historySourceFidelity, observedAt: summary.observedAt ?? null,
      stale: pnlIsStale(summary.observedAt, payload.historySourceFidelity, at.seconds),
    } : periods[range];
    return { ...payload, range, period, periods, historyAll,
      history: Array.isArray(payload.historyByRange?.[range]) ? payload.historyByRange[range]
        : range === 'all' ? historyAll : historyAll.filter(point => timestamp(period.start) && timestamp(period.end) && point.timestamp >= period.start && point.timestamp <= period.end),
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
        const payload = activityPayload(row);
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
    return { activity: page.map(decodeActivity), pagination: { hasMore,
      nextCursor: hasMore ? encodeCursor({ v: 1, address, limit, timestamp: last.timestamp, id: last.id }) : null }, fetchedAt,
      retention: { days: retentionDays, cutoff: at.cutoff } };
  }
  function saveState(address, state) {
    address = addressOf(address);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('采集状态必须为对象。');
    const at = clock();
    query.putState.run(address, encodePayload(trimState(state, at)), Math.trunc(at.ms));
  }
  function getState(address) {
    const row = query.state.get(addressOf(address));
    return row ? trimState(decodePayload(row.payload), clock()) : null;
  }
  function prune() {
    const at = clock();
    const removed = transaction(() => {
      const activities = db.prepare('DELETE FROM activities WHERE timestamp < ?').run(at.cutoff).changes;
      const points = db.prepare('DELETE FROM pnl_points WHERE timestamp < ?').run(at.cutoff).changes;
      for (const row of db.prepare('SELECT address,payload FROM snapshots').all()) {
        const payload = encodePayload(trimSnapshot(decodePayload(row.payload), at));
        if (payload !== row.payload) db.prepare('UPDATE snapshots SET payload=? WHERE address=?').run(payload, row.address);
      }
      for (const row of db.prepare('SELECT address,payload FROM collector_states').all()) {
        const payload = encodePayload(trimState(decodePayload(row.payload), at));
        if (payload !== row.payload) db.prepare('UPDATE collector_states SET payload=? WHERE address=?').run(payload, row.address);
      }
      return { activities: Number(activities), points: Number(points), cutoff: at.cutoff };
    });
    // Incremental vacuum can emit one row per page. Drain it; exec() may stop early.
    // Reclaim at most 16 MiB / 100 ms per pass, never run a full VACUUM on user data.
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const freeBefore = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const budget = Math.min(freeBefore, Math.floor(16 * 1024 * 1024 / pageSize));
    const deadline = performance.now() + 100;
    if (budget && db.prepare('PRAGMA auto_vacuum').get().auto_vacuum === 2) {
      for (const row of db.prepare(`PRAGMA incremental_vacuum(${budget})`).iterate()) { if (performance.now() >= deadline) break; }
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    removed.reclaimedPages = freeBefore - db.prepare('PRAGMA freelist_count').get().freelist_count;
    removed.checkpointBusy = Boolean(checkpoint.busy);
    return removed;
  }
  function stats() {
    const fileBytes = file => { try { return statSync(file).size; } catch { return 0; } };
    const count = table => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
    const freePages = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
    const databaseBytes = filename === ':memory:' ? 0 : fileBytes(filename);
    const walBytes = filename === ':memory:' ? 0 : fileBytes(`${filename}-wal`);
    const shmBytes = filename === ':memory:' ? 0 : fileBytes(`${filename}-shm`);
    return { retentionDays, cutoff: clock().cutoff, wallets: count('snapshots'), activities: count('activities'), pnlPoints: count('pnl_points'), states: count('collector_states'),
      pageSize, pageCount, freePages, reusableBytes: freePages * pageSize, databaseBytes, walBytes, shmBytes,
      bytes: databaseBytes + walBytes + shmBytes };
  }
  function close() { if (!closed) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); closed = true; } }
  return { saveSnapshot, getSnapshot, ingestActivityGroups, readActivities, saveState, getState, prune, stats, close };
}

/** Offline, copy-only compaction. Never replace, prune, VACUUM, or write the source. */
export function compactStore({ path, outputPath, availableBytes = directory => {
  const space = statfsSync(directory); return Number(space.bavail) * Number(space.bsize);
} } = {}) {
  if (!path || !outputPath) throw new Error('必须指定原数据库与新的输出路径。');
  const sourcePath = resolve(path), targetPath = resolve(outputPath);
  if (sourcePath === targetPath || existsSync(targetPath) || existsSync(`${targetPath}-wal`) || existsSync(`${targetPath}-shm`)) throw new Error('压缩输出必须为不存在的新文件，禁止覆盖原数据库。');
  const sourceFile = statSync(sourcePath);
  if (!sourceFile.isFile()) throw new Error('原数据库必须为普通文件。');
  const walSize = () => { try { return statSync(`${sourcePath}-wal`).size; } catch { return 0; } };
  if (walSize()) throw new Error('原数据库存在未收束的 WAL；请先正常停止服务并关闭数据库，再进行离线压缩。');
  mkdirSync(dirname(targetPath), { recursive: true });
  // Conservative: reserve the current DB size plus 64 MiB, even though the output is usually smaller.
  const requiredBytes = sourceFile.size + 64 * 1024 * 1024;
  if (availableBytes(dirname(targetPath)) < requiredBytes) throw new Error(`输出目录可用空间不足：至少预留 ${requiredBytes} 字节；请使用其他磁盘，原数据库未修改。`);
  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
  let target;
  try {
    const schema = source.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value;
    if (!['1', '2'].includes(schema)) throw new Error('原数据库版本不受支持。');
    const initialized = createStore({ path: targetPath }); initialized.close();
    target = new DatabaseSync(targetPath);
    // A new output file needs no large rollback image; avoid a second full copy in its WAL.
    target.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    source.exec('BEGIN');
    const counts = {}, contentDigests = {};
    for (const table of ['metadata', 'snapshots', 'pnl_points', 'activities', 'collector_states', 'activity_sync']) {
      let count = 0;
      let insert;
      const order = table === 'metadata' ? 'key' : table === 'activities' ? 'address,timestamp,content_key,occurrence'
        : table === 'pnl_points' ? `address,${source.prepare('PRAGMA table_info(pnl_points)').all().some(column => column.name === 'basis') ? 'basis,' : ''}timestamp` : 'address';
      const sourceDigest = createHash('sha256');
      for (const row of source.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
        sourceDigest.update(logicalRow(table, row)).update('\n');
        const value = { ...row };
        if (table === 'metadata' && value.key === 'schema_version') value.value = '2';
        if (table === 'activities') value.payload = activityPayload(decodeActivity(value));
        else if ('payload' in value) value.payload = encodePayload(decodePayload(value.payload));
        if (table === 'pnl_points' && !value.basis) value.basis = LEGACY_BASIS;
        const keys = Object.keys(value);
        insert ||= target.prepare(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
        insert.run(...keys.map(key => value[key]));
        count++;
      }
      counts[table] = count;
      if (Number(target.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) !== count) throw new Error(`压缩校验失败：${table} 记录数不符；原数据库保留。`);
      const outputDigest = createHash('sha256');
      const targetOrder = table === 'pnl_points' ? 'address,basis,timestamp' : order;
      for (const row of target.prepare(`SELECT * FROM ${table} ORDER BY ${targetOrder}`).iterate()) outputDigest.update(logicalRow(table, row)).update('\n');
      const sourceHash = sourceDigest.digest('hex'), outputHash = outputDigest.digest('hex');
      if (sourceHash !== outputHash) throw new Error(`压缩校验失败：${table} 逻辑内容摘要不符；原数据库保留。`);
      contentDigests[table] = { source: sourceHash, output: outputHash, equal: true };
    }
    source.exec('COMMIT');
    if (walSize() || statSync(sourcePath).mtimeMs !== sourceFile.mtimeMs || statSync(sourcePath).size !== sourceFile.size) throw new Error('压缩期间原数据库发生变化；请停止服务后重试，禁止替换原库。');
    target.exec('COMMIT');
    const integrity = target.prepare('PRAGMA integrity_check').all();
    if (integrity.some(row => row.integrity_check !== 'ok')) throw new Error('输出数据库完整性校验失败，禁止替换原库。');
    // The application enables WAL on the next open; this finished copy has no WAL sidecar.
    target.close(); target = null;
    return { sourcePath, targetPath, sourceBytes: sourceFile.size, outputBytes: statSync(targetPath).size, counts, contentDigests,
      sourceUnchanged: true, replaced: false };
  } finally {
    target?.close();
    source.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command, path, outputPath] = process.argv;
  if (command !== 'compact' || !path || !outputPath) {
    console.error('用法（先停止服务）：node server/store.mjs compact <原数据库> <新的输出数据库>');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(compactStore({ path, outputPath }), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
