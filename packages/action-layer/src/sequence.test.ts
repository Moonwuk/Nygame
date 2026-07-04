import { describe, expect, it } from 'vitest';
import { InMemorySequenceGate, type SequenceKey } from './sequence';

// SV-1.1-live-B: the per-session cursor map is bounded (LRU eviction). An active session
// is touched on every action so it survives; only stale sessions are reclaimed on a 24/7
// process. The ordering contract (replay / out-of-order / accept) is unchanged.

function key(sessionId: string): SequenceKey {
  return { matchId: 'm', playerId: 'p1', sessionId };
}

describe('InMemorySequenceGate · ordering (unchanged)', () => {
  it('accepts the next expected seq, rejects replay and gaps', () => {
    const gate = new InMemorySequenceGate();
    const k = key('s');
    expect(gate.checkAndReserve(k, 1)).toMatchObject({ ok: true });
    expect(gate.checkAndReserve(k, 1)).toEqual({ ok: false, code: 'E_REPLAY' });
    expect(gate.checkAndReserve(k, 3)).toEqual({ ok: false, code: 'E_OUT_OF_ORDER' });
    expect(gate.checkAndReserve(k, 2)).toMatchObject({ ok: true });
    expect(gate.last(k)).toBe(2);
  });

  it('rollback releases the latest reservation so the same seq re-admits', () => {
    const gate = new InMemorySequenceGate();
    const k = key('s');
    gate.checkAndReserve(k, 1);
    gate.checkAndReserve(k, 2);
    expect(gate.checkAndReserve(k, 2)).toEqual({ ok: false, code: 'E_REPLAY' }); // 2 is taken

    gate.rollback(k, 2); // undo the reservation of 2
    expect(gate.last(k)).toBe(1);
    expect(gate.checkAndReserve(k, 2)).toMatchObject({ ok: true }); // 2 re-admits
  });

  it('rollback is a no-op when the seq is not the latest (a newer one reserved past it)', () => {
    const gate = new InMemorySequenceGate();
    const k = key('s');
    gate.checkAndReserve(k, 1);
    gate.checkAndReserve(k, 2);
    gate.rollback(k, 1); // 1 is stale — 2 is the cursor now
    expect(gate.last(k)).toBe(2); // unchanged
  });
});

describe('InMemorySequenceGate · bounded (LRU)', () => {
  it('holds the cursor map at the cap', () => {
    const gate = new InMemorySequenceGate({ maxCursors: 3 });
    for (let s = 0; s < 10; s++) gate.checkAndReserve(key(`s${s}`), 1);
    expect(gate.size).toBe(3);
  });

  it('evicts the least-recently-used, not an active session', () => {
    const gate = new InMemorySequenceGate({ maxCursors: 2 });
    const active = key('active');
    gate.checkAndReserve(active, 1); // active: seq 1
    gate.checkAndReserve(key('stale'), 1); // stale: seq 1
    gate.checkAndReserve(active, 2); // touch active → stale is now the LRU

    gate.checkAndReserve(key('newcomer'), 1); // over cap → evicts 'stale'

    expect(gate.last(active)).toBe(2); // active survived, cursor intact
    expect(gate.last(key('stale'))).toBe(0); // evicted → reset (would resync)
    expect(gate.size).toBe(2);
  });

  it('a reclaimed session resyncs from scratch (next action expects seq 1)', () => {
    const gate = new InMemorySequenceGate({ maxCursors: 1 });
    const a = key('a');
    gate.checkAndReserve(a, 1);
    gate.checkAndReserve(key('b'), 1); // evicts 'a'

    // 'a' was reclaimed → its old seq 5 is now out of order; seq 1 re-accepts.
    expect(gate.checkAndReserve(a, 5)).toEqual({ ok: false, code: 'E_OUT_OF_ORDER' });
    expect(gate.checkAndReserve(a, 1)).toMatchObject({ ok: true });
  });
});
