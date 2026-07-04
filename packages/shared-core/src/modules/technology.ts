import type { Action } from '../action/types';
import { hoursToMs } from '../action/types';
import { MS_PER_DAY } from '../util/time';
import type { GameData, ResourceBag, TechnologyCondition, TechnologyDef } from '../data/schemas';
import type { GameModule, HandlerContext } from '../kernel/module';
import type {
  ActiveResearch,
  GameState,
  Planet,
  Player,
  PlayerTechnologyState,
  UnitStack,
} from '../state/gameState';
import { scientistsOf } from '../state/gameState';
import { canAfford, payCost } from '../util/treasury';

interface ResearchPayload {
  technology: string;
}

interface CompletePayload {
  playerId?: string;
  technology?: string;
  completesAt?: number;
}

interface ConstructionRequirement {
  allowed: boolean;
  code?: string;
}

interface ConstructionRequirementArgs {
  playerId?: string;
  kind?: 'unit' | 'building';
  id?: string;
}

interface ProductionArgs {
  planetId?: string;
}

interface SpeedArgs {
  fleetId?: string;
}

interface DamageArgs {
  attacker?: string | null;
}

/** Concurrent research slots: 2 by the base rule, raised via the `research.slots`
 *  hook (e.g. a "+1 slot" scientist) up to a design maximum of 3. */
const BASE_RESEARCH_SLOTS = 2;
const MAX_RESEARCH_SLOTS = 3;

function technologyState(player: Player): PlayerTechnologyState {
  const tech = player.technologies ?? (player.technologies = { completed: [] });
  // Migrate a pre-multi-slot single-object `active` (from a match persisted before
  // slots existed) into the list, so the concurrent-research code never meets a
  // non-array and throws E_INTERNAL.
  const active = tech.active as ActiveResearch[] | ActiveResearch | undefined;
  if (active !== undefined && !Array.isArray(active)) {
    tech.active = [active];
  }
  return tech;
}

function hasCompleted(player: Player | undefined, technology: string): boolean {
  return player?.technologies?.completed.includes(technology) ?? false;
}

function completedTechs(player: Player | undefined, data: GameData): TechnologyDef[] {
  if (!player) {
    return [];
  }
  const out: TechnologyDef[] = [];
  for (const id of player.technologies?.completed ?? []) {
    const def = data.technologies[id];
    if (def) {
      out.push(def);
    }
  }
  return out;
}

function effectsSum(
  player: Player | undefined,
  data: GameData,
  key: 'productionBonus' | 'fleetSpeedBonus' | 'combatDamageBonus',
): number {
  let bonus = 0;
  for (const tech of completedTechs(player, data)) {
    bonus += tech.effects[key] ?? 0;
  }
  return bonus;
}

function technologiesUnlocking(data: GameData, kind: 'unit' | 'building', id: string): string[] {
  const out: string[] = [];
  for (const technology of Object.keys(data.technologies).sort()) {
    const def = data.technologies[technology];
    if (!def) {
      continue;
    }
    const unlocked = kind === 'unit' ? (def.unlocks.units ?? []) : (def.unlocks.buildings ?? []);
    if (unlocked.includes(id)) {
      out.push(technology);
    }
  }
  return out;
}

function scheduleCompletion(
  h: HandlerContext,
  technology: string,
  playerId: string,
  hours: number,
): number {
  const completesAt = h.ctx.now + hoursToMs(h.ctx, hours);
  h.schedule(completesAt, 'technology.complete', { playerId, technology, completesAt });
  return completesAt;
}

/** Planets a player currently owns. */
function ownedPlanets(state: GameState, playerId: string): Planet[] {
  return Object.values(state.planets).filter((p) => p.owner === playerId);
}

/** Built copies of `building` across the player's worlds. */
function countBuilding(state: GameState, playerId: string, building: string): number {
  return ownedPlanets(state, playerId).reduce(
    (n, p) => n + p.buildings.filter((b) => b.type === building).length,
    0,
  );
}

/** Worlds of `planetType` the player owns. */
function countPlanetType(state: GameState, playerId: string, planetType: string): number {
  return ownedPlanets(state, playerId).filter((p) => p.planetType === planetType).length;
}

