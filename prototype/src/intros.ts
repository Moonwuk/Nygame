/**
 * ONB-3 · Just-in-time mechanic intros (progressive disclosure). The FIRST time a
 * player opens an advanced panel (tech / market / steward / shipyard / diplomacy),
 * a one-screen intro card explains it — then never again. This spreads learning
 * across sessions instead of front-loading it, and only surfaces a system at the
 * moment of first contact (docs/onboarding-roadmap.md ONB-3).
 *
 * Pure module: no DOM, no i18n, no storage — main.ts persists the seen-set
 * per-callsign (`vd.seenIntros.<nick>`) and renders the card copy through `t()`.
 * The parser is fail-secure (garbage → empty set) and every op is idempotent.
 */

export type IntroTrigger = 'panelOpen' | 'firstAvailable' | 'firstFail';

/** One intro card — copy is a locale msgid (canonical Russian), shown once. */
export interface IntroCard {
  id: string;
  title: string;
  body: string;
  trigger: IntroTrigger;
}

/** The advanced systems worth a first-contact card. Panel-open triggers for now;
 *  the `trigger` field leaves room for firstAvailable/firstFail (retreat/artillery). */
export const INTROS: IntroCard[] = [
  {
    id: 'tech',
    trigger: 'panelOpen',
    title: 'Дерево технологий',
    body: 'Здесь ты открываешь технологии — постоянные улучшения флота, экономики и обороны. Узел стоит ресурсов и времени; изучил — бонус действует до конца матча. Планируй ветку под свой стиль игры.',
  },
  {
    id: 'market',
    trigger: 'panelOpen',
    title: 'Сессионный рынок',
    body: 'Торгуй ресурсами с другими игроками сессии: выставляй свои лоты и забирай чужие. Рынок сглаживает нехватку — обменяй излишек одного ресурса на тот, которого не хватает.',
  },
  {
    id: 'steward',
    trigger: 'panelOpen',
    title: 'Хранитель — ИИ на сон',
    body: 'Уходишь надолго? Передай оборону Хранителю — он будет держать твои миры по заданным правилам, пока тебя нет. Мир идёт 24/7, но базовая защита останется, даже когда ты офлайн.',
  },
  {
    id: 'constructor',
    trigger: 'panelOpen',
    title: 'Верфь — оснащение',
    body: 'Здесь ты собираешь корабли, эскадрильи, дивизии и героев из модулей. Лоадаут фиксируется при постройке — выбирай слоты заранее, переоснастить готовое нельзя. Вкладка «Герои» — штаб командиров.',
  },
  {
    id: 'diplomacy',
    trigger: 'panelOpen',
    title: 'Дипломатия',
    body: 'Объявляй войну и мир, заключай пакты и союзы. Коалиция ограничена порогом силы — всех против одного не собрать. Следи за стойками сторон: союзник сегодня может стать соперником завтра.',
  },
  {
    // ONB-8: fired on first open of the corporation cabinet.
    id: 'corp',
    trigger: 'panelOpen',
    title: 'Кабинет корпорации',
    body: 'Корпорация — это твой отряд в общей сессии: общий склад, роли участников и совместные войны альянсов (AvA). Вступи в существующую или создай свою — вкладка «Войны» открывает доступ к вызовам между корпорациями.',
  },
  {
    // ONB-8: fired on first open of the "Войны" (AvA) tab inside the corp cabinet.
    id: 'ava',
    trigger: 'panelOpen',
    title: 'Войны альянсов (AvA)',
    body: 'Здесь корпорации бросают друг другу вызов на организованную войну. Отметь готовность корпорации и свою личную — когда обе стороны готовы, можно принять вызов. Дальше — набор состава и сама война по расписанию.',
  },
  {
    // ONB-5: fired on the FIRST order that takes real time (a fleet leaving on a
    // course) — the moment the async model becomes tangible.
    id: 'asyncDelay',
    trigger: 'firstAvailable',
    title: 'Мир идёт без тебя',
    body: 'Этот флот прибудет через часы реального времени — мир Void Dominion идёт непрерывно, даже когда ты офлайн. Можешь закрыть игру: приказы выполнятся сами, а к возвращению мы пришлём уведомление и покажем сводку «пока тебя не было».',
  },
];

/** Fast lookup by id. */
export const INTRO_BY_ID: Record<string, IntroCard> = Object.fromEntries(
  INTROS.map((c) => [c.id, c]),
);

/** Fail-secure parse of the persisted seen-set: keep only known intro ids. */
export function parseSeenIntros(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x in INTRO_BY_ID);
  } catch {
    return [];
  }
}

export function hasSeenIntro(seen: readonly string[], id: string): boolean {
  return seen.includes(id);
}

/** Mark an intro seen (idempotent; no duplicates). */
export function markIntroSeen(seen: readonly string[], id: string): string[] {
  return seen.includes(id) ? [...seen] : [...seen, id];
}

/**
 * Decide what to do on first contact with `id`. An unknown id or an already-seen
 * one is a no-op (`card: null`, seen unchanged). Otherwise the intro is marked
 * seen and returned — UNLESS `veteran` is set, in which case it's marked seen
 * silently (`card: null`) so an experienced player is never nagged ("помечено
 * сразу"). Callers persist the returned `seen` and show `card` when present.
 */
export function resolveIntro(
  seen: readonly string[],
  id: string,
  opts: { veteran?: boolean } = {},
): { card: IntroCard | null; seen: string[] } {
  const card = INTRO_BY_ID[id];
  if (!card || hasSeenIntro(seen, id)) return { card: null, seen: [...seen] };
  return { card: opts.veteran ? null : card, seen: markIntroSeen(seen, id) };
}
