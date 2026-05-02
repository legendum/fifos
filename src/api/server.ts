import { setAuthCookieHeader } from "../lib/auth.js";
import { closeTabs } from "../lib/billing.js";
import { PORT } from "../lib/constants.js";
import { getDb } from "../lib/db.js";
import { isSelfHosted, LOCAL_USER_EMAIL } from "../lib/mode.js";
import { requireAuthAsync } from "./auth-middleware.js";
import * as authHandlers from "./handlers/auth.js";
import * as fifosHandlers from "./handlers/fifos.js";
import * as settingsHandlers from "./handlers/settings.js";
import * as webhookHandlers from "./handlers/webhook.js";
import { json } from "./json.js";

// @ts-expect-error — pure JS SDK
const legendumSdk = require("../lib/legendum.js");

getDb();

const legendumMiddleware = legendumSdk.isConfigured()
  ? legendumSdk.middleware({
      prefix: "/f/legendum",
      getToken: async (_req: Request, userId: string) => {
        const db = getDb();
        const row = db
          .query("SELECT legendum_token FROM users WHERE id = ?")
          .get(userId) as { legendum_token: string | null } | undefined;
        return row?.legendum_token || null;
      },
      setToken: async (_req: Request, accountToken: string, userId: string) => {
        const db = getDb();
        db.run(
          "UPDATE users SET legendum_token = ? WHERE id = ?",
          accountToken,
          userId,
        );
      },
      clearToken: async (_req: Request, userId: string) => {
        const db = getDb();
        db.run("UPDATE users SET legendum_token = NULL WHERE id = ?", userId);
      },
      onLinkKey: async (
        _req: Request,
        accountToken: string,
        email: string | null,
      ) => {
        if (!email) return;
        const db = getDb();
        const row = db
          .query("SELECT id FROM users WHERE email = ?")
          .get(email) as { id: number } | undefined;
        if (!row) {
          db.run(
            "INSERT INTO users (email, legendum_token) VALUES (?, ?)",
            email,
            accountToken,
          );
        } else {
          db.run(
            "UPDATE users SET legendum_token = ? WHERE id = ?",
            accountToken,
            row.id,
          );
        }
      },
    })
  : null;

const webhookCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
};

/**
 * Resolve `/w/:ulid/<verb>` routes. Returns null when the path doesn't match
 * a registered webhook verb so the caller can fall through to a 404.
 */
async function routeWebhook(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // Strip optional content-negotiation suffix for verb dispatch.
  const m = path.match(
    /^\/w\/([0-9A-Za-z]+)\/([a-z]+)(?:\/([0-9A-Za-z]+))?(?:\.(json|yaml))?$/,
  );
  if (!m) return null;
  const [, ulid, verb, tail] = m;

  if (method === "POST") {
    if (verb === "push") return webhookHandlers.postPush(req, ulid);
    if (verb === "pop") return webhookHandlers.postPop(req, ulid);
    if (verb === "pull") return webhookHandlers.postPull(req, ulid);
    if (verb === "ack" && tail) return webhookHandlers.postAck(req, ulid, tail);
    if (verb === "nack" && tail)
      return webhookHandlers.postNack(req, ulid, tail);
    if (verb === "retry" && tail) {
      return webhookHandlers.postRetry(req, ulid, tail);
    }
  }
  if (method === "GET") {
    if (verb === "info") return webhookHandlers.getInfo(req, ulid);
    if (verb === "peek") return webhookHandlers.getPeek(req, ulid);
    if (verb === "list" && tail) {
      return webhookHandlers.getList(req, ulid, tail);
    }
    if (verb === "status" && tail) {
      return webhookHandlers.getStatus(req, ulid, tail);
    }
  }
  return null;
}

