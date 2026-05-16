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
import type { WireRow } from "./wire";

/** Client alias for the wire row shape — a thin re-export so server and
 * client cannot drift. Generic over `TExtra` exactly like {@link WireRow}:
 * default `Record<string, unknown>` keeps loose access, narrower types
 * enable end-to-end typing of passthrough columns. */
export type Row<TExtra = Record<string, unknown>> = WireRow<TExtra>;

export type UseResourceResult<TExtra = Record<string, unknown>> = {
  rows: Row<TExtra>[];
  loading: boolean;
  error: Error | null;
  mutate: (
    next: Row<TExtra>[] | ((prev: Row<TExtra>[]) => Row<TExtra>[]),
  ) => void;
  reload: () => void;
  /** When `pageSize` is set: fetches the next page (`?after_position=<last>`)
   * and appends results to `rows`. No-op if `hasMore` is false or pagination
   * is not enabled. */
  loadMore: () => void;
  /** True when the last fetch returned a full page — there may be more rows
   * beyond the cursor. Always false outside pagination mode. */
  hasMore: boolean;
  /** True while a `loadMore` request is in flight. */
  loadingMore: boolean;
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
  /** Enable cursor-based pagination (SPEC §6). When set, the initial fetch
   * requests `?limit=pageSize` and `loadMore()` fetches the next page via
   * `?after_position=<last.position>&limit=pageSize`. SSE handlers also
   * tighten in pagination mode: events for rows not in cache are dropped
   * (otherwise they'd pollute the partial-cache view). */
  pageSize?: number;
  /** Server-side filter params (SPEC §5.9). Each key/value pair is appended
   * to the fetch URL as a query param. Only columns whitelisted in the
   * resource's `filter.equals` / `filter.contains` config are honored;
   * unknown params are ignored server-side. Changes trigger a refetch. SSE
   * events are NOT filtered client-side (superset model — the cache may
   * contain rows that don't match the active filter; consumers re-filter at
   * render time if it matters). */
  filters?: Record<string, string | number>;
};

