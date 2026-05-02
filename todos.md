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

- [ ] `src/lib/{auth,legendum.js,legendum.d.ts,legendum.md,billing}.ts`
- [ ] `src/api/handlers/{auth,settings}.ts` — `/t/`→`/f/`
- [ ] `GET /f/settings/me` → `{ legendum_linked }`

### Phase 3 — Fifos CRUD handlers

- [ ] `src/api/handlers/fifos.ts` — `GET/POST /`, `GET/PATCH/DELETE /:slug`, `PATCH /f/reorder`
- [ ] Reserved slugs `[f, w, auth]`
- [ ] `src/lib/sse.ts` no-op stub
- [ ] Wired into `src/api/server.ts`

### Phase 4 — Webhook write handlers

- [ ] `src/lib/queue.ts` — `push/pop/pull/ack/nack` atomic; lock reclaim
- [ ] `src/api/handlers/webhook.ts` — `/w/:ulid/{push,pop,pull,ack,nack}`
- [ ] Idempotency dedupe with concurrent-loser handling

### Phase 5 — Webhook read + retry/status

- [ ] `/w/:ulid/{info,peek,list/:status,status/:id,retry/:id}`
- [ ] Content negotiation (Accept + `.json`/`.yaml` suffixes)

### Phase 6 — Purger

- [ ] `src/lib/purge.ts` — `sweepRetention()`, `pressurePurge(fifoId)`
- [ ] `setInterval(sweepRetention, …)` wired in `server.ts`
- [ ] `pressurePurge` called from `push` before 429

## Open questions

- Do we want to copy `src/lib/legendum.md` verbatim or write a fifos-specific version? (Defaulting to verbatim copy.)
