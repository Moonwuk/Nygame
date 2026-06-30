import type { GameModule, HandlerContext } from '../kernel/module';
import type { BuildingInstance, Planet, Player } from '../state/gameState';
import type { GameData, ResourceBag } from '../data/schemas';
import { buildingLevel, buildingMaxLevel } from '../data/schemas';
import { isBombarded } from '../state/orbit';
import { allowedBuildings } from '../state/sectorKind';
import type { Action } from '../action/types';
import { hoursToMs, timeScaleOf } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { canAfford, payCost } from '../util/treasury';
import { addUnits } from '../util/stacks';

/** Share of the ground assault's round damage that also wears down the planet's
 *  structures (the rest is spent on the defending garrison). Tunable. */
const STRUCTURE_DAMAGE_SHARE = 0.5;

interface ConstructBuildingPayload {
  planetId: string;
  building: string;
}
interface BuildUnitPayload {
  planetId: string;
  unit: string;
  count?: number;
}
/** Payload of the internal `construction.complete` schedule (we author it, so
 *  it is well-formed; the handler still guards types and is fail-secure). */
interface CompletePayload {
  kind?: 'building' | 'unit' | 'upgrade';
  planetId?: string;
  playerId?: string;
  building?: string;
  unit?: string;
  count?: number;
  level?: number;
}
interface ConstructionRequirement {
  allowed: boolean;
  code?: string;
}

/** `cost × count`, for multi-unit orders. */
function scaleCost(cost: ResourceBag, count: number): ResourceBag {
  const out: Record<string, number> = {};
  for (const res of Object.keys(cost)) {
    out[res] = (cost[res] ?? 0) * count;
  }
  return out;
}

/** Schedules a build to finish after `hours`, scaled by the match timeScale
 *  exactly like every other real-time duration (GDD §3.1). */
function scheduleCompletion(h: HandlerContext, hours: number, payload: CompletePayload): void {
  h.schedule(h.ctx.now + hoursToMs(h.ctx, hours), 'construction.complete', payload);
}

/** True if a `construction.complete` of this `kind` for this planet+building is already
 *  in flight — the "already queued?" guard shared verbatim by build and upgrade. */
function isQueued(
  h: HandlerContext,
  kind: CompletePayload['kind'],
  planetId: string,
  building: string,
): boolean {
  return h.state.scheduled.some((e) => {
    if (e.type !== 'construction.complete') return false;
    const p = e.payload as CompletePayload;
    return p.kind === kind && p.planetId === planetId && p.building === building;
  });
}

function requireUnlocked(
  h: HandlerContext,
  playerId: string,
  kind: 'unit' | 'building',
  id: string,
): void {
  const requirement = h.hook<ConstructionRequirement>(
    'construction.requirement',
    { allowed: true },
    { playerId, kind, id },
  );
  if (!requirement.allowed) {
    return h.reject(requirement.code ?? 'E_LOCKED');
  }
}

/** Resolves the acting player and a planet they own, or rejects with a stable
 *  code (E_NO_PLANET / E_FORBIDDEN). Shared by every build / upgrade order. */
function ownedPlanet(
  h: HandlerContext,
  action: Action,
  planetId: string,
): { planet: Planet; player: Player } {
  const planet = h.state.planets[planetId];
  if (!planet) {
    return h.reject('E_NO_PLANET');
  }
  if (planet.owner !== action.playerId) {
    return h.reject('E_FORBIDDEN');
  }
  const player = h.state.players[action.playerId];
  if (!player) {
    return h.reject('E_FORBIDDEN'); // no treasury / not a participant
  }
  return { planet, player };
}

// --- building combat helpers -------------------------------------------------

/** Total ground-defense bonus a planet's standing buildings grant its garrison. */
function totalDefenseBonus(planet: Planet, data: GameData): number {
  let bonus = 0;
  for (const b of planet.buildings) {
    const def = data.buildings[b.type];
    if (def) {
      bonus += buildingLevel(def, b.level).defenseBonus;
    }
  }
  return bonus;
}

/** Wears `amount` of structural damage across a planet's buildings (array order,
 *  carrying overflow). Buildings with no modelled HP are untouched; ones whose
 *  HP reaches zero are removed and announced via `building.destroyed`. `owner` is
 *  passed in (not read from the planet) because a capture may have already
 *  flipped `planet.owner` by the time the round's damage is applied. */
