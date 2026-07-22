import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createInitialState, type GameState } from '@void/shared-core';
import {
  MemoryAccountStore,
  MemoryArsenalStore,
  MemoryUserStore,
  MemoryAvaChallengeStore,
  MemoryAvaFeedStore,
  MemoryAvaResultStore,
  MemoryAvaRosterStore,
  MemoryAvaSessionStore,
  MemoryCorpRentStore,
  MemoryCorpStore,
  MemoryDropStore,
  MemoryMatchStore,
  MemoryMedalStore,
  MemoryReceiptStore,
} from './memory';
import {
  PostgresAccountStore,
  PostgresArsenalStore,
  PostgresUserStore,
  PostgresAvaChallengeStore,
  PostgresAvaFeedStore,
  PostgresAvaResultStore,
  PostgresAvaRosterStore,
  PostgresAvaSessionStore,
  PostgresCorpRentStore,
  PostgresCorpStore,
  PostgresDropStore,
  PostgresMatchStore,
  PostgresMedalStore,
  PostgresReceiptStore,
  migrate,
} from './postgres';
import type {
  AccountStore,
  ArsenalStore,
  CorpRentStore,
  DropStore,
  OwnedArsenalItem,
  UserStore,
  AvaChallenge,
  AvaChallengeStore,
  AvaFeedStore,
  AvaResultStore,
  AvaRosterEntry,
  AvaRosterStore,
  AvaSessionStore,
  AvaSide,
  CorpStore,
  MatchSnapshot,
  MatchStore,
  MedalStore,
  ReceiptStore,
} from './types';

function state(seed = 'store'): GameState {
  return createInitialState({ seed, version: { data: 't', manifest: 't' } });
}
function snap(matchId: string, seq: number, s: GameState): MatchSnapshot {
  return { matchId, dataVersion: 't', seq, status: 'ongoing', state: s };
}

// Shared behaviour run against BOTH adapters, so memory and Postgres agree.
// `uniq` decouples runs on the shared Postgres tables (ids must not collide).
function matchStoreContract(name: string, make: () => MatchStore, uniq: (p: string) => string): void {
  describe(`MatchStore — ${name}`, () => {
    it('round-trips a snapshot byte-for-byte', async () => {
      const store = make();
      const s = state();
      s.time = 4242;
      await store.save(snap(uniq('m1'), 5, s));
      const loaded = await store.load(uniq('m1'));
      expect(loaded?.seq).toBe(5);
      expect(loaded?.state.time).toBe(4242);
      expect(loaded?.state).toEqual(s);
    });

    it('returns null for an unknown match', async () => {
      expect(await make().load(uniq('nope'))).toBeNull();
    });

    it('is optimistic by seq — an older save never clobbers a newer one', async () => {
      const store = make();
      await store.save(snap(uniq('m2'), 10, withTime(state(), 1000)));
      await store.save(snap(uniq('m2'), 3, withTime(state(), 7))); // stale, lower seq
      const loaded = await store.load(uniq('m2'));
      expect(loaded?.seq).toBe(10);
      expect(loaded?.state.time).toBe(1000);
    });

    it('lists ONGOING matches only (the open-matches feed read)', async () => {
      const store = make();
      await store.save(snap(uniq('m-live'), 1, state()));
      await store.save({ ...snap(uniq('m-done'), 1, state()), status: 'ended' });
      const ids = await store.ongoingMatchIds();
      expect(ids).toContain(uniq('m-live'));
      expect(ids).not.toContain(uniq('m-done'));
    });

    it('ping reports the backing store reachable (the /ready probe)', async () => {
      expect(await make().ping?.()).toBe(true);
    });
  });
}

function accountStoreContract(name: string, make: () => AccountStore, uniq: (p: string) => string): void {
  describe(`AccountStore — ${name}`, () => {
    const seats = ['p1', 'p2'] as const;

    it('assigns a free seat and returns the SAME one on return', async () => {
      const store = make();
      const first = await store.resolveSeat(uniq('r1'), 'alice', seats);
      expect(first).toEqual({ playerId: 'p1', isNew: true });
      const again = await store.resolveSeat(uniq('r1'), 'alice', seats);
      expect(again).toEqual({ playerId: 'p1', isNew: false }); // resumes her side
    });

    it('gives a different nick the other seat, then rejects a full room', async () => {
      const store = make();
      expect((await store.resolveSeat(uniq('r2'), 'alice', seats))?.playerId).toBe('p1');
      expect((await store.resolveSeat(uniq('r2'), 'bob', seats))?.playerId).toBe('p2');
      expect(await store.resolveSeat(uniq('r2'), 'carol', seats)).toBeNull(); // full
      // but an already-seated nick still resolves even when "full"
      expect((await store.resolveSeat(uniq('r2'), 'bob', seats))?.playerId).toBe('p2');
    });

    it('seat ticket (REL-5): first bind wins, later binds return the winner', async () => {
      const store = make();
      await store.resolveSeat(uniq('r3'), 'alice', seats);
      expect(await store.seatTicket(uniq('r3'), 'alice')).toBeNull(); // nothing bound yet
      expect(await store.bindSeatTicket(uniq('r3'), 'alice', 'hash-A')).toBe('hash-A'); // we won
      expect(await store.bindSeatTicket(uniq('r3'), 'alice', 'hash-B')).toBe('hash-A'); // lost → winner
      expect(await store.seatTicket(uniq('r3'), 'alice')).toBe('hash-A');
      // tickets are seat-scoped: another nick / another room are independent
      await store.resolveSeat(uniq('r3'), 'bob', seats);
      expect(await store.seatTicket(uniq('r3'), 'bob')).toBeNull();
      expect(await store.bindSeatTicket(uniq('r4'), 'alice', 'x')).toBeNull(); // no seat there
    });
  });
}

