/**
 * SSE publisher.
 *
 * Phase 3 stub — Phase 7 fills in the per-fifo / per-user ring buffers and
 * subscribe() endpoints (SPEC §6.5). For now, every call is a no-op so the
 * fifos / queue / purge modules can call publish() without a forward
 * reference to unfinished code.
 */
export function publish(
  _scope: string,
  _type: "push" | "change" | "purge" | "fifos",
  _payload: unknown,
): void {}