function damageBuildings(
  h: HandlerContext,
  planet: Planet,
  amount: number,
  owner: string | null,
): void {
  let remaining = amount;
  const survivors: BuildingInstance[] = [];
  for (const b of planet.buildings) {
    const def = h.ctx.data.buildings[b.type];
    const maxHp = def ? buildingLevel(def, b.level).hp : 0;
    if (maxHp <= 0) {
      survivors.push(b); // not modelled as destructible
      continue;
    }
    const absorbed = Math.min(remaining, b.hp);
    b.hp -= absorbed;
    remaining -= absorbed;
    if (b.hp > 0) {
      survivors.push(b);
    } else {
      h.emit('building.destroyed', { planetId: planet.id, building: b.type, owner });
    }
  }
  planet.buildings = survivors;
}

/**
 * Buildings — a base module (docs/modulesystem.md). It owns everything about
 * planet structures:
 *
 *   - orders: `building.construct` / `building.upgrade` / `unit.build`, each
 *     paid up-front from the ordering player's treasury (`Player.resources`) and
 *     finished after `buildTimeHours` (timeScale-scaled) via a scheduled
 *     `construction.complete`. Fail-secure: an unaffordable / unauthorized order
 *     is rejected and charges nothing (OWASP A10). Delivery is gated on still
 *     owning the planet — lose it mid-build and the investment is forfeited.
 *   - defense: each standing building toughens the garrison through the
 *     `combat.damage` hook (the `defenseBonus`, +1% by default, more for a
 *     fortress, growing with level — GDD §7).
 *   - destruction: the ground assault wears down building HP each round; a
 *     destroyed building stops granting its bonus (GDD §7.4). (A distinct
 *     orbital-bombardment pass, with its own magnitude, is a future refinement.)
 */
