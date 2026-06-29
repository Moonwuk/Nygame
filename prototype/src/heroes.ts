/**
 * Hero roster model — grades + ability "modules". Confirmed design: heroes come in
 * GRADES (rarity), and a hero's module-slot count grows with its grade —
 *   обычный 1 · редкий 2 · легендарный 3 · главный 4.
 * The "главный" hero is special: it is always present, named after the player's
 * callsign, and (Phase B) handed out from the start. Grade is an intrinsic property of
 * a hero (like a collectible's rarity) — the player doesn't pick it; until a hero
 * acquisition/collection system lands, the roster is a fixed set of default heroes.
 *
 * Pure + data-driven, like the formation roster. This is the menu-facing MODEL +
 * preview; in-match instances / capital / respawn / in-match re-fit are later phases.
 */

/** Hero grades, lowest → highest. The slot count is the number of module slots. */
export type HeroGrade = 'common' | 'rare' | 'legendary' | 'main';
export interface HeroGradeDef {
  name: string;
  slots: number;
  icon: string;
}
export const HERO_GRADES: Record<HeroGrade, HeroGradeDef> = {
  common: { name: 'Обычный', slots: 1, icon: '◦' },
  rare: { name: 'Редкий', slots: 2, icon: '◈' },
  legendary: { name: 'Легендарный', slots: 3, icon: '★' },
  main: { name: 'Главный', slots: 4, icon: '♛' },
};
/** Module slots a grade grants (degrades to 1 on an unknown grade). */
export function heroSlots(grade: HeroGrade): number {
  return HERO_GRADES[grade]?.slots ?? 1;
}

/** Heroes a player fields per session (the main hero + 3 others). */
export const HERO_ROSTER_COUNT = 4;

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

/** Ability ids the inventory walks (the pool keys, stable order). */
export const HERO_ABILITY_IDS: string[] = Object.keys(HERO_ABILITIES);

/** A hero in the roster: a name + grade (fixes the slot count) + ability slots (id or
 *  null), one entry per grade slot. The base +5% combat aura is implicit on every hero. */
export interface HeroLoadout {
  name: string;
  grade: HeroGrade;
  abilities: (string | null)[];
}

/** The default roster: the main hero (renamed to the player's callsign) + one of each
 *  other grade, so all four rarities are represented until hero acquisition lands. */
export const DEFAULT_HEROES: HeroLoadout[] = [
  { name: 'Командир', grade: 'main', abilities: ['corridor', 'rally', 'scan', 'bulwark'] },
  { name: 'Разрушитель', grade: 'legendary', abilities: ['annihilate', 'scan', 'recall'] },
  { name: 'Авангард', grade: 'rare', abilities: ['corridor', 'rally'] },
  { name: 'Страж', grade: 'common', abilities: ['bulwark'] },
];

/** Aggregate readout of a loadout for the designer preview. */
export interface HeroLoadoutInfo {
  /** Filled slots (non-null, resolvable). */
  count: number;
  /** Total slots the grade grants. */
  slots: number;
  /** Resolved abilities in slot order (unknown ids dropped). */
  abilities: HeroAbility[];
  /** How many chosen abilities aren't wired in the engine yet (shown as "скоро"). */
  planned: number;
}

/** Resolve a loadout's filled slots to ability defs + counts, bounded by its grade's
 *  slot count. Pure; unknown / empty / over-cap slots are skipped (graceful). */
export function heroLoadoutInfo(loadout: HeroLoadout): HeroLoadoutInfo {
  const slots = heroSlots(loadout.grade);
  const abilities: HeroAbility[] = [];
  for (const id of loadout.abilities.slice(0, slots)) {
    if (!id) continue;
    const a = HERO_ABILITIES[id];
    if (a) abilities.push(a);
  }
  return { count: abilities.length, slots, abilities, planned: abilities.filter((a) => !a.live).length };
}
