import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  advance,
  declareWar,
  botFavour,
  botEmbargoes,
  DEFAULT_SETUP,
  FAVOUR_BASE,
  FAVOUR_WAR,
  FAVOUR_WAR_DECLARED_HIT,
  DAY,
  HOUR,
} from './game';
import { getStance, getOffer } from '../../packages/shared-core/src/index';

// In the default setup p1 is the human, p2 the AI (a tracked bot).
describe('bot diplomacy — favour meter', () => {
  it('starts friendly toward the player and stays passive — never wars unprovoked', () => {
    const s = newGame();
    expect(botFavour(s, 'p2', 'p1')).toBe(FAVOUR_BASE);
    // A month with no aggression: the bot never declares war; favour stays capped.
    const st = advance(s, 30 * DAY).state;
    expect(getStance(st, 'p1', 'p2')).toBe('peace');
    expect(botFavour(st, 'p2', 'p1')).toBe(FAVOUR_BASE);
  });

  it('declaring war on a bot sours its favour toward the declarer', () => {
    const st = order(newGame(), declareWar('p1', 'p2'), 0).state;
    expect(botFavour(st, 'p2', 'p1')).toBe(FAVOUR_BASE - FAVOUR_WAR_DECLARED_HIT);
  });

  it('sustained aggression bottoms the meter out and the bot commits to war', () => {
    let st = order(newGame(), declareWar('p1', 'p2'), 0).state; // 60 → 30
    st = advance(st, 20 * DAY).state; // 20 days at war erode favour under the war line
    expect(botFavour(st, 'p2', 'p1')).toBeLessThan(FAVOUR_WAR);
    // The player sues for peace, but the furious bot declines the offer — war holds.
    st = order(st, declareWar('p1', 'p2', 'peace'), st.time).state;
    st = advance(st, st.time + HOUR).state;
    expect(getStance(st, 'p1', 'p2')).toBe('war');
  });

  it('a bot that is left alone accepts peace and mends its favour', () => {
    // Declare war then immediately make peace: favour dropped once, then heals over time.
    let st = order(newGame(), declareWar('p1', 'p2'), 0).state;
    st = order(st, declareWar('p1', 'p2', 'peace'), 0).state; // back to peace right away
    const dropped = botFavour(st, 'p2', 'p1');
    st = advance(st, 20 * DAY).state; // long stretch of peace mends it
    expect(getStance(st, 'p1', 'p2')).toBe('peace'); // never re-warred
    expect(botFavour(st, 'p2', 'p1')).toBeGreaterThan(dropped);
  });

  it('botEmbargoes reports the embargo tier; a non-bot never embargoes', () => {
    const st = order(newGame(), declareWar('p1', 'p2'), 0).state; // 60 → 30, below the embargo line
    expect(botEmbargoes(st, 'p2', 'p1')).toBe(true);
    expect(botEmbargoes(st, 'p1', 'p2')).toBe(false); // p1 is human, tracks no favour
  });
});

// Softening a stance needs the other side's consent (game.ts diplomacyModule): the
// declaration files an OFFER; the matching counter-declaration commits the pair. A
// bot answers inside the same order (by favour); a human's offer waits for a reply.
describe('diplomacy consent — offers, counters, bot answers', () => {
  // The two-humans board the netserver seeds: same seats, nobody tracked as a bot.
  const HUMANS = { seats: DEFAULT_SETUP.seats.map((seat) => ({ ...seat, ai: false })) };

  it('softening files an offer that hangs until the human answers in kind', () => {
    let st = order(newGame(HUMANS), declareWar('p1', 'p2'), 0).state; // escalation: instant
    expect(getStance(st, 'p1', 'p2')).toBe('war');
    st = order(st, declareWar('p2', 'p1', 'peace'), 0).state; // p2 sues for peace
    expect(getStance(st, 'p1', 'p2')).toBe('war'); // …still at war
    expect(getOffer(st, 'p2', 'p1')).toBe('peace'); // …offer on the table
    st = order(st, declareWar('p1', 'p2', 'peace'), 0).state; // p1 answers in kind
    expect(getStance(st, 'p1', 'p2')).toBe('peace'); // pair committed
    expect(getOffer(st, 'p2', 'p1')).toBeNull(); // table wiped both ways
    expect(getOffer(st, 'p1', 'p2')).toBeNull();
  });

  it('duplicate offer → E_ALREADY_OFFERED, same-stance declaration → E_SAME_STANCE', () => {
    let st = order(newGame(HUMANS), declareWar('p1', 'p2'), 0).state;
    st = order(st, declareWar('p1', 'p2', 'peace'), 0).state;
    expect(order(st, declareWar('p1', 'p2', 'peace'), 0).error).toBe('E_ALREADY_OFFERED');
    expect(order(st, declareWar('p1', 'p2', 'war'), 0).error).toBe('E_SAME_STANCE');
    // a DIFFERENT softening replaces the offer instead of stacking
    st = order(st, declareWar('p1', 'p2', 'pact'), 0).state;
    expect(getOffer(st, 'p1', 'p2')).toBe('pact');
  });

  it('escalation voids offers in flight — no stale auto-accept after a war', () => {
    let st = order(newGame(HUMANS), declareWar('p2', 'p1', 'pact'), 0).state; // peace→pact offer
    expect(getOffer(st, 'p2', 'p1')).toBe('pact');
    st = order(st, declareWar('p1', 'p2'), 0).state; // p1 escalates — table wiped
    expect(getOffer(st, 'p2', 'p1')).toBeNull();
    st = order(st, declareWar('p1', 'p2', 'pact'), 0).state; // p1 proposes the same later
    expect(getStance(st, 'p1', 'p2')).toBe('war'); // p2's stale offer must NOT commit it
    expect(getOffer(st, 'p1', 'p2')).toBe('pact');
  });

  it('a bot accepts peace on the spot while favour holds the line', () => {
    const st = order(newGame(), declareWar('p1', 'p2'), 0).state; // favour 60 → 30 ≥ 15
    const r = order(st, declareWar('p1', 'p2', 'peace'), 0).state;
    expect(getStance(r, 'p1', 'p2')).toBe('peace');
    expect(getOffer(r, 'p1', 'p2')).toBeNull();
  });

  it('a furious bot declines and wipes the offer, so the seat can retry', () => {
    let st = order(newGame(), declareWar('p1', 'p2'), 0).state;
    st = advance(st, 20 * DAY).state; // favour bottoms out under FAVOUR_WAR
    st = order(st, declareWar('p1', 'p2', 'peace'), st.time).state;
    expect(getStance(st, 'p1', 'p2')).toBe('war'); // refused
    expect(getOffer(st, 'p1', 'p2')).toBeNull(); // wiped — not stuck as "already offered"
    expect(order(st, declareWar('p1', 'p2', 'peace'), st.time).error).toBeUndefined();
  });

  it('a fresh bot accepts a pact; an alliance with a bot stays barred', () => {
    const st0 = newGame(); // favour 60 ≥ FAVOUR_PACT_ACCEPT
    expect(getStance(order(st0, declareWar('p1', 'p2', 'pact'), 0).state, 'p1', 'p2')).toBe('pact');
    expect(order(st0, declareWar('p1', 'p2', 'alliance'), 0).error).toBe('E_BOT_ALLIANCE');
  });
});
