# Fifos

Use the `fifos` CLI to push/pop work items on a FIFO queue.

## Setup
- Each project's queue is configured by `FIFOS_WEBHOOK` in `.env`.
- For multi-queue services, pass `-f <id|url>` per command instead.

## Verbs
- `fifos push "data"` — append an item. Use `--key <id>` for retry-safe pushes.
- `fifos pop` — fire-and-forget consume (item → done).
- `fifos pop --block [--timeout 60]` — wait via SSE until something is pushed, then pop. Exits 1 cleanly on timeout.
- `fifos pull [--lock 5m]` — at-least-once consume (item → lock). Then `fifos ack` on success or `fifos nack [reason...]` on failure. Default lock is 5 min; extend up to 1h if your work needs longer.
- `fifos nack [reason...]` — fail the locked item; positional args (or stdin) become the diagnostic reason (max 1 KiB), stored on the item and shown in the GUI / `list fail` output.
- `fifos status <id>` — check whether a previously-pushed item has been processed. Includes `fail_reason` on failed items.
- `fifos retry <id>` — resubmit a done/fail item to the tail (clears `fail_reason`).
- `fifos info` / `fifos peek` / `fifos list <open|lock|done|fail>` — inspect the queue. `done`/`fail` come back newest-first; `open`/`lock` oldest-first. Add `--json` or `--yaml` for machine-readable output.
- `fifos list fail --reason <substr>` — filter failed items by a case-insensitive substring of `fail_reason` (e.g. `--reason oom`).

## When to use what
- Pushing background work: `push` (with `--key` if retrying).
- Consuming work an agent does: `pull` + `ack`/`nack` (so a crash returns the item to the queue). Pass a short reason on `nack` so failures are triageable later.
- Just draining a queue without crash safety: `pop`.
- Triaging recent failures: `fifos list fail` (newest-first), then `fifos retry <id>` for the ones worth re-running.

## Exit codes
- 0 = got an item / action succeeded
- 1 = empty queue / not found / `--block --timeout` expired
- 2 = error (network, auth, invalid usage)
