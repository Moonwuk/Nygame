import { describe, expect, it } from 'vitest';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import {
  createInitialState,
  type ActiveResearch,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { constructionModule } from './construction';
import { economyModule } from './economy';
import { movementModule } from './movement';
import { technologyModule } from './technology';

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {
    scout: { faction: 'x', stats: { attack: 2, defense: 1, speed: 10, hp: 6 } },
    dropship: {
      faction: 'x',
      stats: { attack: 2, defense: 4, speed: 5, hp: 20, cargoCapacity: 8 },
      cost: { metal: 10 },
    },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 } },
    refinery: { name: 'Refinery', cost: { metal: 20 }, buildTimeHours: 1 },
  },
  events: {},
  technologies: {
    industry: {
      name: 'Industry',
      cost: { metal: 10 },
      researchTimeHours: 1,
      unlocks: { buildings: ['refinery'] },
      effects: { productionBonus: 0.25 },
    },
    logistics: {
      name: 'Logistics',
      branch: 'space',
      cost: { credits: 10 },
      researchTimeHours: 2,
      unlocks: { units: ['dropship'] },
      effects: { fleetSpeedBonus: 0.5 },
    },
    siege: {
      name: 'Siege',
      cost: { credits: 10 },
      researchTimeHours: 3,
      prerequisites: ['logistics'],
      effects: { combatDamageBonus: 0.1 },
    },
    blockade: {
      name: 'Blockade',
      cost: { metal: 10 },
      researchTimeHours: 1,
      dayGate: 2,
    },
    orbital_net: {
      name: 'Orbital Net',
      cost: { metal: 10 },
      researchTimeHours: 1,
      conditions: [{ type: 'own_sectors', min: 2 }],
    },
    fusion: {
      name: 'Fusion',
      cost: { metal: 10 },
      researchTimeHours: 1,
      conditions: [{ type: 'has_building', building: 'refinery' }],
    },
    terraforming: {
      name: 'Terraforming',
      cost: { metal: 10 },
      researchTimeHours: 1,
      conditions: [{ type: 'controls_planet_type', planetType: 'gas_giant' }],
    },
    carriers: {
      name: 'Carriers',
      cost: { metal: 10 },
      researchTimeHours: 1,
      conditions: [{ type: 'has_unit', unit: 'scout' }],
    },
    fusion_plus: {
      name: 'Fusion+',
      cost: { metal: 10 },
      researchTimeHours: 1,
      conditions: [{ type: 'has_building', building: 'refinery', min: 2 }],
    },
    mining: { name: 'Mining', cost: { metal: 5 }, researchTimeHours: 1 },
    smelting: { name: 'Smelting', cost: { metal: 5 }, researchTimeHours: 1 },
    void_doctrine: {
      name: 'Void Doctrine',
      cost: { metal: 5 },
      researchTimeHours: 1,
      conditions: [{ type: 'has_scientist', branch: 'space' }],
    },
    capstone_ship: {
      name: 'Capstone Ship',
      cost: { metal: 5 },
      researchTimeHours: 1,
      conditions: [{ type: 'has_scientist', branch: 'space', minLevel: 5 }],
    },
  },
  scientists: {
    void_sci: { name: 'Void Sci', branch: 'space' },
    ground_sci: { name: 'Ground Sci', branch: 'ground' },
    slot_sci: { name: 'Slot Sci', slotBonus: 1 },
  },
});

const ctx = (now: number, timeScale?: number): Context =>
  timeScale === undefined ? { now, data } : { now, data, config: { timeScale } };

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}

function planet(id: string, owner: string | null, links: string[] = []): Planet {
  return {
    id,
    owner,
    position: id === 'A' ? { x: 0, y: 0 } : { x: 30, y: 0 },
    links,
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}

function fleet(id: string, owner: string, location: string): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: [{ unit: 'scout', count: 1 }],
    traits: [],
  };
}

