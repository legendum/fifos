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
  process.env.FIFOS_MAX_FIFOS_PER_USER = "3";
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
  });

  test("POST / creates a fifo with slug, ulid, webhook_url, position", async () => {
    const { status, body } = await jpost("/", { name: "builds" });
    expect(status).toBe(201);
    expect(body.name).toBe("builds");
    expect(body.slug).toBe("builds");
    expect(body.ulid).toMatch(/^[0-9A-Z]+$/);
    expect(body.ulid.length).toBeGreaterThanOrEqual(20);
    expect(body.webhook_url).toBe(`/w/${body.ulid}`);
    expect(body.position).toBe(0);
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
    expect(body.fifos.length).toBe(2);
    expect(body.fifos[0].slug).toBe("builds");
    expect(body.fifos[0].position).toBe(0);
    expect(body.fifos[0].counts).toEqual({
      open: 0,
      lock: 0,
      done: 0,
      fail: 0,
    });
    expect(body.fifos[1].slug).toBe("my-deploy-queue");
    expect(body.fifos[1].position).toBe(1);
  });

  test("GET /:slug returns JSON detail with empty items", async () => {
    const { status, body } = await jget("/builds");
    expect(status).toBe(200);
    expect(body.slug).toBe("builds");
    expect(body.counts).toEqual({ open: 0, lock: 0, done: 0, fail: 0 });
    expect(body.items).toEqual([]);
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

  test("PATCH /f/reorder writes positions in the given order", async () => {
    const before = await jget("/");
    expect(before.body.fifos[0].slug).toBe("builds-ci");

    const { status, body } = await jpatch("/f/reorder", {
      order: ["my-deploy-queue", "builds-ci"],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const after = await jget("/");
    expect(after.body.fifos[0].slug).toBe("my-deploy-queue");
    expect(after.body.fifos[0].position).toBe(0);
    expect(after.body.fifos[1].slug).toBe("builds-ci");
    expect(after.body.fifos[1].position).toBe(1);
  });

  test("MAX_FIFOS_PER_USER cap returns 403", async () => {
    // Cap is 3; we already have 2. Next one fills, the one after is rejected.
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
    expect(detail.body.counts.open).toBe(2);

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
});
