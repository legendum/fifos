import { YAML } from "bun";

import { chargeFifoCreate } from "../../lib/billing.js";
import {
  DEFAULT_FIFO_MAX_RETRIES,
  MAX_FIFO_MAX_RETRIES,
  MIN_FIFO_MAX_RETRIES,
  maxFifosPerUser,
} from "../../lib/constants.js";
import { getDb } from "../../lib/db.js";
import { toSlug, validateFifoName } from "../../lib/fifos.js";
import {
  emptyCounts,
  ITEM_STATUSES_PIPE,
  type ItemStatus,
  isItemStatus,
  type StatusCounts,
} from "../../lib/queue.js";
import { publishUserFifos, subscribe } from "../../lib/sse.js";
import { ulid } from "../../lib/ulid.js";
import { json } from "../json.js";

type FifoRow = {
  id: number;
  user_id: number;
  ulid: string;
  name: string;
  slug: string;
  position: number;
  seq: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
};

type FifoSummary = {
  name: string;
  slug: string;
  ulid: string;
  position: number;
  max_retries: number;
  counts: StatusCounts;
  created_at: number;
};

type CountRow = {
  fifo_id: number;
  status: ItemStatus;
  n: number;
};

function getCountsByFifo(fifoIds: number[]): Map<number, StatusCounts> {
  const map = new Map<number, StatusCounts>();
  if (fifoIds.length === 0) return map;
  const placeholders = fifoIds.map(() => "?").join(",");
  const db = getDb();
  const rows = db
    .query(
      `SELECT fifo_id, status, COUNT(*) as n FROM items
        WHERE fifo_id IN (${placeholders})
        GROUP BY fifo_id, status`,
    )
    .all(...fifoIds) as CountRow[];
  for (const r of rows) {
    if (!map.has(r.fifo_id)) map.set(r.fifo_id, emptyCounts());
    map.get(r.fifo_id)![r.status] = r.n;
  }
  return map;
}

/** `value === undefined` is valid (caller omits field). */
function maxRetriesIfInvalid(value: unknown): Response | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_FIFO_MAX_RETRIES ||
    value > MAX_FIFO_MAX_RETRIES
  ) {
    return json(
      {
        error: "invalid_request",
        message: `max_retries must be an integer from ${MIN_FIFO_MAX_RETRIES} to ${MAX_FIFO_MAX_RETRIES}`,
      },
      400,
    );
  }
  return null;
}

export function getFifosPayload(userId: number): { fifos: FifoSummary[] } {
  const db = getDb();
  const rows = db
    .query(
      "SELECT id, ulid, name, slug, position, max_retries, created_at FROM fifos WHERE user_id = ? ORDER BY position, id",
    )
    .all(userId) as FifoRow[];

  const counts = getCountsByFifo(rows.map((r) => r.id));
  const fifos = rows.map((r) => ({
    name: r.name,
    slug: r.slug,
    ulid: r.ulid,
    position: r.position,
    max_retries: r.max_retries,
    counts: counts.get(r.id) ?? emptyCounts(),
    created_at: r.created_at,
  }));
  return { fifos };
}

export function notifyFifosChanged(userId: number): void {
  publishUserFifos(userId, () => getFifosPayload(userId));
}

/** GET / — list user's fifos. */
export function indexFifos(userId: number): Response {
  return json(getFifosPayload(userId));
}

/** GET /f/fifos/items — SSE per-user stream; initial event is the GET / payload. */
export function getFifosStream(req: Request, userId: number): Response {
  const lastEventId = req.headers.get("Last-Event-ID");
  return subscribe(`user:${userId}`, lastEventId, {
    signal: req.signal,
    initial: { type: "fifos", payload: getFifosPayload(userId) },
  });
}

