import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrevoMailer, decryptPayload, encryptPayload, randomToken, digestToken, validateReminderEnvironment } from '../src/infrastructure/mail.mjs';
const env = { APP_SECRET: 'unit-test-secret-with-32-bytes-minimum', BREVO_API_KEY: 'fake-test-key-never-log', MAIL_FROM: 'sender@example.test', PUBLIC_URL: 'https://inn.example.test' };
const message = { to: 'one@example.test', subject: 'test', text: 'test', eventKey: 'test-event' };

test('outbox encryption is authenticated and random; token digest and payload reveal no token', async () => {
  const token = randomToken(); assert.equal(token.length, 43);
  const payload = { text: `https://inn.example.test/#manage=${token}` };
  const a = await encryptPayload(payload, env.APP_SECRET); const b = await encryptPayload(payload, env.APP_SECRET);
  assert.notEqual(a, b); assert.ok(!a.includes(token)); assert.notEqual(await digestToken(token), token);
  assert.deepEqual(await decryptPayload(a, env.APP_SECRET), payload);
  const parts = a.split('.'); parts[1] = `${parts[1][0] === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`;
  await assert.rejects(decryptPayload(parts.join('.'), env.APP_SECRET));
  await assert.rejects(decryptPayload(a, 'another-secret-with-at-least-32-bytes'));
  assert.throws(() => validateReminderEnvironment({ ...env, APP_SECRET: 'too-short' }));
  assert.throws(() => validateReminderEnvironment({ ...env, PUBLIC_URL: 'http://public.example.test' }));
  assert.throws(() => validateReminderEnvironment({ ...env, MAIL_FROM: 'bad\n@example.test' }));
});

test('Brevo adapter uses fixed endpoint and server credentials; distinguishes retryable/permanent failures', async () => {
  const seen = [];
  const mail = createBrevoMailer({ env, fetchImpl: async (url, options) => { seen.push({ url, options }); return new Response('{"messageId":"fake"}', { status: 201 }); } });
  assert.equal((await mail.send(message)).accepted, true);
  assert.equal(seen[0].url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(seen[0].options.headers['api-key'], env.BREVO_API_KEY);
  assert.equal(JSON.parse(seen[0].options.body).headers['X-Youth-Inn-Event'], 'test-event');
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    const failing = createBrevoMailer({ env, fetchImpl: async () => new Response('provider-secret-body', { status }) });
    await assert.rejects(failing.send(message), (error) => error.code === 'MAIL_PROVIDER_ERROR' &&
      error.retryable === (status === 429 || status >= 500) && !error.message.includes('provider-secret-body'));
  }
});

test('mail request and response body both have deadlines; network failures do not expose raw errors', async () => {
  const requestStall = createBrevoMailer({ env, timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(requestStall.send(message), { code: 'MAIL_TIMEOUT', retryable: true });
  const bodyStall = createBrevoMailer({ env, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 201 }) });
  await assert.rejects(bodyStall.send(message), { code: 'MAIL_TIMEOUT', retryable: true });
  const network = createBrevoMailer({ env, fetchImpl: async () => { throw new Error('key-secret-do-not-expose'); } });
  await assert.rejects(network.send(message), (error) => error.code === 'MAIL_NETWORK_ERROR' && !error.message.includes('key-secret'));
});

test('default mail fetch preserves the Web runtime global receiver', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  try {
    globalThis.fetch = function (url, options) {
      assert.equal(this, globalThis);
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(options.method, 'POST');
      called++;
      return Promise.resolve(new Response('{"messageId":"fake-only"}', { status: 201 }));
    };
    assert.equal((await createBrevoMailer({ env }).send(message)).accepted, true);
    assert.equal(called, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('encryption shares one non-extractable key, replaces it on rotation, and keeps independent IVs', { concurrency: false }, async () => {
  const subtle = crypto.subtle;
  const original = subtle.importKey;
  const descriptor = Object.getOwnPropertyDescriptor(subtle, 'importKey');
  let imports = 0; const importedKeys = [];
  try {
    subtle.importKey = function (...args) {
      imports++;
      return Reflect.apply(original, this, args).then((key) => { importedKeys.push(key); return key; });
    };
    const a = 'synthetic-cache-secret-A-at-least-32-bytes';
    const b = 'synthetic-cache-secret-B-at-least-32-bytes';
    const payload = { text: 'synthetic payload; no credentials' };
    const [first, second] = await Promise.all([encryptPayload(payload, a), encryptPayload(payload, a)]);
    assert.equal(imports, 1);
    assert.notEqual(first.split('.')[1], second.split('.')[1]);
    assert.deepEqual(await decryptPayload(first, a), payload);
    assert.equal(imports, 1);
    const rotated = await encryptPayload(payload, b);
    assert.equal(imports, 2);
    await assert.rejects(decryptPayload(first, b));
    assert.deepEqual(await decryptPayload(rotated, b), payload);
    assert.equal(imports, 2);
    assert.deepEqual(await decryptPayload(first, a), payload);
    assert.equal(imports, 3); // Only the latest secret is cached, not a history of keys.
    assert.ok(importedKeys.every((key) => key.extractable === false));
  } finally {
    if (descriptor) Object.defineProperty(subtle, 'importKey', descriptor); else delete subtle.importKey;
  }
});

test('a failed shared key initialization can be retried for the same secret', { concurrency: false }, async () => {
  const subtle = crypto.subtle;
  const original = subtle.importKey;
  const descriptor = Object.getOwnPropertyDescriptor(subtle, 'importKey');
  let attempts = 0;
  try {
    subtle.importKey = function (...args) {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('synthetic initialization failure'));
      return Reflect.apply(original, this, args);
    };
    const secret = 'synthetic-cache-retry-secret-at-least-32-bytes';
    const results = await Promise.allSettled([encryptPayload({ text: 'one' }, secret), encryptPayload({ text: 'two' }, secret)]);
    assert.equal(attempts, 1); assert.ok(results.every((result) => result.status === 'rejected'));
    const encrypted = await encryptPayload({ text: 'retry' }, secret);
    assert.equal(attempts, 2);
    assert.deepEqual(await decryptPayload(encrypted, secret), { text: 'retry' });
  } finally {
    if (descriptor) Object.defineProperty(subtle, 'importKey', descriptor); else delete subtle.importKey;
  }
});
