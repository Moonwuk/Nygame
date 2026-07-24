import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createKernel } from './kernel';
import { deepFreeze } from '../util/clone';
import type { Context } from '../action/types';
import type { GameState } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import { economyModule } from '../modules/economy';
import { movementModule } from '../modules/movement';
import { combatModule } from '../modules/combat';
import { sectorModule } from '../modules/sector';
import { constructionModule } from '../modules/construction';
import { marketModule } from '../modules/market';
import { arbSeed, arbValidAction, fixtureData, makeFixtureState } from '../testkit/arbitraries';

/**
 * MP-3 (security-master-plan.md): a generic dupe detector, complementary to
 * `GI-2.3`'s targeted checks — a STANDING property instead of a specific test.
 *
 * Scope, chosen deliberately narrow to stay PROVABLY correct rather than risk a
 * flaky or wrong invariant from hand-modeling every accrual/upkeep formula in the
 * engine: `arbValidAction` never calls `advanceTo` (no time-based economy accrual
 * fires) and never draws `market.take`/`market.cancel` (no commission burn, no
 * escrow refund) — under exactly this action mix, every resource-touching handler
 * is a SINK (`unit.build`/`building.construct` pay a real, destroyed cost) or
 * value-preserving (`market.list` moves a resource from a player's balance into
 * the order's `amount` — still owned, still counted). So `totalValue` — every
 * player's resource balances plus every open order's escrowed amount, summed —
 * can only ever STAY THE SAME or DECREASE. An increase means resources appeared
 * from nowhere: exactly the "duped resources" bug class this exists to catch.
 *
 * This is intentionally NOT a claim that overall game economy conserves value
 * (accrual, upkeep, combat losses, and market fees are real, legitimate sources/
 * sinks outside this scope) — see MP-3's own "кроме явных source/sink" carve-out.
 */

const HOUR = 3_600_000;
const E_CODE = /^E_[A-Z_]+$/;

// The shared FUZZ fixture (arbitraries.ts) starts every ownable planet with a
// 'mine' already built and no shipyard anywhere — so under it, EVERY
// unit.build/building.construct draw rejects (E_ALREADY_BUILT / E_NO_SHIPYARD)
// and the property below would be vacuously true, never exercising a real sink.
// Extend the data with a shipyard, and give HOME just that (no pre-built mine),
// so both handlers can genuinely succeed and pay a real cost.
const data: GameData = deepFreeze(
  parseGameData({
    ...fixtureData,
    buildings: {
      ...fixtureData.buildings,
      shipyard: { name: 'Shipyard', enablesShipConstruction: true, cost: { metal: 50 }, buildTimeHours: 1 },
    },
  }),
);
function economyFixtureState(seed: string): GameState {
  const base = makeFixtureState(seed);
  const home = base.planets.HOME;
  if (!home) throw new Error('fixture drift: HOME planet missing');
  // hp > 0: a destroyed (hp<=0) building doesn't count as "standing" for the
  // shipyard gate (construction.ts hasShipyard) — the shared fixture's own
  // buildings default to hp:0 (never mattered until this gate existed).
  return { ...base, planets: { ...base.planets, HOME: { ...home, buildings: [{ type: 'shipyard', level: 1, hp: 20 }] } } };
}

const kernel = createKernel([
  economyModule,
  movementModule,
  combatModule,
  sectorModule,
  constructionModule,
  marketModule,
]);
const ctx = (now: number): Context => ({ now, data });
const arbNow = fc.integer({ min: 0, max: 48 * HOUR });

/** Every unit of value still inside the closed system: players' own balances,
 *  plus resources escrowed into a still-open market order (not gone — owned by
 *  the seller, redeemable by cancel/fill, just not currently in their bag). */
function totalValue(state: GameState): number {
  let total = 0;
  for (const player of Object.values(state.players)) {
    for (const amount of Object.values(player.resources)) total += amount ?? 0;
  }
  for (const order of state.market ?? []) total += order.amount;
  return total;
}

describe('economy-conservation property (MP-3)', () => {
  it('sanity: the fixture is alive — a construction order genuinely pays a real cost', () => {
    const state = deepFreeze(economyFixtureState('sanity'));
    const before = totalValue(state);
    const r = kernel.applyAction(
      state,
      { id: 'fz:p1:0', type: 'building.construct', playerId: 'p1', payload: { planetId: 'HOME', building: 'mine' }, issuedAt: 0 },
      ctx(0),
    );
    expect(r.ok ? 'ok' : r.code).toBe('ok');
    if (!r.ok) return;
    expect(totalValue(r.state)).toBeLessThan(before); // the order's cost was actually spent
  });

  it('sanity: a unit order (needs the shipyard) genuinely pays a real cost', () => {
    const state = deepFreeze(economyFixtureState('sanity-unit'));
    const before = totalValue(state);
    const r = kernel.applyAction(
      state,
      { id: 'fz:p1:0', type: 'unit.build', playerId: 'p1', payload: { planetId: 'HOME', unit: 'cruiser', count: 1 }, issuedAt: 0 },
      ctx(0),
    );
    expect(r.ok ? 'ok' : r.code).toBe('ok');
    if (!r.ok) return;
    expect(totalValue(r.state)).toBeLessThan(before);
  });

  it('never increases across a sequence of valid intents (sink-only under this action mix)', () => {
    fc.assert(
      fc.property(
        arbSeed,
        arbNow,
        fc.array(arbValidAction, { minLength: 1, maxLength: 6 }),
        (seed, now, actions) => {
          let state = economyFixtureState(seed);
          let value = totalValue(state);
          for (const action of actions) {
            const r = kernel.applyAction(deepFreeze(state), action, ctx(now));
            if (!r.ok) {
              expect(r.code).toMatch(E_CODE);
              continue; // a rejected action is a no-op (purity — asserted elsewhere)
            }
            const nextValue = totalValue(r.state);
            expect(nextValue).toBeLessThanOrEqual(value);
            state = r.state;
            value = nextValue;
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  // "Готово, когда... ловит подсаженный дюп" — proven directly on the checker
  // itself (no need to actually corrupt the kernel): a fabricated resource credit
  // of the exact shape a dupe bug would produce is NOT invisible to totalValue.
  it('is sensitive to a planted dupe: a fabricated resource credit registers as an increase', () => {
    const before = economyFixtureState('dupe');
    const p1 = before.players.p1!;
    const after: GameState = {
      ...before,
      players: { ...before.players, p1: { ...p1, resources: { ...p1.resources, metal: (p1.resources.metal ?? 0) + 1000 } } },
    };
    expect(totalValue(after)).toBeGreaterThan(totalValue(before));
  });

  it('is sensitive to a planted dupe via a phantom market order (escrowed value with no matching debit)', () => {
    const before = economyFixtureState('dupe-market');
    const after: GameState = {
      ...before,
      market: [...(before.market ?? []), { id: 'phantom', seller: 'p1', resource: 'metal', amount: 500, price: 1 }],
    };
    expect(totalValue(after)).toBeGreaterThan(totalValue(before));
  });
});
