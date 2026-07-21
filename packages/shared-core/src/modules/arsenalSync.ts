import type { GameModule } from '../kernel/module';
import type { PlayerArsenal } from '../state/gameState';

/**
 * LARS-1 — the server-only driver that refreshes a seat's live build-catalog
 * ownership mid-match (LARS-0.2: only "what can be built" goes live; already-built
 * ships are untouched — no-refit doctrine intact). `unit.build`/`hero.fit` keep
 * exactly the ARS-3 snapshot check (`construction.ts`/`hero.ts`) unchanged — this
 * module's only job is to REPLACE `Player.arsenal` with a freshly-read
 * `ArsenalStore` projection, so that unchanged check sees current ownership on
 * the very next `unit.build`.
 *
 * Deliberately NOT client-submittable (absent from `actionPayloadSchemas`, same
 * as `patrol.stamp`) — a client stamping its own arsenal would forge ownership.
 * The server computes the payload from a live `ArsenalStore.listOf(accountId)`
 * read and submits it via `room.submitAction`, bypassing the action-layer gate —
 * the same pattern already used by the AI/patrol drivers.
 */
export const arsenalSyncModule: GameModule = {
  id: 'arsenal-sync',
  version: '0.1.0',
  setup(api) {
    api.onAction('arsenal.sync', (action, h) => {
      const payload = action.payload as Partial<PlayerArsenal> | undefined;
      if (
        !payload ||
        !Array.isArray(payload.hulls) ||
        !Array.isArray(payload.modules) ||
        !Array.isArray(payload.fittings)
      ) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      // A seat with no snapshot at all stays unrestricted (ARS-3 graceful
      // degradation) — syncing one in only makes sense for a seat that already
      // started arsenal-gated (the server only ever submits this for those).
      if (!player.arsenal) return h.reject('E_NO_SNAPSHOT');
      player.arsenal = {
        hulls: [...new Set(payload.hulls)].sort(),
        modules: [...new Set(payload.modules)].sort(),
        fittings: [...new Set(payload.fittings)].sort(),
      };
    });
  },
};
