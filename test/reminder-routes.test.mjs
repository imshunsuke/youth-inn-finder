import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './helpers/d1.mjs';
import { handleReminderRequest } from '../src/http/reminder-routes.mjs';

const env = { APP_SECRET: 'unit-test-secret-with-32-bytes-minimum', BREVO_API_KEY: 'fake-test-key', MAIL_FROM: 'sender@example.test', PUBLIC_URL: 'https://inn.example.test' };
const clock = () => new Date('2026-10-13T04:00:00Z');
function request(path, method = 'GET', body, extra = {}) {
  return new Request(`https://inn.example.test${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('disabled configuration is explicit, unknown path falls through, and GET cannot verify/delete', async (t) => {
  const db = createTestDb(); t.after(() => db.close()); await applyMigrations(db);
  assert.equal(await handleReminderRequest(request('/api/calendar')), null);
  const disabled = await handleReminderRequest(request('/api/reminders', 'POST', { email: 'one@example.test', conditions: { date: '2026-10-15' } }), { db });
  assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, 'REMINDERS_UNAVAILABLE');
  const scanned = await handleReminderRequest(request('/api/reminders/verify?token=anything'), { db, env, clock });
  assert.equal(scanned.status, 405);
  const noAuth = await handleReminderRequest(request('/api/reminders'), { db, env, clock }); assert.equal(noAuth.status, 401);
});

test('HTTP verified management flow uses Bearer, exposes no owner email, and validates origin/body', async (t) => {
  const db = createTestDb(); t.after(() => db.close()); await applyMigrations(db);
  const sent = []; const options = { db, env, clock, mail: { send: async (mail) => sent.push(mail) } };
  let response = await handleReminderRequest(request('/api/reminders', 'POST', { email: 'one@example.test', conditions: { date: '2026-10-15' } }), options);
  assert.equal(response.status, 202); assert.equal(sent.length, 1);
  const token = sent[0].text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  response = await handleReminderRequest(request('/api/reminders/verify', 'POST', { token }), options);
  assert.equal(response.status, 200); const verified = await response.json(); const id = verified.data[0].id;
  const authorization = `Bearer ${verified.managementToken}`;
  response = await handleReminderRequest(request('/api/reminders', 'GET', undefined, { authorization }), options);
  assert.equal(response.status, 200); assert.equal((await response.json()).data[0].email, undefined);
  response = await handleReminderRequest(request(`/api/reminders/${id}`, 'PATCH', { status: 'paused' }, { authorization }), options);
  assert.equal(response.status, 200); assert.equal((await response.json()).data.status, 'paused');
  response = await handleReminderRequest(request(`/api/reminders/${id}`, 'DELETE', undefined, { authorization }), options);
  assert.equal(response.status, 200);
  response = await handleReminderRequest(request('/api/reminders/access', 'POST', { email: 'absent@example.test' }, { origin: 'https://evil.example' }), options);
  assert.equal(response.status, 403);
  response = await handleReminderRequest(new Request('https://inn.example.test/api/reminders', { method: 'POST', body: 'x'.repeat(8193), headers: { 'content-type': 'application/json' } }), options);
  assert.equal(response.status, 413);
  response = await handleReminderRequest(new Request('https://inn.example.test/api/reminders', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }), options);
  assert.equal(response.status, 400);
  response = await handleReminderRequest(new Request('https://inn.example.test/api/reminders', { method: 'POST', body: 'hello' }), options);
  assert.equal(response.status, 415);
});

test('public creation rejects a continuous-stay reminder without a station before queuing mail', async (t) => {
  const db = createTestDb(); t.after(() => db.close()); await applyMigrations(db);
  const sent = []; const options = { db, env, clock, mail: { send: async (mail) => sent.push(mail) } };
  const response = await handleReminderRequest(request('/api/reminders', 'POST', {
    email: 'one@example.test', conditions: { date: '2026-10-15', endDate: '2026-10-17' },
  }), options);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, '连续入住提醒请选择一个驿站');
  assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').first()).n, 0);
});

test('HTTP Bearer management survives disabled mail; create/access/verify still return 503', async (t) => {
  const db = createTestDb(); t.after(() => db.close()); await applyMigrations(db);
  const mutableEnv = { ...env }; const sent = [];
  const options = { db, env: mutableEnv, clock, mail: { send: async (mail) => sent.push(mail) } };
  async function verifiedOwner(email) {
    const created = await handleReminderRequest(request('/api/reminders', 'POST', { email, conditions: { date: '2026-10-15' } }), options);
    assert.equal(created.status, 202);
    const token = sent.at(-1).text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
    const verified = await handleReminderRequest(request('/api/reminders/verify', 'POST', { token }), options);
    assert.equal(verified.status, 200); return verified.json();
  }
  const a = await verifiedOwner('one@example.test'); const b = await verifiedOwner('two@example.test');
  delete mutableEnv.BREVO_API_KEY;
  const authorization = `Bearer ${a.managementToken}`;
  let response = await handleReminderRequest(request('/api/reminders', 'GET', undefined, { authorization }), options);
  assert.equal(response.status, 200); assert.equal((await response.json()).data[0].id, a.data[0].id);
  response = await handleReminderRequest(request(`/api/reminders/${b.data[0].id}`, 'PATCH', { status: 'paused' }, { authorization }), options);
  assert.equal(response.status, 404);
  response = await handleReminderRequest(request(`/api/reminders/${a.data[0].id}`, 'PATCH', { status: 'paused' }, { authorization }), options);
  assert.equal(response.status, 200); assert.equal((await response.json()).data.status, 'paused');
  response = await handleReminderRequest(request(`/api/reminders/${a.data[0].id}`, 'PATCH', { conditions: { date: '2026-10-16', minCount: 2 } }, { authorization }), options);
  assert.equal(response.status, 200); assert.equal((await response.json()).data.conditions.minCount, 2);
  for (const [path, body] of [['/api/reminders', { email: 'new@example.test', conditions: { date: '2026-10-15' } }],
    ['/api/reminders/access', { email: 'one@example.test' }], ['/api/reminders/verify', { token: a.managementToken }]]) {
    response = await handleReminderRequest(request(path, 'POST', body), options);
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'REMINDERS_UNAVAILABLE');
  }
  response = await handleReminderRequest(request(`/api/reminders/${b.data[0].id}`, 'DELETE', undefined, { authorization }), options);
  assert.equal(response.status, 404);
  response = await handleReminderRequest(request(`/api/reminders/${a.data[0].id}`, 'DELETE', undefined, { authorization }), options);
  assert.equal(response.status, 200);
  response = await handleReminderRequest(request('/api/reminders', 'GET', undefined, { authorization: `Bearer ${b.managementToken}` }), options);
  assert.equal(response.status, 200); assert.equal((await response.json()).data.length, 1);
});
