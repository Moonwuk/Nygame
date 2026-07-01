import type { GameModule, HandlerContext } from '../kernel/module';
import { getStance } from '../state/diplomacy';
import { isCapturable } from '../state/sectorKind';

/**
 * Capture-on-arrival (map-roadmap.md M2.2). A fleet that reaches an undefended,
 * uncontested **capturable** sector it doesn't own takes it on the spot — the
 * "walk-in" capture. This was a client-only convenience in the prototype
 * (`seizeSector`), so it never happened in multiplayer; as a kernel rule it now
 * runs server-side and applies identically in single-player and online.
 *
 * Skipped (these need a real assault — the combat module — or can't be owned):
 *   - defended: the sector has a live garrison;
 *   - contested: an enemy fleet with units is also present;
 *   - not capturable: empty space (sector kind `capturable: false`);
 *   - owned by a non-hostile player: an ally's / at-peace world can't be seized
 *     for free — that needs a declared war first (same `war`-only gate combat's
 *     `isHostile` uses). Only a NEUTRAL (unowned) or an at-WAR world walks in.
 *
 * Ordered AFTER combat in the module list, so a contested arrival starts its
 * battle first and the guards below then decline to capture.
 */
function tryCapture(h: HandlerContext, payload: unknown): void {
  const { fleetId, at } = (payload ?? {}) as { fleetId?: string; at?: string };
  if (typeof fleetId !== 'string' || typeof at !== 'string') return;
  const fleet = h.state.fleets[fleetId];
  const planet = h.state.planets[at];
  if (!fleet || !planet || planet.owner === fleet.owner) return;
  if (!isCapturable(h.ctx.data, planet)) return;
  if (planet.owner !== null && getStance(h.state, fleet.owner, planet.owner) !== 'war') return;
  if (planet.garrison.some((s) => s.count > 0)) return;
  const contested = Object.values(h.state.fleets).some(
    (g) => g.owner !== fleet.owner && g.location === at && g.units.some((u) => u.count > 0),
  );
  if (contested) return;
  planet.owner = fleet.owner;
  h.emit('planet.captured', { planetId: at, owner: fleet.owner, via: 'arrival' });
}

export const captureOnArrivalModule: GameModule = {
  id: 'capture-on-arrival',
  version: '0.1.0',
  setup(api) {
    api.on('fleet.arrived', (event, h) => tryCapture(h, event.payload));
    api.on('fleet.transit', (event, h) => tryCapture(h, event.payload));
  },
};
