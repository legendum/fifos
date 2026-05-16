/**
 * Role-mapping loader. Reads a consumer's `config/pues.yaml`, validates each
 * mapped resource against `PRAGMA table_info`, and resolves the role contract
 * (SPEC §5.2–§5.4) into concrete column names. The result is what every other
 * piece of `base/objects/` operates on — the resolver is the single place that
 * knows about defaults, opt-outs, and passthroughs.
 */

import type { Database } from "bun:sqlite";

export type ColumnRoles = {
  pk: string;
  public_id: string;
  owner: string;
  label: string;
  position: string;
  updated_at?: string | null;
  created_at?: string | null;
  meta?: string | null;
};

export type ResourceConfig = {
  table: string;
  columns?: Partial<ColumnRoles>;
  /** Parent-scoped resources only — see SPEC §5.8. */
  parent?: { column: string; table: string };
  /** Required when `parent` is set. Route template with exactly one `:segment`
   * which captures the parent's `public_id` from the URL — e.g.
   * `/api/fifos/:fifo_ulid` makes pues mount the resource at
   * `<prefix>/<name>` and `<prefix>/<name>/:id`. */
  prefix?: string;
  timestamp_format?: "unix" | "iso";
};

export type PuesConfig = {
  app?: { name?: string; db?: string };
  parts?: string[];
  resources?: Record<string, ResourceConfig>;
};

/** Resolved parent reference for a parent-scoped resource (SPEC §5.8).
 * Carries both the child-side FK and the parent's resolved roles, so JOIN
 * SQL and authorization queries do not need to re-resolve the parent. */
export type ResolvedParent = {
  /** FK column on the child table (e.g. `items.fifo_id`). */
  column: string;
  /** Parent's table name. */
  table: string;
  /** URL param name parsed from the resource's `prefix:` template. */
  param: string;
  /** Parent's resolved `pk` column (target of the FK join). */
  pk: string;
  /** Parent's resolved `public_id` column — matched against the URL param. */
  public_id: string;
  /** Parent's resolved `owner` column — authorizes the request. */
  owner: string;
};

export type ResolvedColumns = {
  table: string;
  pk: string;
  public_id: string;
  /** null for parent-scoped resources (ownership is inherited via `parent`). */
  owner: string | null;
  /** null for resources whose rows have no human-friendly name (queue items,
   * log entries). Wire row omits the `label` key in that case; pues' rename
   * primitives (`useRename`, `<RenameTitle>`) are not applicable. */
  label: string | null;
  position: string;
  updated_at: string | null;
  created_at: string | null;
  meta: string | null;
  passthrough: string[];
  parent: ResolvedParent | null;
  /** The original `prefix:` template (only set for parent-scoped resources). */
  prefix: string | null;
  timestamp_format: "unix" | "iso";
};

const REQUIRED_ROLES = ["pk", "public_id", "owner", "position"] as const;
const OPTIONAL_ROLES = [
  "label",
  "updated_at",
  "created_at",
  "meta",
] as const;
const ALL_ROLES = [...REQUIRED_ROLES, ...OPTIONAL_ROLES] as const;

const DEFAULTS: Record<(typeof ALL_ROLES)[number], string> = {
  pk: "id",
  public_id: "ulid",
  owner: "user_id",
  label: "name",
  position: "position",
  updated_at: "updated_at",
  created_at: "created_at",
  meta: "meta",
};

// Canonical wire keys that an app column must never collide with — SPEC §5.6.
// `id` is excluded: it is the canonical wire key for the `public_id` role, but
// the column literally named `id` is almost universally the `pk` role.
const CANONICAL_RESERVED = new Set([
  "label",
  "position",
  "updated_at",
  "created_at",
  "meta",
]);

export async function loadPuesConfig(
  path: string = "config/pues.yaml",
): Promise<PuesConfig> {
  const text = await Bun.file(path).text();
  const parsed = Bun.YAML.parse(text) as PuesConfig | null;
  return parsed ?? {};
}

