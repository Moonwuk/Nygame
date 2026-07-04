import type { Action } from '@void/shared-core';
import {
  authorizeActionEnvelope,
  validateActionEnvelope,
  type ActionEnvelope,
  type ActionSession,
} from './envelope';
import { fail, ok, type ActionLayerFailure } from './errors';
import {
  createActionReceipt,
  InMemoryActionReceiptStore,
  type ActionReceipt,
  type ActionReceiptStore,
} from './receipts';
import { InMemorySequenceGate, type SequenceGate } from './sequence';

export interface ActionGateOptions {
  receipts?: ActionReceiptStore;
  sequences?: SequenceGate;
  now?: () => number;
  /** Per-action-type payload validator (SV-1.2), injected by the composition root (the
   *  game-specific schemas live in shared-core, the gate stays game-agnostic). Returns
   *  true if `payload` is well-formed for `type`; false rejects the action with a stable
   *  `E_BAD_PAYLOAD` BEFORE the reducer. A validator that returns false for unknown types
   *  makes only the intended actions submittable. Absent ⇒ payloads pass through as today. */
  payloadValidator?: (type: string, payload: unknown) => boolean;
}

export interface AcceptedAction {
  status: 'accepted';
  envelope: ActionEnvelope;
  action: Action;
}

export interface DuplicateAction {
  status: 'duplicate';
  envelope: ActionEnvelope;
  receipt: ActionReceipt;
}

export type ActionAdmission =
  | { ok: true; value: AcceptedAction | DuplicateAction }
  | ActionLayerFailure;

export class ActionGate {
  private readonly receipts: ActionReceiptStore;
  private readonly sequences: SequenceGate;
  private readonly now: () => number;
  private readonly payloadValidator?: (type: string, payload: unknown) => boolean;

  constructor(options: ActionGateOptions = {}) {
    this.receipts = options.receipts ?? new InMemoryActionReceiptStore();
    this.sequences = options.sequences ?? new InMemorySequenceGate();
    this.now = options.now ?? (() => Date.now());
    this.payloadValidator = options.payloadValidator;
  }

  admit(raw: unknown, session: ActionSession): ActionAdmission {
    const validated = validateActionEnvelope(raw);
    if (!validated.ok) return validated;

    // Per-type payload schema (SV-1.2): reject a structurally-valid envelope whose action
    // payload is malformed (or whose type is not client-submittable) before the reducer.
    if (
      this.payloadValidator &&
      !this.payloadValidator(validated.value.action.type, validated.value.action.payload)
    ) {
      return fail('E_BAD_PAYLOAD');
    }

    const authorized = authorizeActionEnvelope(validated.value, session);
    if (!authorized.ok) return authorized;

    const envelope = authorized.value;
    const cached = this.receipts.get(envelope.actionId);
    if (cached) return ok({ status: 'duplicate', envelope, receipt: cached });

    const reserved = this.sequences.checkAndReserve(
      { matchId: envelope.matchId, playerId: envelope.playerId, sessionId: envelope.sessionId },
      envelope.clientSeq,
    );
    if (!reserved.ok) return reserved;

    return ok({ status: 'accepted', envelope, action: envelope.action });
  }

  commit(
    envelope: ActionEnvelope,
    result: { ok: true } | { ok: false; code: string },
  ): ActionReceipt {
    const receipt = createActionReceipt(envelope, this.now(), result);
    this.receipts.put(receipt);
    return receipt;
  }

  /** Release the sequence reservation an `admit` made for `envelope`, so a backoff-retry
   *  of the same `clientSeq` is admitted again. Call this ONLY when an accepted action
   *  fails TRANSIENTLY before it commits (e.g. a durable write was unavailable) AND the
   *  admit→failure was serialized (no newer action reserved past it). No receipt is
   *  written, so the action stays undeduped and retriable. */
  rollback(envelope: ActionEnvelope): void {
    this.sequences.rollback(
      { matchId: envelope.matchId, playerId: envelope.playerId, sessionId: envelope.sessionId },
      envelope.clientSeq,
    );
  }
}