function withTime(s: GameState, t: number): GameState {
  s.time = t;
  return s;
}

function receiptStoreContract(name: string, make: () => ReceiptStore, uniq: (p: string) => string): void {
  describe(`ReceiptStore — ${name}`, () => {
    it('saves + loads receipts; a re-save of the same action is a no-op (first wins)', async () => {
      const store = make();
      const m = uniq('m');
      await store.save(m, { actionId: 'a1', playerId: 'p1', seq: 1, ok: true });
      await store.save(m, { actionId: 'a2', playerId: 'p2', seq: 2, ok: false, code: 'E_X' });
      await store.save(m, { actionId: 'a1', playerId: 'p1', seq: 9, ok: true }); // dup → ignored
      const all = await store.loadAll(m);
      expect(all).toHaveLength(2);
      expect(all.find((r) => r.actionId === 'a1')).toMatchObject({ seq: 1, ok: true });
      expect(all.find((r) => r.actionId === 'a2')).toMatchObject({ ok: false, code: 'E_X' });
    });

    it('scopes receipts by match', async () => {
      const store = make();
      await store.save(uniq('rm1'), { actionId: 'a', playerId: 'p1', seq: 1, ok: true });
      expect(await store.loadAll(uniq('rm2'))).toHaveLength(0);
    });
  });
}

/** SE-1.x — login+password accounts, run against BOTH adapters. */
function userStoreContract(name: string, make: () => UserStore, uniq: (p: string) => string): void {
  describe(`UserStore — ${name}`, () => {
    it('creates an account and finds it case-insensitively', async () => {
      const store = make();
      const login = uniq('Ada');
      const created = await store.createUser(login, 'hash-1');
      if (!created.ok) throw new Error('expected ok');
      expect((await store.findUser(login))?.userId).toBe(created.userId);
      expect((await store.findUser(login.toUpperCase()))?.login).toBe(login);
      expect(await store.findUser(uniq('nobody'))).toBeNull();
    });

    it('a duplicate login in ANY case is E_LOGIN_TAKEN, never an overwrite', async () => {
      const store = make();
      const login = uniq('Bob');
      const first = await store.createUser(login, 'hash-1');
      if (!first.ok) throw new Error('expected ok');
      expect(await store.createUser(login.toUpperCase(), 'hash-2')).toEqual({
        ok: false,
        code: 'E_LOGIN_TAKEN',
      });
      expect((await store.findUser(login))?.passHash).toBe('hash-1'); // untouched
    });
  });
}

/** CORP-0 — shared corp-store behaviour, run against BOTH adapters. `uniq` decouples
 *  runs on the shared Postgres tables (names/accounts must not collide across tests). */
