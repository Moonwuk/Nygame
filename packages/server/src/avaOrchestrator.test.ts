import { describe, expect, it } from 'vitest';
import { pairKey } from '@void/shared-core';
import {
  AvaOrchestrator,
  seatAvaRoster,
  warDeclarationsFor,
  winnerSideOf,
  type AvaSessionSpec,
} from './avaOrchestrator';
import { loadAvaMaps, loadShippedData } from './scenario';
import {
  MemoryAvaChallengeStore,
  MemoryAvaRosterStore,
  MemoryAvaSessionStore,
  type AvaChallenge,
  type AvaSide,
} from './store';

// AVA-7 — the orchestrator: a LOCKED matchup becomes a live AvA session. Seating is a pure
// function (allies grouped onto one side's slots, empties → AI); the session build seeds a
// PEACEFUL cross-team start (S5) and persists the fixed accountId → slot map resolveAvaSeat
// reads. The map/data are the real shipped content.

const data = loadShippedData();
const maps = loadAvaMaps();

interface Harness {
  orch: AvaOrchestrator;
  challenges: MemoryAvaChallengeStore;
  roster: MemoryAvaRosterStore;
  sessions: MemoryAvaSessionStore;
  built: AvaSessionSpec[];
}

function harness(): Harness {
  const challenges = new MemoryAvaChallengeStore();
  const roster = new MemoryAvaRosterStore();
  const sessions = new MemoryAvaSessionStore();
  const built: AvaSessionSpec[] = [];
  const orch = new AvaOrchestrator({
    challengeStore: challenges,
    rosterStore: roster,
    sessionStore: sessions,
    data,
    maps,
    createRoom: (spec) => {
      built.push(spec);
      return Promise.resolve();
    },
    now: () => 42,
  });
  return { orch, challenges, roster, sessions, built };
}

/** Seed a LOCKED matchup with the given roster on each side (bypassing AvaService). */
async function lockedMatchup(
  h: Harness,
  id: string,
  challenger: string[],
  target: string[],
): Promise<void> {
  const row: AvaChallenge = {
    id,
    challengerCorp: 'cA',
    targetCorp: 'cB',
    cost: 100,
    status: 'pending',
    createdAt: 1,
    expiresAt: 10,
  };
  await h.challenges.createChallenge(row);
  await h.challenges.closeChallenge(id, 'accepted');
  await h.challenges.closeMatchup(id, 'locked');
  const add = (side: AvaSide, accts: string[]): Promise<unknown> =>
    Promise.all(
      accts.map((accountId) =>
        h.roster.addEntry({ matchupId: id, accountId, side, source: 'self', at: 1 }, 4),
      ),
    );
  await add('challenger', challenger);
  await add('target', target);
}

describe('seatAvaRoster (AVA-7) — pure roster → slot seating', () => {
  const duel = maps.find((m) => m.id === 'ava-duel-1')!;
  const map2v2 = maps.find((m) => m.id === 'ava-2v2-1')!;

  it('seats each side onto its own team slots; playerId = slotId', () => {
    const { slots, seats } = seatAvaRoster(duel, { challenger: ['acc-a'], target: ['acc-b'] });
    expect(seats).toEqual({ 'acc-a': 'slot_a', 'acc-b': 'slot_b' });
    expect(slots.slot_a).toEqual({ playerId: 'slot_a' });
    expect(slots.slot_b).toEqual({ playerId: 'slot_b' });
  });

  it('groups allies on one side and fills an empty slot with an AI bot', () => {
    const { slots, seats } = seatAvaRoster(map2v2, {
      challenger: ['acc-a1', 'acc-a2'],
      target: ['acc-b1'],
    });
    // both challenger accounts land on team A's slots — a single front
    expect(seats['acc-a1']).toBe('slot_a1');
    expect(seats['acc-a2']).toBe('slot_a2');
    expect(seats['acc-b1']).toBe('slot_b1');
    // the empty target slot is a server AI, not a seat any account holds
    expect(slots.slot_b2).toEqual({ playerId: 'bot:slot_b2', ai: true });
    expect(Object.values(seats)).not.toContain('slot_b2');
  });

  it('is deterministic — sorted accounts map to sorted slots regardless of input order', () => {
    const a = seatAvaRoster(map2v2, { challenger: ['acc-a2', 'acc-a1'], target: [] });
    const b = seatAvaRoster(map2v2, { challenger: ['acc-a1', 'acc-a2'], target: [] });
    expect(a.seats).toEqual(b.seats);
    expect(a.seats).toEqual({ 'acc-a1': 'slot_a1', 'acc-a2': 'slot_a2' });
  });
});

