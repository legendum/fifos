/**
 * Canonical wire shape (SPEC §5.6). The server reads role mappings; the client
 * never does. Every row crossing the wire emits canonical keys for mapped
 * roles, with app-specific columns passed through verbatim under their actual
 * names.
 */

import type { ResolvedColumns } from "./config";

/** Wire row shape (SPEC §5.6). The canonical, role-mapped keys that pues
 * always projects, plus a `TExtra` slot for passthrough columns the
 * consumer's schema carries (slug, status, data, …).
 *
 * Default `TExtra = Record<string, unknown>` preserves the original
 * loose shape — any key access is `unknown`. Consumers can narrow it
 * for type safety end-to-end:
 *
 *     type FifoItem = { status: "todo"|"lock"|"done"|"fail"|"skip"; data: string };
 *     const { rows } = useResource<FifoItem>("items", { parentId });
 *     rows[0].status; // typed as the union, not unknown
 */
export type WireRow<TExtra = Record<string, unknown>> = {
  id: string | number;
  /** Omitted for resources with no `label` role mapping (SPEC §5.2) — queue
   * items and other rows without a human-friendly name. */
  label?: string;
  position: number;
  /** Parent's public_id for parent-scoped resources (SPEC §5.8). Clients
   * use it to filter SSE events to the current view's parent. */
  parent_id?: string | number;
  updated_at?: number | string;
  created_at?: number | string;
  meta?: Record<string, unknown>;
} & TExtra;

export function toWire<TExtra = Record<string, unknown>>(
  row: Record<string, unknown>,
  cols: ResolvedColumns,
): WireRow<TExtra> {
  const out: Record<string, unknown> = {
    id: row.public_id_value as string | number,
    position: row.position as number,
  };
  if (cols.label) out.label = row.label as string;
  if (cols.parent) out.parent_id = row.parent_id as string | number;
  if (cols.updated_at) out.updated_at = row.updated_at as number | string;
  if (cols.created_at) out.created_at = row.created_at as number | string;
  if (cols.meta) out.meta = safeParseMeta(row.meta);
  for (const col of cols.passthrough) {
    if (col === cols.owner) continue;
    if (col === cols.pk) continue;
    out[col] = row[col];
  }
  return out as WireRow<TExtra>;
}

function safeParseMeta(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    console.warn("[pues] invalid meta JSON, falling back to {}");
  }
  return {};
}
