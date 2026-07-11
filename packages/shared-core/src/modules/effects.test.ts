import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { movementModule } from './movement';
import { captureOnArrivalModule } from './captureOnArrival';
import { effectsModule, type EffectImpl, type EffectOccurrence } from './effects';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { GameModule } from '../kernel/module';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

const HOUR = 3_600_000;

// The architecture-doc vocabulary, end to end: `infect_planet` is a RULE in
// data.events AND a TRAIT on a unit — the rule fires only for forces carrying it.
function makeData(events: Record<string, unknown>): GameData {
  return parseGameData({
    version: '0.1.0',
    resources: ['energy'],
    units: {
      scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
      plaguebearer: {
        faction: 'x',
        stats: { attack: 1, defense: 1, speed: 10, hp: 6 },
        traits: ['infect_planet'],
      },
    },
    factions: {},
    buildings: {},
    events,
    sectorKinds: {
      planet: { capturable: true, buildable: true, orbit: true },
    },
  });
}

const INFECT = {
  trigger: 'planet_captured',
  effect: 'add_trait',
  params: { trait: 'infected' },
  chance: 1,
};
const ANOMALY = {
  trigger: 'schedule',
  effect: 'modify_resource',
  params: { resource: 'energy', amount: 50, cadenceHours: 8 },
  chance: 1,
};

