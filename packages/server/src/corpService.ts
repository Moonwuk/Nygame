import type { CorpMembership, CorpRecord, CorpRole, CorpStore, CorpSummary } from './store';

/**
 * CORP-0 — the corporation service: membership + the fixed RBAC from
 * docs/corporations.md §2, enforced server-side on EVERY sensitive action
 * (invariant #4 / OWASP A01, fail-secure with stable codes only).
 *
 * The rules, verbatim from the rights matrix:
 *  - exactly one Глава (head); the head cannot be kicked, by anyone;
 *  - an officer accepts/declines applicants and kicks members/recruits ONLY —
 *    never the head or another officer, and never changes roles (no escalation);
 *  - only the head assigns roles (officer/member), transfers headship, disbands;
 *  - the head leaves only after transferring headship — except when alone, where
 *    leaving IS the disband;
 *  - a `recruit` row is the pending application: accept → member, decline/cancel →
 *    removed. One corp per account (recruits included) is a store-level invariant.
 *
 * Deferred (documented, not speculative): medals (needs match history, MM-3.1) and
 * the account-level gate on createCorp (needs server-side XP/levels, AC-0.3).
 */

export type CorpErrorCode =
  | 'E_BAD_NAME'
  | 'E_BAD_ROLE'
  | 'E_BAD_TARGET'
  | 'E_NO_CORP'
  | 'E_NAME_TAKEN'
  | 'E_IN_CORP'
  | 'E_NOT_MEMBER'
  | 'E_NOT_APPLIED'
  | 'E_FORBIDDEN'
  | 'E_HEAD_MUST_TRANSFER';

export type CorpFail = { ok: false; code: CorpErrorCode };

/** The acting account, as resolved from the session (never from the payload). */
export interface CorpActor {
  accountId: string;
  login: string;
}

/** Corp names: 3–24 chars — unicode letters/digits/underscore, single tokens joined
 *  by spaces or hyphens; must start and end on a word character. */
const NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]{1,22}[\p{L}\p{N}_]$/u;

export interface CorpServiceDeps {
  store: CorpStore;
  /** Injectable clock for the audit trail (deterministic tests). */
  now?: () => number;
}

export class CorpService {
  private readonly store: CorpStore;
  private readonly now: () => number;

