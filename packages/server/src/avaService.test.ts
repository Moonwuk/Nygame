import { describe, expect, it } from 'vitest';
import { AvaService } from './avaService';
import { CorpService, type CorpActor } from './corpService';
import { MemoryAvaChallengeStore, MemoryAvaRosterStore, MemoryCorpStore } from './store';

// AVA-2/3/4 — readiness + the S0→S2 challenge state machine — and AVA-6, the roster
// window, enforced fail-secure. Every gate is exercised both ways; influence is
// checked to balance exactly across spend / refund; expiry and the roster sweep run
// with no client, on the injected clock.

const A_HEAD: CorpActor = { accountId: 'a-head', login: 'ahead' };
const A_MEMBER: CorpActor = { accountId: 'a-mem', login: 'amember' };
const B_HEAD: CorpActor = { accountId: 'b-head', login: 'bhead' };
const OUTSIDER: CorpActor = { accountId: 'out', login: 'outsider' };

interface Fixture {
  ava: AvaService;
  corp: CorpService;
  store: MemoryCorpStore;
  corpA: string;
  corpB: string;
  clock: () => number;
}

/** Two corps A (head + member) and B (head), each with `influence` credited. */
async function fixture(
  opts: { influenceA?: number; influenceB?: number; cost?: number; capPerSide?: number } = {},
): Promise<Fixture> {
  const store = new MemoryCorpStore();
  const challenges = new MemoryAvaChallengeStore();
  let t = 0;
  const now = (): number => ++t;
  const corp = new CorpService({ store, now });
  const ava = new AvaService({
    corpStore: store,
    challengeStore: challenges,
    rosterStore: new MemoryAvaRosterStore(),
    now,
    challengeCost: opts.cost ?? 100,
    expiryMs: 1_000,
    pauseMs: 1_000,
    capPerSide: opts.capPerSide ?? 2,
    minPerSide: 1,
  });

  const a = await corp.create(A_HEAD, 'Alliance A');
  const b = await corp.create(B_HEAD, 'Alliance B');
  if (!a.ok || !b.ok) throw new Error('fixture: create failed');
  await corp.apply(A_MEMBER, a.corpId);
  await corp.accept(A_HEAD, a.corpId, A_MEMBER.accountId);
  await store.addInfluence(a.corpId, opts.influenceA ?? 500);
  await store.addInfluence(b.corpId, opts.influenceB ?? 500);
  return { ava, corp, store, corpA: a.corpId, corpB: b.corpId, clock: (): number => t };
}

