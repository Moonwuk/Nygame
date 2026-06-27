import type { DiplomaticStance, GameState, PlayerId } from './gameState';

/**
 * Diplomacy state model (D1) — the pure read/write primitives over the pairwise
 * `GameState.diplomacy` map. No module, no actions, no capability here: this is
 * just the shape and how to query/mutate it. The `diplomacyModule` (D2) builds on
 * these to expose declaration actions and the `diplomacy` capability that drives
 * combat's `isHostile` (see `modules/combat.ts`).
 */

/** Stance assumed for any player pair with no explicit entry. War — this
 *  preserves the engine's existing no-diplomacy default (combat treats different
 *  owners as hostile when no `diplomacy` capability is present, see
 *  `combat.ts:isHostile`). Players are at war by default and negotiate *toward*
 *  peace / pact / alliance; an empty `diplomacy` map = plain FFA. */
export const DEFAULT_STANCE: DiplomaticStance = 'war';

/** Separator inside a pair key. Player ids are slugs (`p1`, `red_1`), so `|`
 *  never appears in one and two ids can't concatenate into an ambiguous key. */
const PAIR_SEP = '|';

/** Canonical, order-independent key for the unordered pair {a, b}: the two ids
 *  sorted and joined by {@link PAIR_SEP}. So `pairKey(a, b) === pairKey(b, a)` —
 *  the stance is stored once per pair. */
export function pairKey(a: PlayerId, b: PlayerId): string {
  return a <= b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`;
}

/** The diplomatic stance between two players. A player is always `alliance` with
 *  themselves (self is maximally friendly); an unrecorded pair — or an absent
 *  `diplomacy` map — falls back to {@link DEFAULT_STANCE}. Pure query. */
export function getStance(state: GameState, a: PlayerId, b: PlayerId): DiplomaticStance {
  if (a === b) return 'alliance';
  return state.diplomacy?.[pairKey(a, b)] ?? DEFAULT_STANCE;
}

/** Set the (symmetric) stance between two players, mutating the draft `state` and
 *  lazily creating the `diplomacy` map. Like `treasury.payCost`, this is a draft
 *  mutator a handler calls — it returns nothing. A no-op for `a === b` (a player
 *  has no stance toward themselves). */
export function setStance(
  state: GameState,
  a: PlayerId,
  b: PlayerId,
  stance: DiplomaticStance,
): void {
  if (a === b) return;
  (state.diplomacy ??= {})[pairKey(a, b)] = stance;
}
