import { createHash } from 'node:crypto';
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

/** Deliver a message (today: the password-reset link). Kept behind an interface so the
 *  transport is swappable — the default (see `logMailer`) just logs the link, and a real
 *  SMTP/API mailer is wired via config when the deployment has one. */
export type Mailer = (msg: { to: string; subject: string; text: string }) => Promise<void>;

/** The default mailer: write the message to stderr. Enough for a dev/playtest admin to
 *  retrieve a reset link from the server logs; production overrides it with a real
 *  transport (there is otherwise no way to actually deliver mail from this repo). */
const logMailer: Mailer = (msg) => {
  process.stderr.write(`[mail] to=${msg.to} · ${msg.subject}\n  ${msg.text}\n`);
  return Promise.resolve();
};

/** Password fingerprint for single-use reset tokens: a short digest of the hash. When the
 *  password changes the hash — and thus this fingerprint — changes, so a spent or stale
 *  reset token no longer matches and is dead (no server-side token store needed). */
const pwFingerprint = (passHash: string): string =>
  createHash('sha256').update(passHash).digest('base64url').slice(0, 22);

export interface AuthApiDeps {
  users: UserStore;
  /** Mint a session token for an authenticated account (from serverConfig). */
  signSession(accountId: string, login: string): Promise<string>;
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

  // --- Password recovery (SE-1.x): request a reset link, then spend it -----------------
  // Mounted only when the deployment wired reset-token signing + a client origin. Both
  // routes share the register/login per-IP budget (guessing/spray brake) and are
  // fail-secure: `recover` ALWAYS 200s (no account-existence oracle); `reset` yields a
  // uniform `E_AUTH` for any bad / expired / already-spent token.
  if (deps.signReset && deps.verifyReset && deps.resetBaseUrl) {
    const signReset = deps.signReset;
    const verifyReset = deps.verifyReset;
    const resetBaseUrl = deps.resetBaseUrl.replace(/\/+$/, '');
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
      // Reset IS a login: hand back a fresh session so the client drops straight in.
      const sessionToken = await deps.signSession(user.userId, user.login);
      return { accountId: user.userId, login: user.login, token: sessionToken };
    });
  }
}
