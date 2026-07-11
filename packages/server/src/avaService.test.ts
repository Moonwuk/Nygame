import { describe, expect, it } from 'vitest';
import { AvaService } from './avaService';
import { CorpService, type CorpActor } from './corpService';
import { MemoryAvaChallengeStore, MemoryCorpStore } from './store';

// AVA-2/3/4 — readiness + the S0→S2 challenge state machine, enforced fail-secure.
// Every gate is exercised both ways; influence is checked to balance exactly across
// spend / refund; expiry runs with no client, on the injected clock.

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
  opts: { influenceA?: number; influenceB?: number; cost?: number } = {},
): Promise<Fixture> {
  const store = new MemoryCorpStore();
  const challenges = new MemoryAvaChallengeStore();
  let t = 0;
  const now = (): number => ++t;
  const corp = new CorpService({ store, now });
  const ava = new AvaService({
    corpStore: store,
    challengeStore: challenges,
    now,
    challengeCost: opts.cost ?? 100,
    expiryMs: 1_000,
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
