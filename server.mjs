import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalDatabase } from './src/development/d1.mjs';
import { migrateLocalDatabase } from './src/development/migrate.mjs';
import { createApp } from './src/http/app.mjs';
import { runScheduled } from './src/worker.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = resolve(projectRoot, 'public');
const stateRoot = resolve(process.env.STATE_DIRECTORY || resolve(projectRoot, '.data'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是有效端口');
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
let appSecret = process.env.APP_SECRET;
if (!appSecret) {
  const secretPath = resolve(stateRoot, 'local-app-secret');
  try { appSecret = (await readFile(secretPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    appSecret = randomBytes(32).toString('base64url');
    await writeFile(secretPath, appSecret, { mode: 0o600, flag: 'wx' });
  }
}
const db = createLocalDatabase(resolve(stateRoot, 'youth-inn.sqlite'));
await migrateLocalDatabase(db);
const env = { ...process.env, APP_SECRET: appSecret, DB: db };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
async function assets(request) {
  try {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.split('/').some((part) => part.startsWith('.'))) return new Response('Not found', { status: 404 });
    const path = await realpath(resolve(publicRoot, pathname === '/' ? 'index.html' : `.${pathname}`));
    if (!path.startsWith(publicRoot + sep)) return new Response('Not found', { status: 404 });
    const type = types[extname(path)];
    if (!type) return new Response('Not found', { status: 404 });
    const content = await readFile(path);
    return new Response(request.method === 'HEAD' ? null : content,
      { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
  } catch { return new Response('Not found', { status: 404 }); }
}
const app = createApp({ env, assetHandler: assets, interactiveCollection: true });
let localOrigin;
const server = createServer(async (incoming, outgoing) => {
  try {
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) throw new Error('Invalid request target');
    const chunks = []; let length = 0; let oversized = false;
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 8192) { oversized = true; chunks.length = 0; } else if (!oversized) chunks.push(chunk);
    }
    if (oversized) { outgoing.writeHead(413); outgoing.end('Request too large'); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    // Forwarded IP headers are only trusted inside Cloudflare, never from local clients.
    headers.delete('cf-connecting-ip');
    const method = incoming.method || 'GET';
    const response = await app(new Request(new URL(incoming.url, localOrigin), {
      method, headers, ...(['GET', 'HEAD'].includes(method) || length === 0 ? {} : { body: Buffer.concat(chunks) }),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    outgoing.end(JSON.stringify({ error: '请求格式无效', code: 'BAD_REQUEST' }));
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可使用 PORT=3001 npm start` : '本地服务启动失败');
  db.close(); process.exitCode = 1;
});
await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, host, ready); });
const actualPort = server.address().port;
localOrigin = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
env.PUBLIC_URL ||= localOrigin;
console.log(`青年驿站已启动: ${localOrigin}`);
console.log('Ctrl+C 停止；首次启动正在准备房源数据。未配置邮件时不会发送邮件。');
let running = null; let stopping = false;
function tick() {
  if (running || stopping || process.env.DISABLE_COLLECTION === 'true') return;
  running = runScheduled(env).then((result) => {
    if (result.collection?.failed) console.error('房源更新暂时失败，将自动重试。');
  }).catch(() => console.error('后台任务暂时失败，将自动重试。')).finally(() => { running = null; });
}
tick();
const interval = setInterval(tick, 60_000);
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(interval);
  await new Promise((resolve) => server.close(resolve));
  await running;
  db.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
