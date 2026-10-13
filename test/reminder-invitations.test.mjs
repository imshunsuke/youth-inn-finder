import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './helpers/d1.mjs';
import { createReminderStore } from '../src/infrastructure/reminder-store.mjs';
import { createReminderService } from '../src/application/reminder-service.mjs';
import { decryptPayload, digestToken, randomToken } from '../src/infrastructure/mail.mjs';
import { flushOutbox, createMonitor } from '../src/application/monitor.mjs';

async function fixture(t) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let time = Date.parse('2026-10-13T04:00:00Z'); const clock = () => new Date(time);
  const env = { APP_SECRET: 'synthetic-invitation-secret-at-least-32-bytes', BREVO_API_KEY: 'fake-only-key',
    MAIL_FROM: 'synthetic@example.test', PUBLIC_URL: 'https://inn.example.test', INVITATION_REQUIRED: 'true',
    REMINDERS_TOTAL_LIMIT: '10', REMINDERS_PER_EMAIL: '2' };
  const store = createReminderStore(db, { clock }); const service = createReminderService({ store, env, clock });
  const sent = []; const mail = { send: async (value) => { sent.push(value); } };
  async function invitation({ email = null, state = 'available' } = {}) {
    const code = randomToken(); const id = crypto.randomUUID(); const created = clock().toISOString();
    await db.prepare(`INSERT INTO reminder_invitations(id,code_digest,state,email,reservation_until,code_expires_at,bound_at,created_at)
      VALUES (?,?,?,?,NULL,?,?,?)`).bind(id, await digestToken(code), state, email,
        new Date(time + 90 * 24 * 60 * 60_000).toISOString(), state === 'bound' ? created : null, created).run();
    return { id, code };
  }
  const create = (code, email = 'one@example.test', date = '2026-10-15', token) =>
    service.create({ email, inviteCode: code, conditions: { date } }, { ip: email, token });
  async function verify(email) {
    const job = await db.prepare(`SELECT payload_ciphertext FROM reminder_outbox WHERE recipient_email=? AND kind='verify'
      AND status='pending' ORDER BY created_at DESC LIMIT 1`).bind(email).first();
    const payload = await decryptPayload(job.payload_ciphertext, env.APP_SECRET);
    const token = payload.text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
    return { ...await service.verify({ token }, { ip: email }), verificationToken: token };
  }
  return { db, store, service, clock, env, mail, sent, invitation, create, verify, advance: (ms) => { time += ms; } };
}

test('private creation needs an invitation, binds only after verification, then accepts the existing Bearer', async (t) => {
  const f = await fixture(t); const invite = await f.invitation();
  await assert.rejects(f.create(undefined), { code: 'INVITATION_REQUIRED' });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').first()).n, 0);
  await f.create(invite.code);
  assert.equal((await f.db.prepare('SELECT state FROM reminder_invitations').first()).state, 'reserved');
  const owner = await f.verify('one@example.test');
  const invitation = await f.store.invitationForOwner('one@example.test'); assert.equal(invitation.state, 'bound');
  assert.equal(invitation.reservation_until, null);
  await assert.rejects(f.create(invite.code, 'other@example.test'), { code: 'INVITATION_REQUIRED' });
  await assert.rejects(f.create(undefined, 'other@example.test', '2026-10-16', owner.managementToken), { code: 'INVITATION_REQUIRED' });
  f.advance(6 * 60_000);
  await f.create(undefined, 'one@example.test', '2026-10-16', owner.managementToken);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 2);
});

