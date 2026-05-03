# Fifos — v1 build

**Intent:** ship fifos v1 through all 14 phases of `docs/PLAN.md`, committing per phase.

## Context

- Plan: `docs/PLAN.md` (14 phases). Spec: `docs/SPEC.md`.
- Template repo: `/Volumes/Code/todos` — port verbatim where the plan says so, swap `todos→fifos`, `lists→fifos`, `/t/→/f/`.
- Done: Phases 0–9 (server-side core + CLI) and Phase 13 (agent skill).
- Remaining: Phases 10–12 (frontend home, fifo detail, PWA build) and Phase 14 (tests). Working phase by phase.

## Constraints

- Commit after each phase so we can rewind cleanly.
- Don't add features beyond what the plan calls for.
- Keep `docs/SPEC.md` and `docs/PLAN.md` as the source of truth — update them if we deviate.

## Plan

### Phase 0 — Repo bootstrap

- [x] package.json / biome.json / tsconfig.json / .gitignore / .env.example
- [x] `bun install` clean
- [x] `bun run lint` green

### Phase 1 — Schema & DB helpers

- [x] `config/schema.sql` (already present — verify against SPEC §3.1)
- [x] `src/lib/{db,ulid,constants,mode}.ts` ported from todos
- [x] `getDb()` opens db with `PRAGMA foreign_keys = ON`

### Phase 2 — Auth & Legendum (verbatim port)

- [x] `src/lib/{auth,legendum.js,legendum.d.ts,legendum.md,billing}.ts`
- [x] `src/api/handlers/{auth,settings}.ts` — `/t/`→`/f/`
- [x] `GET /f/settings/me` → `{ legendum_linked }`

### Phase 3 — Fifos CRUD handlers

- [x] `src/api/handlers/fifos.ts` — `GET/POST /`, `GET/PATCH/DELETE /:slug`, `PATCH /f/reorder`
- [x] Reserved slugs `[f, w, auth]`
- [x] `src/lib/sse.ts` no-op stub
- [x] Wired into `src/api/server.ts`

### Phase 4 — Webhook write handlers

- [x] `src/lib/queue.ts` — `push/pop/pull/ack/nack` atomic; lock reclaim
- [x] `src/api/handlers/webhook.ts` — `/w/:ulid/{push,pop,pull,ack,nack}`
- [x] Idempotency dedupe with concurrent-loser handling

### Phase 5 — Webhook read + retry/status

- [x] `/w/:ulid/{info,peek,list/:status,status/:id,retry/:id}`
- [x] Content negotiation (Accept + `.json`/`.yaml` suffixes)

### Phase 6 — Purger

- [x] `src/lib/purge.ts` — `sweepRetention()`, `pressurePurge(fifoId)`
- [x] `setInterval(sweepRetention, …)` wired in `server.ts`
- [x] `pressurePurge` called from `push` before 429

### Phase 7 — SSE

- [x] `src/lib/sse.ts` — per-scope ring buffers (200 events), monotonic id, replay + resync, 25s keep-alive
- [x] `publishUserFifos(userId, computePayload)` — 250ms coalescing; per-fifo stream stays uncoalesced
- [x] `GET /w/:ulid/items` (public) and `GET /f/fifos/items` (auth, initial snapshot)
- [x] Verified: push/change events arrive live; `Last-Event-ID` replays gap; stale id → `resync`; 5-push burst → 1 coalesced `fifos` event
- [x] `purge` SSE events from both `pressurePurge` (push tx) and `sweepRetention` (timer); per-fifo `purge` event with `{deleted:{done,fail}}` plus a coalesced per-user `fifos` snapshot

### Phase 8 — Billing wiring

- [x] `chargeFifoCreate(userId)` (2 cr) at `POST /` (Phase 3 already had it)
- [x] `chargeWebhookWrite(userId)` (0.01 cr via tab) at all 6 webhook writes — `push/pop/pull/ack/nack/retry`
- [x] Deduped push is free; self-hosted is free
- [x] `closeTabs()` on `SIGTERM`/`SIGINT`
- Note: phase 8 was effectively done as we built phases 3–5; this entry is bookkeeping.

### Phase 9 — CLI

- [x] `src/cli/main.ts` — single-file argv parser, no commander/yargs
- [x] Webhook URL resolution: `-f <ulid|url>` → `FIFOS_WEBHOOK` from `.env` → first-run TTY prompt → exit 2
- [x] Bare ULID canonicalized to `${FIFOS_DOMAIN:-https://fifos.in}/w/<ulid>`
- [x] Verbs: `push` (arg/stdin/`--key`), `pop`, `pop --block [--timeout]`, `pull [--lock]`, `ack`, `nack`, `status <id>`, `retry <id>`, `peek`, `info`, `list <status>`, `open`, `skill`, `help` (default = `info`)
- [x] `--json` / `--yaml` on `info`/`peek`/`list`/`status`
- [x] `.fifos-lock` written on `pull`, deleted on `ack`/`nack` (and on stale-lock 404)
- [x] Exit codes 0/1/2 verified (empty queue, network ok, timeouts)

### Phase 13 — Agent skill

- [x] `config/SKILL.md` written
- [x] `fifos skill` copies it to `~/.claude/skills/fifos/` and `~/.cursor/skills/fifos/`

### Phase 10 — Frontend home (not started)

- [ ] Port `src/web/{App.tsx, entry.tsx, components/}` from todos; strip undo/redo + item-level UI
- [ ] Login screen (Legendum redirect)
- [ ] Fifos home: list from `GET /`, drag-reorder via `@dnd-kit` → `PATCH /f/reorder`, `+` create, swipe-left delete
- [ ] Subscribe to `GET /f/fifos/items` for live updates
- [ ] Settings: log out, Legendum link/unlink

### Phase 11 — Frontend fifo detail (not started)

- [ ] Header with copy-webhook button
- [ ] Status filter chips (open/lock/done/fail) with counts
- [ ] Items list (truncated body, position, status pill, age)
- [ ] `+` modal posts to `/w/:ulid/push`
- [ ] Subscribe to `GET /w/:ulid/items`

### Phase 12 — PWA & service worker (not started)

- [ ] `scripts/build.ts` (Bun.build + workbox-build generateSW)
- [ ] SW config with cacheId from package.json version
- [ ] `public/manifest.webmanifest` + icons (192, 512 maskable)

### Phase 14 — Tests, smoke, polish (in progress)

- [ ] `tests/auth.test.ts`
- [x] `tests/fifos.test.ts` — CRUD, reserved slugs, rename + collision, reorder, MAX cap, cascade-delete
- [x] `tests/queue.test.ts` — push/pop/pull/ack/nack atomicity, idempotency, stale-lock, lazy reclaim, lock TTL clamp, retry, capacity + pressure-purge
- [ ] `tests/sse.test.ts` (replay, resync, keep-alive)
- [ ] `tests/billing.test.ts`
- [ ] `tests/cli.test.ts` (exit codes, lock lifecycle, --block timeout)
- [ ] `tests/purge.test.ts`
- [ ] `bun run smoke` green

