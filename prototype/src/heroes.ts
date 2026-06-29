/**
 * Hero roster model — the "модули = набор способностей" design (confirmed with the
 * designer). A player fields up to HERO_ROSTER_COUNT heroes per session; each carries
 * HERO_SLOTS ability slots ("modules") filled from a shared pool, plus the implicit
 * base combat aura every hero grants its fleet.
 *
 * Pure + data-driven, exactly like the formation roster (`game.ts` formations): this
 * module is just the menu-facing MODEL + preview. The in-match hero instances, the
 * designatable capital, death→24h→player-respawn, and in-match re-fitting land in the
 * next phases — here we only let the player COMPOSE the roster before the match.
 */

/** Ability slots ("modules") per hero. */
export const HERO_SLOTS = 2;
/** Heroes a player fields per session. */
export const HERO_ROSTER_COUNT = 3;

/** One selectable hero ability ("module"). `live` = its in-match effect already exists
 *  in the engine (the core heroModule); a non-live ability is designed but shows as
 *  "скоро" until the in-match hero phase wires its effect. */
export interface HeroAbility {
  id: string;
  name: string;
  icon: string;
  desc: string;
  cooldownHours: number;
  live: boolean;
}

/** The pool a hero's slots draw from (tunable content). `corridor` / `annihilate` are
 *  already wired in the core heroModule (temp lane / planet annihilation); the rest are
 *  designed here and gain their effect in the in-match hero phase. */
export const HERO_ABILITIES: Record<string, HeroAbility> = {
  corridor: {
    id: 'corridor',
    name: 'Коридор',
    icon: '〜',
    desc: 'Открывает временный коридор-лейн до близкого мира; свои флоты идут по нему быстрее.',
    cooldownHours: 12,
    live: true,
  },
  annihilate: {
    id: 'annihilate',
    name: 'Аннигиляция',
    icon: '☢',
    desc: 'Уничтожает планету в радиусе — она становится мёртвым миром.',
    cooldownHours: 48,
    live: true,
  },
  rally: {
    id: 'rally',
    name: 'Сбор',
    icon: '⚑',
    desc: 'Боевой клич: временный доп. бонус к ауре для своих флотов рядом с героем.',
    cooldownHours: 18,
    live: false,
  },
  scan: {
    id: 'scan',
    name: 'Разведка',
    icon: '◎',
    desc: 'Раскрывает зону вокруг цели сквозь туман на время.',
    cooldownHours: 10,
    live: false,
  },
  recall: {
    id: 'recall',
    name: 'Отзыв',
    icon: '⟲',
    desc: 'Мгновенно отзывает корабль-героя в столицу.',
    cooldownHours: 24,
    live: false,
  },
  bulwark: {
    id: 'bulwark',
    name: 'Бастион',
    icon: '⛨',
    desc: 'Временный щит: +оборона своим флотам рядом с героем.',
    cooldownHours: 20,
    live: false,
  },
};

/** Ability ids the slot cycler walks (the pool keys, stable order). */
export const HERO_ABILITY_IDS: string[] = Object.keys(HERO_ABILITIES);

/** A hero in the roster: a name + exactly HERO_SLOTS ability slots (id or null). The
 *  base +5% combat aura is implicit on every hero; the slots add tactical abilities. */
export interface HeroLoadout {
  name: string;
  abilities: (string | null)[];
}

/** Three starter heroes (the player renames / re-fits them before the match, and can
 *  re-fit in-match at the capital — a later phase). */
export const DEFAULT_HEROES: HeroLoadout[] = [
  { name: 'Авангард', abilities: ['corridor', 'rally'] },
  { name: 'Разрушитель', abilities: ['annihilate', 'scan'] },
  { name: 'Страж', abilities: ['bulwark', 'recall'] },
];

/** Aggregate readout of a loadout for the designer preview. */
export interface HeroLoadoutInfo {
  /** Filled slots (non-null, resolvable). */
  count: number;
  /** Resolved abilities in slot order (unknown ids dropped). */
  abilities: HeroAbility[];
  /** How many chosen abilities aren't wired in the engine yet (shown as "скоро"). */
  planned: number;
}

/** Resolve a loadout's filled slots to ability defs + counts. Pure; unknown / empty
 *  slots are skipped, so it degrades gracefully on stale data. */
export function heroLoadoutInfo(loadout: HeroLoadout): HeroLoadoutInfo {
  const abilities: HeroAbility[] = [];
  for (const id of loadout.abilities) {
    if (!id) continue;
    const a = HERO_ABILITIES[id];
    if (a) abilities.push(a);
  }
  return { count: abilities.length, abilities, planned: abilities.filter((a) => !a.live).length };
}
