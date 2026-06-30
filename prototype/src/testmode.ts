/**
 * =============================================================================
 *  DEV TEST MODE — a self-contained, developer-only corner of the prototype.
 * =============================================================================
 *  Everything for the "Тесты" screen lives in THIS file plus three clearly
 *  fenced hooks in the shared code. To cut the whole feature without a trace:
 *    1. delete this file (prototype/src/testmode.ts);
 *    2. remove the `<!-- DEV TEST MODE -->` HTML block + the "Тесты" button and
 *       the `/* DEV TEST MODE *​/` CSS block in prototype/build.mjs;
 *    3. remove the `initTestMode(...)` import + call in prototype/src/main.ts.
 *  Nothing else references it.
 *
 *  Scenarios:
 *    1. Fleet/planet collision — two equal hostile fleets fly head-on (lane
 *       intercept) and, elsewhere, one passes a planet where an enemy sits in
 *       orbit (node catch against a stationed fleet).
 *    2. Ground battle lab — design a division template for each side, then run
 *       the new ground resolver and read the outcome.
 */
import {
  newGame,
  order,
  moveFleet,
  MAP,
  DEFAULT_TEMPLATES,
  formationStats,
  FORMATION_UNITS,
  type MapNode,
  type FormationTemplate,
  type FormationUnit,
} from './game';
import { makeSide, resolveGround, GROUND_ROSTER } from './groundcombat';
import { setStance } from '../../packages/shared-core/src/index';
import type { GameState, Fleet, UnitStack } from '../../packages/shared-core/src/index';

/** The only things test mode borrows from the host app — passed in once. */
export interface TestModeHooks {
  /** Install a ready-made scenario state and start it PAUSED at time 0; `resumeSpeed`
   *  is the multiplier the fast-forward control should resume to. */
  startScenario: (state: GameState, resumeSpeed: number) => void;
  /** Return to the mode-select (connect) screen. */
  back: () => void;
}

const SPEEDS = [1, 2, 6, 20]; // selectable game-speed multipliers
const FORM_ICON: Record<string, string> = { infantry: '🪖', tank: '🛡', bomber: '✈', aa: '◎' };
const FORM_RU: Record<string, string> = { infantry: 'Пехота', tank: 'Танк', bomber: 'Бомбер', aa: 'ПВО' };

// Scenario-1 force config: the spacecraft each side's fleets are built from.
const SHIP_UNITS = ['cruiser', 'scout', 'siege'] as const;
type ShipUnit = (typeof SHIP_UNITS)[number];
type Force = Record<ShipUnit, number>;
const SHIP_RU: Record<ShipUnit, string> = { cruiser: 'Крейсер', scout: 'Скаут', siege: 'Осада' };
const SHIP_ICON: Record<ShipUnit, string> = { cruiser: '▲', scout: '◌', siege: '✦' };
const forceTotal = (f: Force): number => SHIP_UNITS.reduce((a, u) => a + f[u], 0);

