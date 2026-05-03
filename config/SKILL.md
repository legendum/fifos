# Fifos

Use the `fifos` CLI to push/pop work items on a FIFO queue.

## Setup
- Each project's queue is configured by `FIFOS_WEBHOOK` in `.env`.
- For multi-queue services, pass `-f <ulid|url>` per command instead.

## Verbs
- `fifos push "data"` — append an item. Use `--key <id>` for retry-safe pushes.
- `fifos pop` — fire-and-forget consume (item → done).
- `fifos pop --block [--timeout 60]` — wait via SSE until something is pushed, then pop. Exits 1 cleanly on timeout.
- `fifos pull [--lock 30m]` — at-least-once consume (item → lock). Then `fifos done` on success, `fifos fail [reason...]` for retryable failure, or `fifos skip [reason...]` for terminal rejection (malformed/unsupported). Default lock is 30 min; extend up to 1h if your work needs longer.
- `fifos fail [reason...]` — fail the locked item (retryable); positional args (or stdin) become the diagnostic reason (max 1 KiB), stored on the item and shown in the GUI / `list fail` output.
- `fifos skip [reason...]` — skip the locked item (terminal — `retry` refuses). Use for permanent rejections: malformed payload, unsupported version, deprecated job kind. Same reason rules as `fail`.
- `fifos status <id>` — check whether a previously-pushed item has been processed. Includes `fail_reason` / `skip_reason` on failed/skipped items.
- `fifos retry <id>` — resubmit a done/fail item to the tail (clears `fail_reason`). Refuses `skip` (terminal).
- `fifos info` / `fifos peek` / `fifos list <todo|lock|done|fail|skip>` — inspect the queue. `done`/`fail`/`skip` come back newest-first; `todo`/`lock` oldest-first. Add `--json` or `--yaml` for machine-readable output.
- `fifos list fail --reason <substr>` / `fifos list skip --reason <substr>` — filter by case-insensitive substring of `fail_reason` / `skip_reason` (e.g. `--reason oom`).

## When to use what
- Pushing background work: `push` (with `--key` if retrying).
- Consuming work an agent does: `pull` + `done`/`fail`/`skip` (so a crash returns the item to the queue). Pass a short reason on `fail`/`skip` so they're triageable later. Use `fail` when retry might succeed (transient errors); use `skip` when the item itself is bad (malformed, deprecated).
- Just draining a queue without crash safety: `pop`.
- Triaging recent failures: `fifos list fail` (newest-first), then `fifos retry <id>` for the ones worth re-running.

## Exit codes
- 0 = got an item / action succeeded
- 1 = empty queue / not found / `--block --timeout` expired
- 2 = error (network, auth, invalid usage)
