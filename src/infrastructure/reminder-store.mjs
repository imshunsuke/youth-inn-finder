import { todayInShanghai } from '../domain/dates.mjs';
import { REMINDER_INTERVAL_MS, VERIFY_TOKEN_MS } from '../domain/reminders.mjs';

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const rows = (result) => result?.results ?? [];
function outboxStatement(db, mail, where = '1', values = []) {
  return db.prepare(`INSERT OR IGNORE INTO reminder_outbox
    (id,event_key,kind,reminder_id,condition_version,recipient_email,token_digest,payload_ciphertext,observed_at,
     created_at,expires_at,available_at,status) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'pending' WHERE ${where}`)
    .bind(mail.id, mail.event_key, mail.kind, mail.reminder_id ?? null, mail.condition_version ?? null,
      mail.recipient_email, mail.token_digest, mail.payload_ciphertext, mail.observed_at ?? null,
      mail.created_at, mail.expires_at, mail.available_at ?? mail.created_at, ...values);
}
function tokenStatement(db, token, where = '1', values = []) {
  return db.prepare(`INSERT OR IGNORE INTO reminder_tokens
    (digest,purpose,email,reminder_id,condition_version,created_at,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE ${where}`)
    .bind(token.digest, token.purpose, token.email, token.reminder_id ?? null,
      token.condition_version ?? null, token.created_at, token.expires_at, ...values);
}

