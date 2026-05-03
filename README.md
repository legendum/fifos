# Fifos

**FIFO queues with a CLI, a webhook API, and a mobile-first PWA.** Self-hostable; hosted at [fifos.dev](https://fifos.dev).

Each queue has its own unguessable webhook URL. Items go through `todo → lock → done | fail | skip`, with at-least-once consumption (`pull` + `done`/`fail`/`skip`), idempotent pushes, server-side retention, and live SSE updates. `fail` is retryable; `skip` is terminal.

## Install

```bash
git clone <repo-url> fifos
cd fifos
bun install
bun link            # makes the `fifos` CLI globally available
```

Run the server (self-hosted, single local user):

```bash
bun run dev         # hot-reload, http://localhost:3000
# or:
bun run start       # build + serve
```

Hosted mode kicks in automatically when `LEGENDUM_API_KEY` is set — see `docs/SPEC.md` §8 for billing.

## Configure the CLI

The CLI is stateless. Each project's queue is configured via `FIFOS_WEBHOOK` in its `.env`:

```env
FIFOS_WEBHOOK=http://localhost:3000/w/01HKZ8M3RT9PDXVJ1Q4F2BXY7C
```

First-run prompts for it interactively if missing. Override per-call with `-f <ulid|url>`:

```bash
fifos -f 01HKZ8M3RT9PDXVJ1Q4F2BXY7C push "hello"
fifos -f http://localhost:3000/w/01HKZ8M3RT9PDXVJ1Q4F2BXY7C info
```

## CLI verbs

| Verb | What |
|---|---|
| `fifos push "<data>"` | Append an item. Pipe stdin for multi-line bodies. `--key <s>` for idempotent retries (1h dedupe window). |
| `fifos pop` | Fire-and-forget consume (item → `done`). Exit 1 on empty. |
| `fifos pop --block [--timeout N]` | Wait via SSE for the next push, then pop. Exit 1 on timeout. |
| `fifos pull [--lock 5m]` | At-least-once consume (item → `lock`); writes `.fifos-lock` in cwd. Lock TTL clamped to `[10s, 1h]`. |
| `fifos done` | Mark the locked item `done`; clears `.fifos-lock`. |
| `fifos fail [reason words...]` | Mark it `fail` (retryable); positional args (or stdin) become the diagnostic reason (max 1 KiB). |
| `fifos skip [reason words...]` | Mark it `skip` (terminal — `retry` refuses); same reason rules as `fail`. |
| `fifos status <id>` | One item's state, including `fail_reason`. |
| `fifos retry <id>` | Move a `done`/`fail` item back to `todo` at the tail; same id, `fail_reason` cleared. Refuses `skip`. |
| `fifos peek [--items N]` | Up to N oldest `todo` items, no status change. |
| `fifos list <todo\|lock\|done\|fail\|skip>` | List items. `done`/`fail`/`skip` come back newest-first; `todo`/`lock` oldest-first. |
| `fifos list fail --reason <substr>` | Filter failed items by case-insensitive substring of `fail_reason`. |
| `fifos list skip --reason <substr>` | Filter skipped items by case-insensitive substring of `skip_reason`. |
| `fifos info` | Counts summary. |
| `fifos open` | Open this fifo's web page in the browser. |
| `fifos skill` | Install the agent skill at `~/.claude/skills/fifos/` and `~/.cursor/skills/fifos/`. |

`--json` / `--yaml` work on `info`, `peek`, `list`, `status`.

### Exit codes

- `0` — success / got an item
- `1` — empty queue, not found, or `--block --timeout` expired
- `2` — error (network, invalid usage, server-side rejection)

## Webhook API

Every queue has a public, unguessable webhook URL — `POST` verbs are authenticated by ID alone, no token needed.

| Method + path | Notes |
|---|---|
| `POST /w/:ulid/push` | Body = item. Optional `Idempotency-Key: <s>`. |
| `POST /w/:ulid/pop` | Atomic todo → done. `204` if empty. |
| `POST /w/:ulid/pull?lock=5m` | Atomic todo → lock. `204` if empty. |
| `POST /w/:ulid/done/:id` | Lock → done. |
| `POST /w/:ulid/fail/:id` | Lock → fail (retryable). Optional `text/plain` body = reason (max 1 KiB). |
| `POST /w/:ulid/skip/:id` | Lock → skip (terminal). Same body contract as `fail`. |
| `POST /w/:ulid/retry/:id` | Done/fail → todo at the tail (same id). Refuses `skip`. |
| `GET /w/:ulid/info` | Counts + summary. |
| `GET /w/:ulid/peek?n=10` | Up to N oldest todo items. |
| `GET /w/:ulid/list/:status?n=10[&reason=<substr>]` | List by status. `reason` only honored for `fail`. |
| `GET /w/:ulid/status/:id` | One item. |
| `GET /w/:ulid/items` | SSE stream — `push` / `change` / `purge` events with `Last-Event-ID` replay. |

JSON is the default; append `.yaml` (or `Accept: application/yaml`) for YAML.

### Item shape

```json
{
  "id": "01HKZ8M3RT9PDXVJ1Q4F2BXY7C",
  "position": 142,
  "status": "fail",
  "data": "process payment for invoice #4421",
  "locked_until": null,
  "fail_reason": "OOM: ran out of memory",
  "skip_reason": null,
  "created_at": 1746278400,
  "updated_at": 1746278465
}
```

`fail_reason` is set only when `status="fail"`. `skip_reason` is set only when `status="skip"`. `locked_until` is `null` unless `status="lock"`. Timestamps are unix seconds.

## State machine

```
       push                  pop
 ───────────────► todo ────────────► done
                  │                   ▲
              pull│              retry│
                  ▼                   │
                lock ──── done ───────┘
                  │
                  ├─── fail ──► fail ── retry ──► todo
                  │
                  └─── skip ──► skip   (terminal)
```

A `lock` whose `locked_until` has passed is reclaimed back to `todo` on the next interaction with the queue (lazy reclaim). `done`, `fail`, and `skip` items are reaped by a background sweeper after `FIFOS_RETENTION_SECONDS` (default 1 week) or by capacity-pressure purge on push.

## Web UI

Mobile-first PWA at `/`. Drag to reorder fifos, swipe-left to delete, tap to drill into items, filter by status, watch updates land live over SSE. Logo click opens an install dialog with the CLI install command.

## Agent integration

`fifos skill` writes a Claude/Cursor skill file (`config/SKILL.md`) into the relevant skills dir so an agent can use the CLI without prompting. The pattern is:

- `pull` work → do it → `done` on success, `fail "<reason>"` for retryable failure, `skip "<reason>"` for malformed/unsupported items (terminal).
- `list fail --reason <substr>` to triage; `retry <id>` to re-queue. `list skip --reason <substr>` for permanent rejects.
- `pop --block --timeout 60` for long-poll workers.

## Docs

- `docs/SPEC.md` — full API + schema + UX spec (source of truth).
- `docs/PLAN.md` — phased build plan.
- `config/SKILL.md` — agent skill content.

## Stack

Bun + SQLite (WAL, FK on) + React 18 (no build framework, hand-rolled `Bun.build`) + workbox-build SW. Single-process; SSE replay via in-memory ring. Zero runtime deps beyond `@dnd-kit`, `react`, `yaml`, and `workbox-build`.
