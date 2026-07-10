import type { GameModule } from '../kernel/module';
import type { GameState, Planet, UnitStack } from '../state/gameState';
import type { GameData, ResourceBag } from '../data/schemas';
import { buildingLevel } from '../data/schemas';
import { bombardedPlanets } from '../state/orbit';
import type { Context } from '../action/types';
import { hoursToMs, timeScaleOf } from '../action/types';
import { buildProgress, thresholdRamp } from '../util/construction';
import { MS_PER_HOUR, MS_PER_DAY } from '../util/time';

/** Narrow read of a `construction.complete` event's payload — economy never imports
 *  the construction module (modules never import each other), so it re-declares just
 *  the fields it needs off the shared, plain-data `scheduled` queue. */
interface ConstructionPayload {
  kind?: 'building' | 'unit' | 'upgrade';
  planetId?: string;
  building?: string;
  level?: number;
}

/** Output multiplier for a building whose upkeep resource is in arrears: the lights
 *  dim, they don't go out — half rate keeps a starved economy limping (and honest)
 *  instead of dead-spiralling to zero. */
export const BROWNOUT = 0.5;

/** Base hourly production of a planet = the sum of its buildings' `produces`, each at
 *  its current level. A building whose upkeep names a resource the OWNER failed to pay
 *  last settlement (`Player.arrears`) runs at `BROWNOUT` of its output. */
function baseProduction(planet: Planet, data: GameData, arrears?: readonly string[]): ResourceBag {
  const out: Record<string, number> = {};
  for (const building of planet.buildings) {
    const def = data.buildings[building.type];
    if (!def) {
      continue;
    }
    const level = buildingLevel(def, building.level);
    const starved =
      arrears !== undefined &&
      arrears.length > 0 &&
      Object.keys(level.upkeep).some((res) => (level.upkeep[res] ?? 0) > 0 && arrears.includes(res));
    const mult = starved ? BROWNOUT : 1;
    for (const res of Object.keys(level.produces)) {
      out[res] = (out[res] ?? 0) + (level.produces[res] ?? 0) * mult;
    }
  }
  return out;
}

/** Sum two resource bags (`a + b`). */
function mergeBags(a: ResourceBag, b: ResourceBag): ResourceBag {
  const out: Record<string, number> = { ...a };
  for (const [res, amt] of Object.entries(b)) out[res] = (out[res] ?? 0) + amt;
  return out;
}

/** Bonus production from constructions in progress on this planet, on top of
 *  `baseProduction`'s fully-built total:
 *   - a FRESH build (`kind: 'building'`, not yet in `planet.buildings` at all) ramps
 *     in at the 50%-progress threshold, 1:1 with progress up to its full level-1
 *     output at 100% (nothing before the threshold);
 *   - an UPGRADE (`kind: 'upgrade'`) keeps producing its CURRENT level's full output
 *     throughout — already counted in full by `baseProduction`, since the instance
 *     stays at its old level until the upgrade lands — and ramps in only the DELTA
 *     to the target level's output, same threshold rule.
 *  A PAUSED site has no `scheduled` entry any more (construction.ts's cancel removes
 *  it) — its frozen share is credited separately by `pausedProduction` below, since a
 *  paused site's progress no longer changes with `now` the way an active one's does.
 *
 *  Returned as a RATE (per `hoursOfSpan`), matching `baseProduction`'s shape, so it
 *  merges into the same `economy.production` hook + `rate × hours` settlement below —
 *  but a naive point-evaluation of the ramp at `ctx.now` would over/under-credit a span
 *  that jumps straight past the 50% mark in one `time.advanced` (a long-offline
 *  catch-up, or a backgrounded single-player tab at high speed: this game's real-time
 *  offline scheduler wakes only for DUE events, so a quiet build can go one whole
 *  `time.advanced` from 0% to 100% with nothing in between). Instead this integrates
 *  the ramp (linear ⇒ exact via the trapezoid rule) over exactly the overlap between
 *  [from, to] and the building's [50%-mark, completion] window, then re-expresses that
 *  exact amount as a rate over the FULL span so `rate × hours` reproduces it exactly. */
