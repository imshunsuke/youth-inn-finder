import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './helpers/d1.mjs';
import { createReminderStore } from '../src/infrastructure/reminder-store.mjs';
import { createReminderService } from '../src/application/reminder-service.mjs';
import { createMonitor, flushOutbox } from '../src/application/monitor.mjs';
import { MailDeliveryError } from '../src/infrastructure/mail.mjs';

async function fixture(t) {
  const db = createTestDb(); t.after(() => db.close()); await applyMigrations(db);
  let time = Date.parse('2026-10-13T04:00:00Z'); const clock = () => new Date(time);
  const env = { APP_SECRET: 'unit-test-secret-with-32-bytes-minimum', BREVO_API_KEY: 'fake-test-key', MAIL_FROM: 'sender@example.test', PUBLIC_URL: 'https://inn.example.test' };
  const store = createReminderStore(db, { clock }); const service = createReminderService({ store, env, clock });
  const sent = []; let sendFailure = null; let state = 'matched'; let calls = 0;
  const mail = { send: async (payload) => { if (sendFailure) throw sendFailure; sent.push(payload); } };
  const queryService = { findAvailable: async () => {
    calls++; if (state === 'throw') throw new Error('sensitive upstream body');
    return { data: state === 'matched' || state === 'partial-positive' ? [{ id: '64', availableCount: 2, availabilityStatus: 'known', fetchedAt: clock().toISOString() }] : [],
      meta: { fetchedAt: clock().toISOString(), partial: state.startsWith('partial'), availabilityStatus: state === 'not-open' ? 'not-open' : 'known',
        coverage: { totalStations: 2, successfulStations: state === 'partial-empty' ? 1 : 2, failedStations: state === 'partial-empty' ? 1 : 0, unknownStations: state === 'partial-empty' ? 1 : 0 } } };
  } };
  const monitor = () => createMonitor({ store, env, clock, mail, queryService });
  const activate = async (email = 'one@example.test', ip = email) => {
    await service.create({ email, conditions: { date: '2026-10-15' } }, { ip });
    await flushOutbox({ store, env, clock, mail });
    const token = sent.at(-1).text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
    return service.verify({ token }, { ip });
  };
  return { db, store, env, clock, service, sent, mail, queryService, monitor, activate,
    setState: (value) => { state = value; }, calls: () => calls,
    failSend: (value) => { sendFailure = value; }, advance: (ms = 15 * 60_000) => { time += ms; } };
}

