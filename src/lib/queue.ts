/**
 * Queue core — push/pop/pull/done/fail/skip/retry.
 *
 * All mutating verbs run inside a single `db.transaction` (which uses
 * SQLite's BEGIN IMMEDIATE) so the read-then-write sequences are atomic
 * even under concurrent webhook traffic.
 *
 * `pop` and `pull` first reclaim expired locks (status='lock' AND
 * locked_until < now) back to 'todo' — this is the lazy reclaim per
 * SPEC §5.3 / §2.3. `done`/`fail` deliberately do NOT check `locked_until`
 * so a slow worker can still finish a "stale" lock until something else
 * has actually pulled it back to todo.
 */
import {
  DEFAULT_FIFO_MAX_RETRIES,
  FIFOS_LOCK_TIMEOUT_SECONDS,
  IDEMPOTENCY_WINDOW_SECONDS,
  LOCK_TIMEOUT_MAX_SECONDS,
  LOCK_TIMEOUT_MIN_SECONDS,
  MAX_ITEMS_PER_FIFO,
  PURGE_BATCH_SIZE,
} from "./constants.js";
import { getDb } from "./db.js";
import { publish } from "./sse.js";
import { ulid as makeUlid } from "./ulid.js";

import type { ItemStatus } from "./web_constants.js";

export type { ItemStatus } from "./web_constants.js";
export {
  ITEM_STATUSES,
  ITEM_STATUSES_PIPE,
  isItemStatus,
} from "./web_constants.js";

export type StatusCounts = Record<ItemStatus, number>;

export function emptyCounts(): StatusCounts {
  return { todo: 0, lock: 0, done: 0, fail: 0, skip: 0 };
}

export type ItemRow = {
  id: string;
  position: number;
  data: string;
  created_at: number;
  updated_at: number;
  status: ItemStatus;
  locked_until: number | null;
  retry_count: number;
  reason: string | null;
};

export type PushResult = {
  id: string;
  position: number;
  created_at: number;
  deduped: boolean;
};

export type FifoLookup = {
  id: number;
  user_id: number;
  ulid: string;
  name: string;
  slug: string;
  max_retries: number;
};

/** Resolve a fifo by its public ULID. Used by every webhook handler. */
export function getFifoByUlid(ulid: string): FifoLookup | null {
  const db = getDb();
  const row = db
    .query(
      "SELECT id, user_id, ulid, name, slug, max_retries FROM fifos WHERE ulid = ?",
    )
    .get(ulid) as FifoLookup | undefined;
  return row ?? null;
}