describe('AvaOrchestrator.orchestrate (AVA-7) — raise a session from a locked roster', () => {
  it('builds a peaceful session with players in their slots and records the link', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu1', ['acc-a'], ['acc-b']);
    const res = await h.orch.orchestrate('mu1');
    expect(res).toEqual({
      ok: true,
      matchId: 'ava-mu1',
      mapId: 'ava-duel-1',
      seats: { 'acc-a': 'slot_a', 'acc-b': 'slot_b' },
    });
    // the room was raised once, with both slots seated as real players…
    expect(h.built).toHaveLength(1);
    const state = h.built[0]!.state;
    expect(Object.keys(state.players).sort()).toEqual(['slot_a', 'slot_b']);
    // …their homeworlds owned by them…
    expect(state.planets.home_a?.owner).toBe('slot_a');
    expect(state.planets.home_b?.owner).toBe('slot_b');
    // …and the cross-team stance seeded at PEACE (S5 combat-lock is free from the seed).
    expect(state.diplomacy?.[pairKey('slot_a', 'slot_b')]).toBe('peace');
    // the session link is persisted for resolveAvaSeat / settlement
    expect(await h.sessions.byMatch('ava-mu1')).toMatchObject({ matchupId: 'mu1', mapId: 'ava-duel-1' });
  });

  it('fills a short side with an AI bot and seats only the humans', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu2', ['acc-a1', 'acc-a2'], ['acc-b1']);
    const res = await h.orch.orchestrate('mu2');
    if (!res.ok) throw new Error(res.code);
    expect(res.mapId).toBe('ava-2v2-1');
    const state = h.built[0]!.state;
    expect(Object.keys(state.players)).toHaveLength(4); // 3 humans + 1 bot
    const bots = Object.values(state.players).filter((p) => p.ai);
    expect(bots).toHaveLength(1);
    expect(res.seats).toEqual({ 'acc-a1': 'slot_a1', 'acc-a2': 'slot_a2', 'acc-b1': 'slot_b1' });
  });

  it('is idempotent — a second orchestrate returns the same session without rebuilding', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu3', ['acc-a'], ['acc-b']);
    const first = await h.orch.orchestrate('mu3');
    const second = await h.orch.orchestrate('mu3');
    expect(second).toEqual(first);
    expect(h.built).toHaveLength(1); // the room was built exactly once
  });

  it('rejects a missing, unlocked, or unsized matchup with a stable code', async () => {
    const h = harness();
    expect(await h.orch.orchestrate('nope')).toEqual({ ok: false, code: 'E_NO_MATCHUP' });
    // accepted-but-not-locked
    await h.challenges.createChallenge({
      id: 'mu-open',
      challengerCorp: 'cA',
      targetCorp: 'cB',
      cost: 100,
      status: 'pending',
      createdAt: 1,
      expiresAt: 10,
    });
    await h.challenges.closeChallenge('mu-open', 'accepted');
    expect(await h.orch.orchestrate('mu-open')).toEqual({ ok: false, code: 'E_NOT_LOCKED' });
    // no shipped map is a 2×3 — the pick fails, fail-secure
    await lockedMatchup(h, 'mu-big', ['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']);
    expect(await h.orch.orchestrate('mu-big')).toEqual({ ok: false, code: 'E_NO_MAP' });
    expect(h.built).toHaveLength(0);
  });
});

