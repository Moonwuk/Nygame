import type { DomainEvent, GameData, PlayerReward } from '@void/shared-core';
import type { ArsenalStore, DropStore } from './store';

/**
 * ARS-4 — the F2P replenishment loop: play → earn (GDD §4.4 "catch-up: power falls
 * with matches, chance rises with place"). Everything here is SERVER-SIDE, outside
 * the reducer: the deterministic core is never touched (the metrics invariant), and
 * the roll RNG is server policy (EC-2.1). The rolls ARE deterministic per
 * (match, account) — not for gameplay determinism, but so a replayed award pass is
 * bit-identical and the exactly-once claim plus the idempotent grant compose into a
 * crash-safe pipeline; the tables themselves are DATA (`data/dropTables.json`).
 */

/** One weighted line of the drop pool — blueprints only (instances/grades are the
 *  craft loop, EC-2). */
export interface DropPoolLine {
  kind: 'hull' | 'module';
  defId: string;
  weight: number;
}

/** `data/dropTables.json` — the whole loop is balanced by editing this file. */
export interface DropTables {
  /** Pity: a drop is GUARANTEED on the `pityAfter`-th consecutive dry match. */
  pityAfter: number;
  /** Drop chance by final place: the first row with `place <= maxPlace` applies
   *  (rows sorted ascending) — place 1 rolls better than place N (GDD §4.4). */
  byPlace: Array<{ maxPlace: number; chance: number }>;
  pool: DropPoolLine[];
  /** Salvage (shards, the EC-2.2 craft input): per fallen enemy unit, by unit id. */
  salvage: { default: number; perUnit?: Record<string, number> };
}

/** Validate the tables against the shipped catalogs (fail-secure at boot). */
export function validateDropTables(tables: DropTables, data: GameData): string[] {
  const issues: string[] = [];
  if (!(tables.pityAfter >= 1)) issues.push('E_BAD_PITY');
  if (tables.byPlace.length === 0) issues.push('E_EMPTY_PLACES');
  for (const row of tables.byPlace) {
    if (!(row.chance >= 0 && row.chance <= 1)) issues.push(`E_BAD_CHANCE:${row.maxPlace}`);
  }
  if (tables.pool.length === 0) issues.push('E_EMPTY_POOL');
  for (const line of tables.pool) {
    if (!(line.weight > 0)) issues.push(`E_BAD_WEIGHT:${line.defId}`);
    const catalog = line.kind === 'hull' ? data.units : data.modules;
    if (!catalog[line.defId]) issues.push(`E_UNKNOWN_DEF:${line.kind}:${line.defId}`);
  }
  for (const unit of Object.keys(tables.salvage.perUnit ?? {})) {
    if (!data.units[unit]) issues.push(`E_UNKNOWN_DEF:salvage:${unit}`);
  }
  return issues;
}

/** FNV-1a 32-bit over a seed string → the roll stream's start state. */
function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 — a tiny deterministic PRNG stream in [0, 1). Server-side policy RNG
 *  (EC-2.1); seeded per (match, account) so a replayed pass rolls identically. */
