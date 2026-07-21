import { describe, expect, it } from 'vitest';
import { CorpService, type CorpActor } from './corpService';
import { MemoryCorpStore } from './store';

// CORP-0 — the rights matrix from docs/corporations.md §2, enforced fail-secure.
// Every sensitive action is exercised both ways: the allowed path succeeds, every
// forbidden path returns its stable code (never a silent pass — invariant #4).

const HEAD: CorpActor = { accountId: 'a-head', login: 'head' };
const OFFICER: CorpActor = { accountId: 'a-off', login: 'officer' };
const OFFICER2: CorpActor = { accountId: 'a-off2', login: 'officer2' };
const MEMBER: CorpActor = { accountId: 'a-mem', login: 'member' };
const RECRUIT: CorpActor = { accountId: 'a-rec', login: 'recruit' };
const OUTSIDER: CorpActor = { accountId: 'a-out', login: 'outsider' };

interface Fixture {
  service: CorpService;
  store: MemoryCorpStore;
  corpId: string;
}

/** A corp with one of each role: head, two officers, a member, a recruit. */
async function corpFixture(): Promise<Fixture> {
  const store = new MemoryCorpStore();
  let clock = 0;
  const service = new CorpService({ store, now: () => ++clock });
  const created = await service.create(HEAD, 'Void Dominion');
  if (!created.ok) throw new Error('fixture: create failed');
  const corpId = created.corpId;
  for (const actor of [OFFICER, OFFICER2, MEMBER, RECRUIT]) {
    expect(await service.apply(actor, corpId)).toEqual({ ok: true });
  }
  for (const actor of [OFFICER, OFFICER2, MEMBER]) {
    expect(await service.accept(HEAD, corpId, actor.accountId)).toEqual({ ok: true });
  }
  for (const officer of [OFFICER, OFFICER2]) {
    expect(await service.setRole(HEAD, corpId, officer.accountId, 'officer')).toEqual({ ok: true });
  }
  return { service, store, corpId };
}

async function roleOf(store: MemoryCorpStore, actor: CorpActor): Promise<string | null> {
  return (await store.membershipOf(actor.accountId))?.role ?? null;
}

describe('CORP-0 · create / apply / accept / decline', () => {
  it('creating a corp makes the founder its head; bad names are rejected', async () => {
    const store = new MemoryCorpStore();
    const service = new CorpService({ store });
    for (const bad of ['ab', ' a', 'x'.repeat(25), 'два%знака', '']) {
      expect(await service.create(HEAD, bad)).toEqual({ ok: false, code: 'E_BAD_NAME' });
    }
    const created = await service.create(HEAD, '  Красная Гвардия  '); // trimmed, cyrillic ok
    if (!created.ok) throw new Error('expected ok');
    expect(await store.getCorp(created.corpId)).toMatchObject({ name: 'Красная Гвардия' });
    expect(await roleOf(store, HEAD)).toBe('head');
  });

  it('a member of one corp can neither found nor apply to another (one corp per account)', async () => {
    const { service } = await corpFixture();
    expect(await service.create(MEMBER, 'Second Corp')).toEqual({ ok: false, code: 'E_IN_CORP' });
    const other = await service.create(OUTSIDER, 'Other Corp');
    if (!other.ok) throw new Error('expected ok');
    expect(await service.apply(MEMBER, other.corpId)).toEqual({ ok: false, code: 'E_IN_CORP' });
    expect(await service.apply(RECRUIT, other.corpId)).toEqual({ ok: false, code: 'E_IN_CORP' });
  });

  it('applying to a missing corp is E_NO_CORP; officers and the head accept/decline', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.apply(OUTSIDER, 'nope')).toEqual({ ok: false, code: 'E_NO_CORP' });
    expect(await service.apply(OUTSIDER, corpId)).toEqual({ ok: true });
    expect(await roleOf(store, OUTSIDER)).toBe('recruit');
    expect(await service.accept(OFFICER, corpId, OUTSIDER.accountId)).toEqual({ ok: true });
    expect(await roleOf(store, OUTSIDER)).toBe('member');
  });

  it('members and recruits cannot accept/decline; a non-recruit target is E_NOT_APPLIED', async () => {
    const { service, corpId } = await corpFixture();
    for (const actor of [MEMBER, RECRUIT, OUTSIDER]) {
      expect(await service.accept(actor, corpId, RECRUIT.accountId)).toEqual({
        ok: false,
        code: 'E_FORBIDDEN',
      });
    }
    expect(await service.accept(HEAD, corpId, MEMBER.accountId)).toEqual({
      ok: false,
      code: 'E_NOT_APPLIED',
    });
    expect(await service.decline(HEAD, corpId, OUTSIDER.accountId)).toEqual({
      ok: false,
      code: 'E_NOT_APPLIED',
    });
  });

  it('decline removes the application; cancel is the recruit’s own withdrawal', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.decline(OFFICER, corpId, RECRUIT.accountId)).toEqual({ ok: true });
    expect(await roleOf(store, RECRUIT)).toBeNull();
    expect(await service.apply(RECRUIT, corpId)).toEqual({ ok: true });
    expect(await service.cancel(RECRUIT, corpId)).toEqual({ ok: true });
    expect(await roleOf(store, RECRUIT)).toBeNull();
    expect(await service.cancel(MEMBER, corpId)).toEqual({ ok: false, code: 'E_NOT_APPLIED' });
  });
});

