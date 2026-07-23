import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type { Context, GameState, Player } from '../../packages/shared-core/src/index';
import { hungerModule, HUNGER_MULT, data } from './game';

// ECON-1 «голодная армия»: food в arrears владельца → его НАЗЕМНЫЙ урон
// ×HUNGER_MULT (0.75). Корабли едят кредиты — орбитальная фаза не тронута.
// Модуль — чистый вклад в хук combat.damage; тестируется через probe-модуль,
// зовущий пайплайн ровно так, как combat.ts зовёт его на каждом раунде
// (владелец бьющей стороны приходит в args.attacker).

const ctx: Context = { now: 0, data };

const probeKernel = createKernel([
  hungerModule,
  {
    id: 'probe',
    version: '0.0.0',
    setup(api) {
      api.onAction('probe.hit', (action, h) => {
        const p = action.payload as { base: number; phase: string; attacker: string };
        const out = h.hook<number>('combat.damage', p.base, {
          battleId: 'b1',
          phase: p.phase,
          location: 'X',
          attacker: p.attacker,
          defender: 'other',
        });
        (h.state as GameState & { probed?: number }).probed = out;
      });
    },
  },
]);

function player(id: string, arrears?: string[]): Player {
  return {
    id,
    name: id,
    faction: 'x',
    status: 'active',
    resources: { credits: 100 },
    ...(arrears ? { arrears } : {}),
  } as Player;
}

function stateWith(players: Player[]): GameState {
  const s = createInitialState({ seed: 'hunger', version: { data: '0.1.0', manifest: '1' } });
  const map: Record<string, Player> = {};
  for (const p of players) map[p.id] = p;
  return { ...s, players: map };
}

function damageOf(state: GameState, base: number, phase: string, attacker: string): number {
  const r = probeKernel.applyAction(
    state,
    {
      id: 'a:1',
      type: 'probe.hit',
      playerId: attacker,
      payload: { base, phase, attacker },
      issuedAt: 0,
    },
    ctx,
  );
  if (!r.ok) throw new Error(r.code);
  return (r.state as GameState & { probed?: number }).probed ?? NaN;
}

describe('ECON-1 · hungerModule', () => {
  it('ground damage of a food-starved owner is cut by exactly 25%', () => {
    const s = stateWith([player('green', ['food']), player('red')]);
    expect(damageOf(s, 100, 'ground', 'green')).toBeCloseTo(100 * HUNGER_MULT);
  });

  it('the orbital phase is untouched — ships run on credits, not rations', () => {
    const s = stateWith([player('green', ['food'])]);
    expect(damageOf(s, 100, 'orbital', 'green')).toBe(100);
  });

  it('no arrears → full damage; non-food arrears (credits) does not starve troops', () => {
    expect(damageOf(stateWith([player('green')]), 100, 'ground', 'green')).toBe(100);
    expect(damageOf(stateWith([player('green', ['credits'])]), 100, 'ground', 'green')).toBe(100);
  });

  it('a two-sided fight starves only the starving side', () => {
    const s = stateWith([player('green', ['food']), player('red')]);
    expect(damageOf(s, 80, 'ground', 'green')).toBeCloseTo(80 * HUNGER_MULT);
    expect(damageOf(s, 80, 'ground', 'red')).toBe(80);
  });
});
