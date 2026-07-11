import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createInitialState, type GameState } from '@void/shared-core';
import {
  MemoryAccountStore,
  MemoryAvaChallengeStore,
  MemoryCorpStore,
  MemoryMatchStore,
  MemoryReceiptStore,
} from './memory';
import {
  PostgresAccountStore,
  PostgresAvaChallengeStore,
  PostgresCorpStore,
  PostgresMatchStore,
  PostgresReceiptStore,
  migrate,
} from './postgres';
import type {
  AccountStore,
  AvaChallenge,
  AvaChallengeStore,
  CorpStore,
  MatchSnapshot,
  MatchStore,
  ReceiptStore,
} from './types';

function state(seed = 'store'): GameState {
  return createInitialState({ seed, version: { data: 't', manifest: 't' } });
}
function snap(matchId: string, seq: number, s: GameState): MatchSnapshot {
  return { matchId, dataVersion: 't', seq, status: 'ongoing', state: s };
}

// Shared behaviour run against BOTH adapters, so memory and Postgres agree.
function matchStoreContract(name: string, make: () => MatchStore): void {
  describe(`MatchStore — ${name}`, () => {
    it('round-trips a snapshot byte-for-byte', async () => {
      const store = make();
      const s = state();
      s.time = 4242;
      await store.save(snap('m1', 5, s));
      const loaded = await store.load('m1');
      expect(loaded?.seq).toBe(5);
      expect(loaded?.state.time).toBe(4242);
      expect(loaded?.state).toEqual(s);
    });

    it('returns null for an unknown match', async () => {
      expect(await make().load('nope')).toBeNull();
    });

    it('is optimistic by seq — an older save never clobbers a newer one', async () => {
      const store = make();
      await store.save(snap('m2', 10, withTime(state(), 1000)));
      await store.save(snap('m2', 3, withTime(state(), 7))); // stale, lower seq
      const loaded = await store.load('m2');
      expect(loaded?.seq).toBe(10);
      expect(loaded?.state.time).toBe(1000);
    });

    it('ping reports the backing store reachable (the /ready probe)', async () => {
      expect(await make().ping?.()).toBe(true);
    });
  });
}

function accountStoreContract(name: string, make: () => AccountStore): void {
  describe(`AccountStore — ${name}`, () => {
    const seats = ['p1', 'p2'] as const;

    it('assigns a free seat and returns the SAME one on return', async () => {
      const store = make();
      const first = await store.resolveSeat('r1', 'alice', seats);
      expect(first).toEqual({ playerId: 'p1', isNew: true });
      const again = await store.resolveSeat('r1', 'alice', seats);
      expect(again).toEqual({ playerId: 'p1', isNew: false }); // resumes her side
    });

    it('gives a different nick the other seat, then rejects a full room', async () => {
      const store = make();
      expect((await store.resolveSeat('r2', 'alice', seats))?.playerId).toBe('p1');
      expect((await store.resolveSeat('r2', 'bob', seats))?.playerId).toBe('p2');
      expect(await store.resolveSeat('r2', 'carol', seats)).toBeNull(); // full
      // but an already-seated nick still resolves even when "full"
      expect((await store.resolveSeat('r2', 'bob', seats))?.playerId).toBe('p2');
    });

    it('seat ticket (REL-5): first bind wins, later binds return the winner', async () => {
      const store = make();
      await store.resolveSeat('r3', 'alice', seats);
      expect(await store.seatTicket('r3', 'alice')).toBeNull(); // nothing bound yet
      expect(await store.bindSeatTicket('r3', 'alice', 'hash-A')).toBe('hash-A'); // we won
      expect(await store.bindSeatTicket('r3', 'alice', 'hash-B')).toBe('hash-A'); // lost → winner
      expect(await store.seatTicket('r3', 'alice')).toBe('hash-A');
      // tickets are seat-scoped: another nick / another room are independent
      await store.resolveSeat('r3', 'bob', seats);
      expect(await store.seatTicket('r3', 'bob')).toBeNull();
      expect(await store.bindSeatTicket('r4', 'alice', 'x')).toBeNull(); // no seat there
    });
  });
}

function withTime(s: GameState, t: number): GameState {
  s.time = t;
  return s;
}

