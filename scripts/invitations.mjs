// Explicit operator command. Plain invitation codes stay in a private ignored file;
// Wrangler receives only SHA-256 digests, and importing this module has no side effects.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDatabase } from "../src/development/d1.mjs";
import { migrateLocalDatabase } from "../src/development/migrate.mjs";

const INVITATION_COUNT = 5;
const CODE_LIFETIME_MS = 90 * 24 * 60 * 60_000;
const VERIFY_LIFETIME_MS = 30 * 60_000;
const digest = (code) => createHash("sha256").update(code).digest("base64url");
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
class OperatorError extends Error {}

export function createInvitationBundle({ target, now = new Date(), randomBytesImpl = randomBytes } = {}) {
  if (typeof target !== "string" || !target) throw new TypeError("An invitation database target is required");
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + CODE_LIFETIME_MS).toISOString();
  const invitations = Array.from({ length: INVITATION_COUNT }, () => {
    const code = randomBytesImpl(32).toString("base64url");
    return { id: `inv_${digest(code).slice(0, 32)}`, code };
  });
  const bundle = { version: 1, target, createdAt, expiresAt, invitations };
  invitationRows(bundle);
  return bundle;
}

// Validation deliberately never includes file contents or codes in an error.
export function invitationRows(bundle) {
  if (!bundle || bundle.version !== 1 || typeof bundle.target !== "string" || !bundle.target ||
      !Array.isArray(bundle.invitations) || bundle.invitations.length !== INVITATION_COUNT ||
      typeof bundle.createdAt !== "string" || typeof bundle.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(bundle.createdAt)) || !Number.isFinite(Date.parse(bundle.expiresAt)) ||
      new Date(bundle.createdAt).toISOString() !== bundle.createdAt ||
      new Date(bundle.expiresAt).toISOString() !== bundle.expiresAt ||
      Date.parse(bundle.expiresAt) - Date.parse(bundle.createdAt) !== CODE_LIFETIME_MS) {
    throw new OperatorError("邀请码文件无效；请保留原文件，不要重新生成或轮换。");
  }
  const ids = new Set(); const hashes = new Set();
  return bundle.invitations.map(({ id, code } = {}) => {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code) ||
        Buffer.from(code, "base64url").length !== 32 || Buffer.from(code, "base64url").toString("base64url") !== code) {
      throw new OperatorError("邀请码文件无效；请保留原文件，不要重新生成或轮换。");
    }
    const codeDigest = digest(code);
    if (id !== `inv_${codeDigest.slice(0, 32)}` || ids.has(id) || hashes.has(codeDigest)) {
      throw new OperatorError("邀请码文件无效；请保留原文件，不要重新生成或轮换。");
    }
    ids.add(id); hashes.add(codeDigest);
    return { id, codeDigest, createdAt: bundle.createdAt, expiresAt: bundle.expiresAt };
  });
}

function inputCte(bundle) {
  return `input(ordinal,id,code_digest,created_at,code_expires_at) AS (VALUES ${invitationRows(bundle)
    .map((row, index) => `(${index + 1},${sqlString(row.id)},${sqlString(row.codeDigest)},${sqlString(row.createdAt)},${sqlString(row.expiresAt)})`).join(",")})`;
}
const legacyCte = `legacy AS (SELECT email,MIN(verified_at) AS first_verified_at FROM reminders
  WHERE verified_at IS NOT NULL GROUP BY email)`;
function overLimitSql(now) {
  const cutoff = sqlString(new Date(new Date(now).getTime() - VERIFY_LIFETIME_MS).toISOString());
  return `(SELECT COUNT(*) FROM (SELECT r.email FROM reminders r JOIN legacy l ON l.email=r.email
    WHERE r.status IN ('active','paused') OR (r.status='pending' AND r.updated_at>${cutoff})
    GROUP BY r.email HAVING COUNT(*)>2))`;
}

export function buildInvitationStatsSql({ bundle, now = new Date() } = {}) {
  const input = bundle ? `${inputCte(bundle)},` : "";
  return `WITH ${input}${legacyCte} SELECT
    (SELECT COUNT(*) FROM reminder_invitations) AS count,
    (SELECT COUNT(*) FROM reminder_invitations WHERE state='bound') AS boundCount,
    (SELECT COUNT(*) FROM legacy) AS legacyVerifiedCount,
    ${overLimitSql(now)} AS overLimitOwnerCount,
    (SELECT COUNT(*) FROM reminders WHERE invitation_id IS NOT NULL) AS attachedReminderCount${bundle ? `,
    (SELECT COUNT(*) FROM reminder_invitations i JOIN input n ON n.id=i.id AND n.code_digest=i.code_digest) AS matchingCount` : ""};`;
}

