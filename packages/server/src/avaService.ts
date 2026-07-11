import { randomUUID } from 'node:crypto';
import type { AvaChallenge, AvaChallengeStore, CorpStore, CorpSummary } from './store';
import type { CorpActor } from './corpService';

/**
 * AVA-2/3/4 — the Alliance-vs-Alliance readiness + challenge service (server/meta,
 * outside the deterministic core). Like `CorpService` it enforces the rights matrix
 * server-side on every write (invariant #4 / OWASP A01, fail-secure, stable codes),
 * and the storage layer guards the atomic invariants (influence never goes negative;
 * one pending challenge per pair; exactly-once challenge transitions).
 *
 *  - AVA-3 readiness: the HEAD flags the corp into the ready pool; a MEMBER flags their
 *    own standing consent to offline deployment (cleared automatically on leaving).
 *  - AVA-4 challenge (S0→S2): a ready corp's head challenges another ready corp —
 *    spending influence (AVA-2); the target's head accepts (→ S2 matchup) or declines
 *    (influence refunded); an unanswered challenge expires by timer (influence refunded).
 *
 * The expiry timer is the same injected-clock model as the offline scheduler: no live
 * client is required — `sweepExpired(now)` closes+refunds every due challenge, driven
 * by the host on an interval.
 */

export type AvaErrorCode =
  | 'E_FORBIDDEN'
  | 'E_NOT_READY'
  | 'E_SELF_CHALLENGE'
  | 'E_ALREADY_CHALLENGED'
  | 'E_INSUFFICIENT'
  | 'E_NO_CHALLENGE'
  | 'E_CHALLENGE_CLOSED';

export type AvaFail = { ok: false; code: AvaErrorCode };

/** Default challenge cost + expiry (tunable via deps; see open questions in the roadmap). */
const DEFAULT_CHALLENGE_COST = 100;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h real-time

export interface AvaServiceDeps {
  corpStore: CorpStore;
  challengeStore: AvaChallengeStore;
  /** Injectable clock (deterministic tests + the expiry sweep). */
  now?: () => number;
  challengeCost?: number;
  expiryMs?: number;
}

export class AvaService {
  private readonly corps: CorpStore;
  private readonly challenges: AvaChallengeStore;
  private readonly now: () => number;
  private readonly cost: number;
  private readonly expiryMs: number;

  constructor(deps: AvaServiceDeps) {
    this.corps = deps.corpStore;
    this.challenges = deps.challengeStore;
    this.now = deps.now ?? ((): number => Date.now());
    this.cost = deps.challengeCost ?? DEFAULT_CHALLENGE_COST;
    this.expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
  }

  // ---- AVA-3 · readiness -------------------------------------------------

  /** setCorpReady — the head puts their corp into the ready pool. */
  async setCorpReady(who: CorpActor): Promise<{ ok: true } | AvaFail> {
    const corpId = await this.headCorp(who);
    if (!corpId) return { ok: false, code: 'E_FORBIDDEN' };
    await this.corps.setCorpReady(corpId, this.now());
    await this.corps.appendAudit({
      corpId,
      at: this.now(),
      actor: who.accountId,
      action: 'ready',
      detail: 'corp+',
    });
    return { ok: true };
  }

  /** clearCorpReady — the head withdraws their corp from the pool. */
  async clearCorpReady(who: CorpActor): Promise<{ ok: true } | AvaFail> {
    const corpId = await this.headCorp(who);
    if (!corpId) return { ok: false, code: 'E_FORBIDDEN' };
    await this.corps.clearCorpReady(corpId);
    await this.corps.appendAudit({
      corpId,
      at: this.now(),
      actor: who.accountId,
      action: 'ready',
      detail: 'corp-',
    });
    return { ok: true };
  }

  /** setPlayerReady — any member consents to offline deployment in their own corp. */
  async setPlayerReady(who: CorpActor): Promise<{ ok: true } | AvaFail> {
    const row = await this.corps.membershipOf(who.accountId);
    if (!row || row.role === 'recruit') return { ok: false, code: 'E_FORBIDDEN' };
    await this.corps.setPlayerReady(who.accountId, row.corpId, this.now());
    return { ok: true };
  }

  /** clearPlayerReady — the member withdraws their consent. */
  async clearPlayerReady(who: CorpActor): Promise<{ ok: true } | AvaFail> {
    const row = await this.corps.membershipOf(who.accountId);
    if (!row || row.role === 'recruit') return { ok: false, code: 'E_FORBIDDEN' };
    await this.corps.clearPlayerReady(who.accountId);
    return { ok: true };
  }

  /** The ready pool — public within a session (corp name + influence + member count). */
  pool(): Promise<Array<CorpSummary & { readySince: number }>> {
    return this.corps.listReadyCorps();
  }

  // ---- AVA-4 · challenge (S0→S2) -----------------------------------------

