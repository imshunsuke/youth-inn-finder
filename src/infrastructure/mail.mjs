import { normalizeEmail, reminderDisabled } from '../domain/reminders.mjs';

const encoder = new TextEncoder();
let currentEncryptionKey = null;
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encrypted payload');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
export function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function digestToken(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export function validateReminderEnvironment(env = {}) {
  if (typeof env.APP_SECRET !== 'string' || encoder.encode(env.APP_SECRET).length < 32 ||
      typeof env.BREVO_API_KEY !== 'string' || !env.BREVO_API_KEY.trim()) throw reminderDisabled();
  try { normalizeEmail(env.MAIL_FROM); } catch { throw reminderDisabled(); }
  let url;
  try { url = new URL(env.PUBLIC_URL); } catch { throw reminderDisabled(); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw reminderDisabled();
  return url.origin;
}
async function encryptionKey(secret) {
  if (typeof secret !== 'string' || encoder.encode(secret).length < 32) throw reminderDisabled();
  if (currentEncryptionKey?.secret === secret) return currentEncryptionKey.promise;
  // Keep only the current secret's non-extractable key. Concurrent operations
  // share initialization; rotation replaces this entry without retaining payloads.
  const entry = { secret, promise: crypto.subtle.digest('SHA-256', encoder.encode(secret))
    .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])) };
  currentEncryptionKey = entry;
  void entry.promise.catch(() => { if (currentEncryptionKey === entry) currentEncryptionKey = null; });
  return entry.promise;
}
export async function encryptPayload(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('youth-inn-outbox-v1') },
    await encryptionKey(secret), encoder.encode(JSON.stringify(payload)));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function decryptPayload(value, secret) {
  const [version, iv, body, extra] = String(value).split('.');
  if (version !== 'v1' || extra || !iv || !body) throw new Error('Invalid encrypted payload');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode('youth-inn-outbox-v1') },
    await encryptionKey(secret), decode(body));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export class MailDeliveryError extends Error {
  constructor(code, { retryable = false, status = null } = {}) {
    super('邮件服务暂时不可用');
    this.name = 'MailDeliveryError'; this.code = code; this.retryable = retryable; this.status = status;
  }
}

export function createBrevoMailer({ env = {}, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid mail adapter');
  return Object.freeze({
    async send({ to, subject, text, eventKey }) {
      validateReminderEnvironment(env);
      const controller = new AbortController();
      let timer; let activeReader;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); void activeReader?.cancel?.().catch(() => {}); reject(new MailDeliveryError('MAIL_TIMEOUT', { retryable: true }));
      }, timeoutMs); });
      try {
        return await Promise.race([deadline, (async () => {
          const response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
            method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json', 'api-key': env.BREVO_API_KEY },
            body: JSON.stringify({ sender: { email: normalizeEmail(env.MAIL_FROM), name: env.MAIL_FROM_NAME || '青年驿站有房提醒' },
              to: [{ email: normalizeEmail(to) }], subject, textContent: text,
              headers: { 'X-Youth-Inn-Event': eventKey } }),
          });
          // Keep the deadline active while draining the response body as well.
          if (!response.ok) {
            await response.body?.cancel?.().catch(() => {});
            throw new MailDeliveryError('MAIL_PROVIDER_ERROR', { status: response.status,
              retryable: [408, 425, 429].includes(response.status) || response.status >= 500 });
          }
          const reader = response.body?.getReader?.(); activeReader = reader;
          if (reader) {
            let length = 0;
            try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
              length += chunk.value.byteLength; if (length > 65_536) { await reader.cancel(); break; } } }
            finally { reader.releaseLock(); }
          }
          return { accepted: true };
        })()]);
      } catch (error) {
        if (error instanceof MailDeliveryError) throw error;
        throw new MailDeliveryError('MAIL_NETWORK_ERROR', { retryable: true });
      } finally { clearTimeout(timer); }
    },
  });
}
