import type { Database } from "bun:sqlite";

export type ThemePref = "system" | "dark" | "light";

const ALLOWED = new Set<ThemePref>(["system", "light", "dark"]);

function isThemePref(v: unknown): v is ThemePref {
  return typeof v === "string" && ALLOWED.has(v as ThemePref);
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {}
  return {};
}

export function getTheme(db: Database, userId: number): ThemePref | null {
  const row = db
    .query("SELECT meta FROM users WHERE id = ?")
    .get(userId) as { meta: string } | undefined;
  if (!row) return null;
  const meta = parseMeta(row.meta);
  return isThemePref(meta.theme) ? meta.theme : null;
}

export function setTheme(db: Database, userId: number, value: ThemePref): void {
  if (!isThemePref(value)) {
    throw new Error(`Invalid theme: ${String(value)}`);
  }
  const row = db
    .query("SELECT meta FROM users WHERE id = ?")
    .get(userId) as { meta: string } | undefined;
  if (!row) throw new Error(`User ${userId} not found`);
  const merged = { ...parseMeta(row.meta), theme: value };
  db.run(
    "UPDATE users SET meta = ? WHERE id = ?",
    JSON.stringify(merged),
    userId,
  );
}
