import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const TEST_DB_PATH = "data/test-queue.db";

let q: typeof import("../src/lib/queue");
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
  // Tiny cap so the capacity test doesn't have to push 10k rows.
  // Match fifos.test.ts so the constants module sees the same values
  // regardless of which file initializes it first (bun:test shares the process).
  process.env.FIFOS_MAX_ITEMS_PER_FIFO = "5";
  process.env.FIFOS_MAX_FIFOS_PER_USER = "3";
  delete process.env.LEGENDUM_API_KEY;
  delete process.env.LEGENDUM_SECRET;

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  q = await import("../src/lib/queue");
  ({ getDb } = await import("../src/lib/db"));

  const db = getDb();
  const u = db.run(
    "INSERT INTO users (email) VALUES (?)",
    "queue-test@local",
  );
  userId = Number(u.lastInsertRowid);
});

afterAll(async () => {
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

describe("queue.push", () => {
  test("push returns id, monotonically increasing position", async () => {
    const f = await mkFifo("push-mono");
    const a = q.push(f.id, "alpha");
    const b = q.push(f.id, "beta");
    const c = q.push(f.id, "gamma");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(a!.deduped).toBe(false);
    expect(b!.position).toBe(a!.position + 1);
    expect(c!.position).toBe(b!.position + 1);
    expect(a!.id).not.toBe(b!.id);
  });

  test("push respects capacity cap (returns null when nothing to purge)", async () => {
    const f = await mkFifo("push-cap");
    for (let i = 0; i < 5; i++) {
      const r = q.push(f.id, `item-${i}`);
      expect(r).not.toBeNull();
    }
    // Cap is 5, all are 'open' so pressure-purge can't free anything.
    const overflow = q.push(f.id, "too-much");
    expect(overflow).toBeNull();
  });

  test("pressure-purge frees space by deleting done rows", async () => {
    const f = await mkFifo("push-purge");
    for (let i = 0; i < 5; i++) q.push(f.id, `x${i}`);
    // Pop two → those rows become 'done'.
    q.pop(f.id);
    q.pop(f.id);
    // Cap still 5, but pressurePurge deletes the 2 done rows on next push.
    const r = q.push(f.id, "after-purge");
    expect(r).not.toBeNull();
    expect(r!.deduped).toBe(false);
  });
});

describe("queue.push idempotency", () => {
  test("same key returns the original item with deduped=true", async () => {
    const f = await mkFifo("idem-basic");
    const first = q.push(f.id, "hello", "k1");
    const second = q.push(f.id, "world-but-same-key", "k1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    expect(second!.position).toBe(first!.position);
    expect(second!.deduped).toBe(true);
    // The second body never landed — only one row exists.
    const db = getDb();
    const n = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(f.id) as { n: number };
    expect(n.n).toBe(1);
  });

  test("different keys insert separate items", async () => {
    const f = await mkFifo("idem-distinct");
    const a = q.push(f.id, "one", "kA");
    const b = q.push(f.id, "two", "kB");
    expect(a!.id).not.toBe(b!.id);
  });

  test("concurrent-loser path: simulate winner already in idempotency table", async () => {
    const f = await mkFifo("idem-loser");
    const winner = q.push(f.id, "winner", "race");
    expect(winner).not.toBeNull();

    // Now push another value with the SAME key — the SELECT-before-INSERT
    // happens to find the existing key (deduped early-return), but to exercise
    // the late-loser branch we delete the SELECT-visible idempotency row for
    // a moment is hard. Instead we verify the "second push with same key"
    // gives back the winner — which is the externally observable contract.
    const loser = q.push(f.id, "loser-data", "race");
    expect(loser).not.toBeNull();
    expect(loser!.id).toBe(winner!.id);
    expect(loser!.deduped).toBe(true);

    // And confirm the loser never inserted a row.
    const db = getDb();
    const n = db
      .query("SELECT COUNT(*) AS n FROM items WHERE fifo_id = ?")
      .get(f.id) as { n: number };
    expect(n.n).toBe(1);
  });

  test("concurrent pulls: two simultaneous pulls should not return the same item", async () => {
    const f = await mkFifo("concurrent-pulls");
    q.push(f.id, "item-1");
    q.push(f.id, "item-2");

    // In bun:test, we can use Promise.all to trigger near-simultaneous execution
    // Since queue.ts uses transactions, one should succeed and the other should get the next item or null.
    const [res1, res2] = await Promise.all([
      q.pull(f.id, 60),
      q.pull(f.id, 60),
    ]);

    expect(res1).not.toBeNull();
    expect(res2).not.toBeNull();
    // They must be different items
    expect(res1!.id).not.toBe(res2!.id);
  });

  test("duration parsing: handles various formats correctly", async () => {
    const f = await mkFifo("dur-parsing");
    q.push(f.id, "item1");
    q.push(f.id, "item2");

    // Test min clamp
    const pulledMin = q.pull(f.id, 1)!;
    const beforeMin = Math.floor(Date.now() / 1000);
    expect(pulledMin.locked_until! - beforeMin).toBeGreaterThanOrEqual(9);

    // Test max clamp
    const pulledMax = q.pull(f.id, 99999)!;
    const beforeMax = Math.floor(Date.now() / 1000);
    expect(pulledMax.locked_until! - beforeMax).toBeLessThanOrEqual(3601);
  });

});

describe("queue.pop", () => {
  test("pop returns oldest open and marks done, FIFO order", async () => {
    const f = await mkFifo("pop-order");
    q.push(f.id, "first");
    q.push(f.id, "second");
    q.push(f.id, "third");
    expect(q.pop(f.id)!.data).toBe("first");
    expect(q.pop(f.id)!.data).toBe("second");
    expect(q.pop(f.id)!.data).toBe("third");
    expect(q.pop(f.id)).toBeNull();
  });

  test("pop on empty returns null", async () => {
    const f = await mkFifo("pop-empty");
    expect(q.pop(f.id)).toBeNull();
  });
});

describe("queue.pull / ack / nack", () => {
  test("pull marks lock with locked_until, ack flips to done", async () => {
    const f = await mkFifo("pull-ack");
    const pushed = q.push(f.id, "work");
    const pulled = q.pull(f.id, 60);
    expect(pulled).not.toBeNull();
    expect(pulled!.id).toBe(pushed!.id);
    expect(pulled!.status).toBe("lock");
    expect(pulled!.locked_until).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const acked = q.ack(f.id, pulled!.id);
    expect(acked).not.toBeNull();
    expect(acked!.status).toBe("done");
    expect(acked!.locked_until).toBeNull();
  });

  test("nack marks fail", async () => {
    const f = await mkFifo("pull-nack");
    q.push(f.id, "broken");
    const pulled = q.pull(f.id, 60)!;
    const nacked = q.nack(f.id, pulled.id);
    expect(nacked!.status).toBe("fail");
    // No reason supplied → fail_reason stays NULL.
    expect(nacked!.fail_reason).toBeNull();
  });

  test("nack with a reason persists fail_reason", async () => {
    const f = await mkFifo("pull-nack-reason");
    q.push(f.id, "broken");
    const pulled = q.pull(f.id, 60)!;
    const nacked = q.nack(f.id, pulled.id, "exit code 42");
    expect(nacked!.status).toBe("fail");
    expect(nacked!.fail_reason).toBe("exit code 42");

    // And the read-back reflects it too.
    const fresh = getDb()
      .query("SELECT fail_reason FROM items WHERE ulid = ?")
      .get(pulled.id) as { fail_reason: string };
    expect(fresh.fail_reason).toBe("exit code 42");
  });

  test("ack does NOT touch fail_reason and never sets one", async () => {
    const f = await mkFifo("ack-no-reason");
    q.push(f.id, "ok");
    const pulled = q.pull(f.id, 60)!;
    const acked = q.ack(f.id, pulled.id);
    expect(acked!.status).toBe("done");
    expect(acked!.fail_reason).toBeNull();
  });

  test("ack/nack on already-acked item returns null (not_locked)", async () => {
    const f = await mkFifo("ack-twice");
    q.push(f.id, "x");
    const pulled = q.pull(f.id, 60)!;
    expect(q.ack(f.id, pulled.id)).not.toBeNull();
    // Item is now 'done' — re-ack must return null (handler turns this into 404 not_locked).
    expect(q.ack(f.id, pulled.id)).toBeNull();
    expect(q.nack(f.id, pulled.id)).toBeNull();
  });

  test("ack on unknown ulid returns null", async () => {
    const f = await mkFifo("ack-unknown");
    expect(q.ack(f.id, "ZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });

  test("nack reason is preserved across ItemRow read paths", async () => {
    const f = await mkFifo("nack-readback");
    q.push(f.id, "data");
    const pulled = q.pull(f.id, 60)!;
    q.nack(f.id, pulled.id, "timeout after 30s");

    // Direct SELECT (mirrors the read handlers).
    const row = getDb()
      .query(
        "SELECT ulid AS id, status, fail_reason FROM items WHERE fifo_id = ? AND status = 'fail'",
      )
      .get(f.id) as { id: string; status: string; fail_reason: string };
    expect(row.id).toBe(pulled.id);
    expect(row.fail_reason).toBe("timeout after 30s");
  });
});

describe("queue.pull — lock TTL clamping", () => {
  test("null/missing override falls back to default 300s", async () => {
    const f = await mkFifo("ttl-default");
    q.push(f.id, "x");
    const before = Math.floor(Date.now() / 1000);
    const pulled = q.pull(f.id, null)!;
    expect(pulled.locked_until! - before).toBeGreaterThanOrEqual(299);
    expect(pulled.locked_until! - before).toBeLessThanOrEqual(301);
  });

  test("below-min clamps to 10s", async () => {
    const f = await mkFifo("ttl-min");
    q.push(f.id, "x");
    const before = Math.floor(Date.now() / 1000);
    const pulled = q.pull(f.id, 1)!;
    expect(pulled.locked_until! - before).toBeGreaterThanOrEqual(9);
    expect(pulled.locked_until! - before).toBeLessThanOrEqual(11);
  });

  test("above-max clamps to 3600s", async () => {
    const f = await mkFifo("ttl-max");
    q.push(f.id, "x");
    const before = Math.floor(Date.now() / 1000);
    const pulled = q.pull(f.id, 99999)!;
    expect(pulled.locked_until! - before).toBeGreaterThanOrEqual(3599);
    expect(pulled.locked_until! - before).toBeLessThanOrEqual(3601);
  });

  test("in-range value passes through", async () => {
    const f = await mkFifo("ttl-pass");
    q.push(f.id, "x");
    const before = Math.floor(Date.now() / 1000);
    const pulled = q.pull(f.id, 600)!;
    expect(pulled.locked_until! - before).toBeGreaterThanOrEqual(599);
    expect(pulled.locked_until! - before).toBeLessThanOrEqual(601);
  });
});

describe("queue — stale-lock & lazy reclaim", () => {
  test("ack on a stale lock still succeeds (no reclaim has fired yet)", async () => {
    const f = await mkFifo("stale-ack");
    q.push(f.id, "long-running");
    const pulled = q.pull(f.id, 60)!;
    // Force the lock past its deadline without anyone calling pop/pull.
    const db = getDb();
    db.run(
      "UPDATE items SET locked_until = strftime('%s','now') - 100 WHERE ulid = ?",
      pulled.id,
    );
    // ack deliberately does NOT check locked_until.
    const acked = q.ack(f.id, pulled.id);
    expect(acked).not.toBeNull();
    expect(acked!.status).toBe("done");
  });

  test("lazy reclaim on next pop returns the expired-locked item", async () => {
    const f = await mkFifo("lazy-reclaim");
    q.push(f.id, "abandoned");
    const pulled = q.pull(f.id, 60)!;
    const db = getDb();
    // Expire the lock.
    db.run(
      "UPDATE items SET locked_until = strftime('%s','now') - 100 WHERE ulid = ?",
      pulled.id,
    );
    // Next pop reclaims it back to open then immediately pops it as done.
    const popped = q.pop(f.id);
    expect(popped).not.toBeNull();
    expect(popped!.id).toBe(pulled.id);
    expect(popped!.status).toBe("done");
  });

  test("after lazy reclaim, ack on the (now-open) item returns null", async () => {
    const f = await mkFifo("reclaim-then-ack");
    q.push(f.id, "x");
    q.push(f.id, "y"); // need a second item so the next pull sees one
    const pulled = q.pull(f.id, 60)!;
    const db = getDb();
    db.run(
      "UPDATE items SET locked_until = strftime('%s','now') - 100 WHERE ulid = ?",
      pulled.id,
    );
    // Trigger reclaim by pulling — pulls the just-expired item back to lock
    // (because its position is older than the second item).
    const repulled = q.pull(f.id, 60)!;
    expect(repulled.id).toBe(pulled.id);
    // Now if we ack with the original ulid it succeeds (it IS locked again).
    expect(q.ack(f.id, pulled.id)).not.toBeNull();
  });
});

describe("queue.retry", () => {
  test("retry on done → open at tail with new position; ulid retained", async () => {
    const f = await mkFifo("retry-done");
    q.push(f.id, "first");
    q.push(f.id, "second");
    const popped = q.pop(f.id)!; // first → done
    q.pop(f.id); // second → done
    const r = q.retry(f.id, popped.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.id).toBe(popped.id);
      expect(r.row.status).toBe("open");
      // New position must be > original position (tail).
      expect(r.row.position).toBeGreaterThan(popped.position);
    }
  });

  test("retry on fail → open", async () => {
    const f = await mkFifo("retry-fail");
    q.push(f.id, "x");
    const pulled = q.pull(f.id, 60)!;
    q.nack(f.id, pulled.id);
    const r = q.retry(f.id, pulled.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.status).toBe("open");
  });

  test("retry clears fail_reason back to NULL", async () => {
    const f = await mkFifo("retry-clears-reason");
    q.push(f.id, "x");
    const pulled = q.pull(f.id, 60)!;
    q.nack(f.id, pulled.id, "hard fail");
    const before = getDb()
      .query("SELECT fail_reason FROM items WHERE ulid = ?")
      .get(pulled.id) as { fail_reason: string };
    expect(before.fail_reason).toBe("hard fail");

    const r = q.retry(f.id, pulled.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.status).toBe("open");
      expect(r.row.fail_reason).toBeNull();
    }
    const after = getDb()
      .query("SELECT fail_reason FROM items WHERE ulid = ?")
      .get(pulled.id) as { fail_reason: string | null };
    expect(after.fail_reason).toBeNull();
  });

  test("retry on open → wrong_status", async () => {
    const f = await mkFifo("retry-open");
    const pushed = q.push(f.id, "x")!;
    const r = q.retry(f.id, pushed.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_status");
  });

  test("retry on lock → wrong_status", async () => {
    const f = await mkFifo("retry-lock");
    q.push(f.id, "x");
    const pulled = q.pull(f.id, 60)!;
    const r = q.retry(f.id, pulled.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_status");
  });

  test("retry on unknown ulid → not_found", async () => {
    const f = await mkFifo("retry-unknown");
    const r = q.retry(f.id, "ZZZZZZZZZZZZZZZZZZZZ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});
