import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInvitationBundle, invitationRows, buildInvitationStatsSql, buildInitializeInvitationsSql, parseWranglerOutput } from '../scripts/invitations.mjs';
import { digestToken } from '../src/infrastructure/mail.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const now = new Date('2026-10-13T08:00:00.000Z');
function bundle(seed = 0) { let sequence = seed; return createInvitationBundle({ target: 'local:fixture', now, randomBytesImpl: (length) => Buffer.alloc(length, ++sequence) }); }
function database(t) { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); for (const file of readdirSync(root + '/migrations').filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(root + '/migrations/' + file, 'utf8')); t.after(() => db.close()); return db; }
function reminder(db, id, email, status, verified = null, updated = now.toISOString()) { db.prepare('INSERT INTO reminders(id,email,conditions_json,status,created_at,updated_at,verified_at) VALUES(?,?,?,?,?,?,?)').run(id,email,'{"date":"2026-10-20"}',status,now.toISOString(),updated,verified); }
function run(db, sql) { try { db.exec(sql); } catch (error) { db.exec('ROLLBACK'); throw error; } }
const stats = (db, value) => ({ ...db.prepare(buildInvitationStatsSql({ bundle: value, now })).get() });

test('successful file import tolerates text output while aggregate queries require JSON', () => {
 assert.equal(parseWranglerOutput('Executed import successfully.',{file:true}),null);
 assert.equal(parseWranglerOutput('',{file:true}),null);
 assert.deepEqual(parseWranglerOutput('[{"success":true,"results":[{"count":5,"boundCount":1}]}]'),[{success:true,results:[{count:5,boundCount:1}]}]);
 assert.throws(()=>parseWranglerOutput('Executed import successfully.'),/结果无法确认/);
 assert.throws(()=>parseWranglerOutput(''),/结果无法确认/);
});

test('five 32-byte invitation codes become compatible SHA256 digests with a 90-day lifetime', async () => {
 const value = bundle(); const rows = invitationRows(value); assert.equal(rows.length,5);
 assert.equal(new Set(rows.map((row) => row.codeDigest)).size,5);
 for (let index=0;index<rows.length;index++) { assert.equal(rows[index].codeDigest.length,43); assert.equal(rows[index].codeDigest,await digestToken(value.invitations[index].code)); }
 assert.equal(Date.parse(value.expiresAt)-Date.parse(value.createdAt),90*24*60*60_000);
 assert.ok(!/BEGIN TRANSACTION|COMMIT;/.test(buildInitializeInvitationsSql(value,{now,transaction:false})));
 for (const item of value.invitations) { assert.equal(item.code.length,43); assert.equal(Buffer.from(item.code,'base64url').length,32); assert.ok(!buildInitializeInvitationsSql(value,{now}).includes(item.code)); assert.ok(!buildInvitationStatsSql({bundle:value,now}).includes(item.code)); }
 assert.throws(() => invitationRows({...value,invitations:[value.invitations[0],...value.invitations.slice(0,4)]}));
 assert.throws(() => invitationRows({...value,expiresAt:now.toISOString()}));
});

