import { getUserIdFromRequest } from "../lib/auth.js";
import { getDb } from "../lib/db.js";
import { json } from "./json.js";

export function getAuthUserId(req: Request): number | null {
  const userId = getUserIdFromRequest(req);
  if (userId) {
    const db = getDb();
    const row = db.query("SELECT 1 FROM users WHERE id = ?").get(userId);
    return row ? userId : null;
  }
  return null;
}

/**
 * Resolve the authenticated user: session cookie, or Bearer **account_token**
 * (same opaque string returned by `POST /f/legendum/link-key` and stored in
 * `users.legendum_token`).
 *
 * Legendum account keys (`lak_…`) are not accepted here — clients call
 * `POST …/link-key` with `Authorization: Bearer <lak_…>` to obtain an
 * account_token, then use that on subsequent requests.
 */
export async function getAuthUserIdWithBearer(
  req: Request,
): Promise<number | null> {
  const cookieId = getAuthUserId(req);
  if (cookieId) return cookieId;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const bearer = authHeader.slice(7).trim();
  if (!bearer) return null;

  const db = getDb();
  const row = db
    .query("SELECT id FROM users WHERE legendum_token = ?")
    .get(bearer) as { id: number } | undefined;
  return row?.id ?? null;
}

export function requireAuth(req: Request): { userId: number } | Response {
  const userId = getAuthUserId(req);
  if (!userId) {
    return json({ error: "unauthorized", message: "Not authenticated" }, 401);
  }
  return { userId };
}

export async function requireAuthAsync(
  req: Request,
): Promise<{ userId: number } | Response> {
  const userId = await getAuthUserIdWithBearer(req);
  if (!userId) {
    return json({ error: "unauthorized", message: "Not authenticated" }, 401);
  }
  return { userId };
}
