import { chargeWebhookWrite } from "../../lib/billing.js";
import { MAX_ITEM_BYTES } from "../../lib/constants.js";
import { getDb } from "../../lib/db.js";
import { parseDuration } from "../../lib/duration.js";
import {
  ack,
  getFifoByUlid,
  nack,
  pop,
  pull,
  push,
  retry,
} from "../../lib/queue.js";
import { publish } from "../../lib/sse.js";
import { json } from "../json.js";

const NOT_FOUND_ULID = json({ error: "not_found", reason: "ulid" }, 404);

function notFoundUlid(): Response {
  return new Response(NOT_FOUND_ULID.body, {
    status: NOT_FOUND_ULID.status,
    headers: NOT_FOUND_ULID.headers,
  });
}

/** POST /w/:ulid/push — push an item, optional Idempotency-Key. */
export async function postPush(req: Request, ulid: string): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();

  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_ITEM_BYTES) {
    return json(
      {
        error: "invalid_request",
        message: `Body exceeds ${MAX_ITEM_BYTES} bytes`,
      },
      400,
    );
  }
  const data = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const idempotencyKey = req.headers.get("Idempotency-Key");

  const result = push(fifo.id, data, idempotencyKey);
  if (!result) {
    return json({ error: "fifo_full", reason: "fifo_full" }, 429);
  }

  if (!result.deduped) {
    const chargeError = await chargeWebhookWrite(fifo.user_id);
    if (chargeError) return chargeError;
    publish(`fifo:${fifo.id}`, "push", {
      id: result.id,
      position: result.position,
      created_at: result.created_at,
    });
    publish(`user:${fifo.user_id}`, "fifos", { fifoId: fifo.id });
  }

  return json(
    {
      id: result.id,
      position: result.position,
      created_at: result.created_at,
    },
    result.deduped ? 200 : 201,
  );
}

/** POST /w/:ulid/pop — atomically open→done. */
export async function postPop(_req: Request, ulid: string): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const row = pop(fifo.id);
  if (!row) return new Response(null, { status: 204 });

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  publish(`user:${fifo.user_id}`, "fifos", { fifoId: fifo.id });

  return json({
    id: row.id,
    data: row.data,
    position: row.position,
    created_at: row.created_at,
  });
}

/** POST /w/:ulid/pull[?lock=<dur>] — atomically open→lock. */
export async function postPull(req: Request, ulid: string): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();

  const url = new URL(req.url);
  const rawLock = url.searchParams.get("lock");
  const parsed = rawLock ? parseDuration(rawLock) : null;
  const row = pull(fifo.id, parsed);
  if (!row) return new Response(null, { status: 204 });

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  publish(`user:${fifo.user_id}`, "fifos", { fifoId: fifo.id });

  return json({
    id: row.id,
    data: row.data,
    position: row.position,
    created_at: row.created_at,
    locked_until: row.locked_until,
  });
}

/** POST /w/:ulid/ack/:id — locked item → done. */
export async function postAck(
  _req: Request,
  ulid: string,
  itemUlid: string,
): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const row = ack(fifo.id, itemUlid);
  if (!row) return json({ error: "not_locked" }, 404);

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  publish(`user:${fifo.user_id}`, "fifos", { fifoId: fifo.id });

  return json({ id: row.id, status: row.status });
}

/** POST /w/:ulid/nack/:id — locked item → fail. */
export async function postNack(
  _req: Request,
  ulid: string,
  itemUlid: string,
): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const row = nack(fifo.id, itemUlid);
  if (!row) return json({ error: "not_locked" }, 404);

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  publish(`user:${fifo.user_id}`, "fifos", { fifoId: fifo.id });

  return json({ id: row.id, status: row.status });
}

