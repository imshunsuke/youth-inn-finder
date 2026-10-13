// Local development and integration tests only. Production uses Cloudflare D1.
import { DatabaseSync } from "node:sqlite";

class Statement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    if (parameters.some((value) => value === undefined)) throw new TypeError("Cannot bind undefined");
    return new Statement(this.database, this.sql, parameters);
  }

  execute() {
    const statement = this.database.prepare(this.sql);
    const rows = statement.columns().length > 0;
    const result = rows ? statement.all(...this.parameters) : statement.run(...this.parameters);
    return {
      success: true,
      results: rows ? result.map((row) => ({ ...row })) : [],
      meta: {
        changes: rows ? 0 : Number(result.changes),
        last_row_id: rows ? 0 : Number(result.lastInsertRowid),
        duration: 0,
      },
    };
  }

  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.parameters);
    if (!row) return null;
    return column === undefined ? { ...row } : row[column] ?? null;
  }
  async raw({ columnNames = false } = {}) {
    const statement = this.database.prepare(this.sql);
    const names = statement.columns().map((column) => column.name);
    const rows = statement.all(...this.parameters).map((row) => names.map((name) => row[name]));
    return columnNames ? [names, ...rows] : rows;
  }
}

export function createLocalDatabase(path = ":memory:") {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL;");
  return {
    prepare(sql) { return new Statement(database, sql); },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      database.exec(sql);
      return { count: 1, duration: 0 };
    },
    close() { database.close(); },
  };
}
