/**
 * `mountResource` — turn one entry in `config/pues.yaml` into a Bun.serve
 * route map. Returns `{ "/api/<name>": { GET, POST }, "/api/<name>/:id": { PATCH, DELETE } }`.
 *
 * Generic by construction: every SQL string is composed from the resolved
 * column mapping, and `toWire` emits canonical keys regardless of underlying
 * column names. The same handler source serves todos' `lists`, fifos' `items`,
 * and linkobot's `links` — only the captured config differs.
 *
 * Mutation events (when `broadcast` is wired):
 *   <name>.created  — full new row
 *   <name>.updated  — full new row (label/meta/passthrough change)
 *   <name>.reordered — { id, position } for the moving row + each renumbered row
 *   <name>.deleted  — { id }
 * Every event carries `op_id` (from `X-Op-Id` header on the originating
 * request, or `null` for server-initiated mutations).
 */

import type { Database } from "bun:sqlite";

import {
  quoteIdent,
  type ResolvedColumns,
  type ResourceConfig,
  resolveColumns,
} from "./config";
import { newId as defaultNewId } from "./newId";
import {
  appendPosition,
  computeRelativePosition,
  type Scope,
} from "./position";
import { toWire, type WireRow } from "./wire";

export type AuthPolicy = "user" | "public";
export type AuthConfig = { get?: AuthPolicy; write?: AuthPolicy };

export type ResolveUserFn = (
  req: Request,
) => Promise<number | null> | number | null;

export type Broadcast = (
  userId: number,
  event: string,
  data: unknown,
  opts?: { op_id?: string | null },
) => void;

export type BeforeInsertContext = {
  /** The JSON body the client sent (already validated to be an object with a non-empty `label`). */
  body: Record<string, unknown>;
  /** The authenticated user. */
  userId: number;
  /** Resolved role mapping — useful for hooks that need to know which column
   * names the consumer's schema uses. */
  cols: ResolvedColumns;
};

/**
 * Optional per-resource hook called before pues issues its `INSERT`. Use it
 * to derive consumer-specific passthrough columns (e.g. a URL slug from the
 * label) that the schema requires but the wire shape doesn't carry, and to
 * enforce app-level invariants (uniqueness, quotas, billing).
 *
 * Return value:
 *   - `Record<string, unknown>` → pues uses it as the effective body for the
 *     INSERT, picking role columns (label/meta) and passthroughs from it.
 *   - `Response` → pues returns it verbatim. Use for non-400 rejection codes
 *     (402 payment-required, 403 quota-exhausted, etc.).
 *
 * `throw` is shorthand for a 400 with the error message as `error`.
 */
export type BeforeInsertHook = (
  ctx: BeforeInsertContext,
) =>
  | Record<string, unknown>
  | Response
  | Promise<Record<string, unknown> | Response>;

export type BeforeUpdateContext = {
  /** The PATCH body the client sent. */
  body: Record<string, unknown>;
  /** The existing row as it sits in the DB right now, in canonical wire shape
   * (so `existing.slug`, `existing.label`, etc. read the same as on the wire).
   * Useful for hooks that need to compare before/after — e.g. only re-derive
   * a slug when the label actually changed. */
  existing: WireRow;
  /** The authenticated user. */
  userId: number;
  cols: ResolvedColumns;
};

/**
 * Optional per-resource hook called before pues issues its `UPDATE`.
 * Symmetric to `beforeInsert` (see its docstring for return-value semantics).
 * Common use: re-derive a slug when the label changes, enforce per-app
 * invariants on rename.
 */
export type BeforeUpdateHook = (
  ctx: BeforeUpdateContext,
) =>
  | Record<string, unknown>
  | Response
  | Promise<Record<string, unknown> | Response>;

export type MountResourceArgs = {
  db: Database;
  name: string;
  config: ResourceConfig;
  /** Required when `config.parent` is set (SPEC §5.8). Pre-resolved parent
   * role mapping — the consumer resolves the top-level parent first and
   * passes its `ResolvedColumns` here. */
  parentCols?: ResolvedColumns;
  resolveUser?: ResolveUserFn;
  auth?: AuthConfig;
  broadcast?: Broadcast;
  newId?: () => string;
  beforeInsert?: BeforeInsertHook;
  beforeUpdate?: BeforeUpdateHook;
};

export type Handler = (
  req: Request & { params?: Record<string, string> },
) => Promise<Response> | Response;
export type RouteMap = Record<string, Record<string, Handler>>;

