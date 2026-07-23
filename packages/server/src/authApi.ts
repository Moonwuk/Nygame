import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionClaim } from './auth';
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

/** Deliver a message (today: the password-reset link). Kept behind an interface so the
 *  transport is swappable — the default (see `logMailer`) just logs the link, and a real
 *  SMTP/API mailer is wired via config when the deployment has one. */
export type Mailer = (msg: { to: string; subject: string; text: string }) => Promise<void>;

/** The default mailer: write to stderr. The message BODY carries a live reset link (a
 *  15-minute account-takeover token), so by default we log only metadata (to/subject) —
 *  enabling recovery without a real transport must not spill takeover tokens into the
 *  logs. A playtest admin who genuinely needs the link opts in with `MAILER_LOG_BODY=1`;
 *  production wires a real transport instead (there is otherwise no way to deliver mail
 *  from this repo). */
const logMailer: Mailer = (msg) => {
  const body =
    process.env.MAILER_LOG_BODY === '1'
      ? `\n  ${msg.text}`
      : ' (body hidden — set MAILER_LOG_BODY=1 to log it, or wire a real mailer)';
  process.stderr.write(`[mail] to=${msg.to} · ${msg.subject}${body}\n`);
  return Promise.resolve();
};

/** Password fingerprint: a short digest of the password hash. When the password changes
 *  the hash — and thus this fingerprint — changes. Two consumers: single-use reset tokens
 *  (a spent/stale token stops matching → dead, no token store needed) and session freshness
 *  (`liveSession` below re-checks a session's stamped fingerprint against the current hash,
 *  so a reset revokes older sessions). No server-side state either way. */
export const pwFingerprint = (passHash: string): string =>
  createHash('sha256').update(passHash).digest('base64url').slice(0, 22);

/** Re-check a signature-verified session against the CURRENT password: the account must
 *  still exist and its password hash must still fingerprint to the session's stamped `pwfp`.
 *  A password change (today, a `/auth/reset`) breaks the match, so an older session — a
 *  stolen one that outlived the reset included — no longer authenticates. Returns the
 *  claim on success, `null` on any failure (fail-secure). Meant for the identity gate
 *  (join/create), not every request: it costs one indexed `findById`. */
export async function liveSession(
  claim: SessionClaim,
  users: Pick<UserStore, 'findById'>,
): Promise<SessionClaim | null> {
  const user = await users.findById(claim.accountId);
  if (!user || pwFingerprint(user.passHash) !== claim.pwfp) return null;
  return claim;
}

