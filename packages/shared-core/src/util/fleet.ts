import type { Fleet, PlanetId } from '../state/gameState';
import type { HandlerContext } from '../kernel/module';

/** A fleet that has been validated as stationed at a planet and idle (not
 *  moving, not in battle). The `location` is guaranteed non-null. */
export interface IdleFleet extends Fleet {
  location: PlanetId;
}

/** Resolves a fleet the player owns and that is idle (docked, not moving, not
 *  in battle), or rejects with `E_NO_FLEET` / `E_FORBIDDEN` / `E_FLEET_BUSY`. */
export function requireOwnedIdleFleet(
  h: HandlerContext,
  fleetId: string,
  playerId: string,
): IdleFleet {
  const fleet = h.state.fleets[fleetId];
  if (!fleet) {
    h.reject('E_NO_FLEET');
  }
  if (fleet.owner !== playerId) {
    h.reject('E_FORBIDDEN');
  }
  if (fleet.location === null || fleet.movement || fleet.battleId) {
    h.reject('E_FLEET_BUSY');
  }
  return fleet as IdleFleet;
}
