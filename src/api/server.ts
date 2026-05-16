import { join, resolve } from "node:path";
import {
  loadPuesConfig,
  mountResource,
  resolveColumns,
} from "pues/base/objects";
import { sseRoute } from "pues/base/sse";
import { setAuthCookieHeader } from "../lib/auth.js";
import { chargeFifoCreate, closeTabs } from "../lib/billing.js";
import {
  DEFAULT_FIFO_MAX_RETRIES,
  FIFOS_PURGE_INTERVAL_SECONDS,
  MAX_FIFO_MAX_RETRIES,
  MIN_FIFO_MAX_RETRIES,
  maxFifosPerUser,
  PORT,
} from "../lib/constants.js";
import { getDb } from "../lib/db.js";
import { toSlug, validateFifoName } from "../lib/fifos.js";
import { isSelfHosted, LOCAL_USER_EMAIL } from "../lib/mode.js";
import { sweepRetention } from "../lib/purge.js";
import { seedDefaultFifosForNewUser } from "../lib/seed-default-fifos.js";
import {
  getAuthUserIdWithBearer,
  requireAuthAsync,
} from "./auth-middleware.js";
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
    <link rel="stylesheet" href="/pues/theme.css" />
    <link rel="stylesheet" href="/pues/objects.css" />
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

// --- pues role-mapped resources (SPEC §5.8) + per-user SSE (SPEC §7) ---
// Iter 6 lands the parent-scoped contract in fifos' items resource. The
// bespoke `/`, `/:slug`, and `/w/:ulid/*` routes continue to own writes
// (creates flow through the credit-billable webhook; slug + max_retries
// invariants live in the createFifo handler). pues' /api/fifos/:fifo_ulid/items
// endpoint is the new authenticated REST surface — items already lacked
// one, so this is a pure additive adoption.
const puesConfig = await loadPuesConfig();
const fifosResourceCfg = puesConfig.resources?.fifos;
const itemsResourceCfg = puesConfig.resources?.items;
if (!fifosResourceCfg || !itemsResourceCfg) {
  throw new Error(
    "config/pues.yaml: `resources.fifos` and `resources.items` are required.",
  );
}

const resolvePuesUser = async (req: Request): Promise<number | null> => {
  if (isSelfHosted()) {
    const db = getDb();
    const row = db.query("SELECT id FROM users LIMIT 1").get() as {
      id: number;
    } | null;
    return row?.id ?? null;
  }
  return await getAuthUserIdWithBearer(req);
};

const puesSse = sseRoute({ resolveUser: resolvePuesUser });

function rejectJson(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function maxRetriesInvalidMessage(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_FIFO_MAX_RETRIES ||
    value > MAX_FIFO_MAX_RETRIES
  ) {
    return `max_retries must be an integer from ${MIN_FIFO_MAX_RETRIES} to ${MAX_FIFO_MAX_RETRIES}`;
  }
  return null;
}

const fifosCols = resolveColumns(getDb(), "fifos", fifosResourceCfg);
// Pre-resolve items cols so the webhook bridge in handlers/webhook.ts can
// project DB rows to canonical wire shape via toWire(row, itemsCols). pues'
// mountResource also resolves these internally; the second resolution is
// idempotent given identical inputs. Exported below for the bridge.
export const itemsCols = resolveColumns(
  getDb(),
  "items",
  itemsResourceCfg,
  fifosCols,
);
// Exported so handlers/webhook.ts can broadcast on the same SSE channel
// the pues-mounted routes use — see SPEC 7.4.
export { puesSse };

