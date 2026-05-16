/**
 * 26-character public id, time-prefixed, monotonic per millisecond.
 *
 * Layout: 10 chars time (ms since epoch in Crockford-base32) + 16 chars
 * random (80 random bits). Not the strict ULID bit-packing — the random
 * tail uses one base32 char per source byte rather than spanning byte
 * boundaries — but the result is sortable by creation time, URL-safe, and
 * unique with overwhelming probability. Consumers that need spec-strict
 * ULIDs can pass their own `newId` to `mountResource`.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

export function newId(): string {
  return encodeTime(Date.now()) + encodeRandom(RAND_LEN);
}

function encodeTime(ms: number): string {
  let t = ms;
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(n: number): string {
  // 256 = 32 * 8 exactly, so `byte % 32` is bias-free.
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i]! % 32];
  return out;
}