function corpStoreContract(name: string, make: () => CorpStore, uniq: (p: string) => string): void {
  describe(`CorpStore — ${name}`, () => {
    it('creates a corp with the founder as head; the name is taken case-insensitively', async () => {
      const store = make();
      const corpName = uniq('Void Miners');
      const created = await store.createCorp(corpName, uniq('acc-a'), 'alice');
      if (!created.ok) throw new Error('expected ok');
      expect(await store.getCorp(created.corpId)).toEqual({
        corpId: created.corpId,
        name: corpName,
        influence: 0,
      });
      expect(await store.membershipOf(uniq('acc-a'))).toMatchObject({
        role: 'head',
        login: 'alice',
      });
      const dup = await store.createCorp(corpName.toUpperCase(), uniq('acc-b'), 'bob');
      expect(dup).toEqual({ ok: false, code: 'E_NAME_TAKEN' });
    });

    it('one corp per account: a member (or recruit) cannot found or join another', async () => {
      const store = make();
      const created = await store.createCorp(uniq('First'), uniq('acc-1'), 'alice');
      if (!created.ok) throw new Error('expected ok');
      // the head can't found a second corp
      expect(await store.createCorp(uniq('Second'), uniq('acc-1'), 'alice')).toEqual({
        ok: false,
        code: 'E_IN_CORP',
      });
      // a recruit row blocks a second application the same way
      expect(await store.addMember(created.corpId, uniq('acc-2'), 'bob', 'recruit')).toEqual({
        ok: true,
      });
      expect(await store.addMember(created.corpId, uniq('acc-2'), 'bob', 'member')).toEqual({
        ok: false,
        code: 'E_IN_CORP',
      });
    });

    it('setRole/removeMember mutate only the addressed corp membership', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Movers'), uniq('acc-h'), 'head');
      if (!created.ok) throw new Error('expected ok');
      await store.addMember(created.corpId, uniq('acc-m'), 'mira', 'recruit');
      await store.setRole(created.corpId, uniq('acc-m'), 'member');
      expect(await store.membershipOf(uniq('acc-m'))).toMatchObject({ role: 'member' });
      await store.setRole('someone-elses-corp', uniq('acc-m'), 'officer'); // wrong corp → no-op
      expect(await store.membershipOf(uniq('acc-m'))).toMatchObject({ role: 'member' });
      await store.removeMember(created.corpId, uniq('acc-m'));
      expect(await store.membershipOf(uniq('acc-m'))).toBeNull();
    });

    it('swapHead atomically demotes the head to officer and promotes the target', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Handover'), uniq('acc-old'), 'old');
      if (!created.ok) throw new Error('expected ok');
      await store.addMember(created.corpId, uniq('acc-new'), 'new', 'member');
      await store.swapHead(created.corpId, uniq('acc-old'), uniq('acc-new'));
      expect(await store.membershipOf(uniq('acc-old'))).toMatchObject({ role: 'officer' });
      expect(await store.membershipOf(uniq('acc-new'))).toMatchObject({ role: 'head' });
      // a non-head `from` never steals headship
      await store.swapHead(created.corpId, uniq('acc-old'), uniq('acc-old'));
      expect(await store.membershipOf(uniq('acc-new'))).toMatchObject({ role: 'head' });
    });

    it('swapHead is a no-op when the target already left — never commits a headless corp', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Orphanproof'), uniq('acc-head'), 'head');
      if (!created.ok) throw new Error('expected ok');
      await store.addMember(created.corpId, uniq('acc-gone'), 'gone', 'member');
      // The target vanishes between the service's membership check and the swap
      // (the TOCTOU window corpService.transfer leaves open).
      await store.removeMember(created.corpId, uniq('acc-gone'));
      await store.swapHead(created.corpId, uniq('acc-head'), uniq('acc-gone'));
      expect(await store.membershipOf(uniq('acc-head'))).toMatchObject({ role: 'head' });
    });

    it('removeCorp releases every member; the audit trail survives, newest first', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Doomed'), uniq('acc-x'), 'xena');
      if (!created.ok) throw new Error('expected ok');
      await store.addMember(created.corpId, uniq('acc-y'), 'yuri', 'member');
      await store.appendAudit({
        corpId: created.corpId,
        at: 1,
        actor: uniq('acc-x'),
        action: 'create',
      });
      await store.appendAudit({
        corpId: created.corpId,
        at: 2,
        actor: uniq('acc-x'),
        action: 'disband',
        target: uniq('acc-y'),
        detail: 'why',
      });
      await store.removeCorp(created.corpId);
      expect(await store.getCorp(created.corpId)).toBeNull();
      expect(await store.membershipOf(uniq('acc-x'))).toBeNull();
      expect(await store.membershipOf(uniq('acc-y'))).toBeNull();
      const audit = await store.auditOf(created.corpId);
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        at: 2,
        action: 'disband',
        target: uniq('acc-y'),
        detail: 'why',
      });
      expect(audit[1]).toMatchObject({ at: 1, action: 'create' });
    });

    it('listCorps counts accepted members only (recruits pending)', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Counted'), uniq('acc-c1'), 'c1');
      if (!created.ok) throw new Error('expected ok');
      await store.addMember(created.corpId, uniq('acc-c2'), 'c2', 'member');
      await store.addMember(created.corpId, uniq('acc-c3'), 'c3', 'recruit');
      const summary = (await store.listCorps()).find((c) => c.corpId === created.corpId);
      expect(summary).toMatchObject({ name: uniq('Counted'), members: 2 });
      expect(await store.membersOf(created.corpId)).toHaveLength(3);
    });

    // AVA-2 — influence: credited on earn, debited atomically, never negative.
    it('influence starts at 0, credits, and spends atomically without overdrawing', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Rich'), uniq('acc-inf'), 'r');
      if (!created.ok) throw new Error('expected ok');
      expect((await store.getCorp(created.corpId))?.influence).toBe(0);
      await store.addInfluence(created.corpId, 250);
      await store.addInfluence(created.corpId, -99); // non-positive credit is ignored
      expect((await store.getCorp(created.corpId))?.influence).toBe(250);
      expect(await store.spendInfluence(created.corpId, 100)).toEqual({ ok: true });
      expect((await store.getCorp(created.corpId))?.influence).toBe(150);
      // over-spend is refused and changes nothing
      expect(await store.spendInfluence(created.corpId, 1000)).toEqual({
        ok: false,
        code: 'E_INSUFFICIENT',
      });
      expect((await store.getCorp(created.corpId))?.influence).toBe(150);
    });

    // AVA-3 — readiness flags: corp pool + player consent, cleared on leave/disband.
    it('corp/player readiness flags populate the pool and clear on membership loss', async () => {
      const store = make();
      const created = await store.createCorp(uniq('Ready'), uniq('acc-rdyh'), 'head');
      if (!created.ok) throw new Error('expected ok');
      await store.addMember(created.corpId, uniq('acc-rdyp'), 'pat', 'member');
      expect(await store.isCorpReady(created.corpId)).toBe(false);
      await store.setCorpReady(created.corpId, 111);
      expect(await store.isCorpReady(created.corpId)).toBe(true);
      const pool = (await store.listReadyCorps()).find((c) => c.corpId === created.corpId);
      expect(pool).toMatchObject({ name: uniq('Ready'), readySince: 111 });

      await store.setPlayerReady(uniq('acc-rdyp'), created.corpId, 222);
      await store.setPlayerReady(uniq('acc-rdyh'), created.corpId, 223);
      expect(await store.readyPlayersOf(created.corpId)).toHaveLength(2);
      // leaving the corp revokes the player's consent
      await store.removeMember(created.corpId, uniq('acc-rdyp'));
      expect(await store.readyPlayersOf(created.corpId)).toEqual([uniq('acc-rdyh')]);
      // disband clears the corp flag AND remaining consents
      await store.removeCorp(created.corpId);
      expect(await store.isCorpReady(created.corpId)).toBe(false);
      expect(await store.readyPlayersOf(created.corpId)).toHaveLength(0);
    });
  });
}

// AVA-4 — the challenge store: one pending per pair, exactly-once close, expiry sweep.
function challenge(
  id: string,
  challenger: string,
  target: string,
  expiresAt: number,
): AvaChallenge {
  return {
    id,
    challengerCorp: challenger,
    targetCorp: target,
    cost: 100,
    status: 'pending',
    createdAt: 0,
    expiresAt,
  };
}

