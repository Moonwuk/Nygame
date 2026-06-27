import type { GameModule } from '../kernel/module';
import { addUnits } from '../util/stacks';

/**
 * Necromancer signature mechanic — raise the fallen (CR-1.4 / B4). When a fleet owned
 * by a faction with the `raise_fallen` ability loses ships in battle, a fraction of the
 * dead rise again as `reanimated_drone` in that same (surviving) fleet.
 *
 * It listens on the `unit.died` event combat publishes. Events are QUEUED (fired after
 * the round's damage resolution finishes), so adding units back to the fleet is safe —
 * no mid-iteration mutation — and the raised drones join from the next round. Pure and
 * **deterministic**: a fixed fraction, no RNG. The force still net-shrinks each round
 * (fraction < 1) and risen drones don't re-raise, so a battle still converges — the
 * necromancer just bleeds slower. Data-gated on the faction ability; without this
 * module or the ability nothing happens (graceful degradation).
 */

const RAISE_FALLEN = 'raise_fallen';
const REANIMATED_UNIT = 'reanimated_drone';
const REANIMATE_FRACTION = 0.5; // half the fallen rise again

export const reanimationModule: GameModule = {
  id: 'reanimation',
  version: '1.0.0',
  setup(api) {
    api.on('unit.died', (event, h) => {
      const { count, fleetId, unit } = (event.payload ?? {}) as {
        count?: number;
        fleetId?: string;
        unit?: string;
      };
      if (typeof fleetId !== 'string' || typeof count !== 'number' || count <= 0) return;
      if (unit === REANIMATED_UNIT) return; // the risen don't re-raise (no compounding)
      const fleet = h.state.fleets[fleetId];
      if (!fleet) return; // the fleet was wiped out — nothing left to raise into
      const faction = h.state.players[fleet.owner]?.faction;
      const def = faction ? h.ctx.data.factions[faction] : undefined;
      if (!def?.abilities.includes(RAISE_FALLEN)) return;
      const raised = Math.floor(count * REANIMATE_FRACTION);
      if (raised <= 0) return;
      addUnits(fleet.units, REANIMATED_UNIT, raised);
      h.emit('unit.reanimated', { fleetId, owner: fleet.owner, unit: REANIMATED_UNIT, count: raised });
    });
  },
};
