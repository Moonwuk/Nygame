import { describe, it, expect } from 'vitest';
import type { GameState } from '@void/shared-core';
import { nearestPlanet, myFleetAt, moveAction } from './matchInput';
import { worldToScreen, type Bounds, type Viewport, type Cam } from './camera';

// A tiny state: two planets and one fleet parked at planet A.
const STATE = {
  time: 0,
  players: { green: {}, red: {} },
  planets: {
    a: { id: 'a', owner: 'green', position: { x: 0, y: 0 }, links: ['b'] },
    b: { id: 'b', owner: null, position: { x: 100, y: 0 }, links: ['a'] },
  },
  fleets: {
    g1: { id: 'g1', owner: 'green', location: 'a', units: [] },
  },
} as unknown as GameState;

const BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 0 };
const VP: Viewport = { left: 0, top: 0, right: 400, bottom: 300 };
const CAM: Cam = { scale: 1, x: 0, y: 0 };

describe('matchInput — nearestPlanet (tap hit-test)', () => {
  it('hits the planet under the tap and misses when nothing is close', () => {
    const aScreen = worldToScreen({ x: 0, y: 0 }, CAM, VP, BOUNDS);
    expect(nearestPlanet(STATE, aScreen.x, aScreen.y, CAM, VP, BOUNDS)).toBe('a');
    // far away from either node → no hit within maxPx
    expect(nearestPlanet(STATE, aScreen.x, aScreen.y + 200, CAM, VP, BOUNDS, 20)).toBeNull();
  });
});

describe('matchInput — myFleetAt', () => {
  it('finds my fleet at a planet, ignores others / other owners', () => {
    expect(myFleetAt(STATE, 'a', 'green')).toBe('g1');
    expect(myFleetAt(STATE, 'a', 'red')).toBeNull(); // not my fleet
    expect(myFleetAt(STATE, 'b', 'green')).toBeNull(); // no fleet here
  });
});

describe('matchInput — moveAction', () => {
  it('builds a fleet.move order with the ui:<player>:<seq> idempotency id', () => {
    const a = moveAction('green', 7, 'g1', 'b');
    expect(a).toEqual({
      id: 'ui:green:7',
      type: 'fleet.move',
      playerId: 'green',
      payload: { fleetId: 'g1', to: 'b' },
      issuedAt: 0,
    });
  });
});
