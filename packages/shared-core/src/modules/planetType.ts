import type { GameModule } from '../kernel/module';
import type { ResourceBag } from '../data/schemas';

interface ProductionArgs {
  planetId?: string;
}
interface DamageArgs {
  phase?: string;
  location?: string;
  defender?: string;
}

/**
 * Planet type — an optional content module (docs/modulesystem.md). Each planet
 * carries a `planetType` (data-driven, `data/planetTypes.json`); this module
 * turns the type into buffs/debuffs purely through hooks, exactly like the
 * sector module does for terrain, so the core hard-codes no world rules and runs
 * unchanged without it.
 *
 *   - `economy.production`: scales a world's output by its type's
 *     `productionBonus` (a volcanic / gas world is rich, a barren one poor).
 *   - `combat.damage`: a type's `defenseBonus` adjusts the damage the owner's
 *     garrison takes in a ground assault — a defensible world divides incoming
 *     damage (positive bonus), an exposed one amplifies it (negative) — stacking
 *     with buildings, mirroring the construction module's fortress bonus.
 */
export const planetTypeModule: GameModule = {
  id: 'planet-type',
  version: '1.0.0',
  setup(api) {
    api.hook<ResourceBag>('economy.production', (bag, args, h) => {
      const planetId = (args as ProductionArgs).planetId;
      const type = planetId ? h.state.planets[planetId]?.planetType : undefined;
      const def = type ? h.ctx.data.planetTypes[type] : undefined;
      if (!def) {
        return bag;
      }
      const flat = def.productionBonus; // applies to every resource
      const byRes = def.productionByResource; // extra, per-resource (e.g. dead world: +30% metal)
      const base = def.baseOutput; // ECON-7: passive per-hour output biased by type
      const baseKeys = Object.keys(base);
      if (flat === 0 && Object.keys(byRes).length === 0 && baseKeys.length === 0) {
        return bag; // nothing to add or scale — pass through unchanged
      }
      // Passive base output is added FIRST (so building produces and it share the
      // richness multiplier), then the whole bag is scaled by the type's bonuses.
      const out: Record<string, number> = {};
      for (const res of new Set([...Object.keys(bag), ...baseKeys])) {
        const raw = (bag[res] ?? 0) + (base[res] ?? 0);
        out[res] = raw * (1 + flat) * (1 + (byRes[res] ?? 0));
      }
      return out;
    });

    api.hook<number>('combat.damage', (dmg, args, h) => {
      const { phase, location, defender } = args as DamageArgs;
      if (phase !== 'ground' || !location) {
        return dmg;
      }
      const planet = h.state.planets[location];
      // Only the world's holder (the side being damaged is the defender that owns
      // the planet) gets its terrain defense edge — invaders don't.
      if (!planet || planet.owner !== defender || !planet.planetType) {
        return dmg;
      }
      const def = h.ctx.data.planetTypes[planet.planetType];
      const bonus = def?.defenseBonus ?? 0;
      return bonus !== 0 && 1 + bonus > 0 ? dmg / (1 + bonus) : dmg;
    });
  },
};