function pendingProduction(
  scheduled: GameState['scheduled'],
  planet: Planet,
  data: GameData,
  ctx: Context,
  from: number,
  to: number,
  hoursOfSpan: number,
): ResourceBag {
  const out: Record<string, number> = {};
  if (hoursOfSpan <= 0) {
    return out;
  }
  const scale = timeScaleOf(ctx);
  const addRamped = (full: ResourceBag, completesAt: number, totalDurationMs: number): void => {
    const rampStart = completesAt - totalDurationMs * 0.5; // the 50%-progress instant
    const overlapFrom = Math.max(from, rampStart);
    const overlapTo = Math.min(to, completesAt);
    if (overlapTo <= overlapFrom) {
      return; // this span never touches the ramp window
    }
    // Trapezoid rule: exact for a linear ramp — the average of the endpoint ramps
    // times the overlap's duration is the true integral, no matter how coarse the span.
    const avgRamp =
      (buildProgress(overlapFrom, completesAt, totalDurationMs) +
        buildProgress(overlapTo, completesAt, totalDurationMs)) /
      2;
    const overlapHours = ((overlapTo - overlapFrom) / MS_PER_HOUR) * scale;
    for (const res of Object.keys(full)) {
      const amount = (full[res] ?? 0) * avgRamp * overlapHours;
      if (amount !== 0) {
        out[res] = (out[res] ?? 0) + amount / hoursOfSpan;
      }
    }
  };
  for (const event of scheduled) {
    if (event.type !== 'construction.complete') {
      continue;
    }
    const p = event.payload as ConstructionPayload;
    if (p.planetId !== planet.id) {
      continue;
    }
    if (p.kind === 'building' && typeof p.building === 'string') {
      const def = data.buildings[p.building];
      if (!def) continue;
      const level1 = buildingLevel(def, 1);
      addRamped(level1.produces, event.at, hoursToMs(ctx, level1.buildTimeHours));
    } else if (p.kind === 'upgrade' && typeof p.building === 'string' && typeof p.level === 'number') {
      const def = data.buildings[p.building];
      const instance = planet.buildings.find((b) => b.type === p.building);
      if (!def || !instance) continue;
      const current = buildingLevel(def, instance.level);
      const target = buildingLevel(def, p.level);
      const delta: Record<string, number> = {};
      const resources = new Set([...Object.keys(current.produces), ...Object.keys(target.produces)]);
      for (const res of resources) {
        delta[res] = (target.produces[res] ?? 0) - (current.produces[res] ?? 0);
      }
      addRamped(delta, event.at, hoursToMs(ctx, target.buildTimeHours));
    }
  }
  return out;
}

/** Bonus production from PAUSED sites (construction.ts `construction.cancel` parks a
 *  cancelled order here instead of discarding it): pausing halts further
 *  CONSTRUCTION, not the share of the building already standing — it keeps
 *  contributing whatever it had reached, same 50%-threshold rule as an active build,
 *  but FROZEN at `site.progress` rather than advancing (nothing is scheduled to tick
 *  it forward while paused). Unlike `pendingProduction`'s ramp, a paused site's rate
 *  never changes across a span, so this is already an exact constant rate — no
 *  span-integration needed. */
function pausedProduction(planet: Planet, data: GameData): ResourceBag {
  const out: Record<string, number> = {};
  for (const site of planet.pausedConstruction ?? []) {
    const ramp = thresholdRamp(site.progress);
    if (ramp <= 0) continue;
    if (site.kind === 'building' && typeof site.building === 'string') {
      const def = data.buildings[site.building];
      if (!def) continue;
      const level1 = buildingLevel(def, 1);
      for (const res of Object.keys(level1.produces)) {
        out[res] = (out[res] ?? 0) + (level1.produces[res] ?? 0) * ramp;
      }
    } else if (site.kind === 'upgrade' && typeof site.building === 'string' && typeof site.level === 'number') {
      const def = data.buildings[site.building];
      const instance = planet.buildings.find((b) => b.type === site.building);
      if (!def || !instance) continue;
      const current = buildingLevel(def, instance.level);
      const target = buildingLevel(def, site.level);
      const resources = new Set([...Object.keys(current.produces), ...Object.keys(target.produces)]);
      for (const res of resources) {
        const delta = (target.produces[res] ?? 0) - (current.produces[res] ?? 0);
        if (delta !== 0) out[res] = (out[res] ?? 0) + delta * ramp;
      }
    }
  }
  return out;
}

