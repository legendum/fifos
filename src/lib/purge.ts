/**
 * Purgers.
 *
 * Two complementary cleanups:
 *  1. Time-based retention sweep — deletes done/fail items older than
 *     FIFOS_RETENTION_SECONDS, plus idempotency rows older than 1h.
 *     Runs on a setInterval started by server.ts.
 *  2. Capacity-pressure purge — runs inline from `push` in queue.ts when
 *     a fifo is at MAX_ITEMS_PER_FIFO. Implemented in queue.ts so the push
 *     transaction can call it synchronously; re-exported here for callers
 *     that want the same logic outside a tx.
 */
import { FIFOS_RETENTION_SECONDS } from "./constants.js";
import { getDb } from "./db.js";

export { pressurePurge } from "./queue.js";

const BATCH = 100;

export type SweepResult = {
  itemsDeleted: number;
  idempotencyDeleted: number;
};

/**
 * Time-based retention sweep. Loops the two batched DELETEs from SPEC §5.1
 * until both report 0 changes. Short transactions (one batch each) so it
 * doesn't block writers.
 */
export function sweepRetention(): SweepResult {
  const db = getDb();
  let itemsDeleted = 0;
  let idempotencyDeleted = 0;

  while (true) {
    const result = db.run(
      `DELETE FROM items
        WHERE id IN (
          SELECT id FROM items
           WHERE status IN ('done','fail')
             AND updated_at < strftime('%s','now') - ?
           LIMIT ?
        )`,
      FIFOS_RETENTION_SECONDS,
      BATCH,
    );
    if (result.changes === 0) break;
    itemsDeleted += result.changes;
  }

  while (true) {
    const result = db.run(
      `DELETE FROM idempotency
        WHERE rowid IN (
          SELECT rowid FROM idempotency
           WHERE created_at < strftime('%s','now') - 3600
           LIMIT ?
        )`,
      BATCH,
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
