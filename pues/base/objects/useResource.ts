/**
 * Client-side hook over `GET /api/<name>` + the SSE event stream.
 *
 * - Initial fetch populates `rows`.
 * - SSE applies `<name>.created/updated/deleted/reordered` to local state.
 * - `mutate(next)` lets callers do optimistic updates between request and
 *   echo (consumer code passes an op_id along with the HTTP mutation and the
 *   matching SSE echo is dropped — see `useSSE` and SPEC §7.2).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type UseSSEResult, useSSE } from "../sse/useSSE";

export type Row = {
  id: string | number;
  /** Omitted for resources with no label-role mapping (SPEC §5.2). */
  label?: string;
  position: number;
  /** Parent's public_id for parent-scoped resources (SPEC §5.8). The SSE
   * handler in `useResource` uses this to drop cross-parent events when
   * the resource is mounted per-view. */
  parent_id?: string | number;
  updated_at?: number | string;
  created_at?: number | string;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
};

export type UseResourceResult = {
  rows: Row[];
  loading: boolean;
  error: Error | null;
  mutate: (next: Row[] | ((prev: Row[]) => Row[])) => void;
  reload: () => void;
  /** Mint a new op_id; HTTP mutations should send this in `X-Op-Id`
   * so the SSE echo carrying it is dropped client-side. */
  newOpId: UseSSEResult["newOpId"];
};

export type UseResourceOptions = {
  basePath?: string;
  ssePath?: string;
  sseEnabled?: boolean;
  /** If false, the hook neither fetches nor subscribes to SSE.
   *  When it flips back to true, the fetch fires (and SSE if
   *  `sseEnabled` is also true). Useful for gating the resource on
   *  auth state — defer until the user is loaded so the initial
   *  request doesn't 401. Defaults to true. */
  enabled?: boolean;
  /** Parent's public_id, for parent-scoped resources (SPEC §5.8). When
   * set, SSE event handlers drop events whose `parent_id` differs —
   * keeping per-view caches scoped to the URL's parent. Omit (or set
   * undefined) for top-level resources. */
  parentId?: string | number;
};

export function useResource(
  name: string,
  options: UseResourceOptions = {},
): UseResourceResult {
  const basePath = options.basePath ?? "/api";
  const ssePath = options.ssePath ?? "/api/events";
  const sseEnabled = options.sseEnabled ?? true;
  const enabled = options.enabled ?? true;
  const parentId = options.parentId;

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const reloadRef = useRef(0);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const myTick = ++reloadRef.current;
    setLoading(true);
    setError(null);
    fetch(`${basePath}/${name}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Row[]) => {
        if (myTick !== reloadRef.current) return;
        setRows(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (myTick !== reloadRef.current) return;
        setError(e);
        setLoading(false);
      });
  }, [name, basePath, reloadTick, enabled]);

  const handlers = useMemo(
    () => {
      // SPEC §5.8: when this hook is bound to a parent-scoped view via
      // `parentId`, drop events whose `parent_id` differs. Events are
      // delivered per-user, so a user with multiple parents (e.g. multiple
      // fifos) receives sibling events on the same stream. Without this
      // filter, every view's cache would accumulate cross-parent rows.
      const matchesScope = (eventParentId: unknown): boolean => {
        if (parentId === undefined) return true;
        return eventParentId === parentId;
      };
      return {
        [`${name}.created`]: (data: unknown) => {
          if (!isRow(data)) return;
          if (!matchesScope(data.parent_id)) return;
          setRows((prev) => insertSorted(prev, stripOpId(data)));
        },
        [`${name}.updated`]: (data: unknown) => {
          if (!isRow(data)) return;
          if (!matchesScope(data.parent_id)) return;
          setRows((prev) => replaceById(prev, stripOpId(data)));
        },
        [`${name}.reordered`]: (data: unknown) => {
          if (!data || typeof data !== "object") return;
          const { id, position, parent_id } = data as {
            id?: unknown;
            position?: unknown;
            parent_id?: unknown;
          };
          if (
            typeof position !== "number" ||
            (typeof id !== "string" && typeof id !== "number")
          )
            return;
          if (!matchesScope(parent_id)) return;
          setRows((prev) =>
            insertSorted(
              prev.filter((r) => r.id !== id),
              {
                ...(prev.find((r) => r.id === id) ??
                  ({ id, position } as Row)),
                position,
              },
            ),
          );
        },
        [`${name}.deleted`]: (data: unknown) => {
          if (!data || typeof data !== "object") return;
          const { id, parent_id } = data as {
            id?: unknown;
            parent_id?: unknown;
          };
          if (typeof id !== "string" && typeof id !== "number") return;
          if (!matchesScope(parent_id)) return;
          setRows((prev) => prev.filter((r) => r.id !== id));
        },
      };
    },
    [name, parentId],
  );

  const sse = useSSE(handlers, {
    path: ssePath,
    enabled: enabled && sseEnabled,
  });

  const mutate: UseResourceResult["mutate"] = useCallback((next) => {
    setRows((prev) =>
      typeof next === "function" ? (next as (p: Row[]) => Row[])(prev) : next,
    );
  }, []);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  return { rows, loading, error, mutate, reload, newOpId: sse.newOpId };
}

function isRow(v: unknown): v is Row {
  // `label` is optional (SPEC §5.2), so the guard requires only the keys
  // every wire row carries: id and position.
  return !!v && typeof v === "object" && "id" in v && "position" in v;
}

function stripOpId(row: Row): Row {
  if ("op_id" in row) {
    const { op_id: _omit, ...rest } = row as Row & { op_id?: unknown };
    return rest as Row;
  }
  return row;
}

function insertSorted(rows: Row[], row: Row): Row[] {
  const without = rows.filter((r) => r.id !== row.id);
  let i = 0;
  while (i < without.length && without[i]!.position < row.position) i++;
  return [...without.slice(0, i), row, ...without.slice(i)];
}

function replaceById(rows: Row[], row: Row): Row[] {
  let found = false;
  const out = rows.map((r) => {
    if (r.id === row.id) {
      found = true;
      return row;
    }
    return r;
  });
  if (!found) return insertSorted(rows, row);
  // Position may have changed; resort.
  return [...out].sort((a, b) => a.position - b.position);
}
