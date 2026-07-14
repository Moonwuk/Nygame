/**
 * ONB-2 · The guided first match — a data-described chain (ONB-1 engine) that
 * walks a brand-new commander through the core loop in a bot-free solo sandbox:
 *
 *   produce (build a mine) → build (raise a fleet) → move (set a course, fog
 *   opens) → capture a neutral world (two-phase) → the score moves → first win.
 *
 * The "do X" beats advance on the REAL game action (`action:<type>`, fed from
 * `playerOrder`) and the capture/score beats on live GAME STATE (`state`,
 * predicates over `s`) — so the guide tracks what the player actually does, not
 * a scripted click path. The narration steers even where a precise highlight is
 * unavailable: HUD highlights are `optional`, so a missing/renamed selector
 * degrades to copy-only guidance instead of stopping the tour (spotlight.ts).
 *
 * `copy` is a locale key (canonical-Russian msgid; en.ts translates). Predicates
 * come from the host so this stays pure and unit-testable.
 */
import type { SpotlightStep } from './spotlight';

export interface FirstMatchDeps {
  /** True once the player owns a world beyond their start (a neutral was taken). */
  capturedWorld: () => boolean;
  /** True once the player's score has risen above its starting value. */
  scoreRose: () => boolean;
}

/** The ordered guide chain for a fresh commander's first, bot-free match. */
export function buildFirstMatchTour(deps: FirstMatchDeps): SpotlightStep[] {
  return [
    {
      id: 'welcome',
      target: null,
      copy: 'Это твой первый мир, командир. Проведу тебя по главному циклу — пара минут, спокойно, без соперников.',
      advance: { on: 'tap' },
    },
    {
      id: 'home',
      target: '#side',
      copy: 'Внизу — панель твоего домашнего мира: здания, гарнизон и стройка. Тапни свой мир, если панель пуста.',
      advance: { on: 'tap' },
      placement: 'top',
      optional: true,
    },
    {
      id: 'mine',
      target: '#side',
      copy: 'Начни с экономики: построй Шахту — она даёт ресурсы, на них строится всё остальное.',
      advance: { on: 'action', type: 'building.construct' },
      placement: 'top',
    },
    {
      id: 'fleet',
      target: '#side',
      copy: 'Теперь подними флот из гарнизона родного мира — кнопка «Поднять флот». Так корабли становятся подвижной силой.',
      advance: { on: 'action', type: 'fleet.launch' },
      placement: 'top',
    },
    {
      id: 'course',
      target: '#cmdbar',
      copy: 'Выбери свой флот (▲) и тапни соседний мир — задай курс. Флот пойдёт по звёздным трассам, и туман начнёт открываться.',
      advance: { on: 'action', type: 'fleet.move' },
      placement: 'top',
    },
    {
      id: 'capture',
      target: null,
      copy: 'Захвати нейтральный мир: выйди на орбиту, а если он защищён — высади десант. Захват двухфазный: сначала небо, потом земля.',
      advance: { on: 'state', when: deps.capturedWorld },
    },
    {
      id: 'score',
      target: '#devline',
      copy: 'Мир взят — и счёт пошёл! Очки капают за миры и сектора; набери порог — и это победа.',
      advance: { on: 'state', when: deps.scoreRose },
      placement: 'bottom',
    },
    {
      id: 'done',
      target: null,
      copy: 'Первая схватка выиграна! Ты прошёл весь цикл: добыча → стройка → движение → захват → счёт. Дальше — настоящий матч.',
      advance: { on: 'tap' },
    },
  ];
}
