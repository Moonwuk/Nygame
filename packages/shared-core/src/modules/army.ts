import type { GameModule, HandlerContext } from '../kernel/module';
import type { Fleet } from '../state/gameState';
import type { GameData } from '../data/schemas';
import { findHealthyStack, addUnits, sumUnitStat } from '../util/stacks';
import { requireOwnedIdleFleet } from '../util/fleet';

interface TransferPayload {
  fleetId: string;
  unit: string;
  count?: number;
}

/** Total ground-army a fleet's ships can carry (Σ count × cargoCapacity). */
function fleetCapacity(fleet: Fleet, data: GameData): number {
  return sumUnitStat(fleet.units, data, 'cargoCapacity');
}

/** Transport space currently occupied by the fleet's carried ground army. */
function cargoUsed(fleet: Fleet, data: GameData): number {
  return sumUnitStat(fleet.landing ?? [], data, 'cargoSize');
}

/**
 * Army — a base module (docs/modulesystem.md). Fleets (ships) and the planetary
 * ground army (tanks / drop-infantry / militia) are separate: ground units sit
 * in a planet's garrison and only travel as a fleet's cargo. This module moves
 * ground units between a planet's garrison and a fleet docked there, bounded by
 * the fleet's transport `cargoCapacity` — so a fleet must include enough hull
 * (or a dropship) to carry an invasion force. The carried army is the landing
 * force a ground assault uses (GDD §7.4).
 *
 * Fail-secure: every check rejects with a stable code and moves nothing.
 */
export const armyModule: GameModule = {
  id: 'army',
  version: '1.0.0',
  setup(api) {
    /** Validates a load/unload order and resolves the fleet, its planet and the
     *  ground unit def, or rejects. */
    const resolve = (action: { playerId: string; payload: unknown }, h: HandlerContext) => {
      const p = action.payload as Partial<TransferPayload>;
      if (typeof p?.fleetId !== 'string' || typeof p?.unit !== 'string') {
        h.reject('E_BAD_PAYLOAD');
      }
      const count = p.count ?? 1;
      if (!Number.isSafeInteger(count) || count <= 0) {
        h.reject('E_BAD_PAYLOAD');
      }
      const fleet = requireOwnedIdleFleet(h, p.fleetId as string, action.playerId);
      const planet = h.state.planets[fleet.location];
      if (!planet) {
        h.reject('E_NO_PLANET');
      }
      if (planet.owner !== action.playerId) {
        h.reject('E_FORBIDDEN'); // load from / unload onto your own world
      }
      const def = h.ctx.data.units[p.unit as string];
      if (!def) {
        h.reject('E_UNKNOWN_UNIT');
      }
      if (def.domain !== 'ground') {
        h.reject('E_NOT_GROUND'); // only the ground army is transported as cargo
      }
      return { fleet, planet, def, unit: p.unit as string, count };
    };

    api.onAction('army.load', (action, h) => {
      const { fleet, planet, def, unit, count } = resolve(action, h);
      const avail = findHealthyStack(planet.garrison, unit);
      if (!avail || avail.count < count) {
        return h.reject('E_NO_ARMY'); // not that many in the garrison
      }
      const free = fleetCapacity(fleet, h.ctx.data) - cargoUsed(fleet, h.ctx.data);
      if (count * def.stats.cargoSize > free) {
        return h.reject('E_NO_CAPACITY'); // not enough transport space aboard
      }
      avail.count -= count;
      planet.garrison = planet.garrison.filter((s) => s.count > 0);
      fleet.landing = fleet.landing ?? [];
      addUnits(fleet.landing, unit, count);
      h.emit('army.loaded', {
        fleetId: fleet.id,
        planetId: planet.id,
        unit,
        count,
        owner: action.playerId,
      });
    });

    api.onAction('army.unload', (action, h) => {
      const { fleet, planet, unit, count } = resolve(action, h);
      const carried = findHealthyStack(fleet.landing ?? [], unit);
      if (!carried || carried.count < count) {
        return h.reject('E_NO_ARMY'); // not that many aboard
      }
      carried.count -= count;
      fleet.landing = (fleet.landing ?? []).filter((s) => s.count > 0);
      addUnits(planet.garrison, unit, count);
      h.emit('army.unloaded', {
        fleetId: fleet.id,
        planetId: planet.id,
        unit,
        count,
        owner: action.playerId,
      });
    });
  },
};
