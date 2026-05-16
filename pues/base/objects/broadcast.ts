/**
 * `broadcastRow` — re-emit a row mutation that happened *outside*
 * `mountResource`'s routes, so `useResource` subscribers stay coherent
 * across mixed write surfaces.
 *
 * The canonical case is fifos' `/w/:ulid/*` webhook surface: it writes
 * the `items` table directly on push/pop/done/fail/skip/retry/pull,
 * bypassing pues' POST/PATCH/DELETE handlers and their built-in
 * broadcasts. Without a bridge, browser tabs subscribed to
 * `useResource("items")` would silently go stale on every webhook
 * mutation. With this helper, the webhook handler reads the canonical
 * wire row from the DB (via `toWire`) and calls `broadcastRow` so
 * subscribers see the same event shape they would get from a native
 * pues mutation.
 *
 * Scope (deliberately narrow):
 *   - Covers `.created` and `.updated` — the two events that carry a
 *     full row.
 *   - Does NOT cover `.reordered` (different payload shape) or
 *     `.deleted` (caller may not have the row anymore; a separate
 *     `broadcastDelete` would be the right shape if/when needed).
 *
 * See SPEC §7.4.
 */

import type { Broadcast } from "./mountResource";
import type { WireRow } from "./wire";

export function broadcastRow<TExtra = Record<string, unknown>>(
  broadcast: Broadcast,
  userId: number,
  name: string,
  event: "created" | "updated",
  row: WireRow<TExtra>,
  opts?: { op_id?: string | null },
): void {
  broadcast(userId, `${name}.${event}`, row, opts);
}
