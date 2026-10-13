import { AppError, invalidInput } from '../domain/errors.mjs';
import { MANAGEMENT_TOKEN_MS, VERIFY_TOKEN_MS, normalizeConditions, normalizeEmail, publicReminder, invitationRequired } from '../domain/reminders.mjs';
import { digestToken, encryptPayload, randomToken, validateReminderEnvironment } from '../infrastructure/mail.mjs';

const accepted = Object.freeze({ message: '如果可以建立提醒，我们会发送邮件。请检查收件箱和垃圾邮件。' });
const invalidToken = () => new AppError('链接已失效，请重新获取邮件', { code: 'INVALID_TOKEN', status: 401 });
export function validToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function configuredLimit(value, fallback, max = 10_000) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) >= 1 && Number(value) <= max ? Number(value) : fallback;
}

export async function createMailJob({ env, email, kind, reminder = null, token = randomToken(), timestamp, observedAt = null, eventKey }) {
  const origin = validateReminderEnvironment(env);
  const verify = kind === 'verify';
  const expiresAt = new Date(Date.parse(timestamp) + (verify ? VERIFY_TOKEN_MS : MANAGEMENT_TOKEN_MS)).toISOString();
  const tokenRecord = { digest: await digestToken(token), purpose: verify ? 'verify' : 'manage', email,
    reminder_id: verify ? reminder.id : null, condition_version: verify ? reminder.condition_version : null,
    created_at: timestamp, expires_at: expiresAt };
  const link = `${origin}/#${verify ? 'verify' : 'manage'}=${token}`;
  const condition = reminder ? JSON.parse(reminder.conditions_json) : null;
  const description = condition ? `${condition.date}${condition.endDate ? ` 至 ${condition.endDate}（离店）` : ''}${condition.district ? ` · ${condition.district}` : ''}` : '';
  const subject = verify ? '确认你的青年驿站有房提醒' : kind === 'access' ? '管理你的青年驿站提醒' : '你关注的青年驿站有房了';
  const text = verify ? `请打开链接，并在页面点击确认，启用有房提醒。链接 30 分钟内有效。\n${description}\n\n${link}\n\n如果不是你发起的，请忽略本邮件。`
    : kind === 'access' ? `通过下方专属链接查看、修改或取消你的有房提醒。链接 30 天内有效，请勿转发。\n\n${link}\n\n如果不是你发起的，请忽略本邮件。`
      : `你关注的入住条件已经出现符合的房源。房源随时变化，请打开网站查看最新信息并前往官网申请。\n${description}\n\n查房：${origin}/\n管理或取消提醒：${link}\n\n此邮件不是入住确认。持续有房不会重复通知。`;
  const jobExpiry = new Date(Date.parse(timestamp) + (kind === 'notification' ? 24 * 60 * 60_000 : VERIFY_TOKEN_MS)).toISOString();
  return { token, tokenRecord, mail: { id: crypto.randomUUID(), event_key: eventKey ?? `${kind}:${crypto.randomUUID()}`,
    kind, reminder_id: reminder?.id ?? null, condition_version: reminder?.condition_version ?? null,
    recipient_email: email, token_digest: tokenRecord.digest, payload_ciphertext: await encryptPayload({ to: email, subject, text }, env.APP_SECRET),
    observed_at: observedAt, created_at: timestamp, expires_at: jobExpiry, available_at: timestamp } };
}

