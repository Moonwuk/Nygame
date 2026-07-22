import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from './gameState';
import { identifiedNodes, isVisibleTo, visibleState, visibleView } from './visibility';
import type { VisibleState } from './visibility';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 10, defense: 8, speed: 6, hp: 40 }, signature: 4 },
    scout: { faction: 'x', stats: { attack: 2, defense: 2, speed: 9, hp: 8 }, radarRange: 350 },
  },
  factions: {
    // A2: a faction whose passive stretches every radar the player fields by +50%.
    farsight: { name: 'Farsight', passives: { radarRangeBonus: 0.5 } },
  },
  buildings: {
    // Radar reach is a Euclidean DISTANCE (map units), not jumps.
    radar: { name: 'Radar', radarRange: 300, upgrades: [{ radarRange: 500 }, { radarRange: 700 }] },
  },
  technologies: {
    // A2: a researched tech that stretches radar reach by +50%.
    long_scan: { name: 'Long-range scanning', effects: { radarRangeBonus: 0.5 } },
  },
  events: {},
});

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: { metal: 99 } };
}
function planet(
  id: string,
  owner: string | null,
  links: string[],
  extra: Partial<Planet> = {},
): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    links,
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
    ...extra,
  };
}
function fleet(id: string, owner: string, location: string, units: Array<[string, number]>): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}

/** Graph A→B→C→D→E (jumps), but radar works by physical DISTANCE (x-coords below).
 *  p1 owns A with a radar (reach 300). Identify = 1 jump (A,B). By distance from A:
 *  C(250) and E(180) are in radar reach; D(450) is not until the radar is upgraded.
 *  E is 4 jumps away yet physically close — the whole point of the new mechanic. */
function scenario(): GameState {
  const base = createInitialState({ seed: 'vis', version: { data: '0.1.0', manifest: '1' } });
  const at = (x: number): Partial<Planet> => ({ position: { x, y: 0 } });
  return {
    ...base,
    players: {
      p1: player('p1'),
      p2: {
        ...player('p2'),
        technologies: { completed: ['warp'] },
        scientist: { id: 'void_admiral', level: 3 },
      },
    },
    planets: {
      A: planet('A', 'p1', ['B'], { ...at(0), buildings: [{ type: 'radar', level: 1, hp: 10 }] }),
      B: planet('B', null, ['A', 'C'], { ...at(100), garrison: [{ unit: 'cruiser', count: 1 }] }),
      C: planet('C', 'p2', ['B', 'D'], {
        ...at(250),
        garrison: [{ unit: 'cruiser', count: 2 }],
        planetType: 'radar_world',
      }),
      D: planet('D', 'p2', ['C', 'E'], {
        ...at(450),
        garrison: [{ unit: 'cruiser', count: 5 }],
        planetType: 'hidden_world',
      }),
      E: planet('E', 'p2', ['D'], { ...at(180), garrison: [{ unit: 'cruiser', count: 1 }] }),
    },
    fleets: {
      'mine-1': fleet('mine-1', 'p1', 'A', [['cruiser', 1]]),
      'enemy-near': fleet('enemy-near', 'p2', 'B', [['cruiser', 1]]), // at B (identified)
      'enemy-radar': fleet('enemy-radar', 'p2', 'C', [['cruiser', 4]]), // at C (radar by distance) → ◆L
      'enemy-far-close': fleet('enemy-far-close', 'p2', 'E', [['cruiser', 1]]), // 4 jumps away, but close → ◆S
      'enemy-hidden': fleet('enemy-hidden', 'p2', 'D', [['cruiser', 5]]), // at D (beyond L1 radar)
    },
    scheduled: [{ id: 'evt:1', at: 5, type: 'fleet.arrived', payload: {}, seq: 0 }],
  };
}

describe('visibleState — diplomatic offers are private to the two parties', () => {
  it('keeps the viewer’s sent/received offers, strips everyone else’s negotiations', () => {
    const state = scenario();
    state.diplomacyOffers = {
      'p1>p2': 'peace', // viewer sends
      'p2>p1': 'pact', // viewer receives
      'p2>p3': 'alliance', // someone else's negotiation — must not leak
    };
    const view = visibleState(state, 'p1', data);
    expect(view.diplomacyOffers).toEqual({ 'p1>p2': 'peace', 'p2>p1': 'pact' });
    // p3 keeps only the negotiation it is a party to; the p1↔p2 talks never leak.
    const outsider = visibleState(state, 'p3', data);
    expect(outsider.diplomacyOffers).toEqual({ 'p2>p3': 'alliance' });
    expect(JSON.stringify(outsider)).not.toContain('p1>p2');
  });
});

