/**
 * Web-client app shell (Stage 4, CP0.1 — docs/cross-platform-roadmap.md). The first
 * real, buildable entry point: it renders the framework-agnostic welcome-screen
 * view-model into the DOM, binds the shared theme tokens as CSS variables, and drives
 * routing through the pure `resolveWelcomeAction` reducer. It also proves the whole
 * PWA-first bet — the deterministic `@void/shared-core` engine loads and runs in the
 * browser — by building an initial state on launch.
 *
 * This is intentionally thin: map rendering, the network transport and the PWA install
 * layer are later bricks (CP0.2 / CP1.x). No forked copy of the core or its data.
 */
import { createInitialState, type GameState } from '@void/shared-core';
import { theme } from './theme';
import { createWelcomeModel, resolveWelcomeAction, nextCallsign } from './welcomeScreen';
import type { WelcomeModel, WelcomeOutcome, AuthProviderId } from './welcomeScreen';
import { clampCam, zoomAt, type Cam, type Viewport, type Bounds } from './camera';
import { renderMap } from './mapRender';
import { shippedGameData, skirmishState } from './gameData';
import { openLiveMatch } from './net';

/** Bind the typed theme tokens to CSS custom properties (docs/main-menu.md §5.4 — one
 *  TS engine → one look). The stylesheet in index.html reads these vars. */
function applyTheme(): void {
  const s = document.documentElement.style;
  const vars: Record<string, string> = {
    '--cyan': theme.cyan,
    '--cyan-dim': theme.cyanDim,
    '--red': theme.red,
    '--amber': theme.amber,
    '--ink': theme.ink,
    '--dim': theme.dim,
    '--line': theme.line,
    '--line-hi': theme.lineHi,
    '--glass': theme.glass,
  };
  for (const [k, v] of Object.entries(vars)) s.setProperty(k, v);
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** Host owns the callsign sequence (welcomeScreen.ts) — persisted for real later. */
let callsignSeq = 0;

const REJECTIONS: Record<string, string> = {
  E_NO_NICK: 'Введите позывной.',
  E_UNKNOWN_PROVIDER: 'Неизвестный провайдер.',
};

/** Turn a routing outcome into a human status line. Routes are stubbed until the
 *  match browser (CP) and single-player sandbox land — this proves the wiring. */
function statusText(outcome: WelcomeOutcome): string {
  if (!outcome.ok) return `✖ ${REJECTIONS[outcome.code] ?? outcome.code}`;
  if (outcome.route === 'single') return '▶ Одиночная игра — запуск песочницы… (движок в браузере)';
  if (outcome.mode === 'new') {
    const nick = nextCallsign(callsignSeq++);
    const notice =
      outcome.noticeKey === 'guest_stub' ? ` · вход через ${outcome.provider ?? '—'} скоро — пока гость` : '';
    return `→ Обзор матчей · новый командир «${nick}»${notice}`;
  }
  return `→ Обзор матчей · ${outcome.nick ?? 'возвращение'}`;
}

function render(model: WelcomeModel): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML =
    `<main class="welcome">` +
    `<div class="crest">◆</div>` +
    `<h1>${esc(model.title)}</h1>` +
    `<p class="tagline">${esc(model.tagline)}</p>` +
    `<button class="btn primary" data-act="newPlayer">${esc(model.newPlayerLabel)}</button>` +
    `<div class="sep"><span>${esc(model.signInWithLabel)}</span></div>` +
    `<div class="providers">` +
    model.providers
      .map(
        (p) =>
          `<button class="btn stub" data-act="signIn" data-provider="${p.id}" title="${p.available ? '' : 'скоро'}">${esc(p.label)}</button>`,
      )
      .join('') +
    `</div>` +
    `<div class="login"><input id="nick" maxlength="24" placeholder="${esc(model.loginLabel)}" autocomplete="off" />` +
    `<button class="btn" data-act="login">${esc(model.loginLabel)}</button></div>` +
    `<button class="btn ghost" data-act="singlePlayer">${esc(model.singlePlayerLabel)}</button>` +
    `<footer>${model.legal.map((l) => `<a data-legal="${l.id}">${esc(l.label)}</a>`).join('<span>·</span>')}</footer>` +
    `<div id="status" class="status" role="status" aria-live="polite"></div>` +
    `<div class="engine" id="engine"></div>` +
    `</main>`;
}

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function loginNick(): string {
  return (document.getElementById('nick') as HTMLInputElement | null)?.value ?? '';
}