export function buildInitializeInvitationsSql(bundle, { now = new Date(), transaction = true } = {}) {
  const input = inputCte(bundle);
  const matching = `(SELECT COUNT(*) FROM reminder_invitations i JOIN input n ON n.id=i.id AND n.code_digest=i.code_digest)`;
  // Remote Wrangler --file already imports atomically. Only local SQLite needs
  // explicit BEGIN/COMMIT; never submit nested transaction statements to D1.
  return `${transaction ? "BEGIN TRANSACTION;\n" : ""}
WITH ${input},${legacyCte}
SELECT CASE WHEN (SELECT COUNT(*) FROM legacy)<=5 AND ${overLimitSql(now)}=0 AND
  (((SELECT COUNT(*) FROM reminder_invitations)=0 AND (SELECT COUNT(*) FROM reminders WHERE invitation_id IS NOT NULL)=0)
    OR ((SELECT COUNT(*) FROM reminder_invitations)=5 AND ${matching}=5))
  THEN 1 ELSE json('INVITATION_BOOTSTRAP_REJECTED') END;
WITH ${input},${legacyCte},ranked AS
  (SELECT email,ROW_NUMBER() OVER (ORDER BY first_verified_at,email) AS ordinal FROM legacy)
INSERT OR IGNORE INTO reminder_invitations
  (id,code_digest,state,email,reservation_until,code_expires_at,bound_at,created_at)
SELECT n.id,n.code_digest,CASE WHEN l.email IS NULL THEN 'available' ELSE 'bound' END,l.email,NULL,
  n.code_expires_at,CASE WHEN l.email IS NULL THEN NULL ELSE n.created_at END,n.created_at
  FROM input n LEFT JOIN ranked l ON l.ordinal=n.ordinal;
UPDATE reminders SET invitation_id=(SELECT i.id FROM reminder_invitations i WHERE i.state='bound' AND i.email=reminders.email)
  WHERE invitation_id IS NULL AND EXISTS
    (SELECT 1 FROM reminder_invitations i WHERE i.state='bound' AND i.email=reminders.email);
WITH ${input},${legacyCte}
SELECT CASE WHEN (SELECT COUNT(*) FROM reminder_invitations)=5 AND ${matching}=5 AND
  NOT EXISTS(SELECT 1 FROM reminders r WHERE r.verified_at IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM reminder_invitations i WHERE i.id=r.invitation_id AND i.state='bound' AND i.email=r.email))
  THEN 1 ELSE json('INVITATION_BOOTSTRAP_REJECTED') END;
${transaction ? "COMMIT;" : ""}
`;
}

async function readPrivateBundle(path, target) {
  let details;
  try { details = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw new OperatorError("无法读取邀请码文件。"); }
  if (!details.isFile() || (details.mode & 0o777) !== 0o600 || (process.getuid && details.uid !== process.getuid())) {
    throw new OperatorError("邀请码文件必须是当前用户拥有的普通文件，权限为 0600。");
  }
  let bundle;
  try { bundle = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new OperatorError("邀请码文件无法解析；请保留原文件，不要重新生成。"); }
  invitationRows(bundle);
  if (bundle.target !== target) throw new OperatorError("邀请码文件属于另一数据库；请为当前目标选择独立文件。");
  return bundle;
}

