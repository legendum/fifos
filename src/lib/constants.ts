export * from "./web_constants.js";

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

/** Per-user fifo cap (`FIFOS_MAX_FIFOS_PER_USER`, default 50). Starter fifos count toward this. Read per call so `bun test` can change env after other suites loaded `constants.ts`. */
export function maxFifosPerUser(): number {
  const raw = process.env.FIFOS_MAX_FIFOS_PER_USER;
  if (raw === undefined || raw === "") return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}
