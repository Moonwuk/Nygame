import type { PlayerId } from '@void/shared-core';
import type { ActionEnvelope } from './envelope';

export interface ActionReceipt {
  actionId: string;
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
  clientSeq: number;
  acceptedAt: number;
  ok: boolean;
  code?: string;
}

export interface ActionReceiptStore {
  get(actionId: string): ActionReceipt | undefined;
  put(receipt: ActionReceipt): void;
}

export interface InMemoryActionReceiptStoreOptions {
  /** Cap on retained receipts; past it the oldest are evicted (FIFO). Bounds memory for a
   *  long-running or hostile session — idempotency is needed for the retry window (minutes),
   *  not forever. A retry older than the last `maxEntries` re-applies. Mirrors
   *  `MatchRoom.maxReceipts` so the two dedup layers agree. Default 10000. */
  maxEntries?: number;
}

const RECEIPTS_MAX_DEFAULT = 10_000;

export class InMemoryActionReceiptStore implements ActionReceiptStore {
  private readonly receipts = new Map<string, ActionReceipt>();
  private readonly maxEntries: number;

  constructor(options: InMemoryActionReceiptStoreOptions = {}) {
    this.maxEntries =
      options.maxEntries !== undefined && options.maxEntries > 0
        ? options.maxEntries
        : RECEIPTS_MAX_DEFAULT;
  }

  /** Number of retained receipts (bounded by `maxEntries`) — for metrics/tests. */
  get size(): number {
    return this.receipts.size;
  }

  get(actionId: string): ActionReceipt | undefined {
    return this.receipts.get(actionId);
  }

  put(receipt: ActionReceipt): void {
    if (this.receipts.has(receipt.actionId)) return; // first verdict wins (stable)
    this.receipts.set(receipt.actionId, receipt);
    // FIFO-evict the oldest past the cap (Map preserves insertion order). A retried action
    // older than the last `maxEntries` is no longer deduped and re-applies — the accepted
    // idempotency window, identical to the room's bounded receipts.
    while (this.receipts.size > this.maxEntries) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
  }
}

export function createActionReceipt(
  envelope: ActionEnvelope,
  acceptedAt: number,
  result: { ok: true } | { ok: false; code: string },
): ActionReceipt {
  return result.ok
    ? {
        actionId: envelope.actionId,
        matchId: envelope.matchId,
        playerId: envelope.playerId,
        sessionId: envelope.sessionId,
        clientSeq: envelope.clientSeq,
        acceptedAt,
        ok: true,
      }
    : {
        actionId: envelope.actionId,
        matchId: envelope.matchId,
        playerId: envelope.playerId,
        sessionId: envelope.sessionId,
        clientSeq: envelope.clientSeq,
        acceptedAt,
        ok: false,
        code: result.code,
      };
}
