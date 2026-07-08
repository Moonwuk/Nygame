import { describe, expect, it } from 'vitest';
import { actionPayloadSchemas, isValidActionPayload } from './payloadSchemas';

// SV-1.2 — the per-action-type payload schemas the gate enforces before the reducer.

const CLIENT_ACTION_TYPES = [
  'fleet.move',
  'fleet.stop',
  'fleet.orbit',
  'fleet.assault',
  'fleet.bombard',
  'fleet.barrage',
  'fleet.barrageMode',
  'fleet.retreat',
  'army.load',
  'army.unload',
  'hero.move',
  'hero.path.create',
  'hero.ability',
  'hero.spawn',
  'hero.skill.unlock',
  'planet.annihilate',
  'station.deploy',
  'building.construct',
  'building.upgrade',
  'unit.build',
  'technology.research',
  'diplomacy.declare',
  'espionage.spy',
  'market.list',
  'market.buy',
  'market.cancel',
];

describe('SV-1.2 · action payload schemas', () => {
  it('covers exactly the client-submittable action set', () => {
    expect(Object.keys(actionPayloadSchemas).sort()).toEqual([...CLIENT_ACTION_TYPES].sort());
  });

  it('accepts a valid payload for every client action type', () => {
    const valid: Array<[string, unknown]> = [
      ['fleet.move', { fleetId: 'f1', to: 'p1' }],
      ['fleet.move', { fleetId: 'f1', toEdge: { from: 'a', to: 'b', t: 0.5 } }],
      ['fleet.stop', { fleetId: 'f1' }],
      ['fleet.orbit', { fleetId: 'f1', orbit: 'near' }],
      ['fleet.assault', { fleetId: 'f1' }],
      ['fleet.bombard', { fleetId: 'f1', on: true }],
      ['fleet.barrage', { fleetId: 'f1', targetId: 'f2' }],
      ['fleet.barrage', { fleetId: 'f1', targetId: null }], // clear → auto-target
      ['fleet.barrage', { fleetId: 'f1' }], // absent target also clears
      ['fleet.barrageMode', { fleetId: 'f1', mode: 'aggressive' }],
      ['fleet.retreat', { fleetId: 'f1' }],
      ['market.list', { resource: 'metal', amount: 12.5, price: 3 }], // fractional amount is legal
      ['market.buy', { orderId: 'market:1', amount: 5 }],
      ['market.cancel', { orderId: 'market:1' }],
      ['army.load', { fleetId: 'f1', unit: 'marine' }],
      ['army.unload', { fleetId: 'f1', unit: 'marine', count: 3 }],
      ['hero.move', { to: 'p1' }],
      ['hero.path.create', { to: 'p1' }],
      ['hero.ability', { heroId: 'hero:p1', abilityId: 'corridor', target: 'p2' }],
      ['hero.ability', { heroId: 'hero:p1', abilityId: 'recall' }], // untargeted cast
      ['hero.spawn', { heroId: 'hero:p1', at: 'home_a' }],
      ['hero.skill.unlock', { heroId: 'hero:p1', node: 'neural_lace' }],
      ['planet.annihilate', { planetId: 'p1' }],
      ['station.deploy', { planetId: 'p1' }],
      ['building.construct', { planetId: 'p1', building: 'radar' }],
      ['building.upgrade', { planetId: 'p1', building: 'radar' }],
      ['unit.build', { planetId: 'p1', unit: 'cruiser', count: 2 }],
      ['unit.build', { planetId: 'p1', unit: 'cruiser' }], // count optional (defaults to 1)
      ['technology.research', { technology: 'railgun' }],
      ['diplomacy.declare', { target: 'p2', stance: 'war' }],
      ['diplomacy.declare', { target: 'p2', stance: 'alliance' }], // friendly declare = an offer
      ['espionage.spy', { target: 'p2', kind: 'treasury' }],
      ['espionage.spy', { target: 'p2', kind: 'planet', planetId: 'home_b' }],
    ];
    for (const [type, payload] of valid) {
      expect(isValidActionPayload(type, payload), `${type}: ${JSON.stringify(payload)}`).toBe(true);
    }
  });

  it('rejects malformed payloads', () => {
    const bad: Array<[string, unknown]> = [
      ['fleet.move', { fleetId: 'f1' }], // neither to nor toEdge
      ['fleet.move', { fleetId: 123, to: 'p1' }], // fleetId not a string
      ['fleet.move', { fleetId: 'f1', toEdge: { from: 'a', to: 'b' } }], // toEdge missing t
      ['fleet.orbit', { fleetId: 'f1', orbit: 'sideways' }], // not the single 'near' orbit
      ['fleet.orbit', { fleetId: 'f1', orbit: 'far' }], // the old far/near switch is gone
      ['fleet.orbit', { fleetId: 'f1' }], // missing orbit
      ['fleet.bombard', { fleetId: 'f1', on: 'yes' }], // on not a boolean
      ['fleet.barrage', { fleetId: 'f1', targetId: 7 }], // target neither an id nor null
      ['fleet.barrageMode', { fleetId: 'f1', mode: 'berserk' }], // not a known ROE mode
      ['fleet.retreat', {}], // missing fleetId
      ['market.list', { resource: 'metal', amount: 0, price: 3 }], // nothing to sell
      ['market.list', { resource: 'metal', amount: 5, price: -1 }], // negative price
      ['market.list', { resource: 'metal', amount: Infinity, price: 3 }], // not finite
      ['market.buy', { orderId: 'market:1', amount: -2 }], // negative amount
      ['market.buy', { orderId: 'market:1' }], // missing amount
      ['unit.build', { planetId: 'p1', unit: 'c', count: 0 }], // count not positive
      ['unit.build', { planetId: 'p1', unit: 'c', count: 1.5 }], // count not an integer
      ['army.load', { fleetId: 'f1' }], // missing unit
      ['technology.research', {}], // missing technology
      ['station.deploy', { planetId: '' }], // empty id
      ['hero.move', { to: null }], // wrong type
      ['hero.ability', { heroId: 'hero:p1' }], // missing abilityId
      ['hero.ability', { heroId: 'hero:p1', abilityId: 'corridor', target: 7 }], // target not an id
      ['hero.spawn', { heroId: 'hero:p1' }], // missing spawn world
      ['hero.skill.unlock', { node: 'neural_lace' }], // missing heroId
      ['diplomacy.declare', { target: 'p2', stance: 'frenemy' }], // not a known stance
      ['diplomacy.declare', { target: 'p2' }], // missing stance
      ['diplomacy.declare', { stance: 'war' }], // missing target
      ['espionage.spy', { target: 'p2', kind: 'planet' }], // planet theft needs a planetId
      ['espionage.spy', { target: 'p2', kind: 'pings' }], // not a stealable kind (yet)
    ];
    for (const [type, payload] of bad) {
      expect(isValidActionPayload(type, payload), `${type}: ${JSON.stringify(payload)}`).toBe(false);
    }
  });

  it('rejects internal and unknown action types (not client-submittable)', () => {
    expect(isValidActionPayload('arrive', { fleetId: 'f1', at: 'p1' })).toBe(false);
    expect(isValidActionPayload('fleet.arrival', { fleetId: 'f1' })).toBe(false);
    expect(isValidActionPayload('nonsense.type', {})).toBe(false);
  });
});