describe('visibleState — order chains are the owner’s secret (future intent)', () => {
  it('keeps only the viewer’s own fleets’ chains, drops the key when none remain', () => {
    const state = scenario() as GameState & { orders?: Record<string, unknown> };
    state.orders = {
      'mine-1': [{ kind: 'move', to: 'B' }], // viewer's plan
      'enemy-near': [{ kind: 'assault' }], // the enemy's plan — must not leak
      ghost: [{ kind: 'orbit' }], // a dead fleet's stale entry — nobody's
    };
    const view = visibleState(state, 'p1', data) as VisibleState & {
      orders?: Record<string, unknown>;
    };
    expect(view.orders).toEqual({ 'mine-1': [{ kind: 'move', to: 'B' }] });
    // The enemy (p2) in turn sees only its own chain — and never the viewer's.
    const enemy = visibleState(state, 'p2', data) as VisibleState & {
      orders?: Record<string, unknown>;
    };
    expect(enemy.orders).toEqual({ 'enemy-near': [{ kind: 'assault' }] });
    // A player with no chains gets no key at all (no empty-map blip in deltas).
    state.orders = { 'enemy-near': [{ kind: 'assault' }] };
    expect('orders' in visibleState(state, 'p1', data)).toBe(false);
  });

  it('standing orders (autoAssault / patrols) are stripped by the same rule', () => {
    const state = scenario() as GameState & {
      autoAssault?: Record<string, unknown>;
      patrols?: Record<string, unknown>;
    };
    state.autoAssault = { 'mine-1': true, 'enemy-near': true };
    state.patrols = {
      'mine-1': { center: { x: 0, y: 0 }, radius: 5, sortie: { fuel: 2, rearming: 0 } },
      'enemy-near': { center: { x: 9, y: 9 }, radius: 7, sortie: { fuel: 1, rearming: 0 } },
    };
    const view = visibleState(state, 'p1', data) as VisibleState & {
      autoAssault?: Record<string, unknown>;
      patrols?: Record<string, unknown>;
    };
    expect(view.autoAssault).toEqual({ 'mine-1': true });
    expect(Object.keys(view.patrols ?? {})).toEqual(['mine-1']);
    // With nothing of the viewer's left, the keys vanish entirely (delta hygiene).
    state.autoAssault = { 'enemy-near': true };
    state.patrols = {
      'enemy-near': { center: { x: 9, y: 9 }, radius: 7, sortie: { fuel: 1, rearming: 0 } },
    };
    const bare = visibleState(state, 'p1', data);
    expect('autoAssault' in bare).toBe(false);
    expect('patrols' in bare).toBe(false);
  });

  it('forced-march flags (BOOST-1) are stripped by the same rule', () => {
    const state = scenario() as GameState & { forcedMarch?: Record<string, true> };
    state.forcedMarch = { 'mine-1': true, 'enemy-near': true };
    const view = visibleState(state, 'p1', data) as VisibleState & {
      forcedMarch?: Record<string, true>;
    };
    expect(view.forcedMarch).toEqual({ 'mine-1': true }); // the enemy's march is his secret
    state.forcedMarch = { 'enemy-near': true };
    expect('forcedMarch' in visibleState(state, 'p1', data)).toBe(false);
  });
});

describe('visibleView (one coverage pass for the broadcast path)', () => {
  it('returns the same projection and identify set as the two separate calls', () => {
    const state = scenario();
    const { view, identified } = visibleView(state, 'p1', data);
    expect(view).toEqual(visibleState(state, 'p1', data));
    expect([...identified].sort()).toEqual([...identifiedNodes(state, 'p1', data)].sort());
  });
});