export default {
  port: PORT,
  development: !!process.env.DEV,
  routes: {
    ...(legendumSdk.isConfigured()
      ? {
          "/auth/login": { GET: (req: Request) => authHandlers.getLogin(req) },
          "/auth/callback": {
            GET: (req: Request) => authHandlers.getCallback(req),
          },
          "/auth/logout": { POST: () => authHandlers.postLogout() },
        }
      : {}),
  },
  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS" && path.startsWith("/w/")) {
      return new Response(null, { status: 204, headers: webhookCorsHeaders });
    }

    // --- Public webhook routes (no auth — ULID is the credential). ---
    // Handled BEFORE user resolution because hosted mode would otherwise 401.
    if (path.startsWith("/w/")) {
      const res = await routeWebhook(req, path, method);
      if (res) {
        for (const [k, v] of Object.entries(webhookCorsHeaders)) {
          res.headers.set(k, v);
        }
        return res;
      }
    }

    // POST link-key: Bearer lak_ → account_token + optional session cookie.
    if (
      legendumMiddleware &&
      path === "/f/legendum/link-key" &&
      method === "POST"
    ) {
      const legendumRes = await legendumMiddleware(req);
      if (legendumRes?.status === 200) {
        const data = (await legendumRes.json()) as {
          account_token: string;
          email?: string;
        };
        const email = data.email;
        if (email) {
          const db = getDb();
          const row = db
            .query("SELECT id FROM users WHERE email = ?")
            .get(email) as { id: number } | undefined;
          if (row) {
            const headers = new Headers({
              "Content-Type": "application/json",
            });
            headers.append("Set-Cookie", setAuthCookieHeader(row.id));
            return new Response(JSON.stringify(data), { status: 200, headers });
          }
        }
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return legendumRes!;
    }

    // Resolve user — self-hosted has a single local user; hosted requires auth.
    let userId: number;
    if (isSelfHosted()) {
      const db = getDb();
      let user = db.query("SELECT id FROM users LIMIT 1").get() as {
        id: number;
      } | null;
      if (!user) {
        db.run("INSERT INTO users (email) VALUES (?)", LOCAL_USER_EMAIL);
        user = db.query("SELECT id FROM users LIMIT 1").get() as {
          id: number;
        };
      }
      userId = user.id;
    } else {
      const auth = await requireAuthAsync(req);
      if (auth instanceof Response) return auth;
      userId = auth.userId;

      if (legendumMiddleware) {
        const legendumRes = await legendumMiddleware(req, userId);
        if (legendumRes) return legendumRes;
      }
    }

    if (path === "/f/settings/me" && method === "GET") {
      return settingsHandlers.getMe(userId);
    }

    // --- Fifos CRUD (auth) ---
    if (path === "/" && method === "GET") {
      return fifosHandlers.indexFifos(userId);
    }
    if (path === "/" && method === "POST") {
      return await fifosHandlers.createFifo(req, userId);
    }
    if (path === "/f/reorder" && method === "PATCH") {
      return await fifosHandlers.reorderFifos(req, userId);
    }

    // /:slug — must avoid colliding with /f/*, /w/*, /auth/*, /dist/*.
    const slugMatch = path.match(/^\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
    if (
      slugMatch &&
      !path.startsWith("/f/") &&
      !path.startsWith("/w/") &&
      !path.startsWith("/auth/") &&
      !path.startsWith("/dist/")
    ) {
      const rawSlug = slugMatch[1];
      if (method === "GET") {
        const result = fifosHandlers.getFifo(req, rawSlug, userId);
        if (result === null)
          return json({ error: "not_found", reason: "route" }, 404);
        return result;
      }
      if (method === "PATCH") {
        return await fifosHandlers.renameFifo(req, rawSlug, userId);
      }
      if (method === "DELETE") {
        return fifosHandlers.deleteFifo(rawSlug, userId);
      }
    }

    return json({ error: "not_found", reason: "route" }, 404);
  },
};

process.on("SIGTERM", async () => {
  await closeTabs();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await closeTabs();
  process.exit(0);
});
