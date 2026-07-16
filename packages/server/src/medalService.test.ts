import { describe, expect, it } from 'vitest';
import { MedalService } from './medalService';
import { CorpService, type CorpActor } from './corpService';
import { parseMedalCatalog } from './medalCatalog';
import { MemoryAvaResultStore, MemoryCorpStore, MemoryMedalStore } from './store';

// Medals (corporations.md §3): a head/officer grants a MANUAL corp medal to a member; the
// server re-checks the corp's objective eligibility from the AvA match history, refuses a
// non-eligible or auto medal, and the grant is idempotent + audited.

const HEAD: CorpActor = { accountId: 'head', login: 'head' };
const OFFICER: CorpActor = { accountId: 'off', login: 'off' };
const MEMBER: CorpActor = { accountId: 'mem', login: 'mem' };
const RECRUIT: CorpActor = { accountId: 'rec', login: 'rec' };
const OUTSIDER: CorpActor = { accountId: 'out', login: 'out' };

const catalog = parseMedalCatalog({
  medals: {
    first_win: { name: 'First', description: 'd', scope: 'corp', grant: 'manual', condition: { type: 'corp_wins', count: 1 } },
    champion: { name: 'Champ', description: 'd', scope: 'corp', grant: 'manual', condition: { type: 'corp_wins', count: 5 } },
    auto_badge: { name: 'Auto', description: 'd', scope: 'account', grant: 'auto', condition: { type: 'corp_matches', count: 1 } },
  },
});

interface Fixture {
  medals: MedalService;
  results: MemoryAvaResultStore;
  store: MemoryCorpStore;
  corpA: string;
  corpB: string;
}

async function fixture(): Promise<Fixture> {
  const store = new MemoryCorpStore();
  const results = new MemoryAvaResultStore();
  let t = 0;
  const now = (): number => ++t;
  const corp = new CorpService({ store, now });
  const a = await corp.create(HEAD, 'Alliance A');
  const b = await corp.create(OUTSIDER, 'Alliance B'); // OUTSIDER heads B — corpless w.r.t. A
  if (!a.ok || !b.ok) throw new Error('fixture');
  for (const who of [OFFICER, MEMBER, RECRUIT]) await corp.apply(who, a.corpId);
  await corp.accept(HEAD, a.corpId, OFFICER.accountId);
  await corp.accept(HEAD, a.corpId, MEMBER.accountId);
  await corp.setRole(HEAD, a.corpId, OFFICER.accountId, 'officer');
  // RECRUIT stays an applicant (never accepted).
  const medals = new MedalService({ corpStore: store, resultStore: results, medalStore: new MemoryMedalStore(), catalog, now });
  return { medals, results, store, corpA: a.corpId, corpB: b.corpId };
}

/** Give corp `winner` `n` recorded AvA wins. */
async function recordWins(f: Fixture, winner: string, other: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await f.results.record({ matchupId: `mu-${winner}-${i}`, challengerCorp: winner, targetCorp: other, winnerCorp: winner, at: i + 1 });
  }
}

describe('MedalService — manual corp medals (AVA / corporations.md §3)', () => {
  it('grants an eligible medal head→member: idempotent, audited, and readable', async () => {
    const f = await fixture();
    // not eligible yet (0 wins)
    expect(await f.medals.grant(HEAD, MEMBER.accountId, 'first_win')).toEqual({ ok: false, code: 'E_NOT_ELIGIBLE' });
    await recordWins(f, f.corpA, f.corpB, 1);
    // now eligible → granted
    expect(await f.medals.grant(HEAD, MEMBER.accountId, 'first_win')).toEqual({ ok: true, awarded: true });
    // idempotent — a second grant is a no-op award
    expect(await f.medals.grant(HEAD, MEMBER.accountId, 'first_win')).toEqual({ ok: true, awarded: false });
    const mine = await f.medals.medalsOf(MEMBER.accountId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ medalId: 'first_win', corpId: f.corpA });
    const audit = await f.store.auditOf(f.corpA);
    expect(audit.some((e) => e.action === 'medal' && e.target === MEMBER.accountId)).toBe(true);
  });

  it('an officer may grant; a plain member may not', async () => {
    const f = await fixture();
    await recordWins(f, f.corpA, f.corpB, 1);
    expect(await f.medals.grant(OFFICER, MEMBER.accountId, 'first_win')).toEqual({ ok: true, awarded: true });
    expect(await f.medals.grant(MEMBER, OFFICER.accountId, 'first_win')).toEqual({ ok: false, code: 'E_FORBIDDEN' });
  });

  it('refuses a target who is not a real member of the actor’s corp', async () => {
    const f = await fixture();
    await recordWins(f, f.corpA, f.corpB, 1);
    expect(await f.medals.grant(HEAD, RECRUIT.accountId, 'first_win')).toEqual({ ok: false, code: 'E_NOT_MEMBER' }); // recruit
    expect(await f.medals.grant(HEAD, OUTSIDER.accountId, 'first_win')).toEqual({ ok: false, code: 'E_NOT_MEMBER' }); // other corp
  });

  it('refuses an unknown medal, an auto medal, and re-checks eligibility at grant time', async () => {
    const f = await fixture();
    await recordWins(f, f.corpA, f.corpB, 1);
    expect(await f.medals.grant(HEAD, MEMBER.accountId, 'nope')).toEqual({ ok: false, code: 'E_NO_MEDAL' });
    expect(await f.medals.grant(HEAD, MEMBER.accountId, 'auto_badge')).toEqual({ ok: false, code: 'E_NOT_MANUAL' });
    expect(await f.medals.grant(HEAD, MEMBER.accountId, 'champion')).toEqual({ ok: false, code: 'E_NOT_ELIGIBLE' }); // needs 5 wins
  });

  it('eligibleMedals reflects the corp’s current record', async () => {
    const f = await fixture();
    expect(await f.medals.eligibleMedals(HEAD)).toEqual([]);
    await recordWins(f, f.corpA, f.corpB, 5);
    expect((await f.medals.eligibleMedals(HEAD)).sort()).toEqual(['champion', 'first_win']);
    expect(await f.medals.eligibleMedals(OUTSIDER)).toEqual([]); // corp B has no wins
  });
});
