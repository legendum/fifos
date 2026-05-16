/**
 * Position math (SPEC §6). Sparse integers with localized renumbering.
 *
 * STEP = 1000 gives ~10 reorders between any pair before a midpoint runs out.
 * When midpoints collide, the whole user-scope is renumbered to multiples of
 * STEP — heavy for very large lists, but correct, and trivial to upgrade to a
 * windowed renumber later if profiling shows it matters. Most consumers have
 * < 100 rows per scope, where O(N) writes are cheap.
 */

import type { Database } from "bun:sqlite";

import { quoteIdent, type ResolvedColumns } from "./config";

export const POSITION_STEP = 1000;

const q = quoteIdent;

/** Position-math scope.
 *
 *   - Top-level resource: `{ ownerId }` — WHERE is `owner = ?`.
 *   - Parent-scoped resource (SPEC §5.8): `{ parentId }` — WHERE is
 *     `parent.column = ?` only. Owner is not in the WHERE because the
 *     child table doesn't carry one; the parent's ownership was already
 *     authorized at the request boundary, so checking it on every
 *     reorder write would be wasted JOINs.
 *
 * `ownerId` is harmless on parent-scoped writes (mountResource sets it for
 * symmetry / SSE broadcast), but `whereScope` ignores it in that case.
 */
export type Scope = { ownerId: number; parentId?: number | null };

export type RenumberEntry = { pk: unknown; position: number };

export type ReorderResult = {
  newPosition: number;
  renumber: RenumberEntry[];
};

function whereScope(
  cols: ResolvedColumns,
  scope: Scope,
): { sql: string; binds: unknown[] } {
  if (cols.parent) {
    if (scope.parentId == null) {
      throw new Error(
        `[pues] position scope on parent-scoped resource "${cols.table}" requires scope.parentId.`,
      );
    }
    return {
      sql: `${q(cols.parent.column)} = ?`,
      binds: [scope.parentId],
    };
  }
  if (cols.owner == null) {
    throw new Error(
      `[pues] position scope on resource "${cols.table}" has no owner role and no parent — config resolution is inconsistent.`,
    );
  }
  return { sql: `${q(cols.owner)} = ?`, binds: [scope.ownerId] };
}

export function appendPosition(
  db: Database,
  cols: ResolvedColumns,
  scope: Scope,
): number {
  const { sql, binds } = whereScope(cols, scope);
  const row = db
    .query(
      `SELECT COALESCE(MAX(${q(cols.position)}), 0) AS m FROM ${q(cols.table)} WHERE ${sql}`,
    )
    .get(...(binds as [])) as { m: number };
  return row.m + POSITION_STEP;
}

export function prependPosition(
  db: Database,
  cols: ResolvedColumns,
  scope: Scope,
): number {
  const { sql, binds } = whereScope(cols, scope);
  const row = db
    .query(
      `SELECT MIN(${q(cols.position)}) AS m FROM ${q(cols.table)} WHERE ${sql}`,
    )
    .get(...(binds as [])) as { m: number | null };
  return (row.m ?? POSITION_STEP) - POSITION_STEP;
}

/**
 * Compute the integer position for `movingPk` placed before/after an anchor.
 * Returns the new position; if a midpoint isn't available, also returns the
 * full renumber list for the affected scope. The caller is responsible for
 * applying writes and broadcasting `<resource>.reordered` per renumber entry.
 */
export function computeRelativePosition(
  db: Database,
  cols: ResolvedColumns,
  scope: Scope,
  movingPk: unknown,
  anchorPublicId: string | number,
  side: "before" | "after",
): ReorderResult {
  const { sql: scopeSql, binds: scopeBinds } = whereScope(cols, scope);

  const anchor = db
    .query(
      `SELECT ${q(cols.pk)} AS pk, ${q(cols.position)} AS position
       FROM ${q(cols.table)}
       WHERE ${q(cols.public_id)} = ? AND ${scopeSql}`,
    )
    .get(anchorPublicId, ...(scopeBinds as [])) as
    | { pk: unknown; position: number }
    | undefined;
  if (!anchor) {
    throw new Error(
      `[pues] reorder: anchor "${anchorPublicId}" not found in scope.`,
    );
  }

  const cmpOp = side === "before" ? "<" : ">";
  const orderDir = side === "before" ? "DESC" : "ASC";
  const excludeMoving = movingPk != null ? `AND ${q(cols.pk)} != ?` : "";
  const neighborBinds: unknown[] = [
    ...(scopeBinds as []),
    anchor.position,
    ...(movingPk != null ? [movingPk] : []),
  ];

  const neighbor = db
    .query(
      `SELECT ${q(cols.pk)} AS pk, ${q(cols.position)} AS position
       FROM ${q(cols.table)}
       WHERE ${scopeSql} AND ${q(cols.position)} ${cmpOp} ? ${excludeMoving}
       ORDER BY ${q(cols.position)} ${orderDir}, ${q(cols.pk)} ${orderDir}
       LIMIT 1`,
    )
    .get(...neighborBinds) as { pk: unknown; position: number } | undefined;

  const lo =
    side === "before"
      ? (neighbor?.position ?? anchor.position - 2 * POSITION_STEP)
      : anchor.position;
  const hi =
    side === "before"
      ? anchor.position
      : (neighbor?.position ?? anchor.position + 2 * POSITION_STEP);

  if (hi - lo >= 2) {
    return { newPosition: Math.floor((lo + hi) / 2), renumber: [] };
  }

  return renumberScope(db, cols, scope, movingPk, anchor.pk, side);
}

function renumberScope(
  db: Database,
  cols: ResolvedColumns,
  scope: Scope,
  movingPk: unknown,
  anchorPk: unknown,
  side: "before" | "after",
): ReorderResult {
  const { sql, binds } = whereScope(cols, scope);
  const rows = db
    .query(
      `SELECT ${q(cols.pk)} AS pk FROM ${q(cols.table)} WHERE ${sql}
       ORDER BY ${q(cols.position)} ASC, ${q(cols.pk)} ASC`,
    )
    .all(...(binds as [])) as Array<{ pk: unknown }>;

  const SENTINEL: unknown = Symbol("moving");
  const moving = movingPk ?? SENTINEL;
  const remaining = rows.map((r) => r.pk).filter((pk) => pk !== movingPk);
  const anchorIdx = remaining.indexOf(anchorPk);
  if (anchorIdx === -1) {
    throw new Error("[pues] renumber: anchor missing after move-removal");
  }
  const insertAt = side === "before" ? anchorIdx : anchorIdx + 1;
  const seq: unknown[] = [
    ...remaining.slice(0, insertAt),
    moving,
    ...remaining.slice(insertAt),
  ];

  let newPosition = -1;
  const renumber: RenumberEntry[] = [];
  seq.forEach((pk, idx) => {
    const pos = (idx + 1) * POSITION_STEP;
    if (pk === moving) {
      newPosition = pos;
    } else {
      renumber.push({ pk, position: pos });
    }
  });
  return { newPosition, renumber };
}

export { whereScope as _whereScopeForTests };
