/**
 * Home-page list. Reads from `useResource(name)` (REST + SSE), wraps rows in
 * `@dnd-kit/sortable` items, and reorders via the resource's PATCH endpoint
 * with `{ before }` / `{ after }`. Optimistic update + op_id echo dedup
 * keeps the UI snappy.
 *
 * The default renderer treats the entire row as the drag handle. Consumers
 * that want a dedicated handle pass `renderRow` and attach
 * `dragHandleProps` to whatever element they like (e.g. a `≡` icon on the
 * left).
 */

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { useDndPositions } from "./useDndPositions";
import { type Row, useResource } from "./useResource";

export type RowRenderContext = {
  row: Row;
  /** Spread onto the element that should receive drag activation. */
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
};

export type RowRenderer = (ctx: RowRenderContext) => ReactNode;

export type ObjectListProps = {
  resource: string;
  renderRow?: RowRenderer;
  empty?: ReactNode;
  loadingFallback?: ReactNode;
  errorFallback?: (error: Error) => ReactNode;
  sortable?: boolean;
  basePath?: string;
  ssePath?: string;
  sseEnabled?: boolean;
  /** SPEC §5.8 — parent's public_id for parent-scoped resources. Forwarded
   * to `useResource` so SSE handlers filter cross-parent events. */
  parentId?: string | number;
};

const defaultRenderRow: RowRenderer = ({ row, dragHandleProps }) => (
  <div className="pues-object-row__label" {...(dragHandleProps ?? {})}>
    {row.label}
  </div>
);

export function ObjectList({
  resource,
  renderRow = defaultRenderRow,
  empty,
  loadingFallback,
  errorFallback,
  sortable = true,
  basePath,
  ssePath,
  sseEnabled,
  parentId,
}: ObjectListProps) {
  const r = useResource(resource, {
    basePath,
    ssePath,
    sseEnabled,
    parentId,
  });
  const dnd = useDndPositions({ name: resource, resource: r, basePath });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 6 } }),
  );

  if (r.loading) {
    return (
      <>
        {loadingFallback ?? (
          <div className="pues-object-list__loading">Loading…</div>
        )}
      </>
    );
  }
  if (r.error) {
    return (
      <>
        {errorFallback ? (
          errorFallback(r.error)
        ) : (
          <div className="pues-object-list__error">{r.error.message}</div>
        )}
      </>
    );
  }
  if (r.rows.length === 0) {
    return (
      <>{empty ?? <div className="pues-object-list__empty">No items</div>}</>
    );
  }

  if (!sortable) {
    return (
      <ul className="pues-object-list">
        {r.rows.map((row) => (
          <li key={String(row.id)} className="pues-object-row">
            {renderRow({ row })}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={dnd.onDragEnd as (e: DragEndEvent) => void}
    >
      <SortableContext
        items={dnd.itemIds.map(String)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="pues-object-list">
          {r.rows.map((row) => (
            <SortableObjectRow
              key={String(row.id)}
              row={row}
              renderRow={renderRow}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableObjectRow({
  row,
  renderRow,
}: {
  row: Row;
  renderRow: RowRenderer;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: String(row.id) });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="pues-object-row"
      {...attributes}
    >
      {renderRow({
        row,
        dragHandleProps: (listeners ?? {}) as HTMLAttributes<HTMLElement>,
        isDragging,
      })}
    </li>
  );
}
