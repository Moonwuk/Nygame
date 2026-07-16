import type { AvaResultStore, CorpStore, Medal, MedalStore } from './store';
import type { CorpActor } from './corpService';
import type { MedalCatalog, MedalDef } from './medalCatalog';

/**
 * Medals / achievements (corporations.md §3) — server/meta, outside the deterministic core.
 * The catalog is fixed data; conditions are OBJECTIVE and checked server-side from the AvA
 * match history (`AvaResultStore`), never self-reported by a client. MVP implements the
 * **corp medal** path: `scope:corp` + `grant:manual` — the server marks a corp ELIGIBLE by
 * condition, a head/officer hands the medal to a member (an act of recognition), and the
 * server re-checks eligibility at grant time (a non-eligible medal can't be gifted). Grants
 * are idempotent and permanent (no revoke in MVP).
 *
 * Deferred (needs a per-account participation ledger, not just corp-level results):
 * `scope:account` + `grant:auto` achievements and per-account conditions like
 * `ava_matches_for_corp`. See the roadmap.
 */

export type MedalErrorCode = 'E_NO_MEDAL' | 'E_NOT_MANUAL' | 'E_FORBIDDEN' | 'E_NOT_MEMBER' | 'E_NOT_ELIGIBLE';
export type MedalFail = { ok: false; code: MedalErrorCode };

export interface MedalServiceDeps {
  corpStore: CorpStore;
  /** AvA match history — the objective source medal conditions are checked against. */
  resultStore: AvaResultStore;
  medalStore: MedalStore;
  /** The validated medal catalog (`data/medals.json`). */
  catalog: MedalCatalog;
  now?: () => number;
}

export class MedalService {
  private readonly corps: CorpStore;
  private readonly results: AvaResultStore;
  private readonly medals: MedalStore;
  private readonly catalog: MedalCatalog;
  private readonly now: () => number;

  constructor(deps: MedalServiceDeps) {
    this.corps = deps.corpStore;
    this.results = deps.resultStore;
    this.medals = deps.medalStore;
    this.catalog = deps.catalog;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** The public catalog (client shows names/conditions). */
  catalogList(): MedalDef[] {
    return Object.values(this.catalog);
  }

  /** grantMedal — a head/officer awards a MANUAL medal to a member of their own corp. The
   *  server re-checks the corp's eligibility (a non-eligible medal can't be gifted) and the
   *  grant is idempotent (`awarded:false` = the member already held it). */
  async grant(
    who: CorpActor,
    targetAccountId: string,
    medalId: string,
  ): Promise<{ ok: true; awarded: boolean } | MedalFail> {
    const def = this.catalog[medalId];
    if (!def) return { ok: false, code: 'E_NO_MEDAL' };
    if (def.grant !== 'manual') return { ok: false, code: 'E_NOT_MANUAL' }; // auto medals aren't hand-granted
    const actor = await this.corps.membershipOf(who.accountId);
    if (!actor || (actor.role !== 'head' && actor.role !== 'officer')) {
      return { ok: false, code: 'E_FORBIDDEN' };
    }
    const target = await this.corps.membershipOf(targetAccountId);
    if (!target || target.corpId !== actor.corpId || target.role === 'recruit') {
      return { ok: false, code: 'E_NOT_MEMBER' }; // award only to a real member of your corp
    }
    if (!(await this.isEligible(actor.corpId, def))) return { ok: false, code: 'E_NOT_ELIGIBLE' };
    const at = this.now();
    const awarded = await this.medals.grant({
      accountId: targetAccountId,
      medalId,
      corpId: actor.corpId,
      at,
    });
    if (awarded) {
      await this.corps.appendAudit({
        corpId: actor.corpId,
        at,
        actor: who.accountId,
        action: 'medal',
        target: targetAccountId,
        detail: medalId,
      });
    }
    return { ok: true, awarded };
  }

  /** An account's earned medals (permanent history), newest first. */
  medalsOf(accountId: string): Promise<Medal[]> {
    return this.medals.medalsOf(accountId);
  }

  /** Which catalog medals the caller's corp currently satisfies the condition for — the
   *  grant candidates a head/officer sees. Empty (not an error) when the caller is in no
   *  corp. Manual corp medals only in MVP. */
  async eligibleMedals(who: CorpActor): Promise<string[]> {
    const actor = await this.corps.membershipOf(who.accountId);
    if (!actor) return [];
    const eligible: string[] = [];
    for (const def of Object.values(this.catalog)) {
      if (def.grant === 'manual' && (await this.isEligible(actor.corpId, def))) eligible.push(def.id);
    }
    return eligible;
  }

  /** Evaluate an objective condition against the corp's AvA record (server-authority). */
  private async isEligible(corpId: string, def: MedalDef): Promise<boolean> {
    const stats = await this.results.statsForCorp(corpId);
    switch (def.condition.type) {
      case 'corp_wins':
        return stats.wins >= def.condition.count;
      case 'corp_matches':
        return stats.matches >= def.condition.count;
    }
  }
}