const DEFAULT_AUTH: Required<AuthConfig> = { get: "user", write: "user" };
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const q = quoteIdent;

export function mountResource(args: MountResourceArgs): RouteMap {
  const cols = resolveColumns(args.db, args.name, args.config, args.parentCols);
  const auth = { ...DEFAULT_AUTH, ...(args.auth ?? {}) };
  const mintId = args.newId ?? defaultNewId;
  const broadcast = args.broadcast;
  const resourceName = args.name;

  // Parent-scoped resources require authenticated user on both GET and write
  // (SPEC §5.8). Public-read on a parent-scoped resource is not supported in
  // v0.6 — relax if a real consumer needs it.
  if (cols.parent && (auth.get === "public" || auth.write === "public")) {
    throw new Error(
      `[pues] resources.${resourceName}: parent-scoped resources require auth.get and auth.write = "user" (SPEC §5.8).`,
    );
  }

  const selectSql = buildSelectSql(cols, auth.get);
  const selectStmt = args.db.query(selectSql);
  const findOneSql = buildFindOneSql(cols);
  const findOneStmt = args.db.query(findOneSql);

  // For parent-scoped resources: resolve the parent's numeric pk from the
  // URL param + authenticated userId. Used on POST (before INSERT) and as
  // the value bound to `<child>.<parent.column>` on writes. SELECT/findOne
  // do the authorization through the JOIN, so they do not call this.
  const parentPkStmt = cols.parent
    ? args.db.query(
        `SELECT ${q(cols.parent.pk)} AS pk FROM ${q(cols.parent.table)} WHERE ${q(cols.parent.public_id)} = ? AND ${q(cols.parent.owner)} = ?`,
      )
    : null;

  function resolveParentPk(
    req: Request & { params?: Record<string, string> },
    ownerId: number,
  ): unknown | Response {
    if (!cols.parent || !parentPkStmt) return null;
    const parentPublicId = req.params?.[cols.parent.param];
    if (!parentPublicId) {
      return jsonError(400, `parent ${cols.parent.param} required`);
    }
    const row = parentPkStmt.get(parentPublicId, ownerId) as
      | { pk: unknown }
      | undefined;
    if (!row) return jsonError(404, "not_found");
    return row.pk;
  }

  // The column on the child table that scopes writes — `cols.parent.column`
  // for parent-scoped resources, `cols.owner` for top-level. Bound to either
  // `parentPk` or `userId` respectively.
  const scopeColName: string = cols.parent ? cols.parent.column : cols.owner!;

  const getList: Handler = async (req) => {
    const ownerId = await resolveOwner(req, args.resolveUser, auth.get);
    if (ownerId instanceof Response) return ownerId;
    const { limit, offset, afterPosition } = parsePagination(req.url);
    // The cursor is bound twice in the SQL — once for the IS NULL check and
    // once for the comparison. SQLite short-circuits on the NULL branch.
    let rows: Array<Record<string, unknown>>;
    if (cols.parent) {
      const parentPublicId = req.params?.[cols.parent.param];
      if (!parentPublicId) {
        return jsonError(400, `parent ${cols.parent.param} required`);
      }
      rows = selectStmt.all(
        parentPublicId,
        ownerId,
        afterPosition,
        afterPosition,
        limit,
        offset,
      ) as Array<Record<string, unknown>>;
    } else if (auth.get === "user") {
      rows = selectStmt.all(
        ownerId,
        afterPosition,
        afterPosition,
        limit,
        offset,
      ) as Array<Record<string, unknown>>;
    } else {
      rows = selectStmt.all(
        afterPosition,
        afterPosition,
        limit,
        offset,
      ) as Array<Record<string, unknown>>;
    }
    return Response.json(rows.map((r) => toWire(r, cols)));
  };

  const createOne: Handler = async (req) => {
    if (auth.write !== "user") return jsonError(403, "forbidden");
    const ownerId = await resolveOwner(req, args.resolveUser, "user");
    if (ownerId instanceof Response) return ownerId;
    const parentPkOrResponse = resolveParentPk(req, ownerId as number);
    if (parentPkOrResponse instanceof Response) return parentPkOrResponse;
    const parentPk = parentPkOrResponse as number | null;
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    if (
      cols.label &&
      (typeof body.label !== "string" || body.label.trim() === "")
    ) {
      return jsonError(400, "label required");
    }

    let effectiveBody: Record<string, unknown> = body;
    if (args.beforeInsert) {
      try {
        const hookResult = await args.beforeInsert({
          body,
          userId: ownerId as number,
          cols,
        });
        if (hookResult instanceof Response) return hookResult;
        if (!hookResult || typeof hookResult !== "object") {
          return jsonError(
            500,
            "beforeInsert must return an object or Response",
          );
        }
        effectiveBody = hookResult;
      } catch (err) {
        return jsonError(400, (err as Error).message || "rejected_by_hook");
      }
    }

    const opId = getOpId(req);
    const id = mintId();
    const scope: Scope = {
      ownerId: ownerId as number,
      parentId: parentPk,
    };
    const position = appendPosition(args.db, cols, scope);

    const scopeBindValue: unknown = cols.parent ? parentPk : ownerId;
    const insertCols: string[] = [scopeColName, cols.public_id, cols.position];
    const insertBinds: unknown[] = [scopeBindValue, id, position];
    if (cols.label) {
      const labelToInsert =
        typeof effectiveBody.label === "string" &&
        effectiveBody.label.trim() !== ""
          ? String(effectiveBody.label).trim()
          : String(body.label).trim();
      insertCols.push(cols.label);
      insertBinds.push(labelToInsert);
    }
    const now = Math.floor(Date.now() / 1000);
    if (cols.updated_at) {
      insertCols.push(cols.updated_at);
      insertBinds.push(now);
    }
    if (cols.created_at) {
      insertCols.push(cols.created_at);
      insertBinds.push(now);
    }
    if (
      cols.meta &&
      effectiveBody.meta &&
      typeof effectiveBody.meta === "object"
    ) {
      insertCols.push(cols.meta);
      insertBinds.push(JSON.stringify(effectiveBody.meta));
    }
    for (const col of cols.passthrough) {
      if (col === cols.pk) continue;
      // The parent FK column is set by pues from the resolved parent pk —
      // it must never come from the request body (the URL is the only
      // source of truth for which parent the row belongs to).
      if (cols.parent && col === cols.parent.column) continue;
      if (col in effectiveBody) {
        insertCols.push(col);
        insertBinds.push(effectiveBody[col]);
      }
    }

    const sql = `INSERT INTO ${q(cols.table)} (${insertCols.map(q).join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`;
    args.db.run(sql, ...(insertBinds as []));

    const row = cols.parent
      ? (findOneStmt.get(
          id,
          req.params?.[cols.parent.param],
          ownerId,
        ) as Record<string, unknown> | undefined)
      : (findOneStmt.get(id, ownerId) as Record<string, unknown> | undefined);
    if (!row) return jsonError(500, "insert succeeded but row not found");
    const wire = toWire(row, cols);
    broadcast?.(ownerId as number, `${resourceName}.created`, wire, {
      op_id: opId,
    });
    return new Response(JSON.stringify(wire), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  const patchOne: Handler = async (req) => {
    if (auth.write !== "user") return jsonError(403, "forbidden");
    const ownerId = await resolveOwner(req, args.resolveUser, "user");
    if (ownerId instanceof Response) return ownerId;
    const publicId = req.params?.id;
    if (!publicId) return jsonError(400, "id required");
    const parentPublicId = cols.parent
      ? req.params?.[cols.parent.param]
      : null;
    if (cols.parent && !parentPublicId) {
      return jsonError(400, `parent ${cols.parent.param} required`);
    }
    const parentPkOrResponse = resolveParentPk(req, ownerId as number);
    if (parentPkOrResponse instanceof Response) return parentPkOrResponse;
    const parentPk = parentPkOrResponse as number | null;
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;

    const existing = cols.parent
      ? (findOneStmt.get(publicId, parentPublicId, ownerId) as
          | Record<string, unknown>
          | undefined)
      : (findOneStmt.get(publicId, ownerId) as
          | Record<string, unknown>
          | undefined);
    if (!existing) return jsonError(404, "not_found");
    const existingPk = existing.pk_value;
    const opId = getOpId(req);
    const scope: Scope = {
      ownerId: ownerId as number,
      parentId: parentPk,
    };

    let effectiveBody: Record<string, unknown> = body;
    if (args.beforeUpdate) {
      try {
        const hookResult = await args.beforeUpdate({
          body,
          existing: toWire(existing, cols),
          userId: ownerId as number,
          cols,
        });
        if (hookResult instanceof Response) return hookResult;
        if (!hookResult || typeof hookResult !== "object") {
          return jsonError(
            500,
            "beforeUpdate must return an object or Response",
          );
        }
        effectiveBody = hookResult;
      } catch (err) {
        return jsonError(400, (err as Error).message || "rejected_by_hook");
      }
    }

    // Plan the update: ordinary field changes + optional reorder.
    const setCols: string[] = [];
    const setBinds: unknown[] = [];
    let reorderRenumber: Array<{ pk: unknown; position: number }> = [];
    let didReorder = false;

    if (
      cols.label &&
      typeof effectiveBody.label === "string" &&
      effectiveBody.label.trim() !== ""
    ) {
      setCols.push(cols.label);
      setBinds.push(String(effectiveBody.label).trim());
    }
    if (cols.meta && effectiveBody.meta !== undefined) {
      setCols.push(cols.meta);
      setBinds.push(JSON.stringify(effectiveBody.meta ?? {}));
    }
    for (const col of cols.passthrough) {
      if (col === cols.pk) continue;
      // Parent FK column is owned by pues; a client cannot reparent a row
      // via PATCH (move-between-parents is not in the v0.6 surface).
      if (cols.parent && col === cols.parent.column) continue;
      if (col in effectiveBody) {
        setCols.push(col);
        setBinds.push(effectiveBody[col]);
      }
    }

    if (typeof body.before === "string" || typeof body.before === "number") {
      const r = computeRelativePosition(
        args.db,
        cols,
        scope,
        existingPk,
        body.before as string | number,
        "before",
      );
      setCols.push(cols.position);
      setBinds.push(r.newPosition);
      reorderRenumber = r.renumber;
      didReorder = true;
    } else if (
      typeof body.after === "string" ||
      typeof body.after === "number"
    ) {
      const r = computeRelativePosition(
        args.db,
        cols,
        scope,
        existingPk,
        body.after as string | number,
        "after",
      );
      setCols.push(cols.position);
      setBinds.push(r.newPosition);
      reorderRenumber = r.renumber;
      didReorder = true;
    } else if (
      typeof body.position === "number" &&
      Number.isFinite(body.position)
    ) {
      setCols.push(cols.position);
      setBinds.push(Math.floor(body.position));
      didReorder = true;
    }

    if (cols.updated_at && setCols.length > 0) {
      setCols.push(cols.updated_at);
      setBinds.push(Math.floor(Date.now() / 1000));
    }

    if (setCols.length === 0) {
      return jsonError(400, "no_fields_to_update");
    }

    const scopeBindValue: unknown = cols.parent ? parentPk : ownerId;
    const tx = args.db.transaction(() => {
      const updateSql = `UPDATE ${q(cols.table)} SET ${setCols
        .map((c) => `${q(c)} = ?`)
        .join(", ")} WHERE ${q(cols.pk)} = ? AND ${q(scopeColName)} = ?`;
      args.db.run(updateSql, ...(setBinds as []), existingPk, scopeBindValue);
      if (reorderRenumber.length > 0) {
        const upPosSql = `UPDATE ${q(cols.table)} SET ${q(cols.position)} = ? WHERE ${q(cols.pk)} = ? AND ${q(scopeColName)} = ?`;
        for (const e of reorderRenumber) {
          args.db.run(upPosSql, e.position, e.pk, scopeBindValue);
        }
      }
    });
    tx();

    const row = cols.parent
      ? (findOneStmt.get(publicId, parentPublicId, ownerId) as
          | Record<string, unknown>
          | undefined)
      : (findOneStmt.get(publicId, ownerId) as
          | Record<string, unknown>
          | undefined);
    if (!row) return jsonError(500, "update succeeded but row not found");
    const wire = toWire(row, cols);

    // Broadcasting: full-row on .updated, lightweight {id, position} on .reordered.
    // Choose .updated vs .reordered based on what actually changed.
    const nonPositionChange = setCols.some(
      (c) => c !== cols.position && c !== cols.updated_at,
    );
    if (nonPositionChange) {
      broadcast?.(ownerId as number, `${resourceName}.updated`, wire, {
        op_id: opId,
      });
    }
    // Parent-scoped events include the parent's public_id so per-mount
    // useResource subscribers can drop cross-parent updates (SPEC §5.8).
    const eventParentId = cols.parent ? parentPublicId : undefined;
    if (didReorder) {
      broadcast?.(
        ownerId as number,
        `${resourceName}.reordered`,
        eventParentId !== undefined
          ? { id: wire.id, position: wire.position, parent_id: eventParentId }
          : { id: wire.id, position: wire.position },
        { op_id: opId },
      );
    }
    for (const e of reorderRenumber) {
      // Map renumbered rows' public_ids by re-reading; cheaper alternative is
      // to include public_id in the renumber list. For now, run one lookup.
      const sib = args.db
        .query(
          `SELECT ${q(cols.public_id)} AS pid FROM ${q(cols.table)} WHERE ${q(cols.pk)} = ?`,
        )
        .get(e.pk) as { pid: string | number } | undefined;
      if (sib) {
        broadcast?.(
          ownerId as number,
          `${resourceName}.reordered`,
          eventParentId !== undefined
            ? { id: sib.pid, position: e.position, parent_id: eventParentId }
            : { id: sib.pid, position: e.position },
          { op_id: null },
        );
      }
    }
    return Response.json(wire);
  };

  const deleteOne: Handler = async (req) => {
    if (auth.write !== "user") return jsonError(403, "forbidden");
    const ownerId = await resolveOwner(req, args.resolveUser, "user");
    if (ownerId instanceof Response) return ownerId;
    const publicId = req.params?.id;
    if (!publicId) return jsonError(400, "id required");
    const parentPublicId = cols.parent
      ? req.params?.[cols.parent.param]
      : null;
    if (cols.parent && !parentPublicId) {
      return jsonError(400, `parent ${cols.parent.param} required`);
    }
    const parentPkOrResponse = resolveParentPk(req, ownerId as number);
    if (parentPkOrResponse instanceof Response) return parentPkOrResponse;
    const parentPk = parentPkOrResponse as number | null;
    const opId = getOpId(req);
    const existing = cols.parent
      ? (findOneStmt.get(publicId, parentPublicId, ownerId) as
          | Record<string, unknown>
          | undefined)
      : (findOneStmt.get(publicId, ownerId) as
          | Record<string, unknown>
          | undefined);
    if (!existing) return jsonError(404, "not_found");
    const scopeBindValue: unknown = cols.parent ? parentPk : ownerId;
    const sql = `DELETE FROM ${q(cols.table)} WHERE ${q(cols.pk)} = ? AND ${q(scopeColName)} = ?`;
    args.db.run(sql, existing.pk_value, scopeBindValue);
    broadcast?.(
      ownerId as number,
      `${resourceName}.deleted`,
      cols.parent
        ? { id: publicId, parent_id: parentPublicId }
        : { id: publicId },
      {
        op_id: opId,
      },
    );
    return new Response(null, { status: 204 });
  };

  // Route shape: top-level resources use `/api/<name>` (the historical
  // default); parent-scoped resources mount under the consumer-specified
  // `prefix:` template, e.g. `/api/fifos/:fifo_ulid/<name>` (SPEC §5.8).
  const listRoute = cols.prefix
    ? `${cols.prefix}/${resourceName}`
    : `/api/${resourceName}`;
  const itemRoute = `${listRoute}/:id`;
  return {
    [listRoute]: { GET: getList, POST: createOne },
    [itemRoute]: { PATCH: patchOne, DELETE: deleteOne },
  };
}

function buildSelectSql(cols: ResolvedColumns, getPolicy: AuthPolicy): string {
  const parts = baseSelectParts(cols);
  if (cols.parent) {
    // Parent-scoped: JOIN to the parent table and authorize via the
    // parent's public_id (from URL) + owner (authenticated userId).
    // SPEC §5.8 — public-read is rejected at startup for parent-scoped.
    // ORDER BY refs are qualified because position/pk can exist on both
    // child and parent (SQLite throws "ambiguous column" otherwise).
    // The `(? IS NULL OR position > ?)` predicate is the cursor for
    // pagination — the same value is bound twice; SQLite short-circuits
    // when the cursor is null (SPEC §6).
    const child = q(cols.table);
    return (
      `SELECT ${parts.join(", ")} FROM ${child} ` +
      `JOIN ${q(cols.parent.table)} ON ${child}.${q(cols.parent.column)} = ${q(cols.parent.table)}.${q(cols.parent.pk)} ` +
      `WHERE ${q(cols.parent.table)}.${q(cols.parent.public_id)} = ? AND ${q(cols.parent.table)}.${q(cols.parent.owner)} = ? ` +
      `AND (? IS NULL OR ${child}.${q(cols.position)} > ?) ` +
      `ORDER BY ${child}.${q(cols.position)} ASC, ${child}.${q(cols.pk)} ASC ` +
      `LIMIT ? OFFSET ?`
    );
  }
  const where = getPolicy === "user" ? `WHERE ${q(cols.owner!)} = ?` : "WHERE 1=1";
  const orderBy = `ORDER BY ${q(cols.position)} ASC, ${q(cols.pk)} ASC`;
  return `SELECT ${parts.join(", ")} FROM ${q(cols.table)} ${where} AND (? IS NULL OR ${q(cols.position)} > ?) ${orderBy} LIMIT ? OFFSET ?`;
}

function buildFindOneSql(cols: ResolvedColumns): string {
  const parts = baseSelectParts(cols);
  if (cols.parent) {
    return (
      `SELECT ${parts.join(", ")} FROM ${q(cols.table)} ` +
      `JOIN ${q(cols.parent.table)} ON ${q(cols.table)}.${q(cols.parent.column)} = ${q(cols.parent.table)}.${q(cols.parent.pk)} ` +
      `WHERE ${q(cols.table)}.${q(cols.public_id)} = ? AND ${q(cols.parent.table)}.${q(cols.parent.public_id)} = ? AND ${q(cols.parent.table)}.${q(cols.parent.owner)} = ? ` +
      `LIMIT 1`
    );
  }
  return `SELECT ${parts.join(", ")} FROM ${q(cols.table)} WHERE ${q(cols.public_id)} = ? AND ${q(cols.owner!)} = ? LIMIT 1`;
}

function baseSelectParts(cols: ResolvedColumns): string[] {
  // For parent-scoped resources the JOIN table is in scope, so we qualify
  // child columns with the table name to avoid ambiguity (e.g. `position`
  // might exist on both the child and the parent).
  const child = q(cols.table);
  const qualify = (col: string) =>
    cols.parent ? `${child}.${q(col)}` : q(col);
  const out: string[] = [
    `${qualify(cols.pk)} AS pk_value`,
    `${qualify(cols.public_id)} AS public_id_value`,
    `${qualify(cols.position)} AS position`,
  ];
  if (cols.label) out.push(`${qualify(cols.label)} AS label`);
  if (cols.updated_at)
    out.push(`${qualify(cols.updated_at)} AS updated_at`);
  if (cols.created_at)
    out.push(`${qualify(cols.created_at)} AS created_at`);
  if (cols.meta) out.push(`${qualify(cols.meta)} AS meta`);
  // Parent-scoped wire rows project the parent's public_id (SPEC §5.8) so
  // per-mount useResource SSE handlers can filter cross-parent events.
  if (cols.parent) {
    out.push(
      `${q(cols.parent.table)}.${q(cols.parent.public_id)} AS parent_id`,
    );
  }
  for (const col of cols.passthrough) {
    out.push(qualify(col));
  }
  return out;
}

function parsePagination(urlStr: string): {
  limit: number;
  offset: number;
  /** Cursor by position — when set, only rows with `position > afterPosition`
   * are returned (SPEC §6). null means no cursor; the SQL short-circuits the
   * `(? IS NULL OR position > ?)` predicate. */
  afterPosition: number | null;
} {
  const url = new URL(urlStr);
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const rawAfter = url.searchParams.get("after_position");
  const lim = rawLimit == null ? DEFAULT_LIMIT : Number(rawLimit);
  const off = rawOffset == null ? 0 : Number(rawOffset);
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Number.isFinite(lim) ? Math.floor(lim) : DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Number.isFinite(off) ? Math.floor(off) : 0);
  const after =
    rawAfter == null
      ? null
      : Number.isFinite(Number(rawAfter))
        ? Math.floor(Number(rawAfter))
        : null;
  return { limit, offset, afterPosition: after };
}

async function resolveOwner(
  req: Request,
  fn: ResolveUserFn | undefined,
  policy: AuthPolicy,
): Promise<number | null | Response> {
  if (policy === "public") {
    return fn ? await fn(req) : null;
  }
  if (!fn) return jsonError(401, "unauthorized");
  const uid = await fn(req);
  if (uid == null) return jsonError(401, "unauthorized");
  return uid;
}

async function readJsonBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await req.json()) as unknown;
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "expected JSON object body");
    }
    return body as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid JSON body");
  }
}

function getOpId(req: Request): string | null {
  const fromHeader = req.headers.get("X-Op-Id");
  if (fromHeader && fromHeader.length > 0) return fromHeader;
  try {
    const url = new URL(req.url);
    const fromQuery = url.searchParams.get("op_id");
    if (fromQuery && fromQuery.length > 0) return fromQuery;
  } catch {
    /* unparseable url — fall through */
  }
  return null;
}

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export { buildSelectSql, parsePagination };
