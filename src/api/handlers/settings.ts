import { getDb } from "../../lib/db.js";
import { isSelfHosted } from "../../lib/mode.js";
import { json } from "../json.js";

type UserMeta = Record<string, unknown>;

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
    ...(body.meta as UserMeta),
  };
  const db = getDb();
  db.run(
    "UPDATE users SET meta = ? WHERE id = ?",
    JSON.stringify(merged),
    userId,
  );

  return json({ meta: merged });
}