function stateWith(opts: { players?: Player[]; planets?: Planet[]; fleets?: Fleet[] }): GameState {
  const s = createInitialState({ seed: 'tech', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  const fleets: Record<string, Fleet> = {};
  for (const x of opts.fleets ?? []) fleets[x.id] = x;
  return { ...s, players, planets, fleets };
}

function research(technology: string, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:1`,
    type: 'technology.research',
    playerId,
    payload: { technology },
    issuedAt: 0,
  };
}

function buildUnit(unit: string): Action {
  return {
    id: 's:p1:1',
    type: 'unit.build',
    playerId: 'p1',
    payload: { planetId: 'A', unit },
    issuedAt: 0,
  };
}

function construct(building: string): Action {
  return {
    id: 's:p1:1',
    type: 'building.construct',
    playerId: 'p1',
    payload: { planetId: 'A', building },
    issuedAt: 0,
  };
}

function move(fleetId: string, to: string): Action {
  return {
    id: 's:p1:1',
    type: 'fleet.move',
    playerId: 'p1',
    payload: { fleetId, to },
    issuedAt: 0,
  };
}

function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}

function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

describe('technology module — session research tree', () => {
  it('day-gate: a node stays locked until the match reaches session day N', () => {
    const kernel = createKernel([technologyModule]);
    const DAY = 24 * HOUR; // = MS_PER_DAY
    // World clock at `t` (match started at 0 ⇒ startedAt 0); ctx.now tracks state.time.
    const at = (t: number) => ({ ...stateWith({ players: [player('p1', { metal: 30 })] }), time: t });

    // blockade has dayGate 2 → locked until world day 2 = 2 * MS_PER_DAY.
    expect(errCode(kernel.applyAction(at(0), research('blockade'), ctx(0)))).toBe('E_TOO_EARLY');
    expect(
      errCode(kernel.applyAction(at(2 * DAY - 1), research('blockade'), ctx(2 * DAY - 1))),
    ).toBe('E_TOO_EARLY');

    // From day 2 it researches; resources are spent only once it is available.
    const ok = okApply(kernel.applyAction(at(2 * DAY), research('blockade'), ctx(2 * DAY)));
    expect(ok.state.players.p1?.resources.metal).toBe(20);
    expect(ok.state.players.p1?.technologies?.active?.[0]?.technology).toBe('blockade');

    // The gate counts the WORLD clock (state.time), exactly like the match-browser day
    // count — independent of the kernel ctx timeScale (the room runs the clock fast).
    expect(
      errCode(kernel.applyAction(at(2 * DAY - 1), research('blockade'), ctx(2 * DAY - 1, 4))),
    ).toBe('E_TOO_EARLY');
    expect(okApply(kernel.applyAction(at(2 * DAY), research('blockade'), ctx(2 * DAY, 4))).ok).toBe(
      true,
    );

    // dayGate 0 / absent ⇒ available from the start (existing techs unchanged).
    expect(okApply(kernel.applyAction(at(0), research('industry'), ctx(0))).ok).toBe(true);
  });

  it('parses a tech branch and defaults it for nodes that omit it (back-compat)', () => {
    expect(data.technologies.logistics?.branch).toBe('space'); // explicit in fixture
    expect(data.technologies.industry?.branch).toBe('space'); // schema default
    const byBranch: Record<string, string[]> = {};
    for (const [id, def] of Object.entries(data.technologies)) {
      (byBranch[def.branch] ??= []).push(id);
    }
    expect(byBranch.space).toContain('logistics');
    expect(
      Object.keys(byBranch).every((b) => ['ground', 'space', 'squadron', 'missile'].includes(b)),
    ).toBe(true);
  });

  it('conditions gate research on curated, data-driven predicates', () => {
    const kernel = createKernel([technologyModule]);
    const p1 = () => player('p1', { metal: 30 });
    const lockedFor = (tech: string, opts: Parameters<typeof stateWith>[0]) =>
      errCode(kernel.applyAction(stateWith(opts), research(tech), ctx(0)));
    const openFor = (tech: string, opts: Parameters<typeof stateWith>[0]) =>
      okApply(kernel.applyAction(stateWith(opts), research(tech), ctx(0))).ok;

    // own_sectors ≥ 2: locked with one world, open with two.
    expect(lockedFor('orbital_net', { players: [p1()], planets: [planet('A', 'p1')] })).toBe(
      'E_CONDITIONS_UNMET',
    );
    expect(
      openFor('orbital_net', { players: [p1()], planets: [planet('A', 'p1'), planet('B', 'p1')] }),
    ).toBe(true);

    // has_building: locked until an owned world has the refinery.
    expect(lockedFor('fusion', { players: [p1()], planets: [planet('A', 'p1')] })).toBe(
      'E_CONDITIONS_UNMET',
    );
    expect(
      openFor('fusion', {
        players: [p1()],
        planets: [{ ...planet('A', 'p1'), buildings: [{ type: 'refinery', level: 1, hp: 10 }] }],
      }),
    ).toBe(true);

    // controls_planet_type: needs an owned world of that type.
    expect(lockedFor('terraforming', { players: [p1()], planets: [planet('A', 'p1')] })).toBe(
      'E_CONDITIONS_UNMET',
    );
    expect(
      openFor('terraforming', {
        players: [p1()],
        planets: [{ ...planet('A', 'p1'), planetType: 'gas_giant' }],
      }),
    ).toBe(true);

    // has_unit: fleet, garrison, and cargo all count toward the total.
    expect(lockedFor('carriers', { players: [p1()], planets: [planet('A', 'p1')] })).toBe(
      'E_CONDITIONS_UNMET',
    );
    expect(openFor('carriers', { players: [p1()], fleets: [fleet('f1', 'p1', 'A')] })).toBe(true);
    expect(
      openFor('carriers', {
        players: [p1()],
        planets: [{ ...planet('A', 'p1'), garrison: [{ unit: 'scout', count: 1 }] }],
      }),
    ).toBe(true);
    expect(
      openFor('carriers', {
        players: [p1()],
        fleets: [{ ...fleet('f1', 'p1', 'A'), units: [], landing: [{ unit: 'scout', count: 1 }] }],
      }),
    ).toBe(true);

    // count-based (min > 1): the data `min` is the balancing lever — two refineries
    // open the "+" tier, one does not.
    const refineries = (n: number) => ({
      players: [p1()],
      planets: [
        {
          ...planet('A', 'p1'),
          buildings: Array.from({ length: n }, () => ({ type: 'refinery', level: 1, hp: 10 })),
        },
      ],
    });
    expect(lockedFor('fusion_plus', refineries(1))).toBe('E_CONDITIONS_UNMET');
    expect(openFor('fusion_plus', refineries(2))).toBe(true);
  });

  it('has_scientist passes if ANY of the 2 council leaders qualifies (scientists[])', () => {
    const kernel = createKernel([technologyModule]);
    const council = (list: Array<{ id: string; level: number }>): GameState => {
      const s = stateWith({ players: [player('p1', { metal: 30 })] });
      (s.players.p1 as Player).scientists = list;
      return s;
    };
    // A lone ground leader does NOT open the space-focus gate…
    expect(
      errCode(
        kernel.applyAction(council([{ id: 'ground_sci', level: 9 }]), research('void_doctrine'), ctx(0)),
      ),
    ).toBe('E_CONDITIONS_UNMET');
    // …but a ground + space council does — the space leader in the other slot satisfies it.
    expect(
      okApply(
        kernel.applyAction(
          council([
            { id: 'ground_sci', level: 9 },
            { id: 'void_sci', level: 1 },
          ]),
          research('void_doctrine'),
          ctx(0),
        ),
      ).ok,
    ).toBe(true);
  });

  it('has_scientist gates branch-focus and capstone content on the chosen leader', () => {
    const kernel = createKernel([technologyModule]);
    const withScientist = (sci?: { id: string; level: number }): GameState => {
      const s = stateWith({ players: [player('p1', { metal: 30 })] });
      if (sci) (s.players.p1 as Player).scientist = sci;
      return s;
    };

    // No leader → space-focus content is locked; wrong branch stays locked.
    expect(errCode(kernel.applyAction(withScientist(), research('void_doctrine'), ctx(0)))).toBe(
      'E_CONDITIONS_UNMET',
    );
    expect(
      errCode(
        kernel.applyAction(
          withScientist({ id: 'ground_sci', level: 9 }),
          research('void_doctrine'),
          ctx(0),
        ),
      ),
    ).toBe('E_CONDITIONS_UNMET');

    // A space leader unlocks the branch focus.
    expect(
      okApply(
        kernel.applyAction(
          withScientist({ id: 'void_sci', level: 1 }),
          research('void_doctrine'),
          ctx(0),
        ),
      ).ok,
    ).toBe(true);

    // Capstone needs the leader at level ≥ 5: locked at 4, open at 5.
    expect(
      errCode(
        kernel.applyAction(
          withScientist({ id: 'void_sci', level: 4 }),
          research('capstone_ship'),
          ctx(0),
        ),
      ),
    ).toBe('E_CONDITIONS_UNMET');
    expect(
      okApply(
        kernel.applyAction(
          withScientist({ id: 'void_sci', level: 5 }),
          research('capstone_ship'),
          ctx(0),
        ),
      ).ok,
    ).toBe(true);

    // A branchless leader (the +slot generalist) satisfies no branch-focus gate —
    // the opportunity cost of picking +slot instead of a focus.
    expect(
      errCode(
        kernel.applyAction(
          withScientist({ id: 'slot_sci', level: 9 }),
          research('void_doctrine'),
          ctx(0),
        ),
      ),
    ).toBe('E_CONDITIONS_UNMET');
    // An id absent from the catalog satisfies nothing.
    expect(
      errCode(
        kernel.applyAction(withScientist({ id: 'ghost', level: 9 }), research('void_doctrine'), ctx(0)),
      ),
    ).toBe('E_CONDITIONS_UNMET');
  });

  it('pays up front, records active research, then completes on the timeline', () => {
    const kernel = createKernel([technologyModule]);
    const st = stateWith({ players: [player('p1', { metal: 30 })] });

    const started = okApply(kernel.applyAction(st, research('industry'), ctx(0)));
    expect(started.state.players.p1?.resources.metal).toBe(20);
    expect(started.state.players.p1?.technologies?.active).toEqual([
      { technology: 'industry', startedAt: 0, completesAt: HOUR },
    ]);
    expect(started.state.players.p1?.technologies?.completed).toEqual([]);

    const early = okAdvance(kernel.advanceTo(started.state, ctx(HOUR - 1)));
    expect(early.state.players.p1?.technologies?.completed).toEqual([]);

    const done = okAdvance(kernel.advanceTo(early.state, ctx(HOUR)));
    expect(done.state.players.p1?.technologies?.active).toEqual([]);
    expect(done.state.players.p1?.technologies?.completed).toEqual(['industry']);
    expect(done.events.some((event) => event.type === 'technology.researched')).toBe(true);
  });

  it('rejects missing prerequisites, duplicate research, full slots and bad inputs', () => {
    const kernel = createKernel([technologyModule]);
    const st = stateWith({ players: [player('p1', { metal: 30, credits: 30 })] });

    expect(errCode(kernel.applyAction(st, research('siege'), ctx(0)))).toBe('E_PREREQUISITE');
    expect(errCode(kernel.applyAction(st, research('missing'), ctx(0)))).toBe(
      'E_UNKNOWN_TECHNOLOGY',
    );
    expect(errCode(kernel.applyAction(st, { ...research('industry'), payload: {} }, ctx(0)))).toBe(
      'E_BAD_PAYLOAD',
    );

    // Two concurrent researches fill the 2 base slots; a third is rejected.
    const one = okApply(kernel.applyAction(st, research('industry'), ctx(0)));
    const two = okApply(kernel.applyAction(one.state, research('logistics'), ctx(0)));
    expect(two.state.players.p1?.technologies?.active?.length).toBe(2);
    expect(errCode(kernel.applyAction(two.state, research('mining'), ctx(0)))).toBe(
      'E_RESEARCH_SLOTS_FULL',
    );

    // The same tech can't occupy two slots at once, nor be re-researched once done.
    expect(errCode(kernel.applyAction(one.state, research('industry'), ctx(0)))).toBe(
      'E_ALREADY_RESEARCHED',
    );
    const done = okAdvance(kernel.advanceTo(two.state, ctx(2 * HOUR)));
    expect(errCode(kernel.applyAction(done.state, research('industry'), ctx(2 * HOUR)))).toBe(
      'E_ALREADY_RESEARCHED',
    );
  });

  it('research slots: 2 base, raised by the research.slots hook, capped at 3', () => {
    const addSlots = (n: number): GameModule => ({
      id: `test-slots-${n}`,
      version: '1.0.0',
      setup(api) {
        api.hook<number>('research.slots', (base) => base + n);
      },
    });
    const st = () => stateWith({ players: [player('p1', { metal: 40, credits: 40 })] });

    // +1 → 3 slots: a third concurrent research now fits.
    const k3 = createKernel([technologyModule, addSlots(1)]);
    let s = okApply(k3.applyAction(st(), research('industry'), ctx(0))).state;
    s = okApply(k3.applyAction(s, research('logistics'), ctx(0))).state;
    s = okApply(k3.applyAction(s, research('mining'), ctx(0))).state;
    expect(s.players.p1?.technologies?.active?.length).toBe(3);

    // +5 is clamped to the design max of 3: a fourth is still rejected.
    const kCap = createKernel([technologyModule, addSlots(5)]);
    let c = okApply(kCap.applyAction(st(), research('industry'), ctx(0))).state;
    c = okApply(kCap.applyAction(c, research('logistics'), ctx(0))).state;
    c = okApply(kCap.applyAction(c, research('mining'), ctx(0))).state;
    expect(errCode(kCap.applyAction(c, research('smelting'), ctx(0)))).toBe('E_RESEARCH_SLOTS_FULL');

    // A misbehaving hook (returns NaN) falls back to the base 2 — never fail-open.
    const kBad = createKernel([technologyModule, addSlots(NaN)]);
    let d = okApply(kBad.applyAction(st(), research('industry'), ctx(0))).state;
    d = okApply(kBad.applyAction(d, research('logistics'), ctx(0))).state;
    expect(errCode(kBad.applyAction(d, research('mining'), ctx(0)))).toBe('E_RESEARCH_SLOTS_FULL');
  });

  it('migrates a legacy single-object active into the slot list', () => {
    const kernel = createKernel([technologyModule]);
    const legacy = stateWith({ players: [player('p1', { metal: 30, credits: 30 })] });
    // A match persisted before slots existed stored `active` as a single object.
    (legacy.players.p1 as Player).technologies = {
      completed: [],
      active: {
        technology: 'industry',
        startedAt: 0,
        completesAt: HOUR,
      } as unknown as ActiveResearch[],
    };
    // Research still works (no E_INTERNAL); the legacy entry becomes slot 1.
    const r = okApply(kernel.applyAction(legacy, research('logistics'), ctx(0)));
    expect(r.state.players.p1?.technologies?.active?.map((a) => a.technology).sort()).toEqual([
      'industry',
      'logistics',
    ]);
  });

  it('gates data-declared unlocks when present and degrades open without the module', () => {
    const lockedKernel = createKernel([technologyModule, constructionModule]);
    const openKernel = createKernel([constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100, credits: 20 })],
      planets: [planet('A', 'p1')],
    });

    expect(errCode(lockedKernel.applyAction(st, buildUnit('dropship'), ctx(0)))).toBe(
      'E_TECH_LOCKED',
    );
    expect(okApply(openKernel.applyAction(st, buildUnit('dropship'), ctx(0))).ok).toBe(true);

    const started = okApply(lockedKernel.applyAction(st, research('logistics'), ctx(0)));
    const done = okAdvance(lockedKernel.advanceTo(started.state, ctx(2 * HOUR)));
    expect(
      okApply(lockedKernel.applyAction(done.state, buildUnit('dropship'), ctx(2 * HOUR))).ok,
    ).toBe(true);
    expect(errCode(lockedKernel.applyAction(st, construct('refinery'), ctx(0)))).toBe(
      'E_TECH_LOCKED',
    );
  });

  it('applies completed session technologies through existing hooks', () => {
    const economyKernel = createKernel([economyModule, technologyModule]);
    const productionState = stateWith({
      players: [
        {
          ...player('p1', { metal: 0 }),
          technologies: { completed: ['industry'] },
        },
      ],
      planets: [
        {
          ...planet('A', 'p1'),
          buildings: [{ type: 'mine', level: 1, hp: 0 }],
        },
      ],
    });
    const produced = okAdvance(economyKernel.advanceTo(productionState, ctx(HOUR)));
    expect(produced.state.players.p1?.resources.metal).toBeCloseTo(12.5);

    const movementKernel = createKernel([movementModule, technologyModule]);
    const movementState = stateWith({
      players: [
        {
          ...player('p1'),
          technologies: { completed: ['logistics'] },
        },
      ],
      planets: [planet('A', 'p1', ['B']), planet('B', null, ['A'])],
      fleets: [fleet('F', 'p1', 'A')],
    });
    const moved = okApply(movementKernel.applyAction(movementState, move('F', 'B'), ctx(0)));
    expect(moved.state.fleets.F?.movement?.arrivesAt).toBeCloseTo(2 * HOUR);
  });
});

describe('technology.boost — the premium research sink (SES-3, GDD §4.3)', () => {
  const kernel = createKernel([technologyModule]);
  const boost = (technology: string, seq = 2): Action => ({
    id: `s:p1:${seq}`,
    type: 'technology.boost',
    playerId: 'p1',
    payload: { technology },
    issuedAt: 0,
  });
  // A researcher with the premium in the treasury (default boost cost = 50 energy).
  const researching = (): GameState =>
    okApply(
      kernel.applyAction(
        stateWith({ players: [player('p1', { metal: 30, energy: 120 })] }),
        research('industry'), // 1h research → completesAt = HOUR
        ctx(0),
      ),
    ).state;

  it('pays the premium cost and cuts the REMAINING time by initialPercent', () => {
    const r = okApply(kernel.applyAction(researching(), boost('industry'), ctx(0)));
    const slot = r.state.players.p1?.technologies?.active?.[0];
    expect(slot).toMatchObject({ technology: 'industry', completesAt: 0.75 * HOUR, boosts: 1 });
    expect(r.state.players.p1?.resources.energy).toBe(70); // 120 − 50
    expect(r.events).toContainEqual({
      type: 'technology.research.boosted',
      payload: { playerId: 'p1', technology: 'industry', completesAt: 0.75 * HOUR, boosts: 1 },
    });
    // The accelerated completion actually fires at the earlier time.
    const done = okAdvance(kernel.advanceTo(r.state, ctx(0.75 * HOUR)));
    expect(done.state.players.p1?.technologies?.completed).toEqual(['industry']);
  });

  it('the ORIGINAL completion event no-ops after a boost (no double completion)', () => {
    const r = okApply(kernel.applyAction(researching(), boost('industry'), ctx(0)));
    // Advance PAST the original completesAt: the boosted event (0.75h) completes the
    // research; the stale original (1h) finds no matching slot and does nothing.
    const done = okAdvance(kernel.advanceTo(r.state, ctx(2 * HOUR)));
    expect(done.state.players.p1?.technologies?.completed).toEqual(['industry']);
    expect(done.state.players.p1?.technologies?.active).toEqual([]);
  });

  it('diminishing returns: each successive boost cuts geometrically less', () => {
    const first = okApply(kernel.applyAction(researching(), boost('industry'), ctx(0)));
    const second = okApply(kernel.applyAction(first.state, boost('industry', 3), ctx(0)));
    const slot = second.state.players.p1?.technologies?.active?.[0];
    // remaining 0.75h × 25% × 0.5¹ = 0.09375h cut → 0.65625h left.
    expect(slot?.completesAt).toBe(0.65625 * HOUR);
    expect(slot?.boosts).toBe(2);
    expect(second.state.players.p1?.resources.energy).toBe(20); // two boosts paid
  });

  it('fail-secure rejections: not active, due, unaffordable, bad payload', () => {
    // Boosting a tech that is not being researched.
    expect(errCode(kernel.applyAction(researching(), boost('logistics'), ctx(0)))).toBe(
      'E_NOT_ACTIVE',
    );
    // Completion already due at now — nothing left to cut.
    const st = researching();
    expect(errCode(kernel.applyAction({ ...st, time: HOUR }, boost('industry'), ctx(HOUR)))).toBe(
      'E_TOO_LATE',
    );
    // Treasury cannot cover the premium price (default 50 energy).
    const broke = okApply(
      kernel.applyAction(
        stateWith({ players: [player('p1', { metal: 30, energy: 10 })] }),
        research('industry'),
        ctx(0),
      ),
    ).state;
    expect(errCode(kernel.applyAction(broke, boost('industry'), ctx(0)))).toBe('E_INSUFFICIENT');
    const bad: Action = { id: 's:p1:9', type: 'technology.boost', playerId: 'p1', payload: {}, issuedAt: 0 };
    expect(errCode(kernel.applyAction(researching(), bad, ctx(0)))).toBe('E_BAD_PAYLOAD');
  });

  it('scales by data.researchBoost — a bundle override changes price and cut', () => {
    const scaled: GameData = {
      ...data,
      researchBoost: { cost: { metal: 5 }, initialPercent: 0.5, decay: 0.5 },
    };
    const st = okApply(
      kernel.applyAction(
        stateWith({ players: [player('p1', { metal: 30 })] }),
        research('industry'),
        { now: 0, data: scaled },
      ),
    ).state;
    const r = okApply(kernel.applyAction(st, boost('industry'), { now: 0, data: scaled }));
    const slot = r.state.players.p1?.technologies?.active?.[0];
    expect(slot?.completesAt).toBe(0.5 * HOUR); // half the remaining hour
    expect(r.state.players.p1?.resources.metal).toBe(15); // 30 − 10 research − 5 boost
  });

  it('the shipped defaults are the owner-decided premium: 50 energy', () => {
    expect(data.researchBoost).toEqual({
      cost: { energy: 50 },
      initialPercent: 0.25,
      decay: 0.5,
    });
  });
});
