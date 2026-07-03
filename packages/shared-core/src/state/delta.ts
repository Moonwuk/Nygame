import type { GameState } from './gameState';
import { deepEqual } from '../util/clone';

const COLLECTIONS = ['players', 'planets', 'fleets', 'battles'] as const;
type Collection = (typeof COLLECTIONS)[number];
const META_KEYS = [
  'version',
  'time',
  'startedAt',
  'match',
  'rng',
  'battleSeq',
  'scheduled',
  'scheduleSeq',
  'fog',
  'heroes',
  'tempLanes',
  'topology',
  'heroSeq',
  'diplomacy',
  'diplomacyOffers',
  'intel',
  'market',
  'marketSeq',
] as const;

/**
 * A minimal patch between two `GameState`s: per keyed collection only the
 * entities that were added or changed, plus the ids removed, plus any top-level
 * scalar/array fields that changed. Sized to what actually changed rather than
 * the whole world — the networking win for an async game where most of the map
 * is idle between actions (an unchanged entity costs zero bytes).
 *
 * `applyDelta(prev, diffState(prev, next))` deep-equals `next`.
 */
export interface StateDelta {
  changed: Partial<Record<Collection, Record<string, unknown>>>;
  removed: Partial<Record<Collection, string[]>>;
  meta?: Record<string, unknown>;
  /** Meta keys that went defined → undefined. Carried separately because JSON drops
   *  `undefined` values on the wire and `Object.assign` can't remove a key — so a key
   *  the server cleared (e.g. a future diplomacyModule emptying `diplomacy`) would
   *  otherwise stay stale on the client and desync. `applyDelta` `delete`s these. */
  removedMeta?: string[];
}

/** Top-level keys beyond the known collections/meta — HOST EXTENSIONS riding in
 *  `GameState` (e.g. the prototype's `orders` command chains or `divisions`). They are
 *  part of the JSONB snapshot and of every `welcome` full state, so deltas must carry
 *  them too — otherwise a client's copy goes stale right after the first broadcast. */
function extensionKeys(prev: GameState, next: GameState): string[] {
  const known = new Set<string>([...COLLECTIONS, ...META_KEYS]);
  const keys = new Set<string>();
  for (const k of Object.keys(prev)) if (!known.has(k)) keys.add(k);
  for (const k of Object.keys(next)) if (!known.has(k)) keys.add(k);
  return [...keys];
}

/** Build the patch that turns `prev` into `next` (entity-level for collections). */
export function diffState(prev: GameState, next: GameState): StateDelta {
  const changed: StateDelta['changed'] = {};
  const removed: StateDelta['removed'] = {};
  for (const col of COLLECTIONS) {
    const p = prev[col] as Record<string, unknown>;
    const n = next[col] as Record<string, unknown>;
    const c: Record<string, unknown> = {};
    const r: string[] = [];
    for (const id of Object.keys(n)) {
      if (!(id in p) || !deepEqual(p[id], n[id])) c[id] = n[id];
    }
    for (const id of Object.keys(p)) {
      if (!(id in n)) r.push(id);
    }
    if (Object.keys(c).length > 0) changed[col] = c;
    if (r.length > 0) removed[col] = r;
  }
  let meta: Record<string, unknown> | undefined;
  let removedMeta: string[] | undefined;
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  for (const k of [...META_KEYS, ...extensionKeys(prev, next)]) {
    if (!deepEqual(p[k], n[k])) {
      if (n[k] === undefined) (removedMeta ??= []).push(k);
      else (meta ??= {})[k] = n[k];
    }
  }
  const out: StateDelta = { changed, removed };
  if (meta) out.meta = meta;
  if (removedMeta) out.removedMeta = removedMeta;
  return out;
}

/** Apply a `StateDelta` to `state`, returning a new `GameState` (input untouched). */
export function applyDelta(state: GameState, delta: StateDelta): GameState {
  const next = { ...state } as GameState;
  for (const col of COLLECTIONS) {
    const c = delta.changed[col];
    const r = delta.removed[col];
    if (!c && !r) continue;
    const merged = { ...(state[col] as Record<string, unknown>) };
    if (c) for (const id of Object.keys(c)) merged[id] = c[id];
    if (r) for (const id of r) delete merged[id];
    (next as unknown as Record<string, unknown>)[col] = merged;
  }
  if (delta.meta) Object.assign(next, delta.meta);
  if (delta.removedMeta) {
    for (const k of delta.removedMeta) delete (next as unknown as Record<string, unknown>)[k];
  }
  return next;
}
