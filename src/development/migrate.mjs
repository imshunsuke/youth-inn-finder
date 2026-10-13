import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function migrateLocalDatabase(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((value) => value.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await db.prepare("SELECT checksum FROM local_schema_migrations WHERE name = ?").bind(name).first();
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`已应用的迁移被修改：${name}。请新增迁移。`);
      continue;
    }
    await db.exec("BEGIN IMMEDIATE");
    try {
      await db.exec(sql);
      await db.prepare("INSERT INTO local_schema_migrations (name, checksum) VALUES (?, ?)").bind(name, checksum).run();
      await db.exec("COMMIT");
    } catch (error) { await db.exec("ROLLBACK"); throw error; }
  }
}
