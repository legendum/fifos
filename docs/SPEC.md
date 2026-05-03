# Fifos — Product Spec

A minimal PWA + CLI: **create FIFO queues → push/pop items via web UI, CLI, or webhook**. Hosted at **fifos.dev**. Designed for both human and agent users.

Items move through five states: `todo` → `lock` → `done` / `fail` / `skip`. Done, fail, and skip are kept for audit and purged on a schedule. `fail` is retryable; `skip` is terminal (use for malformed/unsupported items).

---

## 1. What it does

- **User signs up** via Login with Legendum (email-only OAuth).
- **User creates fifos** — each fifo is a named FIFO queue with a unique webhook URL.
- **User pushes items, agents pop them** — via the web UI, the `fifos` CLI, or the webhook API.
- **Items are arbitrary UTF-8 text** — typically JSON, Markdown, or YAML. The server doesn't parse them.

```
fifos push '{"build":42}'
fifos pop                # returns oldest todo item, marks done
fifos pull               # returns oldest todo item, marks lock
fifos done               # mark currently-pulled item done
fifos fail               # mark currently-pulled item fail
```

---

## 2. User flows

### 2.1 Auth (Login and Link with Legendum)

Identical to todos. Login + service link in one Legendum flow; encrypted session cookie (HMAC-SHA256, 30-day expiry); `account_token` stored in `users.legendum_token`; auto-logout on Legendum unlink. See `../todos/docs/SPEC.md` §2.1 — verbatim except for service name.

No passwords. The user's **email** is the stable identity.

### 2.2 Fifos (queues)

1. **Dashboard** (after login): list of fifos. "Create fifo" → user enters a name → server generates a unique ULID for the webhook URL.
2. **Web URL**: `fifos.dev/<slug>` — authenticated, session-based. Slug is unique per user. Reserved names: `f`, `w` (rejected on create).
3. **Webhook URL**: `fifos.dev/w/<ulid>` — public, no auth. For agents and scripts.
4. **Each fifo** contains an ordered set of items.

### 2.3 Items

An item is an arbitrary UTF-8 text body with a status and a position.

- **Body**: any text (JSON, Markdown, YAML, plain). UTF-8 only. **Max 64 KB.**
- **Status**: `todo` (queued), `lock` (pulled, awaiting done/fail/skip), `done` (popped or marked done), `fail` (marked fail — retryable), `skip` (marked skip — terminal, not retryable).
- **Position**: server-assigned `INTEGER` from `seq`; monotonically increasing per fifo. FIFO order = ascending `position` among `todo` items.
- **ID**: per-item ULID (Crockford base32, 26 chars — 48-bit ms timestamp + 80-bit random, per the published spec). Public — used in `done/:id`, `fail/:id`, `skip/:id`, `retry/:id`, `status/:id`, and as the `id` field in all webhook responses and SSE events. Lex-sortable and timestamp-decodable. The integer PK is server-internal and never exposed.

#### State machine

```
            push
              │
              ▼
            todo ──pop──► done
              │
            pull
              │
              ▼
            lock ──done──► done
              │ ──fail──► fail   (retryable)
              │ ──skip──► skip   (terminal — retry refused)
              │
   locked_until passes
              │
              └────► todo  (lazy reclaim on next pop/pull)
```

- **Lock timeout**: 30 minutes default (1800s), set on `pull` (`locked_until = now + lock_seconds`). On the next `pop` or `pull`, the server first reclaims any expired locks back to `todo` in the same transaction. Default chosen to cover typical agentic processing (multi-step tool use, network calls, model latency); workers with shorter SLAs can override per-call.
- **Per-pull override**: callers can request a custom lock TTL via the `lock` query param (`POST /pull?lock=5m`) or CLI flag (`fifos pull --lock 5m`). Accepts:
  - **bare integer** → seconds (`600` = 10 min)
  - **`<n>s`** → seconds (`300s`)
  - **`<n>m`** → minutes (`5m`, `10m`)
  - **`<n>h`** → hours (`1h`)

  Server clamps the resolved value to **`[10s, 3600s]`** (10 seconds to 1 hour). Out-of-range or unparseable values are clamped silently to the nearest bound — they don't error. Server default `FIFOS_LOCK_TIMEOUT_SECONDS` applies when no override is given.