export function rollStream(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The drop chance for a final place (rows checked ascending; past the last row → 0 —
 *  an unlisted place earns nothing, fail-secure). */
export function chanceForPlace(tables: DropTables, place: number): number {
  for (const row of [...tables.byPlace].sort((a, b) => a.maxPlace - b.maxPlace)) {
    if (place <= row.maxPlace) return row.chance;
  }
  return 0;
}

/** Weighted pick from the pool with one roll in [0, 1). Pure. */
export function pickFromPool(pool: readonly DropPoolLine[], roll: number): DropPoolLine {
  const total = pool.reduce((sum, line) => sum + line.weight, 0);
  let cursor = roll * total;
  for (const line of pool) {
    cursor -= line.weight;
    if (cursor < 0) return line;
  }
  return pool[pool.length - 1]!; // roll == 1 - ε landing on the boundary
}

/** One account's telemetry record of an end-of-match roll (the JSONL line EC-5.1
 *  will later ingest — disclosure of odds is a P2W gauge, so the roll is logged). */
export interface DropRecord {
  matchId: string;
  accountId: string;
  place: number;
  chance: number;
  pity: number;
  forced: boolean;
  dropped: { kind: 'hull' | 'module'; defId: string } | null;
}

export interface AwardDeps {
  drops: DropStore;
  arsenal: ArsenalStore;
  tables: DropTables;
  now: number;
  /** Telemetry sink — one line per rolled account (odds disclosure, EC-5.1 input). */
  log?: (record: DropRecord) => void;
}

/**
 * Roll the end-of-match drop for every seated account. Exactly-once per
 * (match, account) via `DropStore.claim` — a replayed match end re-claims nothing,
 * so neither the roll nor the pity bump can double. A drop grants a TRADABLE
 * blueprint (origin `drop`; deterministic item id ⇒ the grant itself is also
 * idempotent, belt-and-braces) and resets pity; a dry roll bumps pity; the
 * `pityAfter`-th consecutive dry match forces the drop instead (no black streaks).
 */
export async function awardMatchDrops(
  deps: AwardDeps,
  matchId: string,
  entries: ReadonlyArray<{ accountId: string; reward: PlayerReward }>,
): Promise<DropRecord[]> {
  const records: DropRecord[] = [];
  for (const { accountId, reward } of entries) {
    if (!(await deps.drops.claim(matchId, accountId))) continue; // replay — already rolled
    const pity = await deps.drops.pityOf(accountId);
    const chance = chanceForPlace(deps.tables, reward.place);
    const rng = rollStream(`${matchId}:${accountId}`);
    const forced = pity + 1 >= deps.tables.pityAfter;
    const record: DropRecord = {
      matchId,
      accountId,
      place: reward.place,
      chance,
      pity,
      forced,
      dropped: null,
    };
    if (rng() < chance || forced) {
      const line = pickFromPool(deps.tables.pool, rng());
      await deps.arsenal.grant({
        itemId: `drop:${matchId}:${accountId}`,
        accountId,
        kind: line.kind,
        form: 'blueprint',
        defId: line.defId,
        soulbound: false, // drops trade — the F2P catch-up feeds the auction (ARS-0)
        origin: 'drop',
        acquiredAt: deps.now,
      });
      await deps.drops.setPity(accountId, 0);
      record.dropped = { kind: line.kind, defId: line.defId };
    } else {
      await deps.drops.setPity(accountId, pity + 1);
    }
    deps.log?.(record);
    records.push(record);
  }
  return records;
}

/**
 * Salvage (ARS-4, second half): shards to the WINNER of each battle, priced by the
 * fallen ENEMY composition. Pure over one observed event batch — `battle.resolved`
 * names the winner, and the batch's `unit.died` events at the same location tagged
 * with ANOTHER owner are that battle's enemy losses (`applyDamageToSide` stamps
 * `owner` before a wiped fleet is deleted, so the tag survives). A stalemate
 * (winner null) salvages nothing.
 */
export function salvageFromEvents(
  events: readonly DomainEvent[],
  tables: DropTables,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'battle.resolved') continue;
    const b = event.payload as { winner?: unknown; location?: unknown };
    if (typeof b.winner !== 'string' || typeof b.location !== 'string') continue;
    let shards = 0;
    for (const death of events) {
      if (death.type !== 'unit.died') continue;
      const d = death.payload as { unit?: unknown; count?: unknown; at?: unknown; owner?: unknown };
      if (d.at !== b.location || typeof d.owner !== 'string' || d.owner === b.winner) continue;
      if (typeof d.unit !== 'string' || typeof d.count !== 'number') continue;
      shards += (tables.salvage.perUnit?.[d.unit] ?? tables.salvage.default) * d.count;
    }
    if (shards > 0) out.set(b.winner, (out.get(b.winner) ?? 0) + shards);
  }
  return out;
}
