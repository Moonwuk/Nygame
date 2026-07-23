import { ActionGate } from '@void/action-layer';
import { isValidActionPayload } from '@void/shared-core';
import {
  hmacSecret,
  signJoinToken,
  signResetToken,
  signSessionToken,
  verifyResetToken,
  verifySessionToken,
  type JoinTokenVerifyConfig,
  type SessionTokenResult,
} from './auth';

/**
 * The server's security composition, derived from the environment — extracted from the
 * `main.ts` entrypoint (which boots on import) so it is unit-testable. All three switches
 * are OFF by default, so a bare `pnpm dev:server` is the insecure dev harness:
 *
 *   AUTH_JWT_SECRET  → require a verified join token at the handshake (+ mint tokens for
 *                      the create/join API). AUTH_ISSUER / AUTH_AUDIENCE tune the claims.
 *   ALLOWED_ORIGINS  → comma-separated Origin allowlist (CSWSH defence).
 *   GATE=1           → require validated action.v1 envelopes.
 *
 * `signToken` uses the SAME secret/alg/iss/aud as `auth` verifies with, so a minted token
 * round-trips — the property serverConfig.test.ts pins.
 */
export interface ServerConfig {
  auth?: JoinTokenVerifyConfig;
  allowedOrigins?: string[];
  /** Mint a join token for a seat (the /join API). Present iff auth is configured. */
  signToken?: (matchId: string, playerId: string, accountId?: string) => Promise<string>;
  /** Mint a session token for an authenticated account (the /auth API). Present iff
   *  auth is configured — same secret, but a distinct `typ` + audience, so session and
   *  join tokens can never be replayed as each other. */
  signSession?: (accountId: string, login: string, pwfp: string) => Promise<string>;
  /** Verify a session token (the identity gate on /matches routes). Present iff auth. */
  verifySession?: (token: string) => Promise<SessionTokenResult>;
  /** Mint a password-reset token (the /auth/recover endpoint). Same secret, a distinct
   *  audience + typ, so it can't be replayed as a session/join token. Present iff auth. */
  signReset?: (accountId: string, pwfp: string) => Promise<string>;
  /** Verify a password-reset token (the /auth/reset endpoint). Present iff auth. */
  verifyReset?: (token: string) => Promise<{ accountId: string; pwfp: string } | null>;
  /** Origin the emailed reset link points at (`RESET_BASE_URL`, e.g. https://host). The
   *  recover route only mounts when this is set — a link needs somewhere to point. */
  resetBaseUrl?: string;
  /** Build a fresh per-match ActionGate. Present iff GATE is enabled. */
  gateFactory?: () => ActionGate;
}

/** Join tokens ride in the WS URL, so keep the leaked-token window small; the verify side
 *  also caps age from `iat` (maxTokenAgeSec) as defence-in-depth. */
const JOIN_TOKEN_TTL_SEC = 15 * 60;
/** Sessions are the "stay logged in" credential — days, not minutes. Env-tunable. */
const SESSION_TTL_SEC_DEFAULT = 7 * 24 * 3600;
/** Reset links are one-shot and time-boxed — a tight window bounds a leaked link. */
const RESET_TOKEN_TTL_SEC = 15 * 60;

export function configFromEnv(env: NodeJS.ProcessEnv): ServerConfig {
  const authSecret = env.AUTH_JWT_SECRET;
  const issuer = env.AUTH_ISSUER ?? 'void-dominion';
  const audience = env.AUTH_AUDIENCE ?? 'match';

  const auth: JoinTokenVerifyConfig | undefined = authSecret
    ? { key: hmacSecret(authSecret), algorithms: ['HS256'], issuer, audience, maxTokenAgeSec: JOIN_TOKEN_TTL_SEC }
    : undefined;
  const signToken = authSecret
    ? (matchId: string, playerId: string, accountId?: string): Promise<string> =>
        signJoinToken(
          accountId ? { matchId, playerId, accountId } : { matchId, playerId },
          { key: hmacSecret(authSecret), algorithm: 'HS256', issuer, audience },
          { ttlSeconds: JOIN_TOKEN_TTL_SEC },
        )
    : undefined;

  // Session tokens: same key, DIFFERENT audience (+ a different pinned typ in auth.ts) —
  // a session can't be replayed as a join token or vice versa.
  const sessionAudience = env.AUTH_SESSION_AUDIENCE ?? 'session';
  const sessionTtlSec = Number(env.SESSION_TTL_SEC ?? '') || SESSION_TTL_SEC_DEFAULT;
  const signSession = authSecret
    ? (accountId: string, login: string, pwfp: string): Promise<string> =>
        signSessionToken(
          { accountId, login, pwfp },
          { key: hmacSecret(authSecret), algorithm: 'HS256', issuer, audience: sessionAudience },
          { ttlSeconds: sessionTtlSec },
        )
    : undefined;
  const verifySession = authSecret
    ? (token: string): Promise<SessionTokenResult> =>
        verifySessionToken(token, {
          key: hmacSecret(authSecret),
          algorithms: ['HS256'],
          issuer,
          audience: sessionAudience,
        })
    : undefined;

  // Reset tokens: same key again, a THIRD distinct audience (+ the reset+jwt typ) so no
  // token kind can pass for another. The recover route only mounts when RESET_BASE_URL is
  // also set (the emailed link needs an origin to point the client at).
  const resetAudience = env.AUTH_RESET_AUDIENCE ?? 'reset';
  const signReset = authSecret
    ? (accountId: string, pwfp: string): Promise<string> =>
        signResetToken(
          { accountId, pwfp },
          { key: hmacSecret(authSecret), algorithm: 'HS256', issuer, audience: resetAudience },
          { ttlSeconds: RESET_TOKEN_TTL_SEC },
        )
    : undefined;
  const verifyReset = authSecret
    ? async (token: string): Promise<{ accountId: string; pwfp: string } | null> => {
        const r = await verifyResetToken(token, {
          key: hmacSecret(authSecret),
          algorithms: ['HS256'],
          issuer,
          audience: resetAudience,
          maxTokenAgeSec: RESET_TOKEN_TTL_SEC,
        });
        return r.ok ? r.claim : null;
      }
    : undefined;
  const resetBaseUrl = env.RESET_BASE_URL || undefined;

  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : undefined;

  // A FACTORY, not one instance: each match needs its own gate (per-match sequence + receipts).
  const gateEnabled = env.GATE === '1' || env.GATE === 'true';
  const gateFactory = gateEnabled
    ? (): ActionGate => new ActionGate({ payloadValidator: isValidActionPayload })
    : undefined;

  return {
    auth,
    allowedOrigins,
    signToken,
    signSession,
    verifySession,
    signReset,
    verifyReset,
    resetBaseUrl,
    gateFactory,
  };
}
