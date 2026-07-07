/**
 * META-PROGRESSION (прокачка командующего) — the account-level tech trees.
 *
 * Players EARN experience by finishing matches (participation + score + victory)
 * and SPEND progression points in three branches. This is the Bytro-genre rank
 * ladder: progress comes only from play — it is never sold (docs/main-menu.md §5:
 * premium buys convenience/cosmetics, NEVER combat power; these trees are not
 * purchasable).
 *
 * Design:
 *  - XP → commander LEVEL (rising thresholds); each level past 1 grants ONE point.
 *  - A node costs its TIER in points and requires the previous node of its branch —
 *    three straight tracks, no webs (readable on a phone, no respec in v1).
 *  - Node effects reuse EXISTING session seams, no new engine code: hidden session
 *    technologies granted as `completed` at match start (their bonuses ride the
 *    normal tech hooks), a scientist-council level bump, and a starting-treasury
 *    multiplier. Everything is snapshotted at newGame — deterministic, replay-safe.
 *  - Persistence v1 is per-callsign localStorage (the prototype's guest identity);
 *    the server account (SE-1.x) takes over when the meta-layer lands there.
 *
 * Pure module: no DOM, no storage access — main.ts feeds it state and persists.
 */

export type MetaBranch = 'command' | 'economy' | 'science';

export interface MetaNode {
  id: string;
  branch: MetaBranch;
  /** 1..4 within the branch — also the node's cost in points. */
  tier: number;
  /** Russian source strings (the i18n msgid convention) — render through t(). */
  name: string;
  desc: string;
  /** Hidden session technologies granted as `completed` at match start. */
  tech?: string[];
  /** +N to the scientist council's level at match start. */
  scientistLevel?: number;
  /** Starting-treasury multiplier bonus (0.1 = +10%), summed across nodes. */
  startResources?: number;
}

export interface MetaState {
  xp: number;
  /** Unlocked node ids, in unlock order. */
  spent: string[];
}

export const META_BRANCH_RU: Record<MetaBranch, string> = {
  command: 'Командование',
  economy: 'Экономика',
  science: 'Наука',
};

/** The three progression tracks. Costs total 1+2+3+4 = 10 points per branch —
 *  a full tree is a long campaign, the first nodes land within a few matches. */
export const META_TREE: MetaNode[] = [
  // --- Командование: флотоводец растёт от манёвра к удару ------------------------
  { id: 'cmd1', branch: 'command', tier: 1, name: 'Ходовые школы', desc: '+5% к скорости всех флотов с первой секунды матча.', tech: ['meta_drill_speed'] },
  { id: 'cmd2', branch: 'command', tier: 2, name: 'Слаженные экипажи', desc: '+5% к урону флотов и гарнизонов.', tech: ['meta_drill_combat'] },
  { id: 'cmd3', branch: 'command', tier: 3, name: 'Дальняя разведка', desc: '+15% к радиусу всех радаров.', tech: ['meta_drill_radar'] },
  { id: 'cmd4', branch: 'command', tier: 4, name: 'Ветеран кампаний', desc: 'Ещё +5% к скорости и урону — рефлексы старой гвардии.', tech: ['meta_drill_veteran'] },
  // --- Экономика: тыл решает --------------------------------------------------------
  { id: 'eco1', branch: 'economy', tier: 1, name: 'Хозяйственник', desc: '+10% к стартовой казне каждого матча.', startResources: 0.1 },
  { id: 'eco2', branch: 'economy', tier: 2, name: 'Индустриализация', desc: '+5% к производству всех миров.', tech: ['meta_industry'] },
  { id: 'eco3', branch: 'economy', tier: 3, name: 'Госрезерв', desc: 'Ещё +20% к стартовой казне.', startResources: 0.2 },
  { id: 'eco4', branch: 'economy', tier: 4, name: 'Магнат', desc: 'Ещё +5% к производству — империя работает на вас.', tech: ['meta_industry_2'] },
  // --- Наука: совет учёных набирает вес ---------------------------------------------
  { id: 'sci1', branch: 'science', tier: 1, name: 'Аспирантура', desc: 'Учёные совета начинают матч на +1 уровень.', scientistLevel: 1 },
  { id: 'sci2', branch: 'science', tier: 2, name: 'Открытый архив', desc: '«Промышленная автоматизация» изучена с первой секунды.', tech: ['industrial_automation'] },
  { id: 'sci3', branch: 'science', tier: 3, name: 'Сеть институтов', desc: 'Учёные совета — ещё +1 уровень.', scientistLevel: 1 },
  { id: 'sci4', branch: 'science', tier: 4, name: 'Орбитальная кафедра', desc: '«Орбитальная логистика» изучена с первой секунды.', tech: ['orbital_logistics'] },
];

