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
      if (!def || def.productionBonus === 0) {
        return bag;
      }
      const out: Record<string, number> = {};
      for (const res of Object.keys(bag)) {
        out[res] = (bag[res] ?? 0) * (1 + def.productionBonus);
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