function wire(model: WelcomeModel): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!target) return;
    switch (target.dataset.act) {
      case 'newPlayer':
        setStatus(statusText(resolveWelcomeAction({ kind: 'newPlayer' }, model)));
        break;
      case 'singlePlayer': {
        const outcome = resolveWelcomeAction({ kind: 'singlePlayer' }, model);
        setStatus(statusText(outcome));
        if (outcome.ok && outcome.route === 'single') startMatch();
        break;
      }
      case 'signIn': {
        const provider = target.dataset.provider;
        if (provider) {
          setStatus(statusText(resolveWelcomeAction({ kind: 'signIn', provider: provider as AuthProviderId }, model)));
        }
        break;
      }
      case 'login':
        setStatus(statusText(resolveWelcomeAction({ kind: 'login', nick: loginNick() }, model)));
        break;
    }
  });
  app.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (ke.target as HTMLElement).id === 'nick') {
      setStatus(statusText(resolveWelcomeAction({ kind: 'login', nick: loginNick() }, model)));
    }
  });
}

/** Prove the deterministic core runs in the browser — the whole reason for a web
 *  client (docs/cross-platform-roadmap.md: the client consumes @void/shared-core
 *  directly for its offline preview, no forked copy). */
function showEngine(): void {
  const el = document.getElementById('engine');
  if (!el) return;
  const state = createInitialState({ seed: 'welcome', version: { data: '0.1.0', manifest: '1' } });
  el.textContent = `движок готов · t=${state.time}`;
}

let matchStarted = false;

/** Map-space bounding box of a state's planets — the camera's world extent. Guards an
 *  empty map (no planets yet) so the camera math stays finite. */
function boundsOf(state: GameState): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of Object.values(state.planets)) {
    minX = Math.min(minX, p.position.x);
    minY = Math.min(minY, p.position.y);
    maxX = Math.max(maxX, p.position.x);
    maxY = Math.max(maxY, p.position.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/** Shared map runner: reveals the canvas, wires the shared-camera pan (drag) / zoom
 *  (wheel), and draws `getState()` every frame. Single-player passes a fixed local state;
 *  a live match passes the latest server snapshot. */
function runMatch(getState: () => GameState, bounds: Bounds): void {
  const canvas = document.getElementById('map') as HTMLCanvasElement | null;
  const g = canvas?.getContext('2d') ?? null;
  if (!canvas || !g) return;
  const app = document.getElementById('app');
  if (app) app.hidden = true;
  canvas.hidden = false;

  let vp: Viewport = { left: 0, top: 0, right: 1, bottom: 1 };
  let cam: Cam = { scale: 1, x: 0, y: 0 };
  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    vp = { left: 0, top: 0, right: w, bottom: h };
    cam = clampCam(cam, vp, bounds);
  };
  resize();
  window.addEventListener('resize', resize);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      cam = zoomAt(cam, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12, vp, bounds);
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    cam = clampCam({ scale: cam.scale, x: cam.x + (e.clientX - drag.x), y: cam.y + (e.clientY - drag.y) }, vp, bounds);
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = (): void => {
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const loop = (): void => {
    const state = getState();
    renderMap(g, state, cam, vp, bounds, { now: state.time });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/** Single-player: build a real GameState from the shipped skirmish map (via the shared
 *  loader + buildStateFromMap) and draw it — the first time the client shows the actual
 *  game, not just the menu. Static; the live server path is {@link connectLive}. */
function startMatch(): void {
  if (matchStarted) return;
  matchStarted = true;
  const state = skirmishState(shippedGameData());
  runMatch(() => state, boundsOf(state));
}

/** CP1.1: connect to a live match over WebSocket and render the server's authoritative
 *  snapshots — the first time the Stage-4 client shows a LIVE, server-driven world instead
 *  of a static local map. World extent is taken from the first snapshot; deltas patch the
 *  state and the loop always draws the latest. A manual-start lobby WE host is auto-started
 *  (dev/first-cut — a real lobby-wait UI is a later CP). */
function connectLive(url: string): void {
  if (matchStarted) return;
  let live: GameState | null = null;
  let running = false;
  let started = false;
  setStatus('⇄ Подключение к матчу…');
  const { client } = openLiveMatch(url, {
    onStatus: (s) => {
      if (s === 'closed' && !running) setStatus('✖ соединение закрыто');
    },
    onError: (code) => {
      if (!running) setStatus(`✖ ${code}`);
    },
    onSnapshot: (snap) => {
      live = snap.state;
      if (!started && snap.lobby && !snap.lobby.started && snap.lobby.host === snap.playerId) {
        started = true;
        client.start(); // host of an unstarted lobby → run the world
      }
      if (!running) {
        running = true;
        matchStarted = true;
        const first = live;
        runMatch(() => live ?? first, boundsOf(first));
      }
    },
  });
}

applyTheme();
const welcome = createWelcomeModel();
render(welcome);
wire(welcome);
showEngine();

// CP1.1 deep-link: `?join=<url-encoded ws url>` connects straight to a live match (a shared
// invite, or the dev proto-server). The ws url is encoded so its own ?query survives.
const joinUrl = new URLSearchParams(location.search).get('join');
if (joinUrl) connectLive(joinUrl);
