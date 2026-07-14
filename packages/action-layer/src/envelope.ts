import { parseActionId, type Action, type PlayerId } from '@void/shared-core';
import { z } from 'zod';
import { fail, ok, type ActionLayerResult } from './errors';

export const ACTION_ENVELOPE_SCHEMA_VERSION = 1;

export interface ActionEnvelope {
  schemaVersion: typeof ACTION_ENVELOPE_SCHEMA_VERSION;
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
  clientSeq: number;
  actionId: string;
  issuedAt: number;
  action: Action;
}

export interface ActionSession {
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
}

const ActionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  playerId: z.string().min(1),
  payload: z.unknown(),
  issuedAt: z.number().finite(),
});

const EnvelopeSchema = z.object({
  schemaVersion: z.literal(ACTION_ENVELOPE_SCHEMA_VERSION),
  matchId: z.string().min(1),
  playerId: z.string().min(1),
  sessionId: z.string().min(1),
  clientSeq: z.number().int().nonnegative().safe(),
  actionId: z.string().min(1),
  issuedAt: z.number().finite(),
  action: ActionSchema,
});

export function validateActionEnvelope(raw: unknown): ActionLayerResult<ActionEnvelope> {
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) return fail('E_BAD_PAYLOAD');

  const envelope = parsed.data;
  const parts = parseActionId(envelope.actionId);
  if (!parts) return fail('E_BAD_ACTION_ID');

  if (
    parts.session !== envelope.sessionId ||
    parts.player !== envelope.playerId ||
    parts.sequence !== envelope.clientSeq ||
    envelope.action.id !== envelope.actionId ||
    envelope.action.playerId !== envelope.playerId ||
    envelope.action.issuedAt !== envelope.issuedAt
  ) {
    return fail('E_BAD_ACTION_ID');
  }

  return ok(envelope);
}

export function authorizeActionEnvelope(
  envelope: ActionEnvelope,
  session: ActionSession,
): ActionLayerResult<ActionEnvelope> {
  if (
    envelope.matchId !== session.matchId ||
    envelope.playerId !== session.playerId ||
    envelope.sessionId !== session.sessionId
  ) {
    return fail('E_FORBIDDEN');
  }
  return ok(envelope);
}

/** Builds a v1 envelope around an intent. The factory is the ONLY owner of
 *  `schemaVersion` — callers cannot (and need not) pass one. */
export function createActionEnvelope(
  input: Omit<ActionEnvelope, 'schemaVersion' | 'actionId' | 'action'> & {
    type: string;
    payload: unknown;
  },
): ActionEnvelope {
  const actionId = `${input.sessionId}:${input.playerId}:${input.clientSeq}`;
  return {
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    matchId: input.matchId,
    playerId: input.playerId,
    sessionId: input.sessionId,
    clientSeq: input.clientSeq,
    actionId,
    issuedAt: input.issuedAt,
    action: {
      id: actionId,
      type: input.type,
      playerId: input.playerId,
      payload: input.payload,
      issuedAt: input.issuedAt,
    },
  };
}
