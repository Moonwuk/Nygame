// Minimal browser multiplayer test client. Connects to `pnpm dev:server` over a
// real WebSocket through the actual @void/client transport adapter, renders the
// shared state, and lets a human issue real orders. Open it twice (player=green,
// player=red) to drive the manual two-player checklist in docs/multiplayer.md.
//
// Throwaway harness like the prototype: built with esbuild, ESLint-ignored, not
// typechecked. Browser globals + Date.now() are fine here (this is the client,
// not the deterministic core).
import {
  MultiplayerClient,
  type MultiplayerSnapshot,
  type MultiplayerStatus,
} from '../packages/client/src/index';
import type { Action, GameState } from '@void/shared-core';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;
const statusEl = $('status');
const stateEl = $('state');
const actionsEl = $('actions');
const logEl = $('log');

let client: MultiplayerClient | null = null;
let ws: WebSocket | null = null;
let state: GameState | null = null;
let me = 'green';
let seq = 0;

function esc(s: string): string {
  // Escape for both text and double/single-quoted attribute contexts. esc()'s output
  // lands inside value="…" / data-*="…" attributes (see renderActions), so quotes must
  // be escaped too or a value with a `"` breaks out of the attribute (CWE-79 XSS).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function log(msg: string): void {
  logEl.insertAdjacentHTML('afterbegin', `<div>${new Date().toLocaleTimeString()} · ${esc(msg)}</div>`);
}
function setStatus(s: MultiplayerStatus | 'closed'): void {
  statusEl.textContent = s.toUpperCase();
  statusEl.className = s;
}

function connect(): void {
  disconnect();
  me = input('player').value.trim() || 'green';
  const base = input('base').value.trim().replace(/\/+$/, '');
  const match = input('match').value.trim() || 'dev';
  const url = `${base}/matches/${match}?player=${encodeURIComponent(me)}`;
  log(`connecting → ${url}`);
  const sock = ws = new WebSocket(url);
  client = new MultiplayerClient(
    { send: (d: string) => sock.send(d), close: () => sock.close() },
    {
      onStatus: (s) => setStatus(s),
      onSnapshot: (snap: MultiplayerSnapshot) => {
        state = snap.state;
        $('seq').textContent = `seq ${snap.seq}`;
        render();
      },
      onRejection: (id, code) => log(`✗ rejected ${id}: ${code}`),
      onError: (code) => log(`✗ error: ${code}`),
    },
  );
  sock.onopen = () => {
    if (client) client.open();
    log('socket open');
  };
  sock.onmessage = (ev) => {
    if (client) client.receive(String(ev.data));
  };
  sock.onclose = (ev) => {
    setStatus('closed');
    log(`socket closed (${ev.code})`);
  };
  sock.onerror = () => log('socket error (is dev:server running?)');
}

function disconnect(): void {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  client = null;
  setStatus('closed');
}

function sendAction(type: string, payload: unknown): void {
  if (!client) {
    log('not connected');
    return;
  }
  const action: Action = { id: `tc:${me}:${seq++}`, type, playerId: me, payload, issuedAt: Date.now() };
  client.sendAction(action);
  log(`→ ${type} ${JSON.stringify(payload)}`);
}

function fmtRes(r: Record<string, number>): string {
  const parts = Object.entries(r).map(([k, v]) => `${k} ${Math.round(v)}`);
  return parts.length ? parts.join(' · ') : '—';
}

function render(): void {
  if (!state) return;
  const players = Object.values(state.players)
    .map(
      (p) =>
        `<div class="${p.id === me ? 'mine' : ''}">◆ <b>${esc(p.id)}</b> <span class="dim">${esc(p.faction)}</span> · ${esc(fmtRes(p.resources))}</div>`,
    )
    .join('');
  const fleets = Object.values(state.fleets)
    .map((f) => {
      const loc = f.location ?? (f.movement ? `${f.movement.from}→${f.movement.to}` : '—');
      return `<div class="${f.owner === me ? 'mine' : ''}">▲ <b>${esc(f.id)}</b> <span class="dim">${esc(f.owner)}</span> @ ${esc(loc)} · orbit ${esc(f.orbit ?? '—')}${f.movement ? ' · <em>moving</em>' : ''}</div>`;
    })
    .join('');
  const planets = Object.values(state.planets)
    .map(
      (pl) =>
        `<div>● <b>${esc(pl.id)}</b> <span class="dim">${esc(pl.owner ?? 'neutral')}</span></div>`,
    )
    .join('');
  stateEl.innerHTML =
    `<div class="col"><h3>Players</h3>${players}</div>` +
    `<div class="col"><h3>Fleets</h3>${fleets}</div>` +
    `<div class="col"><h3>Planets</h3>${planets}</div>`;
  renderActions();
}

function renderActions(): void {
  if (!state) {
    actionsEl.innerHTML = '';
    return;
  }
  const mine = Object.values(state.fleets).filter((f) => f.owner === me);
  if (!mine.length) {
    actionsEl.innerHTML = `<div class="dim">No fleets owned by "${esc(me)}" — connect as a seated player (green/red).</div>`;
    return;
  }
  actionsEl.innerHTML = mine
    .map((f) => {
      const loc = f.location;
      const pl = loc ? state?.planets[loc] : undefined;
      const dests = pl?.links ?? [];
      const opts = dests.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      const moveCtl = dests.length
        ? `<select data-move="${esc(f.id)}">${opts}</select><button data-act="move" data-fleet="${esc(f.id)}">Move</button>`
        : '';
      return `<div class="fa"><b>${esc(f.id)}</b>
        <button data-act="orbit" data-fleet="${esc(f.id)}" data-arg="near">Enter orbit</button>
        ${moveCtl}
        <button data-act="stop" data-fleet="${esc(f.id)}">Stop</button></div>`;
    })
    .join('');
}

actionsEl.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button');
  if (!t) return;
  const act = t.getAttribute('data-act');
  const fleetId = t.getAttribute('data-fleet');
  if (!act || !fleetId) return;
  if (act === 'orbit') sendAction('fleet.orbit', { fleetId, orbit: t.getAttribute('data-arg') });
  else if (act === 'stop') sendAction('fleet.stop', { fleetId });
  else if (act === 'move') {
    const sel = actionsEl.querySelector(`select[data-move="${fleetId}"]`) as HTMLSelectElement | null;
    if (sel && sel.value) sendAction('fleet.move', { fleetId, to: sel.value });
  }
});

$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', disconnect);
setStatus('closed');
log('ready — set player (green / red) and Connect. Open a second tab as the other player.');