describe('visibleState (fog of war as a security boundary)', () => {
  it('keeps own and identified objects, hides the rest', () => {
    const view = visibleState(scenario(), 'p1', data);
    // identified fleets: own + the enemy sitting at the identified neutral world.
    expect(Object.keys(view.fleets).sort()).toEqual(['enemy-near', 'mine-1']);
    // identified planet contents stay; radar-only (C) and unseen (D) are stripped.
    expect(view.planets.B?.garrison).toHaveLength(1);
    expect(view.planets.C?.owner).toBeNull();
    expect(view.planets.C?.garrison).toEqual([]);
    expect(view.planets.D?.owner).toBeNull();
    expect(view.planets.D?.planetType).toBeUndefined();
    // topology (the node + its links) is preserved so the map stays navigable.
    expect(view.planets.D?.links).toEqual(['C', 'E']);
  });

  it('reports radar-only enemy fleets as coarse signatures, not the fleets', () => {
    const view = visibleState(scenario(), 'p1', data);
    expect(view.fleets['enemy-radar']).toBeUndefined();
    expect(view.fleets['enemy-far-close']).toBeUndefined();
    // Within radar distance 300 from A: C (4 cruisers ×4 = 16 → L) and E (1 → S).
    // Sorted by location; D (450) is beyond reach, so no contact there.
    expect(view.signatures).toEqual([
      { location: 'C', size: 'L' },
      { location: 'E', size: 'S' },
    ]);
  });

  it('radar reaches by physical distance, ignoring jump topology', () => {
    // E is 4 jumps from A (A→B→C→D→E) yet only 180 units away in space — the
    // signal reaches it even though no fleet could jump there directly.
    const view = visibleState(scenario(), 'p1', data);
    expect(view.signatures.some((s) => s.location === 'E')).toBe(true);
    expect(view.fleets['enemy-far-close']).toBeUndefined(); // detected, not identified
  });

  it('a higher-level radar array detects farther (level-scaled reach)', () => {
    const state = scenario();
    // Level 1 (reach 300): D is 450 units away → outside radar, no contact.
    expect(visibleState(state, 'p1', data).signatures.some((s) => s.location === 'D')).toBe(false);
    // Upgrade A's radar to level 2 (reach 500) → D (450) comes into radar as a
    // signature, while the fleet there is still not identified.
    state.planets.A!.buildings = [{ type: 'radar', level: 2, hp: 26 }];
    const view = visibleState(state, 'p1', data);
    expect(view.fleets['enemy-hidden']).toBeUndefined();
    expect(view.signatures.some((s) => s.location === 'D')).toBe(true);
  });

  it('strips other players private data but keeps identity', () => {
    const state = scenario();
    // A rival on autopilot with a decision journal: both read as «спит — можно
    // бить» intel and must never cross the fog (ST-2.4).
    state.players.p2!.steward = { posture: 'defend', until: state.time + 1 };
    state.players.p2!.stewardLog = [{ at: 0, kind: 'evac', node: 'A' }];
    state.players.p2!.stewardHoldPoints = ['A'];
    state.players.p1!.steward = { posture: 'defend', until: state.time + 1 };
    state.players.p1!.stewardHoldPoints = ['B'];
    const view = visibleState(state, 'p1', data);
    expect(view.players.p1?.resources).toEqual({ metal: 99 }); // own treasury intact
    expect(view.players.p2?.resources).toEqual({}); // enemy treasury hidden
    expect(view.players.p2?.technologies).toBeUndefined();
    expect(view.players.p2?.scientist).toBeUndefined(); // enemy research leader hidden
    expect(view.players.p2?.steward).toBeUndefined(); // enemy autopilot status hidden
    expect(view.players.p2?.stewardLog).toBeUndefined(); // enemy SITREP hidden
    expect(view.players.p2?.stewardHoldPoints).toBeUndefined(); // enemy anchors hidden
    expect(view.players.p1?.steward).toBeDefined(); // own delegation stays visible
    expect(view.players.p1?.stewardHoldPoints).toEqual(['B']); // own anchors stay visible
    expect(view.players.p2?.name).toBe('p2'); // identity kept (scoreboard)
  });

  it('fogs the scoreboard: viewer keeps only their own score line, enemy totals hidden', () => {
    const state = scenario();
    state.match.scores = {
      p1: { controlledPlanets: 1, fleets: 1, units: 1, total: 60 },
      p2: { controlledPlanets: 4, fleets: 3, units: 9, total: 240 }, // fogged intel
    };
    const view = visibleState(state, 'p1', data);
    expect(view.match.scores.p1).toEqual({ controlledPlanets: 1, fleets: 1, units: 1, total: 60 });
    expect(view.match.scores.p2).toBeUndefined(); // enemy's planet/fleet/unit tally not leaked
    // status/winner stay public; the source state is untouched (purity)
    expect(view.match.status).toBe('ongoing');
    expect(state.match.scores.p2?.total).toBe(240);
  });

  it('keeps the viewer own pending schedule, drops enemy timers (no future-intent leak)', () => {
    const state = scenario();
    // own construction (A is p1's) survives; an enemy build (C is p2's) and an
    // owner-less event are stripped — so a player sees their own build queue, not the foe's.
    state.scheduled = [
      {
        id: 'own',
        at: 10,
        type: 'construction.complete',
        payload: { planetId: 'A', building: 'mine' },
        seq: 0,
      },
      {
        id: 'enemy',
        at: 20,
        type: 'construction.complete',
        payload: { planetId: 'C', building: 'mine' },
        seq: 1,
      },
      { id: 'none', at: 5, type: 'fleet.arrived', payload: {}, seq: 2 },
    ];
    expect(visibleState(state, 'p1', data).scheduled.map((e) => e.id)).toEqual(['own']);
  });

  it('keeps owner-tagged and own-fleet-tagged timers, drops the foe’s (all four branches)', () => {
    const state = scenario();
    // `scheduledOwnedBy` has four ownership reads: planetId, playerId (covered by
    // the neighbouring tests), plus the `owner` tag and the fleet-ownership lookup
    // — both security-relevant (a regression leaks enemy timers). Pin the last two.
    state.scheduled = [
      { id: 'own-owner', at: 10, type: 'x.tick', payload: { owner: 'p1' }, seq: 0 },
      { id: 'foe-owner', at: 11, type: 'x.tick', payload: { owner: 'p2' }, seq: 1 },
      { id: 'own-fleet', at: 12, type: 'fleet.arrival', payload: { fleetId: 'mine-1' }, seq: 2 },
      {
        id: 'foe-fleet',
        at: 13,
        type: 'fleet.arrival',
        payload: { fleetId: 'enemy-near' },
        seq: 3,
      },
    ];
    expect(visibleState(state, 'p1', data).scheduled.map((e) => e.id)).toEqual([
      'own-owner',
      'own-fleet',
    ]);
  });

  it('keeps the viewer own playerId-tagged timers (e.g. research), drops the foe’s', () => {
    const state = scenario();
    // `technology.complete` is tagged by playerId, not owner/planetId/fleetId — the
    // viewer must still see their OWN research ETA, and never the enemy's.
    state.scheduled = [
      {
        id: 'my-research',
        at: 30,
        type: 'technology.complete',
        payload: { playerId: 'p1', technology: 't' },
        seq: 0,
      },
      {
        id: 'foe-research',
        at: 40,
        type: 'technology.complete',
        payload: { playerId: 'p2', technology: 't' },
        seq: 1,
      },
    ];
    expect(visibleState(state, 'p1', data).scheduled.map((e) => e.id)).toEqual(['my-research']);
  });

  it('serialized view never contains hidden data (the real anti-leak test)', () => {
    const json = JSON.stringify(visibleState(scenario(), 'p1', data));
    expect(json).not.toContain('enemy-hidden'); // unseen fleet id
    expect(json).not.toContain('hidden_world'); // unseen planet content
  });

  it('is pure — the input state is untouched', () => {
    const state = scenario();
    visibleState(state, 'p1', data);
    expect(state.fleets['enemy-hidden']).toBeDefined();
    expect(state.planets.D?.planetType).toBe('hidden_world');
    expect(state.scheduled).toHaveLength(1);
    expect(state.players.p2?.resources).toEqual({ metal: 99 });
  });

  it('the enemy sees their own side (symmetry, graceful)', () => {
    const view = visibleState(scenario(), 'p2', data);
    expect(view.planets.C?.owner).toBe('p2');
    expect(view.planets.D?.owner).toBe('p2');
    expect(view.players.p2?.resources).toEqual({ metal: 99 });
  });

  // A→Y are one jump apart and physically close (50 units). p1 owns no world here;
  // its only sight is the lone fleet at X. A radarless ship is a blind kitten.
  function loneFleet(units: Array<[string, number]>): GameState {
    const base = createInitialState({ seed: 'blind', version: { data: '0.1.0', manifest: '1' } });
    return {
      ...base,
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        X: planet('X', null, ['Y'], {
          position: { x: 0, y: 0 },
          garrison: [{ unit: 'cruiser', count: 1 }],
        }),
        Y: planet('Y', 'p2', ['X'], {
          position: { x: 50, y: 0 },
          garrison: [{ unit: 'cruiser', count: 3 }],
          planetType: 'secret_world',
        }),
      },
      fleets: { lone: fleet('lone', 'p1', 'X', units) },
    };
  }

  it('a radarless fleet sees only the node it occupies (near-blind ships)', () => {
    const view = visibleState(loneFleet([['cruiser', 1]]), 'p1', data);
    expect(view.planets.X?.garrison).toHaveLength(1); // own node identified
    expect(view.planets.Y?.owner).toBeNull(); // the 1-jump neighbour is NOT revealed
    expect(view.planets.Y?.garrison).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('secret_world'); // anti-leak
  });

  it('a radar-equipped fleet restores sight by distance (radar module)', () => {
    // The same fleet carrying a scout (radarRange 350): Y at 50 units is well within
    // the inner identify half (175) → fully revealed. Sight comes from the module.
    const view = visibleState(
      loneFleet([
        ['cruiser', 1],
        ['scout', 1],
      ]),
      'p1',
      data,
    );
    expect(view.planets.Y?.owner).toBe('p2');
    expect(view.planets.Y?.garrison).toHaveLength(1);
  });

  it('a viewer party to NO offers gets no diplomacyOffers key at all (no first-offer leak)', () => {
    const state = scenario();
    state.players.p3 = player('p3');
    state.diplomacyOffers = { 'p2>p3': 'alliance' };
    const view = visibleState(state, 'p1', data);
    // not an empty {} — the key is gone, so a third party's delta stays silent
    expect('diplomacyOffers' in view).toBe(false);
  });
});

