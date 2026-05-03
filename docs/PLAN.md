# Fifos — Implementation Plan

Build order derived from `SPEC.md`. Each phase ends in something runnable and testable. Most file paths are taken from §4 of SPEC; SQL from §3 and §5; route shapes from §6.

The `../todos` repo is the working template — when a phase says "copy from todos", port it verbatim and rename `todos`→`fifos`, `lists`→`fifos`, `/t/`→`/f/`. Skip todos-specific bits (markdown, undo/redo, `text` blob).

---

## Phase 0 — Repo bootstrap

**Goal:** clean repo skeleton that builds and lints.

1. Copy these from `../todos`, then s/todos/fifos/g and s/Todos/Fifos/g:
   - `package.json` (drop `@dnd-kit/*` only if we end up not using DnD — todos uses it, we will too for fifo reorder, so **keep**)
   - `biome.json`, `tsconfig.json`
   - `bun.lock` will regenerate on `bun install`
   - `.gitignore` — add `.fifos-lock` to it
   - `.env.example` — strip todos vars, add the fifos vars from SPEC §9
2. Update `package.json`:
   - `"name": "fifos"`, `"bin": { "fifos": "src/cli/main.ts" }`
   - Keep all dev deps (`workbox-build`, `@dnd-kit/*`, biome, etc.)
3. `bun install` → `bun run lint` should pass on an empty repo. Add a placeholder `src/index.ts` (single `export {};`) so biome doesn't complain about an empty source tree.
4. **`package.json` scripts** (port from todos, rename):

   | Script | Command | Purpose |
   |---|---|---|
   | `dev` | `bun run --hot src/api/server.ts` | Hot-reload dev server |
   | `start` | `bun run scripts/build.ts && bun run src/api/server.ts` | Build + run (prod) |
   | `build` | `bun run scripts/build.ts` | Build web + service worker |
   | `lint` | `biome check .` | Biome check |
   | `lint:fix` | `biome check --write .` | Biome auto-fix |
   | `test` | `bun test` | Run tests |
   | `smoke` | `bun run lint && bun test && bun run build` | Pre-flight (CI parity) |

**Done when:** `bun run lint` is green and `bun --version` works.

---

## Phase 1 — Schema & DB helpers

**Goal:** `data/fifos.db` exists with all tables and indexes; `getDb()` works.

Files:
- `config/schema.sql` — write fresh per SPEC §3.1:
  - `users` (identical to todos)
  - `fifos` (`id, user_id REFERENCES users(id), ulid, name, slug, position, seq, created_at, updated_at`)
  - `items` (`id, fifo_id REFERENCES fifos(id) ON DELETE CASCADE, ulid, position, status, data, locked_until, created_at, updated_at`)
  - `idempotency` (`fifo_id REFERENCES fifos(id) ON DELETE CASCADE, key, item_id REFERENCES items(id) ON DELETE CASCADE, created_at`, PK `(fifo_id, key)`)
  - All four indexes from §3.1
  - Cascading deletes (`ON DELETE CASCADE`) require `PRAGMA foreign_keys = ON` — enforced by `db.ts` below.
- `src/lib/db.ts` — copy from todos, swap path → `data/fifos.db`. `getDb()` runs schema.sql on first open **and** issues `PRAGMA foreign_keys = ON` on every connection (SQLite has FK enforcement off by default; without this, `ON DELETE CASCADE` is silently a no-op). Verify with `PRAGMA foreign_keys` returning `1`.
- `src/lib/ulid.ts` — copy verbatim.
- `src/lib/constants.ts` — copy & update env var names per SPEC §9.
- `src/lib/mode.ts` — copy verbatim (`isByLegendum()`, `isSelfHosted()`).

**Done when:** `bun -e 'import {getDb} from "./src/lib/db"; getDb()'` creates the db file with all tables.

---

## Phase 2 — Auth & Legendum (port verbatim)

**Goal:** login/logout/link works in both hosted and self-hosted mode.

Copy from `../todos/src`:
- `src/lib/auth.ts`
- `src/lib/legendum.js` + `legendum.d.ts` + `legendum.md`
- `src/lib/billing.ts` (will be customized in Phase 8)
- `src/api/handlers/auth.ts` — adjust `/t/` → `/f/` for legendum middleware mount (see SPEC §6.1)
- `src/api/handlers/settings.ts` — `GET /f/settings/me` returning `{ legendum_linked }`

