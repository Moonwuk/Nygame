import type { GameModule } from '../kernel/module';
import type { DiplomaticStance } from '../state/gameState';
import {
  clearOffers,
  getOffer,
  getStance,
  isBotPair,
  offerInvolves,
  setOffer,
  setStance,
  stanceToRelation,
  type DiplomacyCapability,
} from '../state/diplomacy';

/** Hostility rank of a stance — the axis declarations move along. Higher = more
 *  hostile. Unilateral declarations may only move a pair UP this axis (toward
 *  war); moving down (toward peace / pact / alliance) needs the other side's
 *  consent, because the map is symmetric — otherwise a player under attack could
 *  declare `peace` mid-war and unilaterally switch the enemy's combat off. */
const HOSTILITY: Record<DiplomaticStance, number> = {
  alliance: 0,
  pact: 1,
  peace: 2,
  war: 3,
};

function isStance(value: unknown): value is DiplomaticStance {
  return value === 'war' || value === 'peace' || value === 'pact' || value === 'alliance';
}

/**
 * Diplomacy — declarations (D2) + the consent protocol (D3). Builds on the D1
 * state primitives (`state/diplomacy.ts`), all through one action:
 *
 *  - `diplomacy.declare { target, stance }` toward MORE hostile — unilateral:
 *    the stance flips at once (declaring war never needs consent) and any
 *    standing offers between the pair are voided (a war declaration ends the
 *    negotiation). Emits `diplomacy.changed { a, b, stance, from }`.
 *  - `diplomacy.declare` toward FRIENDLIER — mutual: the first declaration
 *    records a standing OFFER (stance unchanged, `diplomacy.offered` emitted,
 *    visible only to the two parties); when the other side declares the SAME
 *    stance, the pair commits — stance flips, offers clear, `diplomacy.changed`
 *    fires. An invariant falls out: a standing offer is always strictly
 *    friendlier than the pair's current stance (commits and escalations clear).
 *  - provides the `diplomacy` capability (`getRelation`: stance → hostile /
 *    neutral / ally) that combat's `isHostile` consults; without this module
 *    combat falls back to reading the stance directly — same behaviour, so the
 *    module degrades gracefully (invariant #3).
 */
export const diplomacyModule: GameModule = {
  id: 'diplomacy',
  version: '1.1.0',
  setup(api) {
    api.provideCapability<DiplomacyCapability>('diplomacy', {
      getRelation: (state, a, b) => stanceToRelation(getStance(state, a, b)),
    });

    api.onAction('diplomacy.declare', (action, h) => {
      const { target, stance } = action.payload as { target?: unknown; stance?: unknown };
      if (typeof target !== 'string' || target === action.playerId || !isStance(stance)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      // A defeated seat is out of the game politically too (mirrors espionage):
      // it can neither declare nor be declared upon — otherwise eliminated
      // players stay full diplomatic actors and offers to the dead hang forever.
      const actor = h.state.players[action.playerId];
      if (!actor || actor.status !== 'active') {
        return h.reject('E_FORBIDDEN');
      }
      // The player roster is public (every projection keeps ids/names), so an
      // unknown-target reject leaks nothing fog-hidden (A06).
      const victim = h.state.players[target];
      if (!victim || victim.status !== 'active') {
        return h.reject('E_NO_PLAYER');
      }
      const me = action.playerId;
      const from = getStance(h.state, me, target);
      if (stance === from) {
        return h.reject('E_SAME_STANCE');
      }

      if (HOSTILITY[stance] > HOSTILITY[from]) {
        // Escalation — unilateral, and it ends any negotiation in flight.
        clearOffers(h.state, me, target);
        setStance(h.state, me, target, stance);
        h.emit('diplomacy.changed', { a: me, b: target, stance, from });
        return;
      }

      // A coalition is between humans only (GDD §3): an alliance-ward declaration
      // involving an AI seat is refused outright — it must neither stand as an
      // offer nor commit. Peace and a pact with a bot remain legal.
      if (stance === 'alliance' && isBotPair(h.state, me, target)) {
        return h.reject('E_BOT_ALLIANCE');
      }
      // De-escalation — the consent protocol (D3): commit on a matching
      // counter-offer, otherwise record/replace this side's standing offer.
      if (getOffer(h.state, target, me) === stance) {
        clearOffers(h.state, me, target);
        setStance(h.state, me, target, stance);
        h.emit('diplomacy.changed', { a: me, b: target, stance, from });
        return;
      }
      if (getOffer(h.state, me, target) === stance) {
        return h.reject('E_ALREADY_OFFERED'); // this exact offer already stands
      }
      setOffer(h.state, me, target, stance);
      h.emit('diplomacy.offered', { from: me, to: target, stance });
    });

    // An eliminated player can never counter-declare, so their standing offers
    // (sent OR received) would hang in state and in the counterparty's view
    // forever — sweep them the moment the player falls.
    api.on('player.eliminated', (event, h) => {
      const playerId = (event.payload as { playerId?: string })?.playerId;
      const offers = h.state.diplomacyOffers;
      if (typeof playerId !== 'string' || !offers) return;
      for (const key of Object.keys(offers)) {
        if (offerInvolves(key, playerId)) delete offers[key];
      }
      if (Object.keys(offers).length === 0) delete h.state.diplomacyOffers;
    });
  },
};