describe('visibleState — province kind is fog-gated (no appearance leak)', () => {
  // p1 sees only its lone fleet at X; the distant enemy node E (kind void_station) is
  // unseen. Its TRUE kind must not leak — else a client would render its real
  // appearance through the fog.
  function state(fog?: GameState['fog']): GameState {
    const base = createInitialState({ seed: 'fogkind', version: { data: '0.1.0', manifest: '1' } });
    const s: GameState = {
      ...base,
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        X: planet('X', null, [], { position: { x: 0, y: 0 }, kind: 'empty' }),
        E: planet('E', 'p2', [], { position: { x: 9000, y: 0 }, kind: 'void_station' }),
      },
      fleets: { lone: fleet('lone', 'p1', 'X', [['cruiser', 1]]) },
    };
    if (fog) s.fog = fog;
    return s;
  }

  it('an unseen node never ships its true kind', () => {
    const view = visibleState(state(), 'p1', data);
    expect(view.planets.E?.kind).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('void_station');
  });

  it('a remembered node shows its snapshotted kind, not the live one', () => {
    // p1 remembers E as plain `empty` (older snapshot); it has since become void_station.
    const view = visibleState(
      state({ p1: { E: { owner: null, garrison: [], buildings: [], kind: 'empty', at: 0 } } }),
      'p1',
      data,
    );
    expect(view.planets.E?.kind).toBe('empty'); // remembered, not the live void_station
    expect(view.remembered).toContain('E');
  });
});

