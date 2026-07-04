import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the login+password accounts (SE-1.x) — scrypt from node:crypto,
 * so the server takes NO new dependency (no native build steps, works in the distroless
 * image). scrypt is an OWASP-accepted memory-hard KDF; the parameters are embedded in
 * every stored hash, so they can be raised later without invalidating old records —
 * verification always re-derives with the STORED parameters.
 *
 * Stored format (one line, `$`-separated):
 *   scrypt$<N>$<r>$<p>$<salt b64url>$<derived key b64url>
 */

/** Cost parameters. N=2^15 · r=8 ≈ 32 MiB / ~80 ms per hash — a deliberate speed bump
 *  for online guessing while staying cheap enough for a login burst on a small VM. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** node's default scrypt maxmem (32 MiB) is EXACTLY the requirement of N=2^15·r=8 —
 *  give explicit headroom so the derivation never trips the limit. */
const MAX_MEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash a password for storage. `params` is injectable for fast tests only —
 *  production callers use the default cost. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return [
    'scrypt',
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** Verify a password against a stored hash. Fail-secure: ANY malformed/unsupported
 *  stored value verifies false (never throws to the caller); comparison is
 *  constant-time on the derived key. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, nS, rS, pS, saltS, keyS] = stored.split('$');
    if (scheme !== 'scrypt' || !nS || !rS || !pS || !saltS || !keyS) return false;
    const params: ScryptParams = { N: Number(nS), r: Number(rS), p: Number(pS) };
    if (
      !Number.isInteger(params.N) ||
      !Number.isInteger(params.r) ||
      !Number.isInteger(params.p) ||
      params.N < 2 ||
      params.r < 1 ||
      params.p < 1 ||
      128 * params.N * params.r > MAX_MEM // reject a stored record we can't derive safely
    ) {
      return false;
    }
    const salt = Buffer.from(saltS, 'base64url');
    const expected = Buffer.from(keyS, 'base64url');
    if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
    const actual = await derive(password, salt, params);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A decoy hash for timing equalization: `login` misses still burn one scrypt derivation,
 *  so "unknown login" and "wrong password" are indistinguishable by response time. */
export function decoyHash(params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  return hashPassword(randomBytes(9).toString('base64url'), params);
}