  /** challengeCorp — the challenger's head spends influence to challenge a ready corp. */
  async challenge(
    who: CorpActor,
    targetCorpId: string,
  ): Promise<{ ok: true; id: string } | AvaFail> {
    const challengerCorp = await this.headCorp(who);
    if (!challengerCorp) return { ok: false, code: 'E_FORBIDDEN' };
    if (targetCorpId === challengerCorp) return { ok: false, code: 'E_SELF_CHALLENGE' };
    if (!(await this.corps.getCorp(targetCorpId))) return { ok: false, code: 'E_NO_CHALLENGE' };
    // Both corps must be in the ready pool (AVA-3 precondition).
    if (
      !(await this.corps.isCorpReady(challengerCorp)) ||
      !(await this.corps.isCorpReady(targetCorpId))
    ) {
      return { ok: false, code: 'E_NOT_READY' };
    }
    // Spend BEFORE creating the row (fail-secure: no unpaid challenge); refund if the
    // insert loses the one-pending-per-pair race.
    const spend = await this.corps.spendInfluence(challengerCorp, this.cost);
    if (!spend.ok) return { ok: false, code: 'E_INSUFFICIENT' };
    const at = this.now();
    const challenge: AvaChallenge = {
      id: randomUUID(),
      challengerCorp,
      targetCorp: targetCorpId,
      cost: this.cost,
      status: 'pending',
      createdAt: at,
      expiresAt: at + this.expiryMs,
    };
    const created = await this.challenges.createChallenge(challenge);
    if (!created.ok) {
      await this.corps.addInfluence(challengerCorp, this.cost); // undo the spend
      return { ok: false, code: 'E_ALREADY_CHALLENGED' };
    }
    await this.corps.appendAudit({
      corpId: challengerCorp,
      at,
      actor: who.accountId,
      action: 'influence',
      detail: `-${this.cost}: вызов ${targetCorpId}`,
    });
    return { ok: true, id: challenge.id };
  }

  /** acceptChallenge — the TARGET corp's head accepts → S2 matchup (influence stays spent). */
  async accept(who: CorpActor, challengeId: string): Promise<{ ok: true } | AvaFail> {
    const gate = await this.challengePartyGate(who, challengeId, 'target');
    if (!gate.ok) return gate;
    const closed = await this.challenges.closeChallenge(challengeId, 'accepted');
    if (!closed) return { ok: false, code: 'E_CHALLENGE_CLOSED' }; // lost the double-accept race
    await this.corps.appendAudit({
      corpId: gate.challenge.targetCorp,
      at: this.now(),
      actor: who.accountId,
      action: 'ready',
      detail: `accept ${gate.challenge.challengerCorp}`,
    });
    return { ok: true };
  }

  /** declineChallenge — the target's head declines → the challenger's influence is refunded. */
  async decline(who: CorpActor, challengeId: string): Promise<{ ok: true } | AvaFail> {
    const gate = await this.challengePartyGate(who, challengeId, 'target');
    if (!gate.ok) return gate;
    const closed = await this.challenges.closeChallenge(challengeId, 'declined');
    if (!closed) return { ok: false, code: 'E_CHALLENGE_CLOSED' };
    // Refund ONLY after we won the close race — closeChallenge returning true is the
    // exactly-once guarantee, so the challenger can't be refunded twice.
    await this.refund(gate.challenge);
    return { ok: true };
  }

  /** Expiry sweep — closes+refunds every due pending challenge. No client needed. */
  async sweepExpired(now = this.now()): Promise<number> {
    const due = await this.challenges.duePending(now);
    let closed = 0;
    for (const challenge of due) {
      if (await this.challenges.closeChallenge(challenge.id, 'expired')) {
        await this.refund(challenge);
        closed += 1;
      }
    }
    return closed;
  }

  /** The caller's incoming + outgoing challenges (as a party to either side). */
  async challengesFor(who: CorpActor): Promise<AvaChallenge[]> {
    const row = await this.corps.membershipOf(who.accountId);
    if (!row) return [];
    return this.challenges.challengesOf(row.corpId);
  }

  private async refund(challenge: AvaChallenge): Promise<void> {
    await this.corps.addInfluence(challenge.challengerCorp, challenge.cost);
    await this.corps.appendAudit({
      corpId: challenge.challengerCorp,
      at: this.now(),
      actor: 'system',
      action: 'influence',
      detail: `+${challenge.cost}: возврат`,
    });
  }

  /** corpId the actor is HEAD of, or null (fail-secure gate). */
  private async headCorp(who: CorpActor): Promise<string | null> {
    const row = await this.corps.membershipOf(who.accountId);
    return row?.role === 'head' ? row.corpId : null;
  }

  /** Gate a challenge action: the challenge exists, is still pending, and the actor is
   *  the head of the required party (`target` for accept/decline). */
  private async challengePartyGate(
    who: CorpActor,
    challengeId: string,
    side: 'challenger' | 'target',
  ): Promise<{ ok: true; challenge: AvaChallenge } | AvaFail> {
    const challenge = await this.challenges.getChallenge(challengeId);
    if (!challenge) return { ok: false, code: 'E_NO_CHALLENGE' };
    if (challenge.status !== 'pending') return { ok: false, code: 'E_CHALLENGE_CLOSED' };
    const corpId = side === 'target' ? challenge.targetCorp : challenge.challengerCorp;
    const headCorp = await this.headCorp(who);
    if (headCorp !== corpId) return { ok: false, code: 'E_FORBIDDEN' };
    return { ok: true, challenge };
  }
}
