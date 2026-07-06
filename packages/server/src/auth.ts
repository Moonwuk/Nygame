import type { PlayerId } from '@void/shared-core';
import { jwtVerify, SignJWT, type CryptoKey, type JWTPayload, type KeyObject } from 'jose';

/**
 * SE-2.1 — the trust anchor. A join token is a short-lived, match-scoped CAPABILITY
 * granted after identity + matchmaking: it authorizes ONE identity to take ONE seat in
 * ONE match. `verifyJoinToken` is the single gate the WS handshake (SE-0.1) leans on; it
 * is pure (no transport) and returns a typed claim or a stable `E_AUTH` — never the reason
 * (alg/exp/signature), which stays in server logs, not on the wire (OWASP A10).
 *
 * The classic JWT footgun is algorithm confusion (an attacker downgrading to `none`, or
 * signing HS256 with a public key the server expected to verify as RS256). We defend by
 * PINNING an explicit `algorithms` allowlist on every verify — jose rejects any token
 * whose header alg is not in the list, so `none` and cross-alg forgeries never validate.
 */

/** The verification key: a symmetric secret (HS256, dev) or an asymmetric public key
 *  (RS256 / ES256, prod / a JWKS-resolved key). */
export type VerifyKey = Uint8Array | CryptoKey | KeyObject;

export interface JoinTokenVerifyConfig {
  /** Key material to verify the signature against. */
  key: VerifyKey;
  /** Pinned algorithm allowlist — MUST be explicit and MUST NOT include `none`.
   *  A token whose header alg is outside this set is rejected (anti alg-confusion). */
  algorithms: string[];
  /** Required `iss` — a token from another issuer is rejected. */
  issuer: string;
  /** Required `aud` — a token minted for another audience is rejected. */
  audience: string;
  /** Optional hard cap (seconds) on a token's age from `iat`, enforced at the gate
   *  regardless of the minting side's TTL — a defence-in-depth bound on a leaked token's
   *  window. Absent ⇒ replay is bounded only by `exp`. */
  maxTokenAgeSec?: number;
}

/** JWT `typ` header pinned on every join token: verify rejects any token without it, so a
 *  token minted for a DIFFERENT purpose under the same key/iss/aud can't be replayed as a
 *  join token (defence-in-depth against key reuse). */
const JOIN_TOKEN_TYP = 'join+jwt';

/** What a verified join token grants: a seat (`playerId`) in a match (`matchId`), for an
 *  identity (`accountId`, when the minting side had one). */
export interface JoinClaim {
  matchId: string;
  playerId: PlayerId;
  accountId?: string;
}

export type JoinTokenResult = { ok: true; claim: JoinClaim } | { ok: false; code: 'E_AUTH' };

/** Verify + decode a join token. Returns the claim on success, `{ ok:false, code:'E_AUTH' }`
 *  for ANY failure (bad alg, expired, wrong iss/aud, bad signature, missing claim) — the
 *  caller learns only that it was rejected, never why. */
export async function verifyJoinToken(
  token: string,
  config: JoinTokenVerifyConfig,
): Promise<JoinTokenResult> {
  try {
    const { payload } = await jwtVerify(token, config.key, {
      algorithms: config.algorithms, // pinned allowlist — rejects `none` / cross-alg
      issuer: config.issuer,
      audience: config.audience,
      typ: JOIN_TOKEN_TYP, // reject a token minted for another purpose (key-reuse guard)
      clockTolerance: 0, // no skew tolerance — exp is enforced exactly
      requiredClaims: ['exp'], // a join token without `exp` is not a join token
      ...(config.maxTokenAgeSec !== undefined ? { maxTokenAge: config.maxTokenAgeSec } : {}),
    });
    const claim = claimFromPayload(payload);
    return claim ? { ok: true, claim } : { ok: false, code: 'E_AUTH' };
  } catch {
    return { ok: false, code: 'E_AUTH' };
  }
}

