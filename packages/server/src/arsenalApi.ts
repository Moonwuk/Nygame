import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Identity } from './matchApi';
import type { ArsenalStore } from './store';

/**
 * ARS-5 — read-only arsenal HTTP API: the hub witryna needs the account's own
 * collection to render (grid + filters), which nothing exposed to the client
 * before now (ARS-1..4 were server/core-only). Session-gated like the corp/medal
 * APIs — the acting identity comes from the session, never a query param, so a
 * player can only ever read their own items.
 *
 *   GET /arsenal/me   my raw items (kind/form/grade/durability/origin — everything
 *                     the witryna needs; the coarse `PlayerArsenal` snapshot used by
 *                     the core build gate is a separate, narrower projection).
 */

export interface ArsenalApiDeps {
  store: ArsenalStore;
  identify(request: FastifyRequest): Promise<Identity | null>;
}

export function registerArsenalApi(app: FastifyInstance, deps: ArsenalApiDeps): void {
  const identified = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | null> => {
    const who = await deps.identify(request);
    if (!who) void reply.code(401);
    return who;
  };

  app.get('/arsenal/me', async (request, reply) => {
    const who = await identified(request, reply);
    if (!who) return { error: 'E_AUTH' as const };
    return { items: await deps.store.listOf(who.accountId) };
  });
}