function avaChallengeStoreContract(
  name: string,
  make: () => AvaChallengeStore,
  uniq: (p: string) => string,
): void {
  describe(`AvaChallengeStore — ${name}`, () => {
    it('inserts a pending challenge and reads it back for either party', async () => {
      const store = make();
      const [a, b] = [uniq('corp-a'), uniq('corp-b')];
      expect(await store.createChallenge(challenge(uniq('ch1'), a, b, 500))).toEqual({ ok: true });
      expect(await store.getChallenge(uniq('ch1'))).toMatchObject({
        challengerCorp: a,
        targetCorp: b,
        status: 'pending',
      });
      expect(await store.challengesOf(a)).toHaveLength(1);
      expect(await store.challengesOf(b)).toHaveLength(1); // visible to the target too
    });

    it('rejects a second PENDING challenge for the same pair', async () => {
      const store = make();
      const [a, b] = [uniq('c-a2'), uniq('c-b2')];
      await store.createChallenge(challenge(uniq('ch-a'), a, b, 500));
      expect(await store.createChallenge(challenge(uniq('ch-b'), a, b, 600))).toEqual({
        ok: false,
        code: 'E_ALREADY_CHALLENGED',
      });
    });

    it('closeChallenge is exactly-once: the second transition is a no-op', async () => {
      const store = make();
      const [a, b] = [uniq('c-a3'), uniq('c-b3')];
      await store.createChallenge(challenge(uniq('ch-c'), a, b, 500));
      expect(await store.closeChallenge(uniq('ch-c'), 'accepted')).toBe(true);
      expect(await store.closeChallenge(uniq('ch-c'), 'declined')).toBe(false); // already closed
      expect((await store.getChallenge(uniq('ch-c')))?.status).toBe('accepted');
      // closing the pair is free again once the first is terminal
      expect(await store.createChallenge(challenge(uniq('ch-d'), a, b, 700))).toEqual({ ok: true });
    });

    it('duePending returns only pending challenges past their expiry', async () => {
      const store = make();
      const [a, b] = [uniq('c-a4'), uniq('c-b4')];
      await store.createChallenge(challenge(uniq('ch-e'), a, b, 1000));
      // Membership checks (not absolute length) so the shared Postgres table's other
      // rows don't perturb this: our own row is due only once `now` reaches its expiry.
      expect((await store.duePending(500)).map((c) => c.id)).not.toContain(uniq('ch-e'));
      expect((await store.duePending(1000)).map((c) => c.id)).toContain(uniq('ch-e'));
      await store.closeChallenge(uniq('ch-e'), 'expired');
      expect((await store.duePending(2000)).map((c) => c.id)).not.toContain(uniq('ch-e'));
    });

    it('AVA-6: roster window stamps only accepted rows; closeMatchup is exactly-once', async () => {
      const store = make();
      const [a, b] = [uniq('c-a5'), uniq('c-b5')];
      await store.createChallenge(challenge(uniq('ch-f'), a, b, 1000));
      // pending → no window stamped (accept must come first)
      await store.openRosterWindow(uniq('ch-f'), 5000);
      expect((await store.getChallenge(uniq('ch-f')))?.pauseEndsAt).toBeUndefined();
      // and no matchup close either — the row is not accepted
      expect(await store.closeMatchup(uniq('ch-f'), 'locked')).toBe(false);
      expect(await store.endMatchup(uniq('ch-f'))).toBe(false); // AVA-8: not locked

      await store.closeChallenge(uniq('ch-f'), 'accepted');
      await store.openRosterWindow(uniq('ch-f'), 5000);
      expect((await store.getChallenge(uniq('ch-f')))?.pauseEndsAt).toBe(5000);
      // dueRosters keys off the stamped deadline
      expect((await store.dueRosters(4999)).map((c) => c.id)).not.toContain(uniq('ch-f'));
      expect((await store.dueRosters(5000)).map((c) => c.id)).toContain(uniq('ch-f'));
      // accepted → terminal happens exactly once (the sweep race)
      expect(await store.closeMatchup(uniq('ch-f'), 'locked')).toBe(true);
      expect(await store.closeMatchup(uniq('ch-f'), 'cancelled')).toBe(false);
      expect((await store.getChallenge(uniq('ch-f')))?.status).toBe('locked');
      expect((await store.dueRosters(9999)).map((c) => c.id)).not.toContain(uniq('ch-f'));
      // AVA-7: a locked matchup shows up for the orchestrator sweep…
      expect((await store.lockedMatchups()).map((c) => c.id)).toContain(uniq('ch-f'));
      // AVA-8: locked → ended, exactly once (settlement's exactly-once gate)
      expect(await store.endMatchup(uniq('ch-f'))).toBe(true);
      expect(await store.endMatchup(uniq('ch-f'))).toBe(false);
      expect((await store.getChallenge(uniq('ch-f')))?.status).toBe('ended');
      // …and drops out once it is archived (ended).
      expect((await store.lockedMatchups()).map((c) => c.id)).not.toContain(uniq('ch-f'));
    });
  });
}

