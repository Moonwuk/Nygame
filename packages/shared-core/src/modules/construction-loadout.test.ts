import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, AdvanceResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 10, defense: 8, speed: 6, hp: 40, shield: 15, cargoCapacity: 2 },
      cost: { metal: 100 },
      buildTimeHours: 0, // instant, so advanceTo(now) completes it
      slots: { weapon: 1, defense: 1, utility: 1 },
    },
  },
  factions: {},
  buildings: {
    shipyard: { name: 'Shipyard', cost: {}, buildTimeHours: 0, hp: 20, enablesShipConstruction: true },
  },
  events: {},
  modules: {
    targeting: { name: 'T', slot: 'weapon', tag: 'vertical', effects: { stats: { attack: 4 } }, cost: { metal: 60 } },
    plating: { name: 'P', slot: 'defense', tag: 'vertical', effects: { stats: { hp: 12 } }, cost: { metal: 50 } },
    cargo: { name: 'C', slot: 'utility', tag: 'horizontal', effects: { stats: { cargoCapacity: 6 } }, cost: { metal: 45 } },
  },
});
const ctx = (now: number): Context => ({ now, data });

function world(metal = 5000): GameState {
  const s = createInitialState({ seed: 'ld', version: { data: '0.1.0', manifest: '1' } });
  const p1: Player = { id: 'p1', name: 'p1', faction: 'x', status: 'active', resources: { metal } };
  const A: Planet = {
    id: 'A',
    owner: 'p1',
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [{ type: 'shipyard', level: 1, hp: 20 }],
    garrison: [],
    traits: [],
  };
  return { ...s, players: { p1 }, planets: { A } };
}
const build = (modules?: string[], count = 1, seq = 1): Action => ({
  id: `s:p1:${seq}`,
  type: 'unit.build',
  playerId: 'p1',
  payload: { planetId: 'A', unit: 'cruiser', count, modules },
  issuedAt: 0,
});
function ok(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdv(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error('advance failed');
  return r;
}
function err(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
const kernel = createKernel([constructionModule]);

describe('unit.build with a loadout (MOD-3) — charge, stamp, lock, merge identity', () => {
  it('charges hull + modules up-front and stamps the loadout onto the built stack', () => {
    const ordered = ok(kernel.applyAction(world(1000), build(['targeting', 'cargo']), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(1000 - (100 + 60 + 45)); // 795
    const done = okAdv(kernel.advanceTo(ordered.state, ctx(0)));
    const garrison = done.state.planets.A?.garrison ?? [];
    expect(garrison).toHaveLength(1);
    expect(garrison[0]).toMatchObject({ unit: 'cruiser', count: 1 });
    expect([...(garrison[0]?.modules ?? [])].sort()).toEqual(['cargo', 'targeting']);
  });

  it('scales the loadout cost by the order count', () => {
    const ordered = ok(kernel.applyAction(world(1000), build(['targeting'], 3), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(1000 - (100 + 60) * 3); // 520
  });

  it('rejects an illegal or unaffordable loadout, fail-secure', () => {
    expect(err(kernel.applyAction(world(), build(['targeting', 'targeting']), ctx(0)))).toBe('E_DUP_MODULE');
    expect(err(kernel.applyAction(world(), build(['ghost']), ctx(0)))).toBe('E_UNKNOWN_MODULE');
    expect(err(kernel.applyAction(world(), build([42] as unknown as string[]), ctx(0)))).toBe('E_BAD_PAYLOAD');
    expect(err(kernel.applyAction(world(150), build(['targeting']), ctx(0)))).toBe('E_INSUFFICIENT'); // 160 > 150
  });

  it('keeps different loadouts as separate stacks and merges identical ones', () => {
    let s = world(9000);
    s = ok(kernel.applyAction(s, build(['targeting'], 1, 1), ctx(0))).state;
    s = okAdv(kernel.advanceTo(s, ctx(0))).state;
    s = ok(kernel.applyAction(s, build(['cargo'], 1, 2), ctx(0))).state;
    s = okAdv(kernel.advanceTo(s, ctx(0))).state;
    s = ok(kernel.applyAction(s, build(['targeting'], 1, 3), ctx(0))).state; // same fit as build #1
    s = okAdv(kernel.advanceTo(s, ctx(0))).state;
    const g = s.planets.A?.garrison ?? [];
    expect(g).toHaveLength(2); // {targeting}×2 and {cargo}×1
    expect(g.find((x) => x.modules?.includes('targeting'))?.count).toBe(2);
    expect(g.find((x) => x.modules?.includes('cargo'))?.count).toBe(1);
  });

  it('a bare-hull build still works and carries no modules (unchanged path)', () => {
    const ordered = ok(kernel.applyAction(world(1000), build(), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(900); // hull only
    const done = okAdv(kernel.advanceTo(ordered.state, ctx(0)));
    expect(done.state.planets.A?.garrison[0]?.modules).toBeUndefined();
  });
});