describe('AvaOrchestrator.resolveAvaSeat (AVA-7) — fixed AvA seating', () => {
  it('returns the rostered account its fixed slot; refuses outsiders; null for a non-AvA match', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu4', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu4');
    expect(await h.orch.resolveAvaSeat('ava-mu4', 'acc-a')).toEqual({ ok: true, playerId: 'slot_a' });
    expect(await h.orch.resolveAvaSeat('ava-mu4', 'acc-b')).toEqual({ ok: true, playerId: 'slot_b' });
    expect(await h.orch.resolveAvaSeat('ava-mu4', 'acc-x')).toEqual({
      ok: false,
      code: 'E_NOT_ROSTERED',
    });
    expect(await h.orch.resolveAvaSeat('some-other-match', 'acc-a')).toBeNull();
  });
});

describe('AvaOrchestrator × arsenal snapshot (ARS-3)', () => {
  it('attaches each rostered account’s arsenal at launch; bots stay unrestricted', async () => {
    const challenges = new MemoryAvaChallengeStore();
    const roster = new MemoryAvaRosterStore();
    const sessions = new MemoryAvaSessionStore();
    const built: AvaSessionSpec[] = [];
    const arsenals: Record<string, { hulls: string[]; modules: string[]; fittings: string[] }> = {
      'acc-a1': { hulls: ['cruiser'], modules: ['cargo_bay'], fittings: [] },
      'acc-a2': { hulls: ['scout_drone'], modules: [], fittings: [] },
      'acc-b': { hulls: ['dropship'], modules: [], fittings: [] },
    };
    const orch = new AvaOrchestrator({
      challengeStore: challenges,
      rosterStore: roster,
      sessionStore: sessions,
      data,
      maps,
      createRoom: (spec) => {
        built.push(spec);
        return Promise.resolve();
      },
      now: () => 42,
      arsenalOf: (accountId) => Promise.resolve(arsenals[accountId]!),
    });
    const h = { orch, challenges, roster, sessions, built } as unknown as Harness;
    await lockedMatchup(h, 'mu-ars', ['acc-a1', 'acc-a2'], ['acc-b']); // 2v1 → the 2v2 map
    await orch.orchestrate('mu-ars');

    const state = built[0]!.state;
    const seats = built[0]!.seats;
    // each HUMAN seat carries ITS account's snapshot in the built state…
    expect(state.players[seats['acc-a1']!]?.arsenal).toEqual(arsenals['acc-a1']);
    expect(state.players[seats['acc-a2']!]?.arsenal).toEqual(arsenals['acc-a2']);
    expect(state.players[seats['acc-b']!]?.arsenal).toEqual(arsenals['acc-b']);
    // …while the AI-filled empty slot builds unrestricted (no snapshot)
    const bot = Object.keys(state.players).find((id) => id.startsWith('bot:'))!;
    expect(state.players[bot]?.arsenal).toBeUndefined();
  });
});