test('bootstrap binds earliest verified owners, attaches all statuses, and preserves reminder/mail/token data', (t) => {
 const db = database(t); const value = bundle();
 reminder(db,'b1','later@example.test','active','2026-10-12T00:00:00.000Z');
 reminder(db,'b2','later@example.test','pending');
 reminder(db,'a1','earlier@example.test','paused','2026-10-11T00:00:00.000Z');
 reminder(db,'a2','earlier@example.test','expired');
 reminder(db,'unverified','unverified@example.test','pending');
 db.prepare('INSERT INTO reminder_tokens(digest,purpose,email,created_at,expires_at) VALUES(?,?,?,?,?)').run('fixture-token','manage','earlier@example.test',now.toISOString(),'2027-01-01T00:00:00.000Z');
 db.prepare('INSERT INTO reminder_outbox(id,event_key,kind,recipient_email,token_digest,created_at,expires_at,available_at,status) VALUES(?,?,?,?,?,?,?,?,?)').run('fixture-mail','fixture-event','access','earlier@example.test','fixture-token',now.toISOString(),'2027-01-01T00:00:00.000Z',now.toISOString(),'pending');
 const oldReminders = db.prepare('SELECT * FROM reminders ORDER BY id').all().map(({invitation_id,...row})=>({...row}));
 const tokens = db.prepare('SELECT * FROM reminder_tokens').all(); const outbox = db.prepare('SELECT * FROM reminder_outbox').all();
 run(db,buildInitializeInvitationsSql(value,{now}));
 assert.deepEqual(stats(db,value),{count:5,boundCount:2,legacyVerifiedCount:2,overLimitOwnerCount:0,attachedReminderCount:4,matchingCount:5});
 assert.equal(db.prepare('SELECT email FROM reminder_invitations WHERE id=?').get(value.invitations[0].id).email,'earlier@example.test');
 assert.equal(db.prepare('SELECT email FROM reminder_invitations WHERE id=?').get(value.invitations[1].id).email,'later@example.test');
 assert.deepEqual(db.prepare('SELECT * FROM reminders ORDER BY id').all().map(({invitation_id,...row})=>({...row})),oldReminders);
 assert.deepEqual(db.prepare('SELECT * FROM reminder_tokens').all(),tokens); assert.deepEqual(db.prepare('SELECT * FROM reminder_outbox').all(),outbox);
 assert.equal(db.prepare("SELECT invitation_id FROM reminders WHERE id='unverified'").get().invitation_id,null);
 const before = db.prepare('SELECT * FROM reminder_invitations ORDER BY id').all(); run(db,buildInitializeInvitationsSql(value,{now})); assert.deepEqual(db.prepare('SELECT * FROM reminder_invitations ORDER BY id').all(),before);
});

test('six legacy owners abort the whole initialization without changing their reminders', (t) => {
 const db = database(t); for(let index=0;index<6;index++) reminder(db,String(index),`fixture${index}@example.test`,'paused',now.toISOString());
 assert.equal(stats(db).legacyVerifiedCount,6); assert.throws(()=>run(db,buildInitializeInvitationsSql(bundle(),{now})));
 assert.equal(stats(db).count,0); assert.equal(stats(db).attachedReminderCount,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM reminders WHERE status='paused'").get().n,6);
});

test('per-owner live pending count uses updated_at and expires after 30 minutes', (t) => {
 const db = database(t); reminder(db,'a','fixture@example.test','paused',now.toISOString()); reminder(db,'b','fixture@example.test','active'); reminder(db,'c','fixture@example.test','pending');
 assert.equal(stats(db).overLimitOwnerCount,1); assert.throws(()=>run(db,buildInitializeInvitationsSql(bundle(),{now}))); assert.equal(stats(db).count,0);
 db.prepare("UPDATE reminders SET updated_at='2026-10-13T07:00:00.000Z' WHERE id='c'").run();
 assert.equal(stats(db).overLimitOwnerCount,0); run(db,buildInitializeInvitationsSql(bundle(),{now})); assert.equal(stats(db).boundCount,1);
 assert.equal(db.prepare("SELECT status FROM reminders WHERE id='c'").get().status,'pending'); assert.ok(db.prepare("SELECT invitation_id FROM reminders WHERE id='c'").get().invitation_id);
});

test('different file digests and partial existing invitation sets cannot replace invitations', (t) => {
 const db = database(t); const value = bundle(); run(db,buildInitializeInvitationsSql(value,{now})); const before = db.prepare('SELECT * FROM reminder_invitations ORDER BY id').all();
 assert.equal(stats(db,bundle(10)).matchingCount,0); assert.throws(()=>run(db,buildInitializeInvitationsSql(bundle(10),{now}))); assert.deepEqual(db.prepare('SELECT * FROM reminder_invitations ORDER BY id').all(),before);
 db.prepare('DELETE FROM reminder_invitations WHERE id<>?').run(value.invitations[0].id); assert.throws(()=>run(db,buildInitializeInvitationsSql(value,{now}))); assert.equal(stats(db).count,1);
});
