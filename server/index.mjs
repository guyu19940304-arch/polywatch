import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzip } from 'node:zlib';
import { ApiError, ADDRESS_PATTERN, createPolymarketClient } from './polymarket.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function json(response, status, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders };
  const payload = JSON.stringify(body);
  if (payload.length > 8192 && /\bgzip\b/.test(response.req?.headers['accept-encoding'] || '')) {
    gzip(payload, { level: 4 }, (error, compressed) => {
      if (response.destroyed) return;
      response.writeHead(status, error ? headers : { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      response.end(error ? payload : compressed);
    });
  } else { response.writeHead(status, headers); response.end(payload); }
}

export function monitorConfig(env = process.env) {
  if (env.MONITOR_ENABLED !== undefined && !['true', 'false'].includes(env.MONITOR_ENABLED)) throw new Error('MONITOR_ENABLED 只能为 true 或 false。');
  const enabled = env.MONITOR_ENABLED === 'true';
  const interval = (name, fallback, min, max) => { const value = Number(env[name] || fallback); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须为 ${min} 至 ${max} 毫秒。`); return value; };
  const addresses = [...new Set((env.WATCH_WALLETS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (enabled && (!addresses.length || addresses.length > 10 || addresses.some(address => !ADDRESS_PATTERN.test(address)))) throw new Error('WATCH_WALLETS 必须为1至10个有效钱包地址，以逗号分隔。');
  if (env.RETENTION_DAYS !== undefined && env.RETENTION_DAYS !== '30') throw new Error('此看板固定滚动保留30天，RETENTION_DAYS 请设为30。');
  return { enabled, addresses: enabled ? addresses : [], retentionDays: 30,
    activityIntervalMs: interval('ACTIVITY_INTERVAL_MS', 5000, 3000, 60000),
    snapshotIntervalMs: interval('SNAPSHOT_INTERVAL_MS', 60000, 15000, 300000),
    databasePath: env.DATABASE_PATH || path.join(projectRoot, 'data', 'polywatch.sqlite') };
}

export function createServer({ client = createPolymarketClient(), distDir = path.join(projectRoot, 'dist'), store = null, monitor = null, now = Date.now } = {}) {
  const monitorStatus = () => {
    const status = monitor?.status() || { enabled: false, addresses: [], wallets: [], retentionDays: 30 };
    return { ...status, activityIntervalMs: status.intervals?.activityMs ?? 5000, snapshotIntervalMs: status.intervals?.snapshotMs ?? 60000 };
  };
  const monitored = address => store && monitorStatus().enabled && monitorStatus().addresses.includes(address.toLowerCase());
  const activityMeta = (address, status) => {
    const worker = status.wallets.find(row => row.address === address.toLowerCase());
    return { error: worker?.activityError || (worker?.head?.blocked ? worker.head.gap || '当前交易同步被阻塞。' : null) || status.monitorError || null,
      gap: worker?.coverage?.currentGap || (!worker?.backfill?.complete ? '最近30天公开交易历史正在逐页补齐。' : null),
      stale: worker?.activityAt == null || now() - worker.activityAt > status.activityIntervalMs * 3, retentionDays: 30 };
  };
  return http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: '仅支持读取数据。', code: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health') return json(response, 200, { status: 'ok', service: 'polymarket-wallet-monitor', version: 2, persistent: Boolean(store) });
      if (url.pathname === '/api/monitor') return json(response, 200, monitorStatus());
      const windowMatch = url.pathname.match(/^\/api\/wallet\/([^/]+)\/window\/([^/]+)$/);
      if (windowMatch) return json(response, 200, await client.window(decodeURIComponent(windowMatch[1]), decodeURIComponent(windowMatch[2])));
      const match = url.pathname.match(/^\/api\/wallet\/([^/]+)(\/activity)?$/);
      if (match) {
        const address = decodeURIComponent(match[1]);
        if (monitored(address)) {
          if (!ADDRESS_PATTERN.test(address)) throw new ApiError('无效的钱包地址。', 400, 'invalid_address');
          if (match[2]) return json(response, 200, { ...store.readActivities(address, url.searchParams.get('cursor')), monitor: activityMeta(address, monitorStatus()) });
          const range = url.searchParams.get('range') || '1m';
          if (!['1d', '1w', '1m', 'all'].includes(range)) throw new ApiError('无效的统计周期。', 400, 'invalid_range');
          const saved = store.getSnapshot(address, range);
          if (!saved) throw new ApiError('后台正在首次同步钱包数据，请稍候；同步完成后会自动显示。', 503, 'initial_sync', 5);
          const feed = store.readActivities(address);
          const status = monitorStatus();
          const worker = status.wallets.find(row => row.address === address.toLowerCase());
          const activityStatus = activityMeta(address, status);
          const stale = now() - Date.parse(saved.fetchedAt) > status.snapshotIntervalMs * 3;
          const warnings = [...saved.warnings];
          if (stale) warnings.push(`后台快照暂未更新，当前展示 ${saved.fetchedAt} 保存的数据。`);
          if (activityStatus.gap) warnings.push(activityStatus.gap);
          if (activityStatus.error) warnings.push(`后台交易更新：${activityStatus.error}`);
          if (activityStatus.stale) warnings.push('后台成交检查暂未更新，当前显示已保存的记录。');
          if (worker?.snapshotError) warnings.push(`后台盈亏快照：${worker.snapshotError}`);
          return json(response, 200, { ...saved,
            activity: feed.activity, activityPagination: feed.pagination, activityFetchedAt: feed.fetchedAt,
            sections: { ...saved.sections, activity: activityStatus.error || activityStatus.stale ? 'error' : 'ok' },
            warnings: [...new Set(warnings)],
            storage: { persisted: true, retentionDays: 30, stale, snapshotAt: saved.fetchedAt, activityAt: feed.fetchedAt },
          });
        }
        const data = match[2] ? await client.activity(address, url.searchParams.get('cursor')) : await client.wallet(address, url.searchParams.get('range') || '1m');
        return json(response, 200, data);
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在。', code: 'not_found' });
      const decoded = decodeURIComponent(url.pathname);
      const root = path.resolve(distDir);
      let target = path.resolve(root, `.${decoded}`);
      if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target))) return json(response, 403, { error: '访问被拒绝。', code: 'forbidden' });
      try {
        if (!(await stat(target)).isFile()) target = path.join(root, 'index.html');
      } catch {
        if (path.extname(decoded)) return json(response, 404, { error: '文件不存在。', code: 'not_found' });
        target = path.join(root, 'index.html');
      }
      let contents;
      try { contents = await readFile(target); }
      catch { return json(response, 404, { error: '前端尚未构建，请运行 npm run build，或使用开发服务器。', code: 'frontend_not_built' }); }
      const headers = { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=3600' };
      if (contents.length > 4096 && /\.(?:js|css|html|svg|json)$/.test(target) && /\bgzip\b/.test(request.headers['accept-encoding'] || '') && request.method !== 'HEAD') {
        gzip(contents, { level: 6 }, (error, compressed) => { if (response.destroyed) return; response.writeHead(200, error ? headers : { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }); response.end(error ? contents : compressed); });
      } else { response.writeHead(200, headers); response.end(request.method === 'HEAD' ? undefined : contents); }
    } catch (error) {
      const known = error instanceof ApiError || error?.name === 'StoreError';
      json(response, known ? error.status : 500, { error: known ? error.message : '服务暂时无法处理请求，请稍后重试。', code: known ? error.code : 'internal_error' }, known && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
  });
}

export async function createRuntime({ env = process.env } = {}) {
  const config = monitorConfig(env);
  const client = createPolymarketClient({ activityTtl: config.enabled ? 3000 : 10000, snapshotTtl: Math.min(config.snapshotIntervalMs, 60000) });
  let store = null, monitor = null;
  if (config.enabled) {
    const [{ createStore }, { createMonitor }] = await Promise.all([import('./store.mjs'), import('./monitor.mjs')]);
    store = createStore({ path: config.databasePath, retentionDays: 30 });
    try { monitor = createMonitor({ client, store, addresses: config.addresses, activityIntervalMs: config.activityIntervalMs, snapshotIntervalMs: config.snapshotIntervalMs }); monitor.start(); }
    catch (error) { store.close(); throw error; }
  }
  const server = createServer({ client, store, monitor });
  let stopped = false;
  return { server, store, monitor, async stop() {
    if (stopped) return; stopped = true;
    const closing = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    await monitor?.stop(); await closing; store?.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const runtime = await createRuntime();
  runtime.server.on('error', async error => { console.error(error.message); await runtime.stop(); process.exitCode = 1; });
  runtime.server.listen(port, host, () => console.log(`Polymarket wallet monitor: http://${host}:${port}${runtime.monitor ? ' · 后台采集开启 · 保留30天' : ''}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void runtime.stop().then(() => { process.exitCode = 0; }); });
}