describe('CORP-0 · kick', () => {
  it('the head kicks anyone but themself; the head is unkickable', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.kick(HEAD, corpId, OFFICER.accountId)).toEqual({ ok: true });
    expect(await service.kick(HEAD, corpId, MEMBER.accountId)).toEqual({ ok: true });
    expect(await service.kick(HEAD, corpId, RECRUIT.accountId)).toEqual({ ok: true });
    expect(await roleOf(store, OFFICER)).toBeNull();
    expect(await service.kick(HEAD, corpId, HEAD.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
  });

  it('an officer kicks members/recruits only — never the head or another officer', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.kick(OFFICER, corpId, MEMBER.accountId)).toEqual({ ok: true });
    expect(await service.kick(OFFICER, corpId, RECRUIT.accountId)).toEqual({ ok: true });
    expect(await roleOf(store, MEMBER)).toBeNull();
    expect(await service.kick(OFFICER, corpId, HEAD.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    expect(await service.kick(OFFICER, corpId, OFFICER2.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    expect(await roleOf(store, HEAD)).toBe('head');
    expect(await roleOf(store, OFFICER2)).toBe('officer');
  });

  it('members/outsiders cannot kick; an outsider target is E_NOT_MEMBER', async () => {
    const { service, corpId } = await corpFixture();
    expect(await service.kick(MEMBER, corpId, RECRUIT.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    expect(await service.kick(OUTSIDER, corpId, MEMBER.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    expect(await service.kick(HEAD, corpId, OUTSIDER.accountId)).toEqual({
      ok: false,
      code: 'E_NOT_MEMBER',
    });
  });
});

describe('CORP-0 · roles and headship', () => {
  it('only the head assigns roles, and only member ⇄ officer', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.setRole(HEAD, corpId, OFFICER.accountId, 'member')).toEqual({ ok: true });
    expect(await roleOf(store, OFFICER)).toBe('member');
    // no escalation: officers never change roles (the closed escalation path)
    expect(await service.setRole(OFFICER2, corpId, MEMBER.accountId, 'officer')).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    // no second head, no demotion back to an application, no self-change
    expect(await service.setRole(HEAD, corpId, MEMBER.accountId, 'head')).toEqual({
      ok: false,
      code: 'E_BAD_ROLE',
    });
    expect(await service.setRole(HEAD, corpId, MEMBER.accountId, 'recruit')).toEqual({
      ok: false,
      code: 'E_BAD_ROLE',
    });
    expect(await service.setRole(HEAD, corpId, HEAD.accountId, 'member')).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    // a recruit is not a member yet — promotion goes through accept
    expect(await service.setRole(HEAD, corpId, RECRUIT.accountId, 'officer')).toEqual({
      ok: false,
      code: 'E_NOT_MEMBER',
    });
  });

  it('transferHeadship: the target becomes head, the ex-head stays as officer', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.transfer(OFFICER, corpId, MEMBER.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    expect(await service.transfer(HEAD, corpId, RECRUIT.accountId)).toEqual({
      ok: false,
      code: 'E_NOT_MEMBER',
    });
    expect(await service.transfer(HEAD, corpId, HEAD.accountId)).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
    expect(await service.transfer(HEAD, corpId, MEMBER.accountId)).toEqual({ ok: true });
    expect(await roleOf(store, MEMBER)).toBe('head');
    expect(await roleOf(store, HEAD)).toBe('officer');
    // the old head lost head rights with the headship
    expect(await service.setRole(HEAD, corpId, OFFICER.accountId, 'member')).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
  });
});

describe('CORP-0 · leave and disband', () => {
  it('members/officers leave freely; the head must transfer first — unless alone', async () => {
    const { service, store, corpId } = await corpFixture();
    expect(await service.leave(MEMBER, corpId)).toEqual({ ok: true });
    expect(await service.leave(OFFICER, corpId)).toEqual({ ok: true });
    expect(await service.leave(HEAD, corpId)).toEqual({ ok: false, code: 'E_HEAD_MUST_TRANSFER' });
    expect(await service.leave(OFFICER2, corpId)).toEqual({ ok: true });
    expect(await service.leave(RECRUIT, corpId)).toEqual({ ok: true }); // a recruit "leaves" = cancels
    // now alone → leaving disbands the corp
    expect(await service.leave(HEAD, corpId)).toEqual({ ok: true });
    expect(await store.getCorp(corpId)).toBeNull();
    expect(await service.leave(OUTSIDER, corpId)).toEqual({ ok: false, code: 'E_NOT_MEMBER' });
  });

  it('disband is head-only and releases everyone', async () => {
    const { service, store, corpId } = await corpFixture();
    for (const actor of [OFFICER, MEMBER, OUTSIDER]) {
      expect(await service.disband(actor, corpId)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    }
    expect(await service.disband(HEAD, corpId)).toEqual({ ok: true });
    expect(await store.getCorp(corpId)).toBeNull();
    for (const actor of [HEAD, OFFICER, OFFICER2, MEMBER, RECRUIT]) {
      expect(await roleOf(store, actor)).toBeNull();
    }
  });
});

describe('CORP-0 · read models and audit', () => {
  it('detail ranks members head → officers → members → recruits', async () => {
    const { service, corpId } = await corpFixture();
    const detail = await service.detail(corpId);
    if (!detail.ok) throw new Error('expected ok');
    expect(detail.members.map((m) => m.role)).toEqual([
      'head',
      'officer',
      'officer',
      'member',
      'recruit',
    ]);
    expect(await service.detail('nope')).toEqual({ ok: false, code: 'E_NO_CORP' });
  });

  it('mine returns the caller’s corp or nulls', async () => {
    const { service, corpId } = await corpFixture();
    const mine = await service.mine(MEMBER);
    expect(mine.corp?.corpId).toBe(corpId);
    expect(mine.membership).toMatchObject({ role: 'member', login: 'member' });
    expect(await service.mine(OUTSIDER)).toEqual({ corp: null, membership: null });
  });

  it('sensitive actions land in the audit trail; only head/officers read it', async () => {
    const { service, corpId } = await corpFixture();
    expect(await service.kick(HEAD, corpId, MEMBER.accountId)).toEqual({ ok: true });
    expect(await service.transfer(HEAD, corpId, OFFICER.accountId)).toEqual({ ok: true });
    const log = await service.auditLog(OFFICER, corpId);
    if (!log.ok) throw new Error('expected ok');
    // newest first: transfer, kick, the fixture's role×2 + accept×3, create
    expect(log.audit.map((e) => e.action)).toEqual([
      'transfer',
      'kick',
      'role',
      'role',
      'accept',
      'accept',
      'accept',
      'create',
    ]);
    expect(log.audit[0]).toMatchObject({ actor: HEAD.accountId, target: OFFICER.accountId });
    for (const actor of [MEMBER, RECRUIT, OUTSIDER]) {
      expect(await service.auditLog(actor, corpId)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    }
  });

  it('readyPlayers exposes the flagged pool to head/officers only (AVA-6 eligibility)', async () => {
    const { service, store, corpId } = await corpFixture();
    await store.setPlayerReady(MEMBER.accountId, corpId, 1);
    await store.setPlayerReady(OFFICER.accountId, corpId, 2);
    const seen = await service.readyPlayers(OFFICER, corpId);
    if (!seen.ok) throw new Error('expected ok');
    expect(new Set(seen.accountIds)).toEqual(new Set([MEMBER.accountId, OFFICER.accountId]));
    for (const actor of [MEMBER, RECRUIT, OUTSIDER]) {
      expect(await service.readyPlayers(actor, corpId)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    }
  });
});