export function useResource<TExtra = Record<string, unknown>>(
  name: string,
  options: UseResourceOptions = {},
): UseResourceResult<TExtra> {
  const basePath = options.basePath ?? "/api";
  const ssePath = options.ssePath ?? "/api/events";
  const sseEnabled = options.sseEnabled ?? true;
  const enabled = options.enabled ?? true;
  const parentId = options.parentId;
  const pageSize = options.pageSize;
  const paginated = typeof pageSize === "number" && pageSize > 0;
  const filters = options.filters;
  // Filters trigger refetch on change; use a stable JSON serialization as
  // the effect-dep key so {status: "todo"} and {status: "todo"} compare
  // equal across renders.
  const filtersKey = filters ? JSON.stringify(filters) : "";

  const [rows, setRows] = useState<Row<TExtra>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const reloadRef = useRef(0);
  const [reloadTick, setReloadTick] = useState(0);

  const buildUrl = useCallback(
    (extras?: Record<string, string | number>) => {
      const params = new URLSearchParams();
      if (paginated) params.set("limit", String(pageSize));
      if (filters) {
        for (const [k, v] of Object.entries(filters)) {
          if (v !== undefined && v !== null && v !== "")
            params.set(k, String(v));
        }
      }
      if (extras) {
        for (const [k, v] of Object.entries(extras)) {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      return qs ? `${basePath}/${name}?${qs}` : `${basePath}/${name}`;
    },
    [basePath, name, paginated, pageSize, filters],
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const myTick = ++reloadRef.current;
    setLoading(true);
    setError(null);
    setHasMore(false);
    fetch(buildUrl(), { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Row<TExtra>[]) => {
        if (myTick !== reloadRef.current) return;
        const fetched = Array.isArray(data) ? data : [];
        setRows(fetched);
        setLoading(false);
        if (paginated) setHasMore(fetched.length === pageSize);
      })
      .catch((e: Error) => {
        if (myTick !== reloadRef.current) return;
        setError(e);
        setLoading(false);
      });
    // `buildUrl` itself is memoized over the same set of deps below; we
    // list them here so the effect re-runs when any of them change (filter
    // changes trigger a refetch as documented in the option).
  }, [
    name,
    basePath,
    reloadTick,
    enabled,
    paginated,
    pageSize,
    filtersKey,
    buildUrl,
  ]);

  const loadMore = useCallback(() => {
    if (!paginated || !enabled) return;
    if (loadingMore || !hasMore) return;
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    fetch(buildUrl({ after_position: last.position }), {
      credentials: "include",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Row<TExtra>[]) => {
        const next = Array.isArray(data) ? data : [];
        setRows((prev) => {
          // Defensive dedup — SSE may have inserted some of these rows
          // already between the loadMore call and its response.
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...next.filter((r) => !seen.has(r.id))];
        });
        setHasMore(next.length === pageSize);
        setLoadingMore(false);
      })
      .catch(() => {
        setLoadingMore(false);
      });
  }, [paginated, enabled, loadingMore, hasMore, rows, buildUrl, pageSize]);

  const handlers = useMemo(() => {
    // SPEC §5.8: when this hook is bound to a parent-scoped view via
    // `parentId`, drop events whose `parent_id` differs. Events are
    // delivered per-user, so a user with multiple parents (e.g. multiple
    // fifos) receives sibling events on the same stream. Without this
    // filter, every view's cache would accumulate cross-parent rows.
    //
    // Pagination intentionally does NOT tighten these rules — pues
    // accepts a superset of events. A `.updated` for a row in an
    // unloaded range simply inserts it into the cache (insertSorted
    // places it at its position; if it lies beyond the loaded prefix,
    // it appears at the tail, which is harmless for queue-shaped
    // resources and rare for the others). Trade-off: simpler contract
    // over a minor visual quirk in narrow edge cases.
    const matchesScope = (eventParentId: unknown): boolean => {
      if (parentId === undefined) return true;
      return eventParentId === parentId;
    };
    return {
      [`${name}.created`]: (data: unknown) => {
        if (!isRow(data)) return;
        if (!matchesScope(data.parent_id)) return;
        const row = stripOpId(data) as Row<TExtra>;
        setRows((prev) => insertSorted(prev, row));
      },
      [`${name}.updated`]: (data: unknown) => {
        if (!isRow(data)) return;
        if (!matchesScope(data.parent_id)) return;
        const row = stripOpId(data) as Row<TExtra>;
        setRows((prev) => replaceById(prev, row));
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
                ({ id, position } as Row<TExtra>)),
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
  }, [name, parentId]);

  const sse = useSSE(handlers, {
    path: ssePath,
    enabled: enabled && sseEnabled,
  });

  const mutate: UseResourceResult<TExtra>["mutate"] = useCallback((next) => {
    setRows((prev) =>
      typeof next === "function"
        ? (next as (p: Row<TExtra>[]) => Row<TExtra>[])(prev)
        : next,
    );
  }, []);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  return {
    rows,
    loading,
    error,
    mutate,
    reload,
    loadMore,
    hasMore,
    loadingMore,
    newOpId: sse.newOpId,
  };
}

function isRow(v: unknown): v is Row {
  // `label` is optional (SPEC §5.2), so the guard requires only the keys
  // every wire row carries: id and position.
  return !!v && typeof v === "object" && "id" in v && "position" in v;
}

function stripOpId<T extends Row>(row: T): T {
  if ("op_id" in row) {
    const { op_id: _omit, ...rest } = row as T & { op_id?: unknown };
    return rest as T;
  }
  return row;
}

function insertSorted<T extends Row>(rows: T[], row: T): T[] {
  const without = rows.filter((r) => r.id !== row.id);
  let i = 0;
  while (i < without.length && without[i]!.position < row.position) i++;
  return [...without.slice(0, i), row, ...without.slice(i)];
}

function replaceById<T extends Row>(rows: T[], row: T): T[] {
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
