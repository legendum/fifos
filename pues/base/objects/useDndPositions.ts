/**
 * `useDndPositions` — turns a `@dnd-kit/core` `onDragEnd` event into a
 * before/after PATCH against the resource's REST endpoint.
 *
 * The consumer brings `@dnd-kit/*` (every consumer already does); pues
 * imports types/values from `@dnd-kit/core` and `@dnd-kit/sortable` through
 * the consumer's `node_modules`.
 *
 * Wire shape: PATCH `/api/<name>/:id` with `{ before }` or `{ after }`.
 * Server returns the canonical wire row; broadcasts `.reordered` per
 * affected row. The `op_id` carried in `X-Op-Id` lets `useResource` drop
 * the echo so optimistic UI doesn't flicker.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useCallback, useMemo } from "react";

import type { UseResourceResult } from "./useResource";

export type UseDndPositionsArgs<TExtra = Record<string, unknown>> = {
  name: string;
  resource: Pick<UseResourceResult<TExtra>, "rows" | "mutate" | "newOpId">;
  basePath?: string;
};

export type UseDndPositionsResult = {
  /** Stable ids for `<SortableContext items={...} />`. */
  itemIds: (string | number)[];
  /** Wire this to `<DndContext onDragEnd={onDragEnd} />`. */
  onDragEnd: (event: DragEndEvent) => void;
};

export function useDndPositions<TExtra = Record<string, unknown>>(
  args: UseDndPositionsArgs<TExtra>,
): UseDndPositionsResult {
  const basePath = args.basePath ?? "/api";
  const { rows, mutate, newOpId } = args.resource;

  const itemIds = useMemo(() => rows.map((r) => r.id), [rows]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId === overId) return;

      const oldIndex = rows.findIndex((r) => String(r.id) === activeId);
      const newIndex = rows.findIndex((r) => String(r.id) === overId);
      if (oldIndex < 0 || newIndex < 0) return;

      // Optimistic local reorder for snappy UI.
      const optimistic = arrayMove(rows, oldIndex, newIndex);
      mutate(optimistic);

      // Compute `before` or `after` anchor relative to the original direction.
      // Moving down → after the target; moving up → before the target.
      const side: "before" | "after" = newIndex > oldIndex ? "after" : "before";
      const opId = newOpId();
      fetch(`${basePath}/${args.name}/${encodeURIComponent(activeId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Op-Id": opId,
        },
        body: JSON.stringify({ [side]: overId }),
      }).catch(() => {
        // On network failure, revert by reloading from server state.
        // Consumers that want bespoke recovery can wrap `useDndPositions`
        // — for v0.3.0 we keep it minimal.
      });
    },
    [rows, mutate, newOpId, args.name, basePath],
  );

  return { itemIds, onDragEnd };
}
