import { join, resolve } from "node:path";
import { setAuthCookieHeader } from "../lib/auth.js";
import { closeTabs } from "../lib/billing.js";
import { FIFOS_PURGE_INTERVAL_SECONDS, PORT } from "../lib/constants.js";
import { getDb } from "../lib/db.js";
import { isSelfHosted, LOCAL_USER_EMAIL } from "../lib/mode.js";
import { sweepRetention } from "../lib/purge.js";
import { seedDefaultFifosForNewUser } from "../lib/seed-default-fifos.js";
import { requireAuthAsync } from "./auth-middleware.js";
import * as authHandlers from "./handlers/auth.js";
import * as fifosHandlers from "./handlers/fifos.js";
import * as settingsHandlers from "./handlers/settings.js";
import * as webhookHandlers from "./handlers/webhook.js";
import { json } from "./json.js";

const root = resolve(import.meta.dir, "../..");

/** Find the content-hashed JS bundle from `public/dist`, cached after first hit. */
let bundleFile: string | null = null;
async function getBundleFilename(): Promise<string | null> {
  if (bundleFile) return bundleFile;
  try {
    const glob = new Bun.Glob("entry-*.js");
    for await (const f of glob.scan(join(root, "public/dist"))) {
      bundleFile = f;
      return f;
    }
  } catch {
    /* no dist yet */
  }
  return null;
}

/** Send a static file with the given content-type. 404 if missing. */
async function serveStatic(
  filePath: string,
  contentType: string,
  cacheControl?: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
    ...(extraHeaders ?? {}),
  };
  return new Response(file, { headers });
}

async function serveIndex(): Promise<Response> {
  const bundle = await getBundleFilename();
  const scriptTag = bundle
    ? `<script type="module" src="/dist/${bundle}"></script>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <meta name="theme-color" content="#0f172a" />
    <title>Fifos</title>
    <link rel="icon" type="image/png" sizes="192x192" href="/fifos-192.png" />
    <link rel="icon" type="image/png" sizes="512x512" href="/fifos-512.png" />
    <link rel="apple-touch-icon" href="/fifos-192.png" />
    <link rel="manifest" href="/manifest.json" />
    <link rel="stylesheet" href="/main.css" />
  </head>
  <body>
    <div id="root"></div>
    ${scriptTag}
  </body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// @ts-expect-error — pure JS SDK
const legendumSdk = require("../lib/legendum.js");

getDb();

// Time-based retention sweep — every FIFOS_PURGE_INTERVAL_SECONDS (default 1h),
// plus a sweep on boot so a long-stopped instance catches up before serving.
sweepRetention();
setInterval(sweepRetention, FIFOS_PURGE_INTERVAL_SECONDS * 1000);

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
          const created = db
            .query("SELECT id FROM users WHERE email = ?")
            .get(email) as { id: number };
          seedDefaultFifosForNewUser(created.id);
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
    if (verb === "done" && tail)
      return webhookHandlers.postDone(req, ulid, tail);
    if (verb === "fail" && tail)
      return webhookHandlers.postFail(req, ulid, tail);
    if (verb === "skip" && tail)
      return webhookHandlers.postSkip(req, ulid, tail);
    if (verb === "retry" && tail) {
      return webhookHandlers.postRetry(req, ulid, tail);
    }
  }
  if (method === "GET") {
    if (verb === "info") return webhookHandlers.getInfo(req, ulid);
    if (verb === "peek") return webhookHandlers.getPeek(req, ulid);
    if (verb === "items") return webhookHandlers.getItems(req, ulid);
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

    // --- Static frontend assets (no auth, no user resolution). ---
    if (method === "GET") {
      if (path === "/main.css") {
        return serveStatic(join(root, "src/web/main.css"), "text/css");
      }
      if (path === "/manifest.json") {
        return serveStatic(
          join(root, "src/web/manifest.json"),
          "application/manifest+json",
        );
      }
      if (path === "/fifos.png") {
        return serveStatic(join(root, "public/fifos.png"), "image/png");
      }
      if (path === "/fifos-192.png") {
        return serveStatic(join(root, "public/fifos-192.png"), "image/png");
      }
      if (path === "/fifos-512.png") {
        return serveStatic(join(root, "public/fifos-512.png"), "image/png");
      }
      if (path === "/install.sh") {
        return serveStatic(
          join(root, "public/install.sh"),
          "text/plain",
          "no-cache",
        );
      }
      if (path === "/dist/sw.js") {
        return serveStatic(
          join(root, "public/dist/sw.js"),
          "application/javascript",
          "no-cache",
          { "Service-Worker-Allowed": "/" },
        );
      }
      if (path.startsWith("/dist/")) {
        const safe = path.replace(/\.\./g, "");
        return serveStatic(
          join(root, "public", safe),
          "application/javascript",
          "public, max-age=31536000, immutable",
        );
      }
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

    // Browser GETs that are not API-shaped get the SPA shell before user
    // resolution so unauthenticated visitors land on the login UI in hosted mode.
    const acceptNav = req.headers.get("Accept") ?? "";
    const isPageNavigation =
      method === "GET" &&
      !acceptNav.includes("application/json") &&
      !path.startsWith("/f/") &&
      !path.startsWith("/w/") &&
      !path.startsWith("/auth/") &&
      !path.startsWith("/dist/") &&
      !path.match(/\.(md|json|yaml)$/);

    if (isPageNavigation) {
      return await serveIndex();
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
        seedDefaultFifosForNewUser(user.id);
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

    if (path === "/f/fifos/items" && method === "GET") {
      return fifosHandlers.getFifosStream(req, userId);
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
        // null = handler chose HTML format → serve the SPA shell; the client
        // router renders the fifo detail screen.
        if (result === null) return await serveIndex();
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
