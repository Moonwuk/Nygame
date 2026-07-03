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
import { createInitialState } from '@void/shared-core';
import { theme } from './theme';
import { createWelcomeModel, resolveWelcomeAction, nextCallsign } from './welcomeScreen';
import type { WelcomeModel, WelcomeOutcome, AuthProviderId } from './welcomeScreen';

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
      case 'singlePlayer':
        setStatus(statusText(resolveWelcomeAction({ kind: 'singlePlayer' }, model)));
        break;
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

applyTheme();
const welcome = createWelcomeModel();
render(welcome);
wire(welcome);
showEngine();