function claimFromPayload(payload: JWTPayload): JoinClaim | null {
  const matchId = payload.matchId;
  const playerId = payload.playerId;
  if (typeof matchId !== 'string' || matchId === '') return null;
  if (typeof playerId !== 'string' || playerId === '') return null;
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined;
  return accountId ? { matchId, playerId, accountId } : { matchId, playerId };
}

export interface JoinTokenSignConfig {
  /** Signing key: the shared secret for HS256 (dev), or a private key for RS256 / ES256. */
  key: VerifyKey;
  /** The one algorithm to sign with (e.g. `HS256`). */
  algorithm: string;
  issuer: string;
  audience: string;
}

/** Mint a join token (the `/join` endpoint's job — SV-2.4 — and the tests'). Stamps
 *  `iat`/`exp` from `ttlSeconds`; short TTLs keep a leaked token's window tiny. `now`
 *  is injectable for deterministic tests. */
export function signJoinToken(
  claim: JoinClaim,
  config: JoinTokenSignConfig,
  opts: { ttlSeconds: number; now?: () => number },
): Promise<string> {
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const payload: JWTPayload = { matchId: claim.matchId, playerId: claim.playerId };
  if (claim.accountId !== undefined) payload.accountId = claim.accountId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: config.algorithm, typ: JOIN_TOKEN_TYP })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + opts.ttlSeconds)
    .sign(config.key);
}

/** Derive an HS256 secret key from a string (dev / env `AUTH_JWT_SECRET`). */
export function hmacSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Session tokens (SE-1.x, login+password accounts). A session token is the
// "who you are" credential the HTTP API trusts between login and join; the join
// token stays the narrow per-match capability. Same key infrastructure, but a
// DIFFERENT pinned `typ` and a different audience — so neither token kind can
// ever be replayed as the other, even under one shared secret.
// ---------------------------------------------------------------------------

/** JWT `typ` pinned on every session token (mirrors JOIN_TOKEN_TYP's key-reuse guard). */
const SESSION_TOKEN_TYP = 'session+jwt';

/** What a verified session token grants: an authenticated account. */
export interface SessionClaim {
  accountId: string;
  login: string;
}

export type SessionTokenResult = { ok: true; claim: SessionClaim } | { ok: false; code: 'E_AUTH' };

/** Verify + decode a session token — same fail-secure contract as `verifyJoinToken`:
 *  a stable `E_AUTH` for ANY failure, the reason stays server-side. */
export async function verifySessionToken(
  token: string,
  config: JoinTokenVerifyConfig,
): Promise<SessionTokenResult> {
  try {
    const { payload } = await jwtVerify(token, config.key, {
      algorithms: config.algorithms,
      issuer: config.issuer,
      audience: config.audience,
      typ: SESSION_TOKEN_TYP, // a join token (typ join+jwt) can never pass as a session
      clockTolerance: 0,
      requiredClaims: ['exp'],
      ...(config.maxTokenAgeSec !== undefined ? { maxTokenAge: config.maxTokenAgeSec } : {}),
    });
    const accountId = payload.sub;
    const login = payload.login;
    if (typeof accountId !== 'string' || accountId === '') return { ok: false, code: 'E_AUTH' };
    if (typeof login !== 'string' || login === '') return { ok: false, code: 'E_AUTH' };
    return { ok: true, claim: { accountId, login } };
  } catch {
    return { ok: false, code: 'E_AUTH' };
  }
}

/** Mint a session token (the /auth/login and /auth/register endpoints' job). */
export function signSessionToken(
  claim: SessionClaim,
  config: JoinTokenSignConfig,
  opts: { ttlSeconds: number; now?: () => number },
): Promise<string> {
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  return new SignJWT({ login: claim.login })
    .setProtectedHeader({ alg: config.algorithm, typ: SESSION_TOKEN_TYP })
    .setSubject(claim.accountId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + opts.ttlSeconds)
    .sign(config.key);
}
