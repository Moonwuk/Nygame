import { describe, expect, it } from 'vitest';
import { newGame, economySnapshot, netIncome, HOUR, advance } from './game';

// ECON-6: почасовой экономический срез — чистая функция состояния для пайплайна
// наблюдений хоста (netserver onWake). Кривые (казна/приток/arrears) едут в
// JSONL, headline-счётчики — в MetricsAggregator (тест в packages/server).

describe('economySnapshot — срез экономики для метрик', () => {
  it('несёт казну (копией), netPerHour и arrears каждого игрока на state.time', () => {
    let s = newGame();
    s = advance(s, 5 * HOUR).state; // накопить производство
    const snap = economySnapshot(s);
    expect(snap.kind).toBe('economy');
    expect(snap.atTime).toBe(s.time);
    for (const pid of Object.keys(s.players)) {
      const row = snap.players[pid]!;
      expect(row.resources).toEqual(s.players[pid]!.resources);
      expect(row.netPerHour).toEqual(netIncome(s, pid));
      expect(row.arrears).toEqual(s.players[pid]!.arrears ?? []);
    }
    // копия, не ссылка: мутация среза не трогает состояние
    snap.players.p1!.resources.credits = -1;
    expect(s.players.p1!.resources.credits).not.toBe(-1);
  });

  it('отражает arrears игрока в недоимке', () => {
    const s = newGame();
    (s.players.p1! as { arrears?: string[] }).arrears = ['food', 'energy'];
    expect(economySnapshot(s).players.p1!.arrears).toEqual(['food', 'energy']);
  });
});
