import { describe, expect, it } from 'vitest';
import { CorpArsenalService, type CorpArsenalActor } from './corpArsenalService';
import { CorpService, type CorpActor } from './corpService';
import {
  MemoryArsenalStore,
  MemoryAvaChallengeStore,
  MemoryAvaRosterStore,
  MemoryCorpRentStore,
  MemoryCorpStore,
  type AvaChallenge,
} from './store';

// ARS-6 — corp warehouse rentals: only head/officer hands out a corp-owned item, only
// to a fighter already rostered on the corp's own side, only before the matchup locks,
// never twice at once; war end returns everything exactly once with a durability tick
// and an audit line either way.

const HEAD: CorpActor = { accountId: 'head', login: 'head' };
const OFFICER: CorpActor = { accountId: 'off', login: 'off' };
const MEMBER: CorpActor = { accountId: 'mem', login: 'mem' };
const FIGHTER: CorpActor = { accountId: 'fighter', login: 'fighter' };
const ENEMY_FIGHTER: CorpActor = { accountId: 'efighter', login: 'efighter' };

interface Fixture {
  service: CorpArsenalService;
  corps: MemoryCorpStore;
  arsenal: MemoryArsenalStore;
  rentals: MemoryCorpRentStore;
  challenges: MemoryAvaChallengeStore;
  corpA: string;
  corpB: string;
  matchupId: string;
  itemId: string;
}

async function fixture(status: AvaChallenge['status'] = 'accepted'): Promise<Fixture> {
  const corps = new MemoryCorpStore();
  const arsenal = new MemoryArsenalStore();
  const rentals = new MemoryCorpRentStore();
  const challenges = new MemoryAvaChallengeStore();
  const roster = new MemoryAvaRosterStore();
  let t = 0;
  const now = (): number => ++t;
  const corp = new CorpService({ store: corps, now });
  const a = await corp.create(HEAD, 'Alliance A');
  const b = await corp.create(ENEMY_FIGHTER, 'Alliance B');
  if (!a.ok || !b.ok) throw new Error('fixture');
  for (const who of [OFFICER, MEMBER, FIGHTER]) await corp.apply(who, a.corpId);
  await corp.accept(HEAD, a.corpId, OFFICER.accountId);
  await corp.accept(HEAD, a.corpId, MEMBER.accountId);
  await corp.accept(HEAD, a.corpId, FIGHTER.accountId);
  await corp.setRole(HEAD, a.corpId, OFFICER.accountId, 'officer');

  const matchupId = 'mu-1';
  await challenges.createChallenge({
    id: matchupId,
    challengerCorp: a.corpId,
    targetCorp: b.corpId,
    cost: 0,
    status,
    createdAt: 0,
    expiresAt: 0,
    pauseEndsAt: 100,
  });
  await roster.addEntry(
    { matchupId, accountId: FIGHTER.accountId, side: 'challenger', source: 'flagged', at: 1 },
    10,
  );

  const itemId = 'flagship-1';
  await arsenal.grant({
    itemId,
    accountId: a.corpId, // corp-owned: the ArsenalStore reused verbatim (ARS-6 model)
    kind: 'hull',
    form: 'instance',
    defId: 'cruiser',
    soulbound: false,
    durability: 5,
    origin: 'auction',
    acquiredAt: 0,
  });

  const service = new CorpArsenalService({
    corpStore: corps,
    arsenalStore: arsenal,
    rentStore: rentals,
    challengeStore: challenges,
    rosterStore: roster,
    now,
  });
  return { service, corps, arsenal, rentals, challenges, corpA: a.corpId, corpB: b.corpId, matchupId, itemId };
}

const asActor = (who: CorpActor): CorpArsenalActor => who;

