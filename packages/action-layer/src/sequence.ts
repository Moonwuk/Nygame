import type { PlayerId } from '@void/shared-core';
import { fail, ok, type ActionLayerResult } from './errors';

export interface SequenceKey {
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
}

export interface SequenceCursor extends SequenceKey {
  lastSeq: number;
}

export interface SequenceGate {
  checkAndReserve(key: SequenceKey, clientSeq: number): ActionLayerResult<SequenceCursor>;
  last(key: SequenceKey): number;
  /** Undo a reservation of `clientSeq` (only if it is still the latest — no newer action
   *  advanced past it). Lets a caller release the cursor when the reserved action fails
   *  TRANSIENTLY (e.g. a durable write was unavailable), so a backoff-retry of the same
   *  clientSeq is admitted again instead of hitting `E_REPLAY`. */
  rollback(key: SequenceKey, clientSeq: number): void;
}

function keyOf(key: SequenceKey): string {
  return `${key.matchId}:${key.playerId}:${key.sessionId}`;
}

export interface InMemorySequenceGateOptions {
  /** Cap on retained per-session cursors; past it the LEAST-RECENTLY-USED is evicted.
   *  Bounds memory on a 24/7 process where connect/disconnect churn would otherwise grow
   *  one cursor per distinct `(matchId, playerId, sessionId)` forever. An active session is
   *  touched on every action so it is never the victim; only stale sessions are reclaimed.
   *  A reclaimed session's cursor resets to 0 (its next action would be `E_OUT_OF_ORDER`
   *  until it resyncs) — a safety backstop that only bites far past normal concurrency.
   *  Default 50000. */
  maxCursors?: number;
}

const CURSORS_MAX_DEFAULT = 50_000;

export class InMemorySequenceGate implements SequenceGate {
  private readonly cursors = new Map<string, number>();
  private readonly maxCursors: number;

  constructor(options: InMemorySequenceGateOptions = {}) {
    this.maxCursors =
      options.maxCursors !== undefined && options.maxCursors > 0
        ? options.maxCursors
        : CURSORS_MAX_DEFAULT;
  }

  /** Number of retained cursors (bounded by `maxCursors`) — for metrics/tests. */
  get size(): number {
    return this.cursors.size;
  }

  checkAndReserve(key: SequenceKey, clientSeq: number): ActionLayerResult<SequenceCursor> {
    const k = keyOf(key);
    const current = this.cursors.get(k) ?? 0;
    const expected = current + 1;
    if (clientSeq <= current) return fail('E_REPLAY');
    if (clientSeq !== expected) return fail('E_OUT_OF_ORDER');
    // LRU touch: delete + re-insert so this (active) session moves to the most-recent end
    // of the Map and is not the eviction victim, then evict the least-recently-used past
    // the cap. Reserving the seq and refreshing recency are the same write.
    this.cursors.delete(k);
    this.cursors.set(k, clientSeq);
    while (this.cursors.size > this.maxCursors) {
      const lru = this.cursors.keys().next().value;
      if (lru === undefined) break;
      this.cursors.delete(lru);
    }
    return ok({ ...key, lastSeq: clientSeq });
  }

  last(key: SequenceKey): number {
    return this.cursors.get(keyOf(key)) ?? 0;
  }

  rollback(key: SequenceKey, clientSeq: number): void {
    const k = keyOf(key);
    // Only undo if `clientSeq` is still the cursor — a serialized caller guarantees no
    // newer action advanced past it, so this restores the pre-reservation state exactly.
    if (this.cursors.get(k) !== clientSeq) return;
    // Unwinding to 0 is the fresh state — drop the entry (don't leave a dead 0 in the LRU).
    if (clientSeq <= 1) this.cursors.delete(k);
    else this.cursors.set(k, clientSeq - 1);
  }
}