function planet(id: string, owner: string | null, x: number): Planet {
  return {
    id,
    owner,
    position: { x, y: 0 },
    kind: 'planet',
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}
function fleet(id: string, owner: string, location: string | null, units: string[]): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map((u) => ({ unit: u, count: 1 })),
    traits: [],
  };
}
function player(id: string, energy: number, status: Player['status'] = 'active'): Player {
  return { id, name: id, faction: 'x', status, resources: { energy } };
}
function baseState(planets: Planet[], fleets: Fleet[], players: Player[]): GameState {
  const s = createInitialState({ seed: 'efx', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...s,
    planets: Object.fromEntries(planets.map((p) => [p.id, p])),
    fleets: Object.fromEntries(fleets.map((f) => [f.id, f])),
    players: Object.fromEntries(players.map((p) => [p.id, p])),
  };
}
const okApply = (r: ApplyResult): ApplyResult & { ok: true } => {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
};
const okAdvance = (r: AdvanceResult): AdvanceResult & { ok: true } => {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
};

/** Drive a real capture: A→B are lane-linked 30 apart, speed 10 → 3h; move F and
 *  advance past arrival. Capture-on-arrival emits `planet.captured` (no `by`). */
function captureB(
  data: GameData,
  unitTypes: string[],
  extraModules: GameModule[] = [],
): { state: GameState; events: { type: string; payload: unknown }[] } {
  const ctx = (now: number): Context => ({ now, data });
  const a = planet('A', 'p1', 0);
  const b = planet('B', null, 30);
  a.links = ['B'];
  b.links = ['A'];
  const kernel = createKernel([
    movementModule,
    captureOnArrivalModule,
    effectsModule,
    ...extraModules,
  ]);
  let state = baseState([a, b], [fleet('F', 'p1', 'A', unitTypes)], [player('p1', 0)]);
  const move: Action = {
    id: 'm1',
    type: 'fleet.move',
    playerId: 'p1',
    payload: { fleetId: 'F', to: 'B' },
    issuedAt: 0,
  };
  state = okApply(kernel.applyAction(state, move, ctx(0))).state;
  const advanced = okAdvance(kernel.advanceTo(state, ctx(4 * HOUR)));
  return { state: advanced.state, events: advanced.events as { type: string; payload: unknown }[] };
}

describe('effectsModule — trait-scoped planet_captured rules (EFX-1)', () => {
  it('a capture by a force carrying the rule id as a trait applies the effect', () => {
    const { state, events } = captureB(makeData({ infect_planet: INFECT }), ['plaguebearer']);
    expect(state.planets['B']!.owner).toBe('p1');
    expect(state.planets['B']!.traits).toContain('infected');
    expect(events.some((e) => e.type === 'effect.applied')).toBe(true);
  });

  it('the same capture WITHOUT the trait leaves the rule dormant', () => {
    const { state, events } = captureB(makeData({ infect_planet: INFECT }), ['scout']);
    expect(state.planets['B']!.owner).toBe('p1');
    expect(state.planets['B']!.traits).not.toContain('infected');
    expect(events.some((e) => e.type === 'effect.applied')).toBe(false);
  });

  it('chance 0 never fires even for a trait carrier', () => {
    const { state } = captureB(makeData({ infect_planet: { ...INFECT, chance: 0 } }), [
      'plaguebearer',
    ]);
    expect(state.planets['B']!.traits).not.toContain('infected');
  });

  it('an unknown effect id makes the rule inert, never a crash', () => {
    const { state } = captureB(
      makeData({ infect_planet: { ...INFECT, effect: 'summon_dragon' } }),
      ['plaguebearer'],
    );
    expect(state.planets['B']!.owner).toBe('p1'); // capture itself unharmed
    expect(state.planets['B']!.traits).toHaveLength(0);
  });

  it('an unknown trigger vocabulary word is inert', () => {
    const { state } = captureB(
      makeData({ infect_planet: { ...INFECT, trigger: 'moon_eclipse' } }),
      ['plaguebearer'],
    );
    expect(state.planets['B']!.traits).toHaveLength(0);
  });
});

describe('effectsModule — scheduled dark events (EFX-1)', () => {
  const ctxOf =
    (data: GameData) =>
    (now: number): Context => ({ now, data });

  it('fires at every cadence crossing for each ACTIVE player (deterministic grid)', () => {
    const data = makeData({ void_anomaly: ANOMALY });
    const ctx = ctxOf(data);
    const kernel = createKernel([effectsModule]);
    const state = baseState(
      [],
      [],
      [player('p1', 0), player('p2', 0), player('dead', 0, 'defeated')],
    );
    // 0 → 25h crosses the 8h grid at 8h, 16h, 24h = 3 firings × 50 energy.
    const advanced = okAdvance(kernel.advanceTo(state, ctx(25 * HOUR)));
    expect(advanced.state.players['p1']!.resources['energy']).toBe(150);
    expect(advanced.state.players['p2']!.resources['energy']).toBe(150);
    expect(advanced.state.players['dead']!.resources['energy']).toBe(0); // defeated seats are skipped
  });

  it('no crossing → no firing; the grid is absolute, not per-span', () => {
    const data = makeData({ void_anomaly: ANOMALY });
    const ctx = ctxOf(data);
    const kernel = createKernel([effectsModule]);
    let state = baseState([], [], [player('p1', 0)]);
    state = okAdvance(kernel.advanceTo(state, ctx(5 * HOUR))).state; // 0→5h: no 8h multiple
    expect(state.players['p1']!.resources['energy']).toBe(0);
    state = okAdvance(kernel.advanceTo(state, ctx(9 * HOUR))).state; // 5→9h crosses 8h once
    expect(state.players['p1']!.resources['energy']).toBe(50);
  });

  it('a negative amount is a penalty, clamped at zero', () => {
    const data = makeData({
      void_anomaly: { ...ANOMALY, params: { resource: 'energy', amount: -100, cadenceHours: 8 } },
    });
    const kernel = createKernel([effectsModule]);
    const state = baseState([], [], [player('p1', 30)]);
    const advanced = okAdvance(kernel.advanceTo(state, ctxOf(data)(9 * HOUR)));
    expect(advanced.state.players['p1']!.resources['energy']).toBe(0);
  });

  it('a rule without a positive cadenceHours is inert', () => {
    const data = makeData({
      void_anomaly: { ...ANOMALY, params: { resource: 'energy', amount: 50 } },
    });
    const kernel = createKernel([effectsModule]);
    const state = baseState([], [], [player('p1', 0)]);
    const advanced = okAdvance(kernel.advanceTo(state, ctxOf(data)(100 * HOUR)));
    expect(advanced.state.players['p1']!.resources['energy']).toBe(0);
  });

  it('caps degenerate cadences at 100 firings per span (fail-secure)', () => {
    const data = makeData({
      void_anomaly: { ...ANOMALY, params: { resource: 'energy', amount: 50, cadenceHours: 1 } },
    });
    const kernel = createKernel([effectsModule]);
    const state = baseState([], [], [player('p1', 0)]);
    // 0 → 500h would cross 500 grid points; the cap holds it to 100.
    const advanced = okAdvance(kernel.advanceTo(state, ctxOf(data)(500 * HOUR)));
    expect(advanced.state.players['p1']!.resources['energy']).toBe(100 * 50);
  });
});

describe('effectsModule — capability extension seam (EFX-1)', () => {
  it('a module-provided `effect.<name>` capability executes (and overrides) the vocabulary', () => {
    const seen: EffectOccurrence[] = [];
    const quakes: GameModule = {
      id: 'quakes',
      version: '0.0.1',
      setup(api) {
        const impl: EffectImpl = (occurrence, h) => {
          seen.push(occurrence);
          const p = occurrence.playerId ? h.state.players[occurrence.playerId] : undefined;
          if (p) p.resources['energy'] = 999;
        };
        api.provideCapability('effect.quake', impl);
      },
    };
    const data = makeData({
      tremor: { trigger: 'schedule', effect: 'quake', params: { cadenceHours: 8 }, chance: 1 },
    });
    const kernel = createKernel([effectsModule, quakes]);
    const state = baseState([], [], [player('p1', 0)]);
    const advanced = okAdvance(kernel.advanceTo(state, { now: 9 * HOUR, data }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ruleId).toBe('tremor');
    expect(advanced.state.players['p1']!.resources['energy']).toBe(999);
  });
});