// AVA-8 — the result store: idempotent record keyed by matchup, newest-first reads.
function resultStoreContract(
  name: string,
  make: () => AvaResultStore,
  uniq: (p: string) => string,
): void {
  describe(`AvaResultStore — ${name}`, () => {
    it('records an outcome, reads it back, and is idempotent by matchup', async () => {
      const store = make();
      const [mu, a, b] = [uniq('r-mu'), uniq('r-a'), uniq('r-b')];
      await store.record({ matchupId: mu, challengerCorp: a, targetCorp: b, winnerCorp: a, at: 10 });
      expect(await store.get(mu)).toEqual({
        matchupId: mu,
        challengerCorp: a,
        targetCorp: b,
        winnerCorp: a,
        at: 10,
      });
      // A second record for the same matchup keeps the first (belt-and-braces).
      await store.record({ matchupId: mu, challengerCorp: a, targetCorp: b, winnerCorp: b, at: 20 });
      expect((await store.get(mu))?.winnerCorp).toBe(a);
      expect(await store.get(uniq('missing'))).toBeNull();
    });

    it('a draw stores a null winner; recent() returns newest first', async () => {
      const store = make();
      const [m1, m2, a, b] = [uniq('r-m1'), uniq('r-m2'), uniq('r-c'), uniq('r-d')];
      await store.record({ matchupId: m1, challengerCorp: a, targetCorp: b, winnerCorp: null, at: 5 });
      await store.record({ matchupId: m2, challengerCorp: a, targetCorp: b, winnerCorp: b, at: 9 });
      // Explicit big limit: the pg tables are SHARED across runs (see `stamp` above),
      // so rows accumulate — the default top-50 window eventually crowds out this
      // run's tiny `at` values (surfaced locally after ~15 gate runs in one day).
      const recent = (await store.recent(100_000)).filter(
        (r) => r.matchupId === m1 || r.matchupId === m2,
      );
      expect(recent.map((r) => r.matchupId)).toEqual([m2, m1]); // newest (at=9) first
      expect(recent[1]?.winnerCorp).toBeNull();
    });

    it('statsForCorp counts a corp matches (either side) and its wins', async () => {
      const store = make();
      const [a, b, c] = [uniq('s-a'), uniq('s-b'), uniq('s-c')];
      await store.record({ matchupId: uniq('sm1'), challengerCorp: a, targetCorp: b, winnerCorp: a, at: 1 });
      await store.record({ matchupId: uniq('sm2'), challengerCorp: b, targetCorp: a, winnerCorp: b, at: 2 });
      await store.record({ matchupId: uniq('sm3'), challengerCorp: a, targetCorp: c, winnerCorp: null, at: 3 });
      expect(await store.statsForCorp(a)).toEqual({ matches: 3, wins: 1 }); // 3 matches, 1 win
      expect(await store.statsForCorp(b)).toEqual({ matches: 2, wins: 1 });
      expect(await store.statsForCorp(uniq('none'))).toEqual({ matches: 0, wins: 0 });
    });
  });
}

// Medals (corporations.md §3, MED-1) — permanent, idempotent per (account, medal).
function medalStoreContract(name: string, make: () => MedalStore, uniq: (p: string) => string): void {
  describe(`MedalStore — ${name}`, () => {
    it('grants idempotently, reads back newest-first, and reports `has`', async () => {
      const store = make();
      const acc = uniq('acc');
      expect(await store.grant({ accountId: acc, medalId: 'm1', corpId: uniq('c'), at: 10 })).toBe(true);
      expect(await store.grant({ accountId: acc, medalId: 'm1', corpId: uniq('c'), at: 20 })).toBe(false); // dup
      expect(await store.grant({ accountId: acc, medalId: 'm2', corpId: null, at: 30 })).toBe(true);
      expect(await store.has(acc, 'm1')).toBe(true);
      expect(await store.has(acc, 'nope')).toBe(false);
      const mine = await store.medalsOf(acc);
      expect(mine.map((m) => m.medalId)).toEqual(['m2', 'm1']); // newest (at=30) first
      expect(mine.find((m) => m.medalId === 'm1')?.at).toBe(10); // first grant kept, not overwritten
      expect(await store.medalsOf(uniq('other'))).toEqual([]);
    });
  });
}

/** ARS-4 — the drop-loop contract: the (match, account) claim is exactly-once, pity
 *  reads/writes round-trip, shard credits accumulate atomically. Both adapters. */
function dropStoreContract(name: string, make: () => DropStore, uniq: (p: string) => string): void {
  describe(`DropStore — ${name}`, () => {
    it('claim is exactly-once per (match, account); other pairs are independent', async () => {
      const store = make();
      const m = uniq('drop-m1');
      const acc = uniq('drop-acc');
      expect(await store.claim(m, acc)).toBe(true);
      expect(await store.claim(m, acc)).toBe(false); // a replayed match end rolls nothing
      expect(await store.claim(m, uniq('drop-other'))).toBe(true);
      expect(await store.claim(uniq('drop-m2'), acc)).toBe(true);
    });

    it('pity round-trips and defaults to 0; shard credits accumulate', async () => {
      const store = make();
      const acc = uniq('drop-pity');
      expect(await store.pityOf(acc)).toBe(0);
      await store.setPity(acc, 3);
      expect(await store.pityOf(acc)).toBe(3);
      await store.setPity(acc, 0);
      expect(await store.pityOf(acc)).toBe(0);
      expect(await store.shardsOf(acc)).toBe(0);
      await store.addShards(acc, 2);
      await store.addShards(acc, 5);
      expect(await store.shardsOf(acc)).toBe(7);
      expect(await store.shardsOf(uniq('drop-nobody'))).toBe(0);
    });
  });
}

// AVA-7 — the session store: one per matchup/instance, read by match or by matchup.
/** ARS-2 — the arsenal contract: idempotent grant, owner-guarded transfer/consume,
 *  soulbound never moves. Run against BOTH adapters. */