async function writePrivateFile(path, content) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(content, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export function parseWranglerOutput(output, { file = false } = {}) {
  // D1 import can report success as plain text even with --json. Its result is
  // always confirmed by a separate strict aggregate query before reporting success.
  if (file) return null;
  try { return JSON.parse(output); }
  catch { throw new OperatorError("远端 D1 结果无法确认；保留邀请码文件，用相同命令重试。"); }
}

async function wrangler(args, cwd) {
  return new Promise((done, reject) => {
    const child = spawn("npx", ["--no-install", "wrangler", "d1", "execute", "DB", "--remote", "--json", ...args], {
      cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let output = ""; let size = 0;
    child.stdout.on("data", (value) => { size += value.length; if (size <= 1_000_000) output += value; else child.kill(); });
    child.stderr.on("data", () => {}); // CLI failures can echo SQL; never relay them.
    child.on("error", () => reject(new OperatorError("无法启动本机 Wrangler；请先安装项目依赖。")));
    child.on("close", (status) => {
      if (status !== 0 || size > 1_000_000) return reject(new OperatorError("远端 D1 操作未确认成功；保留邀请码文件，用相同命令重试，不要重新生成。"));
      try { done(parseWranglerOutput(output, { file: args.includes("--file") })); }
      catch (error) { reject(error); }
    });
  });
}

function firstResult(output) {
  const statements = Array.isArray(output) ? output : [output];
  if (statements.some((item) => item?.success === false)) throw new OperatorError("数据库查询失败；请先确认 0005 迁移已应用。");
  const row = statements.find((item) => Array.isArray(item?.results) && item.results.length)?.results[0];
  if (!row || !Number.isInteger(row.count) || !Number.isInteger(row.boundCount)) throw new OperatorError("数据库聚合结果无法确认。");
  return row;
}

async function main() {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  let remote = false; let requestedFile;
  for (let index = 2; index < process.argv.length; index += 1) {
    const flag = process.argv[index];
    if (flag === "--remote") remote = true;
    else if (flag === "--file" && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) requestedFile = process.argv[++index];
    else throw new OperatorError("支持 --remote 和 --file .data/文件名.json；默认仅初始化本机数据库。");
  }
  const dataRoot = resolve(projectRoot, ".data");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if (await realpath(dataRoot) !== dataRoot) throw new OperatorError(".data 目录不能是符号链接。");
  const filePath = resolve(projectRoot, requestedFile ?? ".data/invitations.json");
  const withinData = relative(dataRoot, filePath);
  if (!withinData || withinData.startsWith(`..${sep}`) || withinData === ".." || dirname(filePath) !== dataRoot) {
    throw new OperatorError("邀请码文件只能保存在项目 .data 目录内。");
  }
  const localPath = resolve(dataRoot, "youth-inn.sqlite");
  const config = remote ? JSON.parse(await readFile(resolve(projectRoot, "wrangler.json"), "utf8")) : null;
  const databaseId = config?.d1_databases?.find((item) => item.binding === "DB")?.database_id;
  if (remote && (typeof databaseId !== "string" || !databaseId)) throw new OperatorError("请先配置远端 D1 数据库。");
  const target = remote ? `remote:${databaseId}` : `local:${localPath}`;
  let db;
  try {
    if (!remote) { db = createLocalDatabase(localPath); await migrateLocalDatabase(db); }
    const query = async (sql) => remote ? firstResult(await wrangler(["--command", sql], projectRoot)) : db.prepare(sql).first();
    const initial = await query(buildInvitationStatsSql());
    if (![0, INVITATION_COUNT].includes(initial.count)) throw new OperatorError("现有邀请数量不是 0 或 5；请先人工核对，脚本不会重造邀请码。");
    if (initial.count === 0 && (initial.legacyVerifiedCount > INVITATION_COUNT || initial.overLimitOwnerCount > 0 || initial.attachedReminderCount > 0)) {
      throw new OperatorError("旧数据超过 5 人或每人 2 条上限，或存在异常绑定；请先人工核对，提醒状态保持原样。");
    }
    let bundle = await readPrivateBundle(filePath, target);
    if (!bundle) {
      if (initial.count !== 0) throw new OperatorError("数据库已有邀请码，但本机原文件丢失；禁止重新生成或自动轮换。");
      bundle = createInvitationBundle({ target });
      try { await writePrivateFile(filePath, JSON.stringify(bundle, null, 2) + "\n"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        bundle = await readPrivateBundle(filePath, target);
      }
    }
    if (initial.count === INVITATION_COUNT) {
      const existing = await query(buildInvitationStatsSql({ bundle }));
      if (existing.count !== INVITATION_COUNT || existing.matchingCount !== INVITATION_COUNT) throw new OperatorError("本机邀请码文件与数据库摘要不匹配；禁止重新生成或自动轮换。");
      process.stdout.write(JSON.stringify({ count: existing.count, boundCount: existing.boundCount, filePath }) + "\n");
      return;
    }
    const sql = buildInitializeInvitationsSql(bundle, { transaction: !remote });
    if (remote) {
      const sqlPath = resolve(dataRoot, `.invitations-${randomUUID()}.sql`);
      try { await writePrivateFile(sqlPath, sql); await wrangler(["--file", sqlPath], projectRoot); }
      finally { await unlink(sqlPath).catch(() => {}); }
    } else {
      try { await db.exec(sql); }
      catch (error) { await db.exec("ROLLBACK").catch(() => {}); throw error; }
    }
    const result = await query(buildInvitationStatsSql({ bundle }));
    if (result.count !== INVITATION_COUNT || result.matchingCount !== INVITATION_COUNT) throw new OperatorError("初始化结果无法确认；保留原文件，用相同命令重试。");
    process.stdout.write(JSON.stringify({ count: result.count, boundCount: result.boundCount, filePath }) + "\n");
  } finally { db?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof OperatorError ? error.message : "邀请码操作失败；确认迁移和文件权限，保留原文件后重试，不要重新生成。");
    process.exitCode = 1;
  }
}
