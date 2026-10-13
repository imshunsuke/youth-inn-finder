import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './helpers/d1.mjs';
import { createReminderStore } from '../src/infrastructure/reminder-store.mjs';
import { createReminderService } from '../src/application/reminder-service.mjs';
import { flushOutbox } from '../src/application/monitor.mjs';
import { digestToken, decryptPayload } from '../src/infrastructure/mail.mjs';

async function fixture(t) {
  const db = createTestDb(); t.after(() => db.close()); await applyMigrations(db);
  let time = Date.parse('2026-10-13T04:00:00Z'); const clock = () => new Date(time);
  const env = { APP_SECRET: 'unit-test-secret-with-32-bytes-minimum', BREVO_API_KEY: 'fake-test-key', MAIL_FROM: 'sender@example.test', PUBLIC_URL: 'https://inn.example.test' };
  const store = createReminderStore(db, { clock }); const service = createReminderService({ store, env, clock });
  const sent = []; const mail = { send: async (payload) => { sent.push(payload); } };
  const create = (email = 'one@example.test', date = '2026-10-15', ip = '127.0.0.1') => service.create({ email, conditions: { date } }, { ip });
  const flush = () => flushOutbox({ store, env, clock, mail });
  const verify = async (email = 'one@example.test', ip = '127.0.0.1') => {
    await create(email, '2026-10-15', ip); await flush();
    return service.verify({ token: sent.at(-1).text.match(/#verify=([A-Za-z0-9_-]+)/)[1] }, { ip });
  };
  return { db, store, service, env, clock, sent, mail, create, flush, verify, advance: (ms) => { time += ms; } };
}

test('durable pending/verify/manage flow stores only token digests and authenticated ciphertext', async (t) => {
  const f = await fixture(t); await f.create();
  const row = await f.db.prepare('SELECT * FROM reminders').first(); assert.equal(row.status, 'pending');
  assert.deepEqual(await f.store.due(), []);
  const outbox = await f.db.prepare('SELECT * FROM reminder_outbox').first();
  const payload = await decryptPayload(outbox.payload_ciphertext, f.env.APP_SECRET);
  const token = payload.text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  assert.ok(!outbox.payload_ciphertext.includes(token));
  const tokenRow = await f.db.prepare('SELECT * FROM reminder_tokens').first();
  assert.equal(tokenRow.digest, await digestToken(token)); assert.equal(tokenRow.purpose, 'verify');
  const verified = await f.service.verify({ token });
  assert.equal(verified.data[0].status, 'active'); assert.equal(verified.managementToken.length, 43);
  await assert.rejects(f.service.verify({ token }), { code: 'INVALID_TOKEN' });
  const list = await f.service.list(verified.managementToken);
  assert.equal(list.data.length, 1); assert.equal(list.data[0].conditions.date, '2026-10-15');
  assert.equal(list.data[0].email, undefined);
  assert.equal((await f.db.prepare('SELECT payload_ciphertext FROM reminder_outbox').first()).payload_ciphertext, null);
});

test('verification is atomic under concurrent replay and an expired token cannot activate', async (t) => {
  const f = await fixture(t); await f.create(); await f.flush();
  const token = f.sent[0].text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  const results = await Promise.allSettled([f.service.verify({ token }), f.service.verify({ token })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM reminder_tokens WHERE purpose='manage'").first()).count, 1);
  await f.create('two@example.test', '2026-10-15', 'different-ip'); await f.flush();
  const old = f.sent.at(-1).text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  f.advance(31 * 60_000);
  await assert.rejects(f.service.verify({ token: old }), { code: 'INVALID_TOKEN' });
  assert.equal((await f.db.prepare("SELECT status FROM reminders WHERE email='two@example.test'").first()).status, 'pending');
});

test('management capability cannot change a different email; edits version and delete erases owner records', async (t) => {
  const f = await fixture(t); const a = await f.verify(); const b = await f.verify('two@example.test', 'different-ip');
  const first = a.data[0]; const second = b.data[0];
  await assert.rejects(f.service.update(a.managementToken, second.id, { status: 'paused' }), { code: 'NOT_FOUND' });
  const paused = await f.service.update(a.managementToken, first.id, { paused: true });
  assert.equal(paused.data.status, 'paused'); assert.equal(paused.data.conditionVersion, 2);
  const changed = await f.service.update(a.managementToken, first.id, { status: 'active', conditions: { date: '2026-10-16', minCount: 2 } });
  assert.equal(changed.data.conditions.minCount, 2); assert.equal(changed.data.conditionVersion, 3);
  await assert.rejects(f.service.cancel(a.managementToken, second.id), { code: 'NOT_FOUND' });
  await f.service.cancel(a.managementToken, first.id);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM reminders WHERE email='one@example.test'").first()).count, 0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM reminder_tokens WHERE email='one@example.test'").first()).count, 0);
  assert.equal((await f.service.list(b.managementToken)).data.length, 1);
});

test('access has non-enumerating responses, resend cooldown, per-email cap and persistent limits', async (t) => {
  const f = await fixture(t);
  const absent = await f.service.requestAccess({ email: 'absent@example.test' }, { ip: 'absent-ip' });
  const pending = await f.create(); assert.deepEqual(absent, pending);
  await f.create();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM reminder_outbox').first()).count, 1);
  f.advance(60 * 60_000); await f.create('one@example.test', '2026-10-16');
  f.advance(6 * 60_000); await f.create('one@example.test', '2026-10-17');
  f.advance(6 * 60_000); await f.create('one@example.test', '2026-10-18');
  await assert.rejects(f.create('one@example.test', '2026-10-19'), { code: 'RATE_LIMITED' });
  f.advance(60 * 60_000); await f.create('one@example.test', '2026-10-18');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM reminders WHERE email='one@example.test'").first()).count, 3);
  const newStore = createReminderStore(f.db, { clock: f.clock });
  assert.equal(await newStore.consumeRate('shared', 1, 60_000), true);
  assert.equal(await f.store.consumeRate('shared', 1, 60_000), false);
});

test('outbox leases survive service recreation and daily budget reservations are atomic', async (t) => {
  const f = await fixture(t); await f.create();
  const [a, b] = await Promise.all([f.store.claimOutbox(5), f.store.claimOutbox(5)]);
  assert.equal(a.length + b.length, 1);
  assert.equal((await createReminderStore(f.db, { clock: f.clock }).claimOutbox()).length, 0);
  f.advance(61_000); const recovered = await f.store.claimOutbox(); assert.equal(recovered.length, 1); assert.equal(recovered[0].attempts, 2);
  const limits = { totalLimit: 2, notificationLimit: 1, notification: true, day: '2026-10-13' };
  assert.equal(await f.store.reserveMailBudget('one', limits), true);
  assert.equal(await f.store.reserveMailBudget('one', limits), false);
  const results = await Promise.all([f.store.reserveMailBudget('two', limits), f.store.reserveMailBudget('three', limits)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await f.db.prepare("SELECT count FROM reminder_mail_budgets WHERE budget_key='all:2026-10-13'").first()).count, 2);
});

test('public total capacity is atomic, explicit, email-independent and expired pending slots are reusable', async (t) => {
  const f = await fixture(t); f.env.REMINDERS_TOTAL_LIMIT = '1';
  const results = await Promise.allSettled([f.create('one@example.test', '2026-10-15', 'ip-one'), f.create('two@example.test', '2026-10-15', 'ip-two')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REMINDER_CAPACITY');
  const existing = await f.db.prepare('SELECT email FROM reminders').first();
  await assert.rejects(f.create(existing.email, '2026-10-15', 'ip-three'), { code: 'REMINDER_CAPACITY' });
  await assert.rejects(f.create('unknown@example.test', '2026-10-15', 'ip-four'), { code: 'REMINDER_CAPACITY' });
  f.advance(31 * 60_000);
  assert.equal(await f.store.hasCapacity(1), true);
  await f.create(existing.email, '2026-10-15', 'ip-five');
  assert.equal(await f.store.hasCapacity(1), false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 1);
});

test('token purposes remain isolated and management access expires after thirty days', async (t) => {
  const f = await fixture(t); await f.create(); await f.flush();
  const verificationToken = f.sent[0].text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  await assert.rejects(f.service.list(verificationToken), { code: 'INVALID_TOKEN' });
  const owner = await f.service.verify({ token: verificationToken });
  await assert.rejects(f.service.verify({ token: owner.managementToken }), { code: 'INVALID_TOKEN' });
  f.advance(30 * 24 * 60 * 60_000 + 1);
  await assert.rejects(f.service.list(owner.managementToken), { code: 'INVALID_TOKEN' });
});

test('creation and condition edits enforce station selection for continuous-stay reminders', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.create({ email: 'one@example.test', conditions: { date: '2026-10-15', endDate: '2026-10-17' } }),
    { code: 'INVALID_INPUT', message: '连续入住提醒请选择一个驿站' });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 0);
  const owner = await f.verify();
  await assert.rejects(f.service.update(owner.managementToken, owner.data[0].id, {
    conditions: { date: '2026-10-15', endDate: '2026-10-17' },
  }), { code: 'INVALID_INPUT', message: '连续入住提醒请选择一个驿站' });
  const changed = await f.service.update(owner.managementToken, owner.data[0].id, {
    conditions: { date: '2026-10-15', endDate: '2026-10-17', stationId: '64' },
  });
  assert.equal(changed.data.conditions.stationId, '64');
  assert.equal(changed.data.conditions.endDate, '2026-10-17');
});

test('existing management tokens keep working without mail credentials while sending actions stay disabled', async (t) => {
  const f = await fixture(t); const a = await f.verify(); const b = await f.verify('two@example.test', 'different-ip');
  delete f.env.BREVO_API_KEY;
  assert.equal((await f.service.list(a.managementToken)).data[0].id, a.data[0].id);
  await assert.rejects(f.service.update(a.managementToken, b.data[0].id, { status: 'paused' }), { code: 'NOT_FOUND' });
  const paused = await f.service.update(a.managementToken, a.data[0].id, { status: 'paused' });
  assert.equal(paused.data.status, 'paused');
  const edited = await f.service.update(a.managementToken, a.data[0].id, { conditions: { date: '2026-10-16', minCount: 2 } });
  assert.equal(edited.data.conditions.minCount, 2); assert.equal(edited.data.conditions.date, '2026-10-16');
  await assert.rejects(f.create('new@example.test'), { code: 'REMINDERS_UNAVAILABLE' });
  await assert.rejects(f.service.requestAccess({ email: 'one@example.test' }), { code: 'REMINDERS_UNAVAILABLE' });
  await assert.rejects(f.service.verify({ token: a.managementToken }), { code: 'REMINDERS_UNAVAILABLE' });
  await assert.rejects(f.service.cancel(a.managementToken, b.data[0].id), { code: 'NOT_FOUND' });
  await f.service.cancel(a.managementToken, a.data[0].id);
  assert.equal((await f.service.list(b.managementToken)).data.length, 1);
});