describe('AvaOrchestrator × corp rentals (ARS-6)', () => {
  it('merges a corp-rented item into the seat’s snapshot alongside the personal one', async () => {
    const challenges = new MemoryAvaChallengeStore();
    const roster = new MemoryAvaRosterStore();
    const sessions = new MemoryAvaSessionStore();
    const built: AvaSessionSpec[] = [];
    const orch = new AvaOrchestrator({
      challengeStore: challenges,
      rosterStore: roster,
      sessionStore: sessions,
      data,
      maps,
      createRoom: (spec) => {
        built.push(spec);
        return Promise.resolve();
      },
      now: () => 42,
      arsenalOf: (accountId) =>
        Promise.resolve(accountId === 'acc-a1' ? { hulls: ['cruiser'], modules: [], fittings: [] } : { hulls: [], modules: [], fittings: [] }),
      // ARS-6: acc-a1 also has a corp-rented module for THIS matchup only.
      corpRentalOf: (accountId, matchupId) =>
        Promise.resolve(
          accountId === 'acc-a1' && matchupId === 'mu-rent'
            ? { hulls: [], modules: ['cargo_bay'], fittings: [] }
            : { hulls: [], modules: [], fittings: [] },
        ),
    });
    const h = { orch, challenges, roster, sessions, built } as unknown as Harness;
    await lockedMatchup(h, 'mu-rent', ['acc-a1'], ['acc-b']);
    await orch.orchestrate('mu-rent');

    const state = built[0]!.state;
    const seats = built[0]!.seats;
    expect(state.players[seats['acc-a1']!]?.arsenal).toEqual({
      hulls: ['cruiser'], // personal
      modules: ['cargo_bay'], // rented in
      fittings: [],
    });
  });
});

describe('AvaOrchestrator.sweep (AVA-7) — no client needed', () => {
  it('raises a session for every locked matchup that has none, idempotently', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu5', ['acc-a'], ['acc-b']);
    await lockedMatchup(h, 'mu6', ['acc-c'], ['acc-d']);
    expect(await h.orch.sweep()).toEqual({ raised: 2 });
    expect(h.built).toHaveLength(2);
    expect(await h.orch.sweep()).toEqual({ raised: 0 }); // both already have sessions
    expect(h.built).toHaveLength(2);
  });
});

// ---- AVA-8 · S6 war timer + S7 settlement hook -------------------------------

interface WarHarness extends Harness {
  escalated: string[];
  settled: Array<{ matchupId: string; side: AvaSide | null }>;
  /** Flip to false to simulate a transient escalation failure. */
  escalateOk: { value: boolean };
}

function warHarness(peaceMs = 1_000): WarHarness {
  const challenges = new MemoryAvaChallengeStore();
  const roster = new MemoryAvaRosterStore();
  const sessions = new MemoryAvaSessionStore();
  const built: AvaSessionSpec[] = [];
  const escalated: string[] = [];
  const settled: Array<{ matchupId: string; side: AvaSide | null }> = [];
  const escalateOk = { value: true };
  const orch = new AvaOrchestrator({
    challengeStore: challenges,
    rosterStore: roster,
    sessionStore: sessions,
    data,
    maps,
    createRoom: (spec) => {
      built.push(spec);
      return Promise.resolve();
    },
    now: () => 42,
    peaceMs,
    escalateWar: (matchId) => {
      if (escalateOk.value) escalated.push(matchId);
      return Promise.resolve(escalateOk.value);
    },
    settle: (matchupId, side) => {
      settled.push({ matchupId, side });
      return Promise.resolve();
    },
  });
  return { orch, challenges, roster, sessions, built, escalated, settled, escalateOk };
}

