/**
 * Browser side of the shared game-data loader (CP0.3). Vite inlines the `data/*.json`
 * fragments + a shipped map at build time; we hand them to the SAME `loadGameData`
 * composer the server and tests use (one fragment list, no forked copy), then build a
 * real, startable `GameState` from a map with `buildStateFromMap`.
 */
import { loadGameData, parseMatchMap, buildStateFromMap } from '@void/shared-core';
import type { GameData, GameState } from '@void/shared-core';

import manifest from '../../../data/manifest.json';
import resources from '../../../data/resources.json';
import units from '../../../data/units.json';
import factions from '../../../data/factions.json';
import buildings from '../../../data/buildings.json';
import events from '../../../data/events.json';
import sectors from '../../../data/sectors.json';
import sectorKinds from '../../../data/sectorKinds.json';
import planetTypes from '../../../data/planetTypes.json';
import technologies from '../../../data/technologies.json';
import scientists from '../../../data/scientists.json';
import skirmishMap from '../../../data/maps/skirmish-1.json';

const FRAGMENTS: Record<string, unknown> = {
  'manifest.json': manifest,
  'resources.json': resources,
  'units.json': units,
  'factions.json': factions,
  'buildings.json': buildings,
  'events.json': events,
  'sectors.json': sectors,
  'sectorKinds.json': sectorKinds,
  'planetTypes.json': planetTypes,
  'technologies.json': technologies,
  'scientists.json': scientists,
};

/** The validated shipped content bundle, composed in the browser via the shared loader. */
export function shippedGameData(): GameData {
  return loadGameData((name) => FRAGMENTS[name]);
}

/** A ready-to-render single-player `GameState` built from the shipped skirmish map. */
export function skirmishState(data: GameData): GameState {
  return buildStateFromMap(parseMatchMap(skirmishMap), data);
}
