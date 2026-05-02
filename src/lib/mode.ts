/**
 * Hosted vs self-hosted mode detection.
 *
 * Self-hosted is the default for FOSS users: API auth uses a single local
 * user, billing is skipped, and limits in SPEC §3.2 still apply.
 *
 * Hosted mode (fifos.in) is enabled automatically when `LEGENDUM_API_KEY`
 * is set — Legendum-backed login + billing + auto-logout on unlink.
 */

let byLegendumOverride: boolean | null = null;

export function isByLegendum(): boolean {
  if (byLegendumOverride !== null) return byLegendumOverride;
  return !!process.env.LEGENDUM_API_KEY;
}

export function isSelfHosted(): boolean {
  return !isByLegendum();
}

/** Test helper: force hosted-mode on or off. Pass `null` to restore env detection. */
export function setByLegendum(value: boolean | null): void {
  byLegendumOverride = value;
}

export const LOCAL_USER_EMAIL = "local@localhost";
