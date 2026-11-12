import { randomBytes } from 'node:crypto';

// Crockford base32, as used by ULID. Time-ordered IDs make cursor pagination a
// plain `WHERE id < ?` and keep insertion order equal to creation-time order,
// including for history backfilled with a simulated clock.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  const digits: number[] = [];
  for (let i = 0; i < 16; i++) digits.push((bytes[i] ?? 0) % 32);
  return digits;
}

/** Monotonic ULID: within the same millisecond the random part is incremented. */
export function ulid(ms: number): string {
  if (ms === lastTime) {
    const next = [...lastRandom];
    for (let i = next.length - 1; i >= 0; i--) {
      const d = (next[i] ?? 0) + 1;
      if (d < 32) {
        next[i] = d;
        break;
      }
      next[i] = 0;
    }
    lastRandom = next;
  } else {
    lastTime = ms;
    lastRandom = freshRandom();
  }
  return encodeTime(ms) + lastRandom.map((d) => ALPHABET[d]).join('');
}

export type IdPrefix = 'src' | 'snp' | 'chk' | 'chg' | 'run' | 'dig' | 'whk' | 'dlv' | 'key' | 'msg';

export function newId(prefix: IdPrefix, ms: number): string {
  return `${prefix}_${ulid(ms)}`;
}

export function isId(value: string, prefix: IdPrefix): boolean {
  return new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}
