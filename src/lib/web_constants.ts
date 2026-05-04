/**
 * Constants safe for browser bundles (no `process` / Node env reads).
 * `src/lib/constants.ts` re-exports this module first, then server-only values.
 * Web code should import from `../lib/web_constants.js` (not `constants.ts`).
 */

/** Pull lock TTL clamp bounds (seconds). Server clamps override to this range. */
export const LOCK_TIMEOUT_MIN_SECONDS = 10;
export const LOCK_TIMEOUT_MAX_SECONDS = 3600;

/** Max length of the optional `reason` body on done/fail/skip. Diagnostic text, not a payload. */
export const MAX_REASON_BYTES = 1024;

/** Slugs reserved at the URL level (`fifos.dev/<slug>`). */
export const RESERVED_SLUGS = new Set(["f", "w", "auth"]);

/** Idempotency-Key dedupe window for `POST /w/:ulid/push`. */
export const IDEMPOTENCY_WINDOW_SECONDS = 60 * 60;

/** Rows deleted per batch in retention sweep and pressure purge. */
export const PURGE_BATCH_SIZE = 100;

export const ITEM_STATUSES = ["todo", "lock", "done", "fail", "skip"] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

export function isItemStatus(s: string): s is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(s);
}

/** For CLI/API error text, e.g. `todo|lock|done|fail|skip`. */
export const ITEM_STATUSES_PIPE = ITEM_STATUSES.join("|");

/**
 * Default `fifos.max_retries` (fail attempts before auto-`skip`). Must match
 * `DEFAULT` in `config/schema.sql`.
 */
export const DEFAULT_FIFO_MAX_RETRIES = 3;

/** Inclusive floor for `fifos.max_retries` (see SQL `CHECK`). */
export const MIN_FIFO_MAX_RETRIES = 1;

/** Inclusive ceiling for API `max_retries` on fifo create/patch. */
export const MAX_FIFO_MAX_RETRIES = 1000;
