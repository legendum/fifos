import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const TEST_DB_PATH = "data/test-fifos.db";
const PORT = 3041;
let server: { stop: () => void } | undefined;
let base: string;

beforeAll(async () => {
  // Force self-hosted mode + isolated DB + small caps so we can test limits.
  // Match queue.test.ts so the constants module sees the same values
  // regardless of which file initializes it first (bun:test shares the process).
  process.env.FIFOS_DB_PATH = TEST_DB_PATH;
  process.env.FIFOS_MAX_FIFOS_PER_USER = "4";
  process.env.FIFOS_MAX_ITEMS_PER_FIFO = "5";
  delete process.env.LEGENDUM_API_KEY;
  delete process.env.LEGENDUM_SECRET;

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  const mod = await import("../src/api/server");
  server = Bun.serve({ ...mod.default, port: PORT });
  base = `http://localhost:${PORT}`;
});

afterAll(async () => {
  server?.stop();
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

async function jget(path: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
  });
  return { status: res.status, body: await res.json() };
}
async function jpost(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function jpatch(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function jdelete(path: string) {
  const res = await fetch(`${base}${path}`, { method: "DELETE" });
  return { status: res.status, body: await res.json() };
}
async function pushItem(ulid: string, data: string, idemKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const res = await fetch(`${base}/w/${ulid}/push`, {
    method: "POST",
    headers,
    body: data,
  });
  return { status: res.status, body: await res.json() };
}

describe("Fifos CRUD — self-hosted", () => {
  test("settings/me reports unlinked local user", async () => {
    const { status, body } = await jget("/f/settings/me");
    expect(status).toBe(200);
    expect(body.legendum_linked).toBe(false);
    expect(body.meta).toEqual({});
  });

  test("PATCH /f/settings/me merges meta (theme)", async () => {
    const { status, body } = await jpatch("/f/settings/me", {
      meta: { theme: "light" },
    });
    expect(status).toBe(200);
    expect(body.meta?.theme).toBe("light");
    const again = await jget("/f/settings/me");
    expect(again.body.meta?.theme).toBe("light");
  });

  test("starter fifo is seeded for the local user", async () => {
    const { status, body } = await jget("/");
    expect(status).toBe(200);
    expect(body.fifos.length).toBe(1);
    expect(body.fifos[0].slug).toBe("my-first-fifo");
    expect(body.fifos[0].name).toBe("My first FIFO");
    expect(body.fifos[0].position).toBe(0);
    expect(body.fifos[0].counts.todo).toBe(1);
  });

  test("POST / creates a fifo with slug, ulid, webhook_url, position", async () => {
    const { status, body } = await jpost("/", { name: "builds" });
    expect(status).toBe(201);
    expect(body.name).toBe("builds");
    expect(body.slug).toBe("builds");
    expect(body.ulid).toMatch(/^[0-9A-Z]+$/);
    expect(body.ulid.length).toBeGreaterThanOrEqual(20);
    expect(body.webhook_url).toBe(`/w/${body.ulid}`);
    expect(body.position).toBe(1);
    expect(body.max_retries).toBe(3);
  });

  test("POST / slugifies a multi-word name", async () => {
    const { status, body } = await jpost("/", { name: "My Deploy Queue" });
    expect(status).toBe(201);
    expect(body.slug).toBe("my-deploy-queue");
  });

  test("POST / rejects empty name", async () => {
    const { status, body } = await jpost("/", { name: "  " });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  test("POST / rejects reserved slugs (f, w, auth)", async () => {
    for (const name of ["f", "w", "auth"]) {
      const { status, body } = await jpost("/", { name });
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_request");
      expect(body.message.toLowerCase()).toContain("reserved");
    }
  });

  test("POST / rejects duplicate slug for the same user", async () => {
    const { status } = await jpost("/", { name: "builds" });
    expect(status).toBe(400);
  });

  test("GET / lists fifos with counts and ordering", async () => {
    const { status, body } = await jget("/");
    expect(status).toBe(200);
    expect(Array.isArray(body.fifos)).toBe(true);
    expect(body.fifos.length).toBe(3);
    expect(body.fifos[0].slug).toBe("my-first-fifo");
    expect(body.fifos[0].position).toBe(0);
    expect(body.fifos[0].counts.todo).toBe(1);
    expect(body.fifos[1].slug).toBe("builds");
    expect(body.fifos[1].position).toBe(1);
    expect(body.fifos[1].max_retries).toBe(3);
    expect(body.fifos[1].counts).toEqual({
      todo: 0,
      lock: 0,
      done: 0,
      fail: 0,
      skip: 0,
    });
    expect(body.fifos[2].slug).toBe("my-deploy-queue");
    expect(body.fifos[2].position).toBe(2);
  });

  test("GET /:slug returns JSON detail with empty items", async () => {
    const { status, body } = await jget("/builds");
    expect(status).toBe(200);
    expect(body.slug).toBe("builds");
    expect(body.counts).toEqual({ todo: 0, lock: 0, done: 0, fail: 0, skip: 0 });
    expect(body.items).toEqual([]);
    expect(body.max_retries).toBe(3);
  });

  test("GET /:slug 404s for unknown slug", async () => {
    const { status, body } = await jget("/no-such-fifo");
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(body.reason).toBe("fifo");
  });

  test("GET /:slug rejects invalid status filter", async () => {
    const { status, body } = await jget("/builds?status=bogus");
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  test("PATCH /:slug renames and updates slug", async () => {
    const { status, body } = await jpatch("/builds", { name: "Builds CI" });
    expect(status).toBe(200);
    expect(body.name).toBe("Builds CI");
    expect(body.slug).toBe("builds-ci");
    expect(body.old_slug).toBe("builds");

    const list = await jget("/");
    const slugs = list.body.fifos.map((f: { slug: string }) => f.slug);
    expect(slugs).toContain("builds-ci");
    expect(slugs).not.toContain("builds");
  });

  test("PATCH /:slug rejects rename collision", async () => {
    // builds-ci and my-deploy-queue both exist; rename builds-ci -> my-deploy-queue
    const { status, body } = await jpatch("/builds-ci", {
      name: "my-deploy-queue",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  test("PATCH /:slug updates only max_retries", async () => {
    const { status, body } = await jpatch("/builds-ci", { max_retries: 9 });
    expect(status).toBe(200);
    expect(body.max_retries).toBe(9);
    expect(body.slug).toBeUndefined();
    const detail = await jget("/builds-ci");
    expect(detail.body.max_retries).toBe(9);
    await jpatch("/builds-ci", { max_retries: 3 });
  });

  test("PATCH /:slug rejects max_retries below 1", async () => {
    const { status } = await jpatch("/builds-ci", { max_retries: 0 });
    expect(status).toBe(400);
  });

  test("POST / accepts optional max_retries", async () => {
    const { status, body } = await jpost("/", {
      name: "retry-policy",
      max_retries: 7,
    });
    expect(status).toBe(201);
    expect(body.max_retries).toBe(7);
    await jdelete("/retry-policy");
  });

  test("POST / rejects max_retries below 1", async () => {
    const { status } = await jpost("/", { name: "bad-retries", max_retries: 0 });
    expect(status).toBe(400);
  });

  test("PATCH /f/reorder writes positions in the given order", async () => {
    const before = await jget("/");
    expect(before.body.fifos[0].slug).toBe("my-first-fifo");

    const { status, body } = await jpatch("/f/reorder", {
      order: ["my-deploy-queue", "builds-ci", "my-first-fifo"],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const after = await jget("/");
    expect(after.body.fifos[0].slug).toBe("my-deploy-queue");
    expect(after.body.fifos[0].position).toBe(0);
    expect(after.body.fifos[1].slug).toBe("builds-ci");
    expect(after.body.fifos[1].position).toBe(1);
    expect(after.body.fifos[2].slug).toBe("my-first-fifo");
    expect(after.body.fifos[2].position).toBe(2);
  });

  test("MAX_FIFOS_PER_USER cap returns 403", async () => {
    // Cap is 4; we have seed + builds-ci + my-deploy-queue = 3. Next creates
    // the 4th; the following hits the cap.
    const r1 = await jpost("/", { name: "third" });
    expect(r1.status).toBe(201);
    const r2 = await jpost("/", { name: "fourth" });
    expect(r2.status).toBe(403);
    expect(r2.body.error).toBe("forbidden");
  });

  test("DELETE /:slug cascades items and idempotency rows", async () => {
    // Use the just-created "third" fifo: push 2 items (one with idem key), then delete.
    const list = await jget("/");
    const fifo = list.body.fifos.find(
      (f: { slug: string }) => f.slug === "third",
    );
    expect(fifo).toBeTruthy();
    const fifoUlid = fifo.ulid;

    const p1 = await pushItem(fifoUlid, "hello");
    expect(p1.status).toBe(201);
    const p2 = await pushItem(fifoUlid, "world", "k1");
    expect(p2.status).toBe(201);

    // Sanity: counts reflect the pushes.
    const detail = await jget("/third");
    expect(detail.body.counts.todo).toBe(2);

    const del = await jdelete("/third");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Fifo is gone…
    const after = await jget("/third");
    expect(after.status).toBe(404);

    // …and items + idempotency rows for it are gone too (cascade).
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    const items = db
      .query(
        "SELECT COUNT(*) AS n FROM items i WHERE NOT EXISTS (SELECT 1 FROM fifos f WHERE f.id = i.fifo_id)",
      )
      .get() as { n: number };
    expect(items.n).toBe(0);
    const idem = db
      .query(
        "SELECT COUNT(*) AS n FROM idempotency x WHERE NOT EXISTS (SELECT 1 FROM fifos f WHERE f.id = x.fifo_id)",
      )
      .get() as { n: number };
    expect(idem.n).toBe(0);
  });

  test("DELETE /:slug 404s for unknown slug", async () => {
    const { status, body } = await jdelete("/no-such-fifo");
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  test("GET /w/:ulid/list/fail?reason=… filters by substring (case-insensitive, literal % _)", async () => {
    const create = await jpost("/", { name: "reason-filter" });
    expect(create.status).toBe(201);
    const fifoUlid: string = create.body.ulid;

    // Push 4 items, pull + nack each with distinct reasons.
    const reasons = [
      "OOM: ran out of memory",
      "timeout after 30s",
      "validation failed: 100% rejected",
      "OOM: heap exhausted",
    ];
    for (const r of reasons) {
      const push = await fetch(`${base}/w/${fifoUlid}/push`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: r.slice(0, 8),
      });
      expect(push.status).toBe(201);
      const pull = await fetch(`${base}/w/${fifoUlid}/pull`, {
        method: "POST",
      });
      const pulled = (await pull.json()) as { id: string };
      const failRes = await fetch(`${base}/w/${fifoUlid}/fail/${pulled.id}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: r,
      });
      expect(failRes.status).toBe(200);
      const fr = (await failRes.json()) as { exhausted_retries: boolean };
      expect(fr.exhausted_retries).toBe(false);
    }

    // Substring match — case-insensitive, returns 2 items.
    const r1 = await fetch(`${base}/w/${fifoUlid}/list/fail?reason=oom`);
    const j1 = (await r1.json()) as {
      items: { reason: string }[];
    };
    expect(j1.items.length).toBe(2);
    for (const it of j1.items) expect(it.reason.toLowerCase()).toContain("oom");

    // SQL wildcard `%` is matched literally — finds the validation row only.
    const r2 = await fetch(`${base}/w/${fifoUlid}/list/fail?reason=100%25`);
    const j2 = (await r2.json()) as { items: { reason: string }[] };
    expect(j2.items.length).toBe(1);
    expect(j2.items[0].reason).toContain("100%");

    // No match → empty list.
    const r3 = await fetch(`${base}/w/${fifoUlid}/list/fail?reason=nonesuch`);
    const j3 = (await r3.json()) as { items: unknown[] };
    expect(j3.items).toEqual([]);

    // reason on a non-fail status is silently ignored (returns whatever is there).
    const r4 = await fetch(`${base}/w/${fifoUlid}/list/done?reason=oom`);
    expect(r4.status).toBe(200);

    // Free the fifo slot so subsequent tests can still create within the cap.
    const del = await jdelete("/reason-filter");
    expect(del.status).toBe(200);
  });

  test("POST /w/:ulid/fail/:id rejects bodies over 1 KiB with 400", async () => {
    // Need a locked item to fail — create a fifo, push, pull.
    const create = await jpost("/", { name: "fail-cap" });
    expect(create.status).toBe(201);
    const fifoUlid: string = create.body.ulid;

    const pushRes = await fetch(`${base}/w/${fifoUlid}/push`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "needs fail",
    });
    expect(pushRes.status).toBe(201);

    const pullRes = await fetch(`${base}/w/${fifoUlid}/pull`, {
      method: "POST",
    });
    expect(pullRes.status).toBe(200);
    const pulled = (await pullRes.json()) as { id: string };

    const oversized = "x".repeat(1025);
    const failRes = await fetch(`${base}/w/${fifoUlid}/fail/${pulled.id}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: oversized,
    });
    expect(failRes.status).toBe(400);
    const j = (await failRes.json()) as { error: string };
    expect(j.error).toBe("invalid_request");
  });

  test("POST /w/:ulid/fail sets exhausted_retries when auto-skipping", async () => {
    await jpatch("/builds-ci", { max_retries: 1 });
    const list = await jget("/");
    const entry = list.body.fifos.find(
      (f: { slug: string }) => f.slug === "builds-ci",
    );
    expect(entry).toBeTruthy();
    const fifoUlid = entry.ulid as string;

    const pushRes = await fetch(`${base}/w/${fifoUlid}/push`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "two-strikes",
    });
    expect(pushRes.status).toBe(201);

    const pull1 = await fetch(`${base}/w/${fifoUlid}/pull`, { method: "POST" });
    const pulled1 = (await pull1.json()) as { id: string };
    const fail1 = await fetch(`${base}/w/${fifoUlid}/fail/${pulled1.id}`, {
      method: "POST",
    });
    expect(fail1.status).toBe(200);
    const fj1 = (await fail1.json()) as {
      status: string;
      exhausted_retries: boolean;
    };
    expect(fj1.status).toBe("fail");
    expect(fj1.exhausted_retries).toBe(false);

    const retryRes = await fetch(`${base}/w/${fifoUlid}/retry/${pulled1.id}`, {
      method: "POST",
    });
    expect(retryRes.status).toBe(200);

    const pull2 = await fetch(`${base}/w/${fifoUlid}/pull`, { method: "POST" });
    const pulled2 = (await pull2.json()) as { id: string };
    const fail2 = await fetch(`${base}/w/${fifoUlid}/fail/${pulled2.id}`, {
      method: "POST",
    });
    expect(fail2.status).toBe(200);
    const fj2 = (await fail2.json()) as {
      status: string;
      exhausted_retries: boolean;
    };
    expect(fj2.status).toBe("skip");
    expect(fj2.exhausted_retries).toBe(true);

    await jpatch("/builds-ci", { max_retries: 3 });
  });
});
