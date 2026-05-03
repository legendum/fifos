import { chargeWebhookWrite } from "../../lib/billing.js";
import { MAX_FAIL_REASON_BYTES, MAX_ITEM_BYTES } from "../../lib/constants.js";
import { getDb } from "../../lib/db.js";
import { parseDuration } from "../../lib/duration.js";
import {
  done,
  fail,
  getFifoByUlid,
  pop,
  pull,
  push,
  retry,
  skip,
} from "../../lib/queue.js";
import { publish, publishUserFifos, subscribe } from "../../lib/sse.js";
import { json } from "../json.js";
import { getFifosPayload } from "./fifos.js";

function notifyFifosChanged(userId: number): void {
  publishUserFifos(userId, () => getFifosPayload(userId));
}

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
    notifyFifosChanged(fifo.user_id);
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

/** POST /w/:ulid/pop — atomically todo→done. */
export async function postPop(_req: Request, ulid: string): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const row = pop(fifo.id);
  if (!row) return new Response(null, { status: 204 });

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  notifyFifosChanged(fifo.user_id);

  return json({
    id: row.id,
    data: row.data,
    position: row.position,
    created_at: row.created_at,
  });
}

/** POST /w/:ulid/pull[?lock=<dur>] — atomically todo→lock. */
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
  notifyFifosChanged(fifo.user_id);

  return json({
    id: row.id,
    data: row.data,
    position: row.position,
    created_at: row.created_at,
    locked_until: row.locked_until,
  });
}

/** POST /w/:ulid/done/:id — locked item → done. */
export async function postDone(
  _req: Request,
  ulid: string,
  itemUlid: string,
): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const row = done(fifo.id, itemUlid);
  if (!row) return json({ error: "not_locked" }, 404);

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", { id: row.id, status: row.status });
  notifyFifosChanged(fifo.user_id);

  return json({ id: row.id, status: row.status });
}

/**
 * POST /w/:ulid/fail/:id — locked item → fail.
 *
 * Optional text/plain body is the failure reason (max 1 KiB). Empty body or
 * whitespace-only is treated as no reason (stored NULL). Mirrors the body
 * shape of `push` for CLI symmetry.
 */
export async function postFail(
  req: Request,
  ulid: string,
  itemUlid: string,
): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();

  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_FAIL_REASON_BYTES) {
    return json(
      {
        error: "invalid_request",
        message: `Reason exceeds ${MAX_FAIL_REASON_BYTES} bytes`,
      },
      400,
    );
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf).trim();
  const reason = raw.length > 0 ? raw : null;

  const row = fail(fifo.id, itemUlid, reason);
  if (!row) return json({ error: "not_locked" }, 404);

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", {
    id: row.id,
    status: row.status,
    fail_reason: row.fail_reason,
  });
  notifyFifosChanged(fifo.user_id);

  return json({ id: row.id, status: row.status, fail_reason: row.fail_reason });
}

/**
 * POST /w/:ulid/skip/:id — locked item → skip (terminal; retry refuses).
 *
 * Optional text/plain body is the skip reason (max 1 KiB). Same body contract
 * as `fail`.
 */
export async function postSkip(
  req: Request,
  ulid: string,
  itemUlid: string,
): Promise<Response> {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();

  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_FAIL_REASON_BYTES) {
    return json(
      {
        error: "invalid_request",
        message: `Reason exceeds ${MAX_FAIL_REASON_BYTES} bytes`,
      },
      400,
    );
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf).trim();
  const reason = raw.length > 0 ? raw : null;

  const row = skip(fifo.id, itemUlid, reason);
  if (!row) return json({ error: "not_locked" }, 404);

  const chargeError = await chargeWebhookWrite(fifo.user_id);
  if (chargeError) return chargeError;
  publish(`fifo:${fifo.id}`, "change", {
    id: row.id,
    status: row.status,
    skip_reason: row.skip_reason,
  });
  notifyFifosChanged(fifo.user_id);

  return json({ id: row.id, status: row.status, skip_reason: row.skip_reason });
}