describe('radar tracks the moving ship, not its destination', () => {
  const at = (x: number): Partial<Planet> => ({ position: { x, y: 0 } });

  it('a moving fleet projects radar from its current position', () => {
    const base = createInitialState({
      seed: 'radar-move',
      version: { data: '0.1.0', manifest: '1' },
    });
    const state: GameState = {
      ...base,
      time: 100, // 10% along a 0→1000 leg ⇒ the ship is at x=100
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        ST: planet('ST', 'p1', ['EN'], at(0)),
        EN: planet('EN', null, ['ST'], at(1000)),
        P1: planet('P1', null, [], at(300)), // 200 from the ship (x=100) — in radar (350)
        P2: planet('P2', null, [], at(900)), // 800 from the ship — only near the DESTINATION
      },
      fleets: {
        mover: {
          id: 'mover',
          owner: 'p1',
          location: null,
          movement: { from: 'ST', to: 'EN', departedAt: 0, arrivesAt: 1000 },
          units: [{ unit: 'scout', count: 1 }], // scout: radarRange 350
          traits: [],
        },
        'foe-near': fleet('foe-near', 'p2', 'P1', [['cruiser', 1]]),
        'foe-far': fleet('foe-far', 'p2', 'P2', [['cruiser', 1]]),
      },
    };

    const view = visibleState(state, 'p1', data);
    // Centred on the SHIP (x=100): the enemy near the start (P1) is sensed; the one
    // near the destination (P2) is not. The old bug anchored radar at `movement.to`
    // and would have reversed this.
    expect(view.signatures.some((s) => s.location === 'P1')).toBe(true);
    expect(view.signatures.some((s) => s.location === 'P2')).toBe(false);
    expect(view.fleets['foe-far']).toBeUndefined(); // out of the ship's radar → removed
  });
});

