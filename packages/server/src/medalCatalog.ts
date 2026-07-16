import { readFileSync } from 'node:fs';

/**
 * The medal / achievement catalog (corporations.md §3) — DATA, not code: a fixed set of
 * objective, server-checked conditions. It lives outside the deterministic core (no medal
 * counters in `applyAction`), so it is validated here with a small fail-secure parser
 * rather than through the core's `GameData` loader. Unknown shape / condition type → throw
 * (an unrecognized condition must never silently read as "eligible").
 */

export type MedalScope = 'corp' | 'account';
export type MedalGrant = 'manual' | 'auto';

/** An objective, server-checkable condition. MVP: corp-level AvA aggregates from the match
 *  history (`AvaResultStore`). Per-account conditions (e.g. `ava_matches_for_corp`) need a
 *  per-account participation ledger — deferred (see the roadmap). */
export type MedalCondition =
  | { type: 'corp_wins'; count: number }
  | { type: 'corp_matches'; count: number };

export interface MedalDef {
  id: string;
  name: string;
  description: string;
  scope: MedalScope;
  grant: MedalGrant;
  condition: MedalCondition;
}

export type MedalCatalog = Record<string, MedalDef>;

const SCOPES = new Set<MedalScope>(['corp', 'account']);
const GRANTS = new Set<MedalGrant>(['manual', 'auto']);
const CONDITION_TYPES = new Set<MedalCondition['type']>(['corp_wins', 'corp_matches']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseCondition(raw: unknown, id: string): MedalCondition {
  if (!isObject(raw)) throw new Error(`E_INVALID_MEDALS: ${id} condition not an object`);
  const type = raw.type;
  if (typeof type !== 'string' || !CONDITION_TYPES.has(type as MedalCondition['type'])) {
    throw new Error(`E_INVALID_MEDALS: ${id} unknown condition type ${String(type)}`);
  }
  const count = raw.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    throw new Error(`E_INVALID_MEDALS: ${id} condition count must be a positive integer`);
  }
  return { type: type as MedalCondition['type'], count };
}

/** Validate a raw catalog object into a typed `MedalCatalog`, or throw `E_INVALID_MEDALS`. */
export function parseMedalCatalog(raw: unknown): MedalCatalog {
  if (!isObject(raw) || !isObject(raw.medals)) {
    throw new Error('E_INVALID_MEDALS: missing `medals` object');
  }
  const catalog: MedalCatalog = {};
  for (const [id, def] of Object.entries(raw.medals)) {
    if (!isObject(def)) throw new Error(`E_INVALID_MEDALS: ${id} not an object`);
    const { name, description, scope, grant } = def;
    if (typeof name !== 'string' || name === '') throw new Error(`E_INVALID_MEDALS: ${id} name`);
    if (typeof description !== 'string') throw new Error(`E_INVALID_MEDALS: ${id} description`);
    if (typeof scope !== 'string' || !SCOPES.has(scope as MedalScope)) {
      throw new Error(`E_INVALID_MEDALS: ${id} scope ${String(scope)}`);
    }
    if (typeof grant !== 'string' || !GRANTS.has(grant as MedalGrant)) {
      throw new Error(`E_INVALID_MEDALS: ${id} grant ${String(grant)}`);
    }
    catalog[id] = {
      id,
      name,
      description,
      scope: scope as MedalScope,
      grant: grant as MedalGrant,
      condition: parseCondition(def.condition, id),
    };
  }
  return catalog;
}

/** Load + validate the shipped `data/medals.json` catalog. */
export function loadMedalCatalog(): MedalCatalog {
  const raw = JSON.parse(readFileSync(new URL('../../../data/medals.json', import.meta.url), 'utf8'));
  return parseMedalCatalog(raw);
}
