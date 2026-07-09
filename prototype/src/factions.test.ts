import { describe, it, expect } from 'vitest';
import { newGame, advance, data, kernel, START_CANDIDATES } from './game';
import type { SetupConfig } from './game';

// H3 — factions are PURE passive bonuses to the economy or units (for now), applied by
// the core factionModule through the same hooks as technologies. The hooks themselves
// are pinned in shared-core's faction.test.ts; here we pin the PROTOTYPE wiring: the
// catalog shape, the kernel carrying the module, the seat faction reaching the player,
// and the economy passive actually moving a real match's treasury.

const HOUR = 3_600_000;
const solo = (faction: string): SetupConfig => ({
  seats: [{ id: 'p1', name: 'X', faction, start: START_CANDIDATES[0]!, ai: false }],
});

describe('factions (H3) — passive house bonuses over the prototype data', () => {
  it('the catalog carries the four houses, purely economy-or-units passives', () => {
    expect(Object.keys(data.factions).sort()).toEqual(['amber', 'blue', 'red', 'violet']);
    for (const f of Object.values(data.factions)) {
      // pure passives: no unique units / faction abilities, no radar reach —
      // strictly «экономика или юниты» (production / damage / fleet speed).
      expect(f.uniqueUnits).toEqual([]);
      expect(f.abilities).toEqual([]);
      expect(f.passives.radarRangeBonus).toBe(0);
      const sum = f.passives.productionBonus + f.passives.combatDamageBonus + f.passives.fleetSpeedBonus;
      expect(sum).toBeGreaterThan(0);
    }
  });

  it('the kernel carries factionModule; the chosen seat faction lands on the player', () => {
    expect(kernel.manifest.modules.map((m) => m.id)).toContain('faction');
    expect(newGame(solo('red')).players.p1?.faction).toBe('red');
  });

  it('the production passive moves a real treasury: blue (+12% economy) out-earns red', () => {
    const blue = newGame(solo('blue'));
    const red = newGame(solo('red'));
    const metal = (s: typeof blue): number => s.players.p1!.resources.metal ?? 0;
    const b0 = metal(blue);
    const r0 = metal(red);
    const db = metal(advance(blue, blue.time + 10 * HOUR).state) - b0;
    const dr = metal(advance(red, red.time + 10 * HOUR).state) - r0;
    // Identical world, mine and clock — only the house differs. Red's combat passive
    // must not touch production; blue's +12% must show up in the mined metal.
    expect(dr).toBeGreaterThan(0);
    expect(db).toBeGreaterThan(dr);
  });
});
