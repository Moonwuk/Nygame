import type { GameModule, HandlerContext } from '../kernel/module';
import type { Battle, Fleet } from '../state/gameState';
import type { GameData, UnitDef } from '../data/schemas';
import { timeScaleOf, type Context } from '../action/types';

const MS_PER_HOUR = 3_600_000;
/** Hard cap on rounds so a zero-damage stalemate can't run forever (fail-secure). */
const MAX_COMBAT_ROUNDS = 240;

type Tier = 'front' | 'mid' | 'rear' | 'artillery';
/** Damage-receiving order (GDD §7.2): artillery is only reachable once the
 *  front, mid and rear lines are gone. */
const TIER_ORDER: readonly Tier[] = ['front', 'mid', 'rear', 'artillery'];

/** Optional diplomacy capability — absent ⇒ different owner = hostile. */
interface Diplomacy {
  getRelation(a: string, b: string): 'hostile' | 'ally' | 'neutral';
}

const roundIntervalMs = (ctx: Context): number => MS_PER_HOUR / timeScaleOf(ctx);

function unitTier(def: UnitDef): Tier {
  return def.traits.includes('artillery') ? 'artillery' : def.line;
}

function isAlive(fleet: Fleet): boolean {
  return fleet.units.some((s) => s.count > 0);
}

/** Raw damage a fleet deals in one round = Σ count × attack. */
function fleetAttack(fleet: Fleet, data: GameData): number {
  let dmg = 0;
  for (const stack of fleet.units) {
    const def = data.units[stack.unit];
    if (def) {
      dmg += stack.count * def.stats.attack;
    }
  }
  return dmg;
}

/**
 * Applies `totalDamage` to a fleet, filling the receiving lines in tier order.
 * Tracks each stack's remaining HP pool so partial damage persists across
 * rounds; whole ships are lost as the pool drops, each loss announced via
 * `unit.died` (the bus hook the necromancer-style modules listen on).
 */
function applyDamage(h: HandlerContext, fleet: Fleet, totalDamage: number, data: GameData): void {
  let remaining = totalDamage;
  for (const tier of TIER_ORDER) {
    if (remaining <= 0) {
      break;
    }
    const stacks = fleet.units
      .filter((s) => {
        const def = data.units[s.unit];
        return def ? unitTier(def) === tier : false;
      })
      .sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));

    for (const stack of stacks) {
      if (remaining <= 0) {
        break;
      }
      const def = data.units[stack.unit];
      if (!def) {
        continue;
      }
      const perShip = def.stats.hp > 0 ? def.stats.hp : 1;
      let pool = stack.hp ?? stack.count * perShip;
      const absorbed = Math.min(remaining, pool);
      pool -= absorbed;
      remaining -= absorbed;

      const newCount = pool <= 0 ? 0 : Math.ceil(pool / perShip);
      const lost = stack.count - newCount;
      if (lost > 0) {
        h.emit('unit.died', { fleetId: fleet.id, unit: stack.unit, count: lost });
      }
      stack.count = newCount;
      stack.hp = newCount > 0 ? pool : 0;
    }
  }
  fleet.units = fleet.units.filter((s) => s.count > 0);
}

function findEnemyFleet(h: HandlerContext, arriver: Fleet): Fleet | null {
  const diplomacy = h.capability<Diplomacy>('diplomacy');
  let best: Fleet | null = null;
  for (const id of Object.keys(h.state.fleets)) {
    const f = h.state.fleets[id];
    if (!f || f.id === arriver.id || f.location !== arriver.location) {
      continue;
    }
    if (f.battleId || f.owner === arriver.owner || !isAlive(f)) {
      continue;
    }
    const rel = diplomacy?.getRelation(arriver.owner, f.owner) ?? 'hostile';
    if (rel !== 'hostile') {
      continue;
    }
    if (best === null || f.id < best.id) {
      best = f;
    }
  }
  return best;
}

