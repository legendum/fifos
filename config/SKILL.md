# Fifos

Use the `fifos` CLI to push/pop/pull work items on a FIFO queue.

## Setup
- Put `FIFOS_WEBHOOK` in `.env` in your project folder. The CLI only reads `.env` from the current working directory (no walk up). You can use the fifo ULID or the canonical webhook URL (`https://…/w/<ulid>`). Override the default fifo per command with `-f <ulid>` (host comes from `FIFOS_DOMAIN`, default `https://fifos.dev`).
- First-time interactive setup (TTY, no `-f` / no `.env`): prompted with `Enter your fifo ULID:` — the CLI writes the webhook URL to `.env`.

## Verbs
- `fifos push "data"` — append an item (or pipe via stdin). Use `--key <id>` for retry-safe pushes; the dedupe window is 1 h, after which the same key creates a new item.
- `fifos pop` — fire-and-forget consume (item → done).
- `fifos pop --block [--timeout 60]` — wait via SSE until something is pushed, then pop. Exits 1 cleanly on timeout.
- `fifos pull [--lock 1h]` — at-least-once consume (item → lock). Writes `.fifos-lock` in cwd holding the item id; a second `pull` while that file exists exits 2 — finalize or delete it first. Then `fifos done [reason...]` on success, `fifos fail [reason...]` for retryable failure, or `fifos skip [reason...]` for terminal rejection (malformed/unsupported), all from the same cwd. Default lock is 30 min; extend up to 1h if your work needs longer.
- `fifos pull --block [--timeout 60]` — same as `pop --block` but uses the at-least-once `pull` semantics; ideal for long-running agent daemons.
- `fifos done [reason...]` — mark the locked item done. Optional one-line reason (positional args or stdin, max 1 KiB) is stored on the item — useful as agent metadata for triage (e.g. `fifos done "cached hit"`, `fifos done "3 turns, 1.2k tokens"`).
- `fifos fail [reason...]` — fail the locked item (retryable); diagnostic reason stored on the item.
- `fifos skip [reason...]` — skip the locked item (terminal — `retry` refuses). Use for permanent rejections: malformed payload, unsupported version, deprecated job kind. Same reason rules as `fail`.
- `fifos status <id>` — check whether a previously-pushed item has been processed. Includes the `reason` field (set on done/fail/skip).
- `fifos retry <id>` — resubmit a done/fail item to the tail (clears `reason`). Refuses `skip` (terminal).
- `fifos info` / `fifos peek` / `fifos list <todo|lock|done|fail|skip>` — inspect the queue. `done`/`fail`/`skip` come back newest-first; `todo`/`lock` oldest-first. Use `--items=N` on `peek`/`list` to fetch more than the default. Add `--json` or `--yaml` for machine-readable output.
- `fifos list <done|fail|skip> --reason <substr>` — filter terminal items by case-insensitive substring of `reason` (e.g. `--reason oom`).

## When to use what
- Pushing background work: `push` (with `--key` if retrying).
- Consuming work an agent does: `pull` + `done`/`fail`/`skip` (so a crash returns the item to the queue). Pass a short reason on `fail`/`skip` so they're triageable later. Use `fail` when retry might succeed (transient errors); use `skip` when the item itself is bad (malformed, deprecated).
- Just draining a queue without crash safety: `pop`.
- Triaging recent failures: `fifos list fail` (newest-first), then `fifos retry <id>` for the ones worth re-running.

## Exit codes
- 0 = got an item / action succeeded
- 1 = empty queue / not found / `--block --timeout` expired / lock TTL expired on `done`|`fail`|`skip` (`.fifos-lock` is auto-cleared — re-`pull`)
- 2 = error (network, auth, invalid usage; e.g. no `.fifos-lock` in cwd when finalizing, or a second `pull` while one exists)