export function initTestMode(hooks: TestModeHooks): void {
  const found = document.getElementById('testmode');
  if (!found) return;
  const el: HTMLElement = found; // non-null for the closures below

  let mult = 2; // chosen speed multiplier
  let view: 'menu' | 'force' | 'ground' = 'menu';
  // Scenario-1 force config: composition per side (applied to that side's fleets).
  const forceA: Force = { cruiser: 3, scout: 0, siege: 0 };
  const forceD: Force = { cruiser: 3, scout: 0, siege: 0 };
  // Scenario-2 lab: an editable template per side.
  const tplA: FormationTemplate = { name: 'Атака', slots: [...DEFAULT_TEMPLATES[1]!.slots] };
  const tplD: FormationTemplate = { name: 'Оборона', slots: [...DEFAULT_TEMPLATES[0]!.slots] };
  let groundResult = '';

  const show = (on: boolean): void => {
    el.style.display = on ? 'flex' : 'none';
    if (on) {
      view = 'menu';
      groundResult = '';
      render();
    }
  };

  function render(): void {
    el.innerHTML = view === 'menu' ? menuHtml() : view === 'force' ? forceHtml() : groundHtml();
  }

  function menuHtml(): string {
    const spd = SPEEDS.map(
      (v) => `<button class="tm-spd ${v === mult ? 'on' : ''}" data-tm="spd" data-v="${v}">${v}×</button>`,
    ).join('');
    return `<div class="tmbox">
      <div class="tm-title"><span class="dia"></span><b>РЕЖИМ ТЕСТОВ</b><span class="tm-dev">DEV</span></div>
      <p class="tm-sub">Отдельный режим для разработчиков. Выбери множитель скорости — сценарий стартует со сброшенного таймера и на паузе.</p>
      <div class="tm-label">Скорость</div>
      <div class="tm-row">${spd}</div>
      <div class="tm-label">Сценарии</div>
      <button class="tm-scn" data-tm="scn1"><b>1 · Коллизия флотов и планет</b><span>Встречные флоты ловят друг друга в полёте; рядом — перехват флота на ближней орбите пролетающим врагом.</span></button>
      <button class="tm-scn" data-tm="scn2"><b>2 · Наземное сражение</b><span>Собери шаблон дивизии для каждой стороны и проверь новый резолвер наземного боя.</span></button>
      <button class="tm-back" data-tm="back">← Назад</button>
    </div>`;
  }

  function forceSideHtml(side: 'a' | 'd', title: string, f: Force): string {
    const rows = SHIP_UNITS.map(
      (u) =>
        `<div class="tm-frow"><span class="tm-fic">${SHIP_ICON[u]}</span><span class="tm-fnm">${SHIP_RU[u]}</span>` +
        `<button class="tm-step" data-tm="dec" data-side="${side}" data-u="${u}">−</button>` +
        `<span class="tm-fn">${f[u]}</span>` +
        `<button class="tm-step" data-tm="inc" data-side="${side}" data-u="${u}">+</button></div>`,
    ).join('');
    return `<div class="tm-side"><div class="tm-side-h">${title}</div>${rows}<div class="tm-stats">Всего кораблей: ${forceTotal(f)}</div></div>`;
  }

  function forceHtml(): string {
    const can = forceTotal(forceA) > 0 && forceTotal(forceD) > 0;
    return `<div class="tmbox">
      <div class="tm-title"><span class="dia"></span><b>СЦЕНАРИЙ 1 · НАСТРОЙКА СИЛ</b></div>
      <p class="tm-sub">Задай состав флота для каждой стороны — он применяется и к встречным флотам, и к перехвату на орбите. Затем «Запустить» — сценарий стартует со сброшенного таймера, на паузе.</p>
      <div class="tm-sides">${forceSideHtml('a', 'Azure · вы (синие)', forceA)}${forceSideHtml('d', 'Crimson · враг (красные)', forceD)}</div>
      <button class="tm-fight" data-tm="launch1" ${can ? '' : 'disabled'}>▶ Запустить сценарий</button>
      <button class="tm-back" data-tm="tomenu">← К сценариям</button>
    </div>`;
  }

  function slotsHtml(side: 'a' | 'd', tpl: FormationTemplate): string {
    return tpl.slots
      .map((u, i) => {
        const ic = u ? FORM_ICON[u] : '＋';
        const nm = u ? FORM_RU[u] : 'пусто';
        return `<div class="tm-slot ${u ? '' : 'empty'}" data-tm="slot" data-side="${side}" data-i="${i}"><span class="ic">${ic}</span><span class="nm">${nm}</span></div>`;
      })
      .join('');
  }

  function sideHtml(side: 'a' | 'd', title: string, tpl: FormationTemplate): string {
    const f = formationStats(tpl);
    return `<div class="tm-side">
      <div class="tm-side-h">${title}</div>
      <div class="tm-slots">${slotsHtml(side, tpl)}</div>
      <div class="tm-stats">⚔ ${f.attack} · 🛡 ${f.defense} · ❤ ${f.hp} · №${f.count}/6</div>
    </div>`;
  }

  function groundHtml(): string {
    return `<div class="tmbox">
      <div class="tm-title"><span class="dia"></span><b>СЦЕНАРИЙ 2 · НАЗЕМНЫЙ БОЙ</b></div>
      <p class="tm-sub">Тапни слот, чтобы сменить род войск (пусто → пехота → танк → бомбер). Затем «Сразиться» — резолвер прогонит бой до конца.</p>
      <div class="tm-sides">${sideHtml('a', 'Атакующий', tplA)}${sideHtml('d', 'Обороняющийся', tplD)}</div>
      <button class="tm-fight" data-tm="fight">⚔ Сразиться</button>
      ${groundResult ? `<div class="tm-result">${groundResult}</div>` : ''}
      <button class="tm-back" data-tm="tomenu">← К сценариям</button>
    </div>`;
  }

  function cycleSlot(tpl: FormationTemplate, i: number): void {
    const order_: (FormationUnit | null)[] = [null, ...FORMATION_UNITS];
    const cur = tpl.slots[i] ?? null;
    tpl.slots[i] = order_[(order_.indexOf(cur) + 1) % order_.length] ?? null;
  }

  function runGround(): void {
    const atk = makeSide(GROUND_ROSTER, formationStats(tplA).byType);
    const def = makeSide(GROUND_ROSTER, formationStats(tplD).byType);
    const out = resolveGround(GROUND_ROSTER, atk, def);
    const survivors = (s: { type: FormationUnit; count: number }[]): string =>
      s.length ? s.map((x) => `${FORM_RU[x.type]} ×${x.count}`).join(', ') : '— уничтожены';
    const win =
      out.winner === 'attacker'
        ? '<b class="win">Победа: Атакующий</b>'
        : out.winner === 'defender'
          ? '<b class="win">Победа: Обороняющийся</b>'
          : '<b class="draw">Ничья (лимит раундов)</b>';
    groundResult =
      `${win} · раундов: ${out.rounds}` +
      `<div class="tm-surv">Атакующий: ${survivors(out.attacker)}</div>` +
      `<div class="tm-surv">Обороняющийся: ${survivors(out.defender)}</div>`;
  }

  el.addEventListener('click', (ev) => {
    const t = (ev.target as Element).closest('[data-tm]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.tm;
    if (act === 'spd') {
      mult = Number(t.dataset.v);
      render();
    } else if (act === 'back') {
      show(false);
      hooks.back();
    } else if (act === 'scn1') {
      view = 'force';
      render();
    } else if (act === 'inc' || act === 'dec') {
      const f = t.dataset.side === 'a' ? forceA : forceD;
      const u = t.dataset.u as ShipUnit;
      f[u] = Math.max(0, Math.min(9, f[u] + (act === 'inc' ? 1 : -1)));
      render();
    } else if (act === 'launch1') {
      show(false);
      hooks.startScenario(buildCollisionScenario(forceA, forceD), mult);
    } else if (act === 'scn2') {
      view = 'ground';
      groundResult = '';
      render();
    } else if (act === 'tomenu') {
      view = 'menu';
      render();
    } else if (act === 'slot') {
      cycleSlot(t.dataset.side === 'a' ? tplA : tplD, Number(t.dataset.i));
      render();
    } else if (act === 'fight') {
      runGround();
      render();
    }
  });

  // Expose the opener on the element so the host's "Тесты" button can call it
  // through a tiny, fenced hook without test mode reaching back into the app.
  (el as unknown as { _open?: () => void })._open = () => show(true);
}

/** Opens the test overlay (the host calls this from the "Тесты" button). */
export function openTestMode(): void {
  const el = document.getElementById('testmode') as unknown as { _open?: () => void } | null;
  el?._open?.();
}

// --- scenario 1: fleet / planet collision ------------------------------------
// Two hostile fleets on neighbouring planets fly head-on (the engine's lane-
// intercept catches them mid-flight). Far away, a second pair tests the node catch:
// a friendly fleet sits in a planet's orbit while a hostile fleet passes THROUGH
// that planet. `forceA`/`forceD` are the per-side ship compositions (Azure = p1,
// Crimson = p2), applied to both of that side's fleets.
function buildCollisionScenario(forceA: Force, forceD: Force): GameState {
  const byId = new Map<string, MapNode>(MAP.map((n) => [n.id, n]));
  const planets = MAP.filter((n) => n.sector === 'planet');
  const dist = (a: string, b: string): number => {
    const p = byId.get(a)!;
    const q = byId.get(b)!;
    return Math.hypot(p.x - q.x, p.y - q.y);
  };

  // 1a — a head-on pair sharing a lane.
  let a1 = MAP[0]!.id;
  let a2 = MAP[0]!.links[0] ?? MAP[1]!.id;
  for (const n of planets) {
    const l = n.links.find((x) => byId.get(x)?.sector === 'planet');
    if (l) {
      a1 = n.id;
      a2 = l;
      break;
    }
  }
  // 1b — a "pass-through" trio as FAR as possible from the pair: a planet Q whose
  // two neighbours N1,N2 are not directly linked, so N1→N2 must route through Q.
  let q = '';
  let n1 = '';
  let n2 = '';
  let best = -1;
  for (const cand of planets) {
    if (cand.id === a1 || cand.id === a2) continue;
    const nbrs = cand.links.filter((l) => byId.has(l));
    for (let i = 0; i < nbrs.length; i++) {
      for (let j = i + 1; j < nbrs.length; j++) {
        if (byId.get(nbrs[i])!.links.includes(nbrs[j])) continue; // directly linked → skip
        const d = dist(cand.id, a1);
        if (d > best) {
          best = d;
          q = cand.id;
          n1 = nbrs[i]!;
          n2 = nbrs[j]!;
        }
      }
    }
  }

  let st = newGame({
    seats: [
      { id: 'p1', name: 'Azure (тест)', faction: 'blue', start: a1, ai: false },
      { id: 'p2', name: 'Crimson (тест)', faction: 'red', start: a2, ai: false },
    ],
  });
  st.time = 0;
  // newGame seeds everyone at PEACE; the test needs them shooting, so declare war —
  // combat's isHostile only fires on an explicit `war` stance.
  setStance(st, 'p1', 'p2', 'war');
  const units = (f: Force): UnitStack[] =>
    SHIP_UNITS.filter((u) => f[u] > 0).map((u) => ({ unit: u, count: f[u] }));
  const mk = (id: string, owner: string, location: string, f: Force, orbit?: 'near'): Fleet => ({
    id,
    owner,
    location,
    movement: null,
    units: units(f),
    landing: [],
    traits: [],
    ...(orbit ? { orbit } : {}),
  });
  st.fleets = {
    't-a1': mk('t-a1', 'p1', a1, forceA),
    't-a2': mk('t-a2', 'p2', a2, forceD),
  };
  if (q) {
    st.fleets['t-c'] = mk('t-c', 'p1', q, forceA, 'near'); // sits in orbit
    st.fleets['t-d'] = mk('t-d', 'p2', n1, forceD);
  }
  // Issue the marching orders so they execute the moment the dev unpauses.
  st = order(st, moveFleet('p1', 't-a1', a2), st.time).state;
  st = order(st, moveFleet('p2', 't-a2', a1), st.time).state;
  if (q) st = order(st, moveFleet('p2', 't-d', n2), st.time).state;
  st.time = 0; // re-assert the reset counter
  return st;
}
