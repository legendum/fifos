import { chargeWebhookWrite } from "../../lib/billing.js";
import { MAX_ITEM_BYTES } from "../../lib/constants.js";
import { parseDuration } from "../../lib/duration.js";
import { ack, getFifoByUlid, nack, pop, pull, push } from "../../lib/queue.js";
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
