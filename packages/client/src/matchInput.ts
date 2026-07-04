/**
 * Map interaction for a live match (CP1.1 — the send half of the online loop). Pure,
 * DOM-free helpers: hit-test a tapped screen point to a planet, find the local player's
 * fleet at a planet, and build the server-authoritative order the client sends. The client
 * sends INTENT only (docs/architecture.md §5) — the server validates/authorizes/applies and
 * broadcasts the new state; these helpers just shape that intent.
 */
import type { Action, GameState, PlayerId, PlanetId } from '@void/shared-core';
import { worldToScreen, type Cam, type Viewport, type Bounds } from './camera';

/** The planet nearest to a screen point within `maxPx`, or null — the tap hit-test. */
export function nearestPlanet(
  state: GameState,
  sx: number,
  sy: number,
  cam: Cam,
  vp: Viewport,
  bounds: Bounds,
  maxPx = 26,
): PlanetId | null {
  let best: PlanetId | null = null;
  let bestD2 = maxPx * maxPx;
  for (const p of Object.values(state.planets)) {
    const c = worldToScreen(p.position, cam, vp, bounds);
    const dx = c.x - sx;
    const dy = c.y - sy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = p.id;
    }
  }
  return best;
}

/** The id of one of `me`'s fleets currently sitting at `planetId`, or null. */
export function myFleetAt(state: GameState, planetId: PlanetId, me: PlayerId): string | null {
  for (const [id, f] of Object.entries(state.fleets)) {
    if (f.owner === me && f.location === planetId) return id;
  }
  return null;
}

/** Build a `fleet.move` order for `fleetId → to`, issued by `me` with monotonic `seq`
 *  (the idempotency id the ungated dev server accepts: `ui:<player>:<seq>`). */
export function moveAction(me: PlayerId, seq: number, fleetId: string, to: PlanetId): Action {
  return {
    id: `ui:${me}:${seq}`,
    type: 'fleet.move',
    playerId: me,
    payload: { fleetId, to },
    issuedAt: 0,
  };
}