test('one invitation cannot reserve two emails concurrently and the database limits invitation rows to five', async (t) => {
  const f = await fixture(t); const invite = await f.invitation();
  const results = await Promise.allSettled([f.create(invite.code, 'one@example.test'), f.create(invite.code, 'two@example.test')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 1);
  for (let i = 0; i < 4; i++) await f.invitation();
  await assert.rejects(f.invitation(), /INVITATION_CAPACITY/);
  const row = await f.db.prepare('SELECT * FROM reminder_invitations LIMIT 1').first();
  await f.db.prepare(`INSERT OR IGNORE INTO reminder_invitations(id,code_digest,state,code_expires_at,created_at) VALUES (?,?,?,?,?)`)
    .bind(row.id, row.code_digest, 'available', row.code_expires_at, row.created_at).run();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminder_invitations').first()).n, 5);
});

test('two invitations cannot reserve the same email, and expired reservation releases without accepting an old token', async (t) => {
  const f = await fixture(t); const a = await f.invitation(); const b = await f.invitation();
  // Isolate atomic admission from the independent email resend cooldown.
  const service = createReminderService({ store: { ...f.store, consumeRate: async () => true }, env: f.env, clock: f.clock });
  const make = (inviteCode) => service.create({ email: 'one@example.test', inviteCode, conditions: { date: '2026-10-15' } });
  const results = await Promise.allSettled([make(a.code), make(b.code)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const row = await f.db.prepare("SELECT id FROM reminder_invitations WHERE state='reserved'").first();
  const used = row.id === a.id ? a : b;
  const job = await f.db.prepare("SELECT payload_ciphertext FROM reminder_outbox WHERE kind='verify'").first();
  const oldToken = (await decryptPayload(job.payload_ciphertext, f.env.APP_SECRET)).text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  f.advance(31 * 60_000);
  await f.create(used.code, 'new@example.test');
  await assert.rejects(f.service.verify({ token: oldToken }), { code: 'INVALID_TOKEN' });
  const bound = await f.verify('new@example.test'); assert.equal(bound.data.length, 1);
  assert.equal((await f.store.invitationForOwner('new@example.test')).id, used.id);
});

test('an invited owner has a hard two-reminder limit despite oversized configuration and concurrent creation', async (t) => {
  const f = await fixture(t); f.env.REMINDERS_PER_EMAIL = '100'; f.env.REMINDERS_TOTAL_LIMIT = '100';
  const invite = await f.invitation(); await f.create(invite.code); const owner = await f.verify('one@example.test');
  f.advance(6 * 60_000);
  const service = createReminderService({ store: { ...f.store, consumeRate: async () => true }, env: f.env, clock: f.clock });
  const make = (date) => service.create({ email: 'one@example.test', conditions: { date } }, { token: owner.managementToken });
  const results = await Promise.allSettled([make('2026-10-16'), make('2026-10-17')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REMINDER_LIMIT');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 2);
});

test('bound invitation owners can recover access after deleting all reminders; outsiders get the same generic response', async (t) => {
  const f = await fixture(t); const invite = await f.invitation(); await f.create(invite.code); const owner = await f.verify('one@example.test');
  await f.service.cancel(owner.managementToken, owner.data[0].id);
  f.advance(6 * 60_000);
  const own = await f.service.requestAccess({ email: 'one@example.test' }, { ip: 'one' });
  const other = await f.service.requestAccess({ email: 'other@example.test' }, { ip: 'other' });
  assert.deepEqual(own, other);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_outbox WHERE kind='access'").first()).n, 1);
  const flushed = await flushOutbox({ store: f.store, env: f.env, mail: f.mail, clock: f.clock });
  assert.equal(flushed.sent, 1);
  const token = f.sent[0].text.match(/#manage=([A-Za-z0-9_-]+)/)[1];
  assert.deepEqual((await f.service.list(token)).data, []);
  f.advance(6 * 60_000); await f.create(undefined, 'one@example.test', '2026-10-16', token);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 1);
});

test('legacy management remains compatible and an attached paused reminder is never automatically activated', async (t) => {
  const f = await fixture(t); f.env.INVITATION_REQUIRED = 'false';
  await f.create(undefined); const owner = await f.verify('one@example.test');
  await f.service.update(owner.managementToken, owner.data[0].id, { status: 'paused' });
  const invitation = await f.invitation({ email: 'one@example.test', state: 'bound' });
  await f.db.prepare('UPDATE reminders SET invitation_id=? WHERE email=?').bind(invitation.id, 'one@example.test').run();
  f.env.INVITATION_REQUIRED = 'true';
  assert.equal((await f.service.list(owner.managementToken)).data[0].status, 'paused');
  await f.service.update(owner.managementToken, owner.data[0].id, { conditions: { date: '2026-10-16' } });
  assert.equal((await f.service.list(owner.managementToken)).data[0].status, 'paused');
  const monitor = createMonitor({ store: f.store, env: f.env, clock: f.clock, mail: f.mail,
    queryService: { findAvailable: async () => { throw new Error('Paused reminder must not query'); } } });
  assert.equal((await monitor.run({ cleanup: false })).checked, 0);
});

test('an expired duplicate pending cannot reclaim a third personal slot after two newer live reminders', async (t) => {
  const f = await fixture(t); const invite = await f.invitation();
  await f.create(invite.code); await f.verify('one@example.test');
  const originalOwner = await f.db.prepare("SELECT * FROM reminders WHERE status='active'").first();
  // Retain a separate expired pending row to exercise the resend path, while the
  // invitation is already bound to this verified owner.
  const stamp = f.clock().toISOString();
  await f.db.prepare(`INSERT INTO reminders(id,email,conditions_json,status,condition_version,created_at,updated_at,invitation_id)
    VALUES ('expired-pending',?,?, 'pending',1,?,?,?)`).bind(originalOwner.email,
      JSON.stringify({ ...JSON.parse(originalOwner.conditions_json), date: '2026-10-18' }), stamp, stamp, invite.id).run();
  f.advance(31 * 60_000);
  const manageToken = randomToken();
  await f.db.prepare(`INSERT INTO reminder_tokens(digest,purpose,email,created_at,expires_at)
    VALUES (?,'manage',?,?,?)`).bind(await digestToken(manageToken), originalOwner.email, f.clock().toISOString(),
      new Date(f.clock().getTime() + 60 * 60_000).toISOString()).run();
  await f.create(undefined, originalOwner.email, '2026-10-16', manageToken);
  f.advance(6 * 60_000);
  const before = (await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_tokens WHERE purpose='verify'").first()).n;
  await assert.rejects(f.create(undefined, originalOwner.email, '2026-10-18', manageToken), { code: 'REMINDER_LIMIT' });
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_tokens WHERE purpose='verify'").first()).n, before);
  assert.equal((await f.db.prepare("SELECT updated_at FROM reminders WHERE id='expired-pending'").first()).updated_at, stamp);
});

test('five invitations admit exactly ten live pending reminders and never a sixth person', async (t) => {
  const f = await fixture(t);
  const service = createReminderService({ store: { ...f.store, consumeRate: async () => true }, env: f.env, clock: f.clock });
  for (let i = 0; i < 5; i++) {
    const invite = await f.invitation();
    for (const date of ['2026-10-15', '2026-10-16']) await service.create({ email: `synthetic${i}@example.test`,
      inviteCode: invite.code, conditions: { date } });
  }
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 10);
  assert.equal(await f.store.hasCapacity(10), false);
  await assert.rejects(service.create({ email: 'sixth@example.test', conditions: { date: '2026-10-15' } }), { code: 'INVITATION_REQUIRED' });
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_invitations WHERE state='reserved'").first()).n, 5);
});

test('expired and revoked invitations cannot bind a recipient or activate a pending reminder', async (t) => {
  const f = await fixture(t); const expired = await f.invitation();
  await f.db.prepare('UPDATE reminder_invitations SET code_expires_at=? WHERE id=?')
    .bind('2026-10-12T00:00:00.000Z', expired.id).run();
  await assert.rejects(f.create(expired.code), { code: 'INVITATION_REQUIRED' });
  const revoked = await f.invitation(); await f.create(revoked.code);
  const job = await f.db.prepare("SELECT payload_ciphertext FROM reminder_outbox WHERE kind='verify'").first();
  const token = (await decryptPayload(job.payload_ciphertext, f.env.APP_SECRET)).text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  await f.db.prepare("UPDATE reminder_invitations SET state='revoked' WHERE id=?").bind(revoked.id).run();
  await assert.rejects(f.service.verify({ token }), { code: 'INVALID_TOKEN' });
  assert.equal((await f.db.prepare('SELECT status FROM reminders').first()).status, 'pending');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_tokens WHERE purpose='manage'").first()).n, 0);
});

test('new invitation creation plus two fake deliveries stays within the free invocation query budget', async (t) => {
  const f = await fixture(t); const code = await f.invitation();
  const earlier = await f.invitation();
  await f.create(earlier.code, 'earlier@example.test'); // Include an existing outbox item in this HTTP-sized flush.
  let statements = 0;
  const countedDb = { prepare: (...args) => { statements++; return f.db.prepare(...args); }, batch: (...args) => f.db.batch(...args) };
  const store = createReminderStore(countedDb, { clock: f.clock });
  const service = createReminderService({ store, env: f.env, clock: f.clock });
  await service.create({ email: 'one@example.test', inviteCode: code.code, conditions: { date: '2026-10-15' } });
  const flushed = await flushOutbox({ store, env: f.env, clock: f.clock, mail: f.mail, limit: 2 });
  assert.equal(flushed.sent, 2);
  assert.ok(statements + flushed.sent <= 50, `used ${statements} D1 statements + ${flushed.sent} mail fetches`);
  t.diagnostic(`invitation create + two pending verification deliveries: ${statements} D1 statements`);
});

test('verified Bearer creation activates immediately without a second verification email or resend cooldown', async (t) => {
  const f = await fixture(t); const invite = await f.invitation();
  await f.create(invite.code); const owner = await f.verify('one@example.test');
  const before = (await f.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').first()).n;
  const second = await f.create(undefined, 'one@example.test', '2026-10-16', owner.managementToken);
  assert.equal(second.data.status, 'active'); assert.equal(second.message, '提醒已启用');
  assert.equal(second.data.nextCheckAt, f.clock().toISOString());
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').first()).n, before);
  await assert.rejects(f.create(undefined, 'one@example.test', '2026-10-17', owner.managementToken), { code: 'REMINDER_LIMIT' });
});

test('owner duplicate of a paused reminder returns it without resuming or queuing mail', async (t) => {
  const f = await fixture(t); const invite = await f.invitation(); await f.create(invite.code); const owner = await f.verify('one@example.test');
  await f.service.update(owner.managementToken, owner.data[0].id, { status: 'paused' });
  const before = (await f.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').first()).n;
  const duplicate = await f.create(undefined, 'one@example.test', '2026-10-15', owner.managementToken);
  assert.equal(duplicate.data.id, owner.data[0].id); assert.equal(duplicate.data.status, 'paused');
  assert.equal(duplicate.message, '该提醒已暂停');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').first()).n, before);
});

test('owner activation of an existing pending reminder invalidates its old verification token and queued mail', async (t) => {
  const f = await fixture(t); const invite = await f.invitation(); await f.create(invite.code);
  const original = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='verify'").first();
  const oldToken = (await decryptPayload(original.payload_ciphertext, f.env.APP_SECRET)).text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
  f.advance(6 * 60_000); await f.create(invite.code, 'one@example.test', '2026-10-16');
  const owner = await f.verify('one@example.test');
  const activated = await f.create(undefined, 'one@example.test', '2026-10-15', owner.managementToken);
  assert.equal(activated.data.status, 'active'); assert.equal(activated.data.conditionVersion, 2);
  await assert.rejects(f.service.verify({ token: oldToken }), { code: 'INVALID_TOKEN' });
  const invalidated = await f.db.prepare('SELECT status,payload_ciphertext FROM reminder_outbox WHERE id=?').bind(original.id).first();
  assert.equal(invalidated.status, 'cancelled'); assert.equal(invalidated.payload_ciphertext, null);
});

test('HTTP passes Bearer through to immediate invited creation and keeps the two-reminder limit', async (t) => {
  const { handleReminderRequest } = await import('../src/http/reminder-routes.mjs');
  const f = await fixture(t); const invite = await f.invitation();
  const options = { db: f.db, env: f.env, clock: f.clock, mail: f.mail };
  const post = (path, body, token) => handleReminderRequest(new Request(`https://inn.example.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), options);
  let response = await post('/api/reminders', { email: 'one@example.test', inviteCode: invite.code, conditions: { date: '2026-10-15' } });
  assert.equal(response.status, 202); assert.equal(f.sent.length, 1);
  response = await post('/api/reminders/verify', { token: f.sent[0].text.match(/#verify=([A-Za-z0-9_-]+)/)[1] });
  assert.equal(response.status, 200); const owner = await response.json();
  response = await post('/api/reminders', { email: 'one@example.test', conditions: { date: '2026-10-16' } }, owner.managementToken);
  assert.equal(response.status, 202); assert.equal((await response.json()).data.status, 'active');
  assert.equal(f.sent.length, 1);
  response = await post('/api/reminders', { email: 'one@example.test', conditions: { date: '2026-10-17' } }, owner.managementToken);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'REMINDER_LIMIT');
  assert.equal(f.sent.length, 1);
});

test('verification resend retains its own reservation when all ten invitation slots are occupied', async (t) => {
  const f = await fixture(t);
  const service = createReminderService({ store: { ...f.store, consumeRate: async () => true }, env: f.env, clock: f.clock });
  const invitations = [];
  for (let i = 0; i < 5; i++) {
    const invite = await f.invitation(); invitations.push(invite);
    for (const date of ['2026-10-15', '2026-10-16']) await service.create({ email: `synthetic${i}@example.test`, inviteCode: invite.code, conditions: { date } });
  }
  assert.equal(await f.store.hasCapacity(10), false);
  f.advance(6 * 60_000);
  await service.create({ email: 'synthetic0@example.test', inviteCode: invitations[0].code, conditions: { date: '2026-10-15' } });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n, 10);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_tokens WHERE purpose='verify'").first()).n, 11);
});