  constructor(deps: CorpServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** createCorp — the founder becomes the head. */
  async create(who: CorpActor, name: string): Promise<{ ok: true; corpId: string } | CorpFail> {
    const trimmed = name.trim();
    if (!NAME_RE.test(trimmed)) return { ok: false, code: 'E_BAD_NAME' };
    const created = await this.store.createCorp(trimmed, who.accountId, who.login);
    if (!created.ok) return created;
    await this.audit(created.corpId, who, 'create', undefined, trimmed);
    return created;
  }

  /** applyToCorp — creates the recruit row (the pending application). */
  async apply(who: CorpActor, corpId: string): Promise<{ ok: true } | CorpFail> {
    if (!(await this.store.getCorp(corpId))) return { ok: false, code: 'E_NO_CORP' };
    return this.store.addMember(corpId, who.accountId, who.login, 'recruit');
  }

  /** cancelApplication — the applicant withdraws their own recruit row. */
  async cancel(who: CorpActor, corpId: string): Promise<{ ok: true } | CorpFail> {
    const mine = await this.store.membershipOf(who.accountId);
    if (!mine || mine.corpId !== corpId || mine.role !== 'recruit') {
      return { ok: false, code: 'E_NOT_APPLIED' };
    }
    await this.store.removeMember(corpId, who.accountId);
    return { ok: true };
  }

  /** acceptApplicant — head/officer promotes a recruit to member. */
  async accept(who: CorpActor, corpId: string, target: string): Promise<{ ok: true } | CorpFail> {
    const gate = await this.officerGate(who, corpId);
    if (gate) return gate;
    const row = await this.store.membershipOf(target);
    if (!row || row.corpId !== corpId || row.role !== 'recruit') {
      return { ok: false, code: 'E_NOT_APPLIED' };
    }
    await this.store.setRole(corpId, target, 'member');
    await this.audit(corpId, who, 'accept', target);
    return { ok: true };
  }

  /** declineApplicant — head/officer removes a recruit row. */
  async decline(who: CorpActor, corpId: string, target: string): Promise<{ ok: true } | CorpFail> {
    const gate = await this.officerGate(who, corpId);
    if (gate) return gate;
    const row = await this.store.membershipOf(target);
    if (!row || row.corpId !== corpId || row.role !== 'recruit') {
      return { ok: false, code: 'E_NOT_APPLIED' };
    }
    await this.store.removeMember(corpId, target);
    await this.audit(corpId, who, 'decline', target);
    return { ok: true };
  }

  /** kickMember — head: anyone but themself; officer: members/recruits only. */
  async kick(who: CorpActor, corpId: string, target: string): Promise<{ ok: true } | CorpFail> {
    const actor = await this.memberIn(who, corpId);
    if (!actor || (actor.role !== 'head' && actor.role !== 'officer')) {
      return { ok: false, code: 'E_FORBIDDEN' };
    }
    if (target === who.accountId) return { ok: false, code: 'E_FORBIDDEN' }; // kick ≠ leave
    const row = await this.store.membershipOf(target);
    if (!row || row.corpId !== corpId) return { ok: false, code: 'E_NOT_MEMBER' };
    if (row.role === 'head') return { ok: false, code: 'E_FORBIDDEN' }; // the head is unkickable
    if (actor.role === 'officer' && row.role === 'officer') {
      return { ok: false, code: 'E_FORBIDDEN' }; // officers don't outrank each other
    }
    await this.store.removeMember(corpId, target);
    await this.audit(corpId, who, 'kick', target);
    return { ok: true };
  }

  /** setMemberRole — head only, and only between member ⇄ officer. Headship moves
   *  via `transfer`, recruits via `accept` — this can neither mint a second head
   *  nor demote anyone back to an application. */
  async setRole(
    who: CorpActor,
    corpId: string,
    target: string,
    role: string,
  ): Promise<{ ok: true } | CorpFail> {
    const gate = await this.headGate(who, corpId);
    if (gate) return gate;
    if (role !== 'officer' && role !== 'member') return { ok: false, code: 'E_BAD_ROLE' };
    if (target === who.accountId) return { ok: false, code: 'E_FORBIDDEN' }; // the head's own role moves via transfer
    const row = await this.store.membershipOf(target);
    if (!row || row.corpId !== corpId || (row.role !== 'member' && row.role !== 'officer')) {
      return { ok: false, code: 'E_NOT_MEMBER' };
    }
    await this.store.setRole(corpId, target, role);
    await this.audit(corpId, who, 'role', target, role);
    return { ok: true };
  }

  /** transferHeadship — head → an accepted member/officer; the ex-head stays as
   *  an officer. */
  async transfer(who: CorpActor, corpId: string, target: string): Promise<{ ok: true } | CorpFail> {
    const gate = await this.headGate(who, corpId);
    if (gate) return gate;
    if (target === who.accountId) return { ok: false, code: 'E_FORBIDDEN' };
    const row = await this.store.membershipOf(target);
    if (!row || row.corpId !== corpId || (row.role !== 'member' && row.role !== 'officer')) {
      return { ok: false, code: 'E_NOT_MEMBER' };
    }
    await this.store.swapHead(corpId, who.accountId, target);
    await this.audit(corpId, who, 'transfer', target);
    return { ok: true };
  }

  /** leaveCorp — anyone; the head only once alone (then leaving disbands the corp),
   *  otherwise headship must be transferred first. */
  async leave(who: CorpActor, corpId: string): Promise<{ ok: true } | CorpFail> {
    const mine = await this.memberIn(who, corpId);
    if (!mine) return { ok: false, code: 'E_NOT_MEMBER' };
    if (mine.role === 'head') {
      const rows = await this.store.membersOf(corpId);
      if (rows.length > 1) return { ok: false, code: 'E_HEAD_MUST_TRANSFER' };
      await this.store.removeCorp(corpId);
      await this.audit(corpId, who, 'disband');
      return { ok: true };
    }
    await this.store.removeMember(corpId, who.accountId);
    await this.audit(corpId, who, 'leave');
    return { ok: true };
  }

  /** disband — head only; releases every member (audit history survives). */
  async disband(who: CorpActor, corpId: string): Promise<{ ok: true } | CorpFail> {
    const gate = await this.headGate(who, corpId);
    if (gate) return gate;
    await this.store.removeCorp(corpId);
    await this.audit(corpId, who, 'disband');
    return { ok: true };
  }

  /** The browse list — public within a session. */
  list(): Promise<CorpSummary[]> {
    return this.store.listCorps();
  }

  /** One corp with its member list, roles ranked head → officers → members →
   *  recruits (ties by login). */
  async detail(
    corpId: string,
  ): Promise<{ ok: true; corp: CorpRecord; members: CorpMembership[] } | CorpFail> {
    const corp = await this.store.getCorp(corpId);
    if (!corp) return { ok: false, code: 'E_NO_CORP' };
    const rank: Record<CorpRole, number> = { head: 0, officer: 1, member: 2, recruit: 3 };
    const members = (await this.store.membersOf(corpId)).sort(
      (a, b) => rank[a.role] - rank[b.role] || a.login.localeCompare(b.login),
    );
    return { ok: true, corp, members };
  }

  /** The caller's own membership (any role), with the corp record — or nulls. */
  async mine(
    who: CorpActor,
  ): Promise<{ corp: CorpRecord | null; membership: CorpMembership | null }> {
    const membership = await this.store.membershipOf(who.accountId);
    if (!membership) return { corp: null, membership: null };
    return { corp: await this.store.getCorp(membership.corpId), membership };
  }

  /** The audit trail — visible to the corp's head/officers only. */
  async auditLog(
    who: CorpActor,
    corpId: string,
  ): Promise<{ ok: true; audit: Awaited<ReturnType<CorpStore['auditOf']>> } | CorpFail> {
    const gate = await this.officerGate(who, corpId);
    if (gate) return gate;
    return { ok: true, audit: await this.store.auditOf(corpId) };
  }

  /** Accounts flagged ready (AVA-3 consent) in this corp — visible to head/officers
   *  only, since it's the exact eligibility set `AvaService.setRoster` curates from. */
  async readyPlayers(
    who: CorpActor,
    corpId: string,
  ): Promise<{ ok: true; accountIds: string[] } | CorpFail> {
    const gate = await this.officerGate(who, corpId);
    if (gate) return gate;
    return { ok: true, accountIds: await this.store.readyPlayersOf(corpId) };
  }

  private async memberIn(who: CorpActor, corpId: string): Promise<CorpMembership | null> {
    const row = await this.store.membershipOf(who.accountId);
    return row && row.corpId === corpId ? row : null;
  }

  /** Fail-secure gate: null when the actor is the corp's head, a CorpFail otherwise. */
  private async headGate(who: CorpActor, corpId: string): Promise<CorpFail | null> {
    const row = await this.memberIn(who, corpId);
    return row?.role === 'head' ? null : { ok: false, code: 'E_FORBIDDEN' };
  }

  /** Fail-secure gate: null when the actor is the corp's head or an officer. */
  private async officerGate(who: CorpActor, corpId: string): Promise<CorpFail | null> {
    const row = await this.memberIn(who, corpId);
    return row?.role === 'head' || row?.role === 'officer'
      ? null
      : { ok: false, code: 'E_FORBIDDEN' };
  }

  private audit(
    corpId: string,
    who: CorpActor,
    action: 'create' | 'accept' | 'decline' | 'kick' | 'role' | 'transfer' | 'leave' | 'disband',
    target?: string,
    detail?: string,
  ): Promise<void> {
    return this.store.appendAudit({
      corpId,
      at: this.now(),
      actor: who.accountId,
      action,
      ...(target !== undefined ? { target } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}