export function createReminderService({ store, env = {}, clock = () => new Date() } = {}) {
  if (!store) throw new TypeError('Reminder store required');
  const now = () => new Date(clock()).toISOString();
  async function rate(scope, value, limit, windowMs) {
    if (!await store.consumeRate(`${scope}:${await digestToken(value)}`, limit, windowMs, now())) {
      throw new AppError('操作过于频繁，请稍后再试', { code: 'RATE_LIMITED', status: 429, retryable: true });
    }
  }
  async function mutationRate(ip, email, { checkIp = true, sendCooldown = true } = {}) {
    if (checkIp) await rate('create-ip', ip, 12, 60 * 60_000);
    await rate('create-email', email, 3, 60 * 60_000);
    if (!sendCooldown) return true;
    // Intentionally return the same response when the resend cooldown applies.
    return store.consumeRate(`mail-cooldown:${await digestToken(email)}`, 1, 5 * 60_000, now());
  }
  async function access(email, timestamp) {
    const job = await createMailJob({ env, email, kind: 'access', timestamp });
    await store.enqueueAccess(job.tokenRecord, job.mail, { invitationRequired: invitationRequired(env) });
  }
  async function owner(token, ip = 'unknown') {
    // Existing capabilities remain usable while outbound mail is disabled.
    await rate('manage-ip', ip, 120, 60 * 60_000);
    if (!validToken(token)) throw invalidToken();
    await rate('manage-token', token, 120, 60 * 60_000);
    const record = await store.getToken(await digestToken(token), 'manage', now());
    if (!record) throw invalidToken();
    return record.email;
  }
  return Object.freeze({
    async create({ email: value, conditions: valueConditions, inviteCode }, { ip = 'unknown', token: managementToken } = {}) {
      validateReminderEnvironment(env);
      const email = normalizeEmail(value); const conditions = normalizeConditions(valueConditions, { clock });
      const timestamp = now(); const conditionsJson = JSON.stringify(conditions);
      const required = invitationRequired(env);
      const invitationError = () => new AppError('邮件提醒仅限受邀用户，请使用有效邀请码或管理邮件链接',
        { code: 'INVITATION_REQUIRED', status: 403 });
      let invitation = null; let codeDigest = null; let authenticated = false;
      if (required) {
        await rate('create-ip', ip, 12, 60 * 60_000);
        if (managementToken) {
          if (await owner(managementToken, ip) !== email) throw invitationError();
          invitation = await store.invitationForOwner(email); authenticated = true;
        } else {
          if (!validToken(inviteCode)) throw invitationError();
          codeDigest = await digestToken(inviteCode);
          invitation = await store.invitationByCode(codeDigest);
          if (!invitation || !['available','reserved'].includes(invitation.state) || invitation.code_expires_at<=timestamp ||
              (invitation.state==='reserved' && invitation.reservation_until>timestamp && invitation.email!==email)) throw invitationError();
        }
        if (!invitation) throw invitationError();
      }
      const totalLimit = configuredLimit(env.REMINDERS_TOTAL_LIMIT, required ? 10 : 30, required ? 10 : 40);
      const capacityError = () => new AppError('提醒名额暂满，请稍后再试。查房仍可正常使用。',
        { code: 'REMINDER_CAPACITY', status: 503, retryable: true });
      if (required && authenticated) {
        await mutationRate(ip, email, { checkIp: false, sendCooldown: false });
        const existing = await store.findDuplicate(email, conditionsJson);
        if (existing?.invitation_id === invitation.id && ['active','paused'].includes(existing.status)) {
          return { data: publicReminder(existing), message: existing.status === 'paused' ? '该提醒已暂停' : '该提醒已存在' };
        }
        const row = existing?.invitation_id === invitation.id ? existing : { id: crypto.randomUUID(), email,
          conditions_json: conditionsJson, created_at: timestamp, updated_at: timestamp };
        const created = await store.createForOwner(row, invitation.id, timestamp);
        if (!created) {
          if (await store.ownerUsage(email, timestamp) >= 2) throw new AppError('每人最多保留2条提醒，请先删除不需要的提醒',
            { code: 'REMINDER_LIMIT', status: 409 });
          if (!await store.hasCapacity(totalLimit, timestamp)) throw capacityError();
          throw invitationError();
        }
        return { data: publicReminder(created), message: created.status === 'paused' ? '该提醒已暂停' : '提醒已启用' };
      }
      let existing = required ? await store.findDuplicate(email, conditionsJson) : null;
      if (required && existing?.invitation_id !== invitation.id) existing = null;
      const renewingSlot = required && existing?.status === 'pending' &&
        Date.parse(existing.updated_at) > Date.parse(timestamp) - VERIFY_TOKEN_MS;
      // An invite holder may resend verification for its own live reservation
      // even when all slots are occupied; this does not claim an additional slot.
      // The public legacy mode keeps its email-independent capacity response.
      if (!renewingSlot && !await store.hasCapacity(totalLimit, timestamp)) throw capacityError();
      if (!await mutationRate(ip, email, { checkIp: !required })) return accepted;
      if (!required) existing = await store.findDuplicate(email, conditionsJson);
      if (existing && existing.status !== 'pending') { await access(email, timestamp); return accepted; }
      const row = existing ?? { id: crypto.randomUUID(), email, conditions_json: conditionsJson, condition_version: 1,
        created_at: timestamp, updated_at: timestamp };
      const job = await createMailJob({ env, email, kind: 'verify', reminder: row, timestamp });
      const result = await store.createPending(row, job.tokenRecord, job.mail,
        configuredLimit(env.REMINDERS_PER_EMAIL, required ? 2 : 3, required ? 2 : 10), totalLimit,
        { invitationRequired: required, invitationId: invitation?.id ?? null, codeDigest, owner: authenticated });
      if (!result.queued) {
        if (!await store.hasCapacity(totalLimit, timestamp)) throw capacityError();
        if (required) throw new AppError('提醒名额已满或邀请已失效，请删除不需要的提醒或联系邀请人',
          { code: 'REMINDER_LIMIT', status: 409 });
      }
      return accepted;
    },
    async requestAccess({ email: value }, { ip = 'unknown' } = {}) {
      validateReminderEnvironment(env);
      const email = normalizeEmail(value);
      if (await mutationRate(ip, email)) await access(email, now());
      return accepted;
    },
    async verify({ token }, { ip = 'unknown' } = {}) {
      validateReminderEnvironment(env);
      await rate('verify-ip', ip, 30, 60 * 60_000);
      if (!validToken(token)) throw invalidToken();
      await rate('verify-token', token, 5, 60 * 60_000);
      const timestamp = now();
      const verification = await store.getToken(await digestToken(token), 'verify', timestamp);
      if (!verification) throw invalidToken();
      const managementToken = randomToken();
      const management = { digest: await digestToken(managementToken), purpose: 'manage', email: verification.email,
        created_at: timestamp, expires_at: new Date(Date.parse(timestamp) + MANAGEMENT_TOKEN_MS).toISOString() };
      if (!await store.activate(verification, management, timestamp, { invitationRequired: invitationRequired(env) })) throw invalidToken();
      return { managementToken, data: (await store.list(verification.email)).map(publicReminder) };
    },
    async list(token, { ip = 'unknown' } = {}) {
      return { data: (await store.list(await owner(token, ip))).map(publicReminder) };
    },
    async update(token, id, patch, { ip = 'unknown' } = {}) {
      const email = await owner(token, ip);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidInput('提醒修改格式无效', 'body');
      let status = patch.status;
      if (patch.paused !== undefined) {
        if (typeof patch.paused !== 'boolean') throw invalidInput('paused 必须为布尔值', 'paused');
        status = patch.paused ? 'paused' : 'active';
      }
      if (status !== undefined && !['active', 'paused'].includes(status)) throw invalidInput('提醒状态无效', 'status');
      const conditions = patch.conditions === undefined ? undefined : normalizeConditions(patch.conditions, { clock });
      if (status === undefined && conditions === undefined) throw invalidInput('请提供新的条件或状态', 'body');
      const row = await store.update(id, email, { status, conditionsJson: conditions && JSON.stringify(conditions) }, now());
      if (!row) throw new AppError('提醒不存在', { code: 'NOT_FOUND', status: 404 });
      return { data: publicReminder(row) };
    },
    async cancel(token, id, { ip = 'unknown' } = {}) {
      const email = await owner(token, ip);
      if (!await store.cancel(id, email, now())) throw new AppError('提醒不存在', { code: 'NOT_FOUND', status: 404 });
      return { data: { id, status: 'cancelled' } };
    },
  });
}
