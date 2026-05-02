import { createHmac } from "node:crypto";
import { PORT } from "./constants.js";
import { isByLegendum } from "./mode.js";

const COOKIE_NAME = "fifos_session";
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function getSecret(): string {
  return process.env.FIFOS_COOKIE_SECRET ?? "dev-secret-change-in-production";
}

export function createSessionCookie(userId: number): string {
  const expires = Date.now() + MAX_AGE * 1000;
  const payload = `${userId}:${expires}`;
  const sig = createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}:${sig}`;
}

export function verifySessionCookie(cookie: string): number | null {
  const parts = cookie.split(":");
  if (parts.length !== 3) return null;
  const [userIdStr, expiresStr, sig] = parts;
  const payload = `${userIdStr}:${expiresStr}`;
  const expected = createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");
  if (sig !== expected) return null;
  if (Date.now() > Number.parseInt(expiresStr, 10)) return null;
  return Number.parseInt(userIdStr, 10);
}

export function getUserIdFromRequest(req: Request): number | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return verifySessionCookie(decodeURIComponent(match[1]));
}

export function getDomain(): string {
  if (isByLegendum()) {
    return process.env.FIFOS_DOMAIN || "https://fifos.in";
  }
  return process.env.FIFOS_DOMAIN || `http://localhost:${PORT}`;
}

export function setAuthCookieHeader(userId: number): string {
  const value = encodeURIComponent(createSessionCookie(userId));
  const isSecure = getDomain().startsWith("https://");
  const secureFlag = isSecure ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secureFlag}`;
}

export function clearAuthCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME };
