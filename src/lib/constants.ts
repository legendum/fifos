export const PORT = Number(process.env.PORT || 3000);
export const HOST = String(process.env.HOST || "0.0.0.0");

export const FIFOS_DOMAIN =
  process.env.FIFOS_DOMAIN ||
  (process.env.LEGENDUM_API_KEY
    ? "https://fifos.dev"
    : `http://localhost:${PORT}`);

/** Default lock TTL on `pull`, in seconds. Server clamps the override to [10, 3600]. */
export const FIFOS_LOCK_TIMEOUT_SECONDS = Number(
  process.env.FIFOS_LOCK_TIMEOUT_SECONDS || 1800,
);

export const LOCK_TIMEOUT_MIN_SECONDS = 10;
export const LOCK_TIMEOUT_MAX_SECONDS = 3600;

/** Done/fail/skip retention before the periodic sweep deletes them. */
export const FIFOS_RETENTION_SECONDS = Number(
  process.env.FIFOS_RETENTION_SECONDS || 60 * 60 * 24 * 7,
);

/** Cadence of the time-based sweep loop. */
export const FIFOS_PURGE_INTERVAL_SECONDS = Number(
  process.env.FIFOS_PURGE_INTERVAL_SECONDS || 60 * 60,
);

export const MAX_ITEMS_PER_FIFO = Number(
  process.env.FIFOS_MAX_ITEMS_PER_FIFO || 10000,
);

export const MAX_ITEM_BYTES = Number(process.env.FIFOS_MAX_ITEM_BYTES || 65536);

/** Max length of the optional `fail` reason body. Diagnostic text, not a payload. */
export const MAX_FAIL_REASON_BYTES = 1024;

export const MAX_FIFOS_PER_USER = Number(
  process.env.FIFOS_MAX_FIFOS_PER_USER || 50,
);

/** Slugs reserved at the URL level (`fifos.dev/<slug>`). */
export const RESERVED_SLUGS = new Set(["f", "w", "auth"]);

/** Idempotency-Key dedupe window for `POST /w/:ulid/push`. */
export const IDEMPOTENCY_WINDOW_SECONDS = 60 * 60;
