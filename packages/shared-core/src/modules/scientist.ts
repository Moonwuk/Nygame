import type { GameData } from '../data/schemas';
import type { GameModule } from '../kernel/module';
import type { Player } from '../state/gameState';

interface SlotArgs {
  playerId?: string;
}

/** Extra research slots the player's chosen scientist grants (0 if none / unknown id). */
function scientistSlotBonus(player: Player | undefined, data: GameData): number {
  const chosen = player?.scientist;
  if (!chosen) {
    return 0;
  }
  return data.scientists[chosen.id]?.slotBonus ?? 0;
}

/**
 * Scientist (research leader) — a per-player entity CHOSEN at match start and
 * snapshotted immutably (GDD §2/§5.2); NOT a unit and NOT the `hero` module. Its
 * effects ride existing seams rather than new plumbing:
 *
 * - the "+slot" leader adds to the `research.slots` hook here (clamped to the design
 *   max by the technology module);
 * - branch-focus and late-game capstone content gate through the data-driven
 *   `has_scientist` condition in the technology module.
 *
 * Its meta level is supplied at match creation (from the account meta, once that
 * exists) and read-only for the rest of the match. Degrades gracefully: no chosen
 * scientist, or an id absent from the catalog, contributes nothing.
 */
export const scientistModule: GameModule = {
  id: 'scientist',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('research.slots', (base, args, h) => {
      const { playerId } = args as SlotArgs;
      if (typeof playerId !== 'string') {
        return base;
      }
      return base + scientistSlotBonus(h.state.players[playerId], h.ctx.data);
    });
  },
};
