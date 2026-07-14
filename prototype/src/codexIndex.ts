/**
 * ONB-4 · Codex/help index — makes the prototype's existing reference corpus
 * FINDABLE. The single-article renderer (`codexHtml`/`openCodex` in main.ts)
 * already knows every unit and building; this module builds a flat, searchable
 * index over them plus a small glossary of the genre's tricky terms (async,
 * fog, upkeep, orbit/landing, …), so a searchable «?» hub can surface any
 * term/unit/mechanic in two taps.
 *
 * Pure module: no DOM, no i18n, no game imports — main.ts feeds it the loaded
 * game data and the glossary, and localises labels at render time. Search is
 * decoupled from language via an injectable `textOf` (the UI passes one that
 * folds in the localised name, so RU and EN queries both hit).
 */

export type CodexCategory = 'unit' | 'building' | 'mechanic';

/** One findable entry. `key` deep-links into `openCodex` ('u:'/'b:'/'m:'+id). */
export interface CodexEntry {
  key: string;
  /** Base (English) label — the search haystack + a render fallback. */
  title: string;
  category: CodexCategory;
  /** Extra lowercased search terms (domain/line/traits/resource keys/aliases). */
  tags: string[];
}

/** A short mechanic/term article (copy is a locale msgid, rendered through `t()`). */
export interface GlossaryArticle {
  id: string;
  title: string; // canonical-Russian msgid
  body: string; // canonical-Russian msgid
  /** Search aliases (both languages) so «fog» and «туман» both find it. */
  tags: string[];
}

/** The genre's hard concepts as one-screen articles — the "learn the term" layer. */
export const GLOSSARY: GlossaryArticle[] = [
  {
    id: 'async',
    title: 'Асинхронный мир',
    body: 'Мир идёт в реальном времени и продолжается 24/7 — даже когда ты вышел. Приказы занимают реальные часы: отдал курс, закрыл игру, вернулся к результату. Это не пошаговая игра — заходи, отдавай приказы, выходи.',
    tags: ['async', 'асинхрон', 'offline', 'офлайн', 'realtime', 'реальное время', 'время'],
  },
  {
    id: 'fog',
    title: 'Туман войны',
    body: 'Ты видишь только то, что рядом с твоими силами и радарами; остальное скрыто туманом или показано по памяти (последнее, что ты там видел). Разведчики и радары раздвигают обзор — держи глаза открытыми.',
    tags: ['fog', 'туман', 'radar', 'радар', 'разведка', 'видимость', 'scout'],
  },
  {
    id: 'upkeep',
    title: 'Содержание (upkeep)',
    body: 'Флоты и здания требуют ежедневной платы. Доход от шахт минус содержание = чистый баланс; уйдёшь в минус — казна опустеет. Строй экономику раньше армии.',
    tags: ['upkeep', 'содержание', 'экономика', 'казна', 'баланс', 'доход'],
  },
  {
    id: 'capture',
    title: 'Орбита и высадка',
    body: 'Захват мира — двухфазный. Сначала выйди на орбиту и подави оборону в космосе; если мир защищён гарнизоном — высади десант (наземную дивизию из трюма). Небо, потом земля.',
    tags: [
      'orbit',
      'орбита',
      'landing',
      'высадка',
      'capture',
      'захват',
      'десант',
      'assault',
      'штурм',
    ],
  },
  {
    id: 'lanes',
    title: 'Звёздные трассы',
    body: 'Флоты ходят не напрямую, а по звёздным трассам (лэйнам) между мирами — маршрут строится автоматически. Узлы на трассах можно перехватывать: встречный враг на пути — это бой.',
    tags: ['lanes', 'трассы', 'лэйны', 'movement', 'курс', 'маршрут', 'перехват'],
  },
  {
    id: 'score',
    title: 'Очки победы',
    body: 'Очки капают за то, чем ты владеешь: мир — 50, прочий сектор — 10, здания добавляют по уровню. Набери порог очков — победа. Другой путь к победе — уничтожение соперников или доминирование.',
    tags: ['score', 'очки', 'victory', 'победа', 'счёт'],
  },
  {
    id: 'coalition',
    title: 'Коалиционный порог',
    body: 'Дипломатия позволяет заключать пакты и союзы, но коалиция ограничена порогом совокупной силы — нельзя собрать всех против одного. Порог держит баланс сил и не даёт «снежному кому» задавить партию.',
    tags: ['coalition', 'коалиция', 'alliance', 'союз', 'пакт', 'диплом', 'diplomacy', 'порог'],
  },
];

interface CodexData {
  units: Record<string, { domain?: string; line?: string; traits?: string[] }>;
  buildings: Record<string, { name: string; produces?: Record<string, number> }>;
}

/** A stable English label for a unit id ('strike_carrier' → 'strike carrier'). */
function unitLabel(id: string): string {
  return id.replace(/_/g, ' ');
}

/**
 * Flatten the game data + glossary into one searchable index: every unit and
 * building plus each glossary term, each tagged for search and keyed for a
 * deep-link into the single-article codex.
 */
export function buildCodexIndex(
  data: CodexData,
  glossary: GlossaryArticle[] = GLOSSARY,
): CodexEntry[] {
  const entries: CodexEntry[] = [];
  for (const [id, def] of Object.entries(data.units)) {
    entries.push({
      key: 'u:' + id,
      title: unitLabel(id),
      category: 'unit',
      tags: [id, def.domain ?? 'space', def.line ?? '', ...(def.traits ?? [])]
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
    });
  }
  for (const [id, def] of Object.entries(data.buildings)) {
    entries.push({
      key: 'b:' + id,
      title: def.name,
      category: 'building',
      tags: [id, ...Object.keys(def.produces ?? {})].map((s) => s.toLowerCase()),
    });
  }
  for (const g of glossary) {
    entries.push({
      key: 'm:' + g.id,
      title: g.title,
      category: 'mechanic',
      tags: g.tags.map((s) => s.toLowerCase()),
    });
  }
  return entries;
}

/** The default search haystack for an entry: its title + all its tags, lowercased. */
function defaultText(e: CodexEntry): string {
  return (e.title + ' ' + e.tags.join(' ')).toLowerCase();
}

/**
 * Filter the index by a free-text query. An empty/blank query returns EVERY
 * entry (the UI groups those into category sections). Otherwise entries whose
 * title contains the query rank ahead of tag-only matches, order otherwise
 * preserved. `textOf` overrides the haystack so the UI can fold in the localised
 * name — search then hits both languages.
 */
export function searchCodex(
  entries: readonly CodexEntry[],
  query: string,
  textOf: (e: CodexEntry) => string = defaultText,
): CodexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  const titleHits: CodexEntry[] = [];
  const tagHits: CodexEntry[] = [];
  for (const e of entries) {
    if (e.title.toLowerCase().includes(q)) titleHits.push(e);
    else if (textOf(e).includes(q)) tagHits.push(e);
  }
  return [...titleHits, ...tagHits];
}
