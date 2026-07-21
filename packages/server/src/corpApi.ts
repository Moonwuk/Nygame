import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CorpErrorCode, CorpService } from './corpService';
import type { Identity } from './matchApi';
import { slidingWindowIpLimiter } from './rateLimit';

/**
 * CORP-0 — the corporation HTTP API. Every route requires a session (`Authorization:
 * Bearer` — the identity the intents act as comes from the session, NEVER from the
 * payload), so the API is only registered on auth-enabled servers. The service
 * enforces the rights matrix; this layer only parses, identifies, rate-limits and
 * maps stable codes to HTTP statuses.
 *
 *   GET  /corps                    browse list (name + member count)
 *   GET  /corps/me                 my corp + membership (nulls when corpless)
 *   GET  /corps/:id                corp detail + ranked member list
 *   GET  /corps/:id/audit          audit trail (head/officer only)
 *   GET  /corps/:id/ready-players   accountIds flagged ready — AVA-6 setRoster
 *        {accountIds}              eligibility set (head/officer only)
 *   POST /corps        {name}      create — the founder becomes the head
 *   POST /corps/:id/:intent        apply·cancel·accept·decline·kick·role·transfer·
 *        {target?, role?}          leave·disband (see corpService.ts)
 */

export interface CorpApiDeps {
  service: CorpService;
  /** Resolve the caller's identity from the session token — REQUIRED: corp intents
   *  are identity-bound, there is no anonymous fallback. */
  identify(request: FastifyRequest): Promise<Identity | null>;
  /** Injectable clock + limits for the per-IP rate limit (deterministic tests). */
  now?: () => number;
  rateMax?: number;
  rateWindowMs?: number;
}

const STATUS: Record<CorpErrorCode, number> = {
  E_BAD_NAME: 400,
  E_BAD_ROLE: 400,
  E_BAD_TARGET: 400,
  E_NO_CORP: 404,
  E_NOT_MEMBER: 404,
  E_NOT_APPLIED: 404,
  E_NAME_TAKEN: 409,
  E_IN_CORP: 409,
  E_HEAD_MUST_TRANSFER: 409,
  E_FORBIDDEN: 403,
};

/** Social actions are a spam surface (docs/corporations.md §6 anti-abuse), so the
 *  WRITE routes share a per-IP sliding-window budget — the same bounded-map limiter
 *  as the auth/match APIs (reads stay free; the coarse scope limit still covers them). */
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_IPS = 10_000;

const INTENTS = [
  'apply',
  'cancel',
  'accept',
  'decline',
  'kick',
  'role',
  'transfer',
  'leave',
  'disband',
] as const;
type CorpIntent = (typeof INTENTS)[number];

/** Intents that act on another account and therefore require a `target` in the body. */
const TARGETED: ReadonlySet<CorpIntent> = new Set(['accept', 'decline', 'kick', 'role', 'transfer']);

export function registerCorpApi(app: FastifyInstance, deps: CorpApiDeps): void {
  const service = deps.service;
  const now = deps.now ?? ((): number => Date.now());
  const rateMax = deps.rateMax ?? RATE_MAX;
  const rateWindowMs = deps.rateWindowMs ?? RATE_WINDOW_MS;
  const rateLimited = slidingWindowIpLimiter({
    now,
    max: rateMax,
    windowMs: rateWindowMs,
    maxIps: RATE_MAX_IPS,
  });

  /** Session gate shared by every route: identity or a uniform 401. */
  const identified = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | null> => {
    const who = await deps.identify(request);
    if (!who) void reply.code(401);
    return who;
  };

  const failed = (reply: FastifyReply, code: CorpErrorCode): { error: CorpErrorCode } => {
    void reply.code(STATUS[code]);
    return { error: code };
  };

  app.get('/corps', async (request, reply) => {
    if (!(await identified(request, reply))) return { error: 'E_AUTH' as const };
    return { corps: await service.list() };
  });

  app.get('/corps/me', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    return service.mine(who);
  });

  app.get('/corps/:id', async (request, reply) => {
    if (!(await identified(request, reply))) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const result = await service.detail(id);
    if (!result.ok) return failed(reply, result.code);
    return { corp: result.corp, members: result.members };
  });

  app.get('/corps/:id/audit', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const result = await service.auditLog(who, id);
    if (!result.ok) return failed(reply, result.code);
    return { audit: result.audit };
  });

  app.get('/corps/:id/ready-players', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const result = await service.readyPlayers(who, id);
    if (!result.ok) return failed(reply, result.code);
    return { accountIds: result.accountIds };
  });

  app.post('/corps', async (request, reply) => {
    if (rateLimited(request.ip)) {
      void reply.code(429);
      return { error: 'E_RATE_LIMIT' as const };
    }
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const name = (request.body as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') return failed(reply, 'E_BAD_NAME');
    const result = await service.create(who, name);
    if (!result.ok) return failed(reply, result.code);
    void reply.code(201);
    return { corpId: result.corpId };
  });

  app.post(`/corps/:id/:intent(${INTENTS.join('|')})`, async (request, reply) => {
    if (rateLimited(request.ip)) {
      void reply.code(429);
      return { error: 'E_RATE_LIMIT' as const };
    }
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id, intent } = request.params as { id: string; intent: CorpIntent };
    const body = (request.body ?? {}) as { target?: unknown; role?: unknown };
    const target = typeof body.target === 'string' ? body.target : null;
    if (TARGETED.has(intent) && !target) return failed(reply, 'E_BAD_TARGET');

    const result = await dispatch(service, intent, who, id, target, body.role);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });
}

function dispatch(
  service: CorpService,
  intent: CorpIntent,
  who: Identity,
  corpId: string,
  target: string | null,
  role: unknown,
): ReturnType<CorpService['apply']> {
  switch (intent) {
    case 'apply':
      return service.apply(who, corpId);
    case 'cancel':
      return service.cancel(who, corpId);
    case 'accept':
      return service.accept(who, corpId, target ?? '');
    case 'decline':
      return service.decline(who, corpId, target ?? '');
    case 'kick':
      return service.kick(who, corpId, target ?? '');
    case 'role':
      return service.setRole(who, corpId, target ?? '', typeof role === 'string' ? role : '');
    case 'transfer':
      return service.transfer(who, corpId, target ?? '');
    case 'leave':
      return service.leave(who, corpId);
    case 'disband':
      return service.disband(who, corpId);
  }
}
