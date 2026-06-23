import type { GameModule } from '../kernel/module';
import type { GameState, Planet, UnitStack } from '../state/gameState';
import type { GameData, ResourceBag } from '../data/schemas';
import { buildingLevel } from '../data/schemas';
import { bombardedPlanets } from '../state/orbit';
import { timeScaleOf } from '../action/types';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Base hourly production of a planet = the sum of its buildings' `produces`,
 *  each at its current level. */
function baseProduction(planet: Planet, data: GameData): ResourceBag {
  const out: Record<string, number> = {};
  for (const building of planet.buildings) {
    const def = data.buildings[building.type];
    if (!def) {
      continue;
    }
    const produces = buildingLevel(def, building.level).produces;
    for (const res of Object.keys(produces)) {
      out[res] = (out[res] ?? 0) + (produces[res] ?? 0);
    }
  }
  return out;
}

/** Total daily upkeep a player owes for all of their units — ship stacks,
 *  landing troops and the garrisons of their planets. */
function totalUpkeep(state: GameState, playerId: string, data: GameData): ResourceBag {
  const out: Record<string, number> = {};
  const addStacks = (stacks: UnitStack[]) => {
    for (const stack of stacks) {
      const def = data.units[stack.unit];
      if (!def) {
        continue;
      }
      for (const res of Object.keys(def.upkeep)) {
        out[res] = (out[res] ?? 0) + (def.upkeep[res] ?? 0) * stack.count;
      }
    }
  };
  for (const fleet of Object.values(state.fleets)) {
    if (fleet.owner === playerId) {
      addStacks(fleet.units);
      if (fleet.landing) addStacks(fleet.landing);
    }
  }
  for (const planet of Object.values(state.planets)) {
    if (planet.owner === playerId) {
      addStacks(planet.garrison);
    }
  }
  return out;
}

/**
 * Economy — a base module (docs/modulesystem.md). On every `time.advanced` span
 * it settles the player economy by formula over elapsed real time
 * (docs/architecture.md §4.1):
 *
 *   - production: each owned planet feeds its owner's treasury
 *     (`Player.resources`), scaled by the `economy.production` hook;
 *   - upkeep: each player pays daily maintenance for their units, drained from
 *     the same treasury (clamped at zero — a deficit just leaves you at empty).
 *
 * Both scale with `timeScale`, like every other match timer (GDD §3.1).
 */
export const economyModule: GameModule = {
  id: 'economy',
  version: '1.0.0',
  setup(api) {
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) {
        return;
      }
      const scale = timeScaleOf(h.ctx);
      const hours = (span / MS_PER_HOUR) * scale;
      const days = (span / MS_PER_DAY) * scale;
      const data = h.ctx.data;
      const bombarded = bombardedPlanets(h.state); // O(fleets) once, then O(1) per planet

      for (const planetId of Object.keys(h.state.planets)) {
        const planet = h.state.planets[planetId];
        if (!planet || planet.owner === null) {
          continue; // neutral / unclaimed sectors do not produce
        }
        const player = h.state.players[planet.owner];
        if (!player) {
          continue; // owner without a player record → nothing to credit
        }
        if (bombarded.has(planetId)) {
          continue; // production frozen while the world is bombarded (GDD §7.4)
        }
        const rate = h.hook<ResourceBag>('economy.production', baseProduction(planet, data), {
          planetId,
        });
        for (const res of Object.keys(rate)) {
          const perHour = rate[res] ?? 0;
          if (perHour !== 0) {
            player.resources[res] = (player.resources[res] ?? 0) + perHour * hours;
          }
        }
      }

      for (const playerId of Object.keys(h.state.players)) {
        const player = h.state.players[playerId];
        if (!player) {
          continue;
        }
        const upkeep = totalUpkeep(h.state, playerId, data);
        for (const res of Object.keys(upkeep)) {
          const perDay = upkeep[res] ?? 0;
          if (perDay !== 0) {
            player.resources[res] = Math.max(0, (player.resources[res] ?? 0) - perDay * days);
          }
        }
      }
    });
  },
};