describe('ECON-2 · blackout halves the viewer’s radar reach (unpaid energy)', () => {
  const contactLocs = (state: GameState): string[] =>
    (visibleState(state, 'p1', data).signatures ?? []).map((c) => c.location);

  it('energy arrears drop the distance contacts; identity-by-jumps survives', () => {
    // Base reach 300 sees C (x=250) and E (x=180); ×0.5 = 150 sees neither.
    const lit = scenario();
    expect(contactLocs(lit)).toEqual(expect.arrayContaining(['C', 'E']));
    const dark = scenario();
    dark.players.p1!.arrears = ['energy'];
    const dimmed = contactLocs(dark);
    expect(dimmed).not.toContain('C');
    expect(dimmed).not.toContain('E');
    // The jump-based identify (A,B) is sensors-on-the-ground, not radar — intact.
    expect(visibleState(dark, 'p1', data).planets.B?.garrison).not.toEqual([]);
  });

  it('a non-energy arrears (credits) leaves the scope untouched, and the enemy’s radar is his own', () => {
    const broke = scenario();
    broke.players.p1!.arrears = ['credits'];
    expect(contactLocs(broke)).toEqual(expect.arrayContaining(['C', 'E']));
    // p2 in blackout does not dim p1's screens.
    const enemyDark = scenario();
    enemyDark.players.p2!.arrears = ['energy'];
    expect(contactLocs(enemyDark)).toEqual(expect.arrayContaining(['C', 'E']));
  });
});

describe('radar reach is stretched by tech / faction bonuses (A2)', () => {
  // In `scenario`, p1's level-1 radar at A reaches 300: D (x=450, hosting
  // `enemy-hidden`) is dark. A +50% bonus reaches 450 — D blips on radar but
  // stays outside the identify half (225), so it is a contact, not an identity.
  it('a completed technology with radarRangeBonus extends a world radar', () => {
    const state = scenario();
    state.players.p1!.technologies = { completed: ['long_scan'] };
    const view = visibleState(state, 'p1', data);
    expect(view.signatures).toContainEqual({ location: 'D', size: 'L' });
    expect(view.fleets['enemy-hidden']).toBeUndefined(); // a blip, not a fleet
    expect(view.planets.D?.garrison).toEqual([]); // world contents still fogged
  });

  it('a faction passive radarRangeBonus does the same', () => {
    const state = scenario();
    state.players.p1!.faction = 'farsight';
    const view = visibleState(state, 'p1', data);
    expect(view.signatures).toContainEqual({ location: 'D', size: 'L' });
  });

  it('stretches a fleet-carried radar too', () => {
    const base = createInitialState({ seed: 'stretch', version: { data: '0.1.0', manifest: '1' } });
    const state: GameState = {
      ...base,
      players: {
        p1: { ...player('p1'), technologies: { completed: ['long_scan'] } },
        p2: player('p2'),
      },
      planets: {
        X: planet('X', null, ['Z'], { position: { x: 0, y: 0 } }),
        Z: planet('Z', 'p2', ['X'], { position: { x: 400, y: 0 } }),
      },
      fleets: {
        probe: fleet('probe', 'p1', 'X', [['scout', 1]]), // radarRange 350
        lurker: fleet('lurker', 'p2', 'Z', [['cruiser', 4]]), // signature 16 → ◆L
      },
    };
    // 350 < 400: dark without the tech; ×1.5 = 525 ≥ 400: the lurker blips.
    const dark = visibleState(
      { ...state, players: { ...state.players, p1: player('p1') } },
      'p1',
      data,
    );
    expect(dark.signatures).toEqual([]);
    const lit = visibleState(state, 'p1', data);
    expect(lit.signatures).toContainEqual({ location: 'Z', size: 'L' });
  });
});

