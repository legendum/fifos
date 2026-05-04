import { getDb } from "../../lib/db.js";
import { isSelfHosted } from "../../lib/mode.js";
import { json } from "../json.js";

type UserMeta = Record<string, unknown>;

const ALLOWED_THEMES = new Set(["system", "light", "dark"]);

function sanitizeMeta(input: unknown): UserMeta {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const out: UserMeta = {};
  if (typeof record.theme === "string" && ALLOWED_THEMES.has(record.theme)) {
    out.theme = record.theme;
  }
  return out;
}

function readUserRow(
  userId: number,
): { legendum_token: string | null; meta: string } | undefined {
  const db = getDb();
  return db
    .query("SELECT legendum_token, meta FROM users WHERE id = ?")
    .get(userId) as { legendum_token: string | null; meta: string } | undefined;
}

function parseMeta(raw: string | undefined | null): UserMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as UserMeta;
    }
  } catch {}
  return {};
}

export function getMe(userId: number): Response {
  const row = readUserRow(userId);
  if (!row) return json({ error: "not_found", reason: "user" }, 404);

  return json({
    legendum_linked: !!row.legendum_token,
    hosted: !isSelfHosted(),
    meta: parseMeta(row.meta),
  });
}

export async function patchMe(req: Request, userId: number): Promise<Response> {
  let body: { meta?: unknown };
  try {
    body = (await req.json()) as { meta?: unknown };
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON" }, 400);
  }
  if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) {
    return json(
      { error: "invalid_request", message: "meta must be an object" },
      400,
    );
  }

  const row = readUserRow(userId);
  if (!row) return json({ error: "not_found", reason: "user" }, 404);

  const merged: UserMeta = {
    ...parseMeta(row.meta),
    ...sanitizeMeta(body.meta),
  };
  const db = getDb();
  db.run(
    "UPDATE users SET meta = ? WHERE id = ?",
    JSON.stringify(merged),
    userId,
  );

  return json({ meta: merged });
}
