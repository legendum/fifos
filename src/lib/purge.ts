/**
 * Purgers.
 *
 * Two complementary cleanups:
 *  1. Time-based retention sweep — deletes done/fail/skip items older than
 *     FIFOS_RETENTION_SECONDS, plus idempotency rows older than 1h.
 *     Runs on a setInterval started by server.ts. Emits `purge` SSE
 *     events per affected fifo and `fifos` snapshots per affected user.
 *  2. Capacity-pressure purge — runs inline from `push` in queue.ts when
 *     a fifo is at MAX_ITEMS_PER_FIFO. Implemented in queue.ts so the push
 *     transaction can call it synchronously; re-exported here for callers
 *     that want the same logic outside a tx.
 */
import { getFifosPayload } from "../api/handlers/fifos.js";
import { FIFOS_RETENTION_SECONDS, PURGE_BATCH_SIZE } from "./constants.js";
import { getDb } from "./db.js";
import { publish, publishUserFifos } from "./sse.js";

export { pressurePurge } from "./queue.js";

export type SweepResult = {
  itemsDeleted: number;
  idempotencyDeleted: number;
};

type DoomedRow = {
  id: number;
  fifo_id: number;
  status: "done" | "fail" | "skip";
  user_id: number;
};

/**
 * Time-based retention sweep. Each batch reads the doomed rows (with their
 * fifo + user) before deleting so we can emit per-fifo `purge` events and
 * coalesced per-user `fifos` snapshots after the writes commit.
 */
export function sweepRetention(): SweepResult {
  const db = getDb();
  let itemsDeleted = 0;
  let idempotencyDeleted = 0;

  while (true) {
    const rows = db
      .query(
        `SELECT i.id, i.fifo_id, i.status, f.user_id
           FROM items i
           JOIN fifos f ON f.id = i.fifo_id
          WHERE i.status IN ('done','fail','skip')
            AND i.updated_at < strftime('%s','now') - ?
          LIMIT ?`,
      )
      .all(FIFOS_RETENTION_SECONDS, PURGE_BATCH_SIZE) as DoomedRow[];
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.run(`DELETE FROM items WHERE id IN (${placeholders})`, ...ids);
    itemsDeleted += rows.length;

    const byFifo = new Map<
      number,
      { user_id: number; done: number; fail: number; skip: number }
    >();
    for (const r of rows) {
      let entry = byFifo.get(r.fifo_id);
      if (!entry) {
        entry = { user_id: r.user_id, done: 0, fail: 0, skip: 0 };
        byFifo.set(r.fifo_id, entry);
      }
      entry[r.status] += 1;
    }
    const affectedUsers = new Set<number>();
    for (const [fifoId, info] of byFifo) {
      publish(`fifo:${fifoId}`, "purge", {
        deleted: { done: info.done, fail: info.fail, skip: info.skip },
      });
      affectedUsers.add(info.user_id);
    }
    for (const userId of affectedUsers) {
      publishUserFifos(userId, () => getFifosPayload(userId));
    }
  }

  while (true) {
    const result = db.run(
      `DELETE FROM idempotency
        WHERE rowid IN (
          SELECT rowid FROM idempotency
           WHERE created_at < strftime('%s','now') - 3600
           LIMIT ?
        )`,
      PURGE_BATCH_SIZE,
    );
    if (result.changes === 0) break;
    idempotencyDeleted += result.changes;
  }

  if (itemsDeleted || idempotencyDeleted) {
    console.log(
      `[purge] removed ${itemsDeleted} items, ${idempotencyDeleted} idempotency rows`,
    );
  }
  return { itemsDeleted, idempotencyDeleted };
}