function clampLock(seconds: number | null): number {
  let s =
    seconds == null || !Number.isFinite(seconds)
      ? FIFOS_LOCK_TIMEOUT_SECONDS
      : seconds;
  if (s < LOCK_TIMEOUT_MIN_SECONDS) s = LOCK_TIMEOUT_MIN_SECONDS;
  if (s > LOCK_TIMEOUT_MAX_SECONDS) s = LOCK_TIMEOUT_MAX_SECONDS;
  return s;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Lazy reclaim expired locks back to todo. Run inside a tx, before pop/pull select. */
function reclaimLocks(fifoId: number): void {
  const db = getDb();
  db.run(
    `UPDATE items
        SET status = 'todo', locked_until = NULL,
            updated_at = strftime('%s','now')
      WHERE fifo_id = ?
        AND status = 'lock'
        AND locked_until IS NOT NULL
        AND locked_until < strftime('%s','now')`,
    fifoId,
  );
}

/**
 * Pressure purge — invoked by `push` before returning `fifo_full`.
 *
 * Deletes up to `PURGE_BATCH_SIZE` rows per terminal status (`done` / `fail` /
 * `skip`), oldest `updated_at` first. The time-based retention sweep in
 * `purge.ts` uses the same batch size. See `purge.ts` / SPEC §5.
 *
 * Returns `true` if any rows were freed.
 */
export function pressurePurge(fifoId: number): boolean {
  const db = getDb();
  const tryPurge = (status: "done" | "fail" | "skip"): number => {
    const result = db.run(
      `DELETE FROM items
        WHERE id IN (
          SELECT id FROM items
           WHERE fifo_id = ? AND status = ?
           ORDER BY updated_at ASC
           LIMIT ?
        )`,
      fifoId,
      status,
      PURGE_BATCH_SIZE,
    );
    return result.changes;
  };
  const done = tryPurge("done");
  const fail = tryPurge("fail");
  const skip = tryPurge("skip");
  if (done || fail || skip) {
    publish(`fifo:${fifoId}`, "purge", { deleted: { done, fail, skip } });
  }
  return done + fail + skip > 0;
}

function loadItemById(id: number): ItemRow | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT ulid AS id, position, data, created_at, updated_at, status,
              locked_until, reason, retry_count
         FROM items WHERE id = ?`,
    )
    .get(id) as ItemRow | undefined;
  return row ?? null;
}

/**
 * Push an item to a fifo. Atomic transaction handles idempotency, capacity,
 * position allocation, and the concurrent-loser dedupe race.
 *
 * Returns the item with `deduped: true` when an Idempotency-Key hit returned
 * the original item, or `null` when the fifo is full even after pressure purge.
 */
export function push(
  fifoId: number,
  data: string,
  idempotencyKey?: string | null,
): PushResult | null {
  const db = getDb();
  return db.transaction(() => {
    if (idempotencyKey) {
      const hit = db
        .query(
          `SELECT i.ulid AS id, i.position, i.created_at
             FROM idempotency idem
             JOIN items i ON i.id = idem.item_id
            WHERE idem.fifo_id = ? AND idem.key = ?
              AND idem.created_at > strftime('%s','now') - ?`,
        )
        .get(fifoId, idempotencyKey, IDEMPOTENCY_WINDOW_SECONDS) as
        | { id: string; position: number; created_at: number }
        | undefined;
      if (hit) {
        return { ...hit, deduped: true };
      }
    }

    const capRow = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(fifoId) as { n: number };
    if (capRow.n >= MAX_ITEMS_PER_FIFO) {
      pressurePurge(fifoId);
      const recheck = db
        .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
        .get(fifoId) as { n: number };
      if (recheck.n >= MAX_ITEMS_PER_FIFO) return null;
    }

    const seqRow = db
      .query(
        "UPDATE fifos SET seq = seq + 1, updated_at = strftime('%s','now') WHERE id = ? RETURNING seq",
      )
      .get(fifoId) as { seq: number };
    const position = seqRow.seq;

    const itemUlid = makeUlid();
    const insert = db.run(
      `INSERT INTO items (fifo_id, ulid, position, status, data)
       VALUES (?, ?, ?, 'todo', ?)`,
      fifoId,
      itemUlid,
      position,
      data,
    );
    const itemPk = Number(insert.lastInsertRowid);

    if (idempotencyKey) {
      try {
        db.run(
          "INSERT INTO idempotency (fifo_id, key, item_id) VALUES (?, ?, ?)",
          fifoId,
          idempotencyKey,
          itemPk,
        );
      } catch (err: any) {
        // Concurrent loser — the winner already inserted. Roll back our item
        // and return the winner's row.
        db.run("DELETE FROM items WHERE id = ?", itemPk);
        const winner = db
          .query(
            `SELECT i.ulid AS id, i.position, i.created_at
               FROM idempotency idem
               JOIN items i ON i.id = idem.item_id
              WHERE idem.fifo_id = ? AND idem.key = ?`,
          )
          .get(fifoId, idempotencyKey) as
          | { id: string; position: number; created_at: number }
          | undefined;
        if (winner) return { ...winner, deduped: true };
        throw err;
      }
    }

    const fresh = loadItemById(itemPk)!;
    return {
      id: fresh.id,
      position: fresh.position,
      created_at: fresh.created_at,
      deduped: false,
    };
  })();
}

/** Pop the oldest todo item — sets status='done' and returns the row. */
export function pop(fifoId: number): ItemRow | null {
  const db = getDb();
  return db.transaction(() => {
    reclaimLocks(fifoId);
    const row = db
      .query(
        `SELECT id, ulid, position, data, created_at, updated_at
           FROM items
          WHERE fifo_id = ? AND status = 'todo'
          ORDER BY position ASC
          LIMIT 1`,
      )
      .get(fifoId) as
      | {
          id: number;
          ulid: string;
          position: number;
          data: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    db.run(
      "UPDATE items SET status = 'done', updated_at = strftime('%s','now') WHERE id = ?",
      row.id,
    );
    return loadItemById(row.id);
  })();
}

/** Pull the oldest todo item — sets status='lock' with a TTL. */
export function pull(
  fifoId: number,
  lockSeconds: number | null,
): ItemRow | null {
  const db = getDb();
  return db.transaction(() => {
    reclaimLocks(fifoId);
    const row = db
      .query(
        `SELECT id FROM items
          WHERE fifo_id = ? AND status = 'todo'
          ORDER BY position ASC
          LIMIT 1`,
      )
      .get(fifoId) as { id: number } | undefined;
    if (!row) return null;
    const ttl = clampLock(lockSeconds);
    const lockedUntil = now() + ttl;
    db.run(
      `UPDATE items
          SET status = 'lock', locked_until = ?,
              updated_at = strftime('%s','now')
        WHERE id = ?`,
      lockedUntil,
      row.id,
    );
    return loadItemById(row.id);
  })();
}

/**
 * Mark a locked item done. Returns null if it's not in 'lock' anymore.
 *
 * `reason` is optional one-line metadata for triage (e.g. "cached hit", token
 * counts). Same length contract as `fail`/`skip`.
 */
export function done(
  fifoId: number,
  itemUlid: string,
  reason?: string | null,
): ItemRow | null {
  return finishLocked(fifoId, itemUlid, "done", reason ?? null);
}

/**
 * Mark a locked item failed (retryable), or auto-`skip` when fail attempts would
 * exceed `fifos.max_retries`. Returns `exhausted_retries: true` when this call
 * ended in `skip` for that reason.
 */
export function fail(
  fifoId: number,
  itemUlid: string,
  reason?: string | null,
): { row: ItemRow; exhausted_retries: boolean } | null {
  return finishLockedInner(fifoId, itemUlid, "fail", reason ?? null);
}

/**
 * Mark a locked item skipped (terminal — `retry` refuses 'skip').
 * Returns null if it's not in 'lock' anymore.
 *
 * `reason` is optional diagnostic text. Same length contract as `fail`.
 */
export function skip(
  fifoId: number,
  itemUlid: string,
  reason?: string | null,
): ItemRow | null {
  return finishLocked(fifoId, itemUlid, "skip", reason ?? null);
}

/**
 * `retry_count` counts how many times an item has been returned to `todo` via
 * `retry()` (not raw failure count). `fail()` compares `retry_count + 1` to
 * `fifos.max_retries` to decide `fail` vs auto-`skip`.
 */
function finishLockedInner(
  fifoId: number,
  itemUlid: string,
  next: "done" | "fail" | "skip",
  reason: string | null,
): { row: ItemRow; exhausted_retries: boolean } | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .query(
        `SELECT i.id AS item_pk, i.status, i.retry_count, f.max_retries
           FROM items i
           JOIN fifos f ON f.id = i.fifo_id
          WHERE i.fifo_id = ? AND i.ulid = ?`,
      )
      .get(fifoId, itemUlid) as
      | {
          item_pk: number;
          status: ItemStatus;
          retry_count: number;
          max_retries: number;
        }
      | undefined;
    if (!row) return null;
    if (row.status !== "lock") return null;

    const maxRetries = row.max_retries ?? DEFAULT_FIFO_MAX_RETRIES;
    const nextStatus: ItemStatus =
      next === "fail" && row.retry_count + 1 >= maxRetries ? "skip" : next;
    const exhausted_retries = next === "fail" && nextStatus === "skip";

    db.run(
      `UPDATE items
          SET status = ?, locked_until = NULL, reason = ?,
              updated_at = strftime('%s','now')
        WHERE id = ?`,
      nextStatus,
      reason,
      row.item_pk,
    );
    const loaded = loadItemById(row.item_pk);
    if (!loaded) return null;
    return { row: loaded, exhausted_retries };
  })();
}

function finishLocked(
  fifoId: number,
  itemUlid: string,
  next: "done" | "fail" | "skip",
  reason: string | null,
): ItemRow | null {
  return finishLockedInner(fifoId, itemUlid, next, reason)?.row ?? null;
}

/**
 * Move a done/fail item back to todo at the tail (new position from seq).
 * Returns the updated row, or `{ error: 'not_found' | 'wrong_status' }`.
 */
export function retry(
  fifoId: number,
  itemUlid: string,
):
  | { ok: true; row: ItemRow }
  | { ok: false; reason: "not_found" | "wrong_status" } {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .query("SELECT id, status FROM items WHERE fifo_id = ? AND ulid = ?")
      .get(fifoId, itemUlid) as { id: number; status: ItemStatus } | undefined;
    if (!row) return { ok: false, reason: "not_found" } as const;
    if (
      row.status === "todo" ||
      row.status === "lock" ||
      row.status === "skip"
    ) {
      return { ok: false, reason: "wrong_status" } as const;
    }
    const seqRow = db
      .query(
        "UPDATE fifos SET seq = seq + 1, updated_at = strftime('%s','now') WHERE id = ? RETURNING seq",
      )
      .get(fifoId) as { seq: number };
    db.run(
      `UPDATE items
          SET status = 'todo', position = ?, locked_until = NULL,
              reason = NULL, updated_at = strftime('%s','now'),
              retry_count = retry_count + 1
        WHERE id = ?`,
      seqRow.seq,
      row.id,
    );
    return { ok: true, row: loadItemById(row.id)! } as const;
  })();
}
