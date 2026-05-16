/**
 * Subscribes to a server SSE stream and routes named events to handlers.
 * Tracks op_ids issued by `dispatch()` so the matching server echo is
 * dropped (SPEC §7.2 — optimistic-UI safety).
 *
 * Consumers typically use this transitively via `useResource`; only reach
 * for it directly when you need a stream outside the resource model
 * (e.g. a notifications fan-out).
 */

import { useEffect, useMemo, useRef } from "react";

import { newId } from "../objects/newId";

export type SseEventHandler = (
  data: unknown,
  opts: { op_id: string | null },
) => void;

export type UseSSEOptions = {
  path?: string;
  enabled?: boolean;
};

export type UseSSEResult = {
  /** Mint a new op_id and remember it; subsequent server echoes are dropped. */
  newOpId: () => string;
  /** Allow a server event with this op_id to be applied (used by callers
   * that wish to clear an op_id ahead of receiving an echo). */
  forgetOpId: (opId: string) => void;
};

const DEFAULT_PATH = "/api/events";

export function useSSE(
  handlers: Record<string, SseEventHandler>,
  options: UseSSEOptions = {},
): UseSSEResult {
  const path = options.path ?? DEFAULT_PATH;
  const enabled = options.enabled ?? true;

  // Op-ids minted by this client. Server echoes carrying any of these are
  // dropped; foreign events (op_id null or unknown) are applied.
  const ownOpIds = useRef<Set<string>>(new Set());
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined")
      return;
    const es = new EventSource(path, { withCredentials: true });

    const dispatch = (name: string) => (ev: MessageEvent<string>) => {
      const handler = handlersRef.current[name];
      if (!handler) return;
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const opId =
        data && typeof data === "object" && "op_id" in (data as object)
          ? ((data as { op_id?: string | null }).op_id ?? null)
          : null;
      if (opId != null && ownOpIds.current.has(opId)) {
        ownOpIds.current.delete(opId);
        return;
      }
      handler(data, { op_id: opId });
    };

    for (const eventName of Object.keys(handlersRef.current)) {
      es.addEventListener(eventName, dispatch(eventName) as EventListener);
    }
    return () => {
      es.close();
    };
  }, [path, enabled]);

  return useMemo(
    () => ({
      newOpId: () => {
        const id = newId();
        ownOpIds.current.add(id);
        return id;
      },
      forgetOpId: (opId: string) => {
        ownOpIds.current.delete(opId);
      },
    }),
    [],
  );
}