function arsenalStoreContract(
  name: string,
  make: () => ArsenalStore,
  uniq: (p: string) => string,
): void {
  describe(`ArsenalStore — ${name}`, () => {
    const blueprint = (itemId: string, accountId: string, defId = 'cruiser'): OwnedArsenalItem => ({
      itemId,
      accountId,
      kind: 'hull',
      form: 'blueprint',
      defId,
      soulbound: true,
      origin: 'starter',
      acquiredAt: 1,
    });
    const instance = (itemId: string, accountId: string): OwnedArsenalItem => ({
      itemId,
      accountId,
      kind: 'module',
      form: 'instance',
      defId: 'ion_engine',
      grade: 2,
      soulbound: false,
      durability: 5,
      origin: 'auction',
      acquiredAt: 2,
    });

    it('grant is idempotent by itemId — a replayed grant never duplicates or rewrites', async () => {
      const store = make();
      const [acc, item] = [uniq('acc-g'), uniq('it-g')];
      await store.grant(blueprint(item, acc));
      await store.grant({ ...blueprint(item, uniq('acc-thief')), defId: 'dropship' }); // replay → no-op
      const owned = await store.get(item);
      expect(owned).toMatchObject({ accountId: acc, defId: 'cruiser' }); // first write won
      expect(await store.listOf(acc)).toHaveLength(1);
    });

    it('lists an account’s items round-tripped byte-for-byte, sorted', async () => {
      const store = make();
      const acc = uniq('acc-l');
      await store.grant(instance(uniq('it-b'), acc));
      await store.grant(blueprint(uniq('it-a'), acc, 'scout_drone'));
      const items = await store.listOf(acc);
      expect(items.map((i) => i.kind)).toEqual(['hull', 'module']); // sorted by kind first
      expect(items[1]).toMatchObject({ grade: 2, durability: 5, origin: 'auction' });
      expect(await store.listOf(uniq('acc-other'))).toHaveLength(0); // scoped by owner
    });

    it('transfer moves ownership exactly once — the double-sell loses', async () => {
      const store = make();
      const [seller, buyer1, buyer2, item] = [uniq('a-s'), uniq('a-b1'), uniq('a-b2'), uniq('it-t')];
      await store.grant(instance(item, seller));
      expect(await store.transfer(item, seller, buyer1)).toEqual({ ok: true });
      // the second buyer's transfer references the OLD owner — nothing changes
      expect(await store.transfer(item, seller, buyer2)).toEqual({ ok: false, code: 'E_NOT_OWNER' });
      expect((await store.get(item))?.accountId).toBe(buyer1);
    });

    it('a SOULBOUND item never transfers (anti-RMT, structural)', async () => {
      const store = make();
      const [acc, item] = [uniq('a-sb'), uniq('it-sb')];
      await store.grant(blueprint(item, acc)); // soulbound: true
      expect(await store.transfer(item, acc, uniq('a-x'))).toEqual({
        ok: false,
        code: 'E_SOULBOUND',
      });
      expect((await store.get(item))?.accountId).toBe(acc);
    });

    it('consume removes only the owner’s item, once', async () => {
      const store = make();
      const [acc, item] = [uniq('a-c'), uniq('it-c')];
      await store.grant(instance(item, acc));
      expect(await store.consume(item, uniq('a-notmine'))).toBe(false); // owner-guard
      expect(await store.consume(item, acc)).toBe(true);
      expect(await store.consume(item, acc)).toBe(false); // already gone
      expect(await store.get(item)).toBeNull();
    });

    it('wear decrements an instance’s durability, clamped at 0 (ARS-6 rental sink)', async () => {
      const store = make();
      const [acc, item] = [uniq('a-w'), uniq('it-w')];
      await store.grant(instance(item, acc)); // durability: 5
      expect(await store.wear(item, 2)).toEqual({ durability: 3 });
      expect(await store.wear(item, 10)).toEqual({ durability: 0 }); // clamped, never negative
      expect((await store.get(item))?.durability).toBe(0);
    });

    it('wear is a no-op on a blueprint (no durability field) and null on a missing item', async () => {
      const store = make();
      const [acc, item] = [uniq('a-wb'), uniq('it-wb')];
      await store.grant(blueprint(item, acc)); // no durability
      expect(await store.wear(item, 1)).toEqual({ durability: undefined });
      expect(await store.wear(uniq('nope'), 1)).toBeNull();
    });
  });
}

function corpRentStoreContract(
  name: string,
  make: () => CorpRentStore,
  uniq: (p: string) => string,
): void {
  describe(`CorpRentStore — ${name}`, () => {
    it('rent is atomic — an item can be on rent to at most one war at a time', async () => {
      const store = make();
      const [item, corp, mu1, mu2, acc] = [uniq('it'), uniq('corp'), uniq('mu1'), uniq('mu2'), uniq('acc')];
      expect(await store.rent({ itemId: item, corpId: corp, matchupId: mu1, accountId: acc, rentedAt: 1 })).toBe(true);
      // same item, a second war — refused, first rental untouched
      expect(await store.rent({ itemId: item, corpId: corp, matchupId: mu2, accountId: acc, rentedAt: 2 })).toBe(false);
      expect(await store.activeForMatchup(mu1)).toHaveLength(1);
      expect(await store.activeForMatchup(mu2)).toHaveLength(0);
    });

    it('activeForAccount scopes to the (matchup, account) pair', async () => {
      const store = make();
      const [itemA, itemB, corp, mu, acc1, acc2] = [
        uniq('it-a'), uniq('it-b'), uniq('corp'), uniq('mu'), uniq('acc1'), uniq('acc2'),
      ];
      await store.rent({ itemId: itemA, corpId: corp, matchupId: mu, accountId: acc1, rentedAt: 1 });
      await store.rent({ itemId: itemB, corpId: corp, matchupId: mu, accountId: acc2, rentedAt: 1 });
      expect((await store.activeForAccount(mu, acc1)).map((r) => r.itemId)).toEqual([itemA]);
      expect((await store.activeForAccount(mu, acc2)).map((r) => r.itemId)).toEqual([itemB]);
    });

    it('closeRent is exactly-once — a replayed war-end return changes nothing the second time', async () => {
      const store = make();
      const [item, corp, mu, acc] = [uniq('it-c'), uniq('corp'), uniq('mu-c'), uniq('acc')];
      await store.rent({ itemId: item, corpId: corp, matchupId: mu, accountId: acc, rentedAt: 1 });
      expect(await store.closeRent(mu, item)).toBe(true); // first close wins
      expect(await store.closeRent(mu, item)).toBe(false); // replay — nothing to close
      expect(await store.activeForMatchup(mu)).toHaveLength(0);
      // the item is free again — a NEW war can rent it
      expect(await store.rent({ itemId: item, corpId: corp, matchupId: uniq('mu2'), accountId: acc, rentedAt: 2 })).toBe(true);
    });
  });
}

