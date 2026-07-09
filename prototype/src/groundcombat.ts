import type { FormationUnit } from './game';

// --- ground combat: type-matrix damage, weighted by the target's composition --
// Iron-Order-style. Each unit type carries TWO damage tables, attack and defence,
// each giving its damage PER TARGET TYPE. Each tick the attacker hits with `atk`,
// the defender returns `def`. The damage a side deals to a type T is its total
// anti-T output scaled by how much of the target IS type T — so anti-tank weapons
// land on tanks, anti-infantry on infantry, spread evenly within each type.
//
// Note: the near/mid/far damage-receiving LINES are a FLEET (space) concept and do
// NOT apply to ground — ground routes damage by unit type via this matrix instead.

/** Damage by TARGET type (targetType → damage). A missing entry means 0. */
export type DamageTable = Partial<Record<FormationUnit, number>>;

/** A ground unit's combat profile: its own HP plus attack/defence damage by target
 *  type. `atk` is used when its army attacks; `def` is its return fire when attacked. */
export interface GroundProfile {
  hp: number;
  atk: DamageTable;
  def: DamageTable;
}
export type GroundRoster = Record<string, GroundProfile>;

/** Combat width (Iron Order): only the N units MOST EFFECTIVE against the current enemy
 *  fire each tick; the rest are reserve — they add HP and absorb hits, but don't fire.
 *  "Effective" = a unit's damage vs the enemy's composition, so the right counters step
 *  forward (tanks vs infantry). */
export const COMBAT_WIDTH = 12;

/** The default roster — two types: tanks crush infantry (armour breakthrough), infantry
 *  are the cheap, resilient generalist that trades well in numbers. Defence ≥ attack (a
 *  defender's edge). Pure content — tune freely; the resolver reads these. */
// Rock-paper-scissors by DESIGN (H4): tanks shred every infantry line; special forces
// are the one infantry that seriously bites armour (man-portable AT); heavy infantry
// out-tanks everyone on DEFENCE but hits soft; militia is cheap filler that dies fast.
// atk/def are damage PER TARGET TYPE — the counter matrix is data, not code.
export const GROUND_ROSTER: GroundRoster = {
  militia: {
    hp: 14,
    atk: { militia: 4, heavy_infantry: 3, special_forces: 3, tank: 1 },
    def: { militia: 5, heavy_infantry: 4, special_forces: 4, tank: 2 },
  },
  heavy_infantry: {
    hp: 34,
    atk: { militia: 7, heavy_infantry: 5, special_forces: 5, tank: 3 },
    def: { militia: 10, heavy_infantry: 8, special_forces: 8, tank: 6 },
  },
  special_forces: {
    hp: 26,
    atk: { militia: 12, heavy_infantry: 9, special_forces: 9, tank: 10 },
    def: { militia: 11, heavy_infantry: 8, special_forces: 8, tank: 7 },
  },
  tank: {
    hp: 46,
    atk: { militia: 16, heavy_infantry: 12, special_forces: 12, tank: 8 },
    def: { militia: 18, heavy_infantry: 14, special_forces: 12, tank: 9 },
  },
};

/** An officer attached to a division — a hero-like leader granting flexible, TUNABLE
 *  bonuses ("то и то может давать"): any combination of these, set per officer. */
export interface Officer {
  name: string;
  /** +fraction to the division's outgoing ATTACK damage (0.1 = +10%). */
  atk?: number;
  /** +fraction to the division's outgoing DEFENCE (return fire). */
  def?: number;
  /** +fraction to the division's unit HP (toughness / survivability). */
  hp?: number;
  /** Optional flat per-target-type ATTACK bonus (e.g. an anti-tank specialist). */
  atkVs?: DamageTable;
}

/** Placeholder officer archetypes — values are stand-ins to be tuned later. */
export const OFFICERS: Record<string, Officer> = {
  assault: { name: 'Штурмовик', atk: 0.15 },
  defender: { name: 'Командир обороны', def: 0.15, hp: 0.1 },
  quartermaster: { name: 'Снабженец', hp: 0.2 },
};

/** A live stack on one side: a unit type, its count, the remaining HP pool, and the
 *  per-unit max HP (`hpEach`, with any officer toughness baked in). One stack per type. */
export interface GroundStack {
  type: FormationUnit;
  count: number;
  hp: number;
  hpEach: number;
}

/** Build a full-health side from a type→count map (e.g. a mobilised template). An
 *  attached `officer` bakes its HP bonus into each unit's `hpEach`. */
export function makeSide(
  roster: GroundRoster,
  counts: Partial<Record<FormationUnit, number>>,
  officer?: Officer,
): GroundStack[] {
  const hpMul = 1 + (officer?.hp ?? 0);
  const side: GroundStack[] = [];
  for (const [type, count] of Object.entries(counts)) {
    const prof = roster[type];
    if (!prof || !count || count <= 0) continue;
    const hpEach = prof.hp * hpMul;
    side.push({ type: type as FormationUnit, count, hp: count * hpEach, hpEach });
  }
  return side;
}

const liveCount = (side: GroundStack[]): number =>
  side.reduce((n, s) => n + (s.count > 0 ? s.count : 0), 0);

/** The units that FIRE this tick: the `width` MOST EFFECTIVE of `source` against `target`
 *  — ranked by each unit's damage vs the target's composition (so the right counters step
 *  forward: tanks vs infantry). Ties by type id. Returns count per type;
 *  the rest of the army is reserve (HP/absorption only). */