const byId = new Map(META_TREE.map((n) => [n.id, n]));

/** XP needed to go from `level` to `level+1`: 100, 150, 200, … — early ranks land
 *  fast (a match or two), the tail is a season-long grind. */
export function xpToNext(level: number): number {
  return 100 + (Math.max(1, level) - 1) * 50;
}

/** Commander level for a lifetime XP total (level 1 at 0 XP). */
export function metaLevel(xp: number): number {
  let level = 1;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return level;
}

/** XP progress inside the current level: [earned, needed]. */
export function metaLevelProgress(xp: number): [number, number] {
  let level = 1;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return [rest, xpToNext(level)];
}

/** Points earned over a lifetime (one per level past 1) minus points spent. */
export function metaPoints(state: MetaState): number {
  const earned = metaLevel(state.xp) - 1;
  const spent = state.spent.reduce((a, id) => a + (byId.get(id)?.tier ?? 0), 0);
  return earned - spent;
}

/** Can this node be unlocked NOW? Straight track: needs the previous tier of its
 *  branch, not already owned, and enough free points. */
export function canUnlock(state: MetaState, nodeId: string): boolean {
  const node = byId.get(nodeId);
  if (!node || state.spent.includes(nodeId)) return false;
  if (node.tier > 1) {
    const prev = META_TREE.find((n) => n.branch === node.branch && n.tier === node.tier - 1);
    if (!prev || !state.spent.includes(prev.id)) return false;
  }
  return metaPoints(state) >= node.tier;
}

/** Unlock a node (validated; returns the NEW state or null if not allowed). */
export function unlockNode(state: MetaState, nodeId: string): MetaState | null {
  if (!canUnlock(state, nodeId)) return null;
  return { xp: state.xp, spent: [...state.spent, nodeId] };
}

/** XP for one finished match: showing up + the scoreboard + the win. Tuned so an
 *  average match is ~a level early on: 40 base, score tops out around +100. */
export function matchXp(result: { won: boolean; score: number }): number {
  return 40 + Math.min(100, Math.floor(Math.max(0, result.score) / 10)) + (result.won ? 160 : 0);
}

/** What the unlocked tree grants a match at newGame — the ONLY bridge into the
 *  session (snapshot semantics, like scientists/templates: no live account reads). */
export function metaGrant(state: MetaState): {
  tech: string[];
  scientistLevel: number;
  resourceMult: number;
} {
  const out = { tech: [] as string[], scientistLevel: 0, resourceMult: 0 };
  for (const id of state.spent) {
    const n = byId.get(id);
    if (!n) continue;
    for (const tid of n.tech ?? []) if (!out.tech.includes(tid)) out.tech.push(tid);
    out.scientistLevel += n.scientistLevel ?? 0;
    out.resourceMult += n.startResources ?? 0;
  }
  return out;
}

/** Parse a persisted blob (fail-secure: garbage → a fresh account). */
export function parseMetaState(raw: string | null): MetaState {
  if (!raw) return { xp: 0, spent: [] };
  try {
    const v = JSON.parse(raw) as { xp?: unknown; spent?: unknown };
    const xp = typeof v.xp === 'number' && Number.isFinite(v.xp) && v.xp >= 0 ? Math.floor(v.xp) : 0;
    const spent = Array.isArray(v.spent) ? v.spent.filter((x): x is string => typeof x === 'string' && byId.has(x)) : [];
    return { xp, spent };
  } catch {
    return { xp: 0, spent: [] };
  }
}
