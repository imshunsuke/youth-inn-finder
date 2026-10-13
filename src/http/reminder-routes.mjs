import { AppError, invalidInput } from '../domain/errors.mjs';
import { reminderDisabled } from '../domain/reminders.mjs';
import { createReminderService } from '../application/reminder-service.mjs';
import { flushOutbox } from '../application/monitor.mjs';
import { createBrevoMailer } from '../infrastructure/mail.mjs';
import { createReminderStore } from '../infrastructure/reminder-store.mjs';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new AppError('请使用 JSON 请求', { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
  }
  if (Number(request.headers.get('content-length')) > 8192) throw new AppError('请求内容过大', { code: 'BODY_TOO_LARGE', status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw invalidInput('请求内容不能为空', 'body');
  let timer; let text = '';
  try {
    await Promise.race([(async () => {
      const chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 8192) { void reader.cancel(); throw new AppError('请求内容过大', { code: 'BODY_TOO_LARGE', status: 413 }); }
        chunks.push(value);
      }
      const all = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(all);
    })(), new Promise((_, reject) => { timer = setTimeout(() => {
      void reader.cancel(); reject(new AppError('请求读取超时', { code: 'REQUEST_TIMEOUT', status: 408 }));
    }, 5_000); })]);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
    return value;
  } catch (error) { if (error instanceof AppError) throw error; throw invalidInput('JSON 格式无效', 'body'); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function handleReminderRequest(request, { db, store: injectedStore, env = {}, mail: injectedMail,
  queryService, clock = () => new Date() } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/reminders' && !url.pathname.startsWith('/api/reminders/')) return null;
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new AppError('请求来源无效', { code: 'ORIGIN_REJECTED', status: 403 });
    // Sending actions validate mail configuration in the application service.
    // Bearer-authorized management only needs durable storage and a valid token.
    if (!db && !injectedStore) throw reminderDisabled();
    const store = injectedStore ?? createReminderStore(db, { clock });
    const service = createReminderService({ store, env, clock });
    const mail = injectedMail ?? createBrevoMailer({ env });
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1];
    const context = { ip: request.headers.get('cf-connecting-ip') || 'local', token: bearer };
    const path = url.pathname;
    let result;
    if (path === '/api/reminders' && request.method === 'POST') {
      result = await service.create(await readJson(request), context);
      await flushOutbox({ store, env, mail, clock, limit: 2 });
      return json(result, 202);
    }
    if (path === '/api/reminders/access' && request.method === 'POST') {
      result = await service.requestAccess(await readJson(request), context);
      await flushOutbox({ store, env, mail, clock, limit: 2 });
      return json(result, 202);
    }
    if (path === '/api/reminders/verify' && request.method === 'POST') {
      result = await service.verify(await readJson(request), context);
      // The first observation is due immediately; the regular monitor can safely
      // pick it up after verification without making this HTTP request query city-wide.
      return json(result);
    }
    if (path === '/api/reminders' && request.method === 'GET') return json(await service.list(bearer, context));
    const item = path.match(/^\/api\/reminders\/([A-Za-z0-9-]{1,128})$/);
    if (item && request.method === 'PATCH') return json(await service.update(bearer, item[1], await readJson(request), context));
    if (item && request.method === 'DELETE') return json(await service.cancel(bearer, item[1], context));
    return json({ error: '此操作需要在页面中确认', code: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET, POST, PATCH, DELETE' });
  } catch (error) {
    const known = error instanceof AppError;
    return json({ error: known ? error.message : '提醒服务暂时不可用，请稍后再试', code: known ? error.code : 'REMINDER_ERROR' },
      known ? error.status : 500, error?.status === 429 ? { 'retry-after': '300' } : {});
  }
}