describe('CorpArsenalService — RBAC and handout', () => {
  it('head or officer can hand out; a plain member or an outsider cannot', async () => {
    const f = await fixture();
    const byMember = await f.service.rentOut(asActor(MEMBER), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    expect(byMember).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    const byOfficer = await f.service.rentOut(asActor(OFFICER), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    expect(byOfficer).toEqual({ ok: true });
  });

  it('refuses an item the acting corp does not own', async () => {
    const f = await fixture();
    // ENEMY_FIGHTER heads corpB (RBAC clears), but the item belongs to corpA.
    const notMine = await f.service.rentOut(
      asActor(ENEMY_FIGHTER),
      f.corpB,
      f.itemId,
      f.matchupId,
      FIGHTER.accountId,
    );
    expect(notMine).toEqual({ ok: false, code: 'E_NOT_CORP_ITEM' });
  });

  it('refuses a target who is not rostered on the corp’s own side', async () => {
    const f = await fixture();
    const notRostered = await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, MEMBER.accountId);
    expect(notRostered).toEqual({ ok: false, code: 'E_NOT_ROSTERED' });
    // rostered, but on the ENEMY side of the same matchup — still refused
    const enemySide = await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, ENEMY_FIGHTER.accountId);
    expect(enemySide).toEqual({ ok: false, code: 'E_NOT_ROSTERED' });
  });

  it('refuses once the roster has locked ("до лока")', async () => {
    const f = await fixture('locked');
    const tooLate = await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    expect(tooLate).toEqual({ ok: false, code: 'E_ROSTER_LOCKED' });
  });

  it('an item cannot be rented into two wars (or twice) at once', async () => {
    const f = await fixture();
    const first = await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    expect(first).toEqual({ ok: true });
    const second = await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    expect(second).toEqual({ ok: false, code: 'E_ALREADY_RENTED' });
  });

  it('writes an audit line on a successful handout', async () => {
    const f = await fixture();
    await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    const audit = await f.corps.auditOf(f.corpA);
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'rent', actor: HEAD.accountId, target: FIGHTER.accountId, detail: f.itemId }),
    );
  });
});

describe('CorpArsenalService — ARS-3 snapshot merge', () => {
  it('rentedArsenalOf projects only THIS account’s THIS-matchup rentals', async () => {
    const f = await fixture();
    await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    expect(await f.service.rentedArsenalOf(FIGHTER.accountId, f.matchupId)).toEqual({
      hulls: ['cruiser'],
      modules: [],
      fittings: [],
    });
    expect(await f.service.rentedArsenalOf(MEMBER.accountId, f.matchupId)).toEqual({
      hulls: [],
      modules: [],
      fittings: [],
    });
  });
});

describe('CorpArsenalService — war end (ARS-0.3: always returns, win or lose)', () => {
  it('returnWar closes every active rental, ticks durability, and audits — exactly once on replay', async () => {
    const f = await fixture();
    await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, f.matchupId, FIGHTER.accountId);
    const first = await f.service.returnWar(f.matchupId);
    expect(first).toBe(1);
    expect((await f.arsenal.get(f.itemId))?.durability).toBe(4); // 5 - 1
    expect(await f.rentals.activeForMatchup(f.matchupId)).toHaveLength(0);
    const audit = await f.corps.auditOf(f.corpA);
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'rent_return', target: FIGHTER.accountId, detail: f.itemId }),
    );

    // Replay (e.g. a re-delivered match.ended) — nothing doubles.
    const replay = await f.service.returnWar(f.matchupId);
    expect(replay).toBe(0);
    expect((await f.arsenal.get(f.itemId))?.durability).toBe(4); // unchanged

    // The item is free again — a NEW war can rent it.
    const rerent = await f.service.rentOut(asActor(HEAD), f.corpA, f.itemId, 'mu-2', FIGHTER.accountId);
    expect(rerent.ok).toBe(false); // mu-2 doesn't exist as a challenge in this fixture
  });

  it('a matchup with nothing on rent is a safe no-op', async () => {
    const f = await fixture();
    expect(await f.service.returnWar(f.matchupId)).toBe(0);
  });
});