export const constructionModule: GameModule = {
  id: 'construction',
  version: '1.0.0',
  setup(api) {
    api.onAction('building.construct', (action, h) => {
      const payload = action.payload as Partial<ConstructBuildingPayload>;
      if (typeof payload?.planetId !== 'string' || typeof payload?.building !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const { planet, player } = ownedPlanet(h, action, payload.planetId);
      if (isBombarded(h.state, planet.id)) {
        return h.reject('E_BOMBARDED'); // production frozen under bombardment
      }
      const def = h.ctx.data.buildings[payload.building];
      if (!def) {
        return h.reject('E_UNKNOWN_BUILDING');
      }
      // Province-type roster: each province type lists the buildings it may host
      // (`allowedBuildings`). undefined roster (kind-less / unknown / roster-less) = any
      // building — kind-less scenario worlds keep building exactly as before. An explicit
      // `[]` means "no construction here" (empty / debris).
      const roster = allowedBuildings(h.ctx.data, planet);
      if (roster !== undefined && !roster.includes(payload.building)) {
        return h.reject('E_WRONG_SECTOR'); // this structure does not fit this province type
      }
      requireUnlocked(h, action.playerId, 'building', payload.building);
      if (planet.buildings.some((b) => b.type === payload.building)) {
        return h.reject('E_ALREADY_BUILT'); // one of each type; grow it with building.upgrade
      }
      if (isQueued(h, 'building', planet.id, payload.building)) {
        return h.reject('E_ALREADY_QUEUED');
      }
      const level1 = buildingLevel(def, 1);
      if (!canAfford(player.resources, level1.cost)) {
        return h.reject('E_INSUFFICIENT');
      }
      payCost(player.resources, level1.cost);
      scheduleCompletion(h, level1.buildTimeHours, {
        kind: 'building',
        planetId: planet.id,
        playerId: action.playerId,
        building: payload.building,
      });
      h.emit('construction.started', {
        kind: 'building',
        planetId: planet.id,
        building: payload.building,
        playerId: action.playerId,
      });
    });

    api.onAction('building.upgrade', (action, h) => {
      const payload = action.payload as Partial<ConstructBuildingPayload>;
      if (typeof payload?.planetId !== 'string' || typeof payload?.building !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const { planet, player } = ownedPlanet(h, action, payload.planetId);
      if (isBombarded(h.state, planet.id)) {
        return h.reject('E_BOMBARDED');
      }
      const instance = planet.buildings.find((b) => b.type === payload.building);
      if (!instance) {
        return h.reject('E_NO_BUILDING'); // nothing of that type to upgrade
      }
      const def = h.ctx.data.buildings[instance.type];
      if (!def) {
        return h.reject('E_UNKNOWN_BUILDING');
      }
      const nextLevel = instance.level + 1;
      if (nextLevel > buildingMaxLevel(def)) {
        return h.reject('E_MAX_LEVEL');
      }
      if (isQueued(h, 'upgrade', planet.id, instance.type)) {
        return h.reject('E_ALREADY_QUEUED');
      }
      const next = buildingLevel(def, nextLevel);
      if (!canAfford(player.resources, next.cost)) {
        return h.reject('E_INSUFFICIENT');
      }
      payCost(player.resources, next.cost);
      scheduleCompletion(h, next.buildTimeHours, {
        kind: 'upgrade',
        planetId: planet.id,
        playerId: action.playerId,
        building: instance.type,
        level: nextLevel,
      });
      h.emit('construction.started', {
        kind: 'upgrade',
        planetId: planet.id,
        building: instance.type,
        level: nextLevel,
        playerId: action.playerId,
      });
    });

    api.onAction('unit.build', (action, h) => {
      const payload = action.payload as Partial<BuildUnitPayload>;
      if (typeof payload?.planetId !== 'string' || typeof payload?.unit !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const count = payload.count ?? 1;
      if (!Number.isSafeInteger(count) || count <= 0) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const { planet, player } = ownedPlanet(h, action, payload.planetId);
      if (isBombarded(h.state, planet.id)) {
        return h.reject('E_BOMBARDED');
      }
      const def = h.ctx.data.units[payload.unit];
      if (!def) {
        return h.reject('E_UNKNOWN_UNIT');
      }
      requireUnlocked(h, action.playerId, 'unit', payload.unit);
      const cost = scaleCost(def.cost, count);
      if (!canAfford(player.resources, cost)) {
        return h.reject('E_INSUFFICIENT');
      }
      payCost(player.resources, cost);
      scheduleCompletion(h, def.buildTimeHours, {
        kind: 'unit',
        planetId: planet.id,
        playerId: action.playerId,
        unit: payload.unit,
        count,
      });
      h.emit('construction.started', {
        kind: 'unit',
        planetId: planet.id,
        unit: payload.unit,
        count,
        playerId: action.playerId,
      });
    });

    api.on('construction.complete', (event, h) => {
      const p = event.payload as CompletePayload;
      if (typeof p?.planetId !== 'string' || typeof p?.playerId !== 'string') {
        return; // malformed → no-op (fail-secure)
      }
      const planet = h.state.planets[p.planetId];
      if (!planet || planet.owner !== p.playerId) {
        return; // planet gone or captured mid-build → investment forfeited
      }
      if (isBombarded(h.state, planet.id)) {
        // production frozen under bombardment → re-defer until it lifts (scale the
        // retry by timeScale like every other duration, so a fast match isn't stuck)
        h.schedule(h.ctx.now + hoursToMs(h.ctx, 1), 'construction.complete', p);
        return;
      }
      if (p.kind === 'building' && typeof p.building === 'string') {
        if (planet.buildings.some((b) => b.type === p.building)) {
          return; // already present (e.g. a duplicate queued order) → no-op
        }
        const def = h.ctx.data.buildings[p.building];
        const hp = def ? buildingLevel(def, 1).hp : 0;
        planet.buildings.push({ type: p.building, level: 1, hp });
        h.emit('building.constructed', {
          planetId: planet.id,
          building: p.building,
          owner: p.playerId,
        });
      } else if (
        p.kind === 'upgrade' &&
        typeof p.building === 'string' &&
        typeof p.level === 'number'
      ) {
        const instance = planet.buildings.find((b) => b.type === p.building);
        const def = h.ctx.data.buildings[p.building];
        if (!instance || !def || instance.level !== p.level - 1) {
          return; // building gone or already changed → drop
        }
        instance.level = p.level;
        instance.hp = buildingLevel(def, p.level).hp;
        h.emit('building.upgraded', {
          planetId: planet.id,
          building: p.building,
          level: p.level,
          owner: p.playerId,
        });
      } else if (p.kind === 'unit' && typeof p.unit === 'string' && typeof p.count === 'number') {
        addUnits(planet.garrison, p.unit, p.count);
        h.emit('unit.built', {
          planetId: planet.id,
          unit: p.unit,
          count: p.count,
          owner: p.playerId,
        });
      }
    });

    // Standing buildings toughen the garrison: reduce the damage it takes in the
    // ground phase by the planet's total defense bonus (the side being damaged
    // owns the planet ⇒ it is the garrison).
    api.hook<number>('combat.damage', (dmg, args, h) => {
      const a = args as { phase?: string; location?: string; defender?: string };
      if (a.phase !== 'ground' || !a.location) {
        return dmg;
      }
      const planet = h.state.planets[a.location];
      if (!planet || planet.owner !== a.defender) {
        return dmg;
      }
      const bonus = totalDefenseBonus(planet, h.ctx.data);
      return bonus > 0 ? dmg / (1 + bonus) : dmg;
    });

    // The ground assault wears down the contested planet's structures each round
    // (GDD §7.4). The event carries the location and the defending owner, so this
    // still fires correctly on the round that ENDS the battle — by which point
    // combat has already removed the battle and may have flipped `planet.owner`.
    api.on('combat.round', (event, h) => {
      const p = event.payload as {
        phase?: string;
        location?: string;
        defender?: string;
        dmgToDefender?: number;
      };
      if (p.phase !== 'ground' || typeof p.location !== 'string') {
        return; // only the ground assault wears structures (orbital is fleet-vs-fleet)
      }
      if (typeof p.dmgToDefender !== 'number' || p.dmgToDefender <= 0) {
        return;
      }
      const planet = h.state.planets[p.location];
      if (!planet) {
        return;
      }
      damageBuildings(
        h,
        planet,
        p.dmgToDefender * STRUCTURE_DAMAGE_SHARE,
        p.defender ?? planet.owner,
      );
    });

    // Orbital bombardment wears structures the same way (combat measures the
    // firepower; the buildings module applies it — GDD §7.4).
    api.on('planet.bombarded', (event, h) => {
      const p = event.payload as { planetId?: string; power?: number; owner?: string | null };
      if (typeof p.planetId !== 'string' || typeof p.power !== 'number' || p.power <= 0) {
        return;
      }
      const planet = h.state.planets[p.planetId];
      if (!planet) {
        return;
      }
      damageBuildings(h, planet, p.power, p.owner ?? planet.owner);
    });

    // Hospital healing: regenerate garrison HP each tick proportional to the
    // planet's total `healRate` from standing buildings.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) return;
      const scale = timeScaleOf(h.ctx);
      const hours = (span / MS_PER_HOUR) * scale;
      const data = h.ctx.data;

      for (const planet of Object.values(h.state.planets)) {
        if (!planet || planet.owner === null || planet.garrison.length === 0) continue;
        let totalHealRate = 0;
        for (const b of planet.buildings) {
          if (b.hp <= 0) continue; // destroyed building contributes nothing
          const def = data.buildings[b.type];
          if (def) totalHealRate += buildingLevel(def, b.level).healRate;
        }
        if (totalHealRate <= 0) continue;
        for (const stack of planet.garrison) {
          const unitDef = data.units[stack.unit];
          if (!unitDef) continue;
          const fullHp = stack.count * unitDef.stats.hp;
          const currentHp = stack.hp ?? fullHp;
          if (currentHp >= fullHp) continue;
          const healed = totalHealRate * hours * fullHp;
          const newHp = Math.min(fullHp, currentHp + healed);
          stack.hp = newHp >= fullHp ? undefined : newHp;
        }
      }

      // Ship hull repair + shield recharge (ships keep hull damage out of combat now).
      // "Shields" = the hull band ABOVE 30%: it recharges between fights (any fleet
      // not currently in a battle), anywhere. "Hull" = the band AT/BELOW 30%: a breach
      // that only mends while the fleet is stationed over a FRIENDLY world with a
      // repair building (healRate, e.g. a hospital), and which also drags the fleet's
      // speed (route.ts fleetBaseSpeed) until it is repaired.
      const HULL_LINE = 0.3;
      const SHIELD_REGEN = 0.06; // shield-band fraction restored per game-hour
      const BASE_HULL_REPAIR = 0.04; // hull fraction/hour docked at any friendly world
      for (const fleet of Object.values(h.state.fleets)) {
        if (!fleet || fleet.battleId) continue; // a fleet in combat doesn't regen
        let baseRate = 0;
        const planet = fleet.location ? h.state.planets[fleet.location] : undefined;
        if (planet && !fleet.movement && planet.owner === fleet.owner) {
          // any friendly world docks for basic hull repairs; a hospital / repair
          // yard (healRate) speeds it up — mirrors the friendly-soil division regen.
          baseRate = BASE_HULL_REPAIR;
          for (const b of planet.buildings) {
            if (b.hp <= 0) continue;
            const def = data.buildings[b.type];
            if (def) baseRate += buildingLevel(def, b.level).healRate;
          }
        }
        for (const stack of fleet.units) {
          if (stack.hp === undefined) continue; // full hull
          const unitDef = data.units[stack.unit];
          if (!unitDef) continue;
          const fullHp = stack.count * unitDef.stats.hp;
          if (fullHp <= 0 || stack.hp >= fullHp) {
            stack.hp = undefined;
            continue;
          }
          let cur = stack.hp;
          if (cur > HULL_LINE * fullHp) cur = Math.min(fullHp, cur + SHIELD_REGEN * hours * fullHp); // shields
          if (baseRate > 0) cur = Math.min(fullHp, cur + baseRate * hours * fullHp); // hull, at a base
          stack.hp = cur >= fullHp ? undefined : cur;
        }
      }
    });
  },
};
