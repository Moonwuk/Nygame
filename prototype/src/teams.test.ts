import { describe, it, expect } from 'vitest';
import { newGame, DEFAULT_SETUP, START_CANDIDATES, type SeatConfig } from './game';
import { getStance } from '../../packages/shared-core/src/index';

// A team battle seeds diplomacy by side: same team ALLIED, across teams at WAR. A
// free-for-all (no team on any seat) keeps the classic all-peace seeding. Seeded
// state, so an AI teammate is a real ally (bypasses the E_BOT_ALLIANCE declare-gate);
// the SES-1 victory clique reads the alliance stance, so the coalition forms.
describe('team battle — diplomacy seeded by side', () => {
  const FOUR: SeatConfig[] = [
    { id: 'p1', name: 'A1', faction: 'blue', start: DEFAULT_SETUP.seats[0]!.start, ai: false },
    { id: 'p2', name: 'A2', faction: 'red', start: DEFAULT_SETUP.seats[1]!.start, ai: true },
    { id: 'p3', name: 'B1', faction: 'green', start: DEFAULT_SETUP.seats[0]!.start, ai: true },
    { id: 'p4', name: 'B2', faction: 'amber', start: DEFAULT_SETUP.seats[1]!.start, ai: true },
  ];

  it('2v2 — teammates ALLIED, opponents at WAR', () => {
    const seats = FOUR.map((s, i) => ({ ...s, team: i < 2 ? 'A' : 'B' }));
    const st = newGame({ seats });
    expect(getStance(st, 'p1', 'p2')).toBe('alliance'); // team A
    expect(getStance(st, 'p3', 'p4')).toBe('alliance'); // team B
    expect(getStance(st, 'p1', 'p3')).toBe('war'); // A vs B
    expect(getStance(st, 'p1', 'p4')).toBe('war');
    expect(getStance(st, 'p2', 'p3')).toBe('war');
  });

  it('an AI teammate is really allied (not blocked like a declared bot alliance)', () => {
    const seats = FOUR.map((s, i) => ({ ...s, team: i < 2 ? 'A' : 'B' }));
    const st = newGame({ seats });
    // p2 is AI, yet shares team A with the human p1 — seeded alliance stands.
    expect(getStance(st, 'p1', 'p2')).toBe('alliance');
  });

  it('no team on any seat ⇒ classic free-for-all (all pairs at PEACE)', () => {
    const st = newGame({ seats: FOUR }); // no `team`
    expect(getStance(st, 'p1', 'p2')).toBe('peace');
    expect(getStance(st, 'p1', 'p3')).toBe('peace');
    expect(getStance(st, 'p3', 'p4')).toBe('peace');
  });

  it('a lone seat with no team in a team match is at WAR with everyone', () => {
    const seats = [
      { ...FOUR[0]!, team: 'A' },
      { ...FOUR[1]!, team: 'A' },
      { ...FOUR[2]! }, // no team — a lone wolf
    ];
    const st = newGame({ seats });
    expect(getStance(st, 'p1', 'p2')).toBe('alliance');
    expect(getStance(st, 'p1', 'p3')).toBe('war'); // lone seat vs team A
    expect(getStance(st, 'p2', 'p3')).toBe('war');
  });

  it('5v5 seeds alliances and wars across all ten seats', () => {
    const factions = ['blue', 'red', 'amber', 'violet'];
    const seats: SeatConfig[] = START_CANDIDATES.map((start, i) => ({
      id: `p${i + 1}`,
      name: `Player ${i + 1}`,
      faction: factions[i % factions.length]!,
      start,
      ai: i > 0,
      team: i < 5 ? 'A' : 'B',
    }));
    const st = newGame({ seats });
    expect(getStance(st, 'p1', 'p5')).toBe('alliance');
    expect(getStance(st, 'p6', 'p10')).toBe('alliance');
    expect(getStance(st, 'p1', 'p6')).toBe('war');
    expect(getStance(st, 'p5', 'p10')).toBe('war');
  });
});