/** POST / — create fifo. */
export async function createFifo(
  req: Request,
  userId: number,
): Promise<Response> {
  let body: { name?: string; max_retries?: number };
  try {
    body = (await req.json()) as { name?: string; max_retries?: number };
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON" }, 400);
  }

  const maxRetriesIn = body.max_retries;
  const maxRetriesErr = maxRetriesIfInvalid(maxRetriesIn);
  if (maxRetriesErr) return maxRetriesErr;

  const name = body.name?.trim();
  const nameError = validateFifoName(name || "");
  if (nameError)
    return json({ error: "invalid_request", message: nameError }, 400);

  const slug = toSlug(name!);
  const db = getDb();

  const existing = db
    .query("SELECT 1 FROM fifos WHERE user_id = ? AND slug = ?")
    .get(userId, slug);
  if (existing) {
    return json(
      {
        error: "invalid_request",
        message: `A fifo with URL "${slug}" already exists`,
      },
      400,
    );
  }

  const countRow = db
    .query("SELECT COUNT(*) AS n FROM fifos WHERE user_id = ?")
    .get(userId) as { n: number };
  // Includes starter fifo from seedDefaultFifosForNewUser, if any.
  if (countRow.n >= maxFifosPerUser()) {
    return json(
      {
        error: "forbidden",
        message: `Fifo limit reached (${maxFifosPerUser()} per account)`,
      },
      403,
    );
  }

  const chargeError = await chargeFifoCreate(userId);
  if (chargeError) return chargeError;

  const maxPos = db
    .query(
      "SELECT COALESCE(MAX(position), -1) AS max_pos FROM fifos WHERE user_id = ?",
    )
    .get(userId) as { max_pos: number };

  const id = ulid();
  const position = maxPos.max_pos + 1;
  const resolvedMax = maxRetriesIn ?? DEFAULT_FIFO_MAX_RETRIES;
  db.run(
    "INSERT INTO fifos (user_id, ulid, name, slug, position, max_retries) VALUES (?, ?, ?, ?, ?, ?)",
    userId,
    id,
    name!,
    slug,
    position,
    resolvedMax,
  );

  notifyFifosChanged(userId);

  return json(
    {
      name,
      slug,
      ulid: id,
      webhook_url: `/w/${id}`,
      position,
      max_retries: resolvedMax,
    },
    201,
  );
}

/** GET /:slug — fifo detail with items filtered by status. */
export function getFifo(
  req: Request,
  rawSlug: string,
  userId: number,
): Response | null {
  const db = getDb();

  let format = "html";
  let slug = rawSlug;
  if (slug.endsWith(".json")) {
    format = "json";
    slug = slug.slice(0, -5);
  } else if (slug.endsWith(".yaml")) {
    format = "yaml";
    slug = slug.slice(0, -5);
  } else {
    const accept = req.headers.get("Accept") ?? "";
    if (accept.includes("application/json")) format = "json";
    else if (
      accept.includes("application/yaml") ||
      accept.includes("text/yaml")
    )
      format = "yaml";
  }

  const row = db
    .query(
      "SELECT id, ulid, name, slug, position, max_retries, created_at FROM fifos WHERE user_id = ? AND slug = ?",
    )
    .get(userId, slug) as FifoRow | undefined;
  if (!row) return json({ error: "not_found", reason: "fifo" }, 404);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "todo";
  if (!isItemStatus(statusParam)) {
    return json(
      {
        error: "invalid_request",
        message: `status must be one of ${ITEM_STATUSES_PIPE}`,
      },
      400,
    );
  }

  const newestFirst =
    statusParam === "done" || statusParam === "fail" || statusParam === "skip";

  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
  /** Keyset pagination: pass the last-visible row's `position` after `has_more`. */
  let cursor: number | null = null;
  const cursorStr = url.searchParams.get("cursor");
  if (cursorStr !== null && cursorStr !== "") {
    const n = Number.parseInt(cursorStr, 10);
    if (Number.isFinite(n)) cursor = n;
  }
  const q = url.searchParams.get("q")?.trim() ?? "";

  const cursorClause =
    cursor !== null
      ? newestFirst
        ? " AND position < ?"
        : " AND position > ?"
      : "";
  const qClause = q ? " AND lower(data) LIKE '%' || lower(?) || '%'" : "";
  const params: Array<string | number> = [row.id, statusParam];
  if (cursor !== null) params.push(cursor);
  if (q) params.push(q);
  params.push(limit + 1);

  const fetched = db
    .query(
      `SELECT ulid AS id, position, status, data, locked_until, reason,
              created_at, updated_at
         FROM items
        WHERE fifo_id = ? AND status = ?${cursorClause}${qClause}
        ORDER BY position ${newestFirst ? "DESC" : "ASC"}
        LIMIT ?`,
    )
    .all(...params) as unknown[];
  const has_more = fetched.length > limit;
  const items = has_more ? fetched.slice(0, limit) : fetched;

  const counts = getCountsByFifo([row.id]).get(row.id) ?? emptyCounts();

  const payload = {
    name: row.name,
    slug: row.slug,
    ulid: row.ulid,
    max_retries: row.max_retries,
    counts,
    items,
    has_more,
  };

  if (format === "json") return json(payload);
  if (format === "yaml") {
    return new Response(YAML.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/yaml" },
    });
  }

  // HTML — return null so server.ts serves the SPA shell (Phase 10+).
  return null;
}

