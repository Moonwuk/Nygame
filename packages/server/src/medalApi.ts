import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MedalErrorCode, MedalService } from './medalService';
import type { Identity } from './matchApi';

/**
 * Medals HTTP API (corporations.md §3) — session-gated like the corp/AvA APIs (the acting
 * identity comes from the session, never the payload), so it is only registered where auth
 * is on. Reads a player's earned medals + the catalog; the grant intent is a head/officer
 * action the service authorizes and re-checks eligibility for.
 *
 *   GET  /medals                 the catalog (names + conditions)
 *   GET  /medals/me              my earned medals (session identity)
 *   GET  /medals/eligible        medals my corp currently qualifies to grant
 *   POST /medals/grant  {target, medalId}   award a manual medal (head/officer)
 */

export interface MedalApiDeps {
  service: MedalService;
  identify(request: FastifyRequest): Promise<Identity | null>;
  now?: () => number;
  rateMax?: number;
  rateWindowMs?: number;
}

const STATUS: Record<MedalErrorCode, number> = {
  E_NO_MEDAL: 404,
  E_NOT_MANUAL: 409,
  E_FORBIDDEN: 403,
  E_NOT_MEMBER: 404,
  E_NOT_ELIGIBLE: 409,
};

const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_IPS = 10_000;

export function registerMedalApi(app: FastifyInstance, deps: MedalApiDeps): void {
  const service = deps.service;
  const now = deps.now ?? ((): number => Date.now());
  const rateMax = deps.rateMax ?? RATE_MAX;
  const rateWindowMs = deps.rateWindowMs ?? RATE_WINDOW_MS;
  const attempts = new Map<string, { n: number; since: number }>();

  const rateLimited = (ip: string): boolean => {
    const t = now();
    const c = attempts.get(ip);
    if (!c || t - c.since >= rateWindowMs) {
      attempts.delete(ip);
      attempts.set(ip, { n: 1, since: t });
      if (attempts.size > RATE_MAX_IPS) {
        const oldest = attempts.keys().next().value;
        if (oldest !== undefined) attempts.delete(oldest);
      }
      return false;
    }
    c.n += 1;
    return c.n > rateMax;
  };

  const identified = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | null> => {
    const who = await deps.identify(request);
    if (!who) void reply.code(401);
    return who;
  };

  app.get('/medals', async (request, reply) => {
    if (!(await identified(request, reply))) return { error: 'E_AUTH' as const };
    return { medals: service.catalogList() };
  });

  app.get('/medals/me', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    return { medals: await service.medalsOf(who.accountId) };
  });

  app.get('/medals/eligible', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    return { eligible: await service.eligibleMedals(who) };
  });

  app.post('/medals/grant', async (request, reply) => {
    if (rateLimited(request.ip)) {
      void reply.code(429);
      return { error: 'E_RATE_LIMIT' as const };
    }
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const body = request.body as { target?: unknown; medalId?: unknown } | null;
    if (typeof body?.target !== 'string' || typeof body?.medalId !== 'string') {
      void reply.code(400);
      return { error: 'E_BAD_REQUEST' as const };
    }
    const result = await service.grant(who, body.target, body.medalId);
    if (!result.ok) {
      void reply.code(STATUS[result.code]);
      return { error: result.code };
    }
    return result;
  });
}