function sessionStoreContract(
  name: string,
  make: () => AvaSessionStore,
  uniq: (p: string) => string,
): void {
  describe(`AvaSessionStore — ${name}`, () => {
    it('creates a session, reads it by match and by matchup, round-tripping seats', async () => {
      const store = make();
      const [match, matchup] = [uniq('s-match'), uniq('s-mu')];
      const seats = { [uniq('acc-a')]: 'slot_a', [uniq('acc-b')]: 'slot_b' };
      expect(await store.create({ matchId: match, matchupId: matchup, mapId: 'ava-duel-1', seats, at: 7 })).toEqual({
        ok: true,
      });
      expect(await store.byMatch(match)).toEqual({
        matchId: match,
        matchupId: matchup,
        mapId: 'ava-duel-1',
        seats,
        at: 7,
      });
      expect((await store.byMatchup(matchup))?.matchId).toBe(match);
      expect(await store.byMatch(uniq('missing'))).toBeNull();
    });

    it('rejects a second session for the same matchup or the same match id', async () => {
      const store = make();
      const [match, matchup] = [uniq('s-m2'), uniq('s-mu2')];
      await store.create({ matchId: match, matchupId: matchup, mapId: 'ava-duel-1', seats: {}, at: 1 });
      // same matchup, different match id → rejected (one session per matchup)
      expect(
        await store.create({ matchId: uniq('s-m3'), matchupId: matchup, mapId: 'ava-duel-1', seats: {}, at: 2 }),
      ).toEqual({ ok: false, code: 'E_SESSION_EXISTS' });
      // same match id, different matchup → rejected (PK)
      expect(
        await store.create({ matchId: match, matchupId: uniq('s-mu3'), mapId: 'ava-duel-1', seats: {}, at: 3 }),
      ).toEqual({ ok: false, code: 'E_SESSION_EXISTS' });
    });

    it('AVA-8: dueWar keys off warAt; markWarDeclared stamps exactly once', async () => {
      const store = make();
      const [match, matchup] = [uniq('s-m4'), uniq('s-mu4')];
      await store.create({
        matchId: match,
        matchupId: matchup,
        mapId: 'ava-duel-1',
        seats: {},
        at: 1,
        warAt: 100,
      });
      // a session WITHOUT a war schedule never enters the queue (pre-S6 rows)
      const [legacy, legacyMu] = [uniq('s-m5'), uniq('s-mu5')];
      await store.create({ matchId: legacy, matchupId: legacyMu, mapId: 'ava-duel-1', seats: {}, at: 1 });
      expect(await store.markWarDeclared(legacy, 50)).toBe(false);

      expect((await store.dueWar(99)).map((s) => s.matchId)).not.toContain(match); // not due yet
      expect((await store.dueWar(100)).map((s) => s.matchId)).toContain(match);
      expect((await store.dueWar(100)).map((s) => s.matchId)).not.toContain(legacy);

      expect(await store.markWarDeclared(match, 100)).toBe(true);
      expect(await store.markWarDeclared(match, 101)).toBe(false); // exactly once
      expect((await store.byMatch(match))?.warDeclaredAt).toBe(100);
      expect((await store.dueWar(9999)).map((s) => s.matchId)).not.toContain(match); // out of the queue
    });
  });
}

function rosterStoreContract(
  name: string,
  make: () => { challenges: AvaChallengeStore; roster: AvaRosterStore },
  uniq: (p: string) => string,
): void {
  describe(`AvaRosterStore — ${name}`, () => {
    const entry = (matchupId: string, accountId: string, side: AvaSide): AvaRosterEntry => ({
      matchupId,
      accountId,
      side,
      source: 'self',
      at: 1,
    });
    /** A real accepted matchup row to roster against (the Postgres cap guard
     *  serializes on it via FOR UPDATE). */
    async function acceptedMatchup(stores: ReturnType<typeof make>, id: string): Promise<void> {
      await stores.challenges.createChallenge(
        challenge(id, uniq(`${id}-a`), uniq(`${id}-b`), 1000),
      );
      await stores.challenges.closeChallenge(id, 'accepted');
    }

    it('one row per (matchup, account); the per-side cap is guarded', async () => {
      const stores = make();
      const id = uniq('mu1');
      await acceptedMatchup(stores, id);
      expect(await stores.roster.addEntry(entry(id, uniq('p1'), 'challenger'), 2)).toEqual({
        ok: true,
      });
      expect(await stores.roster.addEntry(entry(id, uniq('p1'), 'challenger'), 2)).toEqual({
        ok: false,
        code: 'E_ALREADY_ROSTERED',
      });
      expect(await stores.roster.addEntry(entry(id, uniq('p2'), 'challenger'), 2)).toEqual({
        ok: true,
      });
      expect(await stores.roster.addEntry(entry(id, uniq('p3'), 'challenger'), 2)).toEqual({
        ok: false,
        code: 'E_ROSTER_FULL',
      });
      // The OTHER side has its own cap.
      expect(await stores.roster.addEntry(entry(id, uniq('p3'), 'target'), 2)).toEqual({
        ok: true,
      });
      expect(await stores.roster.rosterOf(id)).toHaveLength(3);
    });

    it('replaceSide swaps one side wholesale and leaves the other untouched', async () => {
      const stores = make();
      const id = uniq('mu2');
      await acceptedMatchup(stores, id);
      await stores.roster.addEntry(entry(id, uniq('q1'), 'challenger'), 4);
      await stores.roster.addEntry(entry(id, uniq('q2'), 'target'), 4);
      await stores.roster.replaceSide(id, 'challenger', [
        { ...entry(id, uniq('q3'), 'challenger'), source: 'flagged' },
        { ...entry(id, uniq('q4'), 'challenger'), source: 'flagged' },
      ]);
      const rows = await stores.roster.rosterOf(id);
      expect(rows.filter((r) => r.side === 'challenger').map((r) => r.accountId).sort()).toEqual(
        [uniq('q3'), uniq('q4')].sort(),
      );
      expect(rows.filter((r) => r.side === 'target').map((r) => r.accountId)).toEqual([uniq('q2')]);
    });
  });
}