describe('isVisibleTo — the ad-hoc identify query (A4)', () => {
  // Coverage in `scenario` for p1: A owned, B identified (1 jump), C/E radar-only,
  // D beyond everything.
  it('answers by the same rule the projection cuts by', () => {
    const state = scenario();
    expect(isVisibleTo(state, 'p1', { planetId: 'A' }, data)).toBe(true); // own world
    expect(isVisibleTo(state, 'p1', { planetId: 'B' }, data)).toBe(true); // identified
    expect(isVisibleTo(state, 'p1', { planetId: 'C' }, data)).toBe(false); // radar blip ≠ seen
    expect(isVisibleTo(state, 'p1', { planetId: 'D' }, data)).toBe(false); // dark
    expect(isVisibleTo(state, 'p1', { fleetId: 'mine-1' }, data)).toBe(true); // own fleet
    expect(isVisibleTo(state, 'p1', { fleetId: 'enemy-near' }, data)).toBe(true); // at identified B
    expect(isVisibleTo(state, 'p1', { fleetId: 'enemy-radar' }, data)).toBe(false); // contact only
    expect(isVisibleTo(state, 'p1', { fleetId: 'enemy-hidden' }, data)).toBe(false);
  });

  it('remembered is not visible, and unknown ids fail secure', () => {
    const state = scenario();
    // p1 once saw D — memory alone must not answer "visible now".
    state.fog = { p1: { D: { owner: 'p2', garrison: [], buildings: [], at: 0 } } };
    expect(isVisibleTo(state, 'p1', { planetId: 'D' }, data)).toBe(false);
    expect(isVisibleTo(state, 'p1', { planetId: 'ghost' }, data)).toBe(false);
    expect(isVisibleTo(state, 'p1', { fleetId: 'ghost' }, data)).toBe(false);
  });
});

// Moved from the fog-memory MODULE's test file: this block exercises only the
// state-layer projection (`visibleState`), so it lives with the projection.
describe('radar — two concentric ranges (inner full-reveal, outer signatures)', () => {
  const rdata: GameData = parseGameData({
    version: '0.1.0',
    resources: ['metal'],
    units: {
      cruiser: { faction: 'x', stats: { attack: 4, defense: 4, speed: 6, hp: 20 }, signature: 6 },
    },
    factions: {},
    buildings: { radar: { name: 'Radar', radarRange: 100 } }, // reach 100 → reveal ≤50, signature ≤100
    events: {},
  });
  const enemy = (id: string, location: string): Fleet => ({
    id,
    owner: 'p2',
    location,
    movement: null,
    units: [{ unit: 'cruiser', count: 2 }],
    traits: [],
  });
  function radarState(): GameState {
    return {
      ...createInitialState({ seed: 'r', version: { data: '0.1.0', manifest: '1' } }),
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        H: planet('H', 'p1', [], {
          position: { x: 0, y: 0 },
          buildings: [{ type: 'radar', level: 1, hp: 0 }],
        }),
        NEAR: planet('NEAR', null, [], { position: { x: 40, y: 0 } }), // ≤50 → full reveal
        MID: planet('MID', null, [], { position: { x: 80, y: 0 } }), //  50<d≤100 → signature
        FAR: planet('FAR', null, [], { position: { x: 200, y: 0 } }), // >100 → nothing
      },
      fleets: {
        fNear: enemy('fNear', 'NEAR'),
        fMid: enemy('fMid', 'MID'),
        fFar: enemy('fFar', 'FAR'),
      },
    };
  }

  it('identifies inside the inner half, signatures the outer half, hides beyond', () => {
    const view = visibleState(radarState(), 'p1', rdata);
    // inner (≤ reach/2 = 50): NEAR at 40 → enemy fleet fully identified, stays in view
    expect(view.fleets.fNear).toBeDefined();
    expect(view.fleets.fNear?.units).toEqual([{ unit: 'cruiser', count: 2 }]);
    // outer (50 < d ≤ 100): MID at 80 → coarse signature only, the fleet is stripped
    expect(view.fleets.fMid).toBeUndefined();
    expect(view.signatures.map((s) => s.location)).toContain('MID');
    // beyond reach (> 100): FAR at 200 → no fleet, no signature
    expect(view.fleets.fFar).toBeUndefined();
    expect(view.signatures.map((s) => s.location)).not.toContain('FAR');
  });
});
