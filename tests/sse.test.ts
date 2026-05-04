import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const TEST_DB_PATH = "data/test-sse.db";

let sse: typeof import("../src/lib/sse");

beforeAll(async () => {
  process.env.FIFOS_DB_PATH = TEST_DB_PATH;
  delete process.env.LEGENDUM_API_KEY;
  delete process.env.LEGENDUM_SECRET;

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  sse = await import("../src/lib/sse");
});

afterAll(async () => {
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

type Frame = { event: string; id: string; data: string };

/** Pull SSE frames until `predicate(frames)` is true, the byte budget runs out, or `timeoutMs` elapses. */
async function readFrames(
  res: Response,
  predicate: (frames: Frame[]) => boolean,
  timeoutMs = 1500,
): Promise<Frame[]> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Frame[] = [];
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start);
    const tick = new Promise<{ done: true }>((r) =>
      setTimeout(() => r({ done: true }), remaining),
    );
    const next = reader.read();
    const result = await Promise.race([next, tick]);
    if ("done" in result && result.done && !("value" in result)) break;
    const r = result as ReadableStreamReadResult<Uint8Array>;
    if (r.done) break;
    buf += decoder.decode(r.value, { stream: true });
    let nl = buf.indexOf("\n\n");
    while (nl !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      nl = buf.indexOf("\n\n");
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
      if (predicate(frames)) {
        try {
          reader.cancel();
        } catch {}
        return frames;
      }
    }
  }
  try {
    reader.cancel();
  } catch {}
  return frames;
}

function parseBlock(block: string): Frame | null {
  // Comment-only blocks (keep-alive `: keep-alive`) yield no frame.
  let event = "";
  let id = "";
  let data = "";
  let saw = false;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx);
    const value = line.slice(idx + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
      saw = true;
    } else if (field === "id") {
      id = value;
      saw = true;
    } else if (field === "data") {
      data = data ? `${data}\n${value}` : value;
      saw = true;
    }
  }
  return saw ? { event, id, data } : null;
}

describe("SSE pub/sub", () => {
  test("delivers a live publish to a subscriber", async () => {
    const scope = "fifo:live-1";
    const res = sse.subscribe(scope, null);
    // Publish after a tick so the subscriber is hooked up.
    setTimeout(() => sse.publish(scope, "push", { id: "i1", position: 0 }), 10);
    const frames = await readFrames(res, (f) => f.length >= 1);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0].event).toBe("push");
    expect(JSON.parse(frames[0].data)).toEqual({ id: "i1", position: 0 });
    expect(Number.parseInt(frames[0].id, 10)).toBeGreaterThan(0);
  });

  test("emits `initial` event on fresh connect (no Last-Event-ID)", async () => {
    const scope = "fifo:initial-1";
    const res = sse.subscribe(scope, null, {
      initial: { type: "fifos", payload: { snapshot: true } },
    });
    const frames = await readFrames(res, (f) => f.length >= 1);
    expect(frames[0].event).toBe("fifos");
    expect(JSON.parse(frames[0].data)).toEqual({ snapshot: true });
  });

  test("Last-Event-ID replays only events strictly newer than the id", async () => {
    const scope = "fifo:replay-1";

    // Live-subscribe and grab the id of the first event so we have a real
    // checkpoint inside the current ring (the global counter is shared, so we
    // can't assume id=1 is meaningful).
    const live = sse.subscribe(scope, null);
    await new Promise((r) => setTimeout(r, 10));
    sse.publish(scope, "push", { n: 1 });
    sse.publish(scope, "push", { n: 2 });
    sse.publish(scope, "push", { n: 3 });

    const liveFrames = await readFrames(live, (f) => f.length >= 3, 500);
    expect(liveFrames.length).toBe(3);
    const idAfterFirst = liveFrames[0].id;

    // Reconnect from idAfterFirst — should replay n=2 and n=3 only.
    const replay = sse.subscribe(scope, idAfterFirst);
    const replayFrames = await readFrames(replay, (f) => f.length >= 2, 500);
    const ns = replayFrames.map((f) => JSON.parse(f.data).n);
    expect(ns).toEqual([2, 3]);
  });

  test("stale Last-Event-ID (older than ring tail) emits `resync`", async () => {
    // Use a fresh scope but we can't truncate the global counter. The ring is
    // capped at 200 events; populate it with 201 events so any small last-id
    // is now older than the tail.
    const scope = "fifo:resync-1";
    for (let i = 0; i < 201; i++) sse.publish(scope, "push", { i });
    const res = sse.subscribe(scope, "1");
    const frames = await readFrames(res, (f) => f.length >= 1, 500);
    expect(frames[0].event).toBe("resync");
  });

  test("future Last-Event-ID (greater than ring head) emits `resync`", async () => {
    const scope = "fifo:resync-2";
    sse.publish(scope, "push", { x: 1 });
    const res = sse.subscribe(scope, "9999999999");
    const frames = await readFrames(res, (f) => f.length >= 1, 500);
    expect(frames[0].event).toBe("resync");
  });

  test("publishUserFifos coalesces a burst into a single `fifos` event", async () => {
    const userId = 7777;
    const scope = `user:${userId}`;
    const res = sse.subscribe(scope, null);

    // Wait for subscription to attach, then fire a burst.
    await new Promise((r) => setTimeout(r, 20));
    let calls = 0;
    for (let i = 0; i < 5; i++) {
      sse.publishUserFifos(userId, () => {
        calls++;
        return { tick: i, calls };
      });
    }

    // Coalesce window is 250ms. Wait long enough for one flush.
    const frames = await readFrames(res, (f) => f.length >= 2, 800);
    const fifosFrames = frames.filter((f) => f.event === "fifos");
    expect(fifosFrames.length).toBe(1);
    // The compute fn from the *latest* call wins.
    expect(JSON.parse(fifosFrames[0].data).tick).toBe(4);
    expect(calls).toBe(1);
  });

  test("per-fifo stream is NOT coalesced — every publish becomes a frame", async () => {
    const scope = "fifo:no-coalesce";
    const res = sse.subscribe(scope, null);
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 3; i++) sse.publish(scope, "push", { i });
    const frames = await readFrames(res, (f) => f.length >= 3, 400);
    expect(frames.length).toBe(3);
    expect(frames.map((f) => JSON.parse(f.data).i)).toEqual([0, 1, 2]);
  });

  test("subscribe response has SSE headers", () => {
    const res = sse.subscribe("fifo:headers", null);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    try {
      res.body?.cancel();
    } catch {}
  });

  test("AbortSignal closes the stream", async () => {
    const ac = new AbortController();
    const res = sse.subscribe("fifo:abort-1", null, { signal: ac.signal });
    ac.abort();
    // Reader should observe done quickly.
    const reader = res.body!.getReader();
    const done = await Promise.race([
      reader.read().then((r) => r.done),
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);
    expect(done).toBe(true);
  });
});