/** POST /w/:ulid/retry/:id — done/fail item → open at the tail (same id). */
export async function postRetry(
  _req: Request,
  ulid: string,
  itemUlid: string,
): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();

  const result = retry(fifo.id, itemUlid);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return json({ error: "not_found", reason: "item" }, 404);
    }
    return json({ error: "wrong_status" }, 409);
  }
  const row = result.row;

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  publish(`user:${fifo.user_id}`, "fifos", { fifoId: fifo.id });

  return json({ id: row.id, status: row.status, position: row.position });
}

type StatusCounts = { open: number; lock: number; done: number; fail: number };

function getCounts(fifoId: number): StatusCounts {
  const db = getDb();
  const rows = db
    .query(
      "SELECT status, COUNT(*) as n FROM items WHERE fifo_id = ? GROUP BY status",
    )
    .all(fifoId) as Array<{ status: keyof StatusCounts; n: number }>;
  const counts: StatusCounts = { open: 0, lock: 0, done: 0, fail: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

function negotiate(req: Request): "json" | "yaml" {
  const url = new URL(req.url);
  if (url.pathname.endsWith(".yaml")) return "yaml";
  if (url.pathname.endsWith(".json")) return "json";
  const accept = req.headers.get("Accept") ?? "";
  if (accept.includes("application/yaml") || accept.includes("text/yaml")) {
    return "yaml";
  }
  return "json";
}

function respond(req: Request, payload: unknown, status = 200): Response {
  if (negotiate(req) === "yaml") {
    const yaml = require("yaml");
    return new Response(yaml.stringify(payload), {
      status,
      headers: { "Content-Type": "application/yaml" },
    });
  }
  return json(payload, status);
}

function clampN(raw: string | null, def = 10, max = 100): number {
  const n = raw == null ? def : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/** GET /w/:ulid/info — counts + fifo summary. Free. */
export function getInfo(req: Request, ulid: string): Response {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const counts = getCounts(fifo.id);
  const total = counts.open + counts.lock + counts.done + counts.fail;
  return respond(req, {
    name: fifo.name,
    slug: fifo.slug,
    ulid: fifo.ulid,
    counts,
    total,
  });
}

/** GET /w/:ulid/peek?n=5 — up to N oldest open items, no status change. Free. */
export function getPeek(req: Request, ulid: string): Response {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const url = new URL(req.url);
  const n = clampN(url.searchParams.get("n"));
  const db = getDb();
  const items = db
    .query(
      `SELECT ulid AS id, position, status, data, locked_until, created_at, updated_at
         FROM items
        WHERE fifo_id = ? AND status = 'open'
        ORDER BY position ASC
        LIMIT ?`,
    )
    .all(fifo.id, n);
  return respond(req, { items });
}

/** GET /w/:ulid/list/:status?n=5. Free. */
export function getList(req: Request, ulid: string, status: string): Response {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  if (!["open", "lock", "done", "fail"].includes(status)) {
    return json(
      {
        error: "invalid_request",
        message: "status must be one of open|lock|done|fail",
      },
      400,
    );
  }
  const url = new URL(req.url);
  const n = clampN(url.searchParams.get("n"));
  const newestFirst = status === "done" || status === "fail";
  const db = getDb();
  const items = db
    .query(
      `SELECT ulid AS id, position, status, data, locked_until, created_at, updated_at
         FROM items
        WHERE fifo_id = ? AND status = ?
        ORDER BY position ${newestFirst ? "DESC" : "ASC"}
        LIMIT ?`,
    )
    .all(fifo.id, status, n);
  return respond(req, { items });
}

/** GET /w/:ulid/status/:id — single item state. Free. */
export function getStatus(
  req: Request,
  ulid: string,
  itemUlid: string,
): Response {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const db = getDb();
  const row = db
    .query(
      `SELECT ulid AS id, status, position, created_at, updated_at
         FROM items WHERE fifo_id = ? AND ulid = ?`,
    )
    .get(fifo.id, itemUlid) as
    | {
        id: string;
        status: string;
        position: number;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return json({ error: "not_found", reason: "item" }, 404);
  return respond(req, row);
}