// AVA-9 — the public feed store: append-only, newest-first, `before`-`at` pagination.
// `at` values are salted per run so pages on the SHARED Postgres tables stay unique.
function feedStoreContract(name: string, make: () => AvaFeedStore, uniq: (p: string) => string): void {
  describe(`AvaFeedStore — ${name}`, () => {
    it('appends matchup + result rows and reads them newest-first, paginating by `before`', async () => {
      const store = make();
      const [a, b] = [uniq('A'), uniq('B')];
      const tag = uniq('t');
      const base = Date.now();
      await store.append({
        id: uniq('f1'),
        at: base + 10,
        kind: 'matchup',
        challengerCorp: a,
        challengerName: `${tag}-A`,
        targetCorp: b,
        targetName: `${tag}-B`,
      });
      await store.append({
        id: uniq('f2'),
        at: base + 20,
        kind: 'result',
        challengerCorp: a,
        challengerName: `${tag}-A`,
        targetCorp: b,
        targetName: `${tag}-B`,
        winnerCorp: a,
      });
      const mine = (rows: Awaited<ReturnType<AvaFeedStore['recent']>>): typeof rows =>
        rows.filter((r) => r.challengerName === `${tag}-A`);
      const all = mine(await store.recent(50, base + 1_000));
      expect(all.map((r) => r.kind)).toEqual(['result', 'matchup']); // newest first
      expect(all[0]).toMatchObject({ kind: 'result', winnerCorp: a });
      expect(all[1]).toMatchObject({ kind: 'matchup' }); // a matchup carries no winner
      expect(all[1]?.winnerCorp).toBeUndefined();
      // the `before` cursor excludes rows at/after the cursor `at`
      const page = mine(await store.recent(50, base + 20));
      expect(page.map((r) => r.kind)).toEqual(['matchup']);
    });
  });
}

matchStoreContract('memory', () => new MemoryMatchStore(), (p) => p);
accountStoreContract('memory', () => new MemoryAccountStore(), (p) => p);
receiptStoreContract('memory', () => new MemoryReceiptStore(), (p) => p);
userStoreContract('memory', () => new MemoryUserStore(), (p) => p);
feedStoreContract('memory', () => new MemoryAvaFeedStore(), (p) => p);
corpStoreContract(
  'memory',
  () => new MemoryCorpStore(),
  (p) => p,
);
avaChallengeStoreContract(
  'memory',
  () => new MemoryAvaChallengeStore(),
  (p) => p,
);
rosterStoreContract(
  'memory',
  () => ({ challenges: new MemoryAvaChallengeStore(), roster: new MemoryAvaRosterStore() }),
  (p) => p,
);
resultStoreContract('memory', () => new MemoryAvaResultStore(), (p) => p);
sessionStoreContract('memory', () => new MemoryAvaSessionStore(), (p) => p);
arsenalStoreContract('memory', () => new MemoryArsenalStore(), (p) => p);
corpRentStoreContract('memory', () => new MemoryCorpRentStore(), (p) => p);
dropStoreContract('memory', () => new MemoryDropStore(), (p) => p);
medalStoreContract('memory', () => new MemoryMedalStore(), (p) => p);

// Postgres adapters — only when a DATABASE_URL is provided (skipped in CI without a
// DB, so the gate stays green). Verified locally against a real Postgres 16.
const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)('Postgres adapters', () => {
  const pool = new Pool({ connectionString: DB });

  beforeAll(async () => {
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // The corp contract from above, against the real tables. The stamp keeps names and
  // account ids unique across runs (shared tables) while STABLE within one run — the
  // contract asks for the same key several times and must get the same id back.
  const stamp = `${process.pid}_${Date.now()}`;
  corpStoreContract(
    'postgres',
    () => new PostgresCorpStore(pool),
    (p) => `${p}_${stamp}`,
  );
  avaChallengeStoreContract(
    'postgres',
    () => new PostgresAvaChallengeStore(pool),
    (p) => `${p}_${stamp}`,
  );
  rosterStoreContract(
    'postgres',
    () => ({
      challenges: new PostgresAvaChallengeStore(pool),
      roster: new PostgresAvaRosterStore(pool),
    }),
    (p) => `${p}_${stamp}`,
  );
  resultStoreContract('postgres', () => new PostgresAvaResultStore(pool), (p) => `${p}_${stamp}`);
  sessionStoreContract('postgres', () => new PostgresAvaSessionStore(pool), (p) => `${p}_${stamp}`);
  arsenalStoreContract('postgres', () => new PostgresArsenalStore(pool), (p) => `${p}_${stamp}`);
  corpRentStoreContract('postgres', () => new PostgresCorpRentStore(pool), (p) => `${p}_${stamp}`);
  dropStoreContract('postgres', () => new PostgresDropStore(pool), (p) => `${p}_${stamp}`);
  medalStoreContract('postgres', () => new PostgresMedalStore(pool), (p) => `${p}_${stamp}`);

  // The SAME contracts the memory adapter runs — no weakened hand copies.
  matchStoreContract('postgres', () => new PostgresMatchStore(pool), (p) => `${p}_${stamp}`);
  accountStoreContract('postgres', () => new PostgresAccountStore(pool), (p) => `${p}_${stamp}`);
  receiptStoreContract('postgres', () => new PostgresReceiptStore(pool), (p) => `${p}_${stamp}`);
  userStoreContract('postgres', () => new PostgresUserStore(pool), (p) => `${p}_${stamp}`);
  feedStoreContract('postgres', () => new PostgresAvaFeedStore(pool), (p) => `${p}_${stamp}`);

  it('migrates idempotently', async () => {
    await migrate(pool);
    await migrate(pool); // twice → no error (IF NOT EXISTS)
  });
});
