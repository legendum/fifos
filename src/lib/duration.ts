/**
 * Parse a human-friendly duration string into seconds.
 *
 * Accepted forms:
 *   - bare integer:     "600"   → 600
 *   - seconds suffix:   "300s"  → 300
 *   - minutes suffix:   "5m"    → 300
 *   - hours suffix:     "1h"    → 3600
 *
 * Returns the duration in seconds, or `null` for any input that is empty,
 * not a positive integer, or has an unrecognized suffix. The caller is
 * responsible for clamping to its own valid range (e.g. queue.ts clamps
 * the `pull` lock TTL to [10, 3600]).
 *
 * Why a single helper: the same parsing runs server-side on the
 * `?lock=<dur>` query param and client-side on the `--lock` CLI flag, so
 * both surfaces accept exactly the same forms.
 */
export function parseDuration(input: string | undefined | null): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const match = /^(\d+)(s|m|h)?$/.exec(s);
  if (!match) return null;

  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  switch (match[2]) {
    case undefined:
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    default:
      return null;
  }
}

/** Clamp a duration in seconds to an inclusive range. */
export function clampSeconds(seconds: number, min: number, max: number): number {
  if (seconds < min) return min;
  if (seconds > max) return max;
  return seconds;
}
