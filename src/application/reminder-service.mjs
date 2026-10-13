import { AppError, invalidInput } from '../domain/errors.mjs';
import { MANAGEMENT_TOKEN_MS, VERIFY_TOKEN_MS, normalizeConditions, normalizeEmail, publicReminder } from '../domain/reminders.mjs';
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
  async function mutationRate(ip, email) {
    await rate('create-ip', ip, 12, 60 * 60_000);
    await rate('create-email', email, 3, 60 * 60_000);
    // Intentionally return the same response when the resend cooldown applies.
    return store.consumeRate(`mail-cooldown:${await digestToken(email)}`, 1, 5 * 60_000, now());
  }
  async function access(email, timestamp) {
    const job = await createMailJob({ env, email, kind: 'access', timestamp });
    await store.enqueueAccess(job.tokenRecord, job.mail);
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
    async create({ email: value, conditions: valueConditions }, { ip = 'unknown' } = {}) {
      validateReminderEnvironment(env);
      const email = normalizeEmail(value); const conditions = normalizeConditions(valueConditions, { clock });
      const timestamp = now(); const conditionsJson = JSON.stringify(conditions);
      const totalLimit = configuredLimit(env.REMINDERS_TOTAL_LIMIT, 30, 40);
      const capacityError = () => new AppError('提醒名额暂满，请稍后再试。查房仍可正常使用。',
        { code: 'REMINDER_CAPACITY', status: 503, retryable: true });
      // Public capacity is checked independently of email existence, so a full
      // deployment has the same response for new and existing addresses.
      if (!await store.hasCapacity(totalLimit, timestamp)) throw capacityError();
      if (!await mutationRate(ip, email)) return accepted;
      const existing = await store.findDuplicate(email, conditionsJson);
      if (existing && existing.status !== 'pending') { await access(email, timestamp); return accepted; }
      const row = existing ?? { id: crypto.randomUUID(), email, conditions_json: conditionsJson, condition_version: 1,
        created_at: timestamp, updated_at: timestamp };
      const job = await createMailJob({ env, email, kind: 'verify', reminder: row, timestamp });
      const result = await store.createPending(row, job.tokenRecord, job.mail,
        configuredLimit(env.REMINDERS_PER_EMAIL, 3, 10), totalLimit);
      if (Number(result[1]?.meta?.changes ?? result[1]?.changes ?? 0) === 0 &&
          !await store.hasCapacity(totalLimit, timestamp)) throw capacityError();
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
      if (!await store.activate(verification, management, timestamp)) throw invalidToken();
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
