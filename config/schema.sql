-- Fifos DB schema (SQLite)
-- Database: data/fifos.db
--
-- Hierarchy: users → fifos → items.
-- See docs/SPEC.md §3.1 for the canonical description.
--
-- IMPORTANT: src/lib/db.ts must issue `PRAGMA foreign_keys = ON` on every
-- connection. SQLite has FK enforcement OFF by default — without the pragma,
-- the ON DELETE CASCADE clauses below silently become no-ops.

-- Users: one row per Legendum account. Authenticated via Login and Link with Legendum.
-- email: stable identity from Legendum ('local@localhost' for self-hosted mode).
-- legendum_token: account-service token for charging credits via Legendum tabs.
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  legendum_token TEXT,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Fifos: each fifo is a named FIFO queue with a unique webhook URL.
-- name: display name as typed by user (may contain spaces).
-- slug: URL-safe version (lowercase, spaces/underscores → hyphens). Unique per user.
-- ulid: 26-char ULID (Crockford base32, 48-bit ms timestamp + 80-bit random,
--   per the published spec); the public webhook credential at /w/<ulid>.
-- position: user-defined ordering on the home screen (drag to reorder).
-- seq: monotonic per-fifo counter; the next pushed item gets seq+1 as its position.
CREATE TABLE IF NOT EXISTS fifos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  ulid       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  slug       TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  seq        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_fifos_user           ON fifos(user_id);
CREATE INDEX IF NOT EXISTS idx_fifos_ulid           ON fifos(ulid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fifos_user_slug ON fifos(user_id, slug);

-- Items: queue entries.
-- ulid: 26-char ULID (Crockford base32) — the public id used in done/fail/status/retry.
-- position: assigned from fifos.seq at push time; FIFO order = position ASC among 'todo'.
-- status: 'todo' (queued), 'lock' (pulled, awaiting done/fail/skip), 'done' (popped or marked done),
--   'fail' (marked fail — retryable), 'skip' (marked skip — terminal, not retryable).
-- data: the item body — UTF-8 text, max 64 KB (enforced at the API boundary).
-- locked_until: unix-seconds; NULL except when status='lock'.
-- fail_reason: optional diagnostic text supplied to fail; max 1 KiB. NULL except
--   when status='fail' (and even then NULL is allowed if no reason was given).
--   Cleared back to NULL on retry.
-- skip_reason: same shape as fail_reason but for status='skip'. NULL except when
--   status='skip' (NULL still allowed). Cleared on retry, but retry refuses 'skip'
--   so this column never actually round-trips through retry.
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fifo_id      INTEGER NOT NULL REFERENCES fifos(id) ON DELETE CASCADE,
  ulid         TEXT    NOT NULL UNIQUE,
  position     INTEGER NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('todo','lock','done','fail','skip')),
  data         TEXT    NOT NULL,
  locked_until INTEGER,
  fail_reason  TEXT,
  skip_reason  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Workhorse index — pop, pull, peek, list all order by (fifo_id, status, position).
CREATE INDEX IF NOT EXISTS idx_items_fifo_status_pos ON items(fifo_id, status, position);
-- Lookup by item ulid (done, fail, skip, status, retry).
CREATE INDEX IF NOT EXISTS idx_items_fifo_ulid       ON items(fifo_id, ulid);
-- Partial index for the retention sweep — only indexes the rows we actually delete.
CREATE INDEX IF NOT EXISTS idx_items_purge           ON items(status, updated_at) WHERE status IN ('done','fail','skip');

-- Idempotency: dedupes POST /w/:ulid/push within a 1h window when Idempotency-Key is set.
-- Composite PK enforces the dedup constraint at the DB level — concurrent loser pushes
-- get a unique-constraint error, retry the SELECT, and return the winner's item id.
-- Rows older than 1h are deleted by the same purger that handles done/fail items.
CREATE TABLE IF NOT EXISTS idempotency (
  fifo_id    INTEGER NOT NULL REFERENCES fifos(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (fifo_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idem_purge ON idempotency(created_at);