/** Copies of `unit` the player fields across fleets, their cargo, and garrisons. */
function countUnit(state: GameState, playerId: string, unit: string): number {
  const inStacks = (stacks: UnitStack[] | undefined): number =>
    (stacks ?? []).reduce((n, s) => n + (s.unit === unit ? s.count : 0), 0);
  let total = 0;
  for (const f of Object.values(state.fleets)) {
    if (f.owner === playerId) total += inStacks(f.units) + inStacks(f.landing);
  }
  for (const p of ownedPlanets(state, playerId)) total += inStacks(p.garrison);
  return total;
}

/** Evaluates one curated unlock condition deterministically from state — each is an
 *  "at least `min`" count. Unknown types fail-secure (never satisfied); the `never`
 *  guard makes adding a schema variant WITHOUT an evaluator case a COMPILE error, so
 *  the catalog stays safe to extend. Composing existing ones to balance is pure data. */
function conditionMet(
  cond: TechnologyCondition,
  state: GameState,
  playerId: string,
  data: GameData,
): boolean {
  switch (cond.type) {
    case 'own_sectors':
      return ownedPlanets(state, playerId).length >= cond.min;
    case 'has_building':
      return countBuilding(state, playerId, cond.building) >= cond.min;
    case 'controls_planet_type':
      return countPlanetType(state, playerId, cond.planetType) >= cond.min;
    case 'has_unit':
      return countUnit(state, playerId, cond.unit) >= cond.min;
    case 'has_scientist': {
      // Branch-focus / capstone gate: ANY of the player's chosen leaders (≤2) meets the
      // level and (if specified) the branch. Branches come from the per-match-frozen
      // catalog, so the id lookups are snapshot-safe.
      return scientistsOf(state.players[playerId]).some((chosen) => {
        if (chosen.level < cond.minLevel) return false;
        const def = data.scientists[chosen.id];
        if (!def) return false; // a chosen id absent from the catalog satisfies nothing
        return cond.branch === undefined || def.branch === cond.branch;
      });
    }
    default: {
      const _exhaustive: never = cond;
      void _exhaustive;
      return false; // fail-secure for hand-built / unvalidated data
    }
  }
}

/** The data-driven availability gate of a tech, independent of cost / research-slot
 *  state: prerequisites → day-gate → conditions. Returns the first unmet gate's stable
 *  reject code, or null when the node is researchable. Pure — used by the reducer and
 *  reusable for a read-only "what can I research (and why not)" query. */
export function technologyLock(
  def: TechnologyDef,
  state: GameState,
  playerId: string,
  data: GameData,
): string | null {
  const completed = state.players[playerId]?.technologies?.completed ?? [];
  for (const prerequisite of def.prerequisites) {
    if (!completed.includes(prerequisite)) return 'E_PREREQUISITE';
  }
  // Day-gate: "Day N" is the match's world clock, counted exactly as the match browser
  // shows it (matchRegistry: floor((state.time − startedAt) / MS_PER_DAY)), so the lock
  // lines up with the displayed day. timeScale already lives in state.time (the room
  // runs the world clock fast); startedAt defaults to 0 for the 0-based clock.
  if ((def.dayGate ?? 0) > 0 && state.time - (state.startedAt ?? 0) < def.dayGate * MS_PER_DAY) {
    return 'E_TOO_EARLY';
  }
  for (const condition of def.conditions ?? []) {
    if (!conditionMet(condition, state, playerId, data)) return 'E_CONDITIONS_UNMET';
  }
  return null;
}

