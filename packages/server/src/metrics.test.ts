import { describe, expect, it } from 'vitest';
import { MetricsAggregator } from './metrics';
import type { RoomObservation } from './matchRoom';

function feed(events: RoomObservation[]): MetricsAggregator {
  const m = new MetricsAggregator();
  for (const e of events) m.observe(e);
  return m;
}

describe('MetricsAggregator (M1)', () => {
  it('starts empty — zero counters, no end', () => {
    const s = new MetricsAggregator().summary();
    expect(s).toMatchObject({
      joins: 0,
      leaves: 0,
      actions: { total: 0, ok: 0, rejected: 0 },
      battles: 0,
      captures: 0,
      desyncs: 0,
      deadLetters: 0,
      advanceOverflows: 0,
      end: null,
    });
    expect(s.submitMs).toEqual({ count: 0, total: 0, max: 0, avg: 0 });
  });

  it('counts joins/leaves and actions by type + reject codes', () => {
    const s = feed([
      { kind: 'join', playerId: 'p1' },
      { kind: 'join', playerId: 'p2' },
      { kind: 'leave', playerId: 'p2' },
      { kind: 'action', actionId: 'a1', playerId: 'p1', type: 'fleet.move', ok: true, seq: 1 },
      { kind: 'action', actionId: 'a2', playerId: 'p1', type: 'fleet.move', ok: true, seq: 2 },
      {
        kind: 'action',
        actionId: 'a3',
        playerId: 'p1',
        type: 'market.buy',
        ok: false,
        seq: 3,
        code: 'E_FORBIDDEN',
      },
    ]).summary();
    expect(s.joins).toBe(2);
    expect(s.leaves).toBe(1);
    expect(s.actions).toEqual({
      total: 3,
      ok: 2,
      rejected: 1,
      byType: { 'fleet.move': 2, 'market.buy': 1 },
      rejectByCode: { E_FORBIDDEN: 1 },
    });
  });

  it('surfaces EVERY failure signal in one summary (the /metrics/summary contract, NETA2-mon)', () => {
    // A mixed stream a live server would produce; the glance-view must expose each anomaly.
    const s = feed([
      { kind: 'desync', playerId: 'p1', atSeq: 7, clientHash: 'deadbeef' },
      { kind: 'desync', playerId: 'p2', atSeq: 9, clientHash: 'cafe' },
      { kind: 'dead_letter', failures: [{ at: 1, type: 'combat.tick', code: 'E_INTERNAL' }] },
      { kind: 'advance_overflow', reachedTime: 5, targetTime: 9, reason: 'stalled' },
      { kind: 'action', actionId: 'x1', playerId: 'p1', type: 'fleet.move', ok: false, seq: 1, code: 'E_UNAVAILABLE' },
      { kind: 'action', actionId: 'x2', playerId: 'p1', type: 'fleet.move', ok: false, seq: 2, code: 'E_UNAVAILABLE' },
      { kind: 'action', actionId: 'x3', playerId: 'p2', type: 'unit.build', ok: false, seq: 3, code: 'E_MATCH_ENDED' },
    ]).summary();
    expect(s.desyncs).toBe(2); // target is 0 — a non-zero here is the loudest signal
    expect(s.deadLetters).toBe(1);
    expect(s.advanceOverflows).toBe(1);
    expect(s.actions.rejected).toBe(3);
    expect(s.actions.rejectByCode).toEqual({ E_UNAVAILABLE: 2, E_MATCH_ENDED: 1 });
  });

  it('counts domain events by type and derives battles/captures', () => {
    const s = feed([
      {
        kind: 'events',
        seq: 5,
        events: [
          { type: 'battle.started', payload: {} },
          { type: 'battle.resolved', payload: {} },
          { type: 'battle.resolved', payload: {} },
          { type: 'planet.captured', payload: {} },
          { type: 'fleet.arrived', payload: {} },
        ],
      },
    ]).summary();
    expect(s.eventsByType).toEqual({
      'battle.started': 1,
      'battle.resolved': 2,
      'planet.captured': 1,
      'fleet.arrived': 1,
    });
    expect(s.battles).toBe(2);
    expect(s.captures).toBe(1);
  });

  it('aggregates submit/advance timings and broadcast delta sizes', () => {
    const s = feed([
      { kind: 'timing', op: 'submit', ms: 4, seq: 1, actionType: 'fleet.move' },
      { kind: 'timing', op: 'submit', ms: 10, seq: 2, actionType: 'fleet.move' },
      { kind: 'timing', op: 'advance', ms: 7, seq: 2 },
      { kind: 'broadcast', seq: 2, ms: 3, deltaBytes: { p1: 100, p2: 300 } },
    ]).summary();
    expect(s.submitMs).toEqual({ count: 2, total: 14, max: 10, avg: 7 });
    expect(s.advanceMs).toEqual({ count: 1, total: 7, max: 7, avg: 7 });
    expect(s.broadcastMs).toEqual({ count: 1, total: 3, max: 3, avg: 3 });
    expect(s.deltaBytes).toEqual({ count: 2, total: 400, max: 300, avg: 200 });
  });

  it('counts desyncs, dead letters (per failure) and advance overflows', () => {
    const s = feed([
      { kind: 'desync', playerId: 'p1', atSeq: 3, clientHash: 'h' },
      {
        kind: 'dead_letter',
        failures: [
          { at: 1, type: 'x', code: 'E_X' },
          { at: 2, type: 'y', code: 'E_Y' },
        ],
      },
      { kind: 'advance_overflow', reachedTime: 5, targetTime: 9, reason: 'throttled' },
    ]).summary();
    expect(s.desyncs).toBe(1);
    expect(s.deadLetters).toBe(2);
    expect(s.advanceOverflows).toBe(1);
  });

  it('records the match end (winner + reason)', () => {
    const s = feed([{ kind: 'end', winner: 'p2', reason: 'score' }]).summary();
    expect(s.end).toEqual({ winner: 'p2', reason: 'score' });
  });

  it('aggregates client perf samples — fps with min, rtt avg/max (M2)', () => {
    const s = feed([
      { kind: 'client_perf', playerId: 'p1', fps: 60, rttMs: 40 },
      { kind: 'client_perf', playerId: 'p2', fps: 30 },
      { kind: 'client_perf', playerId: 'p1', fps: 45, rttMs: 80 },
    ]).summary();
    expect(s.clientFps).toEqual({ count: 3, total: 135, max: 60, avg: 45, min: 30 });
    expect(s.clientRttMs).toEqual({ count: 2, total: 120, max: 80, avg: 60 });
  });

  it('client perf summaries are null when no samples arrived', () => {
    const s = new MetricsAggregator().summary();
    expect(s.clientFps).toBeNull();
    expect(s.clientRttMs).toBeNull();
  });

  it('ECON-6: counts economy snapshots and per-player arrears-hours', () => {
    const snap = (arrears: string[]): RoomObservation => ({
      kind: 'economy',
      atTime: 3_600_000,
      players: {
        p1: { resources: { credits: 12 }, netPerHour: { credits: 1.5 }, arrears },
        p2: { resources: { credits: 40 }, netPerHour: { credits: 3 }, arrears: [] },
      },
    });
    expect(new MetricsAggregator().summary().economy).toBeNull();
    const s = feed([snap(['food']), snap(['food', 'energy']), snap([])]).summary();
    expect(s.economy).toEqual({ snapshots: 3, arrearsHours: { p1: 2 } }); // p2 never in arrears
  });

  it('summary is a snapshot — later observations do not mutate an earlier summary', () => {
    const m = new MetricsAggregator();
    m.observe({ kind: 'action', actionId: 'a1', playerId: 'p1', type: 'x', ok: true, seq: 1 });
    const first = m.summary();
    m.observe({ kind: 'action', actionId: 'a2', playerId: 'p1', type: 'x', ok: true, seq: 2 });
    expect(first.actions.total).toBe(1);
    expect(first.actions.byType.x).toBe(1);
    expect(m.summary().actions.total).toBe(2);
  });
});
