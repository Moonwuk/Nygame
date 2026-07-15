import { randomUUID } from 'node:crypto';
import type {
  AvaChallenge,
  AvaChallengeStore,
  AvaFeedEntry,
  AvaFeedStore,
  AvaResult,
  AvaResultStore,
  AvaRosterEntry,
  AvaRosterStore,
  AvaSide,
  CorpMembership,
  CorpStore,
  CorpSummary,
} from './store';
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
  | 'E_CHALLENGE_CLOSED'
  | 'E_NOT_FLAGGED'
  | 'E_ROSTER_FULL'
  | 'E_ROSTER_LOCKED'
  | 'E_WINDOW_CLOSED'
  | 'E_MATCHUP_CLOSED';

export type AvaFail = { ok: false; code: AvaErrorCode };

/** What a party member sees of a matchup's roster (AVA-6). The OWN side's entries
 *  are listed; the opposing side is private — only its headcount shows. */
export interface AvaRosterView {
  matchupId: string;
  side: AvaSide;
  status: AvaChallenge['status'];
  pauseEndsAt?: number;
  /** The caller's own side, full rows. */
  mine: AvaRosterEntry[];
  /** Headcounts of both sides (the opponent's roster stays private). */
  counts: Record<AvaSide, number>;
}

/** Default challenge cost + expiry (tunable via deps; see open questions in the roadmap). */
const DEFAULT_CHALLENGE_COST = 100;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h real-time
/** Roster window (AVA-6, corporation-wars.md §2: пауза 1–2 дня) + side bounds. The cap
 *  becomes the map's slots-per-side once the orchestrator (AVA-7) picks the map. */
const DEFAULT_PAUSE_MS = 24 * 60 * 60 * 1000; // 24h real-time
const DEFAULT_CAP_PER_SIDE = 4;
const DEFAULT_MIN_PER_SIDE = 1;
/** Influence granted to the winning corp on settlement (AVA-8 S7). Balance constant —
 *  tunable via deps like the challenge cost (see open questions in the roadmap). */
const DEFAULT_WIN_REWARD = 150;

export interface AvaServiceDeps {
  corpStore: CorpStore;
  challengeStore: AvaChallengeStore;
  /** Roster rows (AVA-6). */
  rosterStore: AvaRosterStore;
  /** Recorded outcomes (AVA-8, MM-3.1). */
  resultStore: AvaResultStore;
  /** The public feed (AVA-9) — confirmed matchups + results, no private data. */
  feedStore: AvaFeedStore;
  /** Injectable clock (deterministic tests + the expiry sweep). */
  now?: () => number;
  challengeCost?: number;
  expiryMs?: number;
  /** Roster window length, stamped on accept (AVA-6). */
  pauseMs?: number;
  /** Per-side roster cap (map slots-per-side once AVA-7 picks the map). */
  capPerSide?: number;
  /** Minimum fighters per side at lock time — a shorter side cancels the matchup. */
  minPerSide?: number;
  /** Influence awarded to the winning corp on settlement (AVA-8 S7). */
  winReward?: number;
}

export class AvaService {
  private readonly corps: CorpStore;
  private readonly challenges: AvaChallengeStore;
  private readonly roster: AvaRosterStore;
  private readonly results: AvaResultStore;
  private readonly feed: AvaFeedStore;
  private readonly now: () => number;
  private readonly cost: number;
  private readonly expiryMs: number;
  private readonly pauseMs: number;
  private readonly capPerSide: number;
  private readonly minPerSide: number;
  private readonly winReward: number;

