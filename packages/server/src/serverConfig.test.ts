import { describe, expect, it } from 'vitest';
import { verifyJoinToken } from './auth';
import { checkProductionReadiness, configFromEnv } from './serverConfig';

// 2.3 — the entrypoint's security composition (previously only boot-smoked). The critical
// property: a token minted by `signToken` verifies under `auth` (same secret/alg/iss/aud),
// so enabling auth doesn't accidentally lock everyone out via config drift.

describe('configFromEnv', () => {
  it('is all-off by default (the insecure dev harness)', () => {
    const cfg = configFromEnv({});
    expect(cfg.auth).toBeUndefined();
    expect(cfg.signToken).toBeUndefined();
    expect(cfg.gateFactory).toBeUndefined();
    expect(cfg.allowedOrigins).toBeUndefined();
  });

  it('AUTH_JWT_SECRET yields auth + signToken whose token round-trips', async () => {
    const cfg = configFromEnv({ AUTH_JWT_SECRET: 'secret-xyz' });
    expect(cfg.auth).toBeDefined();
    expect(cfg.signToken).toBeDefined();

    // A token minted for a seat verifies under the handshake's auth config → the claim.
    const token = await cfg.signToken!('m-1', 'green');
    const result = await verifyJoinToken(token, cfg.auth!);
    expect(result).toEqual({ ok: true, claim: { matchId: 'm-1', playerId: 'green' } });
  });

  it('honours AUTH_ISSUER / AUTH_AUDIENCE consistently across sign and verify', async () => {
    const cfg = configFromEnv({
      AUTH_JWT_SECRET: 'secret-xyz',
      AUTH_ISSUER: 'my-iss',
      AUTH_AUDIENCE: 'my-aud',
    });
    const token = await cfg.signToken!('m-2', 'red');
    expect(await verifyJoinToken(token, cfg.auth!)).toMatchObject({ ok: true });
    // A verify config with a different audience rejects the same token (binding is real).
    expect(await verifyJoinToken(token, { ...cfg.auth!, audience: 'other' })).toEqual({
      ok: false,
      code: 'E_AUTH',
    });
  });

  it('parses ALLOWED_ORIGINS (comma-split, trimmed, empties dropped)', () => {
    const cfg = configFromEnv({ ALLOWED_ORIGINS: 'https://a.example, https://b.example ,' });
    expect(cfg.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('GATE=1 yields a factory that builds a FRESH gate each call (per-match isolation)', () => {
    const cfg = configFromEnv({ GATE: '1' });
    expect(cfg.gateFactory).toBeDefined();
    const a = cfg.gateFactory!();
    const b = cfg.gateFactory!();
    expect(a).not.toBe(b); // distinct instances → per-match sequence/receipt state
  });

  it('GATE unset ⇒ no gate factory', () => {
    expect(configFromEnv({ GATE: '0' }).gateFactory).toBeUndefined();
    expect(configFromEnv({}).gateFactory).toBeUndefined();
  });
});

// MP-1: secure-by-default launch guard — "prod-mode without a secret refuses to start".
describe('checkProductionReadiness', () => {
  const FULL = {
    PROD: '1',
    AUTH_JWT_SECRET: 'secret-xyz',
    GATE: '1',
    TRUST_PROXY: '1',
    SEAT_LOCK: '1',
  };

  it('PROD unset ⇒ ok, the dev harness is untouched', () => {
    expect(checkProductionReadiness({})).toEqual({ ok: true, missing: [] });
    // Dev-flag-adjacent values that are NOT the trigger stay untouched too.
    expect(checkProductionReadiness({ PROD: '0' })).toEqual({ ok: true, missing: [] });
  });

  it('PROD=1 with nothing else set refuses, naming every missing switch', () => {
    const r = checkProductionReadiness({ PROD: '1' });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      'AUTH_JWT_SECRET',
      'GATE=1',
      'TLS (TLS_KEY_FILE+TLS_CERT_FILE for native TLS, or TRUST_PROXY=1 behind a TLS-terminating proxy)',
      'SEAT_LOCK=1',
    ]);
  });

  it('PROD=1 with every switch on (proxy-terminated TLS) ⇒ ok', () => {
    expect(checkProductionReadiness(FULL)).toEqual({ ok: true, missing: [] });
  });

  it('PROD="true" is the same trigger as "1"', () => {
    expect(checkProductionReadiness({ ...FULL, PROD: 'true' })).toEqual({ ok: true, missing: [] });
  });

  it('accepts native TLS (key+cert files) as an alternative to TRUST_PROXY', () => {
    const { TRUST_PROXY, ...rest } = FULL;
    void TRUST_PROXY;
    const r = checkProductionReadiness({ ...rest, TLS_KEY_FILE: '/certs/key.pem', TLS_CERT_FILE: '/certs/cert.pem' });
    expect(r).toEqual({ ok: true, missing: [] });
  });

  it('a lone TLS_KEY_FILE without TLS_CERT_FILE does not count as TLS', () => {
    const { TRUST_PROXY, ...rest } = FULL;
    void TRUST_PROXY;
    const r = checkProductionReadiness({ ...rest, TLS_KEY_FILE: '/certs/key.pem' });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      'TLS (TLS_KEY_FILE+TLS_CERT_FILE for native TLS, or TRUST_PROXY=1 behind a TLS-terminating proxy)',
    ]);
  });

  it('flags exactly one missing switch at a time', () => {
    const { SEAT_LOCK, ...rest } = FULL;
    void SEAT_LOCK;
    expect(checkProductionReadiness(rest)).toEqual({ ok: false, missing: ['SEAT_LOCK=1'] });
  });

  it('GATE/SEAT_LOCK also accept the "true" string form', () => {
    expect(checkProductionReadiness({ ...FULL, GATE: 'true', SEAT_LOCK: 'true' })).toEqual({
      ok: true,
      missing: [],
    });
  });
});
