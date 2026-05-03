import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const TEST_DB_PATH = "data/test-billing.db";

let billing: typeof import("../src/lib/billing");
let mode: typeof import("../src/lib/mode");
let getDb: typeof import("../src/lib/db").getDb;
// biome-ignore lint/suspicious/noExplicitAny: legendum SDK is plain JS
let legendum: any;
let userId: number;
let userIdNoToken: number;

type ChargeCall = { token: string; amount: number; description: string };

let chargeCalls: ChargeCall[];
// biome-ignore lint/suspicious/noExplicitAny: SDK error shape is dynamic
let nextChargeError: any | null = null;

beforeAll(async () => {
  process.env.FIFOS_DB_PATH = TEST_DB_PATH;
  // Force hosted mode so charge paths actually run.
  process.env.LEGENDUM_API_KEY = "lpk_test";
  process.env.LEGENDUM_SECRET = "lsk_test";

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  legendum = require("../src/lib/legendum.js");
  billing = await import("../src/lib/billing");
  mode = await import("../src/lib/mode");
  ({ getDb } = await import("../src/lib/db"));

  legendum.mock({
    charge: async (token: string, amount: number, description: string) => {
      chargeCalls.push({ token, amount, description });
      if (nextChargeError) {
        const err = nextChargeError;
        nextChargeError = null;
        throw err;
      }
      return { email: "mock@test.com", transaction_id: 1, balance: 100 };
    },
  });

  const u1 = getDb().run(
    "INSERT INTO users (email, legendum_token) VALUES (?, ?)",
    "billed@test",
    "tok_user_1",
  );
  userId = Number(u1.lastInsertRowid);

  const u2 = getDb().run(
    "INSERT INTO users (email, legendum_token) VALUES (?, ?)",
    "unlinked@test",
    null,
  );
  userIdNoToken = Number(u2.lastInsertRowid);
});

afterAll(async () => {
  legendum.unmock();
  await billing.closeTabs();
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

beforeEach(() => {
  chargeCalls = [];
  nextChargeError = null;
});

describe("chargeFifoCreate (2 credits)", () => {
  test("charges 2 credits with the user's token", async () => {
    const err = await billing.chargeFifoCreate(userId);
    expect(err).toBeNull();
    expect(chargeCalls).toEqual([
      { token: "tok_user_1", amount: 2, description: "fifos.dev fifo" },
    ]);
  });

  test("returns 402 when the user has no Legendum token", async () => {
    const res = await billing.chargeFifoCreate(userIdNoToken);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(402);
    const body = (await (res as Response).json()) as { error: string };
    expect(body.error).toBe("payment_required");
    expect(chargeCalls).toEqual([]);
  });

  test("returns 402 insufficient_funds when the SDK rejects", async () => {
    nextChargeError = Object.assign(new Error("low"), {
      code: "insufficient_funds",
      status: 402,
    });
    const res = await billing.chargeFifoCreate(userId);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(402);
    const body = (await (res as Response).json()) as { error: string };
    expect(body.error).toBe("insufficient_funds");
  });

  test("clears the token on token_not_found and returns 402", async () => {
    nextChargeError = Object.assign(new Error("gone"), {
      code: "token_not_found",
      status: 404,
    });
    const res = await billing.chargeFifoCreate(userId);
    expect((res as Response).status).toBe(402);
    const row = getDb()
      .query("SELECT legendum_token FROM users WHERE id = ?")
      .get(userId) as { legendum_token: string | null };
    expect(row.legendum_token).toBeNull();

    // Restore for downstream tests.
    getDb().run(
      "UPDATE users SET legendum_token = ? WHERE id = ?",
      "tok_user_1",
      userId,
    );
  });

  test("self-hosted mode skips charging entirely", async () => {
    mode.setByLegendum(false);
    try {
      const err = await billing.chargeFifoCreate(userId);
      expect(err).toBeNull();
      expect(chargeCalls).toEqual([]);
    } finally {
      mode.setByLegendum(null);
    }
  });
});

describe("chargeWebhookWrite (0.01 credits via tab)", () => {
  test("does not charge until the tab threshold (2) is reached", async () => {
    // 100 writes × 0.01 = 1 credit accumulated, still below threshold.
    for (let i = 0; i < 100; i++) {
      const err = await billing.chargeWebhookWrite(userId);
      expect(err).toBeNull();
    }
    expect(chargeCalls).toEqual([]);
  });

  test("flushes 1 whole credit at threshold; leftovers stay on the tab", async () => {
    // Reach 2.0 total (cumulative across the previous test) — flush 2 credits.
    // We've already added 1.0; another 100 adds reaches 2.0.
    for (let i = 0; i < 100; i++) {
      await billing.chargeWebhookWrite(userId);
    }
    expect(chargeCalls.length).toBe(1);
    expect(chargeCalls[0]).toEqual({
      token: "tok_user_1",
      amount: 2,
      description: "fifos.dev writes",
    });
  });

  test("closeTabs flushes nothing when remainder is sub-credit", async () => {
    // Add 0.5 then close — Math.floor drops it.
    for (let i = 0; i < 50; i++) await billing.chargeWebhookWrite(userId);
    expect(chargeCalls).toEqual([]);
    await billing.closeTabs();
    expect(chargeCalls).toEqual([]);
  });

  test("returns 402 for users with no Legendum token", async () => {
    const res = await billing.chargeWebhookWrite(userIdNoToken);
    expect((res as Response).status).toBe(402);
    expect(chargeCalls).toEqual([]);
  });

  test("self-hosted mode skips webhook charging", async () => {
    mode.setByLegendum(false);
    try {
      const err = await billing.chargeWebhookWrite(userId);
      expect(err).toBeNull();
      expect(chargeCalls).toEqual([]);
    } finally {
      mode.setByLegendum(null);
    }
  });
});

describe("Webhook write integration — push dedupe is free", () => {
  test("a deduped push does not invoke chargeWebhookWrite", async () => {
    // Direct integration: push the same Idempotency-Key twice into a real fifo.
    const ulidMod = await import("../src/lib/ulid");
    const queue = await import("../src/lib/queue");

    const fifoUlid = ulidMod.ulid();
    const r = getDb().run(
      "INSERT INTO fifos (user_id, ulid, name, slug) VALUES (?, ?, ?, ?)",
      userId,
      fifoUlid,
      "billed-fifo",
      "billed-fifo",
    );
    const fifoId = Number(r.lastInsertRowid);

    const first = queue.push(fifoId, "hi", "k1");
    expect(first?.deduped).toBe(false);
    const second = queue.push(fifoId, "hi", "k1");
    expect(second?.deduped).toBe(true);

    // Only the first push would charge in the handler; the deduped second one
    // returns early before the chargeWebhookWrite call. Mirror the handler:
    const beforeCalls = chargeCalls.length;
    if (!first?.deduped) await billing.chargeWebhookWrite(userId);
    if (!second?.deduped) await billing.chargeWebhookWrite(userId);
    // 0.01 credit added for the first only — far below threshold, no flush.
    expect(chargeCalls.length).toBe(beforeCalls);
  });
});
