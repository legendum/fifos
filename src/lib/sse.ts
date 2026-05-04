/**
 * SSE pub/sub with per-scope ring buffers and Last-Event-ID replay (SPEC §6.5).
 *
 * Two scope shapes are used by callers:
 *   - `fifo:<fifoId>` — public per-fifo stream, payloads are small deltas
 *     ({ id, position, … }) for `push` / `change` events.
 *   - `user:<userId>` — authenticated per-user stream, payload is the full
 *     `GET /` JSON. Bursty writers are coalesced via `publishUserFifos`.
 *
 * Ring buffer holds the last 200 events per scope, each tagged with a
 * monotonic id from a single per-process counter. On reconnect with
 * `Last-Event-ID`, replay everything strictly newer; if the id is outside
 * the ring (stale or pre-restart) emit a single `resync` and resume live.
 *
 * The counter resets on process restart, which is fine — clients see a
 * stale id, get `resync`, and refetch.
 */

const RING_MAX = 200;
const KEEP_ALIVE_MS = 8_000;
const COALESCE_MS = 250;

let counter = 0;
function nextId(): number {
  counter += 1;
  return counter;
}

type EventEntry = { id: number; type: string; data: string };
type Scope = {
  ring: EventEntry[];
  listeners: Set<(e: EventEntry) => void>;
};

const scopes = new Map<string, Scope>();

function getScope(name: string): Scope {
  let s = scopes.get(name);
  if (!s) {
    s = { ring: [], listeners: new Set() };
    scopes.set(name, s);
  }
  return s;
}

export type PublishType = "push" | "change" | "purge" | "fifos" | "resync";

export function publish(
  scope: string,
  type: PublishType,
  payload: unknown,
): void {
  const s = getScope(scope);
  const entry: EventEntry = {
    id: nextId(),
    type,
    data: JSON.stringify(payload),
  };
  s.ring.push(entry);
  if (s.ring.length > RING_MAX) s.ring.shift();
  for (const l of s.listeners) l(entry);
}

/**
 * Coalesce per-user `fifos` events. A burst of pushes only fires one
 * snapshot 250ms after the last event in the burst — keeps the user stream
 * cheap when an agent is hammering a fifo. The per-fifo stream is NOT
 * coalesced (it powers `pop --block`).
 */
const userTimers = new Map<
  number,
  { timer: ReturnType<typeof setTimeout>; compute: () => unknown }
>();

export function publishUserFifos(
  userId: number,
  computePayload: () => unknown,
): void {
  const existing = userTimers.get(userId);
  if (existing) {
    existing.compute = computePayload;
    return;
  }
  const timer = setTimeout(() => {
    const t = userTimers.get(userId);
    userTimers.delete(userId);
    if (!t) return;
    publish(`user:${userId}`, "fifos", t.compute());
  }, COALESCE_MS);
  userTimers.set(userId, { timer, compute: computePayload });
}

function formatEvent(e: EventEntry): string {
  // SSE data lines are single-line: payload is JSON, no embedded newlines
  // unless the payload itself contains them. JSON.stringify never emits raw
  // newlines, so a single `data:` line is always valid here.
  return `event: ${e.type}\nid: ${e.id}\ndata: ${e.data}\n\n`;
}

export type SubscribeOptions = {
  signal?: AbortSignal;
  /** Emitted as the first event on a fresh connect (no Last-Event-ID). */
  initial?: { type: PublishType; payload: unknown };
};

export function subscribe(
  scopeName: string,
  lastEventId: string | null,
  opts: SubscribeOptions = {},
): Response {
  const scope = getScope(scopeName);
  let listener: ((e: EventEntry) => void) | undefined;
  let onAbort: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const close = () => {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        if (opts.signal && onAbort) {
          opts.signal.removeEventListener("abort", onAbort);
          onAbort = undefined;
        }
        if (listener) {
          scope.listeners.delete(listener);
          listener = undefined;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (e: EventEntry) => {
        try {
          controller.enqueue(encoder.encode(formatEvent(e)));
        } catch {
          close();
        }
      };

      const parsed = lastEventId
        ? Number.parseInt(lastEventId, 10)
        : Number.NaN;
      const hasLastId = Number.isFinite(parsed) && parsed > 0;

      if (hasLastId) {
        const ring = scope.ring;
        const head = ring.length ? ring[ring.length - 1].id : 0;
        const tail = ring.length ? ring[0].id : 0;
        if (parsed > head || (ring.length > 0 && parsed < tail - 1)) {
          send({ id: nextId(), type: "resync", data: "{}" });
        } else {
          for (const e of ring) {
            if (e.id > parsed) send(e);
          }
        }
      } else if (opts.initial) {
        send({
          id: nextId(),
          type: opts.initial.type,
          data: JSON.stringify(opts.initial.payload),
        });
      }

      listener = (e) => send(e);
      scope.listeners.add(listener);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          close();
        }
      }, KEEP_ALIVE_MS);

      if (opts.signal) {
        if (opts.signal.aborted) {
          close();
          return;
        }
        onAbort = () => close();
        opts.signal.addEventListener("abort", onAbort);
      }
    },
    cancel() {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (opts.signal && onAbort) {
        opts.signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
      if (listener) {
        scope.listeners.delete(listener);
        listener = undefined;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      // Nginx: stop buffering streamed frames (SSE must flush through immediately).
      "X-Accel-Buffering": "no",
    },
  });
}
