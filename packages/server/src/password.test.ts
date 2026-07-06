import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, type ScryptParams } from './password';

// Cheap parameters for tests — the FORMAT and the verify logic are what's under test,
// not the production cost (which one dedicated case below pins).
const FAST: ScryptParams = { N: 2 ** 12, r: 8, p: 1 };

describe('SE-1.x · password hashing (scrypt)', () => {
  it('round-trips: a hashed password verifies, a wrong one does not', async () => {
    const stored = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery!', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts: hashing the same password twice yields different records (both verify)', async () => {
    const a = await hashPassword('same password', FAST);
    const b = await hashPassword('same password', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('embeds its parameters: verification re-derives with the STORED cost', async () => {
    const stored = await hashPassword('upgradable', FAST);
    const [scheme, n, r, p, salt, key] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(FAST.N);
    expect(Number(r)).toBe(FAST.r);
    expect(Number(p)).toBe(FAST.p);
    expect(salt!.length).toBeGreaterThan(0);
    expect(Buffer.from(key!, 'base64url')).toHaveLength(32);
  });

  it('is fail-secure on malformed or hostile stored values (false, never a throw)', async () => {
    for (const bad of [
      '', // empty
      'plaintext', // no structure
      'bcrypt$10$abc$def', // unknown scheme
      'scrypt$notanumber$8$1$c2FsdA$a2V5', // NaN params
      'scrypt$4096$8$1$$a2V5', // empty salt
      'scrypt$4096$8$1$c2FsdA$', // empty key
      'scrypt$1073741824$8$1$c2FsdA$a2V5', // absurd N → would exceed the memory cap
      'scrypt$4096$8$1$c2FsdA', // missing field
    ]) {
      expect(await verifyPassword('whatever', bad)).toBe(false);
    }
  });

  it('default production cost derives successfully (maxmem headroom is sufficient)', async () => {
    const stored = await hashPassword('production cost check');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('production cost check', stored)).toBe(true);
  });
});
