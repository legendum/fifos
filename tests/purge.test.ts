import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const TEST_DB_PATH = "data/test-purge.db";

let q: typeof import("../src/lib/queue");
let purge: typeof import("../src/lib/purge");
let getDb: typeof import("../src/lib/db").getDb;
let userId: number;

async function mkFifo(slug: string): Promise<{ id: number; ulid: string }> {
  const db = getDb();
  const ulidMod = await import("../src/lib/ulid");
  const fifoUlid = ulidMod.ulid();
  const result = db.run(
    "INSERT INTO fifos (user_id, ulid, name, slug) VALUES (?, ?, ?, ?)",
    userId,
    fifoUlid,
    slug,
    slug,
  );
  return { id: Number(result.lastInsertRowid), ulid: fifoUlid };
}

beforeAll(async () => {
  process.env.FIFOS_DB_PATH = TEST_DB_PATH;
  process.env.FIFOS_MAX_ITEMS_PER_FIFO = "5";
  process.env.FIFOS_MAX_FIFOS_PER_USER = "3";
  // Short retention so we can age-out items by setting updated_at into the past.
  process.env.FIFOS_RETENTION_SECONDS = "60";
  delete process.env.LEGENDUM_API_KEY;
  delete process.env.LEGENDUM_SECRET;

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  q = await import("../src/lib/queue");
  purge = await import("../src/lib/purge");
  ({ getDb } = await import("../src/lib/db"));

  const u = getDb().run(
    "INSERT INTO users (email) VALUES (?)",
    "purge-test@local",
  );
  userId = Number(u.lastInsertRowid);
});

