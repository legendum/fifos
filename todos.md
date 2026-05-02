# Fifos — v1 build

**Intent:** ship the server-side core of fifos through Phase 6 of `docs/PLAN.md`, committing per phase. CLI + frontend + tests come after.

## Context

- Plan: `docs/PLAN.md` (14 phases). Spec: `docs/SPEC.md`.
- Template repo: `/Volumes/Code/todos` — port verbatim where the plan says so, swap `todos→fifos`, `lists→fifos`, `/t/→/f/`.
- Stopping point this session: **end of Phase 6** (server core: DB, auth, fifos CRUD, queue, purger). Stretch into Phase 7+ only if tokens permit.

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
- [ ] (Deferred) `purge` SSE events — time-based sweep doesn't track per-fifo affected; UI will reload via the next user-stream event. Acceptable for v1.

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

## Open questions

- Do we want to copy `src/lib/legendum.md` verbatim or write a fifos-specific version? (Defaulting to verbatim copy.)
