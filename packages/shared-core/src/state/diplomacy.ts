import type { DiplomaticStance, GameState, PlayerId } from './gameState';

/** Friendliness order of the stances — the shared vocabulary for "is this change
 *  an upgrade or a downgrade" (core `diplomacyModule` rules, prototype UI routing). */
export const STANCE_RANK: Record<DiplomaticStance, number> = {
  war: 0,
  peace: 1,
  pact: 2,
  alliance: 3,
};

/**
 * Diplomacy state model (D1) — the pure read/write primitives over the pairwise
 * `GameState.diplomacy` map, plus the stance→relation projection contract (D2).
 * No module here: `modules/diplomacy.ts` builds on these to expose the
 * declaration action and provide the `diplomacy` capability that drives combat's
 * `isHostile` (see `modules/combat.ts`). The capability CONTRACT lives here — the
 * neutral state layer — so a consumer module never imports a provider module
 * (invariant #3: modules talk only through the bus/capabilities).
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

/** Whether `id` is one of the two parties a pair key names. The projection uses
 *  this to keep a diplomatic offer visible only to its participants. */
export function pairHas(key: string, id: PlayerId): boolean {
  const sep = key.indexOf(PAIR_SEP);
  return key.slice(0, sep) === id || key.slice(sep + 1) === id;
}

/** The two party ids a pair key names. Safe because player ids are barred from
 *  containing the separator at every seeding boundary (map schema / slot check). */
export function pairParts(key: string): [PlayerId, PlayerId] {
  const sep = key.indexOf(PAIR_SEP);
  return [key.slice(0, sep), key.slice(sep + 1)];
}

/** True when either player of the pair is an AI seat (bot). The humans-only
 *  coalition rule keys off this (GDD: боты не приглашаются в коалиции). */
export function isBotPair(state: GameState, a: PlayerId, b: PlayerId): boolean {
  return state.players[a]?.ai === true || state.players[b]?.ai === true;
}

/** The diplomatic stance between two players. A player is always `alliance` with
 *  themselves (self is maximally friendly); an unrecorded pair — or an absent
 *  `diplomacy` map — falls back to {@link DEFAULT_STANCE}. Pure query. */
export function getStance(state: GameState, a: PlayerId, b: PlayerId): DiplomaticStance {
  if (a === b) return 'alliance';
  return state.diplomacy?.[pairKey(a, b)] ?? DEFAULT_STANCE;
}

/** The combat-facing projection of a stance: `war` → hostile (fleets engage,
 *  worlds can be assaulted), `alliance` → ally (shared side), `peace`/`pact` →
 *  neutral (no auto-combat). See the `DiplomaticStance` docs in `gameState.ts`. */
export type DiplomaticRelation = 'hostile' | 'neutral' | 'ally';

/** Maps a stance to its combat relation. Pure, total. */
export function stanceToRelation(stance: DiplomaticStance): DiplomaticRelation {
  switch (stance) {
    case 'war':
      return 'hostile';
    case 'alliance':
      return 'ally';
    default:
      return 'neutral'; // peace | pact — "we are not fighting"
  }
}

/** The `diplomacy` capability contract (D2), provided by `diplomacyModule` and
 *  consumed by combat's `isHostile`. Takes the state explicitly (a capability is
 *  registered once at kernel build and holds no state of its own). Absent
 *  capability ⇒ consumers fall back to reading the stance directly (graceful
 *  degradation — same behaviour, since the base mapping is this same one). */
export interface DiplomacyCapability {
  getRelation(state: GameState, a: PlayerId, b: PlayerId): DiplomaticRelation;
}

/** Separator inside a DIRECTED offer key (`from>to`). Like {@link pairKey}'s
 *  `|`, player ids are slugs, so `>` never appears in one. Direction matters: an
 *  offer is from a declarer to a recipient. */
const OFFER_SEP = '>';

/** Directed key for a standing de-escalation offer from `from` to `to` (D3). */
export function offerKey(from: PlayerId, to: PlayerId): string {
  return `${from}${OFFER_SEP}${to}`;
}

/** Whether an offer key involves `playerId` as either party — the fog rule:
 *  offers are private to the two parties (`visibleState` strips the rest). */
export function offerInvolves(key: string, playerId: PlayerId): boolean {
  const sep = key.indexOf(OFFER_SEP);
  return key.slice(0, sep) === playerId || key.slice(sep + 1) === playerId;
}

/** The stance `from` currently offers `to`, or null when no offer stands. */
export function getOffer(state: GameState, from: PlayerId, to: PlayerId): DiplomaticStance | null {
  return state.diplomacyOffers?.[offerKey(from, to)] ?? null;
}

/** Record (or replace) `from`'s standing offer toward `to`, lazily creating the
 *  offers map. Draft mutator, like {@link setStance}. */
export function setOffer(
  state: GameState,
  from: PlayerId,
  to: PlayerId,
  stance: DiplomaticStance,
): void {
  if (from === to) return;
  (state.diplomacyOffers ??= {})[offerKey(from, to)] = stance;
}

/** Void BOTH directions of the pair's offers (on a commit or an escalation —
 *  a war declaration ends the negotiation). Drops the map when it empties, so
 *  an offer-free state serializes identically to one that never negotiated. */
export function clearOffers(state: GameState, a: PlayerId, b: PlayerId): void {
  const offers = state.diplomacyOffers;
  if (!offers) return;
  delete offers[offerKey(a, b)];
  delete offers[offerKey(b, a)];
  if (Object.keys(offers).length === 0) delete state.diplomacyOffers;
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