export function createReminderStore(db, { clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new TypeError('A D1-compatible database is required');
  const current = () => new Date(clock()).toISOString();
  return Object.freeze({
    async consumeRate(key, limit, windowMs, timestamp = current()) {
      const ms = Date.parse(timestamp); const bucket = `${key}:${Math.floor(ms / windowMs)}`;
      const expires = new Date((Math.floor(ms / windowMs) + 1) * windowMs).toISOString();
      const result = await db.prepare(`INSERT INTO reminder_rate_limits(bucket_key,count,expires_at) VALUES (?,1,?)
        ON CONFLICT(bucket_key) DO UPDATE SET count=count+1 WHERE count < ?`).bind(bucket, expires, limit).run();
      return changes(result) > 0;
    },
    async findDuplicate(email, conditionsJson) {
      return db.prepare(`SELECT * FROM reminders WHERE email=? AND conditions_json=? AND status IN ('pending','active','paused')
        ORDER BY created_at DESC LIMIT 1`).bind(email, conditionsJson).first();
    },
    async hasCapacity(limit = 30, timestamp = current()) {
      const cutoff = new Date(Date.parse(timestamp) - VERIFY_TOKEN_MS).toISOString();
      const count = await db.prepare(`SELECT COUNT(*) AS count FROM reminders WHERE status IN ('active','paused')
        OR (status='pending' AND updated_at>?)`).bind(cutoff).first();
      return count.count < limit;
    },
    async createPending(reminder, token, mail, maxReminders = 3, totalLimit = 30) {
      const cutoff = new Date(Date.parse(token.created_at) - VERIFY_TOKEN_MS).toISOString();
      const live = `(status IN ('active','paused') OR (status='pending' AND updated_at>?))`;
      const exists = `EXISTS(SELECT 1 FROM reminders WHERE id=? AND email=? AND status='pending' AND conditions_json=?
        AND (updated_at>? OR (SELECT COUNT(*) FROM reminders WHERE ${live}) < ?))`;
      const values = [reminder.id, reminder.email, reminder.conditions_json, cutoff,
        cutoff, totalLimit];
      return db.batch([
        db.prepare(`INSERT OR IGNORE INTO reminders(id,email,conditions_json,status,condition_version,created_at,updated_at)
          SELECT ?,?,?,'pending',1,?,? WHERE
          (SELECT COUNT(*) FROM reminders WHERE email=? AND status IN ('pending','active','paused')) < ?
          AND (SELECT COUNT(*) FROM reminders WHERE ${live}) < ?
          AND NOT EXISTS(SELECT 1 FROM reminders WHERE email=? AND conditions_json=? AND status IN ('pending','active','paused'))`)
          .bind(reminder.id, reminder.email, reminder.conditions_json, reminder.created_at, reminder.updated_at,
            reminder.email, maxReminders, cutoff, totalLimit, reminder.email, reminder.conditions_json),
        tokenStatement(db, token, exists, values),
        db.prepare(`UPDATE reminders SET updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM reminder_tokens WHERE digest=?)`)
          .bind(token.created_at, reminder.id, token.digest),
        outboxStatement(db, mail, `EXISTS(SELECT 1 FROM reminder_tokens WHERE digest=?)`, [token.digest]),
      ]);
    },
    async enqueueAccess(token, mail) {
      const valid = `EXISTS(SELECT 1 FROM reminders WHERE email=? AND verified_at IS NOT NULL AND status IN ('active','paused'))`;
      return db.batch([tokenStatement(db, token, valid, [token.email]),
        outboxStatement(db, mail, `EXISTS(SELECT 1 FROM reminder_tokens WHERE digest=?)`, [token.digest])]);
    },
    async getToken(digest, purpose, timestamp = current()) {
      return db.prepare(`SELECT * FROM reminder_tokens WHERE digest=? AND purpose=? AND consumed_at IS NULL AND expires_at>?`)
        .bind(digest, purpose, timestamp).first();
    },
    async activate(verification, management, timestamp = current()) {
      const valid = `EXISTS(SELECT 1 FROM reminder_tokens t JOIN reminders r ON r.id=t.reminder_id
        WHERE t.digest=? AND t.purpose='verify' AND t.consumed_at IS NULL AND t.expires_at>?
        AND r.status='pending' AND r.condition_version=t.condition_version)`;
      const results = await db.batch([
        tokenStatement(db, management, valid, [verification.digest, timestamp]),
        db.prepare(`UPDATE reminders SET status='active',verified_at=?,updated_at=?,next_check_at=?,last_match=NULL
          WHERE id=? AND status='pending' AND condition_version=? AND ${valid}`)
          .bind(timestamp, timestamp, timestamp, verification.reminder_id, verification.condition_version, verification.digest, timestamp),
        db.prepare(`UPDATE reminder_tokens SET consumed_at=? WHERE purpose='verify' AND reminder_id=? AND consumed_at IS NULL
          AND EXISTS(SELECT 1 FROM reminder_tokens WHERE digest=? AND purpose='manage')`)
          .bind(timestamp, verification.reminder_id, management.digest),
        db.prepare(`UPDATE reminder_outbox SET status='cancelled',payload_ciphertext=NULL WHERE kind='verify' AND reminder_id=?
          AND status IN ('pending','sending') AND EXISTS(SELECT 1 FROM reminder_tokens WHERE digest=? AND purpose='manage')`)
          .bind(verification.reminder_id, management.digest),
      ]);
      return changes(results[0]) === 1;
    },
    async list(email) {
      return rows(await db.prepare(`SELECT * FROM reminders WHERE email=? AND verified_at IS NOT NULL
        AND status IN ('active','paused') ORDER BY created_at DESC`).bind(email).all());
    },
    async get(id, email) {
      return db.prepare(`SELECT * FROM reminders WHERE id=? AND email=? AND verified_at IS NOT NULL
        AND status IN ('active','paused')`).bind(id, email).first();
    },
    async update(id, email, { conditionsJson, status }, timestamp = current()) {
      // Every meaningful edit creates a new version and invalidates previous queued messages.
      await db.batch([
        db.prepare(`UPDATE reminders SET conditions_json=COALESCE(?,conditions_json),status=COALESCE(?,status),
          condition_version=condition_version+1,updated_at=?,last_match=NULL,match_cycle=0,next_check_at=?
          WHERE id=? AND email=? AND verified_at IS NOT NULL AND status IN ('active','paused')`)
          .bind(conditionsJson ?? null, status ?? null, timestamp, timestamp, id, email),
        db.prepare(`UPDATE reminder_outbox SET status='cancelled',payload_ciphertext=NULL,lease_id=NULL,lease_until=NULL
          WHERE reminder_id=? AND recipient_email=? AND status IN ('pending','sending') AND
          condition_version < (SELECT condition_version FROM reminders WHERE id=? AND email=?)`)
          .bind(id, email, id, email),
      ]);
      return this.get(id, email);
    },
    async cancel(id, email, timestamp = current()) {
      // Hard deletion honours the delete endpoint, including pending emails and token associations.
      const result = await db.batch([
        db.prepare(`DELETE FROM reminder_outbox WHERE reminder_id=? AND recipient_email=?`).bind(id, email),
        db.prepare(`DELETE FROM reminder_tokens WHERE reminder_id=? AND email=?`).bind(id, email),
        db.prepare(`DELETE FROM reminders WHERE id=? AND email=? AND verified_at IS NOT NULL`).bind(id, email),
        db.prepare(`DELETE FROM reminder_tokens WHERE email=? AND NOT EXISTS(SELECT 1 FROM reminders WHERE email=?)`).bind(email, email),
        db.prepare(`DELETE FROM reminder_outbox WHERE recipient_email=? AND NOT EXISTS(SELECT 1 FROM reminders WHERE email=?)`).bind(email, email),
      ]);
      return changes(result[2]) > 0;
    },
    async due(limit = 10, timestamp = current()) {
      const candidates = rows(await db.prepare(`SELECT * FROM reminders WHERE status='active' AND verified_at IS NOT NULL
        AND (next_check_at IS NULL OR next_check_at<=?) ORDER BY next_check_at,created_at LIMIT ?`).bind(timestamp, limit).all());
      const claimed = [];
      for (const row of candidates) {
        const result = await db.prepare(`UPDATE reminders SET next_check_at=? WHERE id=? AND status='active'
          AND condition_version=? AND (next_check_at IS NULL OR next_check_at<=?)`)
          .bind(new Date(Date.parse(timestamp) + 3 * 60_000).toISOString(), row.id, row.condition_version, timestamp).run();
        if (changes(result)) claimed.push(row);
      }
      return claimed;
    },
    async expire(id, version, timestamp = current()) {
      await db.batch([
        db.prepare(`UPDATE reminders SET status='expired',updated_at=? WHERE id=? AND condition_version=? AND status='active'`)
          .bind(timestamp, id, version),
        db.prepare(`UPDATE reminder_outbox SET status='cancelled',payload_ciphertext=NULL WHERE reminder_id=?
          AND status IN ('pending','sending') AND EXISTS(SELECT 1 FROM reminders WHERE id=? AND status='expired')`).bind(id, id),
      ]);
    },
    async observe(reminder, observation, { token, mail } = {}, timestamp = current()) {
      const next = new Date(Date.parse(timestamp) + REMINDER_INTERVAL_MS).toISOString();
      const canTransition = `EXISTS(SELECT 1 FROM reminders WHERE id=? AND status='active' AND condition_version=?
        AND COALESCE(last_match,0)=0 AND match_cycle=?)`;
      const identity = [reminder.id, reminder.condition_version, reminder.match_cycle];
      const statements = [];
      if (observation.state === 'matched' && token && mail) {
        statements.push(tokenStatement(db, token, canTransition, identity));
        statements.push(outboxStatement(db, mail, canTransition, identity));
      }
      if (observation.state === 'matched') statements.push(db.prepare(`UPDATE reminder_outbox SET observed_at=?
        WHERE reminder_id=? AND condition_version=? AND kind='notification' AND status='pending'
        AND EXISTS(SELECT 1 FROM reminders WHERE id=? AND condition_version=? AND status='active')`)
        .bind(observation.observedAt, reminder.id, reminder.condition_version, reminder.id, reminder.condition_version));
      if (observation.state === 'empty') statements.push(db.prepare(`UPDATE reminder_outbox SET status='cancelled',payload_ciphertext=NULL
        WHERE reminder_id=? AND condition_version=? AND kind='notification' AND status IN ('pending','sending')
        AND EXISTS(SELECT 1 FROM reminders WHERE id=? AND condition_version=? AND status='active' AND match_cycle=?)`)
        .bind(reminder.id, reminder.condition_version, reminder.id, reminder.condition_version, reminder.match_cycle));
      statements.push(db.prepare(`UPDATE reminders SET last_checked_at=?,next_check_at=?,
        last_match=CASE WHEN ?='matched' THEN 1 WHEN ?='empty' THEN 0 ELSE last_match END,
        match_cycle=CASE WHEN ?='matched' AND COALESCE(last_match,0)=0 THEN match_cycle+1 ELSE match_cycle END
        WHERE id=? AND status='active' AND condition_version=? AND match_cycle=?`)
        .bind(timestamp, next, observation.state, observation.state, observation.state,
          reminder.id, reminder.condition_version, reminder.match_cycle));
      return db.batch(statements);
    },
    async claimOutbox(limit = 10, timestamp = current(), leaseMs = 60_000) {
      const candidates = rows(await db.prepare(`SELECT id FROM reminder_outbox WHERE expires_at>? AND
        ((status='pending' AND available_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY created_at LIMIT ?`)
        .bind(timestamp, timestamp, timestamp, limit).all());
      const claimed = [];
      for (const { id } of candidates) {
        const lease = crypto.randomUUID();
        const result = await db.prepare(`UPDATE reminder_outbox SET status='sending',lease_id=?,lease_until=?,attempts=attempts+1
          WHERE id=? AND expires_at>? AND ((status='pending' AND available_at<=?) OR (status='sending' AND lease_until<=?))`)
          .bind(lease, new Date(Date.parse(timestamp) + leaseMs).toISOString(), id, timestamp, timestamp, timestamp).run();
        if (changes(result)) claimed.push(await db.prepare(`SELECT * FROM reminder_outbox WHERE id=? AND lease_id=?`).bind(id, lease).first());
      }
      return claimed;
    },
    async canSend(mail, timestamp = current()) {
      const lease = await db.prepare(`SELECT id FROM reminder_outbox WHERE id=? AND lease_id=? AND status='sending'
        AND expires_at>? AND lease_until>?`).bind(mail.id, mail.lease_id, timestamp, timestamp).first();
      if (!lease) return false;
      if (!await this.getToken(mail.token_digest, mail.kind === 'verify' ? 'verify' : 'manage', timestamp)) return false;
      if (mail.kind === 'access') return !!await db.prepare(`SELECT id FROM reminders WHERE email=? AND verified_at IS NOT NULL
        AND status IN ('active','paused') LIMIT 1`).bind(mail.recipient_email).first();
      const row = await db.prepare(`SELECT * FROM reminders WHERE id=? AND email=? AND condition_version=?`)
        .bind(mail.reminder_id, mail.recipient_email, mail.condition_version).first();
      return !!row && (mail.kind === 'verify' ? row.status === 'pending' : row.status === 'active' && row.last_match === 1);
    },
    async reserveMailBudget(emailKey, { totalLimit = 250, notificationLimit = 8, notification = false, day }, timestamp = current()) {
      const expiry = new Date(Date.parse(`${day}T00:00:00Z`) + 48 * 60 * 60_000).toISOString();
      const globalKey = `all:${day}`; const emailBudget = `notice:${day}:${emailKey}`;
      const allowedEmail = `COALESCE((SELECT count FROM reminder_mail_budgets WHERE budget_key=?),0) < ?`;
      const result = await db.batch([
        db.prepare(`INSERT INTO reminder_mail_budgets(budget_key,count,expires_at) SELECT ?,1,? WHERE ${allowedEmail}
          ON CONFLICT(budget_key) DO UPDATE SET count=count+1 WHERE count<? AND ${allowedEmail}`)
          .bind(globalKey, expiry, emailBudget, notification ? notificationLimit : 1_000_000,
            totalLimit, emailBudget, notification ? notificationLimit : 1_000_000),
        db.prepare(`INSERT INTO reminder_mail_budgets(budget_key,count,expires_at)
          SELECT ?,1,? WHERE ?=1 AND changes()=1
          ON CONFLICT(budget_key) DO UPDATE SET count=count+1`)
          .bind(emailBudget, expiry, notification ? 1 : 0),
      ]);
      return changes(result[0]) === 1;
    },
    async finish(mail, { status = 'sent', errorCode = null, retryAt = null } = {}, timestamp = current()) {
      return db.prepare(`UPDATE reminder_outbox SET status=?,last_error_code=?,available_at=COALESCE(?,available_at),
        sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,payload_ciphertext=CASE WHEN ?='pending' THEN payload_ciphertext ELSE NULL END,
        lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=? AND status='sending'`)
        .bind(status, errorCode, retryAt, status, timestamp, status, mail.id, mail.lease_id).run();
    },
    async cleanup(timestamp = current()) {
      const pendingCutoff = new Date(Date.parse(timestamp) - 24 * 60 * 60_000).toISOString();
      const retentionCutoff = new Date(Date.parse(timestamp) - 7 * 24 * 60 * 60_000).toISOString();
      await db.batch([
        db.prepare(`UPDATE reminders SET status='expired',updated_at=? WHERE status='paused' AND
          CASE WHEN json_valid(conditions_json) THEN json_extract(conditions_json,'$.date') ELSE '9999-12-31' END < ?`)
          .bind(timestamp, todayInShanghai(() => new Date(timestamp))),
        db.prepare(`UPDATE reminder_outbox SET status='cancelled',payload_ciphertext=NULL WHERE expires_at<=? AND status IN ('pending','sending')`).bind(timestamp),
        db.prepare(`DELETE FROM reminder_tokens WHERE expires_at<=? OR consumed_at IS NOT NULL`).bind(timestamp),
        db.prepare(`DELETE FROM reminder_rate_limits WHERE expires_at<=?`).bind(timestamp),
        db.prepare(`DELETE FROM reminder_mail_budgets WHERE expires_at<=?`).bind(timestamp),
        db.prepare(`DELETE FROM reminder_outbox WHERE created_at<? AND status IN ('sent','dead','cancelled')`).bind(retentionCutoff),
        db.prepare(`DELETE FROM reminders WHERE status='pending' AND updated_at<?`).bind(pendingCutoff),
        db.prepare(`DELETE FROM reminder_tokens WHERE reminder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reminders r WHERE r.id=reminder_id)`),
        db.prepare(`DELETE FROM reminder_outbox WHERE reminder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reminders r WHERE r.id=reminder_id)`),
        db.prepare(`DELETE FROM reminders WHERE status='expired' AND updated_at<?`).bind(retentionCutoff),
      ]);
    },
  });
}
