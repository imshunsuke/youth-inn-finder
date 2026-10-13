import { readFile, readdir } from "node:fs/promises";
import { createLocalDatabase } from "../../src/development/d1.mjs";

export function createTestDb() { return createLocalDatabase(); }
export const createTestDatabase = createTestDb;

export async function applyMigrations(db) {
  const directory = new URL("../../migrations/", import.meta.url);
  for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(filename, directory), "utf8"));
  }
  return db;
}