**Done when:** `bun run dev`, hit `/auth/login` → Legendum flow works (or in self-hosted mode, returns local user).

---

## Phase 3 — Fifos CRUD handlers

**Goal:** `GET /`, `POST /`, `GET/PATCH/DELETE /:slug`, `PATCH /f/reorder`.

File: `src/api/handlers/fifos.ts` (port from `todos/src/api/handlers/lists.ts`, drop the `text` blob and undo/redo bits).

Routes per SPEC §6.2:

| Route | Notes |
|---|---|
| `GET /` | `SELECT … FROM fifos WHERE user_id=? ORDER BY position, id`. Build `counts` per row via grouped subquery on `items`. |
| `POST /` | Validate name; reject reserved slugs `f`, `w`; check `MAX_FIFOS_PER_USER`; allocate ULID; `position = COALESCE(MAX(position),-1)+1`; charge 2 cr (Phase 8); emit notify. |
| `GET /:slug` | Content-negotiated HTML / JSON / YAML; default status filter = `open`. |
| `PATCH /:slug` | Rename only — body `{ name }` required. Update `slug` from name (slugify same as todos), check uniqueness, `updated_at = now`. |
| `PATCH /f/reorder` | Body `{ order: [slug, …] }`. Loop `UPDATE fifos SET position=? WHERE user_id=? AND slug=?` like todos `reorderLists`. |
| `DELETE /:slug` | Cascade-delete via FK `ON DELETE CASCADE`. |

Wire into `src/api/server.ts`. Reserved slug list: `["f", "w", "auth"]`.

**SSE notify stub:** Phase 3 references "emit notify" on create/rename/reorder/delete, but `src/lib/sse.ts` doesn't exist yet (Phase 7). Add a stub at this point: `src/lib/sse.ts` exports `publish(scope, type, payload)` as a no-op (`export const publish = (..._: unknown[]) => {};`). Phase 7 fills in the body. This keeps Phase 3 importable without a forward-reference.

**Done when:** `curl -X POST localhost:3000/ -d '{"name":"test"}'` returns a fifo row with `slug`, `ulid`, `position`. `PATCH /f/reorder` reorders. `DELETE /:slug` cascades — items and idempotency rows go away.

---

## Phase 4 — Webhook write handlers (push/pop/pull/ack/nack)

**Goal:** the queue verbs work atomically.

File: `src/api/handlers/webhook.ts` + `src/lib/queue.ts` (new — keeps the SQL-heavy pop/pull/ack/nack out of the handler).

`src/lib/queue.ts` exports:

```ts
push(fifoId, ulid, data, idempotencyKey?)  → { id, position, created_at, deduped: bool }
pop(fifoId)                                 → Item | null  (status set to 'done')
pull(fifoId, lockSeconds)                   → Item | null  (status set to 'lock', locked_until set)
                                                            // lockSeconds: caller-supplied or env default;
                                                            // queue.ts clamps to [10, 3600]
ack(fifoId, itemUlid)                       → Item | null  (lock → done; null if not locked)
nack(fifoId, itemUlid)                      → Item | null  (lock → fail; null if not locked)
```

**Critical implementation rules** per SPEC:

- All five operations are wrapped in a single `db.transaction(() => …)` (SQLite's `BEGIN IMMEDIATE`).
- `pop`/`pull` first run the lock-reclaim from §5.3 (`UPDATE items SET status='open', locked_until=NULL WHERE fifo_id=? AND status='lock' AND locked_until < now`), **then** select oldest open item with `SELECT … ORDER BY position ASC LIMIT 1` and update it in the same tx.
- `pull` sets `locked_until = now + clamp(lockSeconds ?? FIFOS_LOCK_TIMEOUT_SECONDS, 10, 3600)`. The `?lock=<dur>` query param feeds `lockSeconds` after duration parsing (see helper below); missing/out-of-range/unparseable values are silently clamped (don't error).
- Add `src/lib/duration.ts` with `parseDuration(s: string): number | null` — accepts bare integers (seconds), and `<n>s`, `<n>m`, `<n>h`. Returns seconds or `null` for unparseable. The handler treats `null` as "no override". Used both server-side (query param) and client-side (CLI `--lock`) so the parsing is identical.
- `ack`/`nack` only check `status='lock'`; do **not** check `locked_until` (SPEC §2.3 stale-lock rule). They return `null` only if the row isn't `lock` anymore.
- `push` (in one tx):
  1. If `idempotencyKey` present, `SELECT item_id FROM idempotency WHERE fifo_id=? AND key=? AND created_at > now-3600`. Hit → load that item and return with `deduped: true` (skip the rest).
  2. Capacity check: `SELECT COUNT(*) FROM items WHERE fifo_id=?` ≥ `MAX_ITEMS_PER_FIFO` → run `pressurePurge(fifoId)` from §5.2 (100 oldest done, then 100 oldest fail). Re-check; if still at cap, return `null` and the handler returns 429.
  3. Allocate `position` via `UPDATE fifos SET seq=seq+1 RETURNING seq` (atomic).
  4. Insert item with that position.
  5. If `idempotencyKey`, `INSERT INTO idempotency (fifo_id, key, item_id, created_at)` with the new item's id. On unique-constraint error (concurrent loser), re-run the SELECT from step 1, roll back the insert, and return the winner's row.

Webhook routes (paths per SPEC §6.3, all `POST`):
- `/w/:ulid/push` — read body as text, max `MAX_ITEM_BYTES`. Status `201` for fresh, `200` for deduped.
- `/w/:ulid/pop` — `200` with item or `204`.
- `/w/:ulid/pull[?lock=<dur>]` — `200` with item + `locked_until` or `204`. `lock` accepts `600`, `300s`, `5m`, `1h`; parsed by `parseDuration` then fed to `pull(fifoId, lockSeconds)`.
- `/w/:ulid/ack/:id`, `/w/:ulid/nack/:id` — `200` or `404 not_locked`.

Webhook resolver helper: `getFifoByUlid(ulid)` → fifo + `user_id`. 404 if missing.

Charges (deferred — actual charging in Phase 8):

- Each webhook-write handler calls `chargeWebhookWrite(userId)` *after* successful work, except deduped push (free).

**Done when:**
- Push then pop returns the same body.
- Two concurrent pulls get different items (or the second gets 204).
- Pull → wait > 5 min → pull again on same fifo: first item is reclaimed and given again.
- Push twice with same `Idempotency-Key` returns the same `id` and second is `200`.
- `info` shows `4 done` after 4 pops.

---

## Phase 5 — Webhook read handlers + retry/status

**Goal:** `peek`, `info`, `list`, `retry`, `status`, content negotiation.

In `src/api/handlers/webhook.ts`:

| Route | SQL / behavior |
|---|---|
| `GET /w/:ulid/info` | Counts query (one grouped SELECT) + fifo row. Returns `{ name, slug, ulid, counts, total }`. |
| `GET /w/:ulid/peek?n=5` | `SELECT … WHERE fifo_id=? AND status='open' ORDER BY position ASC LIMIT n`. Default n=10, max 100. |
| `GET /w/:ulid/list/:status?n=5` | Same but parametric on status; `open`/`lock` ASC, `done`/`fail` DESC. |
| `GET /w/:ulid/status/:id` | `SELECT id, status, position, created_at, updated_at FROM items WHERE fifo_id=? AND ulid=?`. 404 if missing. Free. |
| `POST /w/:ulid/retry/:id` | In tx: load item by ulid; 404 if missing; 409 if status in `('open','lock')`; allocate new position via `seq`; `UPDATE items SET status='open', position=?, locked_until=NULL, updated_at=now WHERE id=?`. Charge 0.01. Emit `change` SSE event. |

Content negotiation helper: read `Accept` header and `.json`/`.yaml` URL suffixes. Use `yaml` lib (already a Bun-supported dep, or add).

**Done when:** all the read endpoints round-trip correctly; `retry` on a `done` item flips it back to `open` at the tail.

---

## Phase 6 — Purger

**Goal:** retention sweep + capacity-pressure purge.

File: `src/lib/purge.ts`.

Functions:
- `sweepRetention()` — runs the two `DELETE` queries from SPEC §5.1, batched 100 rows. Loops until both queries return 0 rows. Logs counts.
- `pressurePurge(fifoId)` — runs the §5.2 sequence: 100 oldest done → 100 oldest fail. Returns `true` if it freed any space.

Started in `server.ts`:

```ts
setInterval(sweepRetention, FIFOS_PURGE_INTERVAL_SECONDS * 1000);
sweepRetention();   // run once on boot
```

`pressurePurge` is called from the push handler (Phase 4) before returning `fifo_full`.

**Done when:** seed 11 items, mark 5 done, set their `updated_at` 8 days ago, run sweep, expect 5 deletions. Idempotency rows older than 1h gone after sweep.

---

## Phase 7 — SSE

**Goal:** `/w/:ulid/items` and `/f/fifos/items` with `Last-Event-ID` resilience.

File: `src/lib/sse.ts`.

Design:
- Per-fifo and per-user **in-memory** ring buffers, capped at 200 events each (SPEC §6.5). Map keys: `fifo:${fifoId}` and `user:${userId}`.
- Each SSE message has a monotonic `id` from a per-process counter starting at 1. Resets on server restart; clients receiving an `id` lower than their `Last-Event-ID` get one `event: resync` and refetch. (SPEC §6.5 already specifies this.)
- On client connect, read `Last-Event-ID` header. If `id <= ringHead && id >= ringTail`, replay tail. Else emit one `event: resync` and resume live.
- 25s `: keep-alive\n\n` interval per connection.
- Bun.serve SSE pattern: return `Response` with a `ReadableStream`. Track open writers in a `Set` keyed per buffer.

API:

```ts
publish(scope: string, type: 'push'|'change'|'purge', payload: object): void
subscribe(scope: string, lastEventId: string | null): Response  // SSE stream
```

Hook points:
- `queue.push()` → `publish("fifo:<id>", "push", {…})` and `publish("user:<uid>", "fifos", { fifos })`
- `queue.pop/pull/ack/nack/retry` → `publish("fifo:<id>", "change", {…})` + user-stream update
- `purger` → `publish("fifo:<id>", "purge", { deleted })` + user-stream update
- `fifos rename / reorder / create / delete` → user-stream only

User-stream coalescing: a busy fifo (many pushes per second) shouldn't spam the user-stream with 100 `fifos` events. Coalesce: when a `fifos` event is queued for a user, set a 250 ms timer; subsequent events within the window collapse into one. Only the latest snapshot (full `GET /` payload) is emitted. Per-fifo stream is **not** coalesced — it's the source of truth for `pop --block` and needs immediate delivery.

Routes:
- `GET /w/:ulid/items` → resolves fifo, returns SSE for `fifo:<fifoId>`.
- `GET /f/fifos/items` → session-auth, returns SSE for `user:<userId>`. Initial event: full `GET /` payload.

**Done when:**
- Open SSE, push from another shell, see `event: push` arrive.
- Disconnect, push 3 items, reconnect with `Last-Event-ID` = pre-disconnect id → see all 3 events replayed.
- Reconnect with stale id past ring → get `resync`.

---

## Phase 8 — Billing wiring

**Goal:** charges flow through Legendum tabs in hosted mode; no-op in self-hosted.

In `src/lib/billing.ts` (port from todos):
- `chargeFifoCreate(userId)` — 2 cr.
- `chargeWebhookWrite(userId)` — 0.01 cr.
- Both no-op when `isSelfHosted()`.
- Tab threshold = 2 cr (same as todos).
- 402 if user has no `legendum_token`; 429 on settle failure.

Wire into:
- `POST /` (Phase 3)
- All `/w/:ulid/{push,pop,pull,ack,nack,retry}` (Phase 4 & 5) — but **skip** the charge on a deduped idempotent push.

**Done when:** in hosted mode with a linked Legendum, creating a fifo + 200 pushes settles a single ~4-credit charge. In self-hosted, no Legendum calls.

---

## Phase 9 — CLI

**Goal:** the `fifos` command with all subcommands from SPEC §2.4.

File: `src/cli/main.ts`. Single-file argv parser (no commander/yargs — todos doesn't use them).

Order of work inside the file:

1. **Bootstrap & config**: load `.env`; resolve webhook URL via `-f <ulid|url>` → `FIFOS_WEBHOOK` → first-run TTY prompt. Implement the URL canonicalization (bare ULID → `${FIFOS_DOMAIN:-https://fifos.dev}/w/<ulid>`). Default subcommand (`fifos` with no args) is `info` — but on first run, when no webhook is resolved, prompt the user, save to `.env`, then run `info`. Non-TTY (no stdin attached): exit 2 with the "FIFOS_WEBHOOK not set" message instead of prompting.
2. **HTTP helper**: `request(method, path, { body?, headers? })` returning `{ status, body, headers }`. Maps 4xx/5xx/network → exit code 2 with stderr message.
3. **Subcommand dispatch** — exact-match keywords. Default = `info`.
4. **Commands** (one function each):
   - `push` (arg or stdin = body; `--key` → `Idempotency-Key` header)
   - `pop`, `pop --block [--timeout N]` (uses SSE — see below)
   - `pull [--lock <dur>]` → write `.fifos-lock`. `--lock` value (e.g. `600`, `5m`, `1h`) is passed through verbatim as `?lock=<dur>` on the URL — server does the parsing/clamping. CLI doesn't need to validate.
   - `ack`, `nack` → read `.fifos-lock`, delete on success
   - `status <id>`, `retry <id>`
   - `peek [--items=N]`, `info`, `list <status> [--items=N]` — all support `--json`/`--yaml`
   - `open` — fetch `/info`, build `${FIFOS_DOMAIN}/<slug>`, exec `open` (macOS) / `xdg-open` (linux)
   - `skill` — copy `config/SKILL.md` to `~/.claude/skills/fifos/SKILL.md` and `~/.cursor/skills/fifos/SKILL.md`
   - `help`

5. **Pop --block implementation**: open `EventSource(`${baseUrl}/items`)` (Bun has it). On `event: push`, immediately call `pop`. If `pop` returns 204 (someone else got it first), keep listening. Honor `--timeout` via `setTimeout` that closes the stream and exits 1.

6. **Exit codes**: 0 / 1 / 2 per SPEC §2.4. Document in `--help`.

7. **Output formatting**:
   - Plain text by default (one item body per line for pop; pretty key:value for info).
   - `--json` and `--yaml` switch on `info`/`peek`/`list`.

**Done when:** in a fresh project, `bun link` then `fifos push hello && fifos pop` round-trips. `fifos pull` writes `.fifos-lock`; `fifos ack` clears it. `fifos pop --block --timeout 10` blocks then exits 1.

---

## Phase 10 — Frontend layout & home screen

**Goal:** mobile-first PWA shell with login + fifos list.

Copy `src/web/{App.tsx, entry.tsx, components/}` from todos as starting point. Strip undo/redo, todos list rendering, drag-handle for items.

Screens:

1. **Login** — same as todos (Legendum redirect).
2. **Fifos home** (§10.1):
   - Top bar: logo (click → install dialog with CLI install instructions), Legendum link/unlink widget.
   - List of fifos from `GET /`, ordered by position. Subscribe to `GET /f/fifos/items` for live updates.
   - Drag-and-drop with `@dnd-kit` (port the todos pattern). On drag-end, `PATCH /f/reorder` with the new slug order.
   - `+` button → name prompt → `POST /`.
   - Swipe-left → Delete (`DELETE /:slug`).
   - Tap a row → fifo detail.

**Done when:** can log in, create 3 fifos, drag-reorder them, delete one.

---

## Phase 11 — Frontend fifo detail

**Goal:** items with status filter and live updates.

§10.2 in SPEC.

- Header: fifo name, copy-webhook button (same affordance as todos copy-list-URL).
- Status filter chips: `open` | `lock` | `done` | `fail`, with counts. Active = `open` by default.
- Items: fetch `GET /:slug?status=<chip>` (or content-negotiated JSON of /:slug filtered).
- Each row: truncated body (tap to expand modal), position, status pill, age (relative time).
- `+` button → modal with `<textarea>` → `POST /w/:ulid/push` (UI calls the public webhook URL directly, knowing the ULID from the fifo row data). This is billed at the standard 0.01 cr per push, same as any external client — no owner discount, no new route.
- Subscribe to `GET /w/:ulid/items` for live item updates.
- No drag, no item delete in v1 (queue is queue).

**Done when:** push from CLI → see it appear live in the UI. Pop in UI → see status change in another tab.

---

## Phase 12 — PWA & service worker

Copy todos' build pipeline:
- `scripts/build.ts` — clean `public/dist`, `Bun.build`, run `workbox-build generateSW`.
- SW config: `cacheId` = `package.json` version, `skipWaiting`, `clientsClaim`, `cleanupOutdatedCaches`, `navigateFallback: "/index.html"`.
- Page registers SW with `updateViaCache: "none"`, reloads on `controllerchange`.
- `public/manifest.webmanifest` linked from `index.html`; icons `fifos-192.png` (192) and `fifos-512.png` (512, `purpose: "any maskable"`).

**Done when:** `bun run build` produces a content-hashed bundle and a working SW; PWA installs.

---

## Phase 13 — Agent skill

File: `config/SKILL.md` — short markdown teaching agents how to use the CLI. Skeleton:

```markdown
# Fifos

Use the `fifos` CLI to push/pop work items on a FIFO queue.

## Setup
- Each project's queue is configured by `FIFOS_WEBHOOK` in `.env`.
- For multi-queue services, pass `-f <ulid|url>` per command instead.

## Verbs
- `fifos push "data"` — append an item. Use `--key <id>` for retry-safe pushes.
- `fifos pop` — fire-and-forget consume (item → done).
- `fifos pull [--lock 5m]` — at-least-once consume (item → lock). Then `fifos ack` on success or `fifos nack` on failure. Default lock is 5 min; extend up to 1h if your work needs longer.
- `fifos status <id>` — check whether a previously-pushed item has been processed.
- `fifos retry <id>` — resubmit a done/fail item without re-pushing.
- `fifos info` / `fifos list <open|lock|done|fail>` — inspect the queue.

## When to use what
- Pushing background work: `push` (with `--key` if retrying).
- Consuming work an agent does: `pull` + `ack`/`nack` (so a crash returns the item to the queue).
- Just draining a queue without crash safety: `pop`.

## Exit codes
- 0 = got an item / action succeeded
- 1 = empty queue / not found / `--block --timeout` expired
- 2 = error (network, auth, invalid usage)
```

`fifos skill` command (in CLI Phase 9) copies it to:
- `~/.claude/skills/fifos/SKILL.md`
- `~/.cursor/skills/fifos/SKILL.md`

**Done when:** `fifos skill` succeeds and the file appears in both target dirs.

---

## Phase 14 — Tests, smoke, polish

Tests in `tests/` (port the todos test harness):

- `tests/auth.test.ts` — Legendum login/callback/logout; self-hosted local-user fallback.
- `tests/fifos.test.ts` — `GET/POST/PATCH/DELETE /:slug`, `PATCH /f/reorder`, reserved-slug rejection, `MAX_FIFOS_PER_USER` enforcement, cascade-delete (items + idempotency rows go too).
- `tests/queue.test.ts` — push/pop/pull/ack/nack atomicity; stale-lock ack succeeds; lock reclaim; lock-TTL clamp `[10, 3600]`; retry id reuse + tail position; idempotency dedup including the unique-constraint loser case.
- `tests/sse.test.ts` — `Last-Event-ID` replay; counter monotonicity; resync on stale id; resync on server restart (counter reset); 25s keep-alive frame.
- `tests/billing.test.ts` — charge totals; deduped push is free; self-hosted is free; web-UI push (via webhook URL with session) charges normally.
- `tests/cli.test.ts` — exit codes 0/1/2; `-f <ulid>` and `-f <url>` both work; `.fifos-lock` lifecycle (write on pull, delete on ack/nack); `--lock` durations parsed; `pop --block --timeout` exits 1 cleanly.
- `tests/purge.test.ts` — time-based retention sweep; idempotency-row sweep (>1h); pressure purge ordering (done before fail); pressure purge does not touch `open` or `lock`.

`bun run smoke` = lint + test + build (matches todos).

**Done when:** `bun run smoke` is green.

---

## Sequencing notes

- Phases 1–3 are **strictly sequential** (each depends on the prior).
- Phases 4 and 5 can be done together; 6 and 7 can run in parallel after 5.
- Phase 8 plugs into 3, 4, 5 — best done after 5 (so all charge sites exist).
- Phases 9 (CLI) and 10–12 (frontend) are independent and can be parallelized.
- Phase 13 is trivial; 14 is continuous (write tests as you go in 4–8).

## Decisions captured (no longer ambiguous)

- **SSE message id** — per-process monotonic counter; ring buffer holds last 200; reset on restart; client gets `resync` on stale or pre-counter ids. (SPEC §6.5.)
- **UI push** — web UI calls `POST /w/:ulid/push` directly, billed at the standard rate. No owner-only push route. (SPEC §7.)
- **Charging** — every webhook write is charged regardless of caller; only an idempotency-key hit within 1h is free.
