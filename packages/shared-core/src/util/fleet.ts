import type { Fleet, GameState, PlanetId } from '../state/gameState';
import type { HandlerContext } from '../kernel/module';

/** A fleet that has been validated as stationed at a planet and idle (not
 *  moving, not in battle). The `location` is guaranteed non-null. */
export interface IdleFleet extends Fleet {
  location: PlanetId;
}

/** Resolves a fleet the player owns and that is idle (docked, not moving, not
 *  in battle), or rejects with `E_NO_FLEET` / `E_FLEET_BUSY`. A fleet that is absent
 *  OR owned by someone else answers with the SAME `E_NO_FLEET` — otherwise a client
 *  could enumerate ids and read the difference to confirm fog-hidden enemy fleets
 *  exist (A06 — reject-code side-channel). `E_FLEET_BUSY` is only reachable for the
 *  caller's own fleet, so it leaks nothing. */
export function requireOwnedIdleFleet(
  h: HandlerContext,
  fleetId: string,
  playerId: string,
): IdleFleet {
  const fleet = h.state.fleets[fleetId];
  if (!fleet || fleet.owner !== playerId) {
    h.reject('E_NO_FLEET');
  }
  if (fleet.location === null || fleet.movement || fleet.battleId) {
    h.reject('E_FLEET_BUSY');
  }
  return fleet as IdleFleet;
}

/** Whether a LIVE battle references this world's garrison as a side. While the
 *  assault runs the garrison is locked in: it can neither evacuate onto ships
 *  (`army.load`, the prototype's `fleet.launch`) nor otherwise dodge the resolve —
 *  else the defender escapes unbloodied and the attacker wins an empty rock. */
export function garrisonUnderAssault(state: GameState, planetId: PlanetId): boolean {
  return Object.values(state.battles).some((b) =>
    [b.attacker, b.defender].some(
      (side) => side.ref.kind === 'garrison' && side.ref.planetId === planetId,
    ),
  );
}