function startBattle(
  h: HandlerContext,
  location: string,
  attackerId: string,
  defenderId: string,
): void {
  const id = `battle:${h.state.battleSeq++}`;
  h.state.battles[id] = { id, location, attacker: attackerId, defender: defenderId, round: 0 };
  const attacker = h.state.fleets[attackerId];
  const defender = h.state.fleets[defenderId];
  if (attacker) attacker.battleId = id;
  if (defender) defender.battleId = id;
  h.emit('battle.started', { battleId: id, location, attacker: attackerId, defender: defenderId });
  h.schedule(h.ctx.now + roundIntervalMs(h.ctx), 'combat.tick', { battleId: id });
}

function finishBattle(h: HandlerContext, battle: Battle, stalemate = false): void {
  const attacker = h.state.fleets[battle.attacker];
  const defender = h.state.fleets[battle.defender];
  const aAlive = !!attacker && isAlive(attacker);
  const dAlive = !!defender && isAlive(defender);
  const winner = stalemate
    ? null
    : aAlive && !dAlive
      ? battle.attacker
      : dAlive && !aAlive
        ? battle.defender
        : null;

  for (const fleet of [attacker, defender]) {
    if (!fleet) {
      continue;
    }
    if (isAlive(fleet)) {
      fleet.battleId = null; // released, free to move again
    } else {
      h.emit('fleet.destroyed', { fleetId: fleet.id, owner: fleet.owner });
      delete h.state.fleets[fleet.id];
    }
  }
  delete h.state.battles[battle.id];
  h.emit('battle.resolved', {
    battleId: battle.id,
    location: battle.location,
    winner,
    rounds: battle.round,
  });
}

/**
 * Combat — a base module (GDD §7). First increment: orbital battle, fleet vs
 * fleet, resolved over real hours (one round per `combat.tick`). Damage runs
 * through the `combat.damage` hook (admiral / tactic / curse extension point);
 * deaths publish `unit.died`; resolution publishes `battle.resolved`. Ground
 * phase, planet capture and heroes build on top of this in the next increments.
 */
export const combatModule: GameModule = {
  id: 'combat',
  version: '1.0.0',
  setup(api) {
    // A fleet arriving where a hostile fleet sits triggers an engagement.
    api.on('fleet.arrived', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      const arriver = h.state.fleets[fleetId];
      if (!arriver || arriver.location === null || arriver.battleId) {
        return;
      }
      const enemy = findEnemyFleet(h, arriver);
      if (enemy) {
        startBattle(h, arriver.location, arriver.id, enemy.id);
      }
    });

    // One battle round per hourly tick.
    api.on('combat.tick', (event, h) => {
      const { battleId } = event.payload as { battleId: string };
      const battle = h.state.battles[battleId];
      if (!battle) {
        return; // already resolved
      }
      const data = h.ctx.data;
      const attacker = h.state.fleets[battle.attacker];
      const defender = h.state.fleets[battle.defender];
      if (!attacker || !defender || !isAlive(attacker) || !isAlive(defender)) {
        finishBattle(h, battle);
        return;
      }

      battle.round += 1;
      if (battle.round > MAX_COMBAT_ROUNDS) {
        finishBattle(h, battle, true); // stalemate safety valve
        return;
      }

      // Simultaneous round: both sides fire from the pre-round state.
      const dmgToDefender = h.hook<number>('combat.damage', fleetAttack(attacker, data), {
        battleId,
        attacker: attacker.id,
        defender: defender.id,
      });
      const dmgToAttacker = h.hook<number>('combat.damage', fleetAttack(defender, data), {
        battleId,
        attacker: defender.id,
        defender: attacker.id,
      });
      applyDamage(h, defender, dmgToDefender, data);
      applyDamage(h, attacker, dmgToAttacker, data);
      h.emit('combat.round', { battleId, round: battle.round, dmgToAttacker, dmgToDefender });

      if (isAlive(attacker) && isAlive(defender)) {
        h.schedule(h.ctx.now + roundIntervalMs(h.ctx), 'combat.tick', { battleId });
      } else {
        finishBattle(h, battle);
      }
    });
  },
};