describe('AvaOrchestrator.sweepWar (AVA-8, S6) — the peace period ends on a timer', () => {
  it('stamps warAt at session creation and escalates exactly once when due', async () => {
    const h = warHarness(1_000);
    await lockedMatchup(h, 'mu7', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu7');
    expect((await h.sessions.byMatchup('mu7'))?.warAt).toBe(42 + 1_000); // now + peaceMs

    expect(await h.orch.sweepWar(42)).toEqual({ declared: 0 }); // peace still running
    expect(h.escalated).toHaveLength(0);
    expect(await h.orch.sweepWar(42 + 1_000)).toEqual({ declared: 1 }); // due → war opens
    expect(h.escalated).toEqual(['ava-mu7']);
    expect(await h.orch.sweepWar(42 + 2_000)).toEqual({ declared: 0 }); // exactly once
    expect(h.escalated).toHaveLength(1);
  });

  it('a failed escalation stays queued and retries on the next pass', async () => {
    const h = warHarness(100);
    await lockedMatchup(h, 'mu8', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu8');
    h.escalateOk.value = false;
    expect(await h.orch.sweepWar(9_999)).toEqual({ declared: 0 }); // transient failure
    h.escalateOk.value = true;
    expect(await h.orch.sweepWar(9_999)).toEqual({ declared: 1 }); // retried and landed
  });

  it('a matchup settled before its war is purged from the queue without escalating', async () => {
    const h = warHarness(100);
    await lockedMatchup(h, 'mu9', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu9');
    await h.challenges.endMatchup('mu9'); // e.g. a timeout ended the match in peace
    expect(await h.orch.sweepWar(9_999)).toEqual({ declared: 0 });
    expect(h.escalated).toHaveLength(0); // no stance flips on a finished match
    expect(await h.orch.sweepWar(9_999)).toEqual({ declared: 0 }); // and it stays purged
  });
});

describe('warDeclarationsFor (AVA-8, S6) — the system declarations that open the war', () => {
  it('declares exactly the cross-team (still-at-peace) pairs, with deterministic ids', async () => {
    const h = warHarness();
    await lockedMatchup(h, 'mu10', ['acc-a1', 'acc-a2'], ['acc-b1']);
    await h.orch.orchestrate('mu10');
    const state = h.built[0]!.state;
    const declares = warDeclarationsFor(state, 'ava-mu10');
    // 2v2 map: side A slots (2 humans) × side B (1 human + 1 bot) = 4 cross pairs;
    // the same-side ALLIANCE pairs are not declared.
    expect(declares).toHaveLength(4);
    for (const { playerId, action } of declares) {
      expect(action.type).toBe('diplomacy.declare');
      expect(action.playerId).toBe(playerId);
      expect((action.payload as { stance: string }).stance).toBe('war');
      expect(action.id.startsWith('ava-war:ava-mu10:')).toBe(true);
    }
    // Applying them all makes every cross pair hostile — nothing left to declare.
    const ids = Object.keys(state.players).sort();
    for (const { action } of declares) {
      const { target } = action.payload as { target: string };
      state.diplomacy![pairKey(action.playerId, target)] = 'war';
    }
    expect(warDeclarationsFor(state, 'ava-mu10')).toHaveLength(0);
    expect(ids).toHaveLength(4);
  });
});

describe('AvaOrchestrator.onMatchEnded (AVA-8, S7) — the settlement hook', () => {
  it('maps the winning player (slot or bot) to its side and settles once', async () => {
    const h = warHarness();
    await lockedMatchup(h, 'mu11', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu11');
    await h.orch.onMatchEnded('ava-mu11', 'slot_a'); // team A slot → challenger side
    expect(h.settled).toEqual([{ matchupId: 'mu11', side: 'challenger' }]);
    await h.orch.onMatchEnded('ava-mu11', 'bot:slot_b'); // a bot win still credits its side
    expect(h.settled[1]).toEqual({ matchupId: 'mu11', side: 'target' });
  });

  it('a draw settles with null; a non-AvA match is ignored', async () => {
    const h = warHarness();
    await lockedMatchup(h, 'mu12', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu12');
    await h.orch.onMatchEnded('ava-mu12', null); // timeout tie — no winner
    expect(h.settled).toEqual([{ matchupId: 'mu12', side: null }]);
    await h.orch.onMatchEnded('dev', 'green'); // a regular match — not ours
    expect(h.settled).toHaveLength(1);
  });

  it('winnerSideOf: unknown slots yield null (no influence on a broken mapping)', () => {
    const duel = maps.find((m) => m.id === 'ava-duel-1')!;
    expect(winnerSideOf(duel, 'slot_a')).toBe('challenger');
    expect(winnerSideOf(duel, 'bot:slot_b')).toBe('target');
    expect(winnerSideOf(duel, 'ghost')).toBeNull();
  });
});