function startResearch(action: Action, h: HandlerContext): void {
  const payload = action.payload as Partial<ResearchPayload>;
  if (typeof payload?.technology !== 'string') {
    return h.reject('E_BAD_PAYLOAD');
  }
  const player = h.state.players[action.playerId];
  if (!player) {
    return h.reject('E_FORBIDDEN');
  }
  const def = h.ctx.data.technologies[payload.technology];
  if (!def) {
    return h.reject('E_UNKNOWN_TECHNOLOGY');
  }
  const tech = technologyState(player);
  const active = (tech.active ??= []);
  if (
    tech.completed.includes(payload.technology) ||
    active.some((a) => a.technology === payload.technology)
  ) {
    return h.reject('E_ALREADY_RESEARCHED'); // already completed or in progress
  }
  const raw = h.hook<number>('research.slots', BASE_RESEARCH_SLOTS, { playerId: action.playerId });
  // Clamp to the design range [2, 3]; a misbehaving hook (non-finite / out of range)
  // falls back to the base rather than fail-open to unlimited slots.
  const slots = Number.isFinite(raw)
    ? Math.min(MAX_RESEARCH_SLOTS, Math.max(BASE_RESEARCH_SLOTS, Math.floor(raw)))
    : BASE_RESEARCH_SLOTS;
  if (active.length >= slots) {
    return h.reject('E_RESEARCH_SLOTS_FULL'); // every research slot is occupied
  }
  const lock = technologyLock(def, h.state, action.playerId, h.ctx.data);
  if (lock) {
    return h.reject(lock);
  }
  if (!canAfford(player.resources, def.cost)) {
    return h.reject('E_INSUFFICIENT');
  }
  payCost(player.resources, def.cost);
  const completesAt = scheduleCompletion(
    h,
    payload.technology,
    action.playerId,
    def.researchTimeHours,
  );
  active.push({ technology: payload.technology, startedAt: h.ctx.now, completesAt });
  h.emit('technology.research.started', {
    playerId: action.playerId,
    technology: payload.technology,
    completesAt,
  });
}

export const technologyModule: GameModule = {
  id: 'technology',
  version: '1.0.0',
  setup(api) {
    api.onAction('technology.research', startResearch);

    api.on('technology.complete', (event, h) => {
      const payload = event.payload as CompletePayload;
      if (
        typeof payload?.playerId !== 'string' ||
        typeof payload.technology !== 'string' ||
        typeof payload.completesAt !== 'number'
      ) {
        return;
      }
      const player = h.state.players[payload.playerId];
      if (!player) {
        return;
      }
      const tech = technologyState(player);
      const active = tech.active;
      if (!active) {
        return;
      }
      const idx = active.findIndex(
        (a) => a.technology === payload.technology && a.completesAt === payload.completesAt,
      );
      if (idx < 0) {
        return; // no matching slot (stale / duplicate completion) → no-op
      }
      active.splice(idx, 1);
      if (!tech.completed.includes(payload.technology)) {
        tech.completed.push(payload.technology);
      }
      h.emit('technology.researched', {
        playerId: payload.playerId,
        technology: payload.technology,
      });
    });

    api.hook<ConstructionRequirement>('construction.requirement', (current, args, h) => {
      if (!current.allowed) {
        return current;
      }
      const { playerId, kind, id } = args as ConstructionRequirementArgs;
      if (typeof playerId !== 'string' || !kind || typeof id !== 'string') {
        return current;
      }
      const locks = technologiesUnlocking(h.ctx.data, kind, id);
      if (locks.length === 0) {
        return current;
      }
      const player = h.state.players[playerId];
      return locks.some((technology) => hasCompleted(player, technology))
        ? current
        : { allowed: false, code: 'E_TECH_LOCKED' };
    });

    api.hook<ResourceBag>('economy.production', (bag, args, h) => {
      const planetId = (args as ProductionArgs).planetId;
      const owner = planetId ? h.state.planets[planetId]?.owner : null;
      if (owner === null || owner === undefined) {
        return bag;
      }
      const bonus = effectsSum(h.state.players[owner], h.ctx.data, 'productionBonus');
      if (bonus === 0) {
        return bag;
      }
      const out: Record<string, number> = {};
      for (const res of Object.keys(bag)) {
        out[res] = (bag[res] ?? 0) * (1 + bonus);
      }
      return out;
    });

    api.hook<number>('fleet.speed', (speed, args, h) => {
      const fleetId = (args as SpeedArgs).fleetId;
      const owner = fleetId ? h.state.fleets[fleetId]?.owner : undefined;
      const bonus = owner ? effectsSum(h.state.players[owner], h.ctx.data, 'fleetSpeedBonus') : 0;
      return bonus !== 0 ? speed * (1 + bonus) : speed;
    });

    api.hook<number>('combat.damage', (damage, args, h) => {
      const attacker = (args as DamageArgs).attacker;
      const bonus =
        typeof attacker === 'string'
          ? effectsSum(h.state.players[attacker], h.ctx.data, 'combatDamageBonus')
          : 0;
      return bonus !== 0 ? damage * (1 + bonus) : damage;
    });
  },
};