  constructor(deps: AvaServiceDeps) {
    this.corps = deps.corpStore;
    this.challenges = deps.challengeStore;
    this.roster = deps.rosterStore;
    this.results = deps.resultStore;
    this.feed = deps.feedStore;
    this.now = deps.now ?? ((): number => Date.now());
    this.cost = deps.challengeCost ?? DEFAULT_CHALLENGE_COST;
    this.expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
    this.pauseMs = deps.pauseMs ?? DEFAULT_PAUSE_MS;
    this.capPerSide = deps.capPerSide ?? DEFAULT_CAP_PER_SIDE;
    this.minPerSide = deps.minPerSide ?? DEFAULT_MIN_PER_SIDE;
    this.winReward = deps.winReward ?? DEFAULT_WIN_REWARD;
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
    // insert loses the one-pending-per-pair race. KNOWN WINDOW: spend and create are
    // two separate stores — a process crash between them loses the influence (the
    // compensation below only covers the lost race). Tolerated for now: the window is
    // one await wide and the loss is bounded by `cost`; closing it needs a shared
    // store transaction (both Postgres adapters share one Pool) or a sweep-side audit.
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

  /** acceptChallenge — the TARGET corp's head accepts → S2 matchup (influence stays spent).
   *  Accept also OPENS the roster window (AVA-6): S3 starts the moment S2 exists. */
  async accept(who: CorpActor, challengeId: string): Promise<{ ok: true } | AvaFail> {
    const gate = await this.challengePartyGate(who, challengeId, 'target');
    if (!gate.ok) return gate;
    const closed = await this.challenges.closeChallenge(challengeId, 'accepted');
    if (!closed) return { ok: false, code: 'E_CHALLENGE_CLOSED' }; // lost the double-accept race
    await this.challenges.openRosterWindow(challengeId, this.now() + this.pauseMs);
    await this.corps.appendAudit({
      corpId: gate.challenge.targetCorp,
      at: this.now(),
      actor: who.accountId,
      action: 'ready',
      detail: `accept ${gate.challenge.challengerCorp}`,
    });
    // AVA-9: the public feed row goes LAST and best-effort — the accept already
    // committed (closeChallenge won the race); a feed hiccup must not fail it.
    await this.publishFeed('matchup', gate.challenge).catch(() => undefined);
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

  // ---- AVA-6 · roster window (S3) -----------------------------------------

  /** setRoster — the head/officer curates their side's list wholesale: only accounts
   *  from the corp's FLAGGED pool (AVA-3 player consent), at most `capPerSide`. */
  async setRoster(
    who: CorpActor,
    matchupId: string,
    accountIds: string[],
  ): Promise<{ ok: true } | AvaFail> {
    const gate = await this.rosterWindowGate(who, matchupId, ['head', 'officer']);
    if (!gate.ok) return gate;
    const distinct = [...new Set(accountIds)];
    if (distinct.length > this.capPerSide) return { ok: false, code: 'E_ROSTER_FULL' };
    const flagged = new Set(await this.corps.readyPlayersOf(gate.corpId));
    if (distinct.some((id) => !flagged.has(id))) return { ok: false, code: 'E_NOT_FLAGGED' };
    const at = this.now();
    await this.roster.replaceSide(
      matchupId,
      gate.side,
      distinct.map(
        (accountId): AvaRosterEntry => ({
          matchupId,
          accountId,
          side: gate.side,
          source: 'flagged',
          at,
        }),
      ),
    );
    return { ok: true };
  }

  /** join — a member self-enrolls onto their corp's side during the pause window
   *  (an UNFLAGGED member may join too — showing up in person IS the consent).
   *  Idempotent: already rostered = the desired state. */
  async join(who: CorpActor, matchupId: string): Promise<{ ok: true } | AvaFail> {
    const gate = await this.rosterWindowGate(who, matchupId, ['head', 'officer', 'member']);
    if (!gate.ok) return gate;
    const added = await this.roster.addEntry(
      {
        matchupId,
        accountId: who.accountId,
        side: gate.side,
        source: 'self',
        at: this.now(),
      },
      this.capPerSide,
    );
    if (!added.ok && added.code === 'E_ROSTER_FULL') return { ok: false, code: 'E_ROSTER_FULL' };
    return { ok: true }; // inserted, or already on the roster — both are the desired state
  }

  /** The caller's view of a matchup roster: own side listed, the opponent's private
   *  (headcount only) — corporation-wars.md: чужой ростер до боя не раскрывается. */
  async rosterView(who: CorpActor, matchupId: string): Promise<AvaRosterView | AvaFail> {
    const gate = await this.partyGate(who, matchupId);
    if (!gate.ok) return gate;
    if (gate.membership.role === 'recruit') return { ok: false, code: 'E_FORBIDDEN' };
    const { matchup, side } = gate;
    const rows = await this.roster.rosterOf(matchupId);
    return {
      matchupId,
      side,
      status: matchup.status,
      ...(matchup.pauseEndsAt === undefined ? {} : { pauseEndsAt: matchup.pauseEndsAt }),
      mine: rows.filter((row) => row.side === side),
      counts: countsBySide(rows),
    };
  }

  /** Roster sweep — at each due window: both sides at `minPerSide` → LOCK the roster
   *  (the orchestrator's S4 input, GDD §2 консервация); a short side → CANCEL the
   *  matchup and refund the challenge cost (AVA-4 refund, exactly-once via the
   *  conditional close). No client needed — the host drives it on an interval. */
  async sweepRosters(now = this.now()): Promise<{ locked: number; cancelled: number }> {
    const due = await this.challenges.dueRosters(now);
    let locked = 0;
    let cancelled = 0;
    for (const matchup of due) {
      const rows = await this.roster.rosterOf(matchup.id);
      const counts = countsBySide(rows);
      const full = counts.challenger >= this.minPerSide && counts.target >= this.minPerSide;
      if (!(await this.challenges.closeMatchup(matchup.id, full ? 'locked' : 'cancelled'))) {
        continue; // lost the transition race — another sweep already resolved it
      }
      if (full) {
        locked += 1;
      } else {
        cancelled += 1;
        await this.refund(matchup);
        await this.corps.appendAudit({
          corpId: matchup.challengerCorp,
          at: this.now(),
          actor: 'system',
          action: 'ready',
          detail: `cancel ${matchup.id}: недобор ростера`,
        });
      }
    }
    return { locked, cancelled };
  }

  // ---- AVA-8 · settlement (S7) --------------------------------------------

  /** settleMatch — the orchestrator calls this once a LOCKED matchup's war has ended:
   *  archive it (locked→ended), record the outcome (MM-3.1 history), and award influence
   *  to the winning corp (AVA-2). The atomic locked→ended transition is the exactly-once
   *  gate — a replayed `match.ended` loses the race and no-ops, so influence is never
   *  awarded twice. `winnerSide` is null for a draw (result recorded, no influence).
   *  Server-driven (past the action gate) like the expiry/roster sweeps — no client. */
  async settleMatch(
    matchupId: string,
    winnerSide: AvaSide | null,
  ): Promise<{ ok: true; winnerCorp: string | null } | AvaFail> {
    const matchup = await this.challenges.getChallenge(matchupId);
    if (!matchup) return { ok: false, code: 'E_NO_CHALLENGE' };
    // Only a LOCKED matchup ran a real session; winning this transition is the
    // exactly-once guard for the influence award below.
    if (!(await this.challenges.endMatchup(matchupId))) {
      return { ok: false, code: 'E_MATCHUP_CLOSED' };
    }
    const winnerCorp =
      winnerSide === null
        ? null
        : winnerSide === 'challenger'
          ? matchup.challengerCorp
          : matchup.targetCorp;
    const at = this.now();
    await this.results.record({
      matchupId,
      challengerCorp: matchup.challengerCorp,
      targetCorp: matchup.targetCorp,
      winnerCorp,
      at,
    });
    if (winnerCorp !== null) {
      await this.corps.addInfluence(winnerCorp, this.winReward);
      await this.corps.appendAudit({
        corpId: winnerCorp,
        at,
        actor: 'system',
        action: 'influence',
        detail: `+${this.winReward}: победа ${matchupId}`,
      });
    }
    // AVA-9: the public feed row goes LAST and best-effort — the settlement already
    // committed (endMatchup is the exactly-once gate); a feed hiccup must not fail it.
    await this.publishFeed('result', matchup, winnerCorp).catch(() => undefined);
    return { ok: true, winnerCorp };
  }

  /** Match history (AVA-8, MM-3.1 minimum) — recorded outcomes, newest first. The
   *  foundation the public feed (AVA-9), medal conditions and rating read from. */
  matchHistory(limit?: number): Promise<AvaResult[]> {
    return this.results.recent(limit);
  }

  // ---- AVA-9 · public feed -------------------------------------------------

  /** The public AvA feed (AVA-9): confirmed matchups + results, newest first, paginated
   *  by a `before`-`at` cursor. Public facts only — the store never holds a roster. */
  publicFeed(limit?: number, before?: number): Promise<AvaFeedEntry[]> {
    return this.feed.recent(limit, before);
  }

  /** Append a public feed row for a matchup/result, snapshotting the two corp names so
   *  the feed reads standalone (a later rename or disband doesn't rewrite history). */
  private async publishFeed(
    kind: AvaFeedEntry['kind'],
    matchup: AvaChallenge,
    winnerCorp: string | null = null,
  ): Promise<void> {
    const [challenger, target] = await Promise.all([
      this.corps.getCorp(matchup.challengerCorp),
      this.corps.getCorp(matchup.targetCorp),
    ]);
    await this.feed.append({
      id: randomUUID(),
      at: this.now(),
      kind,
      challengerCorp: matchup.challengerCorp,
      challengerName: challenger?.name ?? matchup.challengerCorp,
      targetCorp: matchup.targetCorp,
      targetName: target?.name ?? matchup.targetCorp,
      ...(kind === 'result' ? { winnerCorp } : {}),
    });
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

  /** Gate a roster write (AVA-6): the matchup exists; the actor holds one of `roles`
   *  in a PARTY corp; the roster is not locked/cancelled; the pause window is open.
   *  Fail-secure ordering: identity → phase → window (stable codes at each step). */
  /** The identity slice every matchup read shares: the matchup exists and the
   *  caller's corp is a PARTY to it. Role/phase/window gates are the caller's. */
  private async partyGate(
    who: CorpActor,
    matchupId: string,
  ): Promise<
    { ok: true; matchup: AvaChallenge; membership: CorpMembership; side: AvaSide } | AvaFail
  > {
    const matchup = await this.challenges.getChallenge(matchupId);
    if (!matchup) return { ok: false, code: 'E_NO_CHALLENGE' };
    const membership = await this.corps.membershipOf(who.accountId);
    const side = membership ? sideOf(matchup, membership.corpId) : null;
    if (!membership || !side) return { ok: false, code: 'E_FORBIDDEN' };
    return { ok: true, matchup, membership, side };
  }

  private async rosterWindowGate(
    who: CorpActor,
    matchupId: string,
    roles: ReadonlyArray<'head' | 'officer' | 'member'>,
  ): Promise<{ ok: true; corpId: string; side: AvaSide } | AvaFail> {
    const gate = await this.partyGate(who, matchupId);
    if (!gate.ok) return gate;
    const { matchup, membership, side } = gate;
    if (!(roles as readonly string[]).includes(membership.role)) {
      return { ok: false, code: 'E_FORBIDDEN' };
    }
    if (matchup.status === 'locked') return { ok: false, code: 'E_ROSTER_LOCKED' };
    // Any other non-accepted status (pending / declined / expired / cancelled) has no
    // roster phase; an accepted row WITHOUT a stamped window (pre-AVA-6 data) or with
    // the deadline passed is a closed window — fail-secure.
    if (
      matchup.status !== 'accepted' ||
      matchup.pauseEndsAt === undefined ||
      this.now() >= matchup.pauseEndsAt
    ) {
      return { ok: false, code: 'E_WINDOW_CLOSED' };
    }
    return { ok: true, corpId: membership.corpId, side };
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

/** Which side of a matchup a corp fights for, or null when it is not a party. */
/** Per-side headcount of a roster — the same tally the view and the sweep read. */
function countsBySide(rows: readonly AvaRosterEntry[]): Record<AvaSide, number> {
  const counts: Record<AvaSide, number> = { challenger: 0, target: 0 };
  for (const row of rows) counts[row.side] += 1;
  return counts;
}

function sideOf(matchup: AvaChallenge, corpId: string): AvaSide | null {
  if (corpId === matchup.challengerCorp) return 'challenger';
  if (corpId === matchup.targetCorp) return 'target';
  return null;
}
