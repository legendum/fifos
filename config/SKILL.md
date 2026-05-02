# Fifos

Use the `fifos` CLI to push/pop work items on a FIFO queue.

## Setup
- Each project's queue is configured by `FIFOS_WEBHOOK` in `.env`.
- For multi-queue services, pass `-f <ulid|url>` per command instead.

## Verbs
- `fifos push "data"` — append an item. Use `--key <id>` for retry-safe pushes.
- `fifos pop` — fire-and-forget consume (item → done).
- `fifos pop --block [--timeout 60]` — wait via SSE until something is pushed, then pop. Exits 1 cleanly on timeout.
- `fifos pull [--lock 5m]` — at-least-once consume (item → lock). Then `fifos ack` on success or `fifos nack` on failure. Default lock is 5 min; extend up to 1h if your work needs longer.
- `fifos status <id>` — check whether a previously-pushed item has been processed.
- `fifos retry <id>` — resubmit a done/fail item without re-pushing.
- `fifos info` / `fifos peek` / `fifos list <open|lock|done|fail>` — inspect the queue. Add `--json` or `--yaml` for machine-readable output.

## When to use what
- Pushing background work: `push` (with `--key` if retrying).
- Consuming work an agent does: `pull` + `ack`/`nack` (so a crash returns the item to the queue).
- Just draining a queue without crash safety: `pop`.

## Exit codes
- 0 = got an item / action succeeded
- 1 = empty queue / not found / `--block --timeout` expired
- 2 = error (network, auth, invalid usage)
