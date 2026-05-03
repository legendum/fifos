import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const TEST_DB_PATH = "data/test-auth.db";

let auth: typeof import("../src/lib/auth");
let mw: typeof import("../src/api/auth-middleware");
let getDb: typeof import("../src/lib/db").getDb;
let userId: number;

beforeAll(async () => {
  process.env.FIFOS_DB_PATH = TEST_DB_PATH;
  process.env.FIFOS_COOKIE_SECRET = "test-secret-abc";
  delete process.env.LEGENDUM_API_KEY;
  delete process.env.LEGENDUM_SECRET;

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  auth = await import("../src/lib/auth");
  mw = await import("../src/api/auth-middleware");
  ({ getDb } = await import("../src/lib/db"));

  const r = getDb().run(
    "INSERT INTO users (email, legendum_token) VALUES (?, ?)",
    "auth-test@local",
    "tok_real_bearer",
  );
  userId = Number(r.lastInsertRowid);
});

afterAll(async () => {
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

describe("Session cookie HMAC", () => {
  test("createSessionCookie produces userId:expires:sig with valid HMAC", () => {
    const cookie = auth.createSessionCookie(userId);
    expect(cookie.split(":").length).toBe(3);
    expect(auth.verifySessionCookie(cookie)).toBe(userId);
  });

  test("verify rejects tampered signature", () => {
    const cookie = auth.createSessionCookie(userId);
    const [u, e] = cookie.split(":");
    const tampered = `${u}:${e}:not-the-real-sig`;
    expect(auth.verifySessionCookie(tampered)).toBeNull();
  });

  test("verify rejects tampered userId (HMAC binds userId+expires)", () => {
    const cookie = auth.createSessionCookie(userId);
    const [, e, sig] = cookie.split(":");
    const tampered = `${userId + 999}:${e}:${sig}`;
    expect(auth.verifySessionCookie(tampered)).toBeNull();
  });

  test("verify rejects expired cookie", () => {
    // Forge a cookie with an expires timestamp in the past, but a valid HMAC.
    const { createHmac } = require("node:crypto");
    const expires = Date.now() - 1000;
    const payload = `${userId}:${expires}`;
    const sig = createHmac("sha256", "test-secret-abc")
      .update(payload)
      .digest("base64url");
    expect(auth.verifySessionCookie(`${payload}:${sig}`)).toBeNull();
  });

  test("verify rejects malformed cookies", () => {
    expect(auth.verifySessionCookie("")).toBeNull();
    expect(auth.verifySessionCookie("nope")).toBeNull();
    expect(auth.verifySessionCookie("a:b")).toBeNull();
    expect(auth.verifySessionCookie("a:b:c:d")).toBeNull();
  });

  test("setAuthCookieHeader sets HttpOnly, SameSite=Lax, Path=/, Max-Age", () => {
    const header = auth.setAuthCookieHeader(userId);
    expect(header).toContain("fifos_session=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=");
  });

  test("clearAuthCookieHeader expires the cookie", () => {
    expect(auth.clearAuthCookieHeader()).toContain("Max-Age=0");
  });
});

describe("getUserIdFromRequest cookie parsing", () => {
  test("returns userId when a valid session cookie is present", () => {
    const value = encodeURIComponent(auth.createSessionCookie(userId));
    const req = new Request("http://x/", {
      headers: { Cookie: `fifos_session=${value}` },
    });
    expect(auth.getUserIdFromRequest(req)).toBe(userId);
  });

  test("returns null when no cookie header", () => {
    const req = new Request("http://x/");
    expect(auth.getUserIdFromRequest(req)).toBeNull();
  });

  test("returns null for unrelated cookies", () => {
    const req = new Request("http://x/", { headers: { Cookie: "other=1" } });
    expect(auth.getUserIdFromRequest(req)).toBeNull();
  });

  test("ignores tampered session cookie", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "fifos_session=1%3A99999999999999%3Abogus" },
    });
    expect(auth.getUserIdFromRequest(req)).toBeNull();
  });
});

describe("requireAuth / requireAuthAsync", () => {
  test("requireAuth returns 401 Response without cookie", async () => {
    const req = new Request("http://x/");
    const result = mw.requireAuth(req);
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("requireAuth returns { userId } for a valid cookie", () => {
    const value = encodeURIComponent(auth.createSessionCookie(userId));
    const req = new Request("http://x/", {
      headers: { Cookie: `fifos_session=${value}` },
    });
    const result = mw.requireAuth(req);
    expect(result).toEqual({ userId });
  });

  test("requireAuth rejects cookies for users that no longer exist", () => {
    // Forge a cookie for a userId that isn't in the DB.
    const ghost = encodeURIComponent(auth.createSessionCookie(99_999));
    const req = new Request("http://x/", {
      headers: { Cookie: `fifos_session=${ghost}` },
    });
    const result = mw.requireAuth(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("requireAuthAsync accepts a Bearer matching legendum_token", async () => {
    const req = new Request("http://x/", {
      headers: { Authorization: "Bearer tok_real_bearer" },
    });
    const result = await mw.requireAuthAsync(req);
    expect(result).toEqual({ userId });
  });

  test("requireAuthAsync rejects an unknown Bearer token", async () => {
    const req = new Request("http://x/", {
      headers: { Authorization: "Bearer tok_nope" },
    });
    const result = await mw.requireAuthAsync(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("requireAuthAsync ignores non-Bearer Authorization", async () => {
    const req = new Request("http://x/", {
      headers: { Authorization: "Basic abc" },
    });
    const result = await mw.requireAuthAsync(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});
