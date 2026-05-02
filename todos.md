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

## Open questions

- Do we want to copy `src/lib/legendum.md` verbatim or write a fifos-specific version? (Defaulting to verbatim copy.)