- **Done/fail/skip on a "stale" lock** — if `status='lock'` but `locked_until` has passed, `done`/`fail`/`skip` still **succeeds** as long as no `pop`/`pull` has reclaimed the row yet. The lazy reclaim is best-effort (it only fires under contention); whoever finalizes first wins. Once reclaimed back to `todo`, `done`/`fail`/`skip` returns `404 not_locked`.
- **Items are never deleted by user verbs.** Only the periodic purger removes `done` / `fail` / `skip` rows (§5).

### 2.4 CLI: `fifos` command

A lightweight, **stateless** CLI. No local file, no merge logic — every command is a single webhook call. First run prompts for `FIFOS_WEBHOOK` and saves to `.env`.

| Command | Behavior |
|---|---|
| `fifos push "data"` | Push one item. Body is the literal arg. |
| `echo data \| fifos push` | Push one item. Whole stdin (multi-line OK) = one item body. |
| `fifos push --key <s> "data"` | Idempotent push. Server dedupes by `(fifo, key)` for 1h — second call returns the same item id with `200` (free) instead of `201`. Sends `Idempotency-Key: <s>` header. |
| `fifos pop` | Atomically mark oldest `todo` as `done` and print its body. `204` → exit 1, no output. |
| `fifos pop --block [--timeout 60]` | Open SSE on `/items`; wait for a `push` event; then pop. Reconnects on drop using `Last-Event-ID`. `--timeout` (seconds) bounds the wait — on timeout exits 1, no output. Default: no timeout. |
| `fifos pull [--lock <dur>]` | Atomically mark oldest `todo` as `lock`. Stores `id` in `.fifos-lock` (per-cwd, gitignored). `--lock` accepts bare seconds (`600`), or `300s` / `5m` / `1h`. Clamped server-side to `[10s, 1h]`. |
| `fifos done` | POST `/done/:id` using the id from `.fifos-lock`. Removes the lock file on success. |
| `fifos fail [reason words...]` | POST `/fail/:id` using the id from `.fifos-lock`. Optional positional reason (or stdin) is sent as `text/plain` body, max 1 KiB. Removes the lock file on success. **Retryable** via `fifos retry <id>`. |
| `fifos skip [reason words...]` | POST `/skip/:id` using the id from `.fifos-lock`. Same body contract as `fail`. **Terminal** — `fifos retry` refuses (`wrong_status`). Use for malformed/unsupported items. |
| `fifos status <id>` | Print one item's state. Output: `{ id, status, position, created_at, updated_at }`. Exit 1 if id unknown. |
| `fifos retry <id>` | Move a `done` or `fail` item back to `todo` at the tail of the fifo. Same id retained. Exit 1 if id unknown or already `todo`/`lock`/`skip`. |
| `fifos peek --items=5` | GET `/peek?n=5`. Default n=10. Pretty-printed list. |
| `fifos info` | Pretty: `fifo: foo / todo: 3, lock: 1, done: 12, fail: 0, skip: 0`. `--json` / `--yaml` switch output format (also apply to `peek` and `list`). |
| `fifos list todo --items=5` | List up to N todo items, oldest first. Same flags as `info`. |
| `fifos list lock` | List currently-locked items, oldest first, with `locked_until`. |
| `fifos list done --items=5` | List up to N done items, **newest first**. |
| `fifos list fail --items=5` | List up to N fail items, **newest first**. |
| `fifos list skip --items=5` | List up to N skip items, **newest first**. |
| `fifos open` | Open `fifos.dev/<slug>` in default browser. |
| `fifos skill` | Install agent skill to `~/.claude/skills/fifos/` and `~/.cursor/skills/fifos/`. |
| `fifos help` / `--help` | Show commands. |