export function resolveColumns(
  db: Database,
  name: string,
  cfg: ResourceConfig,
  parentCols?: ResolvedColumns,
): ResolvedColumns {
  if (!cfg || typeof cfg.table !== "string" || cfg.table.length === 0) {
    throw new Error(`[pues] resources.${name}: missing or empty 'table'.`);
  }

  if (cfg.columns) {
    for (const role of Object.keys(cfg.columns)) {
      if (!(ALL_ROLES as readonly string[]).includes(role)) {
        throw new Error(
          `[pues] resources.${name}.columns: unknown role "${role}". ` +
            `Valid roles: ${ALL_ROLES.join(", ")}.`,
        );
      }
    }
  }

  const isParentScoped = !!cfg.parent;

  // `prefix:` and parent-scoping are paired (SPEC §5.8). Reject mismatches
  // before any column resolution so the error surfaces at the config layer.
  if (isParentScoped && (!cfg.prefix || cfg.prefix.length === 0)) {
    throw new Error(
      `[pues] resources.${name}: parent-scoped resource requires 'prefix:' (SPEC §5.8).`,
    );
  }
  if (!isParentScoped && cfg.prefix) {
    throw new Error(
      `[pues] resources.${name}: 'prefix:' is only valid on parent-scoped resources.`,
    );
  }
  if (isParentScoped && cfg.columns?.owner) {
    throw new Error(
      `[pues] resources.${name}.columns.owner: parent-scoped resources inherit ownership via 'parent' (SPEC §5.8) — do not map 'owner' explicitly.`,
    );
  }
  if (isParentScoped && !parentCols) {
    throw new Error(
      `[pues] resources.${name}: parent-scoped resource needs the parent's ResolvedColumns passed as the 4th arg. Resolve the parent resource first.`,
    );
  }
  if (isParentScoped && parentCols && cfg.parent!.table !== parentCols.table) {
    throw new Error(
      `[pues] resources.${name}.parent.table = "${cfg.parent!.table}" but parentCols.table = "${parentCols.table}". The parent reference must match the resolved parent's table.`,
    );
  }
  if (isParentScoped && parentCols && parentCols.owner == null) {
    throw new Error(
      `[pues] resources.${name}: parent resource "${parentCols.table}" has no 'owner' role — ownership cannot be inherited. (Multi-level parent chains are not supported in v0.6.)`,
    );
  }

  const info = db
    .query(`PRAGMA table_info(${quoteIdent(cfg.table)})`)
    .all() as Array<{ name: string }>;
  if (info.length === 0) {
    throw new Error(
      `[pues] resources.${name}: table "${cfg.table}" not found in the database.`,
    );
  }
  const actual = new Set(info.map((r) => r.name));

  const explicit = (cfg.columns ?? {}) as Record<
    string,
    string | null | undefined
  >;
  const mapped: Record<string, string | null> = {};

  for (const role of ALL_ROLES) {
    // Parent-scoped resources inherit ownership via the parent (SPEC §5.8).
    // Force-null `owner` regardless of whether the child table happens to
    // carry a `user_id` column — the contract is explicit.
    if (role === "owner" && isParentScoped) {
      mapped[role] = null;
      continue;
    }
    const isOptional = (OPTIONAL_ROLES as readonly string[]).includes(role);
    const v = explicit[role];

    if (v === null) {
      if (!isOptional) {
        throw new Error(
          `[pues] resources.${name}.columns.${role}: cannot opt out of a required role.`,
        );
      }
      mapped[role] = null;
      continue;
    }

    if (typeof v === "string" && v.length > 0) {
      if (!actual.has(v)) {
        throw new Error(
          `[pues] resources.${name}.columns.${role} = "${v}" — no such column on table "${cfg.table}". ` +
            `(Hint: check for typos against the actual schema.)`,
        );
      }
      mapped[role] = v;
      continue;
    }

    const def = DEFAULTS[role];
    if (actual.has(def)) {
      mapped[role] = def;
    } else if (isOptional) {
      console.log(
        `[pues] resources.${name}: optional role "${role}" dropped — no column named "${def}" on "${cfg.table}".`,
      );
      mapped[role] = null;
    } else {
      throw new Error(
        `[pues] resources.${name}: required role "${role}" defaults to column "${def}" but it is absent on "${cfg.table}". ` +
          `Add the column or map it explicitly under resources.${name}.columns.`,
      );
    }
  }

  let resolvedParent: ResolvedParent | null = null;
  if (isParentScoped) {
    if (!cfg.parent!.column || !cfg.parent!.table) {
      throw new Error(
        `[pues] resources.${name}.parent must have both 'column' and 'table'.`,
      );
    }
    if (!actual.has(cfg.parent!.column)) {
      throw new Error(
        `[pues] resources.${name}.parent.column = "${cfg.parent!.column}" — no such column on table "${cfg.table}".`,
      );
    }
    const param = parsePrefixParam(name, cfg.prefix!);
    resolvedParent = {
      column: cfg.parent!.column,
      table: cfg.parent!.table,
      param,
      pk: parentCols!.pk,
      public_id: parentCols!.public_id,
      owner: parentCols!.owner!,
    };
  }

  const mappedColumns = new Set(
    Object.values(mapped).filter((v): v is string => typeof v === "string"),
  );
  const passthrough: string[] = [];
  for (const col of actual) {
    if (mappedColumns.has(col)) continue;
    if (CANONICAL_RESERVED.has(col)) {
      throw new Error(
        `[pues] Column "${col}" on "${cfg.table}" collides with a canonical wire key. ` +
          `Map it explicitly to the matching role under resources.${name}.columns, or rename the column.`,
      );
    }
    passthrough.push(col);
  }
  passthrough.sort();

  return {
    table: cfg.table,
    pk: mapped.pk!,
    public_id: mapped.public_id!,
    owner: mapped.owner,
    label: mapped.label,
    position: mapped.position!,
    updated_at: mapped.updated_at,
    created_at: mapped.created_at,
    meta: mapped.meta,
    passthrough,
    parent: resolvedParent,
    prefix: cfg.prefix ?? null,
    timestamp_format: cfg.timestamp_format ?? "unix",
  };
}

/** Extract the single `:segment` name from a parent-scoped resource's prefix
 * template. Throws on zero or multiple `:segments` (SPEC §5.8). */
function parsePrefixParam(name: string, prefix: string): string {
  if (!prefix.startsWith("/")) {
    throw new Error(
      `[pues] resources.${name}.prefix = ${JSON.stringify(prefix)} — must start with "/".`,
    );
  }
  const matches = [...prefix.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)];
  if (matches.length === 0) {
    throw new Error(
      `[pues] resources.${name}.prefix = ${JSON.stringify(prefix)} — must contain exactly one ":segment" capturing the parent's public_id (SPEC §5.8).`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `[pues] resources.${name}.prefix = ${JSON.stringify(prefix)} — has ${matches.length} ":segments"; exactly one is allowed (SPEC §5.8 — nesting deeper than one level is not supported).`,
    );
  }
  return matches[0][1];
}

function quoteIdent(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`[pues] unsafe SQL identifier: ${JSON.stringify(s)}`);
  }
  return `"${s}"`;
}

export { quoteIdent };