/** Daily upkeep owed per owner for every unit in the world — ship stacks,
 *  landing troops and planet garrisons — aggregated in ONE pass over fleets and
 *  planets (O(world), not O(players × world)). An owner with no upkeep-bearing
 *  units has no entry. */
function upkeepByOwner(state: GameState, data: GameData): Map<string, ResourceBag> {
  const out = new Map<string, ResourceBag>();
  const addStacks = (owner: string, stacks: UnitStack[]) => {
    for (const stack of stacks) {
      const def = data.units[stack.unit];
      if (!def) {
        continue;
      }
      let bag = out.get(owner);
      if (!bag) {
        out.set(owner, (bag = {}));
      }
      for (const res of Object.keys(def.upkeep)) {
        bag[res] = (bag[res] ?? 0) + (def.upkeep[res] ?? 0) * stack.count;
      }
    }
  };
  for (const fleet of Object.values(state.fleets)) {
    addStacks(fleet.owner, fleet.units);
    if (fleet.landing) addStacks(fleet.owner, fleet.landing);
  }
  for (const planet of Object.values(state.planets)) {
    if (planet.owner === null) {
      continue;
    }
    addStacks(planet.owner, planet.garrison);
    // Standing buildings bill their owner daily too (destroyed ones are gone from
    // the array, so nothing dead is ever billed).
    for (const building of planet.buildings) {
      const def = data.buildings[building.type];
      if (!def) {
        continue;
      }
      const upkeep = buildingLevel(def, building.level).upkeep;
      let bag = out.get(planet.owner);
      for (const res of Object.keys(upkeep)) {
        const perDay = upkeep[res] ?? 0;
        if (perDay === 0) {
          continue;
        }
        if (!bag) {
          out.set(planet.owner, (bag = {}));
        }
        bag[res] = (bag[res] ?? 0) + perDay;
      }
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
        const rate = h.hook<ResourceBag>(
          'economy.production',
          // Arrears from the LAST settlement dim this span's output (state-carried,
          // so the formula stays continuous and deterministic across any span split).
          // Constructions in progress (>= 50%) chip in a partial/delta share on top,
          // and a PAUSED one keeps its frozen share (only further construction halts).
          mergeBags(
            mergeBags(
              baseProduction(planet, data, player.arrears),
              pendingProduction(h.state.scheduled, planet, data, h.ctx, from, to, hours),
            ),
            pausedProduction(planet, data),
          ),
          { planetId },
        );
        for (const res of Object.keys(rate)) {
          const perHour = rate[res] ?? 0;
          if (perHour !== 0) {
            player.resources[res] = (player.resources[res] ?? 0) + perHour * hours;
          }
        }
      }

      const upkeepPerOwner = upkeepByOwner(h.state, data);
      for (const playerId of Object.keys(h.state.players)) {
        const player = h.state.players[playerId];
        if (!player) {
          continue;
        }
        const upkeep = upkeepPerOwner.get(playerId);
        // Settle the bill and record what went UNPAID: a resource whose drain pinned
        // the treasury at zero with a remainder owed enters arrears — next span its
        // consumers run at BROWNOUT until the debt is coverable again.
        const short: string[] = [];
        for (const res of Object.keys(upkeep ?? {})) {
          const perDay = upkeep![res] ?? 0;
          if (perDay === 0) {
            continue;
          }
          const have = player.resources[res] ?? 0;
          const owed = perDay * days;
          player.resources[res] = Math.max(0, have - owed);
          if (have < owed) {
            short.push(res);
          }
        }
        if (short.length > 0) {
          player.arrears = short.sort();
        } else if (player.arrears !== undefined) {
          delete player.arrears; // bills paid in full — the brownout lifts
        }
      }
    });
  },
};
