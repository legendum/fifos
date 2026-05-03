/**
 * ULID generator — 26-char Crockford base32, per the published spec.
 *
 * Layout:
 *   - 10 chars: 48-bit unix-millisecond timestamp, big-endian.
 *   - 16 chars: 80-bit cryptographic random, big-endian.
 *
 * Properties:
 *   - Lex-sortable: string comparison matches issue-time ordering across IDs
 *     minted in different milliseconds. Within the same ms, order is random
 *     (we don't implement the optional monotonic-within-ms increment — nothing
 *     in fifos relies on within-ms ordering; `position` is the canonical sort).
 *   - Decodable: the first 10 chars round-trip to the issue timestamp.
 *   - First char is always one of 0-7 (high 2 bits of a 48-bit ms timestamp
 *     are zero until ~year 10889).
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  // 10-char timestamp.
  let t = Date.now();
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = ENCODING[t % 32] + ts;
    t = Math.floor(t / 32);
  }

  // 16-char random — pack 80 bits into a BigInt, then encode 5 bits at a time
  // from the LSB up, prepending each digit to keep big-endian output order.
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = ENCODING[Number(n & 0x1fn)] + rand;
    n >>= 5n;
  }

  return ts + rand;
}
