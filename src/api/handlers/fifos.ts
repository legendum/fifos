import { chargeFifoCreate } from "../../lib/billing.js";
import { MAX_FIFOS_PER_USER } from "../../lib/constants.js";
import { getDb } from "../../lib/db.js";
import { toSlug, validateFifoName } from "../../lib/fifos.js";
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
  created_at: number;
  updated_at: number;
};

type StatusCounts = {
  open: number;
  lock: number;
  done: number;
  fail: number;
};

type FifoSummary = {
  name: string;
  slug: string;
  ulid: string;
  position: number;
  counts: StatusCounts;
  created_at: number;
};

type CountRow = {
  fifo_id: number;
  status: "open" | "lock" | "done" | "fail";
  n: number;
};

function emptyCounts(): StatusCounts {
  return { open: 0, lock: 0, done: 0, fail: 0 };
}

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

export function getFifosPayload(userId: number): { fifos: FifoSummary[] } {
  const db = getDb();
  const rows = db
    .query(
      "SELECT id, ulid, name, slug, position, created_at FROM fifos WHERE user_id = ? ORDER BY position, id",
    )
    .all(userId) as FifoRow[];

  const counts = getCountsByFifo(rows.map((r) => r.id));
  const fifos = rows.map((r) => ({
    name: r.name,
    slug: r.slug,
    ulid: r.ulid,
    position: r.position,
    counts: counts.get(r.id) ?? emptyCounts(),
    created_at: r.created_at,
  }));
  return { fifos };
}

function notifyFifosChanged(userId: number): void {
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
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON" }, 400);
  }

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
  if (countRow.n >= MAX_FIFOS_PER_USER) {
    return json(
      {
        error: "forbidden",
        message: `Fifo limit reached (${MAX_FIFOS_PER_USER} per account)`,
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
  db.run(
    "INSERT INTO fifos (user_id, ulid, name, slug, position) VALUES (?, ?, ?, ?, ?)",
    userId,
    id,
    name!,
    slug,
    position,
  );

  notifyFifosChanged(userId);

  return json(
    {
      name,
      slug,
      ulid: id,
      webhook_url: `/w/${id}`,
      position,
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
      "SELECT id, ulid, name, slug, position, created_at FROM fifos WHERE user_id = ? AND slug = ?",
    )
    .get(userId, slug) as FifoRow | undefined;
  if (!row) return json({ error: "not_found", reason: "fifo" }, 404);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "open";
  if (!["open", "lock", "done", "fail"].includes(statusParam)) {
    return json(
      {
        error: "invalid_request",
        message: "status must be one of open|lock|done|fail",
      },
      400,
    );
  }

  const newestFirst = statusParam === "done" || statusParam === "fail";
  const items = db
    .query(
      `SELECT ulid AS id, position, status, data, locked_until, fail_reason, created_at, updated_at
         FROM items
        WHERE fifo_id = ? AND status = ?
        ORDER BY position ${newestFirst ? "DESC" : "ASC"}`,
    )
    .all(row.id, statusParam);

  const counts = getCountsByFifo([row.id]).get(row.id) ?? emptyCounts();

  const payload = {
    name: row.name,
    slug: row.slug,
    ulid: row.ulid,
    counts,
    items,
  };

  if (format === "json") return json(payload);
  if (format === "yaml") {
    // yaml.stringify is loaded via `yaml` dep (Phase 0). Lazy require to avoid
    // top-level import cost when JSON is the common case.
    const yaml = require("yaml");
    return new Response(yaml.stringify(payload), {
      headers: { "Content-Type": "application/yaml" },
    });
  }

  // HTML — return null so server.ts serves the SPA shell (Phase 10+).
  return null;
}

/** PATCH /:slug — rename. */
export async function renameFifo(
  req: Request,
  oldSlug: string,
  userId: number,
): Promise<Response> {
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON" }, 400);
  }

  const name = body.name?.trim();
  const nameError = validateFifoName(name || "");
  if (nameError)
    return json({ error: "invalid_request", message: nameError }, 400);

  const newSlug = toSlug(name!);
  const db = getDb();

  const row = db
    .query("SELECT id, slug FROM fifos WHERE user_id = ? AND slug = ?")
    .get(userId, oldSlug) as FifoRow | undefined;
  if (!row) return json({ error: "not_found", reason: "fifo" }, 404);

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

  db.run(
    "UPDATE fifos SET name = ?, slug = ?, updated_at = strftime('%s','now') WHERE id = ?",
    name!,
    newSlug,
    row.id,
  );

  notifyFifosChanged(userId);
  return json({ name, slug: newSlug, old_slug: oldSlug });
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