describe('AvaService — readiness (AVA-3)', () => {
  it('only the head flags the corp; a member flags only their own consent', async () => {
    const { ava, corpA } = await fixture();
    expect(await ava.setCorpReady(A_MEMBER)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    expect(await ava.setCorpReady(A_HEAD)).toEqual({ ok: true });
    expect((await ava.pool()).map((c) => c.corpId)).toContain(corpA);

    expect(await ava.setPlayerReady(OUTSIDER)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    expect(await ava.setPlayerReady(A_MEMBER)).toEqual({ ok: true });
    expect(await ava.setPlayerReady(A_HEAD)).toEqual({ ok: true });
  });

  it('leaving the corp revokes the player consent', async () => {
    const { ava, corp, store, corpA } = await fixture();
    await ava.setPlayerReady(A_MEMBER);
    expect(await store.readyPlayersOf(corpA)).toContain(A_MEMBER.accountId);
    await corp.leave(A_MEMBER, corpA);
    expect(await store.readyPlayersOf(corpA)).not.toContain(A_MEMBER.accountId);
  });
});

describe('AvaService — challenge S0→S2 (AVA-4)', () => {
  async function ready(f: Fixture): Promise<void> {
    await f.ava.setCorpReady(A_HEAD);
    await f.ava.setCorpReady(B_HEAD);
  }

  it('challenge → accept: influence spent stays spent, status accepted (S2)', async () => {
    const f = await fixture();
    await ready(f);
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(400); // 500 − 100
    expect(await f.ava.accept(B_HEAD, ch.id)).toEqual({ ok: true });
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(400); // war funded — not refunded
    const list = await f.ava.challengesFor(B_HEAD);
    expect(list[0]).toMatchObject({
      status: 'accepted',
      challengerCorp: f.corpA,
      targetCorp: f.corpB,
    });
  });

  it('challenge → decline refunds the challenger in full', async () => {
    const f = await fixture();
    await ready(f);
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    expect(await f.ava.decline(B_HEAD, ch.id)).toEqual({ ok: true });
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(500); // fully refunded
  });

  it('expiry refunds without any client, on the injected clock', async () => {
    const f = await fixture();
    await ready(f);
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    expect(await f.ava.sweepExpired(1)).toBe(0); // not yet due (expiryMs 1000)
    const closed = await f.ava.sweepExpired(1_000_000);
    expect(closed).toBe(1);
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(500); // refunded on expiry
    expect((await f.ava.challengesFor(A_HEAD))[0]).toMatchObject({ status: 'expired' });
  });

  it('rejects self-challenge, an unready pair, and insufficient influence', async () => {
    const f = await fixture({ influenceA: 50 });
    // corps aren't in the ready pool yet → E_NOT_READY (the head gate already passed)
    expect(await f.ava.challenge(A_HEAD, f.corpB)).toEqual({ ok: false, code: 'E_NOT_READY' });
    await ready(f);
    expect(await f.ava.challenge(A_HEAD, f.corpA)).toEqual({ ok: false, code: 'E_SELF_CHALLENGE' });
    expect(await f.ava.challenge(A_HEAD, f.corpB)).toEqual({ ok: false, code: 'E_INSUFFICIENT' }); // 50 < 100
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(50); // nothing spent on the failed attempt
  });

  it('a non-head cannot challenge, accept or decline', async () => {
    const f = await fixture();
    await ready(f);
    expect(await f.ava.challenge(A_MEMBER, f.corpB)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    // only the TARGET head answers — the challenger head cannot accept their own
    expect(await f.ava.accept(A_HEAD, ch.id)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    expect(await f.ava.accept(OUTSIDER, ch.id)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
  });

  it('one pending challenge per pair; refunds the blocked second attempt', async () => {
    const f = await fixture();
    await ready(f);
    const first = await f.ava.challenge(A_HEAD, f.corpB);
    if (!first.ok) throw new Error('first failed');
    const second = await f.ava.challenge(A_HEAD, f.corpB);
    expect(second).toEqual({ ok: false, code: 'E_ALREADY_CHALLENGED' });
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(400); // blocked attempt was refunded (only 100 gone)
  });

  it('double-accept race: the second accept sees a closed challenge', async () => {
    const f = await fixture();
    await ready(f);
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    expect(await f.ava.accept(B_HEAD, ch.id)).toEqual({ ok: true });
    expect(await f.ava.accept(B_HEAD, ch.id)).toEqual({ ok: false, code: 'E_CHALLENGE_CLOSED' });
    expect(await f.ava.decline(B_HEAD, ch.id)).toEqual({ ok: false, code: 'E_CHALLENGE_CLOSED' });
  });

  it('a missing challenge id is E_NO_CHALLENGE', async () => {
    const f = await fixture();
    expect(await f.ava.accept(B_HEAD, 'nope')).toEqual({ ok: false, code: 'E_NO_CHALLENGE' });
  });
});

describe('AvaService — roster window S3 (AVA-6)', () => {
  /** Ready both corps, run challenge → accept, return the matchup id. */
  async function matchup(f: Fixture): Promise<string> {
    await f.ava.setCorpReady(A_HEAD);
    await f.ava.setCorpReady(B_HEAD);
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    const accepted = await f.ava.accept(B_HEAD, ch.id);
    if (!accepted.ok) throw new Error('accept failed');
    return ch.id;
  }

  it('accept opens the roster window (pauseEndsAt stamped on the matchup)', async () => {
    const f = await fixture();
    await matchup(f);
    const row = (await f.ava.challengesFor(A_HEAD))[0];
    expect(row?.status).toBe('accepted');
    expect(row?.pauseEndsAt).toBeGreaterThan(f.clock());
  });

  it('setRoster: head/officer only, flagged pool only, capped by the side slots', async () => {
    const f = await fixture();
    const id = await matchup(f);
    // A plain member cannot curate; an unflagged pick is rejected wholesale.
    expect(await f.ava.setRoster(A_MEMBER, id, [])).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    expect(await f.ava.setRoster(A_HEAD, id, [A_MEMBER.accountId])).toEqual({
      ok: false,
      code: 'E_NOT_FLAGGED',
    });
    // Flag both, curate both — the side is replaced wholesale.
    await f.ava.setPlayerReady(A_HEAD);
    await f.ava.setPlayerReady(A_MEMBER);
    expect(
      await f.ava.setRoster(A_HEAD, id, [A_HEAD.accountId, A_MEMBER.accountId]),
    ).toEqual({ ok: true });
    const view = await f.ava.rosterView(A_HEAD, id);
    if ('ok' in view) throw new Error('view failed');
    expect(view.mine.map((r) => r.accountId).sort()).toEqual([
      A_HEAD.accountId,
      A_MEMBER.accountId,
    ]);
    // Over the cap (2) — rejected before anything changes.
    expect(
      await f.ava.setRoster(A_HEAD, id, [A_HEAD.accountId, A_MEMBER.accountId, 'ghost']),
    ).toEqual({ ok: false, code: 'E_ROSTER_FULL' });
  });

  it('join: a member self-enrolls (unflagged too), idempotently; outsiders never', async () => {
    const f = await fixture();
    const id = await matchup(f);
    expect(await f.ava.join(A_MEMBER, id)).toEqual({ ok: true }); // unflagged — showing up IS consent
    expect(await f.ava.join(A_MEMBER, id)).toEqual({ ok: true }); // already in = desired state
    expect(await f.ava.join(OUTSIDER, id)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    const view = await f.ava.rosterView(A_MEMBER, id);
    if ('ok' in view) throw new Error('view failed');
    expect(view.mine).toHaveLength(1);
    expect(view.mine[0]).toMatchObject({ accountId: A_MEMBER.accountId, source: 'self' });
  });

  it('join respects the per-side cap', async () => {
    const f = await fixture({ capPerSide: 1 });
    const id = await matchup(f);
    expect(await f.ava.join(A_HEAD, id)).toEqual({ ok: true });
    expect(await f.ava.join(A_MEMBER, id)).toEqual({ ok: false, code: 'E_ROSTER_FULL' });
    expect(await f.ava.join(B_HEAD, id)).toEqual({ ok: true }); // the OTHER side has its own cap
  });

  it('the opponent roster stays private — headcount only', async () => {
    const f = await fixture();
    const id = await matchup(f);
    await f.ava.join(A_HEAD, id);
    await f.ava.join(A_MEMBER, id);
    const view = await f.ava.rosterView(B_HEAD, id);
    if ('ok' in view) throw new Error('view failed');
    expect(view.side).toBe('target');
    expect(view.mine).toHaveLength(0); // B has nobody yet…
    expect(view.counts).toEqual({ challenger: 2, target: 0 }); // …and sees only A's COUNT
    expect(await f.ava.rosterView(OUTSIDER, id)).toEqual({ ok: false, code: 'E_FORBIDDEN' });
  });

  it('sweep locks a full roster exactly once; writes freeze after the lock', async () => {
    const f = await fixture();
    const id = await matchup(f);
    await f.ava.join(A_HEAD, id);
    await f.ava.join(B_HEAD, id);
    expect(await f.ava.sweepRosters(1)).toEqual({ locked: 0, cancelled: 0 }); // window still open
    expect(await f.ava.sweepRosters(1_000_000)).toEqual({ locked: 1, cancelled: 0 });
    expect(await f.ava.sweepRosters(1_000_000)).toEqual({ locked: 0, cancelled: 0 }); // exactly once
    expect((await f.ava.challengesFor(A_HEAD))[0]?.status).toBe('locked');
    expect(await f.ava.join(A_MEMBER, id)).toEqual({ ok: false, code: 'E_ROSTER_LOCKED' });
    await f.ava.setPlayerReady(A_HEAD);
    expect(await f.ava.setRoster(A_HEAD, id, [A_HEAD.accountId])).toEqual({
      ok: false,
      code: 'E_ROSTER_LOCKED',
    });
  });

  it('sweep cancels a short-side matchup and refunds the challenge cost once', async () => {
    const f = await fixture();
    const id = await matchup(f);
    await f.ava.join(A_HEAD, id); // side B never gathers anyone
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(400); // cost still spent
    expect(await f.ava.sweepRosters(1_000_000)).toEqual({ locked: 0, cancelled: 1 });
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(500); // refunded on cancel
    expect((await f.ava.challengesFor(A_HEAD))[0]?.status).toBe('cancelled');
    expect(await f.ava.sweepRosters(1_000_000)).toEqual({ locked: 0, cancelled: 0 }); // no double refund
    expect((await f.store.getCorp(f.corpA))?.influence).toBe(500);
    expect(await f.ava.join(A_MEMBER, id)).toEqual({ ok: false, code: 'E_WINDOW_CLOSED' });
  });

  it('a pending (not yet accepted) challenge has no roster window', async () => {
    const f = await fixture();
    await f.ava.setCorpReady(A_HEAD);
    await f.ava.setCorpReady(B_HEAD);
    const ch = await f.ava.challenge(A_HEAD, f.corpB);
    if (!ch.ok) throw new Error('challenge failed');
    expect(await f.ava.join(A_HEAD, ch.id)).toEqual({ ok: false, code: 'E_WINDOW_CLOSED' });
  });
});
