import type { GameModule } from '../kernel/module';
import type { Fleet } from '../state/gameState';
import type { GameData } from '../data/schemas';
import { timeScaleOf } from '../action/types';

const MS_PER_HOUR = 3_600_000;

interface MovePayload {
  fleetId: string;
  to: string;
}

/** Fleet speed = the slowest unit in it (data-driven), 0 if it cannot move. */
function fleetBaseSpeed(fleet: Fleet, data: GameData): number {
  let speed = Infinity;
  for (const stack of fleet.units) {
    const def = data.units[stack.unit];
    if (!def) {
      continue;
    }
    speed = Math.min(speed, def.stats.speed);
  }
  return Number.isFinite(speed) ? speed : 0;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Movement — a base module (docs/modulesystem.md). Turns the player intent
 * `fleet.move` into a real-time journey: it validates the order (server-
 * authority / OWASP A01), computes travel time, and schedules a `fleet.arrival`
 * for when the fleet reaches its destination. The world clock fires that event
 * later via `advanceTo` — the fleet is genuinely in transit for real hours.
 *
 * Final speed runs through the `fleet.speed` hook (the canonical computeSpeed
 * pipeline from docs/modulesystem.md), so warp drives / curses can modify it.
 */
export const movementModule: GameModule = {
  id: 'movement',
  version: '1.0.0',
  setup(api) {
    api.onAction('fleet.move', (action, h) => {
      const payload = action.payload as Partial<MovePayload>;
      if (typeof payload?.fleetId !== 'string' || typeof payload?.to !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }

      const fleet = h.state.fleets[payload.fleetId];
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN'); // not your fleet
      }
      if (fleet.location === null || fleet.movement !== null || fleet.battleId) {
        return h.reject('E_FLEET_BUSY'); // already in transit or engaged in battle
      }
      if (payload.to === fleet.location) {
        return h.reject('E_SAME_LOCATION');
      }
      const origin = h.state.planets[fleet.location];
      const dest = h.state.planets[payload.to];
      if (!dest) {
        return h.reject('E_NO_DESTINATION');
      }
      if (!origin) {
        return h.reject('E_INTERNAL'); // inconsistent state → fail-secure
      }

      const speed = h.hook<number>('fleet.speed', fleetBaseSpeed(fleet, h.ctx.data), {
        fleetId: fleet.id,
      });
      if (speed <= 0) {
        return h.reject('E_FLEET_IMMOBILE');
      }

      // timeScale compresses all real-time durations (GDD §3.1).
      const travelHours = distance(origin.position, dest.position) / speed;
      const travelMs = (travelHours * MS_PER_HOUR) / timeScaleOf(h.ctx);
      const arrivesAt = h.ctx.now + travelMs;

      fleet.location = null;
      fleet.movement = { from: origin.id, to: dest.id, departedAt: h.ctx.now, arrivesAt };
      h.schedule(arrivesAt, 'fleet.arrival', { fleetId: fleet.id });
      h.emit('fleet.departed', { fleetId: fleet.id, from: origin.id, to: dest.id, arrivesAt });
    });

    api.on('fleet.arrival', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      const fleet = h.state.fleets[fleetId];
      if (!fleet || fleet.movement === null) {
        return; // stale event (fleet gone or already arrived) → harmless
      }
      const destination = fleet.movement.to;
      fleet.location = destination;
      fleet.movement = null;
      // Announce arrival; combat/territory modules can react (graceful degradation).
      h.emit('fleet.arrived', { fleetId, at: destination, owner: fleet.owner });
    });
  },
};
