/**
 * The one place that knows how the shipped game-content bundle is composed — the list of
 * `data/*.json` fragments and the manifest version — so every surface (server, tests, and
 * the web client) assembles it identically instead of keeping its own copy (CP0.3,
 * docs/cross-platform-roadmap.md — "один загрузчик, не шесть").
 *
 * Environment-agnostic (no Node, browser-safe): the caller injects a `readJson(name)`
 * that returns the parsed contents of `data/<name>` — `readFileSync`+`JSON.parse` on the
 * server/in tests, a map of Vite JSON imports in the browser. Adding a data fragment is a
 * one-line change here that every consumer picks up.
 */
import { parseGameData } from './schemas';
import type { GameData } from './schemas';

/** Reads and parses `data/<name>` (e.g. `readJson('units.json')`). */
export type JsonReader = (name: string) => unknown;

/** Compose the raw (unvalidated) content bundle from its fragments. Kept separate from
 *  {@link loadGameData} so validation-failure tests can tweak the bundle before parsing. */
export function composeGameDataBundle(readJson: JsonReader): Record<string, unknown> {
  const manifest = readJson('manifest.json') as { version: string };
  return {
    version: manifest.version,
    resources: readJson('resources.json'),
    units: readJson('units.json'),
    factions: readJson('factions.json'),
    buildings: readJson('buildings.json'),
    events: readJson('events.json'),
    sectors: readJson('sectors.json'),
    sectorKinds: readJson('sectorKinds.json'),
    planetTypes: readJson('planetTypes.json'),
    technologies: readJson('technologies.json'),
    scientists: readJson('scientists.json'),
    modules: readJson('modules.json'),
  };
}

/** Compose **and** validate the shipped bundle (A05/A08 — validate before use). */
export function loadGameData(readJson: JsonReader): GameData {
  return parseGameData(composeGameDataBundle(readJson));
}
