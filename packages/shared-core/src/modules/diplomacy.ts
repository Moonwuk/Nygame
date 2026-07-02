import type { Action } from '../action/types';
import type { GameModule, HandlerContext } from '../kernel/module';
import { getStance, pairKey, setStance } from '../state/diplomacy';
import type { DiplomaticStance, GameState, PlayerId } from '../state/gameState';

/**
 * Diplomacy actions (D2), on top of the D1 state primitives (`state/diplomacy.ts`).
 * The rule that shapes every action: moving a pair TOWARD war is unilateral (nobody
 * needs consent to break a promise), moving it TOWARD alliance needs both sides —
 * a standing offer (`state.diplomacyOffers`) the other party accepts or rejects.
 *
 *   - `diplomacy.declare {target, stance}` — unilateral DOWNGRADE, applied at once.
 *   - `diplomacy.propose {target, stance}` — offer an UPGRADE; one standing offer
 *     per pair (a newer proposal, from either side, replaces it).
 *   - `diplomacy.accept {from}` / `diplomacy.reject {from}` — resolve that offer.
 *
 * Any stance change voids the pair's pending offer (it was made under the old
 * relationship). Combat keeps reading stances straight off the state (D1 default:
 * unrecorded pair = war = FFA); this module only owns HOW stances change. The
 * `diplomacy` capability projects stances onto the coarse hostile/neutral/ally
 * relation for consumers that don't care about the pact/peace distinction.
 */

/** Friendliness order — an action is a downgrade or an upgrade along this scale. */
const RANK: Record<DiplomaticStance, number> = { war: 0, peace: 1, pact: 2, alliance: 3 };

const STANCES = new Set<string>(Object.keys(RANK));

/** The coarse relation the `diplomacy` capability reports (see `DiplomaticStance`
 *  in `state/gameState.ts`): war → hostile, peace/pact → neutral, alliance → ally. */
export type DiplomaticRelation = 'hostile' | 'neutral' | 'ally';

export function stanceToRelation(stance: DiplomaticStance): DiplomaticRelation {
  return stance === 'war' ? 'hostile' : stance === 'alliance' ? 'ally' : 'neutral';
}

/** Optional link other modules may consume via `h.capability('diplomacy')` —
 *  with the usual fallback when the module is absent (docs/modulesystem.md). */
export interface DiplomacyCapability {
  getStance(state: GameState, a: PlayerId, b: PlayerId): DiplomaticStance;
  getRelation(state: GameState, a: PlayerId, b: PlayerId): DiplomaticRelation;
}

interface StancePayload {
  target?: string;
  stance?: string;
}

/** True when either side of the pair is an AI seat (bot). Coalitions are between
 *  humans only — a bot is not invitable to an alliance (GDD: коалиция). */
function botParty(h: HandlerContext, a: PlayerId, b: PlayerId): boolean {
  return h.state.players[a]?.ai === true || h.state.players[b]?.ai === true;
}

/** Validates actor + target and returns the target id, or rejects (fail-secure):
 *  both parties must exist and still be in the match. */
function requireParties(action: Action, h: HandlerContext, target: unknown): PlayerId {
  const actor = h.state.players[action.playerId];
  if (!actor || actor.status !== 'active') {
    return h.reject('E_FORBIDDEN');
  }
  if (typeof target !== 'string' || target === action.playerId) {
    return h.reject('E_BAD_TARGET');
  }
  const other = h.state.players[target];
  if (!other || other.status !== 'active') {
    return h.reject('E_NO_PLAYER');
  }
  return target;
}

/** Applies a stance change: writes it, voids the pair's pending offer (it was
 *  made under the old relationship), and announces the new stance. */
function changeStance(h: HandlerContext, a: PlayerId, b: PlayerId, stance: DiplomaticStance): void {
  setStance(h.state, a, b, stance);
  delete h.state.diplomacyOffers?.[pairKey(a, b)];
  h.emit('diplomacy.changed', { a, b, stance });
}

export const diplomacyModule: GameModule = {
  id: 'diplomacy',
  version: '1.0.0',
  setup(api) {
    // Unilateral declaration — only DOWNGRADES (toward war). Declaring war needs
    // nobody's consent; so does dissolving an alliance down to peace. Raising a
    // stance goes through propose/accept.
    api.onAction('diplomacy.declare', (action, h) => {
      const p = action.payload as StancePayload;
      if (typeof p?.stance !== 'string' || !STANCES.has(p.stance)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const stance = p.stance as DiplomaticStance;
      const target = requireParties(action, h, p.target);
      if (RANK[stance] >= RANK[getStance(h.state, action.playerId, target)]) {
        return h.reject('E_BAD_STANCE'); // not a downgrade — propose it instead
      }
      changeStance(h, action.playerId, target, stance);
    });

    // Offer an UPGRADE (toward alliance). One standing offer per pair: a newer
    // proposal — from either side — replaces it (the latest word stands).
    api.onAction('diplomacy.propose', (action, h) => {
      const p = action.payload as StancePayload;
      if (typeof p?.stance !== 'string' || !STANCES.has(p.stance)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const stance = p.stance as DiplomaticStance;
      const target = requireParties(action, h, p.target);
      if (stance === 'alliance' && botParty(h, action.playerId, target)) {
        return h.reject('E_BOT_ALLIANCE'); // a coalition is between humans only
      }
      if (RANK[stance] <= RANK[getStance(h.state, action.playerId, target)]) {
        return h.reject('E_BAD_STANCE'); // not an upgrade — declare it instead
      }
      (h.state.diplomacyOffers ??= {})[pairKey(action.playerId, target)] = {
        from: action.playerId,
        stance,
      };
      h.emit('diplomacy.proposed', { from: action.playerId, to: target, stance });
    });

    // Resolve the standing offer from `from` on our pair.
    api.onAction('diplomacy.accept', (action, h) => {
      const from = requireParties(action, h, (action.payload as { from?: string })?.from);
      const key = pairKey(action.playerId, from);
      const offer = h.state.diplomacyOffers?.[key];
      if (!offer || offer.from !== from) {
        return h.reject('E_NO_OFFER'); // nothing (from them) to accept
      }
      // A rejection discards the draft, so a hand-seeded invalid offer stays in the
      // state — both checks below are defensive re-validation, not cleanup. Every
      // legitimate stance change voids the pair's offer, so a MODULE-made offer is
      // always still an upgrade and never a bot alliance (fail-secure over invariants).
      if (offer.stance === 'alliance' && botParty(h, action.playerId, from)) {
        return h.reject('E_BOT_ALLIANCE');
      }
      if (RANK[offer.stance] <= RANK[getStance(h.state, action.playerId, from)]) {
        return h.reject('E_BAD_STANCE');
      }
      changeStance(h, from, action.playerId, offer.stance);
    });

    api.onAction('diplomacy.reject', (action, h) => {
      const from = requireParties(action, h, (action.payload as { from?: string })?.from);
      const key = pairKey(action.playerId, from);
      const offer = h.state.diplomacyOffers?.[key];
      if (!offer || offer.from !== from) {
        return h.reject('E_NO_OFFER');
      }
      delete h.state.diplomacyOffers?.[key];
      h.emit('diplomacy.rejected', { from, to: action.playerId, stance: offer.stance });
    });

    api.provideCapability<DiplomacyCapability>('diplomacy', {
      getStance,
      getRelation: (state, a, b) => stanceToRelation(getStance(state, a, b)),
    });
  },
};
