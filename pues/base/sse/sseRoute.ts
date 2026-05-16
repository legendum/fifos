/**
 * Server-Sent Events with per-user fan-out (SPEC §7).
 *
 * Two things come out of `sseRoute()`:
 *   1. A route map the consumer spreads into Bun.serve — typically
 *      `{ "/api/events": { GET } }`.
 *   2. A `broadcast(userId, event, data, { op_id })` function that mutation
 *      handlers call after a successful write. Broadcasts are scoped by
 *      `userId`; there is intentionally no global-broadcast helper, so it is
 *      impossible to ship one user's mutations to another user's stream.
 *
 * Anonymous visitors (resolveUser → null) get a 401: SSE always implies an
 * authenticated stream. Public-read consumers (linkobot) still serve their
 * `auth: { get: "public" }` data via REST; they just don't receive live
 * updates over SSE.
 */

import type { ResolveUserFn } from "../objects/mountResource";

export type Broadcast = (
  userId: number,
  event: string,
  data: unknown,
  opts?: { op_id?: string | null },
) => void;

export type SseRouteArgs = {
  resolveUser: ResolveUserFn;
  path?: string;
  heartbeatMs?: number;
};

export type SseRouteResult = {
  routes: Record<
    string,
    Record<string, (req: Request) => Response | Promise<Response>>
  >;
  broadcast: Broadcast;
  streamCount: () => number;
};

const DEFAULT_PATH = "/api/events";
const DEFAULT_HEARTBEAT_MS = 20_000;

type StreamCtrl = {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
};

export function sseRoute(args: SseRouteArgs): SseRouteResult {
  const path = args.path ?? DEFAULT_PATH;
  const heartbeatMs = args.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const streams = new Map<number, Set<StreamCtrl>>();
  const encoder = new TextEncoder();

  const handler = async (req: Request): Promise<Response> => {
    const uid = await args.resolveUser(req);
    if (uid == null) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return makeStreamResponse(req, uid, streams, heartbeatMs, encoder);
  };

  const broadcast: Broadcast = (userId, event, data, opts) => {
    const set = streams.get(userId);
    if (!set || set.size === 0) return;
    const payload =
      typeof data === "object" && data !== null
        ? { ...(data as object), op_id: opts?.op_id ?? null }
        : { value: data, op_id: opts?.op_id ?? null };
    const chunk = encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
    );
    for (const ctrl of set) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        // controller closed under our feet — drop it silently
      }
    }
  };

  const streamCount = () => {
    let n = 0;
    for (const s of streams.values()) n += s.size;
    return n;
  };

  return {
    routes: { [path]: { GET: handler } },
    broadcast,
    streamCount,
  };
}

function makeStreamResponse(
  req: Request,
  uid: number,
  streams: Map<number, Set<StreamCtrl>>,
  heartbeatMs: number,
  encoder: TextEncoder,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const ctrl: StreamCtrl = {
        enqueue: (chunk) => controller.enqueue(chunk),
        close: () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };

      let set = streams.get(uid);
      if (!set) {
        set = new Set();
        streams.set(uid, set);
      }
      set.add(ctrl);

      // Initial comment so EventSource sees a successful connect.
      controller.enqueue(encoder.encode(`: connected\n\n`));

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);

      const teardown = () => {
        clearInterval(heartbeat);
        set!.delete(ctrl);
        if (set!.size === 0) streams.delete(uid);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", teardown, { once: true });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
