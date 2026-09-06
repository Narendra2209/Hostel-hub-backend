/**
 * Password hashing.
 *
 * Uses Node's built-in `scrypt`. That is a deliberate choice over argon2 or
 * bcrypt: both of those are native modules, which means a compiler in the Lambda
 * image, prebuilt-binary mismatches between a Windows dev machine and a Linux
 * container, and one more thing that can break a deploy. scrypt is memory-hard,
 * built into every Node runtime, and needs no dependency at all.
 *
 * Parameters follow the OWASP guidance for scrypt: N = 2^15, r = 8, p = 1,
 * which costs roughly 32 MB and ~100ms per hash - slow enough to make offline
 * cracking expensive, fast enough that a login does not feel sluggish.
 *
 * The stored format is self-describing so the parameters can be raised later
 * without invalidating existing hashes:
 *
 *   scrypt$N$r$p$<salt base64url>$<derived key base64url>
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; give it headroom or Node refuses.
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

const b64 = (buffer: Buffer): string => buffer.toString('base64url');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${b64(salt)}$${b64(derived)}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing for any malformed hash, so a corrupted
 * record fails closed instead of 500-ing the login endpoint.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // Refuse absurd parameters from a tampered record rather than allocating
    // gigabytes trying to honour them.
    if (N > 1 << 20 || r > 32 || p > 16) return false;

    const salt = Buffer.from(saltRaw, 'base64url');
    const expected = Buffer.from(keyRaw, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });

    // Constant-time: never leak how much of the hash matched.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a hash was made with weaker parameters and should be upgraded. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

/**
 * Password policy, enforced on the server. The web client shows the same rules,
 * but this is the one that counts.
 */
export function validatePasswordStrength(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Use at least 10 characters');
  if (password.length > 200) problems.push('Use at most 200 characters');
  if (!/[a-z]/.test(password)) problems.push('Include a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('Include an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('Include a digit');
  // A short list of the passwords people actually pick, not a dictionary.
  if (/^(password|hostel|admin|welcome|qwerty|letmein)/i.test(password)) {
    problems.push('That password is too easy to guess');
  }
  return problems;
}

/** A readable temporary password for an invited account. */
export function generateTemporaryPassword(): string {
  // Avoids look-alike characters so it can be read aloud or copied by hand.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const pick = (set: string, count: number): string => {
    const bytes = randomBytes(count);
    return Array.from({ length: count }, (_, i) => set[bytes[i]! % set.length]!).join('');
  };
  return `${pick(alphabet, 2)}${pick(lower, 6)}${pick(digits, 3)}`;
}