export interface AuthApiDeps {
  users: UserStore;
  /** Mint a session token for an authenticated account (from serverConfig). `pwfp` binds
   *  the session to the current password (see `liveSession`) so a reset revokes it. */
  signSession(accountId: string, login: string, pwfp: string): Promise<string>;
  /** Recovery (SE-1.x): mint a short-lived reset token bound to `pwfp`. Present together
   *  with `resetBaseUrl` mounts `/auth/recover` + `/auth/reset`; absent leaves them off. */
  signReset?(accountId: string, pwfp: string): Promise<string>;
  /** Validate a reset token (returns the account + fingerprint, or null on any failure). */
  verifyReset?(token: string): Promise<{ accountId: string; pwfp: string } | null>;
  /** Client origin the emailed reset link points at: `${resetBaseUrl}/?reset=<token>`. */
  resetBaseUrl?: string;
  /** Reset-link transport. Omitted ⇒ `logMailer` (logs the link). */
  sendMail?: Mailer;
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

/** Login: 3–24 chars — any unicode letters/digits plus `_`/`-`. It doubles as the
 *  display nick and the seat identity, and the game's suggested callsigns are
 *  cyrillic with a dash («Носорог-1»), so ASCII-only here would reject the golden
 *  path. `\p{L}\p{N}` keeps it log-safe (no spaces/emoji/control chars); dedup is
 *  case-insensitive via lower(login) in the stores. */
const LOGIN_RE = /^[\p{L}\p{N}_-]{3,24}$/u;
/** Password: 8–128 chars. The cap bounds the KDF input (DoS hygiene); no composition
 *  rules — length beats complexity theatre. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
/** Recovery email: a pragmatic shape check (one `@`, a dotted domain, no whitespace) +
 *  a length cap — real validity is proven only by a deliverable message, not a regex. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

/** Parse an OPTIONAL email field: `undefined` = not supplied (fine — registration stays
 *  emailless), a valid string = accepted, `null` = supplied but malformed (a 400). */
function parseEmail(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > EMAIL_MAX || !EMAIL_RE.test(v)) return null;
  return v;
}

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
    const email = parseEmail((request.body as { email?: unknown } | null)?.email);
    if (!creds || email === null) {
      void reply.code(400);
      return { error: 'E_BAD_CREDENTIALS' as const };
    }
    const passHash = await hashPassword(creds.password, deps.scryptParams);
    const created = await deps.users.createUser(creds.login, passHash, email);
    if (!created.ok) {
      void reply.code(409);
      return { error: created.code }; // E_LOGIN_TAKEN | E_EMAIL_TAKEN
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
    const token = await deps.signSession(created.userId, creds.login, pwFingerprint(passHash));
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
    const token = await deps.signSession(user.userId, user.login, pwFingerprint(user.passHash));
    return { accountId: user.userId, login: user.login, token };
  });

  // --- Password recovery (SE-1.x): request a reset link, then spend it -----------------
  // Mounted only when the deployment wired reset-token signing + a client origin. Both
  // routes share the register/login per-IP budget (guessing/spray brake) and are
  // fail-secure: `recover` ALWAYS 200s (no account-existence oracle); `reset` yields a
  // uniform `E_AUTH` for any bad / expired / already-spent token.
  if (deps.signReset && deps.verifyReset && deps.resetBaseUrl) {
    const signReset = deps.signReset;
    const verifyReset = deps.verifyReset;
    // Strip trailing slashes WITHOUT a backtracking regex: `/\/+$/` is a
    // quadratic ReDoS on a run of '/' (CodeQL js/polynomial-redos). resetBaseUrl
    // is deployment config, not request data, so the practical risk is nil — but
    // a linear trim keeps the auth surface clear of the pattern altogether.
    const base = deps.resetBaseUrl;
    let baseEnd = base.length;
    while (baseEnd > 0 && base[baseEnd - 1] === '/') baseEnd -= 1;
    const resetBaseUrl = base.slice(0, baseEnd);
    const sendMail = deps.sendMail ?? logMailer;

    app.post('/auth/recover', async (request: FastifyRequest, reply: FastifyReply) => {
      if (rateLimited(request.ip)) {
        void reply.code(429);
        return { error: 'E_RATE_LIMIT' as const };
      }
      const email = parseEmail((request.body as { email?: unknown } | null)?.email);
      if (!email) {
        void reply.code(400);
        return { error: 'E_BAD_CREDENTIALS' as const };
      }
      // Anti-enumeration: the response is identical whether or not the email is on file —
      // only a real match actually mints + mails a link.
      const user = await deps.users.findUserByEmail(email);
      if (user?.email) {
        const token = await signReset(user.userId, pwFingerprint(user.passHash));
        const link = `${resetBaseUrl}/?reset=${encodeURIComponent(token)}`;
        try {
          await sendMail({
            to: user.email,
            subject: 'Void Dominion — сброс пароля',
            text: `Ссылка для сброса пароля (действует 15 минут):\n${link}\n\nЕсли вы не запрашивали сброс — проигнорируйте это письмо.`,
          });
        } catch {
          /* never surface a delivery failure to the caller (no oracle, no 500) */
        }
      }
      return { ok: true as const };
    });

    app.post('/auth/reset', async (request: FastifyRequest, reply: FastifyReply) => {
      if (rateLimited(request.ip)) {
        void reply.code(429);
        return { error: 'E_RATE_LIMIT' as const };
      }
      const body = (request.body ?? {}) as { token?: unknown; password?: unknown };
      const token = typeof body.token === 'string' ? body.token : '';
      const password = body.password;
      if (
        !token ||
        typeof password !== 'string' ||
        password.length < PASSWORD_MIN ||
        password.length > PASSWORD_MAX
      ) {
        void reply.code(400);
        return { error: 'E_BAD_CREDENTIALS' as const };
      }
      const claim = await verifyReset(token);
      // Single-use: re-fetch the account and re-check the fingerprint against the CURRENT
      // hash — a token already spent (or minted before another change) no longer matches.
      const user = claim ? await deps.users.findById(claim.accountId) : null;
      if (!claim || !user || pwFingerprint(user.passHash) !== claim.pwfp) {
        void reply.code(401);
        return { error: 'E_AUTH' as const };
      }
      const passHash = await hashPassword(password, deps.scryptParams);
      await deps.users.setPassword(user.userId, passHash);
      // Reset IS a login: hand back a fresh session (stamped with the NEW password's
      // fingerprint, so it survives while every pre-reset session is now revoked).
      const sessionToken = await deps.signSession(user.userId, user.login, pwFingerprint(passHash));
      return { accountId: user.userId, login: user.login, token: sessionToken };
    });
  }
}
