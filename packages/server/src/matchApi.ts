import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MatchRegistry } from './matchRegistry';

/**
 * SV-2.4 — the minimal match create/join HTTP API, so players can actually enter a match
 * on the authenticated path: create a match, then exchange a nick for a join token that
 * gates the WebSocket handshake (SE-0.1).
 *
 * DEV-GRADE, and deliberately minimal (no excess): creation is unauthenticated and a seat
 * is claimed first-come by nick (same identity model as the `?nick=` WS login) — NOT a real
 * authorization boundary. Real "who may create / who owns this seat" needs external identity
 * (OIDC — accounts-roadmap) and belongs to a later brick; gate this API behind that + a
 * create rate-limit before any public deployment. The join TOKEN is a real boundary at the
 * WS layer; who is handed one here is not yet.
 */

export interface CreatedMatch {
  matchId: string;
  /** The seat player ids a client can `join` (e.g. `['green', 'red']`). */
  seats: string[];
}

export interface JoinResult {
  playerId: string;
  /** A short-lived join token to pass as `?token=` on the WS handshake. */
  token: string;
}

/** A stable failure from `join`, mapped to an HTTP status by the route. */
export type JoinFailure = { error: 'E_NO_MATCH' | 'E_MATCH_FULL' | 'E_AUTH_DISABLED' };

export interface MatchApiDeps {
  /** Seed + persist a new match; returns its id and seat player ids. */
  createMatch(): Promise<CreatedMatch>;
  /** Resolve `nick` to a seat in `matchId` and mint its join token, or a stable failure:
   *  the match does not exist, every seat is taken, or token auth is not configured. */
  join(matchId: string, nick: string): Promise<JoinResult | JoinFailure>;
}

const STATUS: Record<JoinFailure['error'], number> = {
  E_NO_MATCH: 404,
  E_MATCH_FULL: 409,
  E_AUTH_DISABLED: 501,
};

export function registerMatchApi(app: FastifyInstance, deps: MatchApiDeps): void {
  app.post('/matches', () => deps.createMatch());

  app.get('/matches/:id/join', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const nick = (request.query as { nick?: string }).nick;
    if (typeof nick !== 'string' || nick.trim() === '') {
      void reply.code(400);
      return { error: 'E_NICK_REQUIRED' as const };
    }
    const result = await deps.join(id, nick.trim());
    if ('error' in result) void reply.code(STATUS[result.error]);
    return result;
  });
}

/**
 * The match-browser read-model + archive intents (docs/main-menu.md §2), served beside
 * the create/join API. A server projection — the client only reads it (A10/fog rule);
 * archive is fail-secure per-player (participants only, stable codes).
 */
export function registerBrowserApi(app: FastifyInstance, registry: MatchRegistry): void {
  // A repeated `?nick=a&nick=b` parses to an array — treat anything non-string as
  // absent (fail-secure: anonymous view / E_FORBIDDEN), like the join route's check.
  const nickOf = (request: FastifyRequest): string | null => {
    const nick = (request.query as { nick?: unknown }).nick;
    return typeof nick === 'string' ? nick : null;
  };

  // The three tabs (available/active/archived) for one viewer (`?nick=`).
  app.get('/matches', (request: FastifyRequest) => registry.list(nickOf(request)));

  const archive = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const { id, intent } = request.params as { id: string; intent: string };
    const nick = nickOf(request) ?? '';
    const result =
      intent === 'archive'
        ? await registry.archive(id, nick)
        : await registry.unarchive(id, nick);
    if (!result.ok) void reply.code(result.code === 'E_NO_MATCH' ? 404 : 403);
    return result;
  };
  app.post('/matches/:id/:intent(archive|unarchive)', archive);
}
