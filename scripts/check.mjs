import { readdir, readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}
const targets = [resolve("server.mjs"), ...await files("src"), ...await files("public"),
  ...await files("scripts"), ...await files("test")].filter((path) => [".js", ".mjs"].includes(extname(path)));
for (const path of targets) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const config = JSON.parse(await readFile("wrangler.json", "utf8"));
if (config.main !== "src/worker.mjs" || config.assets?.binding !== "ASSETS" || config.d1_databases?.[0]?.binding !== "DB") {
  throw new Error("Worker 配置与应用入口不一致");
}
const html = await readFile("public/index.html", "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
if (new Set(ids).size !== ids.length) throw new Error("页面存在重复 ID");
console.log(`语法与入口检查通过：${targets.length} 个 JavaScript 文件。`);
