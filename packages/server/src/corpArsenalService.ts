import type { ArsenalItem, PlayerArsenal } from '@void/shared-core';
import { arsenalSnapshotOf } from './arsenal';
import type { ArsenalStore, AvaChallengeStore, AvaRosterStore, CorpRentStore, CorpStore } from './store';

/**
 * ARS-6 — corp-warehouse rentals: a head/officer hands a corp-owned item to a
 * ROSTERED fighter for one AvA war, before the matchup locks. The corp never loses
 * ownership (no `ArsenalStore.transfer` — a corp-owned item is simply a row whose
 * `accountId` IS the corp's id, ARS-1..2's existing shape reused verbatim); this
 * service only tracks WHO currently has USE of it (`CorpRentStore`) and merges that
 * into the fighter's ARS-3 snapshot (`avaOrchestrator.corpRentalOf`) at launch.
 *
 * War end (`returnWar`) closes every active rental for the matchup exactly once —
 * the item is never "returned" as a data operation (it never left `corp_arsenal`),
 * only its wear ticks and the audit records the war (ARS-0.3: items ALWAYS return,
 * win or lose — no full-loot, no burn-on-loss; `durability--` is the only sink).
 */

export type CorpArsenalErrorCode =
  | 'E_FORBIDDEN'
  | 'E_NOT_CORP_ITEM'
  | 'E_NO_MATCHUP'
  | 'E_NOT_PARTY'
  | 'E_ROSTER_LOCKED'
  | 'E_NOT_ROSTERED'
  | 'E_ALREADY_RENTED';

export type CorpArsenalFail = { ok: false; code: CorpArsenalErrorCode };

/** The acting account, as resolved from the session (never from the payload) —
 *  the same shape `CorpActor`/`MedalService` already use. */
export interface CorpArsenalActor {
  accountId: string;
  login: string;
}

export interface CorpArsenalServiceDeps {
  corpStore: CorpStore;
  arsenalStore: ArsenalStore;
  rentStore: CorpRentStore;
  challengeStore: AvaChallengeStore;
  rosterStore: AvaRosterStore;
  now?: () => number;
}

export class CorpArsenalService {
  private readonly corps: CorpStore;
  private readonly arsenal: ArsenalStore;
  private readonly rentals: CorpRentStore;
  private readonly challenges: AvaChallengeStore;
  private readonly roster: AvaRosterStore;
  private readonly now: () => number;

  constructor(deps: CorpArsenalServiceDeps) {
    this.corps = deps.corpStore;
    this.arsenal = deps.arsenalStore;
    this.rentals = deps.rentStore;
    this.challenges = deps.challengeStore;
    this.roster = deps.rosterStore;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Hand a corp-owned item to a rostered fighter for one war. Head/officer only;
   *  the item must belong to the acting corp; the matchup must still be in its
   *  roster window (ACCEPTED, not yet LOCKED — "до лока"); the target must already
   *  be rostered on the corp's own side; the item must not already be on rent
   *  anywhere. Fail-secure: any check failing changes nothing. */
  async rentOut(
    who: CorpArsenalActor,
    corpId: string,
    itemId: string,
    matchupId: string,
    targetAccountId: string,
  ): Promise<{ ok: true } | CorpArsenalFail> {
    const actor = await this.corps.membershipOf(who.accountId);
    if (!actor || actor.corpId !== corpId || (actor.role !== 'head' && actor.role !== 'officer')) {
      return { ok: false, code: 'E_FORBIDDEN' };
    }
    const item = await this.arsenal.get(itemId);
    if (!item || item.accountId !== corpId) return { ok: false, code: 'E_NOT_CORP_ITEM' };
    const matchup = await this.challenges.getChallenge(matchupId);
    if (!matchup) return { ok: false, code: 'E_NO_MATCHUP' };
    const side =
      matchup.challengerCorp === corpId ? 'challenger' : matchup.targetCorp === corpId ? 'target' : null;
    if (!side) return { ok: false, code: 'E_NOT_PARTY' };
    if (matchup.status !== 'accepted') return { ok: false, code: 'E_ROSTER_LOCKED' };
    const roster = await this.roster.rosterOf(matchupId);
    const rostered = roster.some((r) => r.accountId === targetAccountId && r.side === side);
    if (!rostered) return { ok: false, code: 'E_NOT_ROSTERED' };
    const rented = await this.rentals.rent({
      itemId,
      corpId,
      matchupId,
      accountId: targetAccountId,
      rentedAt: this.now(),
    });
    if (!rented) return { ok: false, code: 'E_ALREADY_RENTED' };
    await this.corps.appendAudit({
      corpId,
      at: this.now(),
      actor: who.accountId,
      action: 'rent',
      target: targetAccountId,
      detail: itemId,
    });
    return { ok: true };
  }

  /** ARS-3 snapshot merge point: what THIS account has on rent for THIS matchup,
   *  in `PlayerArsenal` shape (union-ready with the personal snapshot). Empty when
   *  nothing's rented — the orchestrator then merges nothing. */
  async rentedArsenalOf(accountId: string, matchupId: string): Promise<PlayerArsenal> {
    const rows = await this.rentals.activeForAccount(matchupId, accountId);
    if (rows.length === 0) return { hulls: [], modules: [], fittings: [] };
    const items: ArsenalItem[] = [];
    for (const row of rows) {
      const item = await this.arsenal.get(row.itemId);
      if (item) items.push(item);
    }
    return arsenalSnapshotOf(items);
  }

  /** War end (ARS-0.3): every active rental for the matchup returns to the corp
   *  warehouse exactly once — win or lose, no burn-on-loss. Ticks `durability` as
   *  the soft sink and records one audit line per item. Safe to call on a matchup
   *  with no rentals (no-op) and safe to replay (each item closes at most once). */
  async returnWar(matchupId: string): Promise<number> {
    const rows = await this.rentals.activeForMatchup(matchupId);
    let returned = 0;
    for (const row of rows) {
      if (!(await this.rentals.closeRent(matchupId, row.itemId))) continue; // already closed (replay)
      await this.arsenal.wear(row.itemId, 1);
      await this.corps.appendAudit({
        corpId: row.corpId,
        at: this.now(),
        actor: 'system', // war-end sweep, no acting human (same convention as AvaService.refund)
        action: 'rent_return',
        target: row.accountId,
        detail: row.itemId,
      });
      returned += 1;
    }
    return returned;
  }
}