/** PATCH /:slug — rename and/or update max_retries. */
export async function renameFifo(
  req: Request,
  oldSlug: string,
  userId: number,
): Promise<Response> {
  let body: { name?: string; max_retries?: number };
  try {
    body = (await req.json()) as { name?: string; max_retries?: number };
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON" }, 400);
  }

  const nameIn = body.name?.trim();
  const maxIn = body.max_retries;

  if ((!nameIn || nameIn.length === 0) && maxIn === undefined) {
    return json(
      {
        error: "invalid_request",
        message: "Provide name and/or max_retries",
      },
      400,
    );
  }

  const maxInErr = maxRetriesIfInvalid(maxIn);
  if (maxInErr) return maxInErr;

  const db = getDb();

  const row = db
    .query("SELECT id, slug, name FROM fifos WHERE user_id = ? AND slug = ?")
    .get(userId, oldSlug) as
    | { id: number; slug: string; name: string }
    | undefined;
  if (!row) return json({ error: "not_found", reason: "fifo" }, 404);

  let newName = row.name;
  let newSlug = row.slug;

  if (nameIn && nameIn.length > 0) {
    const nameError = validateFifoName(nameIn);
    if (nameError)
      return json({ error: "invalid_request", message: nameError }, 400);

    newSlug = toSlug(nameIn);
    newName = nameIn;

    if (newSlug !== row.slug) {
      const existing = db
        .query("SELECT 1 FROM fifos WHERE user_id = ? AND slug = ?")
        .get(userId, newSlug);
      if (existing) {
        return json(
          {
            error: "invalid_request",
            message: `A fifo with URL "${newSlug}" already exists`,
          },
          400,
        );
      }
    }
  }

  const setParts: string[] = [];
  const args: unknown[] = [];
  if (nameIn && nameIn.length > 0) {
    setParts.push("name = ?", "slug = ?");
    args.push(newName, newSlug);
  }
  if (maxIn !== undefined) {
    setParts.push("max_retries = ?");
    args.push(maxIn);
  }
  setParts.push("updated_at = strftime('%s','now')");
  args.push(row.id);
  db.run(`UPDATE fifos SET ${setParts.join(", ")} WHERE id = ?`, ...args);

  notifyFifosChanged(userId);

  const out: Record<string, unknown> = {};
  if (nameIn && nameIn.length > 0) {
    out.name = newName;
    out.slug = newSlug;
    out.old_slug = oldSlug;
  }
  if (maxIn !== undefined) out.max_retries = maxIn;
  return json(out);
}

/** DELETE /:slug — cascade-delete via FK. */
export function deleteFifo(slug: string, userId: number): Response {
  const db = getDb();
  const result = db.run(
    "DELETE FROM fifos WHERE user_id = ? AND slug = ?",
    userId,
    slug,
  );
  if (result.changes === 0)
    return json({ error: "not_found", reason: "fifo" }, 404);
  notifyFifosChanged(userId);
  return json({ ok: true });
}

/** PATCH /f/reorder — body { order: [slug, …] }. */
export async function reorderFifos(
  req: Request,
  userId: number,
): Promise<Response> {
  let body: { order?: string[] };
  try {
    body = (await req.json()) as { order?: string[] };
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.order)) {
    return json(
      {
        error: "invalid_request",
        message: "order must be an array of fifo slugs",
      },
      400,
    );
  }

  const db = getDb();
  const stmt = db.prepare(
    "UPDATE fifos SET position = ? WHERE user_id = ? AND slug = ?",
  );
  for (let i = 0; i < body.order.length; i++) {
    stmt.run(i, userId, body.order[i]);
  }

  notifyFifosChanged(userId);
  return json({ ok: true });
}