export function activeUnits(
  roster: GroundRoster,
  source: GroundStack[],
  target: GroundStack[],
  which: 'atk' | 'def',
  width = COMBAT_WIDTH,
): DamageTable {
  const total = liveCount(target);
  const out: DamageTable = {};
  if (total <= 0) return out;
  const frac: DamageTable = {};
  for (const s of target) if (s.count > 0) frac[s.type] = (frac[s.type] ?? 0) + s.count / total;
  const eff = (type: string): number => {
    let e = 0;
    for (const t of Object.keys(frac) as FormationUnit[]) e += frac[t]! * (roster[type]?.[which][t] ?? 0);
    return e;
  };
  const ranked = source
    .filter((s) => s.count > 0)
    .slice()
    .sort((x, y) => eff(y.type) - eff(x.type) || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0));
  let remaining = width;
  for (const s of ranked) {
    if (remaining <= 0) break;
    const take = Math.min(s.count, remaining);
    if (take > 0) out[s.type] = (out[s.type] ?? 0) + take;
    remaining -= take;
  }
  return out;
}

/**
 * Damage `source` deals to `target` this tick, as a per target-type bucket:
 *   bucket[t] = ( Σ over source: count × source[which][t] ) × ( target's count-share of t )
 * `which` selects the attacker's `atk` table or the defender's `def` table.
 */
export function damageBuckets(
  roster: GroundRoster,
  source: GroundStack[],
  target: GroundStack[],
  which: 'atk' | 'def',
  officer?: Officer,
  width = COMBAT_WIDTH,
): DamageTable {
  const total = liveCount(target);
  const out: DamageTable = {};
  if (total <= 0) return out;
  // Only the source's `width` units most effective vs THIS target fire; rest are reserve.
  const firing = activeUnits(roster, source, target, which, width);
  // The source's officer scales its outgoing damage (atk when attacking, def on
  // return fire) and may add a flat per-type attack bonus.
  const mul = 1 + (which === 'atk' ? (officer?.atk ?? 0) : (officer?.def ?? 0));
  const targetCount: DamageTable = {};
  for (const s of target) if (s.count > 0) targetCount[s.type] = (targetCount[s.type] ?? 0) + s.count;
  for (const t of Object.keys(targetCount) as FormationUnit[]) {
    let armyDmg = 0;
    for (const [type, cnt] of Object.entries(firing)) {
      armyDmg += cnt! * (roster[type]?.[which][t] ?? 0);
    }
    if (which === 'atk') armyDmg += officer?.atkVs?.[t] ?? 0;
    out[t] = armyDmg * mul * (targetCount[t]! / total);
  }
  return out;
}

/** Apply per-type damage buckets to a side: each type's bucket hits that type's stack,
 *  killing whole units as its HP pool drops. Returns the survivors. */
function applyBuckets(side: GroundStack[], buckets: DamageTable): GroundStack[] {
  return side
    .map((s) => {
      const dmg = buckets[s.type] ?? 0;
      if (dmg <= 0 || s.count <= 0) return s;
      const hp = Math.max(0, s.hp - dmg);
      const count = hp <= 0 ? 0 : Math.ceil(hp / s.hpEach);
      return { type: s.type, count, hp: count > 0 ? hp : 0, hpEach: s.hpEach };
    })
    .filter((s) => s.count > 0);
}

/** One simultaneous combat tick: attacker hits with `atk`, defender returns `def` —
 *  both resolved from the PRE-tick state, then applied. */
export interface GroundTick {
  toDefender: DamageTable;
  toAttacker: DamageTable;
  attacker: GroundStack[];
  defender: GroundStack[];
}
export function groundTick(
  roster: GroundRoster,
  attacker: GroundStack[],
  defender: GroundStack[],
  attackerOfficer?: Officer,
  defenderOfficer?: Officer,
): GroundTick {
  const toDefender = damageBuckets(roster, attacker, defender, 'atk', attackerOfficer);
  const toAttacker = damageBuckets(roster, defender, attacker, 'def', defenderOfficer);
  return {
    toDefender,
    toAttacker,
    attacker: applyBuckets(attacker, toAttacker),
    defender: applyBuckets(defender, toDefender),
  };
}

export interface GroundOutcome {
  winner: 'attacker' | 'defender' | null;
  rounds: number;
  attacker: GroundStack[];
  defender: GroundStack[];
}

/** Resolve a ground battle to conclusion (one side wiped), or null at the round cap.
 *  Each side may have an attached officer (its bonuses apply every tick). */
export function resolveGround(
  roster: GroundRoster,
  attacker: GroundStack[],
  defender: GroundStack[],
  opts: { attackerOfficer?: Officer; defenderOfficer?: Officer; maxRounds?: number } = {},
): GroundOutcome {
  const maxRounds = opts.maxRounds ?? 100;
  let a = attacker;
  let d = defender;
  let rounds = 0;
  while (liveCount(a) > 0 && liveCount(d) > 0 && rounds < maxRounds) {
    const t = groundTick(roster, a, d, opts.attackerOfficer, opts.defenderOfficer);
    a = t.attacker;
    d = t.defender;
    rounds += 1;
  }
  const aAlive = liveCount(a) > 0;
  const dAlive = liveCount(d) > 0;
  return {
    winner: aAlive && !dAlive ? 'attacker' : dAlive && !aAlive ? 'defender' : null,
    rounds,
    attacker: a,
    defender: d,
  };
}
