import { describe, it, expect } from 'vitest';
import {
  META_TREE,
  metaLevel,
  metaLevelProgress,
  metaPoints,
  canUnlock,
  unlockNode,
  matchXp,
  metaGrant,
  parseMetaState,
  type MetaState,
} from './meta';
import { newGame, data } from './game';

const fresh: MetaState = { xp: 0, spent: [] };

describe('meta-progression — XP, levels and points', () => {
  it('levels rise on growing thresholds (100, then +50 per level)', () => {
    expect(metaLevel(0)).toBe(1);
    expect(metaLevel(99)).toBe(1);
    expect(metaLevel(100)).toBe(2); // 100
    expect(metaLevel(249)).toBe(2);
    expect(metaLevel(250)).toBe(3); // 100+150
    expect(metaLevelProgress(120)).toEqual([20, 150]);
  });

  it('a match pays for showing up, the scoreboard and the win', () => {
    expect(matchXp({ won: false, score: 0 })).toBe(40);
    expect(matchXp({ won: false, score: 500 })).toBe(90);
    expect(matchXp({ won: true, score: 5000 })).toBe(40 + 100 + 160); // score capped
  });

  it('points = levels earned minus tiers spent', () => {
    const st: MetaState = { xp: 1000, spent: [] }; // 100+150+200+250+300 = 1000 → level 6 → 5 pts
    expect(metaLevel(st.xp)).toBe(6);
    expect(metaPoints(st)).toBe(5);
    expect(metaPoints({ ...st, spent: ['cmd1', 'cmd2'] })).toBe(2); // 5 − (1+2)
  });
});

describe('meta-progression — straight-track unlock rules', () => {
  it('tier 1 unlocks with a point; tier 2 needs its predecessor', () => {
    expect(canUnlock(fresh, 'cmd1')).toBe(false); // no points at level 1
    const rich: MetaState = { xp: 1000, spent: [] };
    expect(canUnlock(rich, 'cmd1')).toBe(true);
    expect(canUnlock(rich, 'cmd2')).toBe(false); // cmd1 not owned yet
    const next = unlockNode(rich, 'cmd1')!;
    expect(next.spent).toEqual(['cmd1']);
    expect(canUnlock(next, 'cmd2')).toBe(true);
    expect(unlockNode(next, 'cmd1')).toBeNull(); // no double-buy
  });

  it('persisted garbage parses to a fresh account (fail-secure)', () => {
    expect(parseMetaState(null)).toEqual(fresh);
    expect(parseMetaState('{"xp":-5,"spent":["cmd1","bogus",7]}')).toEqual({ xp: 0, spent: ['cmd1'] });
    expect(parseMetaState('not json')).toEqual(fresh);
  });
});

describe('meta-progression — the grant lands in a real match', () => {
  it('every tech a node grants exists in the game data', () => {
    for (const n of META_TREE) for (const id of n.tech ?? []) expect(data.technologies[id], id).toBeDefined();
  });

  it('metaGrant composes the unlocked nodes into one snapshot', () => {
    const g = metaGrant({ xp: 0, spent: ['cmd1', 'eco1', 'sci1'] });
    expect(g).toEqual({ tech: ['meta_drill_speed'], scientistLevel: 1, resourceMult: 0.1 });
  });

  it('newGame applies the meta grant to the human seat only', () => {
    const g = metaGrant({ xp: 0, spent: ['cmd1', 'eco1', 'eco2', 'sci1'] });
    const s = newGame({
      seats: [
        { id: 'p1', name: 'Me', faction: 'blue', start: 'C1R1', ai: false },
        { id: 'p2', name: 'Bot', faction: 'red', start: 'C5R5', ai: true },
      ],
      meta: g,
    });
    expect(s.players.p1?.technologies?.completed).toEqual(expect.arrayContaining(['meta_drill_speed', 'meta_industry']));
    expect(s.players.p2?.technologies?.completed ?? []).toHaveLength(0);
    expect(s.players.p1?.scientists?.[0]?.level).toBe(2);
    const plain = newGame();
    const base = plain.players.p1?.resources.credits ?? 0;
    expect(s.players.p1?.resources.credits).toBe(Math.round(base * 1.1));
    expect(s.players.p2?.resources.credits).toBe(plain.players.p2?.resources.credits);
  });
});