/** POST /w/:ulid/retry/:id — done/fail item → todo at the tail (same id). */
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
  publish(`fifo:${fifo.id}`, "change", {
    id: row.id,
    status: row.status,
    fail_reason: null,
  });
  notifyFifosChanged(fifo.user_id);

  return json({ id: row.id, status: row.status, position: row.position });
}

type StatusCounts = {
  todo: number;
  lock: number;
  done: number;
  fail: number;
  skip: number;
};

function getCounts(fifoId: number): StatusCounts {
  const db = getDb();
  const rows = db
    .query(
      "SELECT status, COUNT(*) as n FROM items WHERE fifo_id = ? GROUP BY status",
    )
    .all(fifoId) as Array<{ status: keyof StatusCounts; n: number }>;
  const counts: StatusCounts = { todo: 0, lock: 0, done: 0, fail: 0, skip: 0 };
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
  const total =
    counts.todo + counts.lock + counts.done + counts.fail + counts.skip;
  return respond(req, {
    name: fifo.name,
    slug: fifo.slug,
    ulid: fifo.ulid,
    counts,
    total,
  });
}

/** GET /w/:ulid/peek?n=5 — up to N oldest todo items, no status change. Free. */
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
        WHERE fifo_id = ? AND status = 'todo'
        ORDER BY position ASC
        LIMIT ?`,
    )
    .all(fifo.id, n);
  return respond(req, { items });
}

/**
 * GET /w/:ulid/list/:status?n=5[&reason=<substr>]
 *
 * `reason` is a case-insensitive substring filter against `fail_reason`. Only
 * meaningful for status=`fail`; ignored otherwise (rather than 400, since a
 * client might pipe the same query across statuses). `%` `_` `\` in the input
 * are escaped so the pattern matches literal text.
 *
 * Free.
 */
export function getList(req: Request, ulid: string, status: string): Response {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  if (!["todo", "lock", "done", "fail", "skip"].includes(status)) {
    return json(
      {
        error: "invalid_request",
        message: "status must be one of todo|lock|done|fail|skip",
      },
      400,
    );
  }
  const url = new URL(req.url);
  const n = clampN(url.searchParams.get("n"));
  const newestFirst =
    status === "done" || status === "fail" || status === "skip";

  const reasonRaw = url.searchParams.get("reason");
  const reasonCol =
    status === "fail"
      ? "fail_reason"
      : status === "skip"
        ? "skip_reason"
        : null;
  const useReason =
    reasonCol !== null && reasonRaw !== null && reasonRaw.length > 0;
  const reasonPattern = useReason ? `%${escapeLike(reasonRaw)}%` : null;

  const db = getDb();
  const sql = `SELECT ulid AS id, position, status, data, locked_until,
                      fail_reason, skip_reason, created_at, updated_at
                 FROM items
                WHERE fifo_id = ? AND status = ?${
                  useReason
                    ? ` AND ${reasonCol} IS NOT NULL AND ${reasonCol} LIKE ? ESCAPE '\\'`
                    : ""
                }
                ORDER BY position ${newestFirst ? "DESC" : "ASC"}
                LIMIT ?`;
  const items = useReason
    ? db.query(sql).all(fifo.id, status, reasonPattern, n)
    : db.query(sql).all(fifo.id, status, n);
  return respond(req, { items });
}

/** Escape SQL LIKE wildcards so the pattern matches literal text. Pair with `ESCAPE '\\'`. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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
      `SELECT ulid AS id, status, position, fail_reason, created_at, updated_at
         FROM items WHERE fifo_id = ? AND ulid = ?`,
    )
    .get(fifo.id, itemUlid) as
    | {
        id: string;
        status: string;
        position: number;
        fail_reason: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return json({ error: "not_found", reason: "item" }, 404);
  return respond(req, row);
}

/** GET /w/:ulid/items — SSE per-fifo stream. */
export function getItems(req: Request, ulid: string): Response {
  const fifo = getFifoByUlid(ulid);
  if (!fifo) return notFoundUlid();
  const lastEventId = req.headers.get("Last-Event-ID");
  return subscribe(`fifo:${fifo.id}`, lastEventId, { signal: req.signal });
}
