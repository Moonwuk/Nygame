import type { GameModule, HandlerContext } from '../kernel/module';
import { INTERCEPT_TOL, isHostile, laneOccupancy, posAt } from '../util/combat';

/**
 * Schedules a `fleet.intercept` for every hostile fleet whose lane occupancy
 * crosses `fleetId`'s on the SAME lane — the analytic "встреча по формуле". Each
 * pair's position difference is linear in time, so the crossing instant is solved
 * exactly by interpolating the well-conditioned 0..1 positions at the overlap
 * window's ends (never dividing by a tiny rate). The intercept re-validates when
 * it fires, so a re-route before contact harmlessly no-ops a stale crossing.
 */
function scanLaneIntercepts(h: HandlerContext, fleetId: string): void {
  const fleet = h.state.fleets[fleetId];
  if (!fleet || fleet.battleId || !fleet.units.some((s) => s.count > 0)) {
    return;
  }
  const occA = laneOccupancy(fleet);
  if (!occA) {
    return; // not on a lane (at a node / gone)
  }
  const now = h.ctx.now;
  for (const id of Object.keys(h.state.fleets)) {
    if (id === fleetId) {
      continue;
    }
    const other = h.state.fleets[id];
    if (!other || other.battleId || !isHostile(h, fleet.owner, other.owner)) {
      continue;
    }
    if (!other.units.some((s) => s.count > 0)) {
      continue;
    }
    const occB = laneOccupancy(other);
    if (!occB || occB.lo !== occA.lo || occB.hi !== occA.hi) {
      continue; // not on the same lane
    }
    const lo = Math.max(occA.t0, occB.t0, now);
    const hi = Math.min(occA.t1, occB.t1);
    if (!(hi >= lo)) {
      continue; // no shared time window
    }
    let tc: number | null = null;
    if (!occA.moving && !occB.moving) {
      // Both parked: a crossing only if they sit on the very same point (rare).
      if (Math.abs(occA.s0 - occB.s0) <= INTERCEPT_TOL) {
        tc = lo;
      }
    } else {
      // At least one moving ⇒ `hi` is finite. d(t)=posA−posB is linear; find its
      // zero between the window ends.
      const dLo = posAt(occA, lo) - posAt(occB, lo);
      const dHi = posAt(occA, hi) - posAt(occB, hi);
      if (Math.abs(dLo) <= INTERCEPT_TOL) {
        tc = lo; // already together at the window's start
      } else if (Math.abs(dHi) <= INTERCEPT_TOL) {
        tc = hi; // together exactly at the window's end
      } else if (dLo < 0 !== dHi < 0) {
        tc = lo + ((hi - lo) * Math.abs(dLo)) / (Math.abs(dLo) + Math.abs(dHi));
      }
    }
    if (tc !== null) {
      h.schedule(tc, 'fleet.intercept', { a: fleetId, b: id });
    }
  }
}

/**
 * Intercept — the lane-crossing DETECTOR (GDD §7.4), split out of the melee
 * combat module along the bus seams. On every leg start / mid-lane park it
 * solves the crossing instant analytically and schedules `fleet.intercept` —
 * the melee `combat` module re-validates and resolves the meeting into a battle
 * when it fires. Degrades gracefully both ways: without this module fleets only
 * collide at nodes (no lane meetings are ever scheduled); without the melee
 * module the scheduled `fleet.intercept` events harmlessly fade (nobody listens).
 */
export const interceptModule: GameModule = {
  id: 'intercept',
  version: '1.0.0',
  setup(api) {
    // Lane combat: a fleet just began a leg / parked on a lane → look for a hostile
    // fleet it will cross ON the lane (not only at a node) and schedule the meeting.
    api.on('fleet.leg', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      scanLaneIntercepts(h, fleetId);
    });
    api.on('fleet.parked', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      scanLaneIntercepts(h, fleetId);
    });
  },
};
