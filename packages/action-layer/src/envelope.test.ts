import { describe, expect, it } from 'vitest';
import {
  authorizeActionEnvelope,
  createActionEnvelope,
  validateActionEnvelope,
} from './envelope';

const session = { matchId: 'match-1', playerId: 'p1', sessionId: 'mobile' };

function envelope(seq = 1) {
  return createActionEnvelope({
    ...session,
    clientSeq: seq,
    issuedAt: 1000,
    type: 'fleet.move',
    payload: { fleetId: 'f1', to: 'NEXUS' },
  });
}

describe('action envelopes', () => {
  it('validates a canonical envelope and core action id', () => {
    const result = validateActionEnvelope(envelope());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.code);
    expect(result.value.action).toMatchObject({
      id: 'mobile:p1:1',
      playerId: 'p1',
      type: 'fleet.move',
    });
  });

  it('rejects malformed payloads before authorization', () => {
    const result = validateActionEnvelope({ ...envelope(), action: { type: 'fleet.move' } });

    expect(result).toEqual({ ok: false, code: 'E_BAD_PAYLOAD' });
  });

  it('rejects mismatched idempotency key components', () => {
    const bad = {
      ...envelope(),
      actionId: 'mobile:p2:1',
      action: { ...envelope().action, id: 'mobile:p2:1' },
    };

    expect(validateActionEnvelope(bad)).toEqual({ ok: false, code: 'E_BAD_ACTION_ID' });
  });

  it('rejects action fields that disagree with the envelope', () => {
    const bad = { ...envelope(), action: { ...envelope().action, playerId: 'p2' } };

    expect(validateActionEnvelope(bad)).toEqual({ ok: false, code: 'E_BAD_ACTION_ID' });
  });

  it('authorizes only the active match/player/session tuple', () => {
    const valid = envelope();

    expect(authorizeActionEnvelope(valid, session)).toMatchObject({ ok: true });
    expect(authorizeActionEnvelope(valid, { ...session, playerId: 'p2' })).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
  });
});
