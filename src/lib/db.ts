import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "../..");

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    const path = resolve(
      ROOT_DIR,
      process.env.FIFOS_DB_PATH || "data/fifos.db",
    );
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    runSchema();
  }
  return db;
}

function runSchema(): void {
  const schemaPath = join(ROOT_DIR, "config/schema.sql");
  try {
    const sql = readFileSync(schemaPath, "utf-8");
    db!.exec(sql);
  } catch (e) {
    console.warn("Could not run schema.sql", e);
  }
}
