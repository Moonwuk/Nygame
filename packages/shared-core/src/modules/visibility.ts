import type { GameModule, HandlerContext } from '../kernel/module';
import type { FogMemory, GameState, PlanetId, PlanetSnapshot } from '../state/gameState';
import { identifiedNodes } from '../state/visibility';

/**
 * Visibility — fog-of-war MEMORY (variant B). The security projection
 * (`visibleState`) hides what a player cannot currently see; this module is the
 * other half: it records the last-known snapshot of every world a player has
 * identified, so `visibleState` can show it greyed ("last known") once sight
 * lifts. Memory lives inside `GameState` (deterministic, persisted, JSON), is
 * updated only from the authoritative state, and degrades gracefully — without
 * this module there is simply no memory and unseen worlds read as unknown.
 */

function snapshot(state: GameState, planetId: PlanetId, now: number): PlanetSnapshot {
  const planet = state.planets[planetId]!;
  const snap: PlanetSnapshot = {
    owner: planet.owner,
    garrison: planet.garrison.map((s) => ({ ...s })),
    buildings: planet.buildings.map((b) => ({ ...b })),
    at: now,
  };
  if (planet.sectorType !== undefined) snap.sectorType = planet.sectorType;
  if (planet.planetType !== undefined) snap.planetType = planet.planetType;
  return snap;
}

/** Refresh every active player's memory with what they currently identify. */
function refreshMemory(h: HandlerContext): void {
  const state = h.state;
  const fog = (state.fog ??= {});
  for (const playerId of Object.keys(state.players)) {
    if (state.players[playerId]?.status !== 'active') continue;
    const memory: FogMemory = fog[playerId] ?? (fog[playerId] = {});
    for (const nodeId of identifiedNodes(state, playerId, h.ctx.data)) {
      if (state.planets[nodeId]) memory[nodeId] = snapshot(state, nodeId, h.ctx.now);
    }
  }
}

export const visibilityModule: GameModule = {
  id: 'visibility',
  version: '1.0.0',
  setup(api) {
    // Continuous time advances refresh memory; captures and arrivals refresh it
    // immediately so a just-scouted world is remembered at once.
    api.on('time.advanced', (_event, h) => refreshMemory(h));
    api.on('planet.captured', (_event, h) => refreshMemory(h));
    api.on('fleet.arrived', (_event, h) => refreshMemory(h));
  },
};