afterAll(async () => {
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

function ageItem(ulid: string, secondsAgo: number): void {
  getDb().run(
    `UPDATE items
        SET updated_at = strftime('%s','now') - ?
      WHERE ulid = ?`,
    secondsAgo,
    ulid,
  );
}

describe("sweepRetention — time-based", () => {
  test("deletes done/fail items past retention window", async () => {
    const f = await mkFifo("sweep-aged");
    const a = q.push(f.id, "a")!;
    const b = q.push(f.id, "b")!;
    const c = q.push(f.id, "c")!;
    q.pop(f.id); // a → done
    q.pop(f.id); // b → done
    // Age both done rows past the 60s retention cutoff.
    ageItem(a.id, 600);
    ageItem(b.id, 600);

    const result = purge.sweepRetention();
    expect(result.itemsDeleted).toBe(2);

    const db = getDb();
    const remaining = db
      .query("SELECT ulid FROM items WHERE fifo_id = ?")
      .all(f.id) as { ulid: string }[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].ulid).toBe(c.id);
  });

  test("does not delete recent done/fail items (under retention window)", async () => {
    const f = await mkFifo("sweep-fresh");
    q.push(f.id, "x");
    q.pop(f.id); // updated_at = now → well within 60s window
    const result = purge.sweepRetention();
    expect(result.itemsDeleted).toBe(0);
  });

  test("never deletes open or lock items, even if aged", async () => {
    const f = await mkFifo("sweep-open-lock");
    const a = q.push(f.id, "open-but-old")!;
    const b = q.push(f.id, "locked-but-old")!;
    q.pull(f.id, 60); // a is the older one — gets locked. b stays open.
    // Age both rows.
    ageItem(a.id, 600);
    ageItem(b.id, 600);
    const result = purge.sweepRetention();
    expect(result.itemsDeleted).toBe(0);
    // Both still present.
    const db = getDb();
    const n = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(f.id) as { n: number };
    expect(n.n).toBe(2);
  });

  test("deletes idempotency rows older than 1h", async () => {
    const f = await mkFifo("sweep-idem");
    const fresh = q.push(f.id, "keep-me", "fresh-key")!;
    const stale = q.push(f.id, "drop-me", "stale-key")!;
    expect(fresh).not.toBeNull();
    expect(stale).not.toBeNull();

    const db = getDb();
    // Make one idempotency row look 2h old.
    db.run(
      `UPDATE idempotency SET created_at = strftime('%s','now') - 7200
        WHERE fifo_id = ? AND key = ?`,
      f.id,
      "stale-key",
    );

    const result = purge.sweepRetention();
    expect(result.idempotencyDeleted).toBe(1);

    const keys = db
      .query("SELECT key FROM idempotency WHERE fifo_id = ?")
      .all(f.id) as { key: string }[];
    expect(keys.map((k) => k.key)).toEqual(["fresh-key"]);
  });

  test("processes multi-batch deletions (>BATCH rows)", async () => {
    // BATCH = 100 in purge.ts; cap is 5 per fifo, so spread across fifos
    // would exceed our MAX_FIFOS_PER_USER=3. Instead, lean on capacity-purge
    // friendly path: bump the per-fifo cap via a fresh fifo, push & pop
    // 105 items, age them, then sweep.
    const db = getDb();
    // Create a fifo bypassing the user-cap and item-cap by direct SQL +
    // disabling the queue's MAX check via inserting items manually.
    const ulidMod = await import("../src/lib/ulid");
    const fifoUlid = ulidMod.ulid();
    const r = db.run(
      "INSERT INTO fifos (user_id, ulid, name, slug) VALUES (?, ?, ?, ?)",
      userId,
      fifoUlid,
      "sweep-batch",
      "sweep-batch",
    );
    const fifoId = Number(r.lastInsertRowid);

    const insert = db.prepare(
      `INSERT INTO items (fifo_id, ulid, position, status, data, updated_at)
       VALUES (?, ?, ?, 'done', 'x', strftime('%s','now') - 600)`,
    );
    for (let i = 1; i <= 105; i++) {
      insert.run(fifoId, ulidMod.ulid(), i);
    }

    const result = purge.sweepRetention();
    expect(result.itemsDeleted).toBeGreaterThanOrEqual(105);

    const n = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(fifoId) as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("pressurePurge — capacity-pressure", () => {
  test("frees space by deleting oldest done rows first", async () => {
    const f = await mkFifo("press-done");
    for (let i = 0; i < 5; i++) q.push(f.id, `i${i}`);
    // Pop 2 → 2 done; remaining 3 open.
    q.pop(f.id);
    q.pop(f.id);
    const freed = purge.pressurePurge(f.id);
    expect(freed).toBe(true);
    const db = getDb();
    const counts = db
      .query(
        "SELECT status, COUNT(*) AS n FROM items WHERE fifo_id = ? GROUP BY status",
      )
      .all(f.id) as { status: string; n: number }[];
    const open = counts.find((c) => c.status === "open")?.n ?? 0;
    const done = counts.find((c) => c.status === "done")?.n ?? 0;
    expect(open).toBe(3);
    expect(done).toBe(0);
  });

  test("falls back to fail rows when no done available", async () => {
    const f = await mkFifo("press-fail");
    q.push(f.id, "a");
    q.push(f.id, "b");
    const pulledA = q.pull(f.id, 60)!;
    q.nack(f.id, pulledA.id);
    const pulledB = q.pull(f.id, 60)!;
    q.nack(f.id, pulledB.id);

    const freed = purge.pressurePurge(f.id);
    expect(freed).toBe(true);

    const db = getDb();
    const n = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(f.id) as { n: number };
    expect(n.n).toBe(0);
  });

  test("never deletes open or lock rows", async () => {
    const f = await mkFifo("press-open-lock");
    q.push(f.id, "open-a");
    q.push(f.id, "lock-a");
    q.pull(f.id, 60); // older one locks (open-a)
    // No done/fail rows exist — pressure purge should free nothing.
    const freed = purge.pressurePurge(f.id);
    expect(freed).toBe(false);

    const db = getDb();
    const n = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(f.id) as { n: number };
    expect(n.n).toBe(2);
  });

  test("returns false on a fifo with no purgeable rows", async () => {
    const f = await mkFifo("press-empty");
    expect(purge.pressurePurge(f.id)).toBe(false);
  });
});