function receiptStoreContract(name: string, make: () => ReceiptStore): void {
  describe(`ReceiptStore — ${name}`, () => {
    it('saves + loads receipts; a re-save of the same action is a no-op (first wins)', async () => {
      const store = make();
      await store.save('m', { actionId: 'a1', playerId: 'p1', seq: 1, ok: true });
      await store.save('m', { actionId: 'a2', playerId: 'p2', seq: 2, ok: false, code: 'E_X' });
      await store.save('m', { actionId: 'a1', playerId: 'p1', seq: 9, ok: true }); // dup → ignored
      const all = await store.loadAll('m');
      expect(all).toHaveLength(2);
      expect(all.find((r) => r.actionId === 'a1')).toMatchObject({ seq: 1, ok: true });
      expect(all.find((r) => r.actionId === 'a2')).toMatchObject({ ok: false, code: 'E_X' });
    });

    it('scopes receipts by match', async () => {
      const store = make();
      await store.save('m1', { actionId: 'a', playerId: 'p1', seq: 1, ok: true });
      expect(await store.loadAll('m2')).toHaveLength(0);
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
  });
}

matchStoreContract('memory', () => new MemoryMatchStore());
accountStoreContract('memory', () => new MemoryAccountStore());
receiptStoreContract('memory', () => new MemoryReceiptStore());
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

// Postgres adapters — only when a DATABASE_URL is provided (skipped in CI without a
// DB, so the gate stays green). Verified locally against a real Postgres 16.
const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)('Postgres adapters', () => {
  const pool = new Pool({ connectionString: DB });
  let n = 0;
  const uniq = (p: string): string => `${p}_${process.pid}_${++n}`;

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

  it('migrates idempotently', async () => {
    await migrate(pool);
    await migrate(pool); // twice → no error (IF NOT EXISTS)
  });

  // Reuse the same contracts, but each call gets unique ids/rooms so tests don't
  // collide on the shared tables.
  it('MatchStore round-trips + is seq-optimistic', async () => {
    await migrate(pool);
    const store = new PostgresMatchStore(pool);
    const id = uniq('m');
    const s = withTime(state(), 999);
    await store.save(snap(id, 7, s));
    expect((await store.load(id))?.state.time).toBe(999);
    await store.save(snap(id, 2, withTime(state(), 1))); // stale
    expect((await store.load(id))?.seq).toBe(7);
    expect((await store.load(id))?.state).toEqual(s);
  });

  it('AccountStore assigns, resumes, and rejects a full room', async () => {
    await migrate(pool);
    const store = new PostgresAccountStore(pool);
    const room = uniq('r');
    const seats = ['p1', 'p2'] as const;
    expect((await store.resolveSeat(room, 'alice', seats))?.playerId).toBe('p1');
    expect(await store.resolveSeat(room, 'alice', seats)).toEqual({ playerId: 'p1', isNew: false });
    expect((await store.resolveSeat(room, 'bob', seats))?.playerId).toBe('p2');
    expect(await store.resolveSeat(room, 'carol', seats)).toBeNull();
  });

  it('AccountStore seat ticket: first bind wins, no seat → null', async () => {
    await migrate(pool);
    const store = new PostgresAccountStore(pool);
    const room = uniq('r');
    await store.resolveSeat(room, 'alice', ['p1', 'p2']);
    expect(await store.seatTicket(room, 'alice')).toBeNull();
    expect(await store.bindSeatTicket(room, 'alice', 'hash-A')).toBe('hash-A');
    expect(await store.bindSeatTicket(room, 'alice', 'hash-B')).toBe('hash-A'); // first wins
    expect(await store.seatTicket(room, 'alice')).toBe('hash-A');
    expect(await store.bindSeatTicket(room, 'nobody', 'x')).toBeNull(); // no seat row
  });

  it('ReceiptStore persists + dedupes by (match, action)', async () => {
    await migrate(pool);
    const store = new PostgresReceiptStore(pool);
    const m = uniq('m');
    await store.save(m, { actionId: 'a1', playerId: 'p1', seq: 1, ok: true });
    await store.save(m, { actionId: 'a1', playerId: 'p1', seq: 9, ok: true }); // dup → ignored
    const all = await store.loadAll(m);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ actionId: 'a1', seq: 1, ok: true });
  });
});
