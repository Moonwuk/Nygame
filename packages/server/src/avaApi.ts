import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AvaErrorCode, AvaService } from './avaService';
import type { Identity } from './matchApi';

/**
 * AVA-2/3/4 — the Alliance-vs-Alliance HTTP API. Like the corp API, every route needs
 * a session (`Authorization: Bearer`; the acting identity comes from the session, NEVER
 * the payload), so it is only registered on auth-enabled servers. The service enforces
 * the rights matrix; this layer parses, identifies, rate-limits and maps stable codes.
 *
 *   GET  /ava/pool                     ready-corp pool (name + influence + members)
 *   GET  /ava/challenges               my incoming + outgoing challenges
 *   POST /ava/ready/corp    (+clear)   corp readiness flag (head only)
 *   POST /ava/ready/player  (+clear)   player readiness flag (own corp member)
 *   POST /ava/challenge     {target}   challenge a ready corp (head; spends influence)
 *   POST /ava/challenge/:id/accept     accept → S2 matchup (target head)
 *   POST /ava/challenge/:id/decline    decline → refund (target head)
 *   GET  /ava/matchup/:id              my side's roster + both headcounts (AVA-6)
 *   POST /ava/matchup/:id/roster       {players[]} curate my side (head/officer)
 *   POST /ava/matchup/:id/join         self-enroll during the pause window (member)
 */

export interface AvaApiDeps {
  service: AvaService;
  /** Resolve the caller's identity from the session token — REQUIRED (no anon path). */
  identify(request: FastifyRequest): Promise<Identity | null>;
  now?: () => number;
  rateMax?: number;
  rateWindowMs?: number;
}

const STATUS: Record<AvaErrorCode, number> = {
  E_FORBIDDEN: 403,
  E_NOT_READY: 409,
  E_SELF_CHALLENGE: 400,
  E_ALREADY_CHALLENGED: 409,
  E_INSUFFICIENT: 402,
  E_NO_CHALLENGE: 404,
  E_CHALLENGE_CLOSED: 409,
  E_NOT_FLAGGED: 409,
  E_ROSTER_FULL: 409,
  E_ROSTER_LOCKED: 409,
  E_WINDOW_CLOSED: 409,
  E_MATCHUP_CLOSED: 409,
};

/** AvA writes are a spam surface like the corp API — share the same per-IP budget. */
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_IPS = 10_000;

export function registerAvaApi(app: FastifyInstance, deps: AvaApiDeps): void {
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

  const failed = (reply: FastifyReply, code: AvaErrorCode): { error: AvaErrorCode } => {
    void reply.code(STATUS[code]);
    return { error: code };
  };

  /** Rate-limit + identify, shared by every write route. Returns the identity or null
   *  (the caller returns immediately when null — the reply code is already set). */
  const guardedWrite = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | null> => {
    if (rateLimited(request.ip)) {
      void reply.code(429);
      return null;
    }
    return identified(request, reply);
  };

  app.get('/ava/pool', async (request, reply) => {
    if (!(await identified(request, reply))) return { error: 'E_AUTH' as const };
    return { pool: await service.pool() };
  });

  app.get('/ava/challenges', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    return { challenges: await service.challengesFor(who) };
  });

  app.post('/ava/ready/corp', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const result = await service.setCorpReady(who);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  app.post('/ava/ready/corp/clear', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const result = await service.clearCorpReady(who);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  app.post('/ava/ready/player', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const result = await service.setPlayerReady(who);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  app.post('/ava/ready/player/clear', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const result = await service.clearPlayerReady(who);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  app.post('/ava/challenge', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const target = (request.body as { target?: unknown } | null)?.target;
    if (typeof target !== 'string' || target.length === 0) return failed(reply, 'E_NO_CHALLENGE');
    const result = await service.challenge(who, target);
    if (!result.ok) return failed(reply, result.code);
    void reply.code(201);
    return { id: result.id };
  });

  app.post('/ava/challenge/:id/accept', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const result = await service.accept(who, id);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  app.post('/ava/challenge/:id/decline', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const result = await service.decline(who, id);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  // ---- AVA-6 · roster window ------------------------------------------------

  app.get('/ava/matchup/:id', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const view = await service.rosterView(who, id);
    if ('ok' in view && !view.ok) return failed(reply, view.code);
    return view;
  });

  app.post('/ava/matchup/:id/roster', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const players = (request.body as { players?: unknown } | null)?.players;
    if (!Array.isArray(players) || players.some((p) => typeof p !== 'string' || p.length === 0)) {
      return failed(reply, 'E_NOT_FLAGGED'); // malformed list — fail-secure, nothing changes
    }
    const result = await service.setRoster(who, id, players as string[]);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });

  app.post('/ava/matchup/:id/join', async (request, reply) => {
    const who = await guardedWrite(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const { id } = request.params as { id: string };
    const result = await service.join(who, id);
    if (!result.ok) return failed(reply, result.code);
    return result;
  });
}
