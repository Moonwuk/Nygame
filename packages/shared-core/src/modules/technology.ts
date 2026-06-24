import type { Action } from '../action/types';
import { timeScaleOf } from '../action/types';
import type { GameData, ResourceBag, TechnologyDef } from '../data/schemas';
import type { GameModule, HandlerContext } from '../kernel/module';
import type { Player, PlayerTechnologyState } from '../state/gameState';
import { canAfford, payCost } from '../util/treasury';

const MS_PER_HOUR = 3_600_000;

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

function technologyState(player: Player): PlayerTechnologyState {
  if (!player.technologies) {
    player.technologies = { completed: [] };
  }
  return player.technologies;
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
  const completesAt = h.ctx.now + (hours * MS_PER_HOUR) / timeScaleOf(h.ctx);
  h.schedule(completesAt, 'technology.complete', { playerId, technology, completesAt });
  return completesAt;
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
  if (tech.completed.includes(payload.technology)) {
    return h.reject('E_ALREADY_RESEARCHED');
  }
  if (tech.active) {
    return h.reject('E_RESEARCH_BUSY');
  }
  for (const prerequisite of def.prerequisites) {
    if (!tech.completed.includes(prerequisite)) {
      return h.reject('E_PREREQUISITE');
    }
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
  tech.active = { technology: payload.technology, startedAt: h.ctx.now, completesAt };
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
      if (
        !tech.active ||
        tech.active.technology !== payload.technology ||
        tech.active.completesAt !== payload.completesAt
      ) {
        return;
      }
      delete tech.active;
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
