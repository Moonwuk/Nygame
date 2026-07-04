import { describe, expect, it } from 'vitest';
import {
  ACTION_ENVELOPE_SCHEMA_VERSION,
  ActionGate,
  createActionEnvelope,
} from '@void/action-layer';
import { isValidActionPayload } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import type { RoomPeer } from './matchRoom';
import type { ServerMessage } from './protocol';

// SV-1.1 — the `@void/action-layer` front door wired into MatchRoom. When a room is
// given a `gate`, every action arrives as an `action.v1` envelope and is
// validate → authorize → sequence → dedup checked BEFORE the reducer, yielding stable
// `E_*` codes with no internal leak (fail-secure). Bare `action` messages are refused.
// This is the abuse e2e (E3): invalid / unauthorized / replay / out-of-order → safe
// reject; valid → applied; duplicate → replayed, not re-applied.

const data = loadShippedData();

class MemoryPeer implements RoomPeer {
  readonly messages: ServerMessage[] = [];
  send(raw: string): void {
    this.messages.push(JSON.parse(raw) as ServerMessage);
  }
  last(): ServerMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
  rejections(): Extract<ServerMessage, { type: 'rejection' }>[] {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'rejection' }> => m.type === 'rejection',
    );
  }
}

const SESSION = { matchId: 'dev', playerId: 'green', sessionId: 'sess-green' } as const;

/** A valid, self-consistent gated envelope for green's fleet in the dev match. */
function orbitEnvelope(clientSeq: number) {
  return createActionEnvelope({
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    matchId: SESSION.matchId,
    playerId: SESSION.playerId,
    sessionId: SESSION.sessionId,
    clientSeq,
    issuedAt: 1000 + clientSeq,
    type: 'fleet.orbit',
    payload: { fleetId: 'green_1', orbit: 'near' },
  });
}

/** The wire message a gated client sends. */
function wire(envelope: unknown): string {
  return JSON.stringify({ type: 'action.v1', envelope });
}

function gatedRoom(now: () => number = () => 1000, extra: Record<string, unknown> = {}) {
  return createDevMatch(data, {
    now,
    time: 1000,
    gate: new ActionGate({ now: () => 5000 }),
    ...extra,
  });
}

