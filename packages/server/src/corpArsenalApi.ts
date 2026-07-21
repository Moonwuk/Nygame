import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Identity } from './matchApi';
import type { CorpArsenalService } from './corpArsenalService';

/**
 * Corp-arsenal rentals HTTP API (ARS-6) — session-gated like the corp/medal APIs
 * (the acting identity comes from the session, never the payload).
 *
 *   POST /corp-arsenal/rent  {corpId, itemId, matchupId, accountId}
 *     Hand a corp-owned item to a rostered fighter for one war (head/officer only).
 */

export interface CorpArsenalApiDeps {
  service: CorpArsenalService;
  identify(request: FastifyRequest): Promise<Identity | null>;
}

const STATUS: Record<string, number> = {
  E_FORBIDDEN: 403,
  E_NOT_CORP_ITEM: 404,
  E_NO_MATCHUP: 404,
  E_NOT_PARTY: 403,
  E_ROSTER_LOCKED: 409,
  E_NOT_ROSTERED: 409,
  E_ALREADY_RENTED: 409,
  E_BAD_REQUEST: 400,
};

export function registerCorpArsenalApi(app: FastifyInstance, deps: CorpArsenalApiDeps): void {
  const identified = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | null> => {
    const who = await deps.identify(request);
    if (!who) void reply.code(401);
    return who;
  };

  app.post('/corp-arsenal/rent', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    const body = request.body as
      | { corpId?: unknown; itemId?: unknown; matchupId?: unknown; accountId?: unknown }
      | null;
    if (
      typeof body?.corpId !== 'string' ||
      typeof body?.itemId !== 'string' ||
      typeof body?.matchupId !== 'string' ||
      typeof body?.accountId !== 'string'
    ) {
      void reply.code(400);
      return { error: 'E_BAD_REQUEST' as const };
    }
    const result = await deps.service.rentOut(who, body.corpId, body.itemId, body.matchupId, body.accountId);
    if (!result.ok) {
      void reply.code(STATUS[result.code] ?? 400);
      return { error: result.code };
    }
    return { ok: true };
  });
}
