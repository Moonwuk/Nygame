import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword, decoyHash, type ScryptParams } from './password';
import type { UserStore } from './store';
import { slidingWindowIpLimiter } from './rateLimit';

/**
 * SE-1.x — login+password authentication over HTTP: `POST /auth/register` and
 * `POST /auth/login`. Success hands the client a SESSION token (see auth.ts) — the
 * "who you are" credential the match API then exchanges for per-match join tokens.
 *
 * Fail-secure by construction (invariant #4):
 *  - login failures are UNIFORM: unknown login and wrong password both return the same
 *    401 `E_AUTH`, and an unknown login still burns one scrypt derivation (decoy hash),
 *    so neither the body nor the response time enumerates accounts;
 *  - malformed input → 400 `E_BAD_CREDENTIALS` with no field-level detail;
 *  - both routes sit behind a per-IP sliding-window rate limit (online-guessing brake) —
 *    a bounded map, evicted FIFO, so an address-spraying client can't grow memory.
 */

export interface AuthApiDeps {
  users: UserStore;
  /** Mint a session token for an authenticated account (from serverConfig). */
  signSession(accountId: string, login: string): Promise<string>;
  /** Post-registration hook (e.g. the starter-arsenal grant, ARS-2), awaited before
   *  the 201 so the account's first read sees its grant. MUST be resilient: a throw
   *  is swallowed here (registration already succeeded — never fail it for a
   *  side-effect), so the hook owns its retries/logging; idempotent hooks are safe
   *  to re-run out of band. */
  onRegistered?(accountId: string, login: string): Promise<void>;
  /** Injectable clock + limits for deterministic tests. */
  now?: () => number;
  rateMax?: number;
  rateWindowMs?: number;
  /** Test-only: cheaper scrypt cost. Production callers omit it (default cost). */
  scryptParams?: ScryptParams;
}

/** Login: 3–24 chars, letters/digits/underscore — it doubles as the display nick and
 *  the seat identity, so keep it URL- and log-safe. */
const LOGIN_RE = /^[a-zA-Z0-9_]{3,24}$/;
/** Password: 8–128 chars. The cap bounds the KDF input (DoS hygiene); no composition
 *  rules — length beats complexity theatre. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const RATE_MAX = 10; // attempts per IP per window (register+login share the budget)
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_IPS = 10_000; // bounded tracker: oldest window evicted first

interface Creds {
  login: string;
  password: string;
}

function parseCreds(body: unknown): Creds | null {
  if (typeof body !== 'object' || body === null) return null;
  const { login, password } = body as { login?: unknown; password?: unknown };
  if (typeof login !== 'string' || !LOGIN_RE.test(login)) return null;
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN ||
    password.length > PASSWORD_MAX
  ) {
    return null;
  }
  return { login, password };
}

export function registerAuthApi(app: FastifyInstance, deps: AuthApiDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  const rateMax = deps.rateMax ?? RATE_MAX;
  const rateWindowMs = deps.rateWindowMs ?? RATE_WINDOW_MS;
  const rateLimited = slidingWindowIpLimiter({
    now,
    max: rateMax,
    windowMs: rateWindowMs,
    maxIps: RATE_MAX_IPS,
  });

  // A decoy hash computed once at startup: login misses verify against it so the
  // "unknown login" path costs one scrypt derivation, same as "wrong password".
  const decoy = decoyHash(deps.scryptParams);

  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    if (rateLimited(request.ip)) {
      void reply.code(429);
      return { error: 'E_RATE_LIMIT' as const };
    }
    const creds = parseCreds(request.body);
    if (!creds) {
      void reply.code(400);
      return { error: 'E_BAD_CREDENTIALS' as const };
    }
    const passHash = await hashPassword(creds.password, deps.scryptParams);
    const created = await deps.users.createUser(creds.login, passHash);
    if (!created.ok) {
      void reply.code(409);
      return { error: created.code };
    }
    // Post-registration side-effects (starter arsenal, ARS-2): awaited so the new
    // account's first read sees them, but NEVER allowed to fail the registration
    // itself — the account exists; an idempotent hook re-runs safely out of band.
    if (deps.onRegistered) {
      try {
        await deps.onRegistered(created.userId, creds.login);
      } catch {
        /* the hook owns its logging/retries */
      }
    }
    // Auto-login: registration IS the first login — hand the session token right away.
    const token = await deps.signSession(created.userId, creds.login);
    void reply.code(201);
    return { accountId: created.userId, login: creds.login, token };
  });

  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    if (rateLimited(request.ip)) {
      void reply.code(429);
      return { error: 'E_RATE_LIMIT' as const };
    }
    const creds = parseCreds(request.body);
    if (!creds) {
      void reply.code(400);
      return { error: 'E_BAD_CREDENTIALS' as const };
    }
    const user = await deps.users.findUser(creds.login);
    // Uniform failure: both paths verify against SOME hash and return the same 401,
    // so account existence leaks neither through the body nor through timing. The
    // decoy verification's result is deliberately discarded — it exists ONLY to
    // cost one scrypt derivation, same as a real check.
    let ok = false;
    if (user) {
      ok = await verifyPassword(creds.password, user.passHash);
    } else {
      await verifyPassword(creds.password, await decoy);
    }
    if (!ok || !user) {
      void reply.code(401);
      return { error: 'E_AUTH' as const };
    }
    const token = await deps.signSession(user.userId, user.login);
    return { accountId: user.userId, login: user.login, token };
  });
}