**Command parsing**: `push`, `pop`, `pull`, `done`, `fail`, `skip`, `status`, `retry`, `peek`, `info`, `list`, `open`, `skill`, `help` are exact-match keywords. Unknown subcommands are an error (we don't have the "anything else is a new item" affordance because `push` already takes data).

**Global flag — `-f` / `--fifo <ulid|url>`** — recognized by every command. Overrides `FIFOS_WEBHOOK`. Accepts a bare 26-char ULID (CLI prepends `${FIFOS_DOMAIN:-https://fifos.dev}/w/`) or a full URL (used verbatim — supports self-hosted domains and dev `http://localhost:3000`). Resolution order: `-f` flag → `FIFOS_WEBHOOK` env → first-run TTY prompt (saves to `.env`) → error.

Multi-fifo services keep their own per-purpose env vars and pass the right one:

```bash
fifos -f "$FIFOS_BUILDS"  push "$payload"
fifos -f "$FIFOS_DEPLOYS" pull
```

**Exit codes** (every command):

| Code | Meaning |
|---|---|
| 0 | Success — got an item / completed action. |
| 1 | Empty queue, missing item id, or `--block --timeout` expired. Not an error, just "nothing to do". |
| 2 | Error — network failure, auth (`402`), 4xx (other than `204`/`404` no-op), 5xx, or invalid usage. |

This lets shell scripts branch reliably: `if data=$(fifos pop); then ...; elif [ $? -eq 1 ]; then sleep 1; else exit 2; fi`.

**Install**: `bun link` in the repo makes `fifos` available globally (via `bin` in package.json → `src/cli/main.ts`).

### 2.5 Local lock file (`.fifos-lock`)

`fifos pull` writes a single line: the item ULID. `fifos done` / `fail` / `skip` reads it and deletes it. This is the **only** local state — it's per-project, gitignore'd by default. If a script crashes between `pull` and finalize, the file persists; the user can `cat .fifos-lock` to see what's in flight, or wait for the 30-minute server-side lock expiry (which will flip the item back to `todo` — at which point `done`/`fail`/`skip` on that id returns 404).

### 2.6 Reordering

- **Fifos** can be dragged up/down on the home screen to reorder. Drag-end commits the full new order in one atomic call to `PATCH /f/reorder` (body: `{ order: [slug, …] }`) — server writes `position = i` for each slug. Same shape as todos.
- **Items cannot be reordered.** FIFO order is server-assigned and immutable.

### 2.7 Agent skill

A skill file (`config/SKILL.md`) installed by `fifos skill` to `~/.claude/skills/fifos/SKILL.md` and `~/.cursor/skills/fifos/SKILL.md`. Teaches agents:

- Use `fifos pull` + `fifos done`/`fail`/`skip` for at-least-once work consumption (`fail` retryable, `skip` terminal).
- Use `fifos pop` for fire-and-forget consumption.
- `FIFOS_WEBHOOK` in `.env` is the default fifo connection; pass `-f <ulid|url>` to target a different fifo per command.
- Respect the lock timeout (30 min default) — long-running work should `pull`, do work, then `done` before the deadline. For known-long tasks, request a longer lock with `fifos pull --lock 1h` (max). Accepts bare seconds, or `s` / `m` / `h` suffixes.
- Use `--key <id>` on push to make retries safe; use `fifos status <id>` to check whether previously pushed work has been processed; use `fifos retry <id>` to resubmit a `done`/`fail` item without re-pushing.

---

## 3. Data we store

**Hierarchy:** users → fifos → items.

### 3.1 Tables

- **users**: `id` (PK), `email` (UNIQUE NOT NULL), `legendum_token`, `created_at`. Identical to todos.
- **fifos**: `id` (PK), `user_id` (FK), `ulid` (UNIQUE), `name`, `slug`, `position` (INTEGER, user-defined ordering; new fifos get `MAX(position)+1`), `seq` (INTEGER, last-issued item position; starts at 0), `created_at`, `updated_at`. Listed by `position` ASC, then `id` ASC.
- **items**: `id` (PK auto-increment), `fifo_id` (FK), `ulid` (UNIQUE — public id for done/fail/skip/status/retry), `position` (INTEGER, from `fifos.seq`), `status` (TEXT: `todo` | `lock` | `done` | `fail` | `skip`), `data` (TEXT, the item body), `locked_until` (INTEGER unix-seconds, NULL except when status=`lock`), `fail_reason` (TEXT, optional diagnostic supplied to fail; NULL except when status=`fail`; cleared on retry), `skip_reason` (TEXT, same shape but for status=`skip`), `created_at`, `updated_at`.
- **idempotency**: `fifo_id` (FK), `key` (TEXT), `item_id` (FK → items.id), `created_at`. **PRIMARY KEY (fifo_id, key)**. Used to dedupe `POST /push` with `Idempotency-Key`. Rows older than 1h are swept by the same purger as done/fail items.

Indexes:

```sql
CREATE INDEX idx_items_fifo_status_pos ON items(fifo_id, status, position);
CREATE INDEX idx_items_fifo_ulid       ON items(fifo_id, ulid);
CREATE INDEX idx_items_purge           ON items(status, updated_at) WHERE status IN ('done','fail','skip');
CREATE INDEX idx_idem_purge            ON idempotency(created_at);
```

The `idx_items_fifo_status_pos` index is the workhorse — pop, pull, peek, list all use it.

### 3.2 Limits

- **Max item body**: 64 KB.
- **Max items per fifo**: 10,000 (any status). Push returns `429` when full **after** running an opportunistic purge (see §5).
- **Max fifos per user**: 50. Enforced on `POST /` fifo creation.

---

## 4. Tech stack & project structure

Same stack as todos: **Bun for everything**, **TypeScript**, **Bun.serve**, **bun:sqlite**, **React 18 + custom CSS** frontend, **workbox-build** for the PWA, **Biome** for lint. Domain: **fifos.dev**.

### Project structure

```
src/
  api/
    server.ts
    handlers/
      auth.ts
      fifos.ts          # /:slug list, create, delete
      webhook.ts        # /w/:ulid/{push,pop,pull,done,fail,skip,retry,status,peek,info,list,items}
      settings.ts
  web/
    App.tsx
    entry.tsx
    components/
  cli/
    main.ts
  lib/
    constants.ts
    mode.ts
    db.ts
    queue.ts            # push/pop/pull/done/fail/skip/retry core (single-file SQL)
    purge.ts            # done/fail/skip sweep + capacity-pressure purge
    sse.ts              # ring buffer + Last-Event-ID replay
    duration.ts         # parseDuration() — bare seconds, "5m", "1h", etc.
    legendum.js / .d.ts
    billing.ts
    ulid.ts
public/
  fifos-192.png         # PWA icon
  fifos-512.png         # PWA icon (also maskable)
  manifest.webmanifest
config/
  schema.sql
  SKILL.md
  nginx.conf
tests/
  *.test.ts             # auth, fifos, queue, sse, billing, cli, purge
scripts/
  build.ts              # clean dist + Bun.build + workbox generateSW
docs/
  CONCEPT.md
  SPEC.md
  PLAN.md
package.json            # bin: { "fifos": "src/cli/main.ts" }
biome.json
tsconfig.json
```

---

## 5. Purging (retention + capacity pressure)

Two purgers, both implemented in `src/lib/purge.ts`.

### 5.1 Time-based retention

Periodic sweep every **1 hour** (in-process `setInterval`, started by `server.ts`). Two queries, both batched at 100 rows per `DELETE` until none match (short transactions, won't block writers):

```sql
-- 1. Done/fail/skip items past retention window
DELETE FROM items
 WHERE id IN (
   SELECT id FROM items
    WHERE status IN ('done','fail','skip')
      AND updated_at < strftime('%s','now') - :retention
    LIMIT 100
 );

-- 2. Idempotency keys older than 1h
DELETE FROM idempotency
 WHERE created_at < strftime('%s','now') - 3600
 LIMIT 100;
```

Default `FIFOS_RETENTION_SECONDS = 604800` (7 days). Configurable via env.

### 5.2 Capacity-pressure purge (on push)

When a `push` would exceed `max_items_per_fifo` (10,000), before returning 429 the server runs an opportunistic purge **for that fifo only**, in this order:

1. Delete up to 100 oldest `done` rows.
2. If still over capacity, delete up to 100 oldest `fail` rows.
3. If still over capacity, delete up to 100 oldest `skip` rows.
4. Retry the insert.
5. If still over capacity, return `429` with `{ "error": "fifo_full" }`.

`todo` and `lock` rows are **never** deleted by the purger.

### 5.3 Lock reclamation

Not a purger — a piece of the pop/pull path. Inside the same transaction as a `pop`/`pull`:

```sql
UPDATE items SET status='todo', locked_until=NULL, updated_at=strftime('%s','now')
 WHERE fifo_id=? AND status='lock' AND locked_until < strftime('%s','now');
```

Then proceed with the actual pop/pull select. Lazy, no cron, no races.

---

## 6. API (REST)

**Auth**: identical to todos — session cookie or `Authorization: Bearer <account_token>`. `lak_` only for the link-key exchange.

### 6.1 Auth & Legendum

- `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`
- `/f/legendum/*` — Legendum middleware

### 6.2 Fifos (auth)

| Route | Description |
|---|---|
| `GET /` | List all fifos for the user, sorted by `position` ASC then `id` ASC. Each row: `{ name, slug, ulid, position, counts: { todo, lock, done, fail, skip }, created_at }`. |
| `POST /` | Create fifo. Body: `{ name }`. New fifo gets `position = MAX(position)+1`. Returns `{ slug, ulid, webhook_url, position }`. **2 credits.** |
| `GET /:slug[?status=<s>]` | Fifo detail. `?status=` filters items by status (`todo` \| `lock` \| `done` \| `fail` \| `skip`); default `todo`. Order: oldest first for `todo`/`lock`, newest first for `done`/`fail`/`skip`. Content-negotiated HTML / JSON / YAML. |
| `PATCH /:slug` | Rename. Body: `{ name }` (required). Returns updated fifo row. |
| `PATCH /f/reorder` | Reorder fifos. Body: `{ order: [slug, …] }` — full ordered list of the user's fifo slugs. Server writes `position = i` for each. Returns `{ ok: true }`. Same pattern as todos `PATCH /t/reorder`. |
| `DELETE /:slug` | Delete fifo and all items. |
| `GET /f/fifos/items` | SSE stream: emits `fifos` event with same JSON as `GET /` whenever any of the user's fifos changes (push, status change, purge, rename). |
| `GET /f/settings/me` | Returns `{ legendum_linked }`. |

### 6.3 Webhook (no auth)

All under `/w/:ulid/`. The ULID is the only credential. CORS open to `*`.

In every response below, the `id` field is the **item ULID** (26 chars, Crockford base32), not the integer PK. Same value used in `done/:id`, `fail/:id`, `skip/:id`, `retry/:id`, `status/:id` paths.

| Verb & path | Body / Headers | Returns | Cost |
|---|---|---|---|
| `POST /w/:ulid/push` | item body. Optional `Idempotency-Key: <s>`. | `201 { id, position, created_at }`. With idempotency key seen in last 1h: `200` with the **same** id, no charge. | **0.01** |
| `POST /w/:ulid/pop` | — | `200 { id, data, position, created_at }` (status now `done`) or `204` if empty | **0.01** |
| `POST /w/:ulid/pull[?lock=<dur>]` | — | `200 { id, data, position, created_at, locked_until }` (status now `lock`) or `204` if empty. `lock` accepts seconds (`600`), or `1800s`/`30m`/`1h`. Clamped to `[10s, 1h]`. Default 30 min. | **0.01** |
| `POST /w/:ulid/done/:id` | — | `200 { id, status: "done" }`. `404 { error: "not_locked" }` if id not currently `lock`. | **0.01** |
| `POST /w/:ulid/fail/:id` | optional `text/plain` body = failure reason (max 1 KiB; whitespace-only treated as no reason). | `200 { id, status: "fail", fail_reason }`. `400 invalid_request` if body exceeds 1 KiB. `404` if id not currently `lock`. | **0.01** |
| `POST /w/:ulid/skip/:id` | optional `text/plain` body = skip reason (same contract as `fail`). | `200 { id, status: "skip", skip_reason }`. Same errors as `fail`. **Terminal** — `retry` refuses. | **0.01** |
| `POST /w/:ulid/retry/:id` | — | `200 { id, status: "todo", position }` — moves a `done`/`fail` item back to `todo` at the tail (new position from `seq`, same id). `404` if id unknown; `409 { error: "wrong_status" }` if currently `todo`, `lock`, or `skip`. | **0.01** |
| `GET /w/:ulid/status/:id` | — | `200 { id, status, position, fail_reason, skip_reason, created_at, updated_at }`. `fail_reason` only set when status=`fail`; `skip_reason` only when status=`skip`; otherwise null. `404` if id unknown. | free |
| `GET /w/:ulid/peek?n=5` | — | `200 { items: [...] }` — up to N oldest `todo` items, no status change. Default n=10, max 100. | free |
| `GET /w/:ulid/info` | — | `200 { name, slug, ulid, counts: {...}, total }` | free |
| `GET /w/:ulid/list/:status?n=5[&reason=<substr>]` | — | `200 { items: [...] }`. `todo`/`lock`: oldest first. `done`/`fail`/`skip`: newest first. Default n=10, max 100. `reason` is a case-insensitive substring filter — applied to `fail_reason` when status=`fail`, `skip_reason` when status=`skip`, ignored for other statuses. SQL `%`/`_`/`\\` in the substring are matched literally. | free |
| `GET /w/:ulid/items` | — | SSE stream (see §6.5) | free |

Shared responses: **404** if ULID unknown (`{ error: "not_found", reason: "ulid" }`); **402** if no Legendum account linked; **429** if Legendum charge fails or fifo at capacity (`reason: fifo_full`).

### 6.4 Content negotiation

GET routes accept `Accept: application/json` (default for webhook), `application/yaml`, `text/html` (default for browser on `/:slug`). `.json` / `.yaml` URL extensions also work.

### 6.5 Server-Sent Events

**Per-fifo stream** — `GET /w/:ulid/items`. No auth (ULID in URL, same exposure as other webhook reads).

Event types:

```
event: push
id: 12345
data: {"id":"01H…","position":42,"created_at":1730000000}

event: change
id: 12346
data: {"id":"01H…","status":"done"}

event: purge
id: 12347
data: {"deleted":{"done":17,"fail":3}}

event: resync
id: 12400
data: {}
```

**Resilience**:
- Server keeps a **per-fifo in-memory ring buffer of the last 200 SSE messages**, each tagged with a monotonic `id` from a per-process counter (server-process scope; resets to 1 on restart, which clients handle via the `resync` fallback below).
- On reconnect, EventSource sends `Last-Event-ID`; the server replays everything newer from the ring buffer, then resumes live.
- If the requested id is **outside the ring** — either older than the tail (gap too large) **or** newer than the head (stale id from a previous server process; counter resets on restart) — the server emits a single `event: resync` and the client must refetch `info` + visible items. Restart-driven resyncs are expected and cheap; the ring is in-memory and not authoritative.
- Periodic `: keep-alive\n\n` comment lines every 25s so proxies don't drop idle streams.

**Per-user stream** — `GET /f/fifos/items` (session cookie). Emits `fifos` events with the full `GET /` JSON whenever any fifo for that user changes. Same ring-buffer + resync semantics.

In dev (`bun run --hot`) restarts drop all open EventSources until refresh.

### 6.6 Errors

Same shape as todos: `{ "error": "<code>", "reason": "<detail>" }` for 4xx. Codes used:

| Status | error | reason | When |
|---|---|---|---|
| 400 | `invalid_request` | (free text in `message`) | Body too large, bad JSON, etc. |
| 402 | `payment_required` | — | No Legendum account linked, hosted mode. |
| 404 | `not_found` | `ulid` | Unknown webhook ULID. |
| 404 | `not_found` | `fifo` | Unknown slug on `/:slug`. |
| 404 | `not_locked` | — | `done`/`fail`/`skip` on an id not currently `lock`. |
| 404 | `not_found` | `item` | `status`/`retry` on unknown item id. |
| 409 | `wrong_status` | — | `retry` on an item that's currently `todo`, `lock`, or `skip`. |
| 429 | `fifo_full` | — | Push and capacity-pressure purge couldn't free space. |
| 429 | `charge_failed` | — | Legendum tab settle failed. |

---

## 7. Billing (Legendum tabs)

Identical mechanism to todos. Different rates.

| Action | Cost |
|---|---|
| Fifo creation | 2 credits |
| Webhook write (push, pop, pull, done, fail, skip, retry) | **0.01** credits |
| Idempotent push (key already seen within 1h) | Free — returns the original item id |
| Webhook read (peek, info, list, items) | Free |
| Authenticated routes | Free |

Charges apply to **every** webhook-write call, regardless of caller — the web UI's push goes through `POST /w/:ulid/push` like any other client and is billed identically. There is no "owner discount" path; the URL defines the rate, not the session.

**Tab threshold**: 2 credits. Charges accumulate until threshold then settle as one Legendum charge.

Self-hosted mode (no `LEGENDUM_API_KEY`) disables billing entirely. Limits in §3.2 still apply.

---

## 8. Security / privacy

- **Auth cookie**: HMAC-SHA256, 30-day expiry. Client cannot forge.
- **Webhook ULIDs**: unguessable (128-bit ULID per the published spec — 48-bit ms timestamp + 80-bit cryptographic random, encoded as 26 Crockford base32 chars). The ULID **is** the credential for webhook routes (no separate token), so the 80-bit random space matters: even a global botnet scanning at 10⁹ req/s would take longer than the age of the universe to land on a valid ULID by chance. Single-fifo scope — a leaked ULID exposes only that queue.
- **CORS**: open to `*` on webhook routes.
- **HTTPS only** in production.
- **Item bodies are not scanned** — UTF-8 text passed through verbatim.

---

## 9. Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind host |
| `FIFOS_DOMAIN` | `http://localhost:$PORT` (dev) / `https://fifos.dev` (prod) | Public domain |
| `FIFOS_DB_PATH` | `data/fifos.db` | SQLite path |
| `FIFOS_COOKIE_SECRET` | — | Required in hosted mode |
| `FIFOS_LOCK_TIMEOUT_SECONDS` | `1800` | Default lock TTL on `pull` (30 min — covers typical agentic processing) |
| `FIFOS_RETENTION_SECONDS` | `604800` (7 days) | Done/fail/skip retention |
| `FIFOS_PURGE_INTERVAL_SECONDS` | `3600` (1 hour) | Time-based sweep cadence |
| `FIFOS_MAX_ITEMS_PER_FIFO` | `10000` | Capacity cap |
| `FIFOS_MAX_ITEM_BYTES` | `65536` (64 KB) | Item body cap |
| `FIFOS_MAX_FIFOS_PER_USER` | `50` | Per-user cap |
| `LEGENDUM_API_KEY` | — | If set, hosted mode |
| `LEGENDUM_SECRET` | — | Required when API key set |
| `LEGENDUM_BASE_URL` | `https://legendum.co.uk` | Legendum host |

### Per-project (CLI)

| Variable | Purpose |
|---|---|
| `FIFOS_WEBHOOK` | Webhook URL (`https://fifos.dev/w/<ulid>`) |

---

## 10. App UX

Mobile-first PWA, portrait-optimized. Same shell as todos.

### 10.1 Fifos screen (home)

- **Top bar**: logo (left, click → install/CLI instructions), Legendum link/unlink widget (right).
- **Body**: list of fifos, ordered by `position` (drag to reorder). Each row shows name + counts pill (`3·1·12 0·2` — happy path `todo·lock·done`, then sad path `fail·skip`).
- **"+"** to create.
- **Swipe left** reveals **Delete**.
- **Tap** → fifo detail screen.
- **Drag-end** commits the new order via `PATCH /f/reorder` (single atomic call).

### 10.2 Fifo detail

- **Back arrow** → home.
- **Header**: fifo name + webhook URL **copy** button (same affordance as todos).
- **Status filter** chips at top: `todo` (default) | `lock` | `done` | `fail` | `skip`. Counts on each chip.
- **Body**: items in chrono order (oldest first for todo/lock, newest first for done/fail/skip). Each row shows truncated body (tap to expand), position, status pill, age. Fail rows show truncated `fail_reason`; skip rows show truncated `skip_reason`.
- **"+"** to push (textarea modal — multi-line OK).
- No drag, no inline edit, no delete from UI in v1 (queue is queue).
- **Live updates** via `/w/:ulid/items` SSE.

---

## 11. PWA & service worker

Same as todos: `workbox-build` `generateSW()`, `cacheId` from `package.json` version, content-hashed bundles, clean dist on build, `updateViaCache: "none"`, page reload on `controllerchange`. No FCM.

`public/manifest.webmanifest` declares name `Fifos`, `start_url: "/"`, `display: "standalone"`, and the two icons (`fifos-192.png` `192x192`, `fifos-512.png` `512x512` with `purpose: "any maskable"`).

---

## 12. Out of scope for v1

- Push notifications.
- Shared fifos / multi-owner.
- Native mobile apps.
- WebSockets (SSE is sufficient).
- Auth on webhook URLs (beyond ULID obscurity).
- Item editing or reordering after push.
- Priority queues, delayed delivery, dead-letter queues with separate retention.
- Batch push/pop in one HTTP call (use scripted loops).

---

## 13. Future developments

- **Native MCP server** (Anthropic Model Context Protocol) — thin wrapper exposing `push`/`pop`/`pull`/`done`/`fail`/`skip`/`retry`/`status`/`peek`/`info`/`list` as MCP tools for direct, typed integration in Claude Code, Claude Desktop, Cursor, etc. Reuses `src/lib/queue.ts`; no duplicate logic. Skipped for v1 because the CLI + agent skill already cover Claude/Cursor and every shell-based runtime.
- Batch APIs (`POST /push-many`, `POST /pop?n=10`).
- Dead-letter fifo: auto-route `fail` items into a separate fifo.
- Per-fifo defaults for lock timeout, retention, capacity (per-pull override already exists in v1).
- Recurring/scheduled push.
- Sharing read or read-write with other users.
- Alert integration on push or fail.

---

## Checklist (implementation)

- [ ] **DB**: `data/fifos.db` from `config/schema.sql` — `users`, `fifos`, `items`, `idempotency`. Indexes per §3.1. `PRAGMA foreign_keys = ON` issued on every connection so `ON DELETE CASCADE` actually fires.
- [ ] **Auth & Legendum**: login/callback/logout, middleware, link/unlink widget, auto-logout on unlink.
- [ ] **Fifos API**: `GET/POST/PATCH/DELETE` per §6.2 + `PATCH /f/reorder`. Slug uniqueness per user. Reserved names.
- [ ] **Webhook API**: push (with `Idempotency-Key`), pop, pull, done, fail, skip, retry, status, peek, info, list, items per §6.3. Lock reclaim in pop/pull tx. Capacity-pressure purge on push.
- [ ] **SSE**: `/w/:ulid/items` and `/f/fifos/items` with ring-buffer + `Last-Event-ID` replay + `resync` fallback (§6.5). 25s keep-alives.
- [ ] **Purger**: time-based sweep on 1h interval (§5.1). Batched 100 deletes.
- [ ] **Billing**: Legendum tabs — 2 cr per fifo create, 0.01 per webhook write, 2-cr threshold. No billing in self-hosted.
- [ ] **CLI**: `push` (arg or stdin = one item; `--key` for idempotency), `pop`, `pop --block [--timeout N]` (SSE), `pull`/`done`/`fail`/`skip` (with `.fifos-lock`), `status <id>`, `retry <id>`, `peek`, `info` (`--json`/`--yaml`), `list <status>`, `open`, `skill`, `help`. Global `-f`/`--fifo <ulid|url>` flag. Documented exit codes 0/1/2.
- [ ] **Frontend — layout**: top bar, install dialog, mobile-first.
- [ ] **Frontend — screens**: login, fifos home (drag to reorder via `PATCH /f/reorder`, swipe-delete), fifo detail (status filter, no item drag).
- [ ] **Frontend — live**: subscribe to `/w/:ulid/items` on detail; `/f/fifos/items` on home.
- [ ] **PWA**: workbox `generateSW()`, version-based cacheId, content-hashed bundles.
- [ ] **Agent skill**: `fifos skill` copies `config/SKILL.md` to `~/.claude/skills/fifos/` and `~/.cursor/skills/fifos/`.
