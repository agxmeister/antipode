import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BITS = 80n;
const RANDOM_MAX = (1n << RANDOM_BITS) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = ENCODING[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

/**
 * ULID (AD-16): 48-bit millisecond timestamp plus 80 random bits, Crockford base32, 26 characters.
 * Monotonic within the process: ids minted in the same millisecond sort in minting order, so
 * `ORDER BY id` is insertion order.
 */
export function ulid(time: number = Date.now()): string {
  if (time <= lastTime) {
    lastRandom = lastRandom + 1n > RANDOM_MAX ? 0n : lastRandom + 1n;
  } else {
    lastTime = time;
    lastRandom = BigInt(`0x${randomBytes(10).toString('hex')}`);
  }
  return encode(BigInt(lastTime), TIME_CHARS) + encode(lastRandom, RANDOM_CHARS);
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