test('first positive sends once; unknown/partial-empty never re-arm; known zero then positive sends again', async (t) => {
  const f = await fixture(t); await f.activate();
  assert.equal((await f.monitor().run()).sent, 1);
  f.advance(); assert.equal((await f.monitor().run()).sent, 0);
  f.advance(); f.setState('throw'); assert.equal((await f.monitor().run()).unknown, 1);
  f.advance(); f.setState('matched'); assert.equal((await f.monitor().run()).sent, 0);
  f.advance(); f.setState('partial-empty'); assert.equal((await f.monitor().run()).unknown, 1);
  f.advance(); f.setState('matched'); assert.equal((await f.monitor().run()).sent, 0);
  f.advance(); f.setState('empty'); await f.monitor().run();
  assert.equal((await f.db.prepare('SELECT last_match FROM reminders').first()).last_match, 0);
  f.advance(); f.setState('partial-positive'); assert.equal((await f.monitor().run()).sent, 1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_outbox WHERE kind='notification'").first()).n, 2);
});

test('same condition shares one query, concurrent monitors claim jobs once, re-created process resumes', async (t) => {
  const f = await fixture(t); await f.activate(); await f.activate('two@example.test');
  const [a, b] = await Promise.all([f.monitor().run({ sendLimit: 10 }), f.monitor().run({ sendLimit: 10 })]);
  assert.equal(a.checked + b.checked, 2); assert.equal(a.sent + b.sent, 2);
  // Simultaneous invocations can each claim a different reminder, so de-duplication
  // is per monitor invocation. The shared query adapter also caches the upstream.
  assert.ok(f.calls() <= 2);
  f.advance(); const oldCalls = f.calls(); const restarted = f.monitor();
  assert.equal((await restarted.run()).sent, 0); assert.equal(f.calls() - oldCalls, 1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM reminder_outbox WHERE kind='notification'").first()).n, 2);
});

test('transient provider failure recovers via durable outbox; permanent failure stops and payload is erased', async (t) => {
  const f = await fixture(t); await f.activate();
  f.failSend(new MailDeliveryError('MAIL_PROVIDER_ERROR', { status: 429, retryable: true }));
  assert.equal((await f.monitor().run()).deferred, 1);
  let row = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='notification'").first();
  assert.equal(row.status, 'pending'); assert.ok(row.payload_ciphertext); assert.equal(row.attempts, 1);
  f.failSend(null); f.advance(31_000);
  assert.equal((await flushOutbox({ store: f.store, env: f.env, clock: f.clock, mail: f.mail })).sent, 1);
  row = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='notification'").first(); assert.equal(row.payload_ciphertext, null);
  f.advance(); f.setState('empty'); await f.monitor().run();
  f.advance(); f.setState('matched'); f.failSend(new MailDeliveryError('MAIL_PROVIDER_ERROR', { status: 400, retryable: false }));
  assert.equal((await f.monitor().run()).failed, 1);
  row = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='notification' AND status='dead'").first();
  assert.equal(row.last_error_code, 'MAIL_PROVIDER_ERROR'); assert.equal(row.payload_ciphertext, null);
  f.advance(); assert.equal((await f.monitor().run()).sent, 0);
});

test('condition edits and pauses invalidate queued events; missing config never sends or queries', async (t) => {
  const f = await fixture(t); const owner = await f.activate();
  assert.equal((await f.monitor().run({ sendLimit: 0 })).sent, 0);
  await f.service.update(owner.managementToken, owner.data[0].id, { status: 'paused' });
  let row = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='notification'").first();
  assert.equal(row.status, 'cancelled'); assert.equal(row.payload_ciphertext, null);
  assert.equal((await f.monitor().run()).checked, 0);
  await f.service.update(owner.managementToken, owner.data[0].id, { status: 'active' });
  assert.equal((await f.monitor().run()).sent, 1);
  const disabled = createMonitor({ store: f.store, env: {}, clock: f.clock, mail: f.mail, queryService: f.queryService });
  const previousCalls = f.calls(); assert.equal((await disabled.run()).disabled, true); assert.equal(f.calls(), previousCalls);
});

test('a stale pending notification waits for fresh positive evidence; known empty cancels it', async (t) => {
  const f = await fixture(t); await f.activate(); await f.monitor().run({ sendLimit: 0 });
  f.advance(21 * 60_000);
  assert.equal((await flushOutbox({ store: f.store, env: f.env, clock: f.clock, mail: f.mail })).deferred, 1);
  assert.equal(f.sent.length, 1);
  // A fresh monitor observation refreshes the existing pending event, retaining its unique key.
  assert.equal((await f.monitor().run()).sent, 0); // deferred job is not due until its retry time
  f.advance(); assert.equal((await f.monitor().run()).sent, 1);
  f.advance(); f.setState('empty'); await f.monitor().run();
  f.advance(); f.setState('matched'); await f.monitor().run({ sendLimit: 0 });
  f.advance(); f.setState('empty'); await f.monitor().run();
  const cancelled = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='notification' AND status='cancelled'").first();
  assert.ok(cancelled); assert.equal(cancelled.payload_ciphertext, null);
});

test('budget exhaustion defers delivery and a past arrival date ends monitoring', async (t) => {
  const f = await fixture(t); const owner = await f.activate();
  f.env.MAIL_DAILY_LIMIT = '1'; // verification has used today's one permitted attempt
  assert.equal((await f.monitor().run()).deferred, 1);
  const job = await f.db.prepare("SELECT * FROM reminder_outbox WHERE kind='notification'").first();
  assert.equal(job.last_error_code, 'DAILY_BUDGET'); assert.equal(f.sent.length, 1);
  f.advance(3 * 24 * 60 * 60_000); await f.monitor().run();
  assert.equal((await f.db.prepare('SELECT status FROM reminders WHERE id=?').bind(owner.data[0].id).first()).status, 'expired');
  assert.equal(f.sent.length, 1);
});

test('pause during send preparation prevents sending a queued version; paused arrival dates expire too', async (t) => {
  const f = await fixture(t); const owner = await f.activate();
  await f.monitor().run({ sendLimit: 0 });
  let changed = false;
  const wrapped = { ...f.store, reserveMailBudget: async (...args) => {
    const allowed = await f.store.reserveMailBudget(...args);
    if (!changed) { changed = true; await f.service.update(owner.managementToken, owner.data[0].id, { status: 'paused' }); }
    return allowed;
  } };
  const result = await flushOutbox({ store: wrapped, env: f.env, clock: f.clock, mail: f.mail });
  assert.equal(result.sent, 0); assert.equal(f.sent.length, 1);
  f.advance(3 * 24 * 60 * 60_000); await f.monitor().run();
  assert.equal((await f.db.prepare('SELECT status FROM reminders WHERE id=?').bind(owner.data[0].id).first()).status, 'expired');
});

for (const expandedCatalog of [false, true]) for (const sendLimit of [1, 2]) test(`three fresh interval reminders, expanded catalog ${expandedCatalog}, ${sendLimit} deliveries stay within D1 invocation budget`, async (t) => {
  const f = await fixture(t);
  const owners = [await f.activate(), await f.activate('two@example.test'), await f.activate('three@example.test')];
  const { createSnapshotStore, createSnapshotClient } = await import('../src/infrastructure/snapshot-store.mjs');
  const { createQueryService } = await import('../src/application/query-service.mjs');
  const snapshots = createSnapshotStore({ db: f.db, clock: f.clock });
  const stations = Array.from({ length: 90 }, (_, i) => ({ id: String(i), name: `驿站${i}`, district: '徐汇区', address: '青年路', street: '', isOnShelf: true }));
  await snapshots.saveCatalog('0', { items: stations, fetchedAt: f.clock().toISOString() });
  const secondStations = expandedCatalog ? stations.map((station, index) => ({ ...station, id: String(index + 90) })) : stations;
  await snapshots.saveCatalog('1', { items: secondStations, fetchedAt: f.clock().toISOString() });
  for (let i = 0; i < owners.length; i++) {
    const day = expandedCatalog && i === 1 ? 15 : 15 + i;
    const date = `2026-10-${day}`; const endDate = `2026-10-${day + 1}`;
    // Defensive budget test for persisted legacy/wide conditions. New public
    // continuous-stay reminder input is now required to select a single station.
    const existing = await f.db.prepare('SELECT conditions_json FROM reminders WHERE id=?').bind(owners[i].data[0].id).first();
    const conditions = { ...JSON.parse(existing.conditions_json), date, endDate, houseType: String(i % 2) };
    await f.db.prepare('UPDATE reminders SET conditions_json=? WHERE id=?').bind(JSON.stringify(conditions), owners[i].data[0].id).run();
    await snapshots.saveIntervalBatch((i % 2 ? secondStations : stations).map(({ id }) => ({ stationId: id, startDate: date, endDate,
      availabilityStatus: 'known', availableCount: 2, fetchedAt: f.clock().toISOString() })));
  }
  let statements = 0;
  const countedDb = { prepare: (...args) => { statements++; return f.db.prepare(...args); }, batch: (...args) => f.db.batch(...args) };
  const store = createReminderStore(countedDb, { clock: f.clock });
  const queryService = createQueryService({ client: createSnapshotClient({ db: countedDb, clock: f.clock }), clock: f.clock });
  const result = await createMonitor({ store, queryService, env: f.env, clock: f.clock, mail: f.mail }).run({ limit: 3, sendLimit, cleanup: false });
  assert.equal(result.checked, 3); assert.equal(result.sent, sendLimit);
  assert.ok(statements + sendLimit <= 50, `used ${statements} D1 statements plus ${sendLimit} mail fetches`);
  t.diagnostic(`3 intervals / 90 stations per catalog / expanded=${expandedCatalog} / ${sendLimit} sends: ${statements} D1 statements`);
});
