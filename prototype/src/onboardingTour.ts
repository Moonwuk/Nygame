/**
 * ONB-1 · A concrete, data-described guide-mark chain over the live HUD — the
 * proof that the spotlight engine (`./spotlight`) leads a player around REAL
 * elements, and the base ONB-2 extends into the full guided first match.
 *
 * `copy` is a locale key: the canonical-Russian msgid (translated by locale/en.ts).
 * The HUD-targeted steps are `optional` so launching the tour outside a match
 * (targets hidden → engine sees no rect) skips them gracefully instead of
 * safe-stopping — see spotlight.ts. Selectors are stable HUD ids from build.mjs.
 */
import type { SpotlightStep } from './spotlight';

/** A short interface-orientation tour: welcome → real-time clock → treasury → tools. */
export const HUD_ORIENTATION_TOUR: SpotlightStep[] = [
  {
    id: 'welcome',
    target: null,
    copy: 'Короткий тур по интерфейсу — на нём держится весь мир. «Пропустить обучение» доступно всегда.',
    advance: { on: 'tap' },
  },
  {
    id: 'clock',
    target: '#speedbar',
    copy: 'Мир идёт в реальном времени и продолжается, даже когда ты офлайн. Здесь — пауза и ускорение.',
    advance: { on: 'tap' },
    placement: 'top',
    optional: true,
  },
  {
    id: 'purse',
    target: '#purse',
    copy: 'Твоя казна: доход от шахт минус содержание флота. Следи, чтобы не уйти в минус.',
    advance: { on: 'tap' },
    placement: 'bottom',
    optional: true,
  },
  {
    id: 'tools',
    target: '#rail',
    copy: 'Инструменты командира: дипломатия, наука, верфь, рынок и сводки событий.',
    advance: { on: 'tap' },
    placement: 'right',
    optional: true,
  },
  {
    id: 'done',
    target: null,
    copy: 'Готово! Пора действовать: построй шахту, подними флот, отдай курс. Удачи, командир.',
    advance: { on: 'tap' },
  },
];
