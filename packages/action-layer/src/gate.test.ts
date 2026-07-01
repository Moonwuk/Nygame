import { describe, expect, it } from 'vitest';
import {
  ACTION_ENVELOPE_SCHEMA_VERSION,
  createActionEnvelope,
  type ActionSession,
} from './envelope';
import { ActionGate } from './gate';

const session: ActionSession = { matchId: 'match-1', playerId: 'p1', sessionId: 'mobile' };

function envelope(clientSeq: number, payload: unknown = { fleetId: 'f1', to: 'NEXUS' }) {
  return createActionEnvelope({
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    ...session,
    clientSeq,
    issuedAt: 1000 + clientSeq,
    type: 'fleet.move',
    payload,
  });
}

describe('ActionGate', () => {
  it('admits a validated, authorized action and records its receipt', () => {
    const gate = new ActionGate({ now: () => 5000 });
    const admitted = gate.admit(envelope(1), session);

    expect(admitted).toMatchObject({ ok: true, value: { status: 'accepted' } });
    if (!admitted.ok || admitted.value.status !== 'accepted') throw new Error('expected accepted');

    const receipt = gate.commit(admitted.value.envelope, { ok: true });

    expect(receipt).toMatchObject({ actionId: 'mobile:p1:1', ok: true, acceptedAt: 5000 });
  });

  it('deduplicates retries by action id so callers do not apply twice', () => {
    const gate = new ActionGate({ now: () => 5000 });
    let applyCount = 0;

    const first = gate.admit(envelope(1), session);
    if (!first.ok || first.value.status !== 'accepted') throw new Error('expected accepted');
    applyCount += 1;
    gate.commit(first.value.envelope, { ok: true });

    const retry = gate.admit(envelope(1), session);

    expect(retry).toMatchObject({ ok: true, value: { status: 'duplicate' } });
    expect(applyCount).toBe(1);
  });

  it('caches failed receipts for stable retry results', () => {
    const gate = new ActionGate({ now: () => 5000 });
    const first = gate.admit(envelope(1), session);
    if (!first.ok || first.value.status !== 'accepted') throw new Error('expected accepted');
    gate.commit(first.value.envelope, { ok: false, code: 'E_INSUFFICIENT_RESOURCES' });

    const retry = gate.admit(envelope(1), session);

    expect(retry).toMatchObject({
      ok: true,
      value: { status: 'duplicate', receipt: { ok: false, code: 'E_INSUFFICIENT_RESOURCES' } },
    });
  });

  it('rejects spoofed player sessions before sequence reservation', () => {
    const gate = new ActionGate();
    const result = gate.admit(envelope(1), { ...session, playerId: 'p2' });

    expect(result).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    expect(gate.admit(envelope(1), session)).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
  });

  it('rejects out-of-order actions and then accepts the expected sequence', () => {
    const gate = new ActionGate();

    expect(gate.admit(envelope(2), session)).toEqual({ ok: false, code: 'E_OUT_OF_ORDER' });
    expect(gate.admit(envelope(1), session)).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
  });

  it('rejects a malformed payload at the gate when a validator is configured (SV-1.2)', () => {
    // Only `{ to: string }` payloads are valid here; anything else is E_BAD_PAYLOAD.
    const gate = new ActionGate({
      payloadValidator: (_type, payload) =>
        typeof (payload as { to?: unknown }).to === 'string',
    });
    const bad = gate.admit(envelope(1, { nope: true }), session);
    expect(bad).toEqual({ ok: false, code: 'E_BAD_PAYLOAD' });

    // A well-formed payload still admits, and the sequence wasn't consumed by the reject.
    const good = gate.admit(envelope(1, { to: 'NEXUS' }), session);
    expect(good).toMatchObject({ ok: true, value: { status: 'accepted' } });
  });

  it('rejects replayed lower sequences even with a new action id', () => {
    const gate = new ActionGate();
    const first = gate.admit(envelope(1), session);
    if (!first.ok || first.value.status !== 'accepted') throw new Error('expected accepted');

    const replay = {
      ...envelope(1),
      actionId: 'mobile:p1:0',
      clientSeq: 0,
      action: { ...envelope(1).action, id: 'mobile:p1:0' },
    };

    expect(gate.admit(replay, session)).toEqual({ ok: false, code: 'E_REPLAY' });
  });
});