describe('MatchRoom · action-layer gate (SV-1.1)', () => {
  it('admits a valid gated action through the reducer', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    await room.receive('green', peer, wire(orbitEnvelope(1)), SESSION.sessionId);

    expect(room.state.fleets.green_1?.orbit).toBe('near'); // applied
    expect(room.sequence).toBe(1);
    expect(peer.messages.some((m) => m.type === 'delta')).toBe(true);
    expect(peer.rejections()).toHaveLength(0);
  });

  it('rejects a malformed envelope with E_BAD_PAYLOAD and does not touch state', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    await room.receive('green', peer, wire({ not: 'an envelope' }), SESSION.sessionId);

    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_BAD_PAYLOAD' });
    expect(room.sequence).toBe(0);
    expect(room.state.fleets.green_1?.orbit).toBeUndefined(); // untouched (not yet in orbit)
  });

  it('rejects a tampered actionId with E_BAD_ACTION_ID', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const tampered = { ...orbitEnvelope(1), actionId: 'sess-green:green:999' };
    await room.receive('green', peer, wire(tampered), SESSION.sessionId);

    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_BAD_ACTION_ID' });
    expect(room.sequence).toBe(0);
  });

  it('rejects an unauthorized envelope with E_FORBIDDEN (player and match binding)', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    // A self-consistent envelope claiming another player, sent over green's session.
    const foreignPlayer = createActionEnvelope({
      schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
      matchId: 'dev',
      playerId: 'red',
      sessionId: SESSION.sessionId,
      clientSeq: 1,
      issuedAt: 1001,
      type: 'fleet.orbit',
      payload: { fleetId: 'red_1', orbit: 'near' },
    });
    await room.receive('green', peer, wire(foreignPlayer), SESSION.sessionId);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_FORBIDDEN' });

    // A valid session bound to a different match id is also forbidden.
    const foreignMatch = { ...orbitEnvelope(1), matchId: 'other-match' };
    await room.receive('green', peer, wire(foreignMatch), SESSION.sessionId);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_FORBIDDEN' });

    expect(room.sequence).toBe(0); // nothing applied
  });

  it('rejects a replayed lower sequence with E_REPLAY', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    await room.receive('green', peer, wire(orbitEnvelope(1)), SESSION.sessionId); // cursor → 1
    expect(room.sequence).toBe(1);

    // A fresh action id at a seq the gate already passed → not a dedup, a replay.
    await room.receive('green', peer, wire(orbitEnvelope(0)), SESSION.sessionId);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_REPLAY' });
    expect(room.sequence).toBe(1); // unchanged
  });

  it('rejects an out-of-order sequence with E_OUT_OF_ORDER', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    // First expected seq is 1; jumping to 2 is a gap.
    await room.receive('green', peer, wire(orbitEnvelope(2)), SESSION.sessionId);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_OUT_OF_ORDER' });
    expect(room.sequence).toBe(0);

    // The expected seq then admits.
    await room.receive('green', peer, wire(orbitEnvelope(1)), SESSION.sessionId);
    expect(room.sequence).toBe(1);
  });

  it('replays a duplicate committed action idempotently (no re-apply)', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const env = orbitEnvelope(1);
    await room.receive('green', peer, wire(env), SESSION.sessionId);
    expect(room.sequence).toBe(1);

    // Same envelope again → the gate deduplicates it: a resync, no new seq, no re-apply.
    await room.receive('green', peer, wire(env), SESSION.sessionId);
    expect(room.sequence).toBe(1);
    expect(peer.last()).toMatchObject({ type: 'state' }); // full resync, not a fresh delta
  });

  it('refuses a bare action on a gated room (no gate bypass)', async () => {
    const room = gatedRoom();
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const bare = JSON.stringify({
      type: 'action',
      action: { id: 'x', type: 'fleet.orbit', playerId: 'green', payload: { fleetId: 'green_1', orbit: 'near' }, issuedAt: 0 },
    });
    await room.receive('green', peer, bare, SESSION.sessionId);

    expect(peer.last()).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
    expect(room.sequence).toBe(0);
    expect(room.state.fleets.green_1?.orbit).toBeUndefined(); // never reached the reducer
  });

  it('refuses a gated envelope without a session, and on an un-gated room', async () => {
    // Gated room, but no sessionId passed by the transport → unroutable.
    const gated = gatedRoom();
    const gPeer = new MemoryPeer();
    gated.addPeer('green', gPeer);
    await gated.receive('green', gPeer, wire(orbitEnvelope(1)));
    expect(gPeer.last()).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
    expect(gated.sequence).toBe(0);

    // Un-gated room does not accept envelope messages at all.
    const plain = createDevMatch(data, { now: () => 1000, time: 1000 });
    const pPeer = new MemoryPeer();
    plain.addPeer('green', pPeer);
    await plain.receive('green', pPeer, wire(orbitEnvelope(1)), SESSION.sessionId);
    expect(pPeer.last()).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
    expect(plain.sequence).toBe(0);
  });

  it('rejects a malformed action payload at the gate (SV-1.2) and applies a valid one', async () => {
    const room = createDevMatch(data, {
      gate: new ActionGate({ payloadValidator: isValidActionPayload }),
      now: () => 1000,
      time: 1000,
    });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    // Structurally a valid envelope, but the payload violates the fleet.orbit schema.
    const bad = createActionEnvelope({
      schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
      matchId: 'dev',
      playerId: 'green',
      sessionId: SESSION.sessionId,
      clientSeq: 1,
      issuedAt: 1001,
      type: 'fleet.orbit',
      payload: { fleetId: 'green_1', orbit: 'sideways' }, // not the single 'near' orbit
    });
    await room.receive('green', peer, wire(bad), SESSION.sessionId);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_BAD_PAYLOAD' });
    expect(room.sequence).toBe(0);
    expect(room.state.fleets.green_1?.orbit).toBeUndefined(); // untouched (not yet in orbit)

    // The same clientSeq with a WELL-FORMED payload still lands (the bad one didn't burn it).
    await room.receive('green', peer, wire(orbitEnvelope(1)), SESSION.sessionId);
    expect(room.state.fleets.green_1?.orbit).toBe('near');
    expect(room.sequence).toBe(1);
  });

  it('gate + persist: commits the durable gated action before broadcast, dedups a retry', async () => {
    const room = createDevMatch(data, {
      gate: new ActionGate(),
      persist: () => Promise.resolve(),
      now: () => 1000,
      time: 1000,
    });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const env = orbitEnvelope(1);
    await room.receive('green', peer, wire(env), SESSION.sessionId);
    expect(room.state.fleets.green_1?.orbit).toBe('near'); // durably committed
    expect(room.sequence).toBe(1);
    expect(peer.messages.some((m) => m.type === 'delta')).toBe(true);

    // Retry the same envelope → gate dedups it → a resync, no new seq, no re-apply.
    await room.receive('green', peer, wire(env), SESSION.sessionId);
    expect(room.sequence).toBe(1);
    expect(peer.last()).toMatchObject({ type: 'state' });
  });

  it('gate + persist: a transient write failure rolls back the seq and stays retriable', async () => {
    let down = true;
    const room = createDevMatch(data, {
      gate: new ActionGate(),
      persist: () => (down ? Promise.reject(new Error('store down')) : Promise.resolve()),
      now: () => 1000,
      time: 1000,
    });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const env = orbitEnvelope(1);
    await room.receive('green', peer, wire(env), SESSION.sessionId);
    // Transient failure: nothing committed, a retriable reject, cursor rolled back.
    expect(room.state.fleets.green_1?.orbit).toBeUndefined();
    expect(room.sequence).toBe(0);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_UNAVAILABLE' });

    // Store recovers; the SAME clientSeq re-admits (not E_REPLAY) and lands durably.
    down = false;
    await room.receive('green', peer, wire(env), SESSION.sessionId);
    expect(room.state.fleets.green_1?.orbit).toBe('near');
    expect(room.sequence).toBe(1);
  });

  it('rate-limits before reserving a sequence, so a throttled action stays retriable', async () => {
    // The ordering guarantee: a throttled action must NOT burn its clientSeq, or a
    // backoff-retry of the same seq would hit E_REPLAY instead of landing.
    let clock = 1000;
    const room = gatedRoom(() => clock, { actionRateMax: 1, actionRateWindowMs: 60_000 });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    await room.receive('green', peer, wire(orbitEnvelope(1)), SESSION.sessionId);
    expect(room.sequence).toBe(1); // first action lands

    // Second action, same window → throttled. The sequence cursor must stay at 1.
    await room.receive('green', peer, wire(orbitEnvelope(2)), SESSION.sessionId);
    expect(peer.last()).toMatchObject({ type: 'rejection', code: 'E_RATE_LIMIT' });
    expect(room.sequence).toBe(1);

    // Backoff past the window, retry the SAME clientSeq → it admits (not E_REPLAY).
    clock += 60_001;
    await room.receive('green', peer, wire(orbitEnvelope(2)), SESSION.sessionId);
    expect(room.sequence).toBe(2);
    expect(room.state.fleets.green_1?.orbit).toBe('near');
  });
});