// Top-level fifos resource via pues: enforces slug derivation, name
// validation, max_retries bounds, count limit, and credit billing in the
// beforeInsert/beforeUpdate hooks. Mirrors the bespoke createFifo /
// renameFifo logic in src/api/handlers/fifos.ts so /api/fifos and the
// legacy `/` route stay behaviorally equivalent during the dual-routing
// phase. The bespoke routes keep emitting notifyFifosChanged for the UI
// SSE stream — pues broadcasts its own events on /api/events.
const puesFifosRoutes = mountResource({
  db: getDb(),
  name: "fifos",
  config: fifosResourceCfg,
  resolveUser: resolvePuesUser,
  broadcast: puesSse.broadcast,
  beforeInsert: async ({ body, userId }) => {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const nameError = validateFifoName(label);
    if (nameError) return rejectJson(400, "invalid_request", nameError);

    const maxRetriesIn = body.max_retries;
    const maxRetriesMsg = maxRetriesInvalidMessage(maxRetriesIn);
    if (maxRetriesMsg) return rejectJson(400, "invalid_request", maxRetriesMsg);

    const slug = toSlug(label);
    const db = getDb();
    const dup = db
      .query("SELECT 1 FROM fifos WHERE user_id = ? AND slug = ?")
      .get(userId, slug);
    if (dup) {
      return rejectJson(
        400,
        "invalid_request",
        `A fifo with URL "${slug}" already exists`,
      );
    }

    const countRow = db
      .query("SELECT COUNT(*) AS n FROM fifos WHERE user_id = ?")
      .get(userId) as { n: number };
    if (countRow.n >= maxFifosPerUser()) {
      return rejectJson(
        403,
        "forbidden",
        `Fifo limit reached (${maxFifosPerUser()} per account)`,
      );
    }

    const chargeError = await chargeFifoCreate(userId);
    if (chargeError) return chargeError;

    return {
      ...body,
      label,
      slug,
      max_retries: maxRetriesIn ?? DEFAULT_FIFO_MAX_RETRIES,
    };
  },
  beforeUpdate: ({ body, existing, userId }) => {
    const maxRetriesIn = body.max_retries;
    const maxRetriesMsg = maxRetriesInvalidMessage(maxRetriesIn);
    if (maxRetriesMsg) return rejectJson(400, "invalid_request", maxRetriesMsg);

    if (typeof body.label !== "string") return body;
    const trimmed = body.label.trim();
    if (trimmed === "" || trimmed === existing.label) return body;

    const nameError = validateFifoName(trimmed);
    if (nameError) return rejectJson(400, "invalid_request", nameError);

    const newSlug = toSlug(trimmed);
    if (newSlug === existing.slug) return body;

    const db = getDb();
    const conflict = db
      .query("SELECT 1 FROM fifos WHERE user_id = ? AND slug = ? AND ulid != ?")
      .get(userId, newSlug, existing.id);
    if (conflict) {
      return rejectJson(
        400,
        "invalid_request",
        `A fifo with URL "${newSlug}" already exists`,
      );
    }
    return { ...body, slug: newSlug };
  },
});

const puesItemsRoutes = mountResource({
  db: getDb(),
  name: "items",
  config: itemsResourceCfg,
  parentCols: fifosCols,
  resolveUser: resolvePuesUser,
  broadcast: puesSse.broadcast,
  // State-machine entry guard. Items begin life in "todo" regardless of
  // what the client sent; transitions to lock/done/fail/skip happen
  // exclusively via /w/:ulid/*. Combined with methods: [GET, POST] in
  // pues.yaml, this means no pues route can mutate status on an
  // existing row.
  beforeInsert: ({ body }) => ({ ...body, status: "todo" }),
});

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
  // SSE streams must outlive Bun's default 10s idle timeout. 255 is the max.
  idleTimeout: 255,
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
    // pues-mounted top-level fifos resource — coexists with the bespoke
    // `/` and `/:slug` routes during the dual-routing phase. The hooks in
    // mountResource above enforce slug, max_retries, count limit, and
    // billing so /api/fifos and the legacy `/` route stay equivalent.
    ...puesFifosRoutes,
    // pues-mounted parent-scoped resource: items. Items remain primarily
    // written via /w/:ulid/* (webhook, public credential, billable); these
    // routes add an authenticated REST surface for programmatic clients.
    ...puesItemsRoutes,
    // pues per-user SSE stream — coexists with the bespoke /w/:ulid/items
    // and /f/fifos/items streams during the dual-routing phase.
    ...puesSse.routes,
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
      if (path === "/pues/theme.css") {
        return serveStatic(
          join(root, "pues/base/theme/theme.css"),
          "text/css",
        );
      }
      if (path === "/pues/objects.css") {
        return serveStatic(
          join(root, "pues/base/objects/objects.css"),
          "text/css",
        );
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
    if (path === "/f/settings/me" && method === "PATCH") {
      return await settingsHandlers.patchMe(req, userId);
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
