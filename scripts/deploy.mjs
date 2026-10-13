// Running this command explicitly publishes to the signed-in Cloudflare account.
// Secrets are passed on stdin, never as command arguments or written to config.
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReminderEnvironment } from "../src/infrastructure/mail.mjs";

// Pure preflight for callers/tests; importing this file never publishes a Worker.
export function validateDeploymentEnvironment(env = {}, { withMail = false, dryRun = false } = {}) {
  if (dryRun) return;
  if (Object.hasOwn(env, "APP_SECRET") &&
      (typeof env.APP_SECRET !== "string" || new TextEncoder().encode(env.APP_SECRET).length < 32)) {
    throw new Error("提供的 APP_SECRET 至少需要 32 字节；请使用安全随机值，不要写入仓库。");
  }
  if (withMail) {
    try {
      validateReminderEnvironment({ ...env,
        APP_SECRET: env.APP_SECRET ?? "deployment-validation-placeholder-32-bytes",
        PUBLIC_URL: "https://deployment-validation.example.test",
      });
    } catch {
      throw new Error("邮件配置无效：需要非空 BREVO_API_KEY 和有效 MAIL_FROM；不要把凭据写入仓库。");
    }
  }
}

async function main() {
  const cliPackage = new URL("../node_modules/wrangler/package.json", import.meta.url);
  const cliMetadata = JSON.parse(await readFile(cliPackage, "utf8"));
  const cli = fileURLToPath(new URL(cliMetadata.bin.wrangler, cliPackage));
  const configPath = resolve("wrangler.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some((flag) => !["--dry-run", "--with-mail"].includes(flag))) throw new Error("支持 --dry-run 或 --with-mail");
  validateDeploymentEnvironment(process.env, { withMail: flags.has("--with-mail"), dryRun: flags.has("--dry-run") });
  async function command(args, { input, capture = false } = {}) {
    return new Promise((done, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      });
      let output = "";
      if (capture) child.stdout.on("data", (value) => { output += value; });
      if (input !== undefined) child.stdin.end(input + "\n");
      child.on("error", reject);
      child.on("exit", (status) => status === 0 ? done(output) : reject(new Error(`Wrangler 操作失败（${args[0]}）`)));
    });
  }
  if (flags.has("--dry-run")) {
    await command(["deploy", "--dry-run", "--outdir", "dist/worker"]);
  } else {
    await command(["whoami"]);
    if (!config.d1_databases[0].database_id) {
      const databases = JSON.parse(await command(["d1", "list", "--json"], { capture: true }));
      const existing = databases.find((item) => item.name === config.d1_databases[0].database_name);
      if (existing) {
        config.d1_databases[0].database_id = existing.uuid;
        await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
      } else {
        await command(["d1", "create", config.d1_databases[0].database_name, "--binding", "DB", "--update-config"]);
      }
    }
    await command(["d1", "migrations", "apply", "DB", "--remote"]);
    const output = await command(["deploy"], { capture: true });
    process.stdout.write(output);
    const deployed = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
    if (!deployed) throw new Error("部署输出未包含 workers.dev 地址，请先检查 Cloudflare 部署状态。");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    saved.vars = { ...saved.vars, PUBLIC_URL: deployed };
    await writeFile(configPath, JSON.stringify(saved, null, 2) + "\n");
    const secrets = JSON.parse(await command(["secret", "list"], { capture: true }));
    if (!secrets.some((item) => item.name === "APP_SECRET")) {
      await command(["secret", "put", "APP_SECRET"], { input: process.env.APP_SECRET || randomBytes(32).toString("base64url") });
    }
    if (flags.has("--with-mail")) {
      await command(["secret", "put", "BREVO_API_KEY"], { input: process.env.BREVO_API_KEY });
      await command(["secret", "put", "MAIL_FROM"], { input: process.env.MAIL_FROM });
    }
    await command(["deploy"]);
    console.log(`网站地址：${deployed}`);
  console.log(flags.has("--with-mail") ? "邮件配置已上传，请完成验证邮件与目标收件箱验收。" : `部署完成，邮件配置状态：${deployed}/api/health`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
