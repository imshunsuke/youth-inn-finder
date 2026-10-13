import { todayInShanghai } from '../domain/dates.mjs';
import { evaluateObservation, OBSERVATION_MAX_AGE_MS } from '../domain/reminders.mjs';
import { createBrevoMailer, decryptPayload, digestToken, validateReminderEnvironment } from '../infrastructure/mail.mjs';
import { createReminderStore } from '../infrastructure/reminder-store.mjs';
import { configuredLimit, createMailJob } from './reminder-service.mjs';

export async function flushOutbox({ store, env = {}, mail = createBrevoMailer({ env }), clock = () => new Date(), limit = 5 } = {}) {
  validateReminderEnvironment(env);
  const timestamp = () => new Date(clock()).toISOString();
  const summary = { sent: 0, deferred: 0, failed: 0, cancelled: 0 };
  const boundedLimit = Math.min(Math.max(limit, 0), 20);
  for (let index = 0; index < boundedLimit; index++) {
    // Lease one item at a time: a slow provider must not use up the leases of
    // other items while they wait in this invocation's local send queue.
    const [job] = await store.claimOutbox(1, timestamp());
    if (!job) break;
    if (!await store.canSend(job, timestamp())) {
      await store.finish(job, { status: 'cancelled', errorCode: 'INVALIDATED' }, timestamp()); summary.cancelled++; continue;
    }
    if (job.kind === 'notification' && (!job.observed_at ||
        Date.parse(timestamp()) - Date.parse(job.observed_at) > OBSERVATION_MAX_AGE_MS ||
        Date.parse(job.observed_at) > Date.parse(timestamp()) + 60_000)) {
      // Wait for fresh positive evidence. Never send an old availability snapshot.
      await store.finish(job, { status: 'pending', errorCode: 'OBSERVATION_STALE',
        retryAt: new Date(Date.parse(timestamp()) + 15 * 60_000).toISOString() }, timestamp());
      summary.deferred++; continue;
    }
    let payload;
    try { payload = await decryptPayload(job.payload_ciphertext, env.APP_SECRET); }
    catch {
      await store.finish(job, { status: 'dead', errorCode: 'PAYLOAD_UNREADABLE' }, timestamp()); summary.failed++; continue;
    }
    // Attempts, including transient provider failures, consume the daily budget.
    // Defaults leave 50 of Brevo's advertised 300/day for account-wide other mail.
    // The provider's actual account quota remains authoritative.
    if (!await store.reserveMailBudget(await digestToken(job.recipient_email), {
      totalLimit: configuredLimit(env.MAIL_DAILY_LIMIT, 250, 250),
      notificationLimit: configuredLimit(env.MAIL_NOTIFICATION_DAILY_LIMIT, 8, 50),
      notification: job.kind === 'notification', day: todayInShanghai(clock),
    }, timestamp())) {
      const nextDay = new Date(`${todayInShanghai(clock)}T16:00:00.000Z`).toISOString();
      await store.finish(job, { status: 'pending', errorCode: 'DAILY_BUDGET', retryAt: nextDay }, timestamp());
      summary.deferred++; continue;
    }
    // Recheck after decryption/budget acquisition so a changed reminder cannot
    // knowingly send an already invalidated version. Provider in-flight delivery
    // cannot be revoked, and a lost provider response can still duplicate a mail.
    if (!await store.canSend(job, timestamp())) {
      await store.finish(job, { status: 'cancelled', errorCode: 'INVALIDATED' }, timestamp()); summary.cancelled++; continue;
    }
    try {
      await mail.send({ ...payload, eventKey: job.event_key });
      await store.finish(job, { status: 'sent' }, timestamp()); summary.sent++;
    } catch (error) {
      const retry = error?.retryable === true && job.attempts < 6;
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, job.attempts - 1));
      const errorCode = ['MAIL_TIMEOUT', 'MAIL_NETWORK_ERROR', 'MAIL_PROVIDER_ERROR'].includes(error?.code) ? error.code : 'MAIL_SEND_FAILED';
      await store.finish(job, { status: retry ? 'pending' : 'dead', errorCode,
        retryAt: retry ? new Date(Date.parse(timestamp()) + delay).toISOString() : null }, timestamp());
      if (retry) summary.deferred++; else summary.failed++;
    }
  }
  return summary;
}

export function createMonitor({ db, store = db && createReminderStore(db), queryService, env = {},
  mail = createBrevoMailer({ env }), clock = () => new Date() } = {}) {
  if (!store || typeof queryService?.findAvailable !== 'function') throw new TypeError('Persistent store and query service required');
  return Object.freeze({
    async run({ limit = 3, sendLimit = 1, cleanup = true } = {}) {
      try { validateReminderEnvironment(env); }
      catch (error) { if (error.code === 'REMINDERS_UNAVAILABLE') return { disabled: true, checked: 0, sent: 0 }; throw error; }
      const now = () => new Date(clock()).toISOString();
      if (cleanup) await store.cleanup(now());
      const due = await store.due(Math.min(Math.max(limit, 0), 50), now());
      const shared = new Map();
      let checked = 0; let unknown = 0; let expired = 0;
      for (const reminder of due) {
        let conditions;
        try { conditions = JSON.parse(reminder.conditions_json); }
        catch { await store.observe(reminder, { state: 'unknown' }, {}, now()); unknown++; continue; }
        if (conditions.date < todayInShanghai(clock)) {
          await store.expire(reminder.id, reminder.condition_version, now()); expired++; continue;
        }
        const key = reminder.conditions_json;
        if (!shared.has(key)) shared.set(key, Promise.resolve().then(() =>
          queryService.findAvailable({ ...conditions, sort: 'availability', limit: 200 })).catch(() => null));
        const result = await shared.get(key);
        const observation = evaluateObservation(result, { now: Date.parse(now()), minCount: conditions.minCount });
        checked++;
        if (observation.state === 'unknown') unknown++;
        let job;
        if (observation.state === 'matched' && reminder.last_match !== 1) {
          job = await createMailJob({ env, email: reminder.email, kind: 'notification', reminder, timestamp: now(),
            observedAt: observation.observedAt,
            eventKey: `available:${reminder.id}:${reminder.condition_version}:${reminder.match_cycle + 1}` });
        }
        await store.observe(reminder, observation, job ? { token: job.tokenRecord, mail: job.mail } : {}, now());
      }
      return { checked, unknown, expired, ...await flushOutbox({ store, env, mail, clock, limit: sendLimit }) };
    },
  });
}

export async function runMonitor(options) { return createMonitor(options).run(options); }
