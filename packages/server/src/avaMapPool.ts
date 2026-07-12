import { avaShape, type MatchMap, type Rng } from '@void/shared-core';

/**
 * AvA map pool (AVA-5) — the orchestrator-side pick of "an AvA map for N×M"
 * (`corporation-wars.md` S4, consumed by AVA-7). Pure and deterministic:
 * candidates are the maps tagged `avaEligible` whose DERIVED shape matches the
 * requested size (`avaShape` — sides / slots-per-side come from the slots
 * themselves, so there are no declared numbers to drift), ordered canonically
 * by map id so the choice is independent of the caller's array order. A pick
 * spends exactly one draw of the supplied seeded `Rng` — same pool + same rng
 * state → the same map, so a session's map choice can be re-derived for
 * replays/audit. No eligible map of that size → `null` (the caller decides
 * whether that cancels the matchup); maps are assumed already validated
 * (`parseMatchMap` + `validateMatchMap` at load).
 */
export function pickAvaMap(
  maps: readonly MatchMap[],
  sides: number,
  slotsPerSide: number,
  rng: Rng,
): MatchMap | null {
  const pool = maps
    .filter((map) => {
      if (!map.avaEligible) return false;
      const shape = avaShape(map);
      return shape !== null && shape.sides === sides && shape.slotsPerSide === slotsPerSide;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (pool.length === 0) return null;
  return pool[rng.nextInt(0, pool.length)]!;
}
