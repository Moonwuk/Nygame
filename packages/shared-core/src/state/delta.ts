import type { GameState } from './gameState';

const COLLECTIONS = ['players', 'planets', 'fleets', 'battles'] as const;
type Collection = (typeof COLLECTIONS)[number];
const META_KEYS = [
  'version',
  'time',
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
      if (!(id in p) || JSON.stringify(p[id]) !== JSON.stringify(n[id])) c[id] = n[id];
    }
    for (const id of Object.keys(p)) {
      if (!(id in n)) r.push(id);
    }
    if (Object.keys(c).length > 0) changed[col] = c;
    if (r.length > 0) removed[col] = r;
  }
  let meta: Record<string, unknown> | undefined;
  for (const k of META_KEYS) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      (meta ??= {})[k] = next[k];
    }
  }
  return meta ? { changed, removed, meta } : { changed, removed };
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
  return next;
}
