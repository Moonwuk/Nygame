import { describe, it, expect } from 'vitest';
import type { Action } from '@void/shared-core';
// Runtime import must be a path (the prototype has no package.json for workspace
// resolution) — the same leaf-module pattern constructor.test.ts uses for @void/client.
import { isValidActionPayload } from '../../packages/shared-core/src/actions/payloadSchemas';
import {
  moveFleet,
  stopFleet,
  orbitFleet,
  bombardFleet,
  barrageFleet,
  barrageModeFleet,
  assaultFleet,
  retreatFleet,
  loadArmy,
  unloadArmy,
  launchFleet,
  mergeFleet,
  splitFleet,
  engageFleet,
  buildBuilding,
  upgradeBuilding,
  buildUnit,
  buildShip,
  researchTech,
  declareWar,
  spyOn,
  marketList,
  marketTake,
  marketCancel,
  mobilizeDivision,
  renameDivisionTemplate,
  setDivisionTemplate,
  loadDivision,
  unloadDivision,
  designateCapital,
  delegateSteward,
  recallSteward,
  orderAuto,
  orderScramble,
  patrolStamp,
  castHeroAbility,
  spawnHero,
  unlockHeroSkill,
  fitHero,
  freshSortie,
} from './game';

// RELEASE gate parity (REL-2): every intent the prototype UI can emit must clear the
// action-layer payload schemas — otherwise a GATED release server silently locks the
// player out of that mechanic (divisions, launches, steward…). The sample actions come
// from the REAL builders, so a builder/schema drift fails here, not in production.

const P = 'p1';
/** Every client-submittable intent the prototype UI can produce, via its real builders. */
const CLIENT_ACTIONS: Action[] = [
  moveFleet(P, 'f1', 'B2'),
  stopFleet(P, 'f1'),
  orbitFleet(P, 'f1'),
  bombardFleet(P, 'f1', true),
  barrageFleet(P, 'f1', 'f2'),
  barrageModeFleet(P, 'f1', 'aggressive'),
  assaultFleet(P, 'f1'),
  retreatFleet(P, 'f1'),
  loadArmy(P, 'f1', 'infantry', 2),
  unloadArmy(P, 'f1', 'infantry', 2),
  launchFleet(P, 'C1R1'),
  mergeFleet(P, 'f1', 'f2'),
  splitFleet(P, 'f1', [{ unit: 'fighter_squadron', count: 2 }]),
  engageFleet(P, 'f1', 'f2'),
  buildBuilding(P, 'C1R1', 'mine'),
  upgradeBuilding(P, 'C1R1', 'mine'),
  buildUnit(P, 'C1R1', 'cruiser', 1),
  buildShip(P, 'C1R1', 'cruiser', 1, ['targeting_array']),
  researchTech(P, 'propulsion_1'),
  declareWar(P, 'p2'),
  spyOn(P, 'p2', 'treasury'),
  marketList(P, 'sell', 'metal', 10, 5),
  marketTake(P, 'lot:1', 5),
  marketCancel(P, 'lot:1'),
  mobilizeDivision(P, 'C1R1', 0),
  mobilizeDivision(P, 'C1R1', 1, true), // officer premade (BF-20)
  renameDivisionTemplate(P, 0, 'Гвардия'), // designer rename (BF-20)
  setDivisionTemplate(P, 0, 2, 'tank'),
  setDivisionTemplate(P, 0, 2, null),
  loadDivision(P, 'div:1', 'f1'),
  unloadDivision(P, 'div:1'),
  designateCapital(P, 'C1R1'),
  delegateSteward(P, 123456789),
  recallSteward(P),
  orderAuto(P, 'f1', true),
  orderScramble(P, 'f1', false),
  castHeroAbility(P, 'hero:p1:1', 'scan', 'B2'),
  spawnHero(P, 'hero:p1:2', 'C1R1'),
  unlockHeroSkill(P, 'hero:p1:1', 'neural_lace'),
  fitHero(P, 'hero:p1:1', 'psi_lens'),
];

describe('gate parity (REL-2) — the schemas cover every prototype intent', () => {
  it('every UI-emitted action type+payload clears isValidActionPayload', () => {
    const rejected = CLIENT_ACTIONS.filter((a) => !isValidActionPayload(a.type, a.payload));
    expect(rejected.map((a) => a.type)).toEqual([]);
  });

  it('patrol.stamp stays server-only — the gate must refuse it from the wire', () => {
    const stamp = patrolStamp(P, 'f1', freshSortie(3), 42);
    expect(isValidActionPayload(stamp.type, stamp.payload)).toBe(false);
  });

  it('the removed order-chain types are not client-submittable', () => {
    for (const type of ['order.enqueue', 'order.clear', 'order.pop', 'order.remove', 'order.block', 'order.retry', 'order.hold']) {
      expect(isValidActionPayload(type, { fleetId: 'f1' })).toBe(false);
    }
  });

  it('the retired officer attach/detach action is not client-submittable (BF-19)', () => {
    expect(isValidActionPayload('division.officer', { divisionId: 'div:1', officer: 'assault' })).toBe(false);
    expect(isValidActionPayload('division.officer', { divisionId: 'div:1', officer: null })).toBe(false);
  });

  it('malformed payloads of the new types are refused (fail-secure spot checks)', () => {
    expect(isValidActionPayload('fleet.split', { fleetId: 'f1', take: [] })).toBe(false); // empty take
    expect(isValidActionPayload('division.rename', { template: 0, name: '' })).toBe(false); // empty name
    expect(isValidActionPayload('division.template', { template: 0, slot: -1, unit: null })).toBe(false);
    expect(isValidActionPayload('steward.delegate', { posture: 'defend' })).toBe(false); // no until
    expect(isValidActionPayload('order.auto', { fleetId: 'f1', on: 'yes' })).toBe(false);
    expect(isValidActionPayload('unit.build', { planetId: 'p', unit: 'cruiser', modules: 'targeting_array' })).toBe(false);
  });
});
