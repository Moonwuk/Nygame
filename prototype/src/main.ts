/**
 * Void Dominion — playable prototype, browser UI.
 *
 * Renders the live map and drives the REAL shared-core kernel in real time:
 * every frame advances the world clock, player clicks become kernel actions, a
 * light Red AI issues its own, and the canvas reflects the resulting state.
 */
import {
  newGame,
  advance,
  order,
  data,
  MAP,
  SECTOR_TYPES,
  SCORE_LIMIT,
  HOUR,
  DAY,
  hpOfLevel,
  TAX_OFFICE_BONUS,
  moveFleet,
  moveFleetEdge,
  stopFleet,
  orbitFleet,
  assaultFleet,
  bombardFleet,
  barrageFleet,
  barrageModeFleet,
  loadArmy,
  unloadArmy,
  mergeFleet,
  splitFleet,
  engageFleet,
  researchTech,
  buildBuilding,
  upgradeBuilding,
  buildUnit,
  aiOrders,
  declareWar,
  canTraverse,
  START_CANDIDATES,
  DEFAULT_TEMPLATES,
  FORMATION_UNITS,
  FORMATION_SLOTS,
  formationStats,
  divisionsOf,
  templatesOf,
  mobilizeDivision,
  loadDivision,
  unloadDivision,
  setDivisionOfficer,
  designateCapital,
  capitalOf,
  isInhabited,
  divisionCargo,
  fleetCargoFree,
  clampPowerWeights,
  type FormationTemplate,
  type FormationUnit,
  type SetupConfig,
  type SeatConfig,
  type StepOut,
} from './game';
import { OFFICERS } from './groundcombat';
import {
  DEFAULT_HEROES,
  HERO_ABILITIES,
  HERO_ABILITY_IDS,
  HERO_GRADES,
  HERO_ROSTER_COUNT,
  heroSlots,
  heroLoadoutInfo,
  type HeroLoadout,
} from './heroes';
import {
  SHIP_HULLS,
  SHIP_MODULES,
  SHIP_MODULE_IDS,
  hullSlots,
  shipStats,
  shipLoadoutInfo,
  DEFAULT_SHIP_LOADOUTS,
  type ShipLoadout,
} from './ships';
import {
  buildingLevel,
  buildingMaxLevel,
  estimateTravelHours,
  fleetBaseSpeed,
  getStance,
  hashState,
  planRoute,
} from '../../packages/shared-core/src/index';
import { MultiplayerClient, type MultiplayerPing } from '../../packages/client/src/index';
import { buildLabel, checkForUpdate, currentBuild, type UpdateInfo } from './updater';
// DEV TEST MODE — self-contained dev-only scenarios; remove this import + the
// initTestMode(...) call below + the #testmode HTML/CSS to cut it cleanly.
import { initTestMode, openTestMode } from './testmode';
import type {
  GameState,
  Fleet,
  Battle,
  Planet,
  Action,
  DiplomaticStance,
  DomainEvent,
} from '../../packages/shared-core/src/index';

// --- constants ---------------------------------------------------------------

// Political palette (Bytro/Paradox-style): YOU = green, ally = blue, neutral =
// gray, enemy = red — used for fleets/planets and to tint each owner's province.
// Cyan stays the console-chrome accent (grid, borders, targeting reticle).
const COLOR: Record<string, string> = {
  p1: '#3ad17a', // you — green
  p2: '#ff5a4d', // rivals — red / amber / violet (by stable order, see RIVAL_COLORS)
  p3: '#ffb43a',
  p4: '#b07cff',
  ally: '#4a8cff', // ally — blue (latent: no allied player in the skirmish yet)
  null: '#6f8a93', // neutral — gray
};
// Distinct hues for the OTHER commanders (you are always green), assigned in a stable
// order so each rival keeps its colour across the match (up to 3 rivals on a 4-seat map).
const RIVAL_COLORS = ['#ff5a4d', '#ffb43a', '#b07cff']; // red, amber, violet
const VOID_COLOR = '#46606e'; // empty-space provinces — uncapturable void
// Political colour is relative to the local commander: YOU are always green, neutral gray,
// each rival its own hue. Works for solo (you = p1) and net (you may be any seat).
function ownerColor(owner: string | null | undefined): string {
  if (!owner) return COLOR.null;
  if (owner === ME) return COLOR.p1;
  const rivals = ['p1', 'p2', 'p3', 'p4'].filter((id) => id !== ME);
  const i = rivals.indexOf(owner);
  return i >= 0 ? RIVAL_COLORS[i % RIVAL_COLORS.length]! : RIVAL_COLORS[0]!;
}
// The four possible commanders, in stable seat order. Seat 1 is always you (human);
// seats 2-4 are AI or off in the setup screen. Mirrors DEFAULT_SETUP in game.ts.
const SEAT_META: ReadonlyArray<{ id: string; name: string; faction: string; color: string }> = [
  { id: 'p1', name: 'Azure Compact', faction: 'blue', color: COLOR.p1! },
  { id: 'p2', name: 'Crimson Hegemony', faction: 'red', color: COLOR.p2! },
  { id: 'p3', name: 'Amber Concord', faction: 'amber', color: COLOR.p3! },
  { id: 'p4', name: 'Violet Ascendancy', faction: 'violet', color: COLOR.p4! },
];
const GRID = 'rgba(46,150,160,0.07)';
const LOCK = '#7df0d0'; // selection / targeting reticle accent
const TAU = Math.PI * 2;
const TOP = 50; // top-bar height
const RAIL = 50; // left-rail width
const BUILDABLE = ['mine', 'refinery', 'tax_office', 'barracks', 'radar', 'fort'];
// `orbital_aa` (orbital ПВО — anti-ship near-orbit emplacement) is NOT freely
// buildable: it's a tech unlock (pending the in-session research tree). It still
// comes pre-installed with a space fortress (installFortressAA).
const BUILD_UNITS = ['marine', 'cruiser', 'scout', 'siege'];
const BUILD_ICON: Record<string, string> = {
  mine: '⬢',
  refinery: '◇',
  tax_office: '⛁',
  barracks: '▤',
  fort: '⬡',
  starfort: '✦',
  radar: '⊚',
};
const UNIT_ICON: Record<string, string> = {
  marine: '◆',
  orbital_aa: '⌁',
  cruiser: '▲',
  scout: '◌',
  siege: '✦',
  hero: '♔', // the player's projection — a crowned flagship
};
// A small glyph per province KIND, drawn above each province so its type reads at a
// glance (planet / asteroid / nebula / wreck-field / storm / …). Text glyphs only.
const KIND_ICON: Record<string, string> = {
  planet: '◉',
  dead_world: '⊗',
  asteroid: '⬡',
  nebula: '≋',
  dense_nebula: '❋',
  graveyard: '⊘',
  ion_storm: '⌁',
  solar_flare: '✸',
};
let ME = 'p1';
// Суверены — the donate/premium currency (docs/economy-roadmap.md). It's a meta-layer
// account balance, NOT match state, so the prototype shows a placeholder here; the real
// balance comes from the account once monetization is wired.
const SOVEREIGNS = 25;
type PlanetTab = 'ground' | 'ships' | 'buildings';
type BuildLane = 'buildings' | 'units';
type BuildKind = 'building' | 'upgrade' | 'unit';

interface QueuedBuild {
  kind: BuildKind;
  id: string;
  count: number;
}

interface PlanetBuildQueue {
  buildings: QueuedBuild[];
  units: QueuedBuild[];
}

interface ConstructionPayload {
  kind?: 'building' | 'unit' | 'upgrade';
  planetId?: string;
  building?: string;
  unit?: string;
  count?: number;
  level?: number;
}

interface ActiveBuild {
  at: number;
  seq: number;
  payload: ConstructionPayload;
}

/** Escape untrusted strings before inserting into innerHTML (XSS prevention). */
function esc(s: string): string {
  // Covers text and both attribute-quote styles. The file currently uses only
  // double-quoted attributes (so escaping " already prevents breakout), but escaping
  // ' too keeps esc() complete if a single-quoted attribute is ever added. (CWE-79)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** hex `#rrggbb` → `rgba()` with alpha — for tinted rings, ticks and trails. */
function rgba(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Cached radial-glow sprites: building a `createRadialGradient` per node every frame
// (×60 provinces) is a major CPU cost, as is `shadowBlur`. Bake one soft glow disc
// per (colour, radius) once and blit it with `drawImage` + `globalAlpha` instead —
// drawImage is cheap, so the map glow scales to many provinces.
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string, radius: number): HTMLCanvasElement {
  const rad = Math.max(4, Math.round(radius));
  const key = `${color}:${rad}`;
  const hit = glowCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  const px = Math.ceil(rad * 2 * DPR);
  cv.width = px;
  cv.height = px;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grd = g.createRadialGradient(rad, rad, 0, rad, rad, rad);
  grd.addColorStop(0, rgba(color, 0.95));
  grd.addColorStop(0.5, rgba(color, 0.32));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, rad * 2, rad * 2);
  glowCache.set(key, cv);
  return cv;
}
/** Blit a cached glow disc of `color` centred at (x,y), radius r, at opacity `a`. */
function blitGlow(color: string, x: number, y: number, r: number, a: number): void {
  if (a <= 0.004) return;
  const spr = glowSprite(color, r);
  const rad = Math.max(4, Math.round(r));
  cx.globalAlpha = Math.min(1, a);
  cx.drawImage(spr, x - rad, y - rad, rad * 2, rad * 2);
  cx.globalAlpha = 1;
}

// EXPERIMENT (holographic volume): give map objects a sense of depth so they read as
// orbs projected on the ship's command terminal, not flat rings. Bake one shaded sphere
// per colour — lit from the upper-left with a Fresnel rim — and blit it scaled to the
// node, same cache-and-blit trick as the glow (no per-node gradient on the hot path).
const sphereCache = new Map<string, HTMLCanvasElement>();
function sphereSprite(color: string): HTMLCanvasElement {
  const hit = sphereCache.get(color);
  if (hit) return hit;
  const rad = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(rad * 2 * DPR);
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  // specular highlight up-left → colour body → translucent rim = a lit sphere
  const grd = g.createRadialGradient(rad - rad * 0.34, rad - rad * 0.4, rad * 0.06, rad, rad, rad);
  grd.addColorStop(0, rgba('#ffffff', 0.8));
  grd.addColorStop(0.18, rgba(color, 0.62));
  grd.addColorStop(0.55, rgba(color, 0.26));
  grd.addColorStop(0.85, rgba(color, 0.1));
  grd.addColorStop(1, rgba(color, 0.02));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(rad, rad, rad - 1, 0, TAU);
  g.fill();
  g.strokeStyle = rgba('#ffffff', 0.26); // holographic rim
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(rad, rad, rad - 1.4, 0, TAU);
  g.stroke();
  sphereCache.set(color, cv);
  return cv;
}
/** Blit the cached shaded sphere of `color` centred at (x,y) at node radius r, scaled
 *  by `a` (fade the volume out at the far/whole-map view where nodes pack together). */
function blitSphere(color: string, x: number, y: number, r: number, a = 1): void {
  if (a <= 0.02) return;
  cx.globalAlpha = a;
  cx.drawImage(sphereSprite(color), x - r, y - r, r * 2, r * 2);
  cx.globalAlpha = 1;
}

/** Total count across a stack of units (ships, garrison or landing troops). */
const sumUnits = (stacks: ReadonlyArray<{ count: number }>): number =>
  stacks.reduce((a, s) => a + s.count, 0);

// Map-marker geometry / palette, shared so every blip reads the same way.
const CARDINAL: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];
const ORBIT_COLOR = '#7df0d0'; // the single orbit ring (GDD §7.4 — no near/far split)

// --- state -------------------------------------------------------------------

let s: GameState = newGame();
let speed = 1; // game-hours per real second (0 = paused); calm ×1 baseline, set per match
let banner: string | null = null;
let selFleet: string | null = null;
let selPlanet: string | null = null;
let selFleets = new Set<string>();
let aiming = false; // "Move" command armed → next world tap orders the move
let barrageAim = false; // "Обстрел" armed → next tap picks the artillery's focus target
// A staged move that would cross territory of a player you're at PEACE with: held
// until you confirm in the war-prompt (declaring war opens the route) or cancel.
let warPrompt: {
  fleetIds: string[];
  destId: string;
  edge?: { from: string; to: string; t: number };
  blockers: string[];
} | null = null;
let merging = false; // "Merge" armed → next tap on a friendly fleet picks the anchor
// Fleets ordered to merge but not yet co-located: each flies to its anchor and the
// fusion fires once they share a docked sector (see resolvePendingMerges()).
let pendingMerges: Array<{ mover: string; into: string }> = [];
let additive = false; // Ctrl/⌘ held on the current tap → add to the fleet selection
// Split-fleet dialog: which fleet, and how many of each ship type peel off.
let splitState: { fleetId: string; take: Record<string, number> } | null = null;

// --- session diplomacy & comms menu state ------------------------------------
// Messages are a prototype-local session log — they don't touch the deterministic
// core (they don't affect the sim, so they stay out of GameState). Stances DO live
// in the core (state.diplomacy); the menu drives them through diplomacy.declare.
// `to` is a conversation key: a seat id (a 1:1 DM) or COALITION (the allies' group
// chat). `ping` (coalition only) carries a province id → a clickable map marker.
// `pingId` (net only) is the server-assigned id, so a `ping.removed` can find its line.
type SessionMsg = {
  at: number;
  from: string;
  to: string;
  text: string;
  sys: boolean;
  ping?: string;
  pingId?: string;
  realAt?: number; // wall-clock ms at creation, for the chat's "real time" stamp
};
const COALITION = 'coalition';
const CH_SESSION = 'session'; // everyone in this match
const CH_GLOBAL = 'global'; // cross-session lobby (placeholder until a global server)
const GROUP_CHANNELS = new Set([COALITION, CH_SESSION, CH_GLOBAL]); // group rooms vs 1:1 DMs
let sessionMessages: SessionMsg[] = [];
// --- floating chat window (desktop only) -------------------------------------
// A movable/resizable in-game chat overlay (bottom-left by default). It reuses the
// session message store + convoLineHtml; geometry/opacity/font are applied inline so a
// frame never rebuilds it. Settings live in a popover flown out to its right, and are
// cached client-side (localStorage) — never round-tripped to the server.
let chatOpen = false;
let chatMin = false; // collapsed to just its title bar
let chatPinned = false; // position + size locked (drag/resize disabled)
let chatSettingsOpen = false;
let chatPlaced = false; // has it been parked / restored at least once?
let chatTab: string = CH_SESSION; // the open channel/DM key
const chatGeom = { x: 12, y: 0, w: 360, h: 300 }; // CSS px; y is set on first open
// Message-stamp toggles (showDay/showTime/showReal) ride along in the cached config.
const chatCfg = {
  fontPx: 13,
  transparency: 8,
  censor: false,
  color: '',
  showDay: true,
  showTime: true,
  showReal: false,
};
// Active move/resize gesture: pointer origin + the geometry snapshot we drag from.
let chatDrag: {
  mode: 'move' | 'resize';
  dir: string;
  px: number;
  py: number;
  gx: number;
  gy: number;
  gw: number;
  gh: number;
} | null = null;
let diploOpen = false;
let diploTab: 'diplo' | 'msgs' = 'diplo';
let diploSort: 'name' | 'worlds' | 'stance' = 'stance';
let diploExpanded: string | null = null; // participant row showing its action buttons
// Roster filters (alongside sort): show only seats matching the picked stance(s) and
// type(s). Empty set = no constraint from that category. They AND across categories,
// OR within one. A stance filter excludes your own seat (you have no self-stance).
const diploStanceFilter = new Set<DiplomaticStance>();
const diploTypeFilter = new Set<'human' | 'ai'>();
let convoOpen = COALITION; // the open conversation in the messages tab (seat id or COALITION)
// Screen hit-boxes for the on-map ping markers, rebuilt every frame by drawPings().
let pingHits: Array<{ loc: string; x: number; y: number }> = [];

// --- multiplayer (net mode) --------------------------------------------------
// When connected, the server is authoritative: snapshots replace `s`, orders are
// sent (not applied locally), and the local sim/AI is suspended (see frame()).
let NET = false;
/** The match this client is in / will (re)connect to. Set when joining from the menu;
 *  `connect()` (and auto-reconnect) dial `/matches/<currentMatchId>`. */
let currentMatchId = 'proto';
let netClient: MultiplayerClient | null = null;
let netSock: WebSocket | null = null;
// M0 net telemetry (dev overlay): smoothed round-trip ms, and a desync check that
// compares our reconstructed view to the server's hash on every snapshot.
let rttEma: number | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let netDesync = false; // last snapshot's hash mismatched (server vs our rebuild)
let netDesyncCount = 0; // how many snapshots have mismatched this session
// Manual-start lobby roster from the server (host + who's connected + started).
let lobbyInfo: { host: string | null; connected: string[]; started: boolean } | null = null;
// Auto-reconnect: on an UNEXPECTED drop (not a user action), rejoin our seat with
// backoff — the server keeps the match running and the nick maps us back.
let userClosed = false;
let reconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let aimPointer: { x: number; y: number } | null = null; // last canvas pointer (for the move preview)
let hoverObj: string | null = null; // side-panel object under the pointer (data-desc key)
let planetTab: PlanetTab = 'buildings';
const buildQueues: Record<string, PlanetBuildQueue> = {};
const logLines: string[] = [];
let lastAiAt = 0;
// Player ids the local sim drives as AI (empty seats become AI). Default solo = p2.
let AI_PLAYERS = new Set<string>(['p2']);
// Session war record (from `unit.died` events): enemy units you destroyed vs your own
// units lost. Cumulative since the match started; reset on a new match. Only battles
// YOU take part in are counted (tracked by location via battle.started/resolved), so
// the AI's fights elsewhere don't inflate your tally.
let killStats = { destroyed: 0, lost: 0 };
const myBattleLocs = new Set<string>();
// Single-player setup screen state: per-seat role (seat 0 is always you) + your
// chosen homeworld. Seats 2-4 toggle 'ai'/'off'; an 'ai' seat spawns a rival.
let setupSlots: Array<'human' | 'ai' | 'off'> = ['human', 'ai', 'off', 'off'];
let setupStart: string = START_CANDIDATES[0] ?? MAP[0]!.id;
// Chosen time-flow multiplier for the launched match (×1/×2/×5/×10). ×1 = today's
// normal play pace; the launch maps it onto the speedbar (applyTimeSpeed).
let setupSpeed = 1;
let lastPanelHtml = '';
let lastCmdHtml = '';
let lastSplitHtml = '';
let lastHudHtml = '';
let lastClockText = '';
let lastObjDescHtml = '';
let lastLogHtml = '';
let lastAlertText = '';
// --- fog of war (renderer projection; always on) -----------------------------
// Client-side projection just for the renderer — NOT the real security boundary
// (that is `visibleState` in shared-core). Fog is always on: ships are near-blind,
// sight comes from owned worlds + radar (see `computeVision`).
let vision: Vision | null = null; // identify + radar sets for this frame

// --- dom ---------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = $('map') as unknown as HTMLCanvasElement;
const cx = canvas.getContext('2d') as CanvasRenderingContext2D;
const side = $('side');
const logEl = $('log');
const devlineEl = $('devline'); // status strip below the top bar: day/time + worlds/fleets/score
const purse = $('purse');
const bannerEl = $('banner');
let lastBannerHtml = ''; // dirty-check so the banner's restart button isn't recreated each frame
const restartBtn = $('restart'); // speedbar restart (shown in the no-bots solo sandbox)
const restartSep = $('restart-sep');
const alertBadge = $('alertbadge');
const cmdbar = $('cmdbar');
const splitdlg = $('splitdlg');

// --- viewport, galaxy backdrop & map projection ------------------------------

function viewW(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1280;
}
function viewH(): number {
  return typeof window !== 'undefined' ? window.innerHeight : 720;
}
let VW = 1280; // viewport size in CSS pixels (drives layout + projection)
let VH = 720;
let DPR = 1;
let MOBILE = false;
function resize() {
  VW = viewW();
  VH = viewH();
  DPR = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  MOBILE = VW < 720;
  canvas.width = Math.round(VW * DPR);
  canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + 'px';
  canvas.style.height = VH + 'px';
  if (chatOpen) {
    clampChatGeom(); // the half-screen cap follows the new viewport
    applyChatGeom();
  }
}
if (typeof window !== 'undefined') window.addEventListener('resize', resize);
resize();

// Deterministic faint starfield (normalized 0..1), drawn as dim vector ticks.
const STARS = Array.from({ length: 280 }, (_, i) => {
  const r1 = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  const r2 = (Math.sin(i * 78.233) * 12543.1234) % 1;
  const r3 = (Math.sin(i * 3.71) * 9281.77) % 1;
  return {
    x: (r1 + 1) % 1,
    y: (r2 + 1) % 1,
    b: 0.12 + ((r3 + 1) % 1) * 0.45,
    phase: i * 0.37,
  };
});
const NEBULAE = Array.from({ length: 5 }, (_, i) => {
  const r1 = (Math.sin(i * 21.771) * 36137.13) % 1;
  const r2 = (Math.sin(i * 9.317) * 21891.41) % 1;
  const r3 = (Math.sin(i * 15.913) * 11923.71) % 1;
  return {
    x: (r1 + 1) % 1,
    y: (r2 + 1) % 1,
    r: 160 + ((r3 + 1) % 1) * 180,
    color: i % 2 ? '#8f6dff' : '#35d6e6',
    phase: i * 1.7,
  };
});

// The backdrop (deep-space + nebulae + radar grid + star ticks) is baked into the
// cached static layer (see buildStaticLayer). This is the only live backdrop bit:
// a slow radar sweep across the plotting table — pure command-console chrome.
// Live sweep state (pivot + leading-edge angle), captured each frame so map blips
// can light up as the arm crosses them (radar "ping" afterglow). sweepOn guards
// engines without conic gradients (no visible sweep → no ping).
let sweepCx = 0;
let sweepCy = 0;
let sweepAng = 0;
let sweepOn = false;
let sweepPrevAng = -1; // previous frame's arm angle, for "did the arm cross X" tests
const SWEEP_DIV = 1600; // sweep angular rate: ang = now / SWEEP_DIV
const SWEEP_PERIOD = TAU * SWEEP_DIV; // ms for a full rotation (~10s) — the radar refresh tick
/** Radar contacts as PAINTED BY THE SWEEP: a signature is refreshed only as the arm
 *  crosses it, then lingers at that last-swept spot (a dim ghost) until the next
 *  pass repaints it — so radar gives periodic snapshots, never a live feed. */
const radarMemory = new Map<string, { node: string; size: 'S' | 'M' | 'L'; at: number }>();

/** How brightly a contact at screen-point `c` is lit by the sweep: 1 the instant
 *  the arm crosses it, fading linearly back to 0 just before the next pass (so the
 *  imprint lingers a whole rotation). 0 when the sweep is inactive. */
function sweepGlow(c: { x: number; y: number }): number {
  if (!sweepOn) return 0;
  const entAng = Math.atan2(c.y - sweepCy, c.x - sweepCx); // canvas-clockwise, matches the conic
  let delta = (sweepAng - entAng) % TAU;
  if (delta < 0) delta += TAU;
  const t = 1 - delta / TAU;
  return t * t; // ease so the just-crossed flash reads, with a lingering tail
}

function drawScanSweep(now: number) {
  if (!cx.createConicGradient) return; // graceful: skip on engines without it
  // Pivot the sweep at the MAP centre (projected through the camera), not the
  // screen centre — so it pans / zooms with the map instead of staying glued to
  // the viewport.
  const mc = world({ x: (MINX + MAXX) / 2, y: (MINY + MAXY) / 2 });
  const cxp = mc.x;
  const cyp = mc.y;
  const ang = (now / SWEEP_DIV) % TAU;
  sweepCx = cxp;
  sweepCy = cyp;
  sweepAng = ang;
  sweepOn = true;
  const grd = cx.createConicGradient(ang, cxp, cyp);
  // very subtle trailing wedge — barely-there in a still frame, reads as a slow
  // rotating radar sweep in motion (fades over ~0.4 turn behind the leading edge)
  grd.addColorStop(0, 'rgba(53,214,230,0.032)');
  grd.addColorStop(0.16, 'rgba(53,214,230,0.008)');
  grd.addColorStop(0.4, 'rgba(53,214,230,0)');
  grd.addColorStop(1, 'rgba(53,214,230,0)');
  cx.save();
  cx.globalCompositeOperation = 'lighter';
  cx.fillStyle = grd;
  cx.fillRect(0, 0, VW, VH);
  cx.restore();
}

/** Did the sweep arm cross screen-angle `target` between last frame and this one? */
function sweptThisFrame(target: number): boolean {
  if (sweepPrevAng < 0) return false;
  const d = (sweepAng - sweepPrevAng + TAU) % TAU; // arc the arm swept this frame
  if (d <= 0) return false;
  const t = (((target % TAU) + TAU) % TAU - sweepPrevAng + TAU) % TAU;
  return t > 0 && t <= d;
}

/** Refresh radar contacts the arm crossed this frame: snapshot each radar-only enemy
 *  fleet's spot + coarse size when the sweep paints it. Runs every frame. */
function updateRadarContacts(now: number): void {
  if (!sweepOn) return;
  if (vision) {
    for (const f of Object.values(s.fleets)) {
      if (f.owner === ME) continue;
      const fn = fleetNode(f);
      if (!fn || known(fn) || !radarHas(fn)) continue; // identified or out of radar → not a signature
      const node = s.planets[fn];
      if (!node) continue;
      const pos = world(node.position);
      if (sweptThisFrame(Math.atan2(pos.y - sweepCy, pos.x - sweepCx))) {
        radarMemory.set(f.id, { node: fn, size: sigClass(fleetSignature(f)), at: now });
      }
    }
  }
  sweepPrevAng = sweepAng;
}

/** Draw the remembered radar contacts: a bright flash when freshly swept, settling
 *  to a dim last-known ghost held until the next pass repaints it; dropped once a full
 *  rotation passes with no repaint (the contact has moved on / is gone). */
function drawRadarContacts(now: number): void {
  const FLOOR = 0.32; // dim ghost level the imprint holds between passes
  const FLASH = 1400; // ms of bright flash right after the arm paints it
  for (const [id, m] of radarMemory) {
    const age = now - m.at;
    if (age > SWEEP_PERIOD * 1.25) {
      radarMemory.delete(id); // a whole turn with no repaint → contact lost
      continue;
    }
    const node = s.planets[m.node];
    if (!node) {
      radarMemory.delete(id);
      continue;
    }
    const pos = world(node.position);
    if (!visible(pos, 120)) continue;
    const bright = FLOOR + (1 - FLOOR) * Math.max(0, 1 - age / FLASH);
    drawSignatureAt(pos, m.size, bright, now);
  }
}

// Project a map-space point into the on-screen play area (inside the HUD insets).
let MINX = Infinity;
let MAXX = -Infinity;
let MINY = Infinity;
let MAXY = -Infinity;
for (const n of MAP) {
  MINX = Math.min(MINX, n.x);
  MAXX = Math.max(MAXX, n.x);
  MINY = Math.min(MINY, n.y);
  MAXY = Math.max(MAXY, n.y);
}
// The play area: the screen rectangle the map lives in, inside the HUD insets. Mobile
// no longer reserves the left rail (it folds into the drawer) → the map claims that
// space; desktop keeps the rail + label gutter and the right panel column.
function insets(): { left: number; right: number; top: number; bottom: number } {
  if (MOBILE) {
    return { left: 14, right: VW - 24, top: TOP + 54, bottom: VH - 96 };
  }
  // Wide screens (tablets + landscape): frame the board with reserves that SCALE to the
  // viewport rather than fixed desktop constants. The old fixed 372px right column and
  // 80/150 top/bottom bars wasted most of a tablet's width and squeezed a short landscape
  // screen to a sliver — so the whole-map fit rendered tiny. Clamped so it stays sane
  // across a 9" tablet up to a desktop window.
  const rightPad = Math.min(360, Math.max(120, VW * 0.16));
  const topPad = Math.min(80, Math.max(44, VH * 0.09));
  const botPad = Math.min(150, Math.max(78, VH * 0.16));
  return { left: RAIL + 80, right: VW - rightPad, top: TOP + topPad, bottom: VH - botPad };
}
// Leave a little breathing room around the whole-map (scale-1) view so it reads as a
// framed board, not edge-to-edge. This is the floor of the zoom range (MIN_SCALE = 1).
const FIT_MARGIN = 0.94;
// Base fit: map-space → screen, fitting the whole map inside the play area at scale 1.
function projBase(p: { x: number; y: number }): { x: number; y: number } {
  const { left, right, top, bottom } = insets();
  const aw = Math.max(60, right - left);
  const ah = Math.max(60, bottom - top);
  const mapW = MAXX - MINX || 1;
  const mapH = MAXY - MINY || 1;
  // UNIFORM scale (preserve aspect): one factor for both axes, so a circle in map
  // space stays a circle on screen — distances aren't stretched, and the radar
  // ring reads as a true circle. Fit the whole map inside the play area and centre
  // it (the spare axis gets symmetric margins / letterbox).
  const scale = Math.min(aw / mapW, ah / mapH) * FIT_MARGIN;
  const offX = left + (aw - mapW * scale) / 2;
  const offY = top + (ah - mapH * scale) / 2;
  return { x: offX + (p.x - MINX) * scale, y: offY + (p.y - MINY) * scale };
}

// Camera: pan offset + zoom over the base fit. Node/label sizes stay constant
// in screen pixels; only positions transform (a node-graph style zoom).
const cam = { scale: 1, x: 0, y: 0 };
// Zoom range tied to content: 1 = the whole-map fit (you can't zoom out past it into
// empty void); 6 = close enough to read one province + its neighbours on a phone. On a
// phone the opening view zooms onto your home region (the wide map is too dense to read
// whole on a narrow screen); double-tap resets to that view, pinch out to the overview.
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// node sector type by id — drives asteroid-junction rendering + capture-by-arrival
const SECTOR_OF: Record<string, string> = Object.fromEntries(MAP.map((n) => [n.id, n.sector]));
function world(p: { x: number; y: number }): { x: number; y: number } {
  const b = projBase(p);
  return { x: b.x * cam.scale + cam.x, y: b.y * cam.scale + cam.y };
}
function visible(c: { x: number; y: number }, pad = 80): boolean {
  return c.x >= -pad && c.x <= VW + pad && c.y >= -pad && c.y <= VH + pad;
}
function zoomAt(fx: number, fy: number, factor: number) {
  // Anchor the zoom on the focal point (cursor / pinch centre): the map-space point under
  // it stays put, so zoom grows toward where you're looking instead of drifting.
  const bx = (fx - cam.x) / cam.scale;
  const by = (fy - cam.y) / cam.scale;
  cam.scale = clamp(cam.scale * factor, MIN_SCALE, MAX_SCALE);
  cam.x = fx - bx * cam.scale;
  cam.y = fy - by * cam.scale;
  clampCam();
}

/** Keep the map filling the play area, but with SLACK at the edges so the outermost
 *  provinces don't jam against the screen border — you can pan a comfortable margin
 *  past the content edge, which makes edge navigation easy. At the whole-map (min-zoom)
 *  floor the map sits centred and still; a zoomed-in map pans freely across its content. */
function clampCam(): void {
  const { left, right, top, bottom } = insets();
  const tl = projBase({ x: MINX, y: MINY });
  const br = projBase({ x: MAXX, y: MAXY });
  const pL = tl.x * cam.scale;
  const pR = br.x * cam.scale;
  const pT = tl.y * cam.scale;
  const pB = br.y * cam.scale;
  // Breathing room: allow panning ~16% of the play area past each edge.
  const mx = (right - left) * 0.16;
  const my = (bottom - top) * 0.16;
  // Per axis: if the map is at least as big as the play area, pan within it (+ slack) so
  // an edge can sit a margin inside; otherwise it fits, so park it centred in the play area.
  cam.x =
    pR - pL >= right - left
      ? clamp(cam.x, right - pR - mx, left - pL + mx)
      : (left + right - pL - pR) / 2;
  cam.y =
    pB - pT >= bottom - top
      ? clamp(cam.y, bottom - pB - my, top - pT + my)
      : (top + bottom - pT - pB) / 2;
}

/** Put map-point `p` at the centre of the play area at `scale` (clamped + bounded). */
function centerOn(p: { x: number; y: number }, scale: number): void {
  cam.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
  const b = projBase(p);
  const { left, right, top, bottom } = insets();
  cam.x = (left + right) / 2 - b.x * cam.scale;
  cam.y = (top + bottom) / 2 - b.y * cam.scale;
  clampCam();
}
/** The opening / reset view. On a phone the wide map is too dense to read whole, so
 *  zoom onto your home region and pan to explore; on a wide screen the whole-map fit
 *  reads fine. The zoom is RELATIVE to the screen-fit, so it autoscales across screens. */
function defaultView(): void {
  const home =
    Object.values(s.planets).find((p) => p.owner === ME && p.buildings.length > 0) ??
    Object.values(s.planets).find((p) => p.owner === ME);
  if (MOBILE && home) {
    centerOn(home.position, 3);
  } else {
    cam.scale = 1;
    cam.x = 0;
    cam.y = 0;
    clampCam();
  }
}
// Re-validate the camera after a real resize (orientation / window). Attached after
// `cam` exists so the initial in-module resize() call never touches it (TDZ-safe).
if (typeof window !== 'undefined') window.addEventListener('resize', () => clampCam());

// --- helpers -----------------------------------------------------------------

const planet = (id: string | null | undefined): Planet | undefined =>
  id ? s.planets[id] : undefined;
const isShip = (u: string) => !data.units[u]?.traits.includes('ground');
const isGround = (u: string) => data.units[u]?.domain === 'ground';
const floor = Math.floor;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
/** Compact number like Iron Order's bar: 15.7k, 728, … */
function kfmt(n: number): string {
  const v = Math.round(n);
  return Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(v);
}

function cost(bag: Record<string, number> | undefined): string {
  if (!bag) return 'free';
  const parts = Object.entries(bag).map(([r, n]) => `${n}${r === 'metal' ? 'm' : 'c'}`);
  return parts.length ? parts.join(' ') : 'free';
}
function afford(bag: Record<string, number> | undefined): boolean {
  const res = s.players[ME]?.resources ?? {};
  for (const [r, n] of Object.entries(bag ?? {})) if ((res[r] ?? 0) < n) return false;
  return true;
}
function unitIcon(unit: string): string {
  return UNIT_ICON[unit] ?? (isGround(unit) ? '◆' : '▲');
}
function displayUnit(unit: string): string {
  return unit.replace(/_/g, ' ');
}
function queueOf(planetId: string): PlanetBuildQueue {
  return (buildQueues[planetId] ??= { buildings: [], units: [] });
}
function laneOf(kind: BuildKind): BuildLane {
  return kind === 'unit' ? 'units' : 'buildings';
}
function buildCost(planetId: string, q: QueuedBuild): Record<string, number> | undefined {
  if (q.kind === 'unit') {
    return data.units[q.id]?.cost;
  }
  if (q.kind === 'building') {
    return data.buildings[q.id]?.cost;
  }
  const pl = s.planets[planetId];
  const inst = pl?.buildings.find((b) => b.type === q.id);
  return inst ? data.buildings[q.id]?.upgrades[inst.level - 1]?.cost : undefined;
}
function canStartQueued(planetId: string, q: QueuedBuild): boolean {
  return afford(buildCost(planetId, q));
}
function constructionPayload(payload: unknown): ConstructionPayload | null {
  const p = payload as ConstructionPayload;
  return typeof p?.planetId === 'string' ? p : null;
}
function activeConstruction(planetId: string, lane: BuildLane): ActiveBuild | null {
  let best: ActiveBuild | null = null;
  for (const event of s.scheduled) {
    if (event.type !== 'construction.complete') {
      continue;
    }
    const payload = constructionPayload(event.payload);
    if (!payload || payload.planetId !== planetId) {
      continue;
    }
    const kind = payload.kind === 'unit' ? 'units' : 'buildings';
    if (kind !== lane) {
      continue;
    }
    if (!best || event.at < best.at || (event.at === best.at && event.seq < best.seq)) {
      best = { at: event.at, seq: event.seq, payload };
    }
  }
  return best;
}
function constructionLabel(p: ConstructionPayload): string {
  if (p.kind === 'unit' && p.unit) {
    return `${p.count ?? 1}× ${unitIcon(p.unit)} ${displayUnit(p.unit)}`;
  }
  if (p.kind === 'upgrade' && p.building) {
    return `${BUILD_ICON[p.building] ?? '▣'} ${data.buildings[p.building]?.name ?? p.building} → L${p.level ?? '?'}`;
  }
  if (p.building) {
    return `${BUILD_ICON[p.building] ?? '▣'} ${data.buildings[p.building]?.name ?? p.building}`;
  }
  return 'unknown order';
}
function buildDurationHours(p: ConstructionPayload): number {
  if (p.kind === 'unit' && p.unit) {
    return data.units[p.unit]?.buildTimeHours ?? 0;
  }
  if (p.kind === 'upgrade' && p.building && typeof p.level === 'number') {
    return data.buildings[p.building]?.upgrades[p.level - 2]?.buildTimeHours ?? 0;
  }
  if (p.building) {
    return data.buildings[p.building]?.buildTimeHours ?? 0;
  }
  return 0;
}
function timeLeft(at: number): string {
  const hours = Math.max(0, (at - s.time) / HOUR);
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.ceil(hours * 60)}m`;
}
/** Format a travel-time-remaining in hours as `1.4h` / `35m`. */
function fmtEta(totalH: number): string {
  return totalH >= 1 ? `${totalH.toFixed(1)}h` : `${Math.ceil(totalH * 60)}m`;
}
function progressPct(active: ActiveBuild): number {
  const duration = buildDurationHours(active.payload) * HOUR;
  if (duration <= 0) {
    return 100;
  }
  return Math.max(0, Math.min(100, 100 - ((active.at - s.time) / duration) * 100));
}
function queuedLabel(q: QueuedBuild): string {
  if (q.kind === 'unit') {
    return `${q.count}× ${unitIcon(q.id)} ${displayUnit(q.id)}`;
  }
  if (q.kind === 'upgrade') {
    return `${BUILD_ICON[q.id] ?? '▣'} ${data.buildings[q.id]?.name ?? q.id} upgrade`;
  }
  return `${BUILD_ICON[q.id] ?? '▣'} ${data.buildings[q.id]?.name ?? q.id}`;
}
function enqueueBuild(planetId: string, order: QueuedBuild): void {
  if (NET) {
    // No local build queue in net mode — the server times construction. Send the
    // order straight away (one tap = one build queued server-side).
    const action =
      order.kind === 'unit'
        ? buildUnit(ME, planetId, order.id, order.count)
        : order.kind === 'upgrade'
          ? upgradeBuilding(ME, planetId, order.id)
          : buildBuilding(ME, planetId, order.id);
    playerOrder(action);
    return;
  }
  queueOf(planetId)[laneOf(order.kind)].push(order);
  note(`queued ${queuedLabel(order)} at ${planetId}`);
  pumpBuildQueues();
}
function submitQueued(planetId: string, queued: QueuedBuild): StepOut {
  const action =
    queued.kind === 'unit'
      ? buildUnit(ME, planetId, queued.id, queued.count)
      : queued.kind === 'upgrade'
        ? upgradeBuilding(ME, planetId, queued.id)
        : buildBuilding(ME, planetId, queued.id);
  const out = order(s, action, s.time);
  apply(out);
  return out;
}
// A rally fleet keeps swallowing freshly-built ships only while its world still has
// a ship in the pipeline (one building, or one queued). The moment the queue drains,
// the fleet is "closed" (loses its 'rally' tag) so the NEXT order opens a fresh fleet
// — ships only pool together if you queue the next batch before the current one finishes.
// Single-player only: in net mode the server owns the fleets and their tags.
function closeIdleRallies(): void {
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME || !f.location || f.movement || !f.traits?.includes('rally')) continue;
    const pending =
      !!activeConstruction(f.location, 'units') || (buildQueues[f.location]?.units.length ?? 0) > 0;
    if (!pending) f.traits = f.traits.filter((t) => t !== 'rally');
  }
}
function pumpBuildQueues(): void {
  for (const planetId of Object.keys(buildQueues)) {
    const q = buildQueues[planetId];
    const p = s.planets[planetId];
    if (!p || p.owner !== ME) {
      continue;
    }
    for (const lane of ['buildings', 'units'] as const) {
      const next = q[lane][0];
      if (!next || activeConstruction(planetId, lane) || !canStartQueued(planetId, next)) {
        continue;
      }
      q[lane].shift();
      const r = submitQueued(planetId, next);
      if (r.error) {
        note(`${queuedLabel(next)} failed: ${r.error}`);
      }
    }
  }
}
function fleetPos(f: Fleet): { x: number; y: number } | null {
  if (f.location) return s.planets[f.location]?.position ?? null;
  // Parked at a continuous point ON a lane (stopped mid-march / marched to a point).
  if (f.edge) {
    const a = s.planets[f.edge.from]?.position;
    const b = s.planets[f.edge.to]?.position;
    if (!a || !b) return null;
    return { x: a.x + (b.x - a.x) * f.edge.t, y: a.y + (b.y - a.y) * f.edge.t };
  }
  const m = f.movement;
  if (!m) return null;
  const a = s.planets[m.from]?.position;
  const b = s.planets[m.to]?.position;
  if (!a || !b) return null;
  // The leg only covers the sub-segment [startT, endT] of the lane (a partial leg
  // out of / into a parked position), so interpolate within those bounds.
  const s0 = m.startT ?? 0;
  const e0 = m.endT ?? 1;
  const prog = Math.min(1, Math.max(0, (s.time - m.departedAt) / (m.arrivesAt - m.departedAt)));
  const t = s0 + (e0 - s0) * prog;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
/** Where to draw a battle: the position of a fleet engaged in it (so a mid-lane
 *  intercept renders at the crossing point, not the nearest node), falling back to
 *  the battle's node when no participant is in view. */
function battleAnchor(b: Battle): { x: number; y: number } | null {
  for (const f of Object.values(s.fleets)) {
    if (f.battleId === b.id) {
      const p = fleetPos(f);
      if (p) return p;
    }
  }
  return s.planets[b.location]?.position ?? null;
}

/** The fleets the command bar / move order currently act on (mine only). */
function selectedFleetIds(): string[] {
  if (selFleets.size) return [...selFleets].filter((id) => s.fleets[id]?.owner === ME);
  return selFleet && s.fleets[selFleet]?.owner === ME ? [selFleet] : [];
}

/** Does this fleet carry artillery (units that fire at range — the `fleet.barrage`
 *  / standoff-fire mechanic applies)? */
function fleetHasArtillery(f: Fleet | undefined): boolean {
  return !!f && f.units.some((u) => u.count > 0 && (data.units[u.unit]?.traits.includes('artillery') ?? false));
}

/** A fleet's standoff firing radius (map units) — the longest gun among its live
 *  artillery units sets the reach (mirrors combat.ts artilleryRange). 0 = none. */
function artilleryRangeOf(f: Fleet | undefined): number {
  if (!f) return 0;
  let r = 0;
  for (const u of f.units) {
    if (u.count > 0 && data.units[u.unit]?.traits.includes('artillery')) {
      r = Math.max(r, data.units[u.unit]?.stats.range ?? 0);
    }
  }
  return r;
}

/** The "Дивизии" block for an owned planet: garrisoned divisions + a mobilise row for
 *  the player's 3 locked templates (cost + affordability). */
function divisionsHtml(planetId: string): string {
  const here = Object.values(divisionsOf(s)).filter((d) => d.owner === ME && d.location === planetId);
  let h = `<div class="sec">Дивизии</div>`;
  if (here.length) {
    for (const d of here) {
      const comp = d.units.map((u) => `${FORM_ICON[u.type] ?? '▪'}${u.count}`).join(' ') || '—';
      const hp = Math.round(d.units.reduce((n, u) => n + u.hp, 0));
      const off = d.officer ? OFFICERS[d.officer]?.name : '';
      h += `<div class="asset-row" data-desc="division"><span class="bicon">⊞</span><b>${esc(d.name)}</b><span class="dim">${comp} · ❤${hp}${off ? ' · ★' + esc(off) : ''}</span></div>`;
      // Officer attach / detach (a hero-like leader; bonuses tuned in groundcombat).
      h += `<div class="row">`;
      for (const key of Object.keys(OFFICERS)) {
        const on = d.officer === key;
        h += btn('officer', `${d.id}|${key}`, `${on ? '● ' : ''}${esc(OFFICERS[key]!.name)}`, !on);
      }
      if (d.officer) h += btn('officer', `${d.id}|`, 'Снять', true);
      h += `</div>`;
    }
  } else {
    h += `<div class="row dim">Нет дивизий — мобилизуй по шаблону ниже.</div>`;
  }
  const tpls = templatesOf(s, ME);
  const res = s.players[ME]?.resources ?? {};
  h += `<div class="sec">Мобилизовать дивизию</div>`;
  for (let i = 0; i < tpls.length; i++) {
    const t = tpls[i]!;
    const f = formationStats(t);
    const cost = Object.entries(f.cost).map(([r, a]) => `${a}${r[0]}`).join(' ') || '—';
    const afford = Object.entries(f.cost).every(([r, a]) => (res[r] ?? 0) >= a);
    h += btn('mobilize', String(i), `${esc(t.name)} (${f.count}) · ${cost}`, afford && f.count > 0);
  }
  h += `<div class="hint">Дивизия строится по шаблону из меню. На своём мире +1 HP/юнит/день; полностью выбитая исчезает.</div>`;
  return h;
}

/** Division ⇄ hold transport for a docked fleet `f` over world `here`: load the
 *  player's garrisoning divisions (if they fit the free hold) and unload the ones it
 *  carries (onto an enemy world = a landing). Empty string when there's nothing to do. */
function fleetDivisionsHtml(f: Fleet, here: Planet): string {
  const all = Object.values(divisionsOf(s));
  const carried = all.filter((d) => d.carriedBy === f.id);
  const loadable = all.filter((d) => d.owner === ME && d.carriedBy == null && d.location === here.id);
  if (!carried.length && !loadable.length) return '';
  // Clamp the readout: a carrier that lost ships while loaded can hold more footprint
  // than its remaining capacity (carried footprint is reserved at load time, not
  // re-validated against later losses), so raw free can go negative.
  const free = Math.max(0, fleetCargoFree(s, f));
  let g = `<div class="sec">Дивизии ⇄ трюм (своб. ${free})</div>`;
  if (loadable.length) {
    g += `<div class="row">`;
    for (const d of loadable) {
      const c = divisionCargo(d);
      g += btn('divload', d.id, `▲ ${esc(d.name)} (${c})`, c <= free);
    }
    g += `</div>`;
  }
  if (carried.length) {
    g += `<div class="row">`;
    for (const d of carried) {
      const comp = d.units.map((u) => `${FORM_ICON[u.type] ?? '▪'}${u.count}`).join('') || '—';
      g += btn('divunload', d.id, `▼ ${esc(d.name)} ${comp}`, true);
    }
    g += `</div>`;
  }
  g += `<div class="hint">Загрузка — дивизия должна влезть в трюм; выгрузка высаживает её на этот мир (на чужом — захват, если не обороняется).</div>`;
  return g;
}

const ORBIT_R = 44; // single orbit-ring radius in screen px (before the zoom bloom)
// Past this camera zoom the orbital layer "opens up": rings widen and stationed
// fleets start to circle their planet. Below it everything stays static (and
// fixed-size), exactly as before — cheap at the whole-map view where it'd be invisible.
const ORBIT_ZOOM_IN = 1.6;
let orbitPhase = 0; // accumulated sim-time ms (frozen on pause) — drives the orbit spin
/** Ring/animation are gated on the same close-zoom threshold. */
function orbitsLive(): boolean {
  return cam.scale >= ORBIT_ZOOM_IN;
}
/** Orbit-ring radius scale at the current zoom: compact (half-size) at the far view —
 *  full rings read as bulky there — blooming open to ~2.4× once zoomed in close so
 *  stationed fleets get room to circle. */
function orbitZoom(): number {
  if (cam.scale <= ORBIT_ZOOM_IN) return 0.5;
  return clamp(0.5 + (cam.scale - ORBIT_ZOOM_IN) * 1.2, 0.5, 2.4);
}
/** Orbit-ring radius for a planet at the current zoom, in screen px. The base radius
 *  blooms with zoom (orbitZoom), but is capped to a fraction of the on-screen gap to the
 *  nearest LINKED neighbour so the ring never spills onto the adjacent sectors — zoomed in
 *  tight on a phone the un-capped ring reached its neighbours and looked messy. Fleets sit
 *  on this same radius (so a chevron never floats off the ring). */
function orbitRingRadius(pl: { position: { x: number; y: number }; links?: string[] }): number {
  const pc = world(pl.position);
  let nearest = Infinity;
  for (const nb of pl.links ?? []) {
    const np = s.planets[nb];
    if (!np) continue;
    const npc = world(np.position);
    nearest = Math.min(nearest, Math.hypot(npc.x - pc.x, npc.y - pc.y));
  }
  // cap the ring at ~40% of the gap to the nearest neighbour, then scale by zoom (so two
  // adjacent rings keep a gap and the ring never covers a neighbouring node).
  const scale = nearest === Infinity ? orbitZoom() : Math.min(orbitZoom(), (nearest * 0.4) / ORBIT_R);
  return ORBIT_R * scale;
}
/** Angular position (radians) of a stationed fleet's orbit slot at index `idx` of
 *  `nPeers` sharing the ring — fanned out, and spinning when zoomed in close. */
function orbitAngle(idx: number, nPeers: number): number {
  let a = -Math.PI / 2 + (idx - (nPeers - 1) / 2) * 0.55;
  if (orbitsLive()) a += orbitPhase * 0.00052; // the single ring's steady sweep (rad/ms)
  return a;
}

/** Screen anchor (+ heading) for a fleet's chevron: the interpolated lane
 *  position while moving, or a slot on the orbit ring while stationed
 *  (fleets sharing the ring are fanned out so they don't overlap). */
function fleetAnchor(f: Fleet): { x: number; y: number; ang: number } | null {
  if (f.movement || !f.location) {
    const mp = fleetPos(f);
    if (!mp) return null;
    const c = world(mp);
    let ang = -Math.PI / 2;
    const lane = f.movement ?? f.edge; // heading = along the lane it is on
    if (lane) {
      const a = s.planets[lane.from]?.position;
      const b = s.planets[lane.to]?.position;
      if (a && b) {
        const wa = world(a);
        const wb = world(b);
        ang = Math.atan2(wb.y - wa.y, wb.x - wa.x);
      }
    }
    return { x: c.x, y: c.y, ang };
  }
  const pl = s.planets[f.location];
  if (!pl) return null;
  const pc = world(pl.position);
  // a single orbit: every stationed (non-transit) fleet here shares the one ring
  const peers = Object.values(s.fleets).filter((g) => g.location === f.location && !g.movement);
  const idx = Math.max(
    0,
    peers.findIndex((g) => g.id === f.id),
  );
  const a0 = orbitAngle(idx, peers.length);
  const r = orbitRingRadius(pl);
  // when circling, the chevron faces along its travel (tangent); static = radial as before
  const ang = orbitsLive() ? a0 + Math.PI / 2 : a0;
  return { x: pc.x + Math.cos(a0) * r, y: pc.y + Math.sin(a0) * r, ang };
}
function note(msg: string) {
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  logLines.push(`D${d} ${String(h).padStart(2, '0')}h · ${msg}`);
  while (logLines.length > 9) logLines.shift();
}

/** The map node a fleet occupies / is travelling over / is parked nearest to. */
function fleetNode(f: Fleet): string | null {
  if (f.location) return f.location;
  if (f.movement) {
    // The node the ship is NEAREST to right now — tracks it along the leg, not the
    // destination (so its radar/identify anchor follows the fleet).
    const m = f.movement;
    const span = m.arrivesAt - m.departedAt;
    const prog = span > 0 ? Math.min(1, Math.max(0, (s.time - m.departedAt) / span)) : 1;
    const s0 = m.startT ?? 0;
    const t = s0 + ((m.endT ?? 1) - s0) * prog;
    return t <= 0.5 ? m.from : m.to;
  }
  if (f.edge) return f.edge.t <= 0.5 ? f.edge.from : f.edge.to;
  return null;
}

/** The closest point ON a lane to a screen point: which lane (`from`,`to`), the
 *  fraction `t` along it and its screen position — or null if none within `maxPx`.
 *  Lets the player march an army to any point on a road (Bytro continuous order). */
function nearestLanePoint(
  mx: number,
  my: number,
  maxPx = 14,
): { from: string; to: string; t: number; x: number; y: number } | null {
  let best = maxPx;
  let found: { from: string; to: string; t: number; x: number; y: number } | null = null;
  for (const p of Object.values(s.planets)) {
    const a = world(p.position);
    for (const mId of p.links ?? []) {
      if (p.id >= mId) continue; // each undirected lane once
      const mp = s.planets[mId];
      if (!mp) continue;
      const b = world(mp.position);
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      if (!len2) continue;
      let t = ((mx - a.x) * vx + (my - a.y) * vy) / len2;
      t = Math.min(1, Math.max(0, t));
      const px = a.x + vx * t;
      const py = a.y + vy * t;
      const d = Math.hypot(mx - px, my - py);
      if (d < best) {
        best = d;
        found = { from: p.id, to: mId, t, x: px, y: py };
      }
    }
  }
  return found;
}

/** For a march to a lane point: which endpoint the fleet routes through and the
 *  total ETA (node route + the partial leg into the lane), mirroring the kernel's
 *  cheaper-end choice. Used only for the move preview. */
function laneAim(
  f: Fleet,
  from: string,
  lane: { from: string; to: string; t: number },
): { endId: string; hrs: number } {
  const speed = fleetBaseSpeed(f, data) || 1;
  const a = s.planets[lane.from]?.position;
  const b = s.planets[lane.to]?.position;
  const len = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  const toNode = (to: string): number =>
    from === to ? 0 : (estimateTravelHours(s, data, from, to, f) ?? Infinity);
  const hFrom = toNode(lane.from) + (len * lane.t) / speed; // reach `from`, then advance t
  const hTo = toNode(lane.to) + (len * (1 - lane.t)) / speed; // reach `to`, then back (1-t)
  return hFrom <= hTo ? { endId: lane.from, hrs: hFrom } : { endId: lane.to, hrs: hTo };
}

// --- radar / signatures ------------------------------------------------------
// Radar reach + per-unit "loudness" are DATA, read straight from the content
// (`data.buildings[t].radarRange`, `data.units[u].radarRange`/`signature`) — the
// SAME source the core fog (`visibility.ts`) reads, so single-player and the
// networked view agree by construction, with no mirrored constants to drift. The
// reach values themselves (and why a radar must clear your border to the next ring
// of worlds to yield any signature) are tuned in the content, next to the data.
const SENSOR_HOPS = 1; // identify (full-detail) range from an owned WORLD (jumps); fleets see their own node only
// A radar projects two concentric ranges: signatures out to its full reach, and
// full identification within the inner half (mirrors shared-core visibility).
const IDENTIFY_REACH_FRACTION = 0.5;

/** Total radar signature of a fleet = Σ count × per-unit signature (from content). */
function fleetSignature(f: Fleet): number {
  let sig = 0;
  for (const st of f.units) sig += st.count * (data.units[st.unit]?.signature ?? 1);
  return sig;
}
/** Coarse size bucket shown for a radar contact (reuses the count-label idea). */
function sigClass(sig: number): 'S' | 'M' | 'L' {
  return sig >= 13 ? 'L' : sig >= 5 ? 'M' : 'S';
}
/** Radar reach (distance) a fleet projects, from its loudest radar-ship (0 = none).
 *  Reads `data.units[u].radarRange` — same field the core fog uses. */
function fleetRadar(f: Fleet): number {
  let r = 0;
  for (const st of f.units) if (st.count > 0) r = Math.max(r, data.units[st.unit]?.radarRange ?? 0);
  return r;
}
/** Radar reach (distance) a world projects, from its best radar array (grows with
 *  level). Reads `buildingLevel(def, level).radarRange` — same field the core fog uses. */
function planetRadar(p: Planet): number {
  let r = 0;
  for (const b of p.buildings) {
    const def = data.buildings[b.type];
    if (def) r = Math.max(r, buildingLevel(def, b.level).radarRange);
  }
  return r;
}
/** Add every node within Euclidean `radius` of `start`'s position — radar is a
 *  physical signal, not jumps: a node close in space shows up even if many jumps
 *  away (or unreachable) by the lane graph. */
function withinRadiusAt(origin: { x: number; y: number }, radius: number, out: Set<string>): void {
  const r2 = radius * radius;
  for (const pl of Object.values(s.planets)) {
    const dx = pl.position.x - origin.x;
    const dy = pl.position.y - origin.y;
    if (dx * dx + dy * dy <= r2) out.add(pl.id);
  }
}
function withinRadius(start: string, radius: number, out: Set<string>): void {
  const origin = s.planets[start]?.position;
  if (origin) withinRadiusAt(origin, radius, out);
}

/** Flood `hops` jumps out from `start` over the lane graph into `out`. */
function floodHops(start: string, hops: number, out: Set<string>): void {
  out.add(start);
  let frontier = [start];
  for (let d = 0; d < hops; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const pl = s.planets[id];
      if (!pl?.links) continue;
      for (const l of pl.links)
        if (!out.has(l)) {
          out.add(l);
          next.push(l);
        }
    }
    frontier = next;
  }
}

interface Vision {
  identify: Set<string>;
  radar: Set<string>;
}
/** Variant-B visibility: an identify range (full detail, feeds memory) plus a
 *  wider radar range (enemy fleets seen only as coarse signatures). The radar
 *  reach scales with radar-array level and radar-ships. null vision = fog off. */
function computeVision(): Vision {
  const identify = new Set<string>();
  const radar = new Set<string>();
  for (const p of Object.values(s.planets))
    if (p.owner === ME) {
      floodHops(p.id, SENSOR_HOPS, identify);
      const rr = planetRadar(p);
      if (rr > 0) {
        withinRadius(p.id, rr, radar); // signatures (outer)
        withinRadius(p.id, rr * IDENTIFY_REACH_FRACTION, identify); // full reveal (inner)
      }
    }
  for (const f of Object.values(s.fleets))
    if (f.owner === ME) {
      const node = fleetNode(f);
      if (!node) continue;
      floodHops(node, 0, identify); // own node only — ships are near-blind (mirrors FLEET_IDENTIFY_HOPS)
      const rr = fleetRadar(f);
      if (rr > 0) {
        const pos = fleetPos(f); // radar from the SHIP's position, not its destination
        if (pos) {
          withinRadiusAt(pos, rr, radar); // signatures (outer)
          withinRadiusAt(pos, rr * IDENTIFY_REACH_FRACTION, identify); // full reveal (inner)
        }
      }
    }
  for (const id of identify) radar.add(id); // identify implies radar
  return { identify, radar };
}

// Per-viewer MEMORY of the last identified state of a node (variant B): once you
// have seen a system, you remember its last-known state (greyed) when sight lifts.
interface Snapshot {
  owner: string | null;
  garrison: number;
  buildings: { type: string; level: number }[];
}
const memory = new Map<string, Snapshot>();
function updateMemory(identify: Set<string>): void {
  for (const id of identify) {
    const p = s.planets[id];
    if (p)
      memory.set(id, {
        owner: p.owner,
        garrison: sumUnits(p.garrison),
        buildings: p.buildings.map((b) => ({ type: b.type, level: b.level })),
      });
  }
}

/** True if node `id` is identified (full detail); fog off ⇒ always true. */
function known(id: string | null | undefined): boolean {
  return !vision || (id != null && vision.identify.has(id));
}
/** True if node `id` is inside radar reach (signature-level detection). */
function radarHas(id: string | null | undefined): boolean {
  return !!vision && id != null && vision.radar.has(id);
}

/** Draw a fogged system: a greyed last-known blip from memory, or an unexplored
 *  marker if it has never been identified. */
function drawFogMarker(c: { x: number; y: number }, id: string, mem: Snapshot | undefined): void {
  cx.save();
  if (mem) {
    const col = ownerColor(mem.owner);
    cx.setLineDash([2, 4]);
    cx.strokeStyle = rgba(col, 0.34);
    cx.lineWidth = 1;
    cx.beginPath();
    cx.arc(c.x, c.y, 9, 0, TAU);
    cx.stroke();
    cx.setLineDash([]);
    cx.fillStyle = rgba(col, 0.4);
    cx.beginPath();
    cx.arc(c.x, c.y, 1.6, 0, TAU);
    cx.fill();
    cx.textAlign = 'left';
    cx.fillStyle = rgba(col, 0.5);
    cx.font = '700 11px ui-monospace,Menlo,monospace';
    cx.fillText(id, c.x + 13, c.y - 1);
    cx.fillStyle = 'rgba(120,140,150,0.45)';
    cx.font = '9px ui-monospace,Menlo,monospace';
    const icons = mem.buildings.map((b) => BUILD_ICON[b.type] ?? '▪').join('');
    cx.fillText(`G:${mem.garrison} ${icons} ✦last`, c.x + 13, c.y + 10);
  } else {
    cx.strokeStyle = 'rgba(90,110,120,0.3)';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.arc(c.x, c.y, 6, 0, TAU);
    cx.stroke();
    cx.fillStyle = 'rgba(90,110,120,0.4)';
    cx.font = '9px ui-monospace,Menlo,monospace';
    cx.textAlign = 'center';
    cx.fillText('?', c.x, c.y + 3);
  }
  cx.restore();
}

/** Draw a coarse amber signature blip (size bucket S/M/L) at a screen point, no
 *  identity. `fade` (0..1) dims it — radar contacts are painted by the sweep and
 *  fade between passes (see drawRadarContacts). */
function drawSignatureAt(pos: { x: number; y: number }, cls: 'S' | 'M' | 'L', fade: number, now: number): void {
  const r = cls === 'L' ? 9 : cls === 'M' ? 7 : 5;
  const pulse = 0.5 + 0.5 * Math.sin(now / 200 + pos.x * 0.05);
  cx.save();
  cx.translate(pos.x, pos.y);
  cx.strokeStyle = rgba('#ffb43a', (0.5 + 0.3 * pulse) * fade); // amber = unidentified contact
  cx.fillStyle = rgba('#ffb43a', (0.1 + 0.08 * pulse) * fade);
  cx.lineWidth = 1.3;
  cx.beginPath(); // diamond
  cx.moveTo(0, -r);
  cx.lineTo(r, 0);
  cx.lineTo(0, r);
  cx.lineTo(-r, 0);
  cx.closePath();
  cx.fill();
  cx.stroke();
  cx.fillStyle = rgba('#ffd98a', 0.92 * fade);
  cx.font = '700 9px ui-monospace,Menlo,monospace';
  cx.textAlign = 'center';
  cx.fillText('◆' + cls, 0, r + 12);
  cx.restore();
}
function apply(out: StepOut) {
  s = out.state;
  if (selFleet && !s.fleets[selFleet]) selFleet = null;
  if (splitState && !s.fleets[splitState.fleetId]) splitState = null; // fleet gone → close
  selFleets = new Set([...selFleets].filter((id) => s.fleets[id]?.owner === ME));
  handleEvents(out.events);
}

// A space fortress comes with a fixed orbital-AA emplacement (prototype scenario
// rule). The garrison unit makes the junction "defended" — it can no longer be
// walked into, only stormed — and its AA now fires on near-orbit attackers.
function installFortressAA(planetId: string) {
  const pl = s.planets[planetId];
  if (!pl) return;
  const aa = pl.garrison.find((u) => u.unit === 'orbital_aa' && u.hp === undefined);
  if (aa) aa.count += 1;
  else pl.garrison.push({ unit: 'orbital_aa', count: 1 });
}

/** Apply a player-issued order and surface a rejection in the log (so a denied
 *  click — wrong orbit, no capacity, can't afford — isn't silently swallowed). */
function playerOrder(action: Action) {
  if (NET && netClient) {
    netClient.sendAction(action); // server is authoritative — await its broadcast
    return;
  }
  const out = order(s, action, s.time);
  apply(out);
  if (out.error) note('✖ ' + out.error.replace(/^E_/, '').toLowerCase().replace(/_/g, ' '));
}

// --- timed cargo loading (prototype UX: "погрузка занимает час") --------------
// A ground-army load doesn't snap into the hold — it takes ~1 game-hour. The order
// is queued here and the real `army.load` only fires once the world clock has
// advanced LOAD_TIME, while the fleet marker animates the hold filling up. This is
// prototype-only client state; the deterministic core is untouched.
const LOAD_TIME = HOUR; // ~1 game-hour to lift one ground unit into the hold
interface PendingLoad {
  fleetId: string;
  unit: string;
  startAt: number; // world time the load was ordered
  doneAt: number; // world time it completes
}
let pendingLoads: PendingLoad[] = [];

/** Hold footprint (cargoSize) already reserved by this fleet's in-progress loads. */
function pendingLoadCargo(fleetId: string): number {
  let n = 0;
  for (const p of pendingLoads)
    if (p.fleetId === fleetId) n += data.units[p.unit]?.stats.cargoSize ?? 1;
  return n;
}

/** Queue a ~1h ground-army load if the hold has room (reserving for loads already
 *  under way), so the player can't over-fill the trim before any of them land. */
function beginLoad(fleetId: string, unit: string): void {
  const f = s.fleets[fleetId];
  if (!f || f.movement || f.battleId || !f.location) return;
  const need = data.units[unit]?.stats.cargoSize ?? 1;
  if (need > fleetCargoFree(s, f) - pendingLoadCargo(fleetId)) {
    note('✖ no cargo'); // hold full once the loads already in progress land
    return;
  }
  pendingLoads.push({ fleetId, unit, startAt: s.time, doneAt: s.time + LOAD_TIME });
}

/** Drive queued loads each frame: drop any whose carrier moved / fights / vanished
 *  (load cancelled), and fire the real `army.load` once a load's hour has elapsed. */
function pumpPendingLoads(): void {
  if (!pendingLoads.length) return;
  const keep: PendingLoad[] = [];
  for (const p of pendingLoads) {
    const f = s.fleets[p.fleetId];
    if (!f || f.movement || f.battleId || !f.location) continue; // cancelled
    if (s.time >= p.doneAt) {
      playerOrder(loadArmy(ME, p.fleetId, p.unit, 1)); // kernel moves garrison → hold
      continue;
    }
    keep.push(p);
  }
  pendingLoads = keep;
}

// --- diplomacy gate (client order layer) -------------------------------------
// A move that would cross or end on territory of a player you're at PEACE with is
// blocked: you must declare war first. Such a move opens a confirmation ("this
// declares war on …") instead of dispatching. The AI honours the same rule (see
// aiOrders); the kernel only fights once a `war` stance exists (combat.isHostile).
function blockerName(id: string): string {
  return s.players[id]?.name ?? NAME[id] ?? id;
}
/** Distinct PEACE owners a fleet at node `from` would cross or land on reaching `toId`
 *  — each must be at war before the route opens. Empty ⇒ the move is free. */
function peaceBlockers(from: string | null, toId: string): string[] {
  if (!from || from === toId) return [];
  const route = planRoute(s, from, toId) ?? [toId]; // hops after `from`, incl. dest
  const set = new Set<string>();
  for (const hop of route) {
    const owner = s.planets[hop]?.owner ?? null;
    if (owner != null && !canTraverse(s, ME, owner)) set.add(owner);
  }
  return [...set];
}
/** Order every selected fleet to a world. If the route crosses PEACE territory, stage
 *  a war-declaration prompt instead of dispatching (confirm → declare war + advance). */
function tryMoveGroup(fleetIds: string[], destId: string): void {
  const movers = fleetIds.filter((id) => s.fleets[id] && s.fleets[id]!.location !== destId);
  if (!movers.length) return;
  const blockers = new Set<string>();
  for (const id of movers)
    for (const b of peaceBlockers(fleetNode(s.fleets[id]!), destId)) blockers.add(b);
  if (blockers.size) {
    warPrompt = { fleetIds: movers, destId, blockers: [...blockers] };
    renderWarPrompt();
    return;
  }
  for (const id of movers) playerOrder(moveFleet(ME, id, destId));
}
/** As tryMoveGroup, but the target is a point on a lane (continuous order). Either lane
 *  endpoint sitting on PEACE territory blocks the march until war is declared. */
function tryMoveEdgeGroup(fleetIds: string[], edge: { from: string; to: string; t: number }): void {
  const blockers = new Set<string>();
  for (const id of fleetIds) {
    const node = fleetNode(s.fleets[id]!);
    for (const end of [edge.from, edge.to]) for (const b of peaceBlockers(node, end)) blockers.add(b);
  }
  if (blockers.size) {
    warPrompt = { fleetIds: [...fleetIds], destId: edge.to, edge, blockers: [...blockers] };
    renderWarPrompt();
    return;
  }
  for (const id of fleetIds) playerOrder(moveFleetEdge(ME, id, edge));
}
/** Confirm the staged move: declare war on each blocker (opens the lanes), then issue
 *  the held move for every fleet. War-first ordering means the routes are clear when
 *  the moves apply (solo: sequential; net: server applies in send order). */
function confirmWarPrompt(): void {
  if (!warPrompt) return;
  const wp = warPrompt;
  warPrompt = null;
  hideWarPrompt();
  for (const b of wp.blockers) playerOrder(declareWar(ME, b));
  for (const id of wp.fleetIds) {
    if (wp.edge) playerOrder(moveFleetEdge(ME, id, wp.edge));
    else playerOrder(moveFleet(ME, id, wp.destId));
  }
  note('⚔ War declared — fleets advancing');
}
function cancelWarPrompt(): void {
  warPrompt = null;
  hideWarPrompt();
}
function renderWarPrompt(): void {
  const el = document.getElementById('warprompt');
  if (!el || !warPrompt) return;
  const names = warPrompt.blockers.map((b) => esc(blockerName(b))).join(', ');
  el.innerHTML =
    `<div class="wpbox">` +
    `<div class="wp-head">⚔ DECLARE WAR?</div>` +
    `<div class="wp-body">This route crosses worlds held by <b>${names}</b>, ` +
    `with whom you are at <b>peace</b>. There is no peaceful passage — ` +
    `advancing here declares <b>war</b>.</div>` +
    `<div class="wp-actions"><button class="wp-no">CANCEL</button>` +
    `<button class="wp-yes">DECLARE WAR</button></div>` +
    `</div>`;
  el.classList.add('show');
}
function hideWarPrompt(): void {
  document.getElementById('warprompt')?.classList.remove('show');
}

const NAME: Record<string, string> = { p1: 'Azure', p2: 'Crimson', p3: 'Amber', p4: 'Violet' };
function setFleetSelection(ids: string[]) {
  const picked = ids.filter((id) => s.fleets[id]?.owner === ME);
  selFleets = new Set(picked);
  selFleet = picked.length === 1 ? (picked[0] ?? null) : null;
  selPlanet = null; // a fleet selection never co-selects a planet (mutually exclusive)
  lastPanelHtml = '';
}
function clearSelection() {
  selFleet = null;
  selPlanet = null;
  selFleets = new Set();
  merging = false;
  splitState = null;
  lastPanelHtml = '';
}

/** Ctrl/⌘-click toggle: fold the current selection into a group and add/remove one. */
function toggleFleetInSelection(id: string) {
  if (s.fleets[id]?.owner !== ME) return;
  const next = new Set(selFleets);
  if (selFleet) next.add(selFleet);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setFleetSelection([...next]);
}

/** Order `movers` to merge into `anchorId`. Co-located & idle fleets fuse at once;
 *  distant ones are sent to the anchor's sector and finish on arrival (pending). */
function orderMerge(movers: string[], anchorId: string) {
  const anchor = s.fleets[anchorId];
  if (!anchor || anchor.owner !== ME) return;
  const dest = anchor.location ?? anchor.movement?.to ?? null;
  let queued = 0;
  for (const moverId of movers) {
    if (moverId === anchorId) continue;
    const m = s.fleets[moverId];
    if (!m || m.owner !== ME) continue;
    const coLocated =
      !!m.location && m.location === anchor.location && !m.movement && !anchor.movement;
    if (coLocated) {
      playerOrder(mergeFleet(ME, moverId, anchorId));
    } else {
      pendingMerges = pendingMerges.filter((pm) => pm.mover !== moverId);
      pendingMerges.push({ mover: moverId, into: anchorId });
      if (dest && m.location !== dest) playerOrder(moveFleet(ME, moverId, dest));
      queued++;
    }
  }
  setFleetSelection([anchorId]); // keep the surviving fleet selected for follow-up
  note(queued ? `⛬ ${queued} fleet(s) en route to merge` : '⛬ fleets merged');
}

/** Merge button on a multi-selection: pick a docked anchor, fold the rest into it. */
function mergeGroup(ids: string[]) {
  const fleets = ids.map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  if (fleets.length < 2) return;
  const anchor = fleets.find((f) => f.location && !f.movement) ?? fleets[0]!;
  orderMerge(
    ids.filter((id) => id !== anchor.id),
    anchor.id,
  );
}

/** Drive in-flight merge orders: fuse on arrival, re-chase if the anchor moved. */
function resolvePendingMerges() {
  if (!pendingMerges.length) return;
  pendingMerges = pendingMerges.filter(({ mover, into }) => {
    const m = s.fleets[mover];
    const a = s.fleets[into];
    if (!m || !a) return false; // a fleet is gone (already merged / destroyed) → drop
    if (m.battleId || a.battleId) return true; // hold the order through combat
    if (m.location && a.location && m.location === a.location && !m.movement && !a.movement) {
      playerOrder(mergeFleet(ME, mover, into));
      return false; // co-located & idle → fused, order complete
    }
    const dest = a.location ?? a.movement?.to ?? null;
    if (!m.movement && dest && m.location !== dest) playerOrder(moveFleet(ME, mover, dest));
    return true;
  });
}
function handleEvents(events: DomainEvent[]) {
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'battle.started':
        note(`⚔️ battle at ${p.location} (${p.phase})`);
        if (p.attacker === ME || p.defender === ME) myBattleLocs.add(p.location as string);
        break;
      case 'battle.resolved':
        note(
          `battle at ${p.location} ended — ${p.winner ? NAME[p.winner as string] + ' won' : 'stalemate'}`,
        );
        myBattleLocs.delete(p.location as string);
        break;
      case 'technology.researched':
        if (p.playerId === ME)
          note(`⚛ изучено: ${data.technologies[p.technology as string]?.name ?? (p.technology as string)}`);
        if (techWin.classList.contains('show')) renderTech();
        break;
      case 'planet.captured':
        note(`🚩 ${NAME[p.owner as string]} captured ${p.planetId}`);
        if (diploOpen && diploTab === 'diplo') renderDiplo(); // province counts shifted
        break;
      case 'diplomacy.changed': {
        const a = p.a as string;
        const b = p.b as string;
        const st = p.stance as DiplomaticStance;
        const na = NAME[a] ?? a;
        const nb = NAME[b] ?? b;
        // Only events that involve YOU land in a conversation (your DM with the other
        // party); two AIs re-stancing each other isn't part of any of your chats.
        if (a === ME || b === ME) {
          pushMsg(
            b,
            st === 'war' ? `${na} объявил войну ${nb}` : `${na} и ${nb}: ${STANCE_RU[st].toLowerCase()}`,
            true,
            a,
          );
          note(`${na} → ${nb}: ${STANCE_RU[st]}`);
        }
        if (diploOpen && diploTab === 'diplo') renderDiplo();
        break;
      }
      case 'building.constructed':
        note(`🏗️ ${p.building} built at ${p.planetId}`);
        if (p.building === 'starfort') installFortressAA(p.planetId as string);
        break;
      case 'building.upgraded':
        note(`⬆️ ${p.building} → L${p.level} at ${p.planetId}`);
        break;
      case 'building.destroyed':
        note(`💥 ${p.building} destroyed at ${p.planetId}`);
        break;
      case 'unit.built':
        note(`🛠️ ${p.count}× ${p.unit} at ${p.planetId}`);
        break;
      case 'fleet.launched':
        note(`🚀 ${NAME[p.owner as string]} launched a fleet from ${p.planetId}`);
        break;
      case 'fleet.merged':
        if (p.owner === ME) note(`⛬ fleets merged at ${p.at}`);
        break;
      case 'fleet.split':
        if (p.owner === ME) note(`⊟ fleet split at ${p.at}`);
        break;
      case 'fleet.destroyed':
        note(`☠️ a ${NAME[p.owner as string]} fleet was destroyed`);
        break;
      case 'unit.died': {
        // War record — only count casualties in battles you're part of, so the AI's
        // fights elsewhere don't pad your numbers. Your dead = lost; the rest = destroyed.
        if (myBattleLocs.has(p.at as string)) {
          const n = (p.count as number) ?? 0;
          if (p.owner === ME) killStats.lost += n;
          else killStats.destroyed += n;
        }
        break;
      }
    }
  }
}

// Walk-in capture (undefended, uncontested, capturable sector) is now a kernel
// rule — `captureOnArrivalModule` — so it applies on the authoritative server and
// in single-player alike; the resulting `planet.captured` event is noted above.

// --- red AI ------------------------------------------------------------------

function runAI() {
  if (s.time - lastAiAt < 2 * HOUR) return;
  lastAiAt = s.time;
  // Each empty seat's orders come from the shared `aiOrders` (same logic the net
  // server uses to drive unfilled multiplayer seats). Apply them in sequence.
  for (const ai of AI_PLAYERS) {
    for (const a of aiOrders(s, ai)) apply(order(s, a, s.time));
  }
}

// Enemy (AI) auto-engagement: an idle hostile fleet over a world it doesn't own,
// with the orbit clear, descends and lands automatically — keeps the AI pressing
// the capture loop. The player's own fleets are driven by hand (orbit/bombard/
// assault controls in the fleet panel), so they are skipped here.
function autoEngage() {
  for (const f of Object.values(s.fleets)) {
    if (f.owner === ME || f.location == null || f.movement || f.battleId) continue;
    if (!SECTOR_TYPES[SECTOR_OF[f.location]]?.capturable) continue; // empty space can't be taken
    const here = s.planets[f.location];
    if (!here || here.owner === f.owner) continue;
    const enemyHere = Object.values(s.fleets).some(
      (g) => g.owner !== f.owner && g.location === f.location && g.units.some((u) => u.count > 0),
    );
    if (enemyHere) continue; // let the auto orbital battle settle first
    if (f.orbit !== 'near') apply(order(s, orbitFleet(f.owner, f.id, 'near'), s.time));
    apply(order(s, assaultFleet(f.owner, f.id), s.time));
  }
}

// Safety-net: detect two docked enemy fleets sharing a sector without a battle
// and force-engage them. Catches the case where both fleets were in-transit when
// the other arrived, so the combat module's arrival handler found no enemy.
function checkFleetClashes() {
  const fleets = Object.values(s.fleets);
  for (const f of fleets) {
    if (!f.location || f.movement || f.battleId) continue;
    for (const g of fleets) {
      if (g.id <= f.id) continue; // avoid processing the same pair twice
      if (!g.location || g.movement || g.battleId) continue;
      if (f.owner === g.owner || f.location !== g.location) continue;
      // Two idle enemy fleets in the same sector — start a battle from the ME side
      const myFleet = f.owner === ME ? f : g.owner === ME ? g : f;
      const foeFleet = myFleet === f ? g : f;
      apply(order(s, engageFleet(myFleet.owner, myFleet.id, foeFleet.id), s.time));
    }
  }
}

/** How the match ended, in plain words (perspective comes from the prefix). */
function endReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'domination':
      return 'by galactic domination';
    case 'elimination':
      return 'by elimination';
    case 'score':
      return 'by score limit';
    case 'timeout':
      return 'on the clock';
    default:
      return 'the match has ended';
  }
}

/** Terminal banner read from the AUTHORITATIVE `match` state (the victory module
 *  in the kernel — local sim and the net server both run it), not a hand-rolled
 *  guess. Fires once; a draw (no winner on timeout) is its own line. */
function checkEnd() {
  if (banner) return;
  if (s.match?.status !== 'ended') return;
  const why = endReasonText(s.match.reason);
  banner =
    s.match.winner === ME
      ? `🏆 VICTORY — ${why}`
      : s.match.winner === null
        ? `⚖️ DRAW — ${why}`
        : `💀 DEFEAT — ${why}`;
}

// --- rendering ---------------------------------------------------------------

/** A regular polygon path centred at (x,y) — fort/station containment marker. */
function poly(x: number, y: number, r: number, sides: number, rot = 0) {
  cx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i) cx.lineTo(px, py);
    else cx.moveTo(px, py);
  }
  cx.closePath();
}

// Stable asteroid cluster for an asteroid-field junction — built once and seeded
// by the node position, so the rocks never shimmer or move between frames.
interface Rock {
  dx: number;
  dy: number;
  r: number;
  rot: number;
  sides: number;
}
const asteroidCache = new Map<string, Rock[]>();
function asteroidsFor(id: string, x: number, y: number): Rock[] {
  const hit = asteroidCache.get(id);
  if (hit) return hit;
  let seed = (Math.floor(x * 3457) ^ Math.floor(y * 8761) ^ 0x9e3779b9) >>> 0;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const rocks: Rock[] = [];
  const count = 9 + Math.floor(rnd() * 4);
  for (let i = 0; i < count; i++) {
    const ang = rnd() * TAU;
    const dist = 7 + rnd() * 21;
    rocks.push({
      dx: Math.cos(ang) * dist,
      dy: Math.sin(ang) * dist * 0.72, // slightly flattened → reads as a belt
      r: 1.5 + rnd() * 2.8,
      rot: rnd() * TAU,
      sides: 3 + Math.floor(rnd() * 3),
    });
  }
  asteroidCache.set(id, rocks);
  return rocks;
}

/** Four slowly-rotating corner brackets — the "locked target" selection reticle. */
function targetBrackets(x: number, y: number, r: number, t: number) {
  cx.save();
  cx.translate(x, y);
  cx.rotate(t / 1600);
  cx.strokeStyle = LOCK;
  cx.lineWidth = 1.6;
  cx.shadowColor = LOCK;
  cx.shadowBlur = 8;
  const len = 6;
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    cx.beginPath();
    cx.moveTo(sx * r - sx * len, sy * r);
    cx.lineTo(sx * r, sy * r);
    cx.lineTo(sx * r, sy * r - sy * len);
    cx.stroke();
  }
  cx.restore();
}



function drawBattlePulse(x: number, y: number, pulse: number) {
  cx.save();
  cx.shadowColor = '#ff5a4d';
  cx.shadowBlur = 12;
  for (let i = 0; i < 3; i++) {
    const k = (pulse + i / 3) % 1;
    cx.strokeStyle = rgba('#ff5a4d', 0.55 * (1 - k));
    cx.lineWidth = 1.2 + i * 0.25;
    cx.beginPath();
    cx.arc(x, y, 18 + k * 24, 0, TAU);
    cx.stroke();
  }
  cx.restore();
}

/**
 * Rings for my own radar reach (planet arrays + radar-ships). Each radar projects
 * TWO concentric ranges (matching shared-core visibility): an OUTER signature ring
 * (full reach — enemy fleets show as coarse blips in fog) and an INNER full-reveal
 * ring (half the reach — contacts fully identified). The reach is a Euclidean
 * distance in MAP units; the projection is uniform so they read as true circles.
 * Only meaningful with fog on.
 */
// Offscreen layer for compositing the UNION of radar circles into one clean
// frontier (so overlapping ranges read as a single border, not a tangle of rings).
let unionCv: HTMLCanvasElement | null = null;
function unionCtx(): CanvasRenderingContext2D {
  if (!unionCv) unionCv = document.createElement('canvas');
  if (unionCv.width !== canvas.width || unionCv.height !== canvas.height) {
    unionCv.width = canvas.width;
    unionCv.height = canvas.height;
  }
  const g = unionCv.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, unionCv.width, unionCv.height);
  g.setTransform(DPR, 0, 0, DPR, 0, 0); // draw in CSS px, matching the main canvas
  return g;
}

/** Paint a set of screen circles as ONE merged region: a faint union fill plus a
 *  crisp union outline. A circle fully inside another contributes nothing; an
 *  outlier extends the frontier — exactly one "border of visibility". */
function drawUnionTier(
  circles: Array<{ x: number; y: number; r: number }>,
  lineW: number,
  fillA: number,
  strokeA: number,
): void {
  if (!circles.length) return;
  const arcs = (g: CanvasRenderingContext2D, inset: number): void => {
    g.beginPath();
    for (const c of circles) {
      const r = c.r - inset;
      if (r > 0) {
        g.moveTo(c.x + r, c.y); // moveTo each ⇒ separate subpaths, no joining lines
        g.arc(c.x, c.y, r, 0, TAU);
      }
    }
  };
  // Filled union, drawn as ONE path straight onto the map — overlaps merge under
  // nonzero winding, so there are no internal seams.
  if (fillA > 0) {
    cx.fillStyle = rgba(LOCK, fillA);
    arcs(cx, 0);
    cx.fill();
  }
  // Crisp outline: fill the union white, erode an inset copy with destination-out
  // → a ring tracing only the outer frontier; tint it, then blit 1:1 onto the map.
  if (strokeA > 0 && lineW > 0) {
    const g = unionCtx();
    g.fillStyle = '#fff';
    arcs(g, 0);
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    arcs(g, lineW);
    g.fill();
    g.globalCompositeOperation = 'source-in';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = rgba(LOCK, strokeA);
    g.fillRect(0, 0, unionCv!.width, unionCv!.height);
    g.globalCompositeOperation = 'source-over';
    cx.save();
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.drawImage(unionCv as HTMLCanvasElement, 0, 0);
    cx.restore();
  }
}

function drawRadarCoverage() {
  // My radar sources (planet arrays + radar-ships), tagged so a SELECTED entity can
  // also show its own precise range on top of the merged frontier.
  type Src = { x: number; y: number; r: number; sel: boolean };
  const sources: Src[] = [];
  const selFleetSet = new Set(selectedFleetIds());
  for (const p of Object.values(s.planets)) {
    if (p.owner !== ME) continue;
    const r = planetRadar(p);
    if (r > 0) sources.push({ x: p.position.x, y: p.position.y, r, sel: selPlanet === p.id });
  }
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME) continue;
    const r = fleetRadar(f);
    // Draw the ring at the SHIP's actual position (interpolated for a moving fleet),
    // so the coverage tracks the fleet instead of sitting on its destination node.
    const pos = r > 0 ? fleetPos(f) : null;
    if (pos) sources.push({ x: pos.x, y: pos.y, r, sel: selFleetSet.has(f.id) });
  }
  if (!sources.length) return;
  // Project map circles to screen circles (uniform projection ⇒ true circles).
  const screen = (x: number, y: number, rr: number): { x: number; y: number; r: number } => {
    const c = world({ x, y });
    return { x: c.x, y: c.y, r: world({ x: x + rr, y }).x - c.x };
  };
  const outer = sources.map((v) => screen(v.x, v.y, v.r)).filter((c) => c.r > 0);
  const inner = sources
    .map((v) => screen(v.x, v.y, v.r * IDENTIFY_REACH_FRACTION))
    .filter((c) => c.r > 0);
  cx.save();
  // The unified visibility frontier: outer (signatures) then inner (full reveal).
  drawUnionTier(outer, 1.2, 0.03, 0.16);
  drawUnionTier(inner, 1.4, 0.05, 0.3);
  // A selected planet/fleet additionally shows ITS OWN two rings — crisp + dashed —
  // so you can read one entity's exact reach out of the merged whole.
  for (const v of sources) {
    if (!v.sel) continue;
    const c = world({ x: v.x, y: v.y });
    const ring = (rr: number, dash: number[], a: number): void => {
      const r = world({ x: v.x + rr, y: v.y }).x - c.x;
      if (!(r > 0)) return;
      cx.beginPath();
      cx.arc(c.x, c.y, r, 0, TAU);
      cx.setLineDash(dash);
      cx.lineWidth = 1.3;
      cx.strokeStyle = rgba(LOCK, a);
      cx.stroke();
    };
    ring(v.r, [3, 6], 0.5); // outer — signatures
    ring(v.r * IDENTIFY_REACH_FRACTION, [], 0.72); // inner — full reveal
  }
  cx.setLineDash([]);
  cx.restore();
}

/** The planned route of every moving fleet of mine — dashed, brighter if selected. */
function drawFleetRoutes() {
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME || !f.movement) continue;
    const start = fleetAnchor(f);
    if (!start) continue;
    const sel = selFleet === f.id || selFleets.has(f.id);
    const mv = f.movement;
    const nodes = [mv.to, ...(mv.path ?? [])];
    // If the journey ends at a POINT on the final lane (`toEdge` order), the last
    // route point must be that point — not the destination node it would latch to.
    const parkFrac = mv.parkT ?? mv.endT ?? 1;
    const pts = [{ x: start.x, y: start.y }];
    for (let i = 0; i < nodes.length; i++) {
      const pl = s.planets[nodes[i]!];
      if (!pl) continue;
      if (i === nodes.length - 1 && parkFrac < 1) {
        const prev = s.planets[i === 0 ? mv.from : nodes[i - 1]!]?.position;
        if (prev) {
          pts.push(
            world({
              x: prev.x + (pl.position.x - prev.x) * parkFrac,
              y: prev.y + (pl.position.y - prev.y) * parkFrac,
            }),
          );
          continue;
        }
      }
      pts.push(world(pl.position));
    }
    if (pts.length < 2) continue;
    cx.save();
    cx.setLineDash([4, 6]);
    cx.strokeStyle = rgba(LOCK, sel ? 0.85 : 0.32);
    cx.lineWidth = sel ? 1.8 : 1.1;
    cx.shadowColor = LOCK;
    cx.shadowBlur = sel ? 8 : 2;
    cx.beginPath();
    cx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i]!.x, pts[i]!.y);
    cx.stroke();
    const d = pts[pts.length - 1]!;
    cx.setLineDash([]);
    cx.beginPath();
    cx.arc(d.x, d.y, 4, 0, TAU);
    cx.stroke();
    cx.restore();
  }
}

/** While "Move" is armed: a dashed line from each selected fleet to the world
 *  under the pointer (snaps to the nearest blip) — preview before committing. */
function drawAimPreview() {
  if (!aiming || !aimPointer) return;
  const ids = selectedFleetIds();
  if (!ids.length) return;
  // Prefer a node target; if none is near, aim at the closest point ON a lane —
  // the army will route to that road and park there (Bytro continuous order).
  // The node pick radius MUST match selectAt's (24px): with the old 30px, a tap
  // 24–30px from a junction dispatched a lane park (fleet flies to the road point)
  // while the preview drew the path to the node — the reported mismatch.
  let target: { x: number; y: number } | null = null;
  let targetId: string | null = null;
  let best = 24;
  for (const n of MAP) {
    const c = world(n);
    const d = Math.hypot(aimPointer.x - c.x, aimPointer.y - c.y);
    if (d < best) {
      best = d;
      target = c;
      targetId = n.id;
    }
  }
  const laneTarget = targetId ? null : nearestLanePoint(aimPointer.x, aimPointer.y);
  if (laneTarget) target = { x: laneTarget.x, y: laneTarget.y };
  const tip = target ?? aimPointer;
  cx.save();
  cx.strokeStyle = rgba(LOCK, 0.6);
  cx.lineWidth = 1.4;
  cx.setLineDash([3, 5]);
  cx.shadowColor = LOCK;
  cx.shadowBlur = 6;
  for (const id of ids) {
    const f = s.fleets[id];
    if (!f) continue;
    const a = fleetAnchor(f);
    if (!a) continue;
    // draw the ROUTED march path through province centres (Bytro-style), so you
    // see the actual road the army will take — not a straight line to the target.
    const from = fleetNode(f);
    // For a lane target, route to the endpoint the army enters through, then a
    // final segment to the point on the road.
    const routeEndId = laneTarget && from ? laneAim(f, from, laneTarget).endId : targetId;
    const pts: Array<{ x: number; y: number }> = [a];
    if (from && routeEndId && routeEndId !== from) {
      const route = planRoute(s, from, routeEndId);
      if (route)
        for (const hop of route) {
          const pl = s.planets[hop];
          if (pl) pts.push(world(pl.position));
        }
    }
    if (laneTarget) pts.push({ x: laneTarget.x, y: laneTarget.y });
    if (pts.length === 1) pts.push(tip);
    cx.beginPath();
    cx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i]!.x, pts[i]!.y);
    cx.stroke();
  }
  if (target) {
    cx.setLineDash([]);
    cx.beginPath();
    cx.arc(tip.x, tip.y, laneTarget ? 9 : 16, 0, TAU); // smaller pip for a road point
    cx.stroke();
    // travel-time estimate to this target for the first selected fleet (longer
    // route → more hours; the authoritative time is computed by the server).
    const f0 = s.fleets[ids[0]!];
    const from = f0 ? fleetNode(f0) : null;
    let hrs: number | null = null;
    if (f0 && from) {
      if (laneTarget) hrs = laneAim(f0, from, laneTarget).hrs;
      else if (targetId) hrs = estimateTravelHours(s, data, from, targetId, f0);
    }
    if (hrs != null && Number.isFinite(hrs)) {
      cx.font = '11px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.fillStyle = rgba(LOCK, 0.95);
      cx.fillText(hrs >= 1 ? `~${hrs.toFixed(1)}h` : `~${Math.ceil(hrs * 60)}m`, tip.x, tip.y - 22);
    }
  }
  cx.restore();
}

let selectionBox: { x1: number; y1: number; x2: number; y2: number } | null = null;

/**
 * Province field — the whole map is a tiling of provinces (Bytro/Paradox-style):
 * every point belongs to the nearest seed (planets = capturable territory tinted
 * in the owner's colour; empty-space voids = uncapturable, neutral). The tiling is
 * computed as vector Voronoi cells (half-plane clipping) in base space and filled
 * under the camera each frame — so it covers the whole map, scales without
 * stretching, and never shimmers. Rebuilt only on viewport / ownership change.
 */
// --- holographic static layer (territory + hyperlanes), camera-baked & cached --
// The expensive world-space art — influence glows + the hyperlane network — is
// rendered once into an offscreen canvas and re-blitted every frame; it rebuilds
// only when the camera, ownership or viewport changes. Idle frames cost a single
// drawImage, so the map holds 60fps instead of re-tracing the whole graph + a
// Voronoi tiling every frame.
const bg = document.createElement('canvas');
const bgx = bg.getContext('2d') as CanvasRenderingContext2D;
let bgContent = ''; // viewport + ownership signature (camera-independent)
let bgCam = { x: 0, y: 0, scale: 1 }; // camera the static layer was last baked at

function ownersSig(): string {
  let out = '';
  for (const n of MAP) out += (s.planets[n.id]?.owner ?? '·') + ',';
  return out;
}

/** Clip a convex polygon to the half-plane a*x + b*y + c ≤ 0 (Sutherland–Hodgman).
 *  Used to carve the weighted-Voronoi (power-diagram) province cells. */
function clipHalfPlane(
  poly: Array<[number, number]>,
  a: number,
  b: number,
  c: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % poly.length]!;
    const dc = a * cur[0] + b * cur[1] + c;
    const dn = a * nxt[0] + b * nxt[1] + c;
    if (dc <= 0) out.push(cur);
    if (dc < 0 !== dn < 0) {
      const t = dc / (dc - dn);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out;
}

/** Sentinel edge-tag: this province edge sits on the map boundary, not a neighbour. */
const BOUNDARY = -1;

/** Like {@link clipHalfPlane}, but carries a per-edge tag so the political map can
 *  colour each border by what lies across it. `tags[k]` is what borders the edge
 *  `poly[k]→poly[k+1]`: a neighbour seed index (≥0) or BOUNDARY. The newly-cut edge
 *  (along the clip line) is tagged `clipTag` (the seed we clipped against); surviving
 *  original edges keep their tag. Lets same-owner borders draw as faint hairlines
 *  (the empire reads as one field) and owner-vs-owner borders as a bright frontier. */
function clipHalfPlaneTagged(
  poly: Array<[number, number]>,
  tags: number[],
  a: number,
  b: number,
  c: number,
  clipTag: number,
): { poly: Array<[number, number]>; tags: number[] } {
  const out: Array<[number, number]> = [];
  const outT: number[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % n]!;
    const tag = tags[i]!;
    const dc = a * cur[0] + b * cur[1] + c;
    const dn = a * nxt[0] + b * nxt[1] + c;
    const cross = dc < 0 !== dn < 0;
    if (dc <= 0) {
      out.push(cur);
      if (cross) {
        const t = dc / (dc - dn);
        out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
        outT.push(tag); // cur → intersection: surviving part of the original edge
        outT.push(clipTag); // intersection → next: along the new clip line (this neighbour)
      } else {
        outT.push(tag); // wholly-inside original edge keeps its tag
      }
    } else if (cross) {
      const t = dc / (dc - dn);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
      outT.push(tag); // intersection → nxt: re-entering part of the original edge
    }
  }
  return { poly: out, tags: outT };
}

/** Rebuild the cached province map when the camera/ownership/viewport moves. */
function buildStaticLayer(): void {
  // Rebuild only when the content/size changes, or when the camera has SETTLED at a
  // new spot. During an active pan/zoom we skip the O(n²) re-tessellation entirely
  // and let blitStaticLayer follow the camera with the last bake (transformed).
  const content = `${VW}x${VH}:${DPR.toFixed(2)}|${ME}|${ownersSig()}`;
  const sizeOk = bg.width === Math.round(VW * DPR);
  const camSame = cam.x === bgCam.x && cam.y === bgCam.y && cam.scale === bgCam.scale;
  // Re-bake whenever the camera moved. The bake is viewport-sized, so following a pan
  // with a transformed STALE bake left the newly-revealed area uncovered — a smear / a
  // map squeezed into a corner on the wide map. A 52-seed power diagram is cheap enough
  // to re-tile per moved frame; idle frames (camera at rest) still cost one cached blit.
  if (sizeOk && content === bgContent && camSame) return;
  bgContent = content;
  bgCam = { x: cam.x, y: cam.y, scale: cam.scale };
  bg.width = Math.round(VW * DPR);
  bg.height = Math.round(VH * DPR);
  const g = bgx;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, VW, VH);

  // 0) backdrop — deep-space fill + slow nebula clouds + a radar plotting grid +
  //    faint star ticks. Baked here (not per-frame) so idle frames stay cheap; the
  //    "alive" motion comes from the live layers (lane packets, scan sweep, fleets).
  g.fillStyle = '#02060c';
  g.fillRect(0, 0, VW, VH);
  for (const neb of NEBULAE) {
    const r = neb.r * (MOBILE ? 0.7 : 1);
    const grd = g.createRadialGradient(neb.x * VW, neb.y * VH, 0, neb.x * VW, neb.y * VH, r);
    grd.addColorStop(0, rgba(neb.color, 0.06));
    grd.addColorStop(0.45, rgba(neb.color, 0.024));
    grd.addColorStop(1, 'rgba(2,6,12,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, VW, VH);
  }
  const gap = Math.max(28, 56 * cam.scale);
  const ox = ((cam.x % gap) + gap) % gap;
  const oy = ((cam.y % gap) + gap) % gap;
  g.lineWidth = 1;
  g.strokeStyle = GRID;
  g.beginPath();
  for (let x = ox; x <= VW; x += gap) {
    g.moveTo(x, 0);
    g.lineTo(x, VH);
  }
  for (let y = oy; y <= VH; y += gap) {
    g.moveTo(0, y);
    g.lineTo(VW, y);
  }
  g.stroke();
  for (const st of STARS) {
    g.fillStyle = rgba('#9fe6e0', st.b);
    g.fillRect(st.x * VW, st.y * VH, 1, 1);
  }

  // PROVINCES — political map (Bytro-style). Every sector is a filled CELL of a
  // weighted Voronoi (power diagram) over the sector centres: the cells tile the
  // map and share borders, so a bigger `size` claims more territory and resizing
  // one shifts the shared borders with its neighbours evenly. Adjacency IS the
  // shared border — no lanes. (Empty void waypoints aren't real provinces → skipped.)
  const W = 9000 * cam.scale * cam.scale; // size → weight (screen px²), zoom-consistent
  const seeds: Array<{ x: number; y: number; w: number; owner: string | null; kind: string }> = [];
  for (const n of MAP) {
    if (n.sector === 'empty') continue;
    const p = s.planets[n.id];
    if (!p) continue;
    const c = world(n);
    seeds.push({ x: c.x, y: c.y, w: (p.size ?? 1) * W, owner: p.owner ?? null, kind: n.sector });
  }
  // Keep the power diagram valid: clamp the weight spread so a heavier neighbour can
  // never swallow a close smaller node's cell (which left it with no province border).
  clampPowerWeights(seeds);
  // Clip cells to the MAP boundary (province bounding box + padding), not the
  // viewport — otherwise the outermost provinces stretch to the screen edge. This
  // gives the map a defined edge that pans/zooms with the camera.
  const padB = Math.max(40, (MAXX - MINX) * 0.05);
  const tl = world({ x: MINX - padB, y: MINY - padB });
  const br = world({ x: MAXX + padB, y: MAXY + padB });
  const clip: Array<[number, number]> = [
    [tl.x, tl.y],
    [br.x, tl.y],
    [br.x, br.y],
    [tl.x, br.y],
  ];
  const trace = (poly: Array<[number, number]>): void => {
    g.beginPath();
    g.moveTo(poly[0]![0], poly[0]![1]);
    for (let k = 1; k < poly.length; k++) g.lineTo(poly[k]![0], poly[k]![1]);
    g.closePath();
  };
  // Pass 1 — bake every province cell (tagged power-diagram polygon) and its fill.
  // Same owner ⇒ same colour, so a captured cluster paints as ONE political field.
  const cells: Array<{
    poly: Array<[number, number]>;
    tags: number[];
    owner: string | null;
    idx: number;
  }> = [];
  for (let i = 0; i < seeds.length; i++) {
    const si = seeds[i]!;
    let poly: Array<[number, number]> = clip.map((q) => [q[0], q[1]]);
    let tags: number[] = clip.map(() => BOUNDARY);
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (i === j) continue;
      const sj = seeds[j]!;
      // power-diagram half-plane: keep |x-ci|² - wi ≤ |x-cj|² - wj
      const a = 2 * (sj.x - si.x);
      const b = 2 * (sj.y - si.y);
      const cc = si.x * si.x + si.y * si.y - si.w - (sj.x * sj.x + sj.y * sj.y - sj.w);
      ({ poly, tags } = clipHalfPlaneTagged(poly, tags, a, b, cc, j));
    }
    if (poly.length < 3) continue;
    // Unified territory fill. Owned land is painted STRONGLY in its owner colour so
    // who-holds-what reads at a glance — your worlds clearly green, each rival its hue
    // — and it ignores fog on purpose: a province an enemy has captured keeps showing
    // its owner colour even when you can't see the garrison (last-known control map,
    // Bytro/HoI-style). Neutral stays a faint wash.
    trace(poly);
    g.fillStyle = rgba(si.owner ? ownerColor(si.owner) : COLOR.null, si.owner ? 0.58 : 0.1);
    g.fill();
    // faint terrain/kind accent — each province still reads as its own kind of place
    // (nebula slows fleets, gas-giant boosts output, …)
    const accent = SECTOR_TYPES[si.kind]?.color;
    if (accent) {
      trace(poly);
      g.fillStyle = rgba(accent, 0.16); // province-type tint reads through the owner fill
      g.fill();
    }
    cells.push({ poly, tags, owner: si.owner, idx: i });
  }

  // Pass 2 — classify every cell edge by what's across it. Same-owner borders are
  // thin INNER hairlines (so an empire stays one colour field with subtle province
  // divisions); owner-vs-(other owner / neutral / void) borders are a glowing
  // FRONTIER in the owner's colour. That contrast is the "merged territory, thinly
  // outlined provinces" look.
  type Seg = [number, number, number, number];
  const ownedFront = new Map<string, Seg[]>();
  const ownedInner = new Map<string, Seg[]>();
  const neutralEdge: Seg[] = [];
  const bucket = (m: Map<string, Seg[]>, key: string): Seg[] => {
    let arr = m.get(key);
    if (!arr) m.set(key, (arr = []));
    return arr;
  };
  for (const cell of cells) {
    const { poly, tags, owner, idx } = cell;
    const m = poly.length;
    for (let k = 0; k < m; k++) {
      const t = tags[k]!;
      const p0 = poly[k]!;
      const p1 = poly[(k + 1) % m]!;
      const seg: Seg = [p0[0], p0[1], p1[0], p1[1]];
      const neigh = t >= 0 ? seeds[t]!.owner : undefined; // undefined ⇒ map boundary
      if (t >= 0 && owner !== null && neigh === owner) {
        if (idx < t) bucket(ownedInner, ownerColor(owner)).push(seg); // same empire, draw once
      } else if (owner !== null) {
        bucket(ownedFront, ownerColor(owner)).push(seg); // empire frontier (each side glows)
      } else if (t === BOUNDARY || idx < t) {
        neutralEdge.push(seg); // neutral province division (faint, drawn once)
      }
    }
  }
  const strokeSegs = (segs: Seg[], style: string, width: number): void => {
    if (segs.length === 0) return;
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    for (const sg of segs) {
      g.moveTo(sg[0], sg[1]);
      g.lineTo(sg[2], sg[3]);
    }
    g.stroke();
  };
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const [col, segs] of ownedInner) strokeSegs(segs, rgba(col, 0.18), 0.65); // inner hairlines
  strokeSegs(neutralEdge, 'rgba(67,98,110,0.34)', 1); // neutral divisions
  for (const [col, segs] of ownedFront) strokeSegs(segs, rgba(col, 0.14), 5.5); // frontier glow
  for (const [col, segs] of ownedFront) strokeSegs(segs, rgba(col, 0.9), 1.6); // frontier crisp
  g.restore();

  // PATH NETWORK — thin roads between adjacent provinces (the visible "пути").
  // Movement runs along these; an army marches province-to-adjacent-province and
  // its route (drawAimPreview / drawFleetRoutes) traces them.
  g.strokeStyle = 'rgba(150,185,195,0.34)';
  g.lineWidth = 1.1;
  for (const n of MAP) {
    if (!s.planets[n.id]) continue;
    const a = world(n);
    for (const l of n.links) {
      if (n.id >= l) continue; // each undirected road once
      const B = s.planets[l];
      if (!B) continue;
      const b = world(B.position);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }

  // map boundary — a faint frame so the edge of the sector reads as intentional
  g.strokeStyle = 'rgba(90,130,140,0.35)';
  g.lineWidth = 1.5;
  g.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

/** Blit the cached static layer (device-pixel 1:1) beneath the live dynamic art. */
function blitStaticLayer(): void {
  buildStaticLayer(); // re-bakes at the live camera whenever it moved (else returns the cache)
  cx.save();
  cx.setTransform(1, 0, 0, 1, 0, 0); // backing pixels — the bake is always at the live camera, 1:1
  cx.drawImage(bg, 0, 0);
  cx.restore();
}

/** Draw the radar ranges of the selected sector: the OUTER signature radius (full
 *  reach, animated dashed) and the INNER full-reveal radius (half the reach, solid)
 *  — the two concentric ranges from shared-core visibility. The reach is a physical
 *  distance in map units; the projection is uniform so they read as true circles.
 *  Nothing is drawn for a sector with no radar. (Complements `drawRadarCoverage` —
 *  that shows ALL my sources persistently; this labels the selected one on tap.) */
function drawRadarRange(now: number): void {
  if (!selPlanet) return;
  const p = s.planets[selPlanet];
  if (!p) return;
  const reach = planetRadar(p);
  if (reach <= 0) return;
  const c = world(p.position);
  const pulse = 0.5 + 0.5 * Math.sin(now / 600);
  const radiusPx = (rr: number): { rx: number; ry: number } => ({
    rx: Math.abs(world({ x: p.position.x + rr, y: p.position.y }).x - c.x),
    ry: Math.abs(world({ x: p.position.x, y: p.position.y + rr }).y - c.y),
  });
  cx.save();
  cx.shadowColor = '#5ff0c0';
  cx.textAlign = 'left';
  cx.font = '700 10px ui-monospace,Menlo,monospace';

  // outer — signature reach (coarse blips in fog)
  const o = radiusPx(reach);
  cx.fillStyle = rgba('#5ff0c0', 0.04);
  cx.beginPath();
  cx.ellipse(c.x, c.y, o.rx, o.ry, 0, 0, TAU);
  cx.fill();
  cx.setLineDash([6, 7]);
  cx.lineDashOffset = -now / 60;
  cx.strokeStyle = rgba('#5ff0c0', 0.34 + 0.18 * pulse);
  cx.lineWidth = 1.3;
  cx.shadowBlur = 6;
  cx.stroke();
  cx.fillStyle = rgba('#aef6e6', 0.85);
  cx.fillText(`◌ SIGNATURE ${reach}`, c.x + o.rx + 7, c.y + 3);

  // inner — full-reveal reach (contacts fully identified)
  const inner = reach * IDENTIFY_REACH_FRACTION;
  const i = radiusPx(inner);
  cx.fillStyle = rgba('#5ff0c0', 0.06);
  cx.beginPath();
  cx.ellipse(c.x, c.y, i.rx, i.ry, 0, 0, TAU);
  cx.fill();
  cx.setLineDash([]);
  cx.strokeStyle = rgba('#7df0d0', 0.6 + 0.2 * pulse);
  cx.lineWidth = 1.4;
  cx.shadowBlur = 7;
  cx.stroke();
  cx.fillStyle = rgba('#aef6e6', 0.9);
  cx.fillText(`● REVEAL ${Math.round(inner)}`, c.x + i.rx + 7, c.y - 7);
  cx.restore();
}

function render(now: number) {
  cx.setTransform(DPR, 0, 0, DPR, 0, 0); // draw in CSS pixels, crisp on hi-DPI
  blitStaticLayer(); // backdrop + province political map (re-baked on camera move, else cached)
  drawScanSweep(now); // slow radar sweep — pure console chrome
  updateRadarContacts(now); // the arm paints enemy signatures as it crosses them
  drawRadarCoverage(); // my sensor reach (radar arrays + ships)

  drawFleetRoutes();

  // battles — pulsing red contact ring at the actual clash point (an engaged
  // fleet's position, so a mid-lane intercept shows where it really happens) with a
  // live countdown to the next hourly damage round (the battle timer).
  const wave = (now / 900) % 1;
  for (const b of Object.values(s.battles)) {
    if (!known(b.location)) continue;
    const anchor = battleAnchor(b);
    if (!anchor) continue;
    const c = world(anchor);
    if (!visible(c, 120)) continue;
    drawBattlePulse(c.x, c.y, wave);
    if (typeof b.nextRoundAt === 'number') {
      cx.save();
      cx.font = '700 10px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.fillStyle = '#ff8a7d';
      cx.fillText(`⚔ ${timeLeft(b.nextRoundAt)}`, c.x, c.y - 28);
      cx.restore();
    }
  }

  // selected sector: its radar detection radius (a physical circle in map space →
  // an axis-aligned ellipse on screen because the fit projection is non-uniform).
  drawRadarRange(now);

  // radar ping afterglow: as the sweep arm crosses a contact it flares, then the
  // imprint lingers (fading) until the arm comes back round — drawn behind the
  // blips so it reads as the contact glowing, not an overlay. Skips void nodes and
  // anything still fully unexplored.
  if (sweepOn) {
    cx.save();
    cx.globalCompositeOperation = 'lighter';
    for (const n of MAP) {
      if (n.sector === 'empty') continue;
      const p = s.planets[n.id];
      if (!p) continue;
      const c = world(n);
      if (!visible(c, 60)) continue;
      const seen = known(n.id) || memory.has(n.id);
      if (!seen) continue;
      const g = sweepGlow(c);
      if (g <= 0.03) continue;
      const col = known(n.id) ? ownerColor(p.owner) : '#6f8a93';
      blitGlow(col, c.x, c.y, 24, 0.42 * g); // cached glow disc (no per-node gradient)
    }
    cx.restore();
  }

  // planets — wireframe blips with sensor rings + monospace callouts
  cx.textAlign = 'left';
  const R = 13;
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p) continue;
    const c = world(n);
    if (!visible(c, 110)) continue;
    const kn = known(n.id);
    // Variant B: fog hides capturable systems (void cells stay as pure geometry).
    // Unknown → a remembered last-known blip, or an "unexplored" marker.
    if (n.sector !== 'empty' && !kn) {
      drawFogMarker(c, n.id, memory.get(n.id));
      continue;
    }
    const showOwner = p.owner;
    const col = ownerColor(p.owner);
    const ownerPulse = 0.64 + 0.36 * Math.sin(now / 620 + n.x * 0.011 + n.y * 0.017);

    // empty-space sector: just a faint survey marker at its centre (no city, no
    // capture) — it is only a node you travel through.
    if (n.sector === 'empty') {
      cx.save();
      cx.strokeStyle = rgba(VOID_COLOR, 0.5);
      cx.lineWidth = 1;
      cx.beginPath();
      for (const [dx, dy] of CARDINAL) {
        cx.moveTo(c.x + dx * 1.5, c.y + dy * 1.5);
        cx.lineTo(c.x + dx * 3.5, c.y + dy * 3.5);
      }
      cx.stroke();
      cx.fillStyle = rgba(VOID_COLOR, 0.6);
      cx.beginPath();
      cx.arc(c.x, c.y, 1, 0, TAU);
      cx.fill();
      cx.restore();
      continue;
    }

    // province-type badge: a small kind glyph above the node so the type reads at a
    // glance, regardless of the bespoke art below it (planet / asteroid / nebula / …).
    if (KIND_ICON[n.sector]) {
      cx.save();
      cx.font = '13px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      cx.shadowColor = 'rgba(0,0,0,0.85)';
      cx.shadowBlur = 3;
      cx.fillStyle = rgba(SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? '#9fb6bd', 1);
      cx.fillText(KIND_ICON[n.sector]!, c.x, c.y - 18);
      cx.restore();
    }

    // asteroid-field sector: a lane junction, not a city — scattered rocks + a
    // fat hub where the lanes meet, no orbits. Captured by simply arriving — unless
    // a space fortress is raised here, which fortifies it (orbit + AA, must storm).
    if (n.sector === 'asteroid') {
      const fort = p.buildings.find((b) => b.type === 'starfort');
      blitGlow(col, c.x, c.y, 30, p.owner ? 0.16 : 0.06); // cached glow disc
      cx.save();
      cx.strokeStyle = 'rgba(186,170,140,0.7)';
      cx.fillStyle = 'rgba(42,40,33,0.72)';
      cx.lineWidth = 1;
      for (const rk of asteroidsFor(n.id, n.x, n.y)) {
        cx.save();
        cx.translate(c.x + rk.dx, c.y + rk.dy);
        cx.rotate(rk.rot + now / 9000);
        cx.beginPath();
        for (let k = 0; k < rk.sides; k++) {
          const a = (k / rk.sides) * TAU;
          const rr = rk.r * (0.72 + 0.28 * Math.sin(a * 2 + rk.rot));
          const px = Math.cos(a) * rr;
          const py = Math.sin(a) * rr;
          if (k) cx.lineTo(px, py);
          else cx.moveTo(px, py);
        }
        cx.closePath();
        cx.fill();
        cx.stroke();
        cx.restore();
      }
      cx.restore();
      // fat junction hub (the lanes converge here), owner-coloured
      blitGlow(col, c.x, c.y, 13, p.owner ? 0.5 : 0.3); // cached bloom, not shadowBlur
      cx.fillStyle = rgba(col, 0.92);
      cx.beginPath();
      cx.arc(c.x, c.y, 4.2, 0, TAU);
      cx.fill();
      cx.strokeStyle = rgba(col, 0.75);
      cx.lineWidth = 1.3;
      cx.beginPath();
      cx.arc(c.x, c.y, 7.5 + 0.6 * ownerPulse, 0, TAU);
      cx.stroke();
      // space fortress: a hexagonal bastion ring around the hub (with HP bar)
      if (fort) {
        cx.save();
        cx.strokeStyle = col;
        cx.lineWidth = 1.6;
        cx.shadowColor = col;
        cx.shadowBlur = 8;
        poly(c.x, c.y, 12, 6, Math.PI / 6);
        cx.stroke();
        poly(c.x, c.y, 7, 6, Math.PI / 6);
        cx.stroke();
        cx.restore();
        const frac = Math.max(0, Math.min(1, fort.hp / hpOfLevel('starfort', fort.level)));
        cx.fillStyle = 'rgba(2,9,13,.7)';
        cx.fillRect(c.x - 12, c.y - 22, 24, 3);
        cx.fillStyle = rgba(frac > 0.35 ? col : '#ff5a4d', 0.9);
        cx.fillRect(c.x - 12, c.y - 22, 24 * frac, 3);
      }
      if (selPlanet === n.id) targetBrackets(c.x, c.y, fort ? 18 : 15, now);
      cx.save();
      cx.shadowColor = 'rgba(0,0,0,0.85)';
      cx.shadowBlur = 3;
      cx.fillStyle = p.owner ? col : '#9fc9c4';
      cx.font = '700 11px ui-monospace,Menlo,monospace';
      cx.fillText(n.id, c.x + 16, c.y - 1);
      cx.fillStyle = 'rgba(150,210,205,0.55)';
      cx.font = '9px ui-monospace,Menlo,monospace';
      cx.fillText(fort ? 'void fortress ✦' : 'asteroid field', c.x + 16, c.y + 11);
      cx.restore();
      continue;
    }

    // territory aura — cached glow disc (no per-node gradient)
    blitGlow(col, c.x, c.y, R + 34, showOwner ? 0.3 : 0.1);

    // sensor-range ring (dashed, faint)
    cx.save();
    cx.setLineDash([3, 5]);
    cx.lineDashOffset = -now / 180;
    cx.strokeStyle = rgba(col, 0.18 + 0.13 * ownerPulse);
    cx.lineWidth = 1;
    cx.beginPath();
    cx.arc(c.x, c.y, R + 14 + 2 * ownerPulse, 0, TAU);
    cx.stroke();
    cx.restore();

    // fort = hex containment ring
    if (kn && p.buildings.some((b) => b.type === 'fort')) {
      cx.strokeStyle = rgba(col, 0.5);
      cx.lineWidth = 1;
      poly(c.x, c.y, R + 6, 6, Math.PI / 6);
      cx.stroke();
    }

    if (kn && p.buildings.length) {
      cx.save();
      cx.font = '11px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      const start = c.x - ((p.buildings.length - 1) * 13) / 2;
      for (let i = 0; i < p.buildings.length; i++) {
        const b = p.buildings[i];
        if (!b) continue;
        const bx = start + i * 13;
        const by = c.y + R + 19;
        cx.fillStyle = 'rgba(2,9,13,.78)';
        cx.strokeStyle = rgba(col, 0.55);
        cx.lineWidth = 1;
        cx.beginPath();
        cx.rect(bx - 5, by - 5, 10, 10);
        cx.fill();
        cx.stroke();
        cx.fillStyle = rgba(col, 0.9);
        cx.fillText(BUILD_ICON[b.type] ?? '▪', bx, by + 0.5);
      }
      cx.restore();
    }

    // holographic volume: a lit sphere inside the ring — subtle at the far view (nodes
    // pack together there), blooming to full once you zoom into a region
    blitSphere(col, c.x, c.y, R, clamp(0.3 + (cam.scale - 1) * 0.7, 0.3, 1));

    // wireframe body + bright core (glow comes from the cached aura/bloom discs,
    // not shadowBlur — shadowBlur per node per frame is a major CPU cost)
    blitGlow(col, c.x, c.y, R + 7, showOwner ? 0.22 : 0.12); // tight bloom at the ring
    cx.strokeStyle = col;
    cx.lineWidth = 2;
    cx.beginPath();
    cx.arc(c.x, c.y, R, 0, TAU);
    cx.stroke();
    cx.fillStyle = rgba(col, 0.72 + 0.28 * ownerPulse);
    cx.beginPath();
    cx.arc(c.x, c.y, 2.6 + 1.2 * ownerPulse, 0, TAU);
    cx.fill();

    // N/E/S/W crosshair ticks
    cx.strokeStyle = rgba(col, 0.7);
    cx.lineWidth = 1.2;
    cx.beginPath();
    for (const [dx, dy] of CARDINAL) {
      cx.moveTo(c.x + dx * (R - 3), c.y + dy * (R - 3));
      cx.lineTo(c.x + dx * (R + 5), c.y + dy * (R + 5));
    }
    cx.stroke();

    if (selPlanet === n.id) targetBrackets(c.x, c.y, R + 10, now);

    // callout: id + garrison/buildings, monospace (fogged → no telemetry)
    cx.save();
    cx.shadowColor = 'rgba(0,0,0,0.85)';
    cx.shadowBlur = 3;
    cx.fillStyle = kn ? (p.owner ? col : '#9fc9c4') : 'rgba(120,140,150,0.55)';
    cx.font = '700 12px ui-monospace,Menlo,monospace';
    cx.fillText(n.id, c.x + R + 12, c.y - 1);
    cx.font = '10px ui-monospace,Menlo,monospace';
    if (kn) {
      const g = p.garrison.reduce((a, st) => a + st.count, 0);
      cx.fillStyle = 'rgba(150,210,205,0.6)';
      const icons = p.buildings.map((b) => BUILD_ICON[b.type] ?? '▪').join('');
      cx.fillText(`G:${g}  B:${icons || '—'}`, c.x + R + 12, c.y + 12);
    } else {
      cx.fillStyle = 'rgba(110,130,140,0.5)';
      cx.fillText('· no telemetry', c.x + R + 12, c.y + 12);
    }
    cx.restore();
  }

  // the orbit ring around any CITY that holds a stationed fleet (a single orbit).
  // Asteroid-field junctions have no orbits, so they are skipped.
  const stationed: Record<string, Fleet[]> = {};
  for (const f of Object.values(s.fleets))
    if (f.location && !f.movement) {
      if (f.owner !== ME && !known(f.location)) continue; // hidden enemy orbit
      (stationed[f.location] ??= []).push(f);
    }
  for (const pid of Object.keys(stationed)) {
    const pl = s.planets[pid];
    if (!pl) continue;
    // orbit only on types that have one (cities); a fortress gives a junction one too
    const fortified =
      pl.buildings.some((b) => b.type === 'starfort') || (pl.garrison ?? []).some((u) => u.count > 0);
    if (!SECTOR_TYPES[SECTOR_OF[pid]]?.orbit && !fortified) continue;
    const pc = world(pl.position);
    if (!visible(pc, 80)) continue;
    // A single orbit ring (GDD §7.4) — one orbit, so no N/F labels cluttering the map.
    const rr = orbitRingRadius(pl);
    cx.save();
    cx.setLineDash([2, 5]);
    cx.lineDashOffset = now / 200;
    cx.strokeStyle = rgba(ORBIT_COLOR, 0.4);
    cx.lineWidth = 1.3;
    cx.beginPath();
    cx.arc(pc.x, pc.y, rr, 0, TAU);
    cx.stroke();
    cx.restore();
  }

  // fleets — glowing chevrons on their orbit ring (stationed) or along the lane
  cx.textAlign = 'center';
  // carried divisions per fleet (rendered as cargo diamonds) — counted once.
  const carriedDivCount: Record<string, number> = {};
  for (const d of Object.values(divisionsOf(s)))
    if (d.carriedBy) carriedDivCount[d.carriedBy] = (carriedDivCount[d.carriedBy] ?? 0) + 1;
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME) {
      const fn = fleetNode(f);
      if (!known(fn)) {
        // not identified: a radar contact is shown only as a swept signature
        // (drawRadarContacts), painted by the arm and remembered — never live here.
        continue;
      }
    }
    const A = fleetAnchor(f);
    if (!A || !visible(A, 120)) continue;
    const col = ownerColor(f.owner);
    const ships = sumUnits(f.units);
    const troops = sumUnits(f.landing ?? []);
    const engine = 0.55 + 0.45 * Math.sin(now / 120 + f.id.length);

    // bombardment beam down to the planet
    if (f.bombarding && f.location) {
      const target = s.planets[f.location];
      if (target) {
        const pc = world(target.position);
        const spark = 0.45 + 0.55 * Math.sin(now / 90);
        cx.save();
        cx.strokeStyle = rgba('#ffb15f', 0.3 + 0.3 * spark);
        cx.lineWidth = 1.2 + spark;
        cx.shadowColor = '#ffb15f';
        cx.shadowBlur = 12;
        cx.beginPath();
        cx.moveTo(A.x, A.y);
        cx.lineTo(pc.x, pc.y);
        cx.stroke();
        cx.restore();
      }
    }

    // contact trail while moving
    if (f.movement) {
      for (let i = 1; i <= 4; i++) {
        cx.fillStyle = rgba(col, 0.33 - 0.055 * i);
        cx.beginPath();
        cx.arc(
          A.x - Math.cos(A.ang) * i * (8 + engine * 2),
          A.y - Math.sin(A.ang) * i * (8 + engine * 2),
          2.8 - 0.35 * i,
          0,
          TAU,
        );
        cx.fill();
      }
    }

    // Squadron emblem (upright): ships are up-triangles, ONE per three ships, packed
    // into a pyramid — "каждые 3 корабля = один треугольник". Cargo glues under the
    // base: carried divisions as diamonds first ("эскадрильи ромбиком"), then ground
    // troops as squares (loaded = filled, loading ~1h = an empty square filling up).
    const BW = 6,
      TH = 5; // triangle base width / height; rows stack TH apart
    const nTri = Math.max(1, Math.ceil(ships / 3));
    // pack the triangles into a bottom-heavy pyramid: full rows 1..R, then shave the
    // apex rows of any empty slots so the BASE is always widest (1→[1], 2→[2],
    // 4→[1,3], 6→[1,2,3], 10→[1,2,3,4]).
    let R = 1;
    while ((R * (R + 1)) / 2 < nTri) R++;
    const tri: number[] = [];
    for (let r = 1; r <= R; r++) tri.push(r);
    for (let r = 0, trim = (R * (R + 1)) / 2 - nTri; trim > 0 && r < tri.length; r++) {
      const cut = Math.min(tri[r]!, trim);
      tri[r]! -= cut;
      trim -= cut;
    }
    const rows = tri.filter((x) => x > 0);
    const yBase = A.y; // baseline of the bottom (widest) row
    const apexTop = yBase - rows.length * TH;
    cx.save();
    // While in transit, point the ship pyramid along its heading ("нос по курсу"): the
    // apex (drawn toward -y / up) rotates onto A.ang. Only the triangles turn — the cargo
    // pips and the ship-count text below stay upright and readable.
    if (f.movement) {
      cx.translate(A.x, A.y);
      cx.rotate(A.ang + Math.PI / 2);
      cx.translate(-A.x, -A.y);
    }
    cx.shadowColor = col;
    cx.shadowBlur = 6 + 6 * engine;
    cx.fillStyle = rgba(col, 0.16 + 0.12 * engine);
    cx.strokeStyle = col;
    cx.lineWidth = 1.3;
    for (let r = 0; r < rows.length; r++) {
      const base = apexTop + (r + 1) * TH; // this row's baseline
      const rw = rows[r]! * BW;
      for (let i = 0; i < rows[r]!; i++) {
        const x0 = A.x - rw / 2 + i * BW;
        cx.beginPath();
        cx.moveTo(x0 + BW / 2, base - TH); // apex up
        cx.lineTo(x0 + BW, base); // flat base, right corner
        cx.lineTo(x0, base); // flat base, left corner
        cx.closePath();
        cx.fill();
        cx.stroke();
      }
    }
    cx.restore();

    // cargo glued under the base: diamonds (carried divisions) first, then squares
    // (ground troops). A loading troop (~1h) is an empty square that fills bottom-up.
    const loads = pendingLoads.filter((p) => p.fleetId === f.id); // empty for enemy/idle fleets
    const cargo: { kind: 'div' | 'troop' | 'load'; load?: PendingLoad }[] = [];
    for (let i = 0; i < (carriedDivCount[f.id] ?? 0); i++) cargo.push({ kind: 'div' });
    for (let i = 0; i < troops; i++) cargo.push({ kind: 'troop' });
    for (const p of loads) cargo.push({ kind: 'load', load: p });
    if (cargo.length > 0) {
      const CELL = 6.5,
        SQ = 4,
        DR = 3,
        MAX = 8; // cap; rare overflow gets a "+N" tail
      const n = Math.min(cargo.length, MAX);
      const over = cargo.length - n;
      const rowW = n * CELL + (over > 0 ? 12 : 0);
      let px = A.x - rowW / 2 + CELL / 2; // centre of the first cell
      const cyc = yBase + 4; // a touch below the flat base
      cx.save();
      cx.shadowColor = col;
      cx.shadowBlur = 3;
      cx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const pip = cargo[i]!;
        if (pip.kind === 'div') {
          // carried division → a solid diamond ("ромбик")
          cx.beginPath();
          cx.moveTo(px, cyc - DR);
          cx.lineTo(px + DR, cyc);
          cx.lineTo(px, cyc + DR);
          cx.lineTo(px - DR, cyc);
          cx.closePath();
          cx.fillStyle = rgba(col, 0.85);
          cx.strokeStyle = rgba(col, 0.95);
          cx.fill();
          cx.stroke();
        } else {
          const x = px - SQ / 2,
            y = cyc - SQ / 2;
          if (pip.kind === 'troop') {
            // loaded troop → solid square
            cx.fillStyle = rgba(col, 0.85);
            cx.fillRect(x, y, SQ, SQ);
            cx.strokeStyle = rgba(col, 0.95);
            cx.strokeRect(x + 0.5, y + 0.5, SQ - 1, SQ - 1);
          } else {
            // loading troop → empty square filling from the bottom (0→1 over ~1h)
            const p = pip.load!;
            const prog = clamp((s.time - p.startAt) / (p.doneAt - p.startAt), 0, 1);
            cx.strokeStyle = rgba(col, 0.85);
            cx.strokeRect(x + 0.5, y + 0.5, SQ - 1, SQ - 1);
            if (prog > 0) {
              const fh = (SQ - 1) * prog;
              cx.fillStyle = rgba(col, 0.8);
              cx.fillRect(x + 0.5, y + 0.5 + (SQ - 1 - fh), SQ - 1, fh);
            }
          }
        }
        px += CELL;
      }
      cx.restore();
      if (over > 0) {
        cx.fillStyle = rgba(col, 0.92);
        cx.font = '700 8px ui-monospace,Menlo,monospace';
        cx.textAlign = 'left';
        cx.fillText(`+${over}`, px - CELL / 2 + 1, cyc + SQ / 2);
        cx.textAlign = 'center';
      }
    }

    if (selFleet === f.id || selFleets.has(f.id)) {
      targetBrackets(A.x, A.y, 12, now);
      // Artillery: show the standoff firing radius (and a focus line to a chosen
      // target) so the player can read the reach — "радиус не очень большой".
      const aRange = artilleryRangeOf(f);
      if (aRange > 0) {
        cx.save();
        cx.strokeStyle = rgba('#ff7a3a', barrageAim ? 0.7 : 0.42);
        cx.lineWidth = 1;
        cx.setLineDash([5, 5]);
        cx.beginPath();
        cx.arc(A.x, A.y, aRange * cam.scale, 0, TAU);
        cx.stroke();
        cx.setLineDash([]);
        const tf = f.barrageTarget ? s.fleets[f.barrageTarget] : undefined;
        const ta = tf ? fleetAnchor(tf) : null;
        if (ta) {
          cx.strokeStyle = rgba('#ff7a3a', 0.8);
          cx.beginPath();
          cx.moveTo(A.x, A.y);
          cx.lineTo(ta.x, ta.y);
          cx.stroke();
        }
        cx.restore();
      }
    }

    // ship count, small, under the whole emblem (exact size for fleets past 5 ships).
    cx.fillStyle = rgba(col, 0.95);
    cx.font = '700 9px ui-monospace,Menlo,monospace';
    cx.fillText(String(ships), A.x, A.y + 18);
  }

  drawRadarContacts(now); // swept enemy signatures — last-known ghosts until repainted

  if (selectionBox) {
    const x = Math.min(selectionBox.x1, selectionBox.x2);
    const y = Math.min(selectionBox.y1, selectionBox.y2);
    const w = Math.abs(selectionBox.x2 - selectionBox.x1);
    const h = Math.abs(selectionBox.y2 - selectionBox.y1);
    cx.save();
    cx.fillStyle = 'rgba(53,214,230,.08)';
    cx.strokeStyle = LOCK;
    cx.setLineDash([5, 4]);
    cx.lineWidth = 1.2;
    cx.fillRect(x, y, w, h);
    cx.strokeRect(x, y, w, h);
    cx.restore();
  }
  drawPings(now); // ally ping markers (coalition), with screen hit-boxes for taps
  drawAimPreview();
}

// --- side panel --------------------------------------------------------------

function btn(act: string, arg: string, label: string, ok: boolean, desc?: string): string {
  const d = desc ? ` data-desc="${esc(desc)}"` : '';
  return `<button class="b" data-act="${esc(act)}" data-arg="${esc(arg)}"${d} ${ok ? '' : 'disabled'}>${esc(label)}</button>`;
}
/** Wrap a panel section so the desktop multi-column layout never splits it across
 *  columns. Sections are laid out side-by-side on wide screens, stacked on phones. */
function block(inner: string): string {
  return `<div class="block">${inner}</div>`;
}
/** Lay a set of sections into the responsive multi-column body (see `.pcols` CSS). */
function pcols(blocks: string[]): string {
  return `<div class="pcols">${blocks.map(block).join('')}</div>`;
}
function cardHeader(color: string, title: string, sub: string): string {
  return `<div class="phead">
    <span class="pflag" style="background:${color}"></span>
    <div class="ptitle"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
    <button class="pclose" data-act="close" data-arg="">✕</button>
  </div>`;
}
function tabButton(tab: PlanetTab, label: string, count: number): string {
  const on = planetTab === tab ? ' on' : '';
  return `<button class="ptab${on}" data-act="tab" data-arg="${tab}">${label}<b>${count}</b></button>`;
}
function unitRows(stacks: Array<{ unit: string; count: number }>): string {
  if (!stacks.length) {
    return `<div class="row dim">none</div>`;
  }
  return stacks
    .map(
      (st) =>
        `<div class="asset-row" data-desc="u:${esc(st.unit)}"><span class="bicon">${unitIcon(st.unit)}</span><b>${st.count}× ${displayUnit(st.unit)}</b><span class="dim">${isGround(st.unit) ? 'ground' : 'space'}</span></div>`,
    )
    .join('');
}
function conveyorHtml(planetId: string, lane: BuildLane): string {
  const active = activeConstruction(planetId, lane);
  const queued = queueOf(planetId)[lane];
  let html = `<div class="conveyor">`;
  if (active) {
    // The live % / remaining-time are patched in each frame by updatePanelLive() and
    // deliberately kept OUT of the panel's HTML signature — otherwise the panel (and its
    // build buttons) would be rebuilt 60×/s, and a click whose down/up straddle a rebuild
    // is dropped (the bug where rapid build orders only queued one ship in real time).
    const dur = buildDurationHours(active.payload) * HOUR;
    html += `<div class="current"><span>NOW</span><b>${constructionLabel(active.payload)}</b><em class="conv-time" data-at="${active.at}">—</em></div>`;
    html += `<div class="bar"><i class="conv-fill" data-at="${active.at}" data-dur="${dur}" style="width:0%"></i></div>`;
  } else {
    html += `<div class="current idle"><span>IDLE</span><b>ready for next order</b><em>—</em></div>`;
    html += `<div class="bar"><i style="width:0%"></i></div>`;
  }
  if (queued.length) {
    html += `<div class="queue">${queued
      .map((q, i) => `<span><em>${i + 1}</em>${queuedLabel(q)}</span>`)
      .join('')}</div>`;
  } else {
    html += `<div class="queue empty">queue empty</div>`;
  }
  return html + `</div>`;
}
// Buildable options as codex tiles (icon + cost). Tapping a tile opens the full-info
// panel, which carries a "Build here" button for the selected province — so browsing
// specs and committing the build share one control (no separate text button row).
function buildButtons(_planetId: string, ids: string[], kind: 'building' | 'unit'): string {
  const k = kind === 'unit' ? 'u' : 'b';
  const tiles = ids
    .map((id) => codexTile(k, id, cost(kind === 'unit' ? data.units[id]?.cost : data.buildings[id]?.cost)))
    .join('');
  return tiles ? `<div class="ptiles">${tiles}</div>` : '';
}

function panelHtml(): string {
  const group = [...selFleets].map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  if (group.length > 1) {
    const ships = group.reduce((a, f) => a + sumUnits(f.units), 0);
    const troops = group.reduce((a, f) => a + sumUnits(f.landing ?? []), 0);
    let h = cardHeader(
      ownerColor(ME),
      'TASK GROUP',
      `${group.length} fleets · ${ships} ships · ${troops} troops`,
    );
    h += `<div class="hint">Press <b>Move</b>, then tap a destination to send all selected fleets (they route and stop). Press <b>Merge</b> to fuse the group into one (distant fleets fly in first). Shift-drag selects a group; Ctrl/⌘-click adds a fleet.</div>`;
    for (const f of group) {
      const loc =
        f.location ??
        (f.movement
          ? `${f.movement.from}→${f.movement.to}`
          : f.edge
            ? `⟜ ${f.edge.from}–${f.edge.to}`
            : '—');
      const nShips = sumUnits(f.units);
      const nTr = sumUnits(f.landing ?? []);
      h += `<div class="row" style="color:${ownerColor(f.owner)}">▲ ${f.id} <span class="dim">${loc}</span> · ${nShips}${nTr ? '+' + nTr : ''}</div>`;
    }
    h += btn('cancel', '', 'Deselect group', true);
    return h;
  }
  if (selFleet) {
    const f = s.fleets[selFleet];
    if (f) {
      const nShips = sumUnits(f.units);
      const nTr = sumUnits(f.landing ?? []);
      const inOrbit = f.orbit === 'near';
      // Hull integrity across the squadron (persistent between fights now): a stack's
      // current hp ?? full. Below 30% the fleet limps (route.ts) until it repairs.
      let curHull = 0,
        maxHull = 0;
      for (const st of f.units) {
        const u = data.units[st.unit];
        if (!u) continue;
        const m = st.count * u.stats.hp;
        maxHull += m;
        curHull += st.hp ?? m;
      }
      const hullPct = maxHull > 0 ? Math.round((curHull / maxHull) * 100) : 100;
      const hullTag = hullPct < 100 ? ` · ${hullPct < 30 ? '⚠ ' : ''}корпус ${hullPct}%` : '';
      let h = cardHeader(
        ownerColor(f.owner),
        'FLEET',
        `${nShips} ships · ${nTr} troops${hullTag}${inOrbit ? ' · in orbit' : ''}${f.bombarding ? ' · ⊗ bombarding' : ''}`,
      );
      // Aggregate combat weight, summed across the squadron's ships (it moves at its
      // slowest hull). The hero aura (+5%, noted below) is not folded into these totals.
      let atk = 0,
        def = 0,
        hpTot = 0,
        spd = Infinity;
      for (const u of f.units) {
        const st = data.units[u.unit]?.stats;
        if (!st || u.count <= 0) continue;
        atk += (st.attack ?? 0) * u.count;
        def += (st.defense ?? 0) * u.count;
        hpTot += (st.hp ?? 0) * u.count;
        if ((st.speed ?? 0) > 0) spd = Math.min(spd, st.speed ?? Infinity);
      }
      const spdTxt = spd === Infinity ? '—' : String(spd);
      const flavor: string[] = [];
      if (f.units.some((u) => u.count > 0 && data.units[u.unit]?.traits.includes('hero'))) flavor.push('with a hero flagship');
      if (f.units.some((u) => u.count > 0 && data.units[u.unit]?.traits.includes('artillery'))) flavor.push('packing siege artillery');
      if (f.units.some((u) => u.count > 0 && (data.units[u.unit]?.radarRange ?? 0) > 0)) flavor.push('running its own radar picket');
      const blurb =
        nShips === 0
          ? 'An empty hull group — no ships aboard.'
          : `A squadron of ${nShips} ship${nShips > 1 ? 's' : ''}${flavor.length ? ' — ' + flavor.join(', ') : ''}. Its combined weight is below; it advances at its slowest hull.`;
      h += `<div class="row dim">${blurb}</div>`;
      h += `<div class="pstats"><span>⚔ ATK ${atk}</span><span>🛡 DEF ${def}</span><span>❤ HP ${hpTot}</span><span>⚡ SPD ${spdTxt}</span></div>`;
      h += nShips ? `<div class="sec">Ships — tap for specs</div>` + unitTilesHtml(f.units) : '';
      if (nTr > 0) h += `<div class="sec">Carrying troops</div>` + unitTilesHtml(f.landing ?? []);

      // Artillery rules of engagement — passive / return / standard / aggressive.
      if (f.owner === ME && fleetHasArtillery(f)) {
        const mode = f.barrageMode ?? 'standard';
        const mbtn = (m: string, lbl: string) =>
          btn('barragemode', m, (mode === m ? '● ' : '') + lbl, mode !== m);
        h += `<div class="sec">Артиллерия — режим огня</div><div class="row">`;
        h += mbtn('passive', 'Пассив') + mbtn('return', 'Ответ') + mbtn('standard', 'Станд') + mbtn('aggressive', 'Агрес');
        h += `</div>`;
        h += `<div class="hint">Пассив — не стреляет. Ответ — только после урона по флоту. Станд — по тем, с кем война. Агрес — по любому, кроме пакта/союза.</div>`;
      }

      // The player's projection hero rides here → name it and flag its fleet aura.
      if (f.units.some((u) => u.count > 0 && data.units[u.unit]?.traits.includes('hero'))) {
        const hero = Object.values(s.heroes ?? {}).find((x) => x.owner === f.owner);
        const heroName = hero?.name ?? s.players[f.owner]?.name ?? f.owner;
        h += `<div class="row"><b>♔ ${esc(heroName)}</b> <span class="dim">— projection · +5% attack/defense to this fleet</span></div>`;
      }

      if (f.movement) {
        // total travel-time estimate to the final destination (next-hop ETA from the
        // authoritative schedule + the remaining route at base speed). The ETA ticks
        // every frame, so it's a placeholder here (stable signature → no rebuild) and
        // patched in place by updatePanelLive() — keeps the panel's buttons put.
        const dest = f.movement.destination ?? f.movement.to;
        const restH = dest !== f.movement.to ? (estimateTravelHours(s, data, f.movement.to, dest, f) ?? 0) : 0;
        h += `<div class="row">↗ en route to <b>${esc(dest)}</b> · arrives in <b class="pn-eta" data-arrive="${f.movement.arrivesAt}" data-rest="${restH}">…</b></div>`;
      } else if (f.edge) {
        const pct = Math.round(f.edge.t * 100);
        h += `<div class="row">⟜ holding on the <b>${esc(f.edge.from)}–${esc(f.edge.to)}</b> lane · ${pct}% across</div>`;
      }

      const here = planet(f.location);
      const docked = !!here && !f.movement && !f.battleId;
      if (!docked) {
        const engaged = f.battleId ? s.battles[f.battleId] : undefined;
        h += `<div class="hint">${
          f.battleId
            ? engaged?.nextRoundAt !== undefined
              ? `Engaged — next damage round in <span class="pn-timer" data-at="${engaged.nextRoundAt}">…</span>.`
              : 'Engaged — orbital battle in progress.'
            : f.edge
              ? 'Parked on a lane — press Move to march on (it routes from here).'
              : 'In transit — routing along the lanes. Collisions trigger an orbital battle.'
        }</div>`;
      } else {
        // enemy/neutral world you can act on — empty space is pass-through only
        const hostile = here!.owner !== f.owner && (SECTOR_TYPES[SECTOR_OF[here!.id]]?.capturable ?? false);
        const cols: string[] = [];
        if (hostile) {
          let at = `<div class="sec">Strike</div><div class="row">`;
          at += btn(
            'bombard',
            f.bombarding ? 'off' : 'on',
            f.bombarding ? '⊗ Stop bombard' : '⊗ Bombard',
            inOrbit && nShips > 0,
          );
          at += btn('assault', '', '⚔ Assault', inOrbit);
          at += `</div>`;
          at += `<div class="hint">In orbit you can bombard (wears buildings &amp; freezes their output), but the garrison's AA reaches you. Assault lands your carried troops against the garrison.</div>`;
          cols.push(at);
        }
        // load / unload ground army at your own world
        if (here!.owner === ME) {
          let ga = `<div class="sec">Ground army ⇄ garrison</div>`;
          const groundHere = here!.garrison.filter((st) => isGround(st.unit));
          const carried = f.landing ?? [];
          const loadingN = pendingLoads.filter((p) => p.fleetId === f.id).length;
          const freeHold = fleetCargoFree(s, f) - pendingLoadCargo(f.id); // reserve in-progress loads
          if (groundHere.length) {
            ga += `<div class="row">`;
            for (const st of groundHere) {
              const sz = data.units[st.unit]?.stats.cargoSize ?? 1;
              ga += btn('load', st.unit, `▲ Load ${st.unit}`, sz <= freeHold);
            }
            ga += `</div>`;
          }
          if (carried.length) {
            ga += `<div class="row">`;
            for (const st of carried) ga += btn('unload', st.unit, `▼ Unload ${st.unit}`, true);
            ga += `</div>`;
          }
          if (loadingN) ga += `<div class="hint">⏳ погрузка: ${loadingN} (≈1ч на единицу)</div>`;
          if (!groundHere.length && !carried.length && !loadingN)
            ga += `<div class="row dim">no ground army here</div>`;
          cols.push(ga);
        }
        const dh = fleetDivisionsHtml(f, here!); // load/unload divisions (landing on a hostile world)
        if (dh) cols.push(dh);
        h += pcols(cols);
      }
      h += `<div class="hint">Press <b>Move</b> (command bar), then tap a destination — the fleet routes there and stops. <b>Merge…</b> tap another fleet to combine; <b>Split</b> peels ships into a new fleet.</div>`;
      h += btn('cancel', '', 'Deselect', true);
      return h;
    }
  }
  const p = planet(selPlanet);
  if (!p) return '<div class="hint">Tap a world.</div>';
  if (!known(p.id) && p.owner !== ME) {
    const mem = memory.get(p.id);
    if (mem) {
      const icons =
        mem.buildings
          .map((b) => `${BUILD_ICON[b.type] ?? '▪'} ${data.buildings[b.type]?.name ?? b.type} L${b.level}`)
          .join(', ') || 'none seen';
      return (
        cardHeader(ownerColor(mem.owner), p.id, 'LAST KNOWN ✦') +
        `<div class="row dim">Out of sensor range — last scan (may be stale).</div>` +
        `<div class="row">Owner: <b>${mem.owner ? NAME[mem.owner] : 'Neutral'}</b></div>` +
        `<div class="row">Garrison when seen: <b>${mem.garrison}</b></div>` +
        `<div class="row">Structures: ${icons}</div>` +
        `<div class="hint">Re-scan with a fleet or radar to refresh.</div>` +
        btn('cancel', '', 'Deselect', true)
      );
    }
    return (
      cardHeader('#5f8f8c', p.id, 'NO TELEMETRY') +
      `<div class="row dim">Unexplored — outside sensor and radar range. Contents unknown.</div>` +
      `<div class="hint">Send a fleet toward this system (or extend radar) to detect it.</div>` +
      btn('cancel', '', 'Deselect', true)
    );
  }
  const mine = p.owner === ME;
  const sec = data.sectors[p.terrain ?? '']?.name ?? p.terrain ?? '—';
  const pt = p.planetType ? data.planetTypes[p.planetType] : undefined;
  const ptName = pt?.name ?? p.planetType ?? '—';
  // Province type (the structural kind) — shown so the map's provinces read clearly.
  const kindName = SECTOR_TYPES[SECTOR_OF[p.id]]?.name ?? SECTOR_OF[p.id] ?? '—';
  const ground = p.garrison.filter((st) => isGround(st.unit));
  const ships = p.garrison.filter((st) => isShip(st.unit));
  const gcount = sumUnits(p.garrison);
  const here = Object.values(s.fleets).filter((f) => f.location === p.id);
  let h =
    cardHeader(ownerColor(p.owner), p.id, `${p.owner ? NAME[p.owner] : 'Neutral'} · ${kindName} · ${ptName} · ${sec}`) +
    `<div class="pstats"><span>⚔ ${gcount} garrison</span><span>${unitIcon('marine')} ${sumUnits(ground)} ground</span><span>${unitIcon('cruiser')} ${sumUnits(ships)} ships</span><span>▣ ${p.buildings.length} built</span></div>`;
  if (pt && (pt.productionBonus !== 0 || pt.defenseBonus !== 0)) {
    const pct = (n: number) => (n >= 0 ? '+' : '') + Math.round(n * 100) + '%';
    const parts: string[] = [];
    if (pt.productionBonus !== 0) parts.push(`prod ${pct(pt.productionBonus)}`);
    if (pt.defenseBonus !== 0) parts.push(`def ${pct(pt.defenseBonus)}`);
    h += `<div class="row dim">${esc(ptName)} world — ${parts.join(' · ')}</div>`;
  }

  // Capital marker / designate — heroes respawn here (and re-fit modules, Phase C).
  if (mine) {
    if (capitalOf(s, ME) === p.id) {
      h += `<div class="row"><b style="color:var(--grn)">★ Столица</b> <span class="dim">— здесь возродятся и сменят модули герои</span></div>`;
    } else if (isInhabited(p)) {
      h += `<div class="row">${btn('capital', '', '★ Сделать столицей', true)}</div>`;
    }
  }

  h += `<div class="ptabs">${tabButton('ground', 'Ground', ground.length)}${tabButton(
    'ships',
    'Ships',
    ships.length + here.length,
  )}${tabButton('buildings', 'Buildings', p.buildings.length)}</div>`;

  // Tab content is split into self-contained blocks; on desktop they flow into
  // side-by-side columns (filling the wide panel), on phones they stack vertically.
  const cols: string[] = [];
  if (planetTab === 'ground') {
    cols.push(`<div class="sec">Ground units</div>` + unitRows(ground));
    if (mine) {
      cols.push(divisionsHtml(p.id));
      const groundBuilds = BUILD_UNITS.filter((u) => isGround(u));
      cols.push(
        `<div class="sec">Ground conveyor</div>` +
          conveyorHtml(p.id, 'units') +
          buildButtons(p.id, groundBuilds, 'unit'),
      );
    }
    cols.push(
      `<div class="hint">Ground units defend planets and can be loaded onto fleets from the fleet panel.</div>`,
    );
  } else if (planetTab === 'ships') {
    // Built ships now auto-rally to orbit (see fleetLaunchModule), so the garrison
    // normally holds no spacecraft — only surface the section if some linger.
    if (ships.length) {
      cols.push(`<div class="sec">Spacecraft in garrison</div>` + unitRows(ships));
    }
    if (here.length) {
      let orbit = `<div class="sec">Fleets in orbit</div>`;
      for (const f of here) {
        const fShips = sumUnits(f.units);
        const tr = sumUnits(f.landing ?? []);
        const sel = f.owner === ME ? btn('selfleet', f.id, 'Select →', true) : '';
        orbit += `<div class="asset-row" data-desc="fleet" style="color:${ownerColor(f.owner)}"><span class="bicon">▲</span><b>${fShips} ships${tr ? ' +' + tr + ' troops' : ''}</b>${sel}</div>`;
      }
      cols.push(orbit);
    }
    if (mine) {
      const shipBuilds = BUILD_UNITS.filter((u) => isShip(u));
      cols.push(
        `<div class="sec">Shipyard conveyor</div>` +
          conveyorHtml(p.id, 'units') +
          buildButtons(p.id, shipBuilds, 'unit'),
      );
    }
    cols.push(
      `<div class="hint">Built spacecraft join the garrison first; launch creates a mobile fleet.</div>`,
    );
  } else {
    cols.push(
      `<div class="sec">Building conveyor</div>` +
        (mine
          ? conveyorHtml(p.id, 'buildings')
          : `<div class="row dim">enemy construction telemetry unavailable</div>`),
    );
    let blds = `<div class="sec">Buildings</div>`;
    if (p.buildings.length === 0) blds += `<div class="row dim">none</div>`;
    for (const b of p.buildings) {
      const def = data.buildings[b.type];
      const max = def ? buildingMaxLevel(def) : 1;
      blds += `<div class="asset-row" data-desc="b:${b.type}:${b.level}"><span class="bicon">${BUILD_ICON[b.type] ?? '▪'}</span><b>${def?.name ?? b.type}</b><span class="dim">L${b.level}/${max} · hp ${floor(b.hp)}/${hpOfLevel(b.type, b.level)}</span>`;
      if (mine && b.level < max) {
        const c = def?.upgrades[b.level - 1]?.cost;
        // hovering Upgrade previews the NEXT level's dossier (output it will unlock)
        blds += btn('upgrade', b.type, `▲ Upgrade ${cost(c)}`, afford(c), `b:${b.type}:${b.level + 1}`);
      }
      blds += `</div>`;
    }
    if (mine) {
      // Province-centric roster (data-driven): each province type lists what it can
      // raise (SECTOR_TYPES.allowedBuildings); absent = the default BUILDABLE set.
      const buildable = SECTOR_TYPES[SECTOR_OF[p.id]]?.allowedBuildings ?? BUILDABLE;
      const missing = buildable.filter((t) => !p.buildings.some((b) => b.type === t));
      if (missing.length) blds += buildButtons(p.id, missing, 'building');
    }
    cols.push(blds);
  }
  return h + pcols(cols);
}

// --- object dossiers (side-panel hover descriptions) -------------------------
// Loosely-coupled lore + live-stat blurbs for the things you can hover in the
// side panel. Keyed by a `data-desc` string ("b:<id>:<lvl>" buildings, "u:<id>"
// units, "fleet"); each returns a name + HTML body where live numbers are wrapped
// in <em class="hl"> (rendered yellow). When you add a new buildable or unit,
// add a case here too — the panel wires the hover up from the data-desc tag.
interface Dossier {
  name: string;
  body: string;
}
const hl = (v: string | number): string => `<em class="hl">${v}</em>`;

function buildingDossier(id: string, level: number): Dossier | null {
  const def = data.buildings[id];
  if (!def) return null;
  const lv = buildingLevel(def, Math.max(1, level));
  const pct = (n: number) => `+${Math.round(n * 100)}%`;
  const metal = lv.produces.metal ?? 0;
  const credits = lv.produces.credits ?? 0;
  switch (id) {
    case 'mine':
      return {
        name: def.name,
        body: `Буровая платформа, вгрызающаяся в рудное тело планеты. Добывает ${hl(metal)} металла в час. Каждый новый горизонт вскрывает более плотную жилу — выработка растёт в полтора раза, и из этого металла куётся весь флот.`,
      };
    case 'refinery':
      return {
        name: def.name,
        body: `Перерабатывающий комплекс, превращающий руду и логистику в ликвидные кредиты — ${hl(credits)} в час. Топливо для имперской бюрократии, верфей и наёмных эскадр.`,
      };
    case 'barracks':
      return {
        name: def.name,
        body: `Гарнизонный учебный лагерь. Куёт наземные подразделения и держит планетарную оборону в тонусе. Мир без казарм беззащитен перед первой же десантной волной.`,
      };
    case 'radar':
      return {
        name: def.name,
        body: `Сеть глубокого сканирования. Просвечивает пустоту в радиусе ${hl(lv.radarRange ?? 0)} и ловит чужие сигнатуры задолго до того, как они выйдут на дистанцию удара. Апгрейд раздвигает горизонт обнаружения.`,
      };
    case 'fort':
      return {
        name: def.name,
        body: `Эшелонированный планетарный бастион. Поднимает оборону гарнизона на ${hl(pct(lv.defenseBonus ?? 0))} и держит ${hl(lv.hp)} структурной прочности под орбитальным огнём. Последний рубеж осаждённого мира.`,
      };
    case 'starfort':
      return {
        name: def.name,
        body: `Автономная крепость, вмороженная в астероидное поле: ${hl(pct(lv.defenseBonus ?? 0))} к обороне и ${hl(lv.hp)} прочности. Превращает безликий перекрёсток в укреплённый узел с орбитой и ПКО — взять его можно только штурмом.`,
      };
    case 'metal_station':
      return {
        name: def.name,
        body: `Добывающая платформа, вгрызающаяся в спёкшуюся кору мёртвого мира. Там, где аннигиляция выжгла всё живое, обнажилась чистая металлическая руда — станция качает ${hl(metal)} металла в час, и каждый новый ярус наращивает поток. Единственная причина держать выжженное пепелище под флагом.`,
      };
    case 'tax_office':
      return {
        name: def.name,
        body: `Налоговая управа имперского образца: сама ничего не добывает, но ставит на учёт население мира и поднимает его кредитный сбор на ${hl(pct(TAX_OFFICE_BONUS))}. Возводится один раз — бюрократию не масштабируют, её терпят.`,
      };
    default:
      return { name: def.name, body: 'Планетарное сооружение.' };
  }
}

function unitDossier(id: string): Dossier | null {
  const def = data.units[id];
  if (!def) return null;
  const st = def.stats;
  switch (id) {
    case 'scout':
      return {
        name: 'Scout',
        body: `Лёгкий разведывательный корпус. Быстрый (ход ${hl(st.speed)}) и почти неслышный (сигнатура ${hl(def.signature ?? 1)}) — чертит карту пустоты там, куда боится соваться линейный флот.`,
      };
    case 'cruiser':
      return {
        name: 'Cruiser',
        body: `Рабочая лошадь линейного флота: ${hl(st.attack)} атаки, ${hl(st.hp)} корпуса и трюм на ${hl(st.cargoCapacity ?? 0)}. Универсальный боевой корабль, одинаково уверенный в обороне и в наступлении.`,
      };
    case 'siege':
      return {
        name: 'Siege Platform',
        body: `Тяжёлая осадная платформа: ${hl(st.attack)} урона с дистанции ${hl(st.range ?? 0)}, но тонкая броня (${hl(st.defense)} защиты). Её место за спинами крейсеров, откуда она крушит укрепления и верфи.`,
      };
    case 'marine':
      return {
        name: 'Marine',
        body: `Десантная пехота, ${hl(st.attack)}/${hl(st.defense)} в наземном бою. Грузится на флот и высаживается, чтобы захватывать миры, которые орбита лишь подавляет огнём.`,
      };
    case 'orbital_aa':
      return {
        name: 'Orbital AA',
        body: `Стационарная зенитная батарея — неподвижна, но выдаёт ${hl(st.aaDamage ?? 0)} урона по кораблям на низкой орбите. Кошмар для бомбардировщиков, повисших над планетой.`,
      };
    case 'hero':
      return {
        name: 'Flagship',
        body: `Боевая проекция самого командующего — флагман во главе родного флота: ${hl(st.attack)} атаки и ${hl(st.hp)} корпуса. Но решает не это: его присутствие держит эскадру в кулаке, давая ${hl('+5%')} к атаке и обороне всем кораблям рядом. Падёт — командующий лишается проекции, пока та не отстроится заново на родном мире.`,
      };
    default:
      return { name: displayUnit(id), body: 'Боевая единица.' };
  }
}

function objDossier(key: string): Dossier | null {
  if (key === 'fleet') {
    return {
      name: 'Fleet',
      body: 'Мобильное оперативное соединение кораблей. Выберите его, чтобы отдавать приказы на манёвр, орбиту и удар по врагу.',
    };
  }
  const [kind, id, lvl] = key.split(':');
  if (kind === 'b') return buildingDossier(id, Number(lvl) || 1);
  if (kind === 'u') return unitDossier(id);
  return null;
}

// --- build/unit codex (contextual tile → full-info popup + Build here) -------
/** One stat row for the codex popup. */
function cxRow(k: string, v: string): string {
  return `<div class="cx-row"><span class="cx-k">${k}</span><span class="cx-v">${v}</span></div>`;
}
/** Full info card — cost + every stat + the lore blurb — for a building ('b') or unit ('u'). */
function codexHtml(kind: string, id: string): string {
  if (kind === 'b') {
    const def = data.buildings[id];
    if (!def) return '';
    const lv = buildingLevel(def, 1);
    const maxLvl = 1 + (def.upgrades?.length ?? 0);
    const rows = [cxRow('Cost', cost(def.cost)), cxRow('Build time', `${def.buildTimeHours ?? 0} h`), cxRow('Structure HP', String(def.hp ?? 0))];
    const prod = Object.entries(lv.produces ?? {})
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([r, n]) => `${n} ${r}/h`)
      .join(', ');
    if (prod) rows.push(cxRow('Produces', prod));
    if ((lv.defenseBonus ?? 0) > 0.01) rows.push(cxRow('Garrison defense', `+${Math.round((lv.defenseBonus ?? 0) * 100)}%`));
    if ((lv.radarRange ?? 0) > 0) rows.push(cxRow('Radar reach', String(lv.radarRange)));
    if ((def.scoreValue ?? 0) > 0) rows.push(cxRow('Victory points', `${def.scoreValue} / level`));
    rows.push(cxRow('Tiers', maxLvl > 1 ? `${maxLvl} (upgradeable)` : '1'));
    const dos = buildingDossier(id, 1);
    return (
      `<div class="cx-head"><span class="cx-ic">${BUILD_ICON[id] ?? '▣'}</span><b>${esc(def.name)}</b><span class="cx-tag">building</span></div>` +
      `<div class="cx-stats">${rows.join('')}</div><div class="cx-desc">${dos?.body ?? ''}</div>`
    );
  }
  const def = data.units[id];
  if (!def) return '';
  const st = def.stats;
  const rows = [
    cxRow('Cost', cost(def.cost)),
    cxRow('Build time', `${def.buildTimeHours ?? 0} h`),
    cxRow('Attack / Defense', `${st.attack ?? 0} / ${st.defense ?? 0}`),
    cxRow('Hull HP', String(st.hp ?? 0)),
  ];
  if ((st.speed ?? 0) > 0) rows.push(cxRow('Speed', String(st.speed)));
  if ((st.range ?? 0) > 0) rows.push(cxRow('Range', String(st.range)));
  if ((st.cargoCapacity ?? 0) > 0) rows.push(cxRow('Cargo capacity', String(st.cargoCapacity)));
  if ((st.aaDamage ?? 0) > 0) rows.push(cxRow('Anti-air', String(st.aaDamage)));
  rows.push(cxRow('Radar signature', String(def.signature ?? 1)));
  if ((def.radarRange ?? 0) > 0) rows.push(cxRow('Radar reach', String(def.radarRange)));
  const upkeep = Object.entries(def.upkeep ?? {})
    .map(([r, n]) => `${n} ${r}/day`)
    .join(', ');
  if (upkeep) rows.push(cxRow('Upkeep', upkeep));
  const tags = [def.domain ?? 'space', def.line, ...(def.traits ?? [])].filter(Boolean).join(', ');
  if (tags) rows.push(cxRow('Class', tags));
  const dos = unitDossier(id);
  return (
    `<div class="cx-head"><span class="cx-ic">${unitIcon(id)}</span><b>${esc(dos?.name ?? displayUnit(id))}</b><span class="cx-tag">${def.domain === 'ground' ? 'ground unit' : 'ship'}</span></div>` +
    `<div class="cx-stats">${rows.join('')}</div><div class="cx-desc">${dos?.body ?? ''}</div>`
  );
}
// --- player card (tap the top-left crest) ------------------------------------
/** Your dossier in this session: faction, worlds, fleets, score, and the treasury.
 *  Opened by tapping the crest in the top-left corner. */
function playerCardHtml(): string {
  const pl = s.players[ME];
  const name = pl?.name ?? NAME[ME] ?? ME;
  const faction = SEAT_META.find((m) => m.id === ME)?.faction ?? pl?.faction ?? '—';
  const worlds = Object.values(s.planets).filter((p) => p.owner === ME).length;
  // Total units you command: ships + carried troops across your fleets, plus every
  // garrison on your worlds.
  let units = 0;
  for (const f of Object.values(s.fleets))
    if (f.owner === ME) units += sumUnits(f.units) + sumUnits(f.landing ?? []);
  for (const pp of Object.values(s.planets)) if (pp.owner === ME) units += sumUnits(pp.garrison);
  const score = Math.round(s.match?.scores?.[ME]?.total ?? 0);
  const need = Math.max(0, SCORE_LIMIT - score);
  const col = ownerColor(ME);
  const row = (k: string, v: string) => `<div class="pc-row"><span class="pc-k">${k}</span><span class="pc-v">${v}</span></div>`;
  return (
    `<div class="pc-head"><span class="pc-dia" style="background:${col};box-shadow:0 0 10px ${col}"></span>` +
    `<b>${esc(name)}</b><span class="pc-tag">commander</span></div>` +
    `<div class="pc-stats">` +
    row('Faction', esc(faction)) +
    row('Worlds held', String(worlds)) +
    row('Units', String(units)) +
    row('Score', `${score} / ${SCORE_LIMIT}${need === 0 ? ' · ★ WIN' : ' · ' + need + ' to win'}`) +
    `</div><div class="pc-sec">War record</div><div class="pc-stats">` +
    row('⚔ Enemy units destroyed', kfmt(killStats.destroyed)) +
    row('☠ Own units lost', kfmt(killStats.lost)) +
    `</div><button class="pc-close">CLOSE</button>`
  );
}
function openPlayerCard(): void {
  const el = document.getElementById('playercard');
  if (!el) return;
  el.innerHTML = `<div class="pcbox">${playerCardHtml()}</div>`;
  el.classList.add('show');
}

// --- session diplomacy & comms menu ------------------------------------------
// Opened from the left rail (Diplomacy / Dispatches). Two tabs: the participant
// roster (icon = human vs AI, sortable by name / provinces / stance, with stance
// actions) and the session message log. Stances run through the core's
// `diplomacy.declare`; messages are a client-side session log (SessionMsg).
const STANCE_RU: Record<DiplomaticStance, string> = {
  war: 'Война',
  peace: 'Мир',
  pact: 'Пакт',
  alliance: 'Союз',
};
const STANCE_COLOR: Record<DiplomaticStance, string> = {
  war: '#ff5a4d',
  peace: '#9fb8c0',
  pact: '#35d6e6',
  alliance: '#5ff0a8',
};
// Friendliness rank: war (hostile) < peace < pact < alliance (closest). Warming the
// relation up a rank needs the other side's consent; cooling it down is unilateral.
const STANCE_RANK: Record<DiplomaticStance, number> = { war: 0, peace: 1, pact: 2, alliance: 3 };
const STANCES: DiplomaticStance[] = ['war', 'peace', 'pact', 'alliance'];

function worldsOf(id: string): number {
  let n = 0;
  for (const p of Object.values(s.planets)) if (p.owner === id) n++;
  return n;
}
/** A seat the AI drives. Everyone else (ME, or another human in net play) is human —
 *  this drives the roster's human/AI icon and whether a proposal is auto-decided. */
function isAiSeat(id: string): boolean {
  return AI_PLAYERS.has(id);
}
/** Seats taking part in the match, in the fixed seat order. */
function diploSeats(): string[] {
  return SEAT_META.map((m) => m.id).filter((id) => !!s.players[id]);
}
type StampOpts = { day?: boolean; time?: boolean; real?: boolean; realAt?: number };
/** Message stamp. Defaults to `Day N · HH:MM` (game day + game time, mirrors the status
 *  strip); the chat passes toggles to add/drop fields and append the real wall-clock. */
function fmtStamp(at: number, opts?: StampOpts): string {
  const o = opts ?? { day: true, time: true };
  const p2 = (n: number) => String(n).padStart(2, '0');
  const parts: string[] = [];
  if (o.day) parts.push(`D${floor(at / DAY) + 1}`);
  if (o.time) parts.push(`${p2(floor((at % DAY) / HOUR))}:${p2(floor((at % HOUR) / 60000))}`);
  if (o.real && o.realAt != null) {
    const dt = new Date(o.realAt);
    parts.push(`⌚${p2(dt.getHours())}:${p2(dt.getMinutes())}`);
  }
  return parts.join(' ');
}

/** Deterministic AI verdict on a proposal to warm relations, by relative strength
 *  (provinces). A side that's winning won't de-escalate; a weaker/even one takes it. */
function aiAcceptsStance(target: string, to: DiplomaticStance): boolean {
  const mine = worldsOf(ME);
  const theirs = worldsOf(target);
  switch (to) {
    case 'war':
      return true; // war never needs consent
    case 'peace':
      return mine >= theirs; // sue for peace works unless they're ahead
    case 'pact':
      return mine * 4 >= theirs * 3; // mine ≥ 0.75× theirs — a respectable partner
    case 'alliance':
      return mine >= theirs; // ally only an equal-or-stronger power
  }
}

/** Append a line to the session log (bounded). Patches the feed if it's on screen. */
function pushMsg(to: string, text: string, sys: boolean, from = ME, ping?: string): void {
  sessionMessages.push({ at: s.time, from, to, text, sys, ping, realAt: Date.now() });
  if (sessionMessages.length > 300) sessionMessages.shift();
  if (diploOpen && diploTab === 'msgs') renderDiploFeed();
  if (chatOpen && !chatMin) renderChatFeed();
}

/** Player-driven stance change toward `target`. War (and any cooling-off) is
 *  unilateral; warming the relation up a rank asks the target — an AI decides by
 *  strength, a (net) human can't negotiate here yet. */
function proposeStance(target: string, to: DiplomaticStance): void {
  if (target === ME || !s.players[target]) return;
  const from = getStance(s, ME, target);
  if (from === to) return;
  if (STANCE_RANK[to] > STANCE_RANK[from]) {
    if (!isAiSeat(target)) {
      note('переговоры с другими игроками — позже (нужен сервер)');
      return;
    }
    if (!aiAcceptsStance(target, to)) {
      pushMsg(target, `${NAME[target] ?? target} отклонил предложение: ${STANCE_RU[to]}`, true, target);
      note(`✖ ${NAME[target] ?? target} отклонил: ${STANCE_RU[to]}`);
      return;
    }
  }
  // diplomacy.declare sets the stance and emits diplomacy.changed → the log line + note
  // are appended uniformly in handleEvents (the same path the AI's declarations take).
  playerOrder(declareWar(ME, target, to));
}

function openDiplo(tab: 'diplo' | 'msgs'): void {
  diploOpen = true;
  diploTab = tab;
  renderDiplo();
  document.getElementById('diplo')?.classList.add('show');
}
function closeDiplo(): void {
  diploOpen = false;
  document.getElementById('diplo')?.classList.remove('show');
}

/** Roster icon + tag for a seat: a human commander vs a synthetic (AI) one. */
function seatBadge(id: string): { icon: string; tag: string } {
  if (id === ME) return { icon: '☻', tag: 'ВЫ' };
  if (isAiSeat(id)) return { icon: '⌬', tag: 'ИИ' };
  return { icon: '☻', tag: 'ИГРОК' };
}

/** Does a seat pass the active roster filters? Stance filter never matches ME (no
 *  self-stance); an empty category imposes no constraint. */
function diploPasses(id: string): boolean {
  if (diploStanceFilter.size) {
    if (id === ME || !diploStanceFilter.has(getStance(s, ME, id))) return false;
  }
  if (diploTypeFilter.size && !diploTypeFilter.has(isAiSeat(id) ? 'ai' : 'human')) return false;
  return true;
}
function diploRowsHtml(): string {
  const others = diploSeats().filter((id) => id !== ME);
  const byName = (a: string, b: string) => (NAME[a] ?? a).localeCompare(NAME[b] ?? b);
  if (diploSort === 'name') others.sort(byName);
  else if (diploSort === 'worlds') others.sort((a, b) => worldsOf(b) - worldsOf(a) || byName(a, b));
  else
    others.sort(
      (a, b) => STANCE_RANK[getStance(s, ME, a)] - STANCE_RANK[getStance(s, ME, b)] || byName(a, b),
    );
  const ordered = [ME, ...others].filter(diploPasses);
  // Keep the expansion in sync with visibility: if a filter (or a stance/capture change
  // that re-renders) hides the expanded seat, drop the expansion — otherwise the row
  // re-opens itself when that seat later re-enters the list.
  if (diploExpanded && !ordered.includes(diploExpanded)) diploExpanded = null;
  if (!ordered.length) return `<div class="dp-empty">Под фильтр никто не подходит.</div>`;
  return ordered
    .map((id) => {
      const bdg = seatBadge(id);
      const col = ownerColor(id);
      const w = worldsOf(id);
      const isMe = id === ME;
      const st = isMe ? null : getStance(s, ME, id);
      const stanceTag = isMe
        ? `<span class="dp-tag">ВЫ</span>`
        : `<span class="dp-stance" style="color:${STANCE_COLOR[st!]};border-color:${STANCE_COLOR[st!]}">${STANCE_RU[st!]}</span>`;
      const expanded = diploExpanded === id && !isMe;
      const actions = expanded
        ? `<div class="dp-actions">` +
          STANCES.map(
            (t) =>
              `<button class="dp-act${t === st ? ' on' : ''}" data-stance="${t}" data-seat="${id}" style="--sc:${STANCE_COLOR[t]}">${STANCE_RU[t]}</button>`,
          ).join('') +
          `<button class="dp-msg" data-msgseat="${id}">✉</button></div>`
        : '';
      return (
        `<div class="dp-row${expanded ? ' open' : ''}${isMe ? ' me' : ''}"${isMe ? '' : ` data-seat="${id}"`}>` +
        `<span class="dp-ic" style="color:${col}">${bdg.icon}</span>` +
        `<span class="dp-name">${esc(NAME[id] ?? id)} <em>${bdg.tag}</em></span>` +
        `<span class="dp-w" title="провинций">⬣ ${w}</span>` +
        stanceTag +
        `</div>` +
        actions
      );
    })
    .join('');
}

// --- conversations (messages tab: list of chats + the open thread) -----------
/** Your coalition: you + everyone you're at `alliance` with. */
function coalitionMembers(): string[] {
  return [ME, ...diploSeats().filter((id) => id !== ME && getStance(s, ME, id) === 'alliance')];
}
/** Messages in a conversation: a group channel (coalition / session / global) collects
 *  everything addressed to it; a seat id = the 1:1 DM between you and them (either dir). */
function convoMessages(key: string): SessionMsg[] {
  if (GROUP_CHANNELS.has(key)) return sessionMessages.filter((m) => m.to === key);
  return sessionMessages.filter(
    (m) =>
      !GROUP_CHANNELS.has(m.to) && ((m.from === ME && m.to === key) || (m.from === key && m.to === ME)),
  );
}
function convoLast(key: string): SessionMsg | undefined {
  const ms = convoMessages(key);
  return ms[ms.length - 1];
}
function fromName(id: string): string {
  return id === ME ? 'Вы' : NAME[id] ?? id;
}
/** One message line. A ping renders as a clickable marker that flies the camera.
 *  `stamp` overrides which time fields show (the chat passes its cached toggles);
 *  omitted → the default `Day N · HH:MM` used by the diplomacy feed. */
function convoLineHtml(m: SessionMsg, stamp?: StampOpts): string {
  const t = fmtStamp(m.at, stamp && { ...stamp, realAt: m.realAt });
  if (m.ping) {
    return (
      `<div class="dp-line ping" data-ping="${esc(m.ping)}"><span class="dp-when">${t}</span>` +
      `📍 <b>${esc(fromName(m.from))}</b> ${esc(m.ping)}: ${esc(m.text)}<span class="dp-jump">↪ камера</span></div>`
    );
  }
  if (m.sys) return `<div class="dp-line sys"><span class="dp-when">${t}</span>${esc(m.text)}</div>`;
  return `<div class="dp-line${m.from === ME ? ' me' : ''}"><span class="dp-when">${t}</span><b>${esc(fromName(m.from))}:</b> ${esc(m.text)}</div>`;
}
function convoFeedInnerHtml(key: string): string {
  const msgs = convoMessages(key);
  if (msgs.length) return msgs.map((m) => convoLineHtml(m)).join('');
  return `<div class="dp-empty">${key === COALITION ? 'Чат коалиции пуст.<br>Отметьте провинцию пингом 📍 или напишите.' : 'Сообщений пока нет.'}</div>`;
}
/** Left column: the coalition channel pinned on top, then a DM per participant
 *  (most-recently-active first). Selecting one opens its thread on the right. */
function convoListHtml(): string {
  const dms = diploSeats()
    .filter((id) => id !== ME)
    .sort(
      (a, b) =>
        (convoLast(b)?.at ?? -1) - (convoLast(a)?.at ?? -1) ||
        (NAME[a] ?? a).localeCompare(NAME[b] ?? b),
    );
  const coal =
    `<button class="dp-cv coal${convoOpen === COALITION ? ' on' : ''}" data-convo="${COALITION}">` +
    `<span class="dp-cv-ic" style="color:var(--amber)">⚡</span>` +
    `<span class="dp-cv-nm">Коалиция<em>${coalitionMembers().length} уч.</em></span></button>`;
  const items = dms
    .map((id) => {
      const last = convoLast(id);
      const prev = last ? esc((last.from === ME ? 'Вы: ' : '') + (last.ping ? '📍 ' + last.ping : last.text)) : '—';
      return (
        `<button class="dp-cv${convoOpen === id ? ' on' : ''}" data-convo="${id}">` +
        `<span class="dp-cv-ic" style="color:${ownerColor(id)}">${seatBadge(id).icon}</span>` +
        `<span class="dp-cv-nm">${esc(NAME[id] ?? id)}<em>${prev}</em></span></button>`
      );
    })
    .join('');
  return `<div class="dp-cvlist">${coal}${items}</div>`;
}
/** Right column: header, the open conversation's messages, and the composer (with a
 *  ping button in the coalition channel). */
function convoThreadHtml(): string {
  const isCoal = convoOpen === COALITION;
  const title = isCoal
    ? `⚡ Коалиция · ${coalitionMembers().length} уч.`
    : `${seatBadge(convoOpen).icon} ${esc(NAME[convoOpen] ?? convoOpen)}`;
  const pingBtn = isCoal
    ? `<button class="dp-ping" title="Отметить выбранную провинцию пингом">📍</button>`
    : '';
  return (
    `<div class="dp-thread">` +
    `<div class="dp-thhead">${title}</div>` +
    `<div class="dp-feed" id="dp-feed">${convoFeedInnerHtml(convoOpen)}</div>` +
    `<div class="dp-compose">${pingBtn}<input id="dp-text" maxlength="160" placeholder="Сообщение…" autocomplete="off"><button class="dp-send">▶</button></div>` +
    `</div>`
  );
}

function renderDiplo(): void {
  const el = document.getElementById('diplo');
  if (!el) return;
  const tabBtn = (k: 'diplo' | 'msgs', label: string) =>
    `<button class="dp-tab${diploTab === k ? ' on' : ''}" data-tab="${k}">${label}</button>`;
  const sortBtn = (k: typeof diploSort, label: string) =>
    `<button class="dp-sortb${diploSort === k ? ' on' : ''}" data-sort="${k}">${label}</button>`;
  const stChip = (k: DiplomaticStance) =>
    `<button class="dp-fchip${diploStanceFilter.has(k) ? ' on' : ''}" data-fstance="${k}" style="--sc:${STANCE_COLOR[k]}">${STANCE_RU[k]}</button>`;
  const tyChip = (k: 'human' | 'ai', label: string) =>
    `<button class="dp-fchip ty${diploTypeFilter.has(k) ? ' on' : ''}" data-ftype="${k}">${label}</button>`;
  const anyFilter = diploStanceFilter.size || diploTypeFilter.size;
  const filterRow =
    `<div class="dp-filters"><span>Фильтр:</span>` +
    STANCES.map(stChip).join('') +
    `<span class="dp-fsep"></span>${tyChip('human', '☻ Человек')}${tyChip('ai', '⌬ ИИ')}` +
    (anyFilter ? `<button class="dp-fclear" data-fclear="1">Сброс</button>` : '') +
    `</div>`;
  const body =
    diploTab === 'diplo'
      ? `<div class="dp-sorts"><span>Сорт.:</span>${sortBtn('name', 'Имя')}${sortBtn('worlds', 'Провинции')}${sortBtn('stance', 'Отношение')}</div>` +
        filterRow +
        `<div class="dp-list">${diploRowsHtml()}</div>`
      : `<div class="dp-convo">${convoListHtml()}${convoThreadHtml()}</div>`;
  el.innerHTML =
    `<div class="dpbox">` +
    `<div class="dp-head"><b>СЕССИЯ</b>${tabBtn('diplo', 'Дипломатия')}${tabBtn('msgs', 'Сообщения')}<button class="dp-close">✕</button></div>` +
    body +
    `</div>`;
  if (diploTab === 'msgs') scrollFeedToEnd();
}
/** Patch just the open thread's feed (so a new line doesn't wipe a half-typed reply). */
function renderDiploFeed(): void {
  const feed = document.getElementById('dp-feed');
  if (!feed) return;
  feed.innerHTML = convoFeedInnerHtml(convoOpen);
  feed.scrollTop = feed.scrollHeight;
}
function scrollFeedToEnd(): void {
  const feed = document.getElementById('dp-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/** A compact codex tile (icon + a one-line label) that opens the full info panel on
 *  tap. `label` is the build cost for buildables, or ×count for a fleet's ships. The
 *  tiles live in context — building tiles in the build menu, ship tiles in the fleet
 *  panel — not in a global HUD strip. */
function codexTile(kind: 'b' | 'u', id: string, label: string): string {
  if (!(kind === 'b' ? data.buildings[id] : data.units[id])) return '';
  const icon = kind === 'b' ? BUILD_ICON[id] ?? '▣' : unitIcon(id);
  const name = kind === 'b' ? data.buildings[id]?.name ?? id : unitDossier(id)?.name ?? displayUnit(id);
  return `<button class="ptile" data-codex="${kind}:${id}" title="${esc(name)} — tap for full specs"><span class="pt-ic">${icon}</span><span class="pt-c">${esc(label)}</span></button>`;
}
/** A row of ship/troop tiles for a fleet's composition — tap one for its full specs. */
function unitTilesHtml(stacks: Array<{ unit: string; count: number }>): string {
  const tiles = stacks
    .filter((u) => u.count > 0)
    .map((u) => codexTile('u', u.unit, '×' + u.count))
    .join('');
  return tiles ? `<div class="ptiles">${tiles}</div>` : '';
}
function openCodex(key: string): void {
  const [kind, id] = key.split(':');
  const el = document.getElementById('codex');
  if (!el || !kind || !id) return;
  el.innerHTML = `<div class="cxbox">${codexHtml(kind, id)}${codexBuildBtn(kind, id)}<button class="cx-close">CLOSE</button></div>`;
  el.classList.add('show');
}
/** A "Build here" action inside the codex when the selected province can raise this
 *  thing — so the codex doubles as the build menu (tap a build tile → specs → build). */
function codexBuildBtn(kind: string, id: string): string {
  const p = selPlanet ? s.planets[selPlanet] : null;
  if (!p || p.owner !== ME) return ''; // only when you're looking at one of your worlds
  if (kind === 'b') {
    const buildable = (SECTOR_TYPES[SECTOR_OF[p.id]]?.allowedBuildings ?? BUILDABLE).includes(id);
    const built = p.buildings.some((b) => b.type === id);
    if (!buildable || built) return '';
    return `<button class="cx-build" data-build="building:${id}">▣ Build here · ${cost(data.buildings[id]?.cost)}</button>`;
  }
  if (kind === 'u' && data.units[id]) {
    return `<button class="cx-build" data-build="unit:${id}">${unitIcon(id)} Build here · ${cost(data.units[id]?.cost)}</button>`;
  }
  return '';
}

/** Right-docked description pane HTML for the currently hovered menu object. */
function objDescHtml(): string {
  const d = hoverObj ? objDossier(hoverObj) : null;
  if (!d) {
    return `<div class="pd-empty">Наведи на объект слева — здесь появится его досье.</div>`;
  }
  const lvl = hoverObj && hoverObj.startsWith('b:') ? Number(hoverObj.split(':')[2]) || 0 : 0;
  const title = lvl ? `${esc(d.name)} ${hl(lvl)}` : esc(d.name);
  return `<div class="pd-title">${title}</div><div class="pd-body">${d.body}</div>`;
}

function renderObjDesc(): void {
  const pane = document.getElementById('pdesc');
  if (!pane) return;
  const html = objDescHtml();
  if (html === lastObjDescHtml) return;
  lastObjDescHtml = html;
  pane.innerHTML = html;
}

function renderPanel() {
  // While arming a merge target, collapse the panel so the map (and the fleet to
  // merge with) is fully tappable — important on phones where the sheet covers it.
  const open = !merging && (selFleet !== null || selPlanet !== null || selFleets.size > 0);
  side.style.display = open ? 'flex' : 'none';
  document.body.classList.toggle('sheet-open', open); // mobile: hide log/comms under the sheet
  if (!open) {
    lastPanelHtml = '';
    lastObjDescHtml = '';
    hoverObj = null;
    return;
  }
  const html = panelHtml();
  if (html !== lastPanelHtml) {
    // Scrollable content on the left, a fixed dossier pane glued to the right edge
    // (filling the panel's empty space — see #side / .pdesc CSS). Re-rendering the
    // content rebuilds #pdesc, so force the dossier to repaint against the new DOM.
    // Preserve the scroll offset across the rebuild — the build conveyor's countdown
    // changes the HTML every frame, which would otherwise snap the list back to top
    // and make the panel impossible to scroll while anything is under construction.
    const prevScroll = (side.querySelector('.pscroll') as HTMLElement | null)?.scrollTop ?? 0;
    side.innerHTML = `<div class="pscroll">${html}</div><aside class="pdesc" id="pdesc"></aside>`;
    const ps = side.querySelector('.pscroll') as HTMLElement | null;
    if (ps && prevScroll > 0) ps.scrollTop = prevScroll;
    lastPanelHtml = html;
    lastObjDescHtml = '';
  }
  renderObjDesc();
  updatePanelLive(); // patch live countdowns in place — never rebuild the panel for them
}

/** Patch the panel's per-frame text (build progress, travel ETA, battle round) in
 *  place each frame. These tick every frame, so they're kept OUT of the panel's HTML
 *  signature — the panel (and its buttons) only rebuilds on real structural changes,
 *  so a click whose down/up straddle a frame is never dropped. */
function updatePanelLive(): void {
  const root = side.querySelector('.pscroll');
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll('.conv-fill')) as HTMLElement[]) {
    const at = Number(el.dataset.at);
    const dur = Number(el.dataset.dur);
    const pct = dur > 0 ? Math.max(0, Math.min(100, 100 - ((at - s.time) / dur) * 100)) : 100;
    el.style.width = `${pct.toFixed(0)}%`;
  }
  for (const el of Array.from(root.querySelectorAll('.conv-time')) as HTMLElement[]) {
    el.textContent = timeLeft(Number(el.dataset.at));
  }
  for (const el of Array.from(root.querySelectorAll('.pn-eta')) as HTMLElement[]) {
    const totalH = Math.max(0, (Number(el.dataset.arrive) - s.time) / HOUR) + Number(el.dataset.rest);
    el.textContent = fmtEta(totalH);
  }
  for (const el of Array.from(root.querySelectorAll('.pn-timer')) as HTMLElement[]) {
    el.textContent = timeLeft(Number(el.dataset.at));
  }
}

function cmdBtn(cmd: string, icon: string, label: string, cls: string, disabled: boolean): string {
  return `<button data-cmd="${cmd}" class="${cls}" title="${esc(label)}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}><span class="ci">${icon}</span><span class="cl">${esc(label)}</span></button>`;
}

/** Horizontal fleet command bar — Move (arm) / Stop / Attack / orbit change —
 *  acting on the current fleet selection, buttons enabled by context. */
function renderCmdBar() {
  const ids = selectedFleetIds();
  if (ids.length === 0) {
    if (aiming) aiming = false;
    if (merging) merging = false;
    cmdbar.classList.remove('show');
    lastCmdHtml = '';
    return;
  }
  const fleets = ids.map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  const anyMoving = fleets.some((f) => f.movement);
  const docked = fleets.filter((f) => f.location && !f.movement && !f.battleId);
  const canAssault = docked.some(
    (f) =>
      f.orbit === 'near' &&
      f.location &&
      s.planets[f.location]?.owner !== f.owner &&
      SECTOR_TYPES[SECTOR_OF[f.location]]?.capturable, // empty space can't be taken
  );
  // Merge: a group fuses in one tap; a lone fleet arms target-pick (needs a partner).
  const myFleetTotal = Object.values(s.fleets).filter((f) => f.owner === ME).length;
  const canMerge = ids.length >= 2 || (ids.length === 1 && myFleetTotal >= 2);
  // Split: only a single docked fleet with ≥2 ships can shed some into a new fleet.
  const lone = ids.length === 1 && fleets[0] ? fleets[0] : null;
  const canSplit = !!lone && !!lone.location && !lone.movement && !lone.battleId && sumUnits(lone.units) >= 2;
  // Artillery in the selection → offer the standoff-fire focus order.
  const anyArtillery = fleets.some(fleetHasArtillery);
  const html =
    `<span class="cmdlabel">${ids.length > 1 ? ids.length + ' FLEETS' : 'FLEET'}</span>` +
    cmdBtn('move', '⤳', 'Move', aiming ? 'on' : '', false) +
    cmdBtn('stop', '■', 'Stop', 'danger', !anyMoving) +
    cmdBtn('attack', '⚔', 'Attack', '', !canAssault) +
    (anyArtillery ? cmdBtn('barrage', '🎯', 'Обстрел', barrageAim ? 'on' : '', false) : '') +
    cmdBtn('merge', '⛬', ids.length > 1 ? 'Merge' : 'Merge…', merging ? 'on' : '', !canMerge) +
    cmdBtn('split', '⊟', 'Split', splitState ? 'on' : '', !canSplit);
  if (html !== lastCmdHtml) {
    cmdbar.innerHTML = html;
    lastCmdHtml = html;
  }
  cmdbar.classList.add('show');
}

/** Ship counts (by type) of a fleet — the rows of the split dialog. */
function fleetShipCounts(f: Fleet): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of f.units) out[st.unit] = (out[st.unit] ?? 0) + st.count;
  return out;
}

/** The "Split fleet" modal: per ship type, +1 / +10 / All (and −1) move ships into
 *  a new fleet; Confirm peels them off into the same sector. Closes itself if the
 *  fleet is deselected, vanishes, or starts moving. */
function renderSplitDialog() {
  if (splitState && splitState.fleetId !== selFleet) splitState = null; // selection moved on
  const f = splitState ? s.fleets[splitState.fleetId] : undefined;
  if (!splitState || !f || f.movement || f.battleId) {
    splitState = null;
    if (splitdlg.style.display !== 'none') splitdlg.style.display = 'none';
    lastSplitHtml = '';
    return;
  }
  const counts = fleetShipCounts(f);
  let takeTotal = 0;
  let total = 0;
  let rows = '';
  for (const unit of Object.keys(counts)) {
    const have = counts[unit] ?? 0;
    total += have;
    const tk = Math.min(splitState.take[unit] ?? 0, have);
    splitState.take[unit] = tk;
    takeTotal += tk;
    rows += `<div class="srow">
      <span class="sname"><span class="bicon">${unitIcon(unit)}</span>${esc(displayUnit(unit))}</span>
      <b class="scur">${have - tk}</b>
      <span class="sbtns">
        <button data-sx="dec" data-unit="${esc(unit)}" data-n="1" ${tk <= 0 ? 'disabled' : ''}>−1</button>
        <button data-sx="inc" data-unit="${esc(unit)}" data-n="1" ${tk >= have ? 'disabled' : ''}>+1</button>
        <button data-sx="inc" data-unit="${esc(unit)}" data-n="10" ${tk >= have ? 'disabled' : ''}>+10</button>
        <button data-sx="all" data-unit="${esc(unit)}" ${tk >= have ? 'disabled' : ''}>All</button>
      </span>
      <b class="snew">→ ${tk}</b>
    </div>`;
  }
  const valid = takeTotal > 0 && takeTotal < total;
  const html = `<div class="sbox">
    <div class="shead">SPLIT FLEET <b>${esc(splitState.fleetId)}</b></div>
    <div class="ssub">Peel ships into a new fleet — it stays in the same sector. At least one ship stays behind; carried troops stay with the original.</div>
    <div class="srows">${rows}</div>
    <div class="sfoot">new fleet: <b>${takeTotal}</b> ships · original keeps <b>${total - takeTotal}</b></div>
    <div class="sactions">
      <button data-sx="confirm" class="cbtn" ${valid ? '' : 'disabled'}>Confirm</button>
      <button data-sx="cancel" class="cbtn ghost">Cancel</button>
    </div>
  </div>`;
  if (html !== lastSplitHtml) {
    splitdlg.innerHTML = html;
    lastSplitHtml = html;
  }
  splitdlg.style.display = 'flex';
}

splitdlg.addEventListener('click', (ev) => {
  if (ev.target === splitdlg && splitState) {
    // click on the dimmed backdrop (outside the box) cancels
    splitState = null;
    renderSplitDialog();
    lastCmdHtml = '';
    renderCmdBar();
    return;
  }
  const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t || t.disabled || !splitState) return;
  const sx = t.dataset.sx;
  if (sx === 'cancel') {
    splitState = null;
    renderSplitDialog();
    lastCmdHtml = '';
    renderCmdBar();
    return;
  }
  if (sx === 'confirm') {
    const take = Object.entries(splitState.take)
      .filter(([, n]) => n > 0)
      .map(([unit, count]) => ({ unit, count }));
    if (take.length) playerOrder(splitFleet(ME, splitState.fleetId, take));
    splitState = null;
    renderSplitDialog();
    lastCmdHtml = '';
    lastPanelHtml = '';
    renderCmdBar();
    renderPanel();
    return;
  }
  const unit = t.dataset.unit ?? '';
  const f = s.fleets[splitState.fleetId];
  if (!f) return;
  const have = fleetShipCounts(f)[unit] ?? 0;
  const cur = splitState.take[unit] ?? 0;
  if (sx === 'inc') splitState.take[unit] = Math.min(have, cur + Number(t.dataset.n));
  else if (sx === 'dec') splitState.take[unit] = Math.max(0, cur - Number(t.dataset.n));
  else if (sx === 'all') splitState.take[unit] = have;
  renderSplitDialog();
});

side.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t || t.disabled) return;
  if (t.dataset.codex) {
    openCodex(t.dataset.codex); // a build/ship tile → full specs (+ Build here)
    return;
  }
  const act = t.dataset.act;
  const arg = t.dataset.arg ?? '';
  if (act === 'close') {
    clearSelection();
  } else if (act === 'cancel') {
    selFleet = null;
    selFleets = new Set();
  } else if (act === 'selfleet') {
    setFleetSelection([arg]);
  } else if (act === 'tab') {
    if (arg === 'ground' || arg === 'ships' || arg === 'buildings') {
      planetTab = arg;
    }
  } else if (act === 'build') {
    enqueueBuild(selPlanet!, { kind: 'building', id: arg, count: 1 });
  } else if (act === 'upgrade') {
    enqueueBuild(selPlanet!, { kind: 'upgrade', id: arg, count: 1 });
  } else if (act === 'unit') {
    enqueueBuild(selPlanet!, { kind: 'unit', id: arg, count: 1 });
  } else if (act === 'mobilize') {
    playerOrder(mobilizeDivision(ME, selPlanet!, Number(arg)));
  } else if (act === 'capital') {
    playerOrder(designateCapital(ME, selPlanet!));
  } else if (act === 'bombard') {
    playerOrder(bombardFleet(ME, selFleet!, arg === 'on'));
  } else if (act === 'barragemode') {
    playerOrder(barrageModeFleet(ME, selFleet!, arg));
  } else if (act === 'assault') {
    playerOrder(assaultFleet(ME, selFleet!));
  } else if (act === 'load') {
    beginLoad(selFleet!, arg); // ~1h timed load (animated in the marker)
  } else if (act === 'unload') {
    playerOrder(unloadArmy(ME, selFleet!, arg, 1));
  } else if (act === 'divload') {
    playerOrder(loadDivision(ME, arg, selFleet!));
  } else if (act === 'divunload') {
    playerOrder(unloadDivision(ME, arg));
  } else if (act === 'officer') {
    const sep = arg.indexOf('|');
    const divId = arg.slice(0, sep);
    const key = arg.slice(sep + 1);
    playerOrder(setDivisionOfficer(ME, divId, key || null));
  }
  lastPanelHtml = '';
  renderPanel();
});

// Side-panel object hover → live dossier in the right-docked pane (desktop only;
// touch has no hover, so the pane just stays on its default prompt there).
side.addEventListener('pointermove', (ev) => {
  if (MOBILE) return;
  const t = ev.target as HTMLElement;
  if (t.closest('#pdesc')) return; // over the dossier itself — keep what's shown
  const key = (t.closest('[data-desc]') as HTMLElement | null)?.dataset.desc ?? null;
  if (key !== hoverObj) {
    hoverObj = key;
    renderObjDesc();
  }
});
side.addEventListener('pointerleave', () => {
  if (hoverObj !== null) {
    hoverObj = null;
    renderObjDesc();
  }
});

cmdbar.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t || t.disabled) return;
  const cmd = t.dataset.cmd;
  const ids = selectedFleetIds();
  if (cmd !== 'merge') merging = false; // any other command disarms merge-targeting
  if (cmd !== 'barrage') barrageAim = false; // any other command disarms barrage-targeting
  if (cmd === 'move') {
    aiming = !aiming; // arm / disarm the move order
  } else if (cmd === 'merge') {
    if (ids.length >= 2) mergeGroup(ids);
    else {
      merging = !merging; // lone fleet → arm: next friendly-fleet tap is the anchor
      aiming = false;
      if (merging) note('⛬ pick a fleet to merge with');
    }
  } else if (cmd === 'stop') {
    for (const id of ids) if (s.fleets[id]?.movement) playerOrder(stopFleet(ME, id));
  } else if (cmd === 'attack') {
    for (const id of ids) if (s.fleets[id]?.orbit === 'near') playerOrder(assaultFleet(ME, id));
    aiming = false;
  } else if (cmd === 'split') {
    const id = ids[0];
    if (id) {
      splitState = splitState ? null : { fleetId: id, take: {} }; // toggle the dialog
      aiming = false;
      renderSplitDialog();
    }
  } else if (cmd === 'barrage') {
    // Arm focus-fire: the next tap on an enemy fleet aims the selected artillery
    // at it; a tap on empty space clears back to auto-targeting the nearest.
    barrageAim = !barrageAim;
    aiming = false;
    if (barrageAim) note('🎯 tap an enemy fleet to focus fire · empty space = auto');
  }
  lastCmdHtml = '';
  lastPanelHtml = '';
  renderCmdBar();
  renderPanel();
});

// --- canvas input ------------------------------------------------------------

// Tap/click selection at a screen point (drag-aware — see the pointer handlers).
function selectAt(mx: number, my: number) {
  closePingPop(); // any map tap dismisses an open ping popup (a marker tap reopens below)
  // Merge armed: the next tap on a friendly fleet (not itself in the selection) is
  // the anchor — the selected fleet(s) fly to it and fuse. Any other tap cancels.
  if (merging) {
    const movers = selectedFleetIds();
    for (const f of Object.values(s.fleets)) {
      if (f.owner !== ME || movers.includes(f.id)) continue;
      const a = fleetAnchor(f);
      if (a && Math.hypot(mx - a.x, my - a.y) < 16) {
        orderMerge(movers, f.id);
        merging = false;
        lastPanelHtml = '';
        return;
      }
    }
    merging = false;
    lastPanelHtml = '';
    return;
  }
  // Barrage armed: the next tap on an enemy fleet focuses the selected artillery's
  // standoff fire on it; a tap on empty space (no enemy fleet) clears back to
  // auto-targeting the nearest hostile in range. A mis-aimed/peace target is
  // rejected server-side (surfaced as a log note).
  if (barrageAim) {
    let targetId: string | null = null;
    for (const f of Object.values(s.fleets)) {
      if (f.owner === ME) continue;
      const a = fleetAnchor(f);
      if (a && Math.hypot(mx - a.x, my - a.y) < 16) {
        targetId = f.id;
        break;
      }
    }
    for (const id of selectedFleetIds()) {
      if (fleetHasArtillery(s.fleets[id])) playerOrder(barrageFleet(ME, id, targetId));
    }
    if (targetId) note('🎯 focus fire set');
    else note('🎯 auto-target');
    barrageAim = false;
    lastPanelHtml = '';
    return;
  }
  // Plain tap = selection. Movement happens only when "Move" is armed (aiming), so a
  // fleet selection never blocks picking a planet (and vice versa).
  // A tap on an ally ping marker opens its description popup (takes priority over
  // selection, since markers float above the node they mark).
  if (!aiming) {
    for (const h of pingHits) {
      if (Math.hypot(mx - h.x, my - h.y) < 12) {
        openPingPop(h.loc);
        return;
      }
    }
  }
  if (!aiming) {
    for (const f of Object.values(s.fleets)) {
      if (f.owner !== ME) continue;
      const a = fleetAnchor(f);
      if (a && Math.hypot(mx - a.x, my - a.y) < 16) {
        if (additive) toggleFleetInSelection(f.id); // Ctrl/⌘ → extend the group
        else setFleetSelection([f.id]); // (clears any selected planet)
        return;
      }
    }
  }
  for (const n of MAP) {
    const c = world(n);
    if (Math.hypot(mx - c.x, my - c.y) < 24) {
      if (aiming) {
        // Move armed → send the selected fleet(s) here; they route along the lanes to
        // this world and stop. Keep them selected for follow-up orders. A route through
        // a player you're at peace with stages a war prompt instead of dispatching.
        tryMoveGroup(selectedFleetIds(), n.id);
        aiming = false;
        lastPanelHtml = '';
        return;
      }
      // plain tap → select the planet (mutually exclusive with a fleet)
      selPlanet = n.id;
      selFleet = null;
      selFleets = new Set();
      lastPanelHtml = '';
      return;
    }
  }
  // Move armed but no node hit → if the tap landed on a road, march there: the
  // army routes to that lane and parks at the exact point (Bytro continuous order).
  if (aiming) {
    const lane = nearestLanePoint(mx, my);
    if (lane) {
      tryMoveEdgeGroup(selectedFleetIds(), { from: lane.from, to: lane.to, t: lane.t });
    }
    aiming = false;
    lastPanelHtml = '';
    return;
  }
  clearSelection();
}

// --- camera control: drag-pan, pinch-zoom, wheel-zoom, tap-select ------------

const pointers = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number } | null = null;
let dragged = false;
let pinchDist = 0;
let boxSelecting = false;
const ptXY = (ev: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * VW, y: ((ev.clientY - r.top) / r.height) * VH };
};
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture?.(ev.pointerId);
  const p = ptXY(ev);
  pointers.set(ev.pointerId, p);
  if (pointers.size === 1) {
    dragStart = p;
    boxSelecting = ev.shiftKey;
    additive = ev.ctrlKey || ev.metaKey; // Ctrl/⌘-click → add to the fleet selection
    selectionBox = boxSelecting ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y } : null;
    dragged = false;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (ev) => {
  const prev = pointers.get(ev.pointerId);
  if (!prev) return;
  const p = ptXY(ev);
  pointers.set(ev.pointerId, p);
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    pinchDist = d;
    dragged = true;
  } else if (boxSelecting && dragStart) {
    selectionBox = { x1: dragStart.x, y1: dragStart.y, x2: p.x, y2: p.y };
    if (Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 6) dragged = true;
  } else {
    cam.x += p.x - prev.x;
    cam.y += p.y - prev.y;
    clampCam(); // keep the map from being dragged entirely off-screen
    if (dragStart && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 6) dragged = true;
  }
});
function endPointer(ev: PointerEvent) {
  const single = pointers.size === 1;
  const p = pointers.get(ev.pointerId);
  if (single && boxSelecting && selectionBox) {
    const x1 = Math.min(selectionBox.x1, selectionBox.x2);
    const x2 = Math.max(selectionBox.x1, selectionBox.x2);
    const y1 = Math.min(selectionBox.y1, selectionBox.y2);
    const y2 = Math.max(selectionBox.y1, selectionBox.y2);
    const picked: string[] = [];
    for (const f of Object.values(s.fleets)) {
      if (f.owner !== ME) continue;
      const a = fleetAnchor(f);
      if (a && a.x >= x1 && a.x <= x2 && a.y >= y1 && a.y <= y2) picked.push(f.id);
    }
    if (picked.length) setFleetSelection(picked);
    else {
      selFleets = new Set();
      selFleet = null;
      lastPanelHtml = '';
    }
    selectionBox = null;
    boxSelecting = false;
  }
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (single && !dragged && p) selectAt(p.x, p.y);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (ev) => {
  pointers.delete(ev.pointerId);
  pinchDist = 0;
  selectionBox = null;
  boxSelecting = false;
});
canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * VW;
    const y = ((ev.clientY - r.top) / r.height) * VH;
    zoomAt(x, y, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);
canvas.addEventListener('dblclick', () => defaultView());
// track the pointer for the "Move" preview line (desktop only)
canvas.addEventListener('pointermove', (ev) => {
  aimPointer = ptXY(ev);
});

// --- top bar / speed ---------------------------------------------------------

for (const b of Array.from(document.querySelectorAll('[data-speed]'))) {
  b.addEventListener('click', () => {
    speed = Number((b as HTMLElement).dataset.speed);
    for (const x of Array.from(document.querySelectorAll('[data-speed]')))
      x.classList.toggle('on', Number((x as HTMLElement).dataset.speed) === speed);
  });
}

// Map a setup time-flow multiplier (×1/×2/×5/×10) onto the speedbar and start running at
// it. The multiplier IS the play speed in game-hours per real second (×1 = a calm 1 h/s,
// ×5 = 5 h/s, …); fast-forward (▶▶) runs at 3× the chosen play. The play/fast buttons carry
// the live values so pause→resume returns to the chosen pace, not the default.
const PLAY_BASE = 1; // game-hours per real second at ×1 (the calm baseline pace)
function applyTimeSpeed(mult: number): void {
  const play = PLAY_BASE * mult;
  const playBtn = $('spd-play');
  const fastBtn = $('spd-fast');
  if (playBtn) playBtn.dataset.speed = String(play);
  if (fastBtn) fastBtn.dataset.speed = String(play * 3);
  speed = play;
  for (const x of Array.from(document.querySelectorAll('[data-speed]')))
    x.classList.toggle('on', Number((x as HTMLElement).dataset.speed) === speed);
}

// Restart → back to the skirmish setup (bot selection). The speedbar button serves the
// no-bots sandbox; the end-banner button (delegated) serves a finished bot match.
restartBtn.addEventListener('click', () => openSetup());
bannerEl.addEventListener('click', (ev) => {
  if ((ev.target as Element).closest('[data-restart]')) openSetup();
});

// Speedbar "⌂ В меню": leave the current match back to the hub from anywhere in-game.
// In net mode this is an intentional disconnect (userClosed → no auto-reconnect). The
// sim keeps ticking underneath as the menu's live backdrop, same as the other overlays.
$('tomenu').addEventListener('click', () => {
  if (NET) {
    userClosed = true;
    NET = false;
    if (netSock) netSock.close();
  }
  openHub();
});

// Event-log window: the rail's ≡ opens it; ✕ or the backdrop closes it. The feed
// (#log) updates in place each frame whether the window is open or not.
const logWin = document.getElementById('logwin');
document.getElementById('rail-log')?.addEventListener('click', () => logWin?.classList.add('show'));
logWin?.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'logwin' || tg.classList.contains('lw-close')) logWin.classList.remove('show');
});

// --- technologies window -----------------------------------------------------
// Session research (technologyModule): pick a tech to research (one at a time). Techs are
// grouped by branch, show cost + status, and gate on prerequisites / day / affordability.
const techWin = $('tech');
const TECH_CUR: Record<string, string> = {
  credits: '¤', food: '❖', metal: '⬢', energy: '↯', microelectronics: '▦',
};
const TECH_BRANCHES: Array<{ key: string; label: string }> = [
  { key: 'space', label: 'Космос' },
  { key: 'ground', label: 'Земля' },
  { key: 'squadron', label: 'Эскадрильи' },
  { key: 'missile', label: 'Ракеты' },
];
const techCost = (c: Record<string, number>): string =>
  Object.entries(c).map(([k, v]) => `${TECH_CUR[k] ?? k} ${v}`).join(' · ');
function renderTech(): void {
  const body = $('techbody');
  const me = s.players[ME];
  const techs = data.technologies;
  const done = new Set(me?.technologies?.completed ?? []);
  const active = me?.technologies?.active;
  const res = (me?.resources ?? {}) as Record<string, number>;
  const started = s.startedAt ?? 0;
  let html = '';
  if (active) {
    const def = techs[active.technology];
    const total = active.completesAt - active.startedAt;
    const prog = total > 0 ? clamp((s.time - active.startedAt) / total, 0, 1) : 1;
    const etaH = Math.max(0, Math.ceil((active.completesAt - s.time) / HOUR));
    html +=
      `<div class="tw-active"><div class="tw-an">⚛ Исследуется: ${esc(def?.name ?? active.technology)}</div>` +
      `<div class="tw-bar"><div class="tw-fill" style="width:${Math.round(prog * 100)}%"></div></div>` +
      `<div class="tw-eta">≈ ${etaH} ч осталось</div></div>`;
  }
  for (const br of TECH_BRANCHES) {
    const ids = Object.keys(techs)
      .filter((id) => (techs[id]!.branch ?? 'space') === br.key)
      .sort((a, b) => techs[a]!.tier - techs[b]!.tier || a.localeCompare(b));
    if (!ids.length) continue;
    html += `<div class="tw-branch">${br.label}</div>`;
    for (const id of ids) {
      const t = techs[id]!;
      const isActive = active?.technology === id;
      const prereqMissing = (t.prerequisites ?? []).filter((p) => !done.has(p));
      const dayGate = t.dayGate ?? 0;
      const gatedByDay = dayGate > 0 && s.time - started < dayGate * DAY;
      const affordable = Object.entries(t.cost).every(([k, v]) => (res[k] ?? 0) >= (v as number));
      let cls = '';
      let action = '';
      if (done.has(id)) {
        cls = 'done';
        action = `<span class="tw-badge">✓ изучено</span>`;
      } else if (isActive) {
        action = `<span class="tw-badge wait">⏳ идёт…</span>`;
      } else if (prereqMissing.length) {
        cls = 'locked';
        action = `<span class="tw-badge wait">🔒 ${prereqMissing.map((p) => esc(techs[p]?.name ?? p)).join(', ')}</span>`;
      } else if (gatedByDay) {
        cls = 'locked';
        action = `<span class="tw-badge wait">🔒 с дня ${dayGate}</span>`;
      } else {
        const dis = !!active || !affordable;
        action = `<button class="tw-go" data-tech="${id}"${dis ? ' disabled' : ''}>Исследовать</button>`;
      }
      html +=
        `<div class="tw-card ${cls}"><div class="tw-info">` +
        `<div class="tw-name">${esc(t.name)}<span class="tier">T${t.tier}</span></div>` +
        `<div class="tw-meta"><span class="tw-cost">${techCost(t.cost)}</span> · ${t.researchTimeHours}ч` +
        (t.description ? `<br>${esc(t.description)}` : '') +
        `</div></div>${action}</div>`;
    }
  }
  body.innerHTML = html;
}
document.getElementById('rail-tech')?.addEventListener('click', () => {
  techWin.classList.add('show');
  renderTech();
});
techWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'tech' || tg.classList.contains('tw-close')) {
    techWin.classList.remove('show');
    return;
  }
  const id = (tg.closest('.tw-go') as HTMLElement | null)?.dataset.tech;
  if (id) {
    playerOrder(researchTech(ME, id));
    renderTech();
  }
});

// --- connect overlay (single-player vs join a live session) ------------------
// Entry screen: pick a faction, then run a local skirmish or connect to a server
// (`pnpm dev:proto-server`, or a tunnel URL a friend shared). The last-used URL
// is remembered so the APK reconnects with one tap.
const connectEl = $('connect');
const srvInput = $('csrv') as HTMLInputElement;
const nickInput = $('cnick') as HTMLInputElement;
const statusEl = $('cstatus');
const showConnect = (show: boolean): void => {
  connectEl.style.display = show ? 'flex' : 'none';
};
srvInput.value =
  localStorage.getItem('void.server') ??
  // Default to the SAME ORIGIN so a served page needs no typing: deployed https →
  // wss://<host>; the game served from the proto-server (http on its port) →
  // ws://<host>:<port>; a file:// page or the APK (no port) → ws://<host>:8788.
  (location.protocol === 'https:'
    ? `wss://${location.host}`
    : location.port
      ? `ws://${location.host}`
      : `ws://${location.hostname || '127.0.0.1'}:8788`);
// Remember the side you last commanded, so reopening the link drops you back onto
// your own seat — the server maps nick→side, so a returning name resumes its own
// faction (nick-login; full accounts in docs/persistence-accounts-roadmap.md).
nickInput.value = localStorage.getItem('void.nick') ?? '';

$('csolo').addEventListener('click', () => {
  userClosed = true; // intentional leave → don't auto-reconnect
  NET = false;
  openSetup(); // pick start + rivals before the skirmish begins
});

// DEV TEST MODE — fenced hook. The "Тесты" button opens the dev test overlay;
// initTestMode wires it to the host with two tiny callbacks. Cut this whole block
// (and the import + #testmode HTML/CSS) to remove the feature without a trace.
$('ctest')?.addEventListener('click', () => {
  userClosed = true;
  NET = false;
  showConnect(false);
  openTestMode();
});
initTestMode({
  startScenario: (state, resumeSpeed) => {
    installMatch(state, new Set()); // scenarios drive themselves — no AI
    speed = 0; // start paused at t=0
    // prime the fast-forward (▶▶) control to the chosen multiplier and show paused
    const spd = Array.from(document.querySelectorAll('[data-speed]')) as HTMLElement[];
    const fast = spd[spd.length - 1];
    if (fast) {
      fast.dataset.speed = String(resumeSpeed);
      fast.textContent = `${resumeSpeed}×`;
    }
    for (const x of spd) x.classList.toggle('on', Number(x.dataset.speed) === 0);
    connectEl.style.display = 'none';
  },
  back: () => showConnect(true),
});

// --- welcome stage: first-launch identity screen → match browser ------------
// The entry overlay opens on a clean welcome (new commander / sign-in / single-
// player); "Новый командир" and "Вход" reveal the match browser (stage 2). Social
// sign-in is a styled stub until accounts land (docs/accounts-roadmap.md AC-1.1):
// it drops you straight into guest play by callsign, with a "скоро" notice.
const welcomeStageEl = $('cwelcome');
const browseStageEl = $('cbrowse');
function showStage(stage: 'welcome' | 'browse'): void {
  welcomeStageEl.style.display = stage === 'welcome' ? '' : 'none';
  browseStageEl.style.display = stage === 'browse' ? '' : 'none';
}

// A fresh callsign for a brand-new commander. Deterministic on purpose (no random/
// time even in UI glue): a persisted counter walks a fixed wordlist.
const CALLSIGNS = ['Носорог', 'Комета', 'Гадюка', 'Орион', 'Вектор', 'Сокол', 'Титан', 'Квазар'];
function suggestCallsign(): string {
  const n = (Number(localStorage.getItem('void.newcount') ?? '0') || 0) + 1;
  localStorage.setItem('void.newcount', String(n));
  return `${CALLSIGNS[(n - 1) % CALLSIGNS.length]}-${n}`;
}
function enterBrowse(): void {
  if (!nickInput.value.trim()) nickInput.value = suggestCallsign();
  showStage('browse');
  void refreshMatches();
}
// --- meta-shell hub: post-login home + bottom nav (docs/main-menu.md) -------
// After identity you land on the hub (home + PLAY + bottom nav), not the raw match
// list. The nav routes into the existing flow: "Игры"/"ИГРАТЬ" → the match browser
// (стадия 2 of #connect, untouched), Рейтинг/Альянсы → заглушки до мета-слоя, Ещё →
// настройки. Social sign-in is a guest stub (accounts AC-1.1) with a "скоро" note.
const hubEl = $('hub');
const hubNote = $('hub-note');
function showHub(show: boolean): void {
  hubEl.style.display = show ? 'flex' : 'none';
}
const HUB_PANELS: Record<string, string> = { home: 'hp-home', rank: 'hp-rank', ally: 'hp-ally', more: 'hp-more' };
function hubTab(tab: string): void {
  hubNote.textContent = '';
  if (tab === 'games') {
    showHub(false);
    showConnect(true);
    enterBrowse(); // hand off to the existing match browser
    return;
  }
  for (const [k, pid] of Object.entries(HUB_PANELS)) $(pid).style.display = k === tab ? 'flex' : 'none';
  for (const b of Array.from(document.querySelectorAll('.hub-tab')))
    b.classList.toggle('active', (b as HTMLElement).dataset.hub === tab);
}
function openHub(note = ''): void {
  if (!nickInput.value.trim()) nickInput.value = suggestCallsign();
  $('hub-name').textContent = nickInput.value.trim() || 'Командир';
  showConnect(false);
  showHub(true);
  hubTab('home');
  hubNote.textContent = note;
}

$('cnew').addEventListener('click', () => openHub());
$('clogin').addEventListener('click', () => openHub());
$('cgoogle').addEventListener('click', () => openHub('Вход через Google — скоро · ты вошёл гостем'));
$('capple').addEventListener('click', () => openHub('Вход через Apple — скоро · ты вошёл гостем'));
$('cback').addEventListener('click', () => {
  showStage('welcome'); // reset #connect's inner stage for next time
  statusEl.textContent = '';
  openHub(); // back from the browser → the hub
});
$('clang').addEventListener('click', () => {
  statusEl.textContent = 'Другие языки — скоро';
});
for (const a of Array.from(document.querySelectorAll('.cfoot a'))) {
  a.addEventListener('click', () => {
    statusEl.textContent = `${(a.textContent ?? '').trim()} — скоро`;
  });
}

// hub interactions
$('hub-play').addEventListener('click', () => hubTab('games'));
$('hub-solo').addEventListener('click', () => {
  showHub(false);
  openSetup('hub');
});
$('hub-msg').addEventListener('click', () => {
  hubNote.textContent = 'Сообщения — скоро';
});
$('hub-logout').addEventListener('click', () => {
  showHub(false);
  showConnect(true);
  showStage('welcome');
});
for (const b of Array.from(document.querySelectorAll('.hub-tab'))) {
  b.addEventListener('click', () => hubTab((b as HTMLElement).dataset.hub ?? 'home'));
}
for (const t of Array.from(document.querySelectorAll('#hp-more .hub-tile[data-more]'))) {
  t.addEventListener('click', () => {
    hubNote.textContent = `${(t as HTMLElement).dataset.more} — скоро`;
  });
}

// First-run gate: a returning commander (a saved callsign) skips the identity card
// and boots straight into the hub — the raw "Новый командир / войти" screen is only
// for a genuinely new device. "Сменить командира" in the hub goes back to identity.
if ((localStorage.getItem('void.nick') ?? '').trim()) openHub();

// --- single-player setup overlay --------------------------------------------
// Pick your homeworld on a mini-map and choose how many AI rivals join, then
// launch a fresh local match. Seat 1 is always you; seats 2-4 toggle AI/off.
// Switch every rival OFF for a solo sandbox — the core never ends a one-player
// match, so it's a peaceful space to read descriptions and learn the interface.
const setupEl = $('setup');
const setupMapEl = $('setupmap');
const setupSlotsEl = $('setupslots');
const setupSpeedEl = $('setupspeed');
const setupHintEl = $('setuphint');
const setupGoEl = $('setupgo') as HTMLButtonElement;
const setupDivEl = $('setup-div');
const setupHeroEl = $('setup-hero');
const setupShipEl = $('setup-ship');

// --- division designer (main-menu "Дивизии" tab) ----------------------------
// The player's 3 templates, composed before the match and LOCKED once it starts.
// Persisted across openSetup() so a design survives going Back; deep-cloned from the
// defaults so editing never mutates them.
const setupTemplates: FormationTemplate[] = DEFAULT_TEMPLATES.map((t) => ({
  name: t.name,
  slots: [...t.slots],
}));
let setupTplIdx = 0; // which of the 3 templates is open in the designer
const FORM_ICON: Record<string, string> = { infantry: '🪖', tank: '🛡', bomber: '✈', aa: '◎' };
const FORM_RU: Record<string, string> = { infantry: 'Пехота', tank: 'Танк', bomber: 'Бомбер', aa: 'ПВО' };

function renderTemplates(): void {
  const tabs = setupTemplates
    .map((t, i) => `<button data-tpl="${i}" class="${i === setupTplIdx ? 'on' : ''}">${esc(t.name)}</button>`)
    .join('');
  const tpl = setupTemplates[setupTplIdx]!;
  const slots = tpl.slots
    .map((u, i) => {
      const cls = u ? '' : 'empty';
      const ic = u ? FORM_ICON[u] : '＋';
      const nm = u ? FORM_RU[u] : 'пусто';
      return `<div class="tslot ${cls}" data-slot="${i}"><span class="ic">${ic}</span><span class="nm">${esc(nm)}</span></div>`;
    })
    .join('');
  const f = formationStats(tpl);
  const syn = f.synergies.length
    ? f.synergies.map((x) => `<span class="syn">◈ ${esc(x.name)} — ${esc(x.desc)}</span>`).join('')
    : `<span class="syn none">◇ Нет бонусов состава — смешай рода войск.</span>`;
  const cost = Object.entries(f.cost)
    .map(([r, a]) => `${a} ${r}`)
    .join(' · ');
  setupDivEl.innerHTML =
    `<p class="ssub">Собери 3 шаблона дивизий из 6 слотов. Состав даёт суммарные статы и бонусы; во время боя шаблоны не меняются. Тапни слот, чтобы сменить юнит.</p>` +
    `<div class="tpl-tabs">${tabs}</div>` +
    `<div class="tpl-slots">${slots}</div>` +
    `<div class="tpl-stats"><div class="row"><span>⚔ Атака ${f.attack}</span><span>🛡 Оборона ${f.defense}</span><span>❤ HP ${f.hp}</span><span>№ ${f.count}/${FORMATION_SLOTS}</span></div>${syn}<div class="tpl-cost">Стоимость мобилизации: ${cost || '—'}</div></div>`;
}

/** Cycle a slot through: пусто → пехота → танк → бомбер → пусто. */
function cycleSlot(i: number): void {
  const tpl = setupTemplates[setupTplIdx];
  if (!tpl) return;
  const cur = tpl.slots[i] ?? null;
  const order: (FormationUnit | null)[] = [null, ...FORMATION_UNITS];
  const next = order[(order.indexOf(cur) + 1) % order.length] ?? null;
  tpl.slots[i] = next;
  renderTemplates();
}

setupDivEl.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-slot],[data-tpl]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.tpl !== undefined) {
    setupTplIdx = Number(t.dataset.tpl);
    renderTemplates();
  } else if (t.dataset.slot !== undefined) {
    cycleSlot(Number(t.dataset.slot));
  }
});
// --- hero designer (main-menu "Герои" tab) ----------------------------------
// The player's hero roster: up to 3 loadouts, each with HERO_SLOTS ability "modules"
// + the implicit base aura. Composed before the match (in-match capital/respawn/refit
// land in a later phase). Reuses the division designer's tab/slot/stats chrome.
const setupHeroes: HeroLoadout[] = DEFAULT_HEROES.map((h) => ({ name: h.name, grade: h.grade, abilities: [...h.abilities] }));
let setupHeroIdx = 0; // which hero is open in the designer
let heldModule: string | null = null; // the module on the "cursor" (grab → place, Minecraft-style)
const heldGhostEl = $('heldghost');

/** Put a module on the cursor (or clear with null); reflect it in the floating ghost. */
function setHeld(id: string | null, kind: 'hero' | 'ship' = 'hero'): void {
  heldModule = id;
  const icon =
    id == null ? '' : kind === 'ship' ? (SHIP_MODULES[id]?.icon ?? '') : (HERO_ABILITIES[id]?.icon ?? '');
  heldGhostEl.textContent = icon;
  heldGhostEl.style.display = icon ? 'block' : 'none';
}
/** Move the floating ghost to the pointer (called on grab + pointermove). */
function moveGhost(x: number, y: number): void {
  heldGhostEl.style.left = `${x}px`;
  heldGhostEl.style.top = `${y}px`;
}

/** The hero's display name — the главный hero shows the player's callsign (nick). */
function heroName(h: HeroLoadout): string {
  return h.grade === 'main' ? nickInput.value.trim() || h.name : h.name;
}

function renderHeroes(): void {
  const tabs = setupHeroes
    .map((h, i) => `<button data-hero="${i}" class="${i === setupHeroIdx ? 'on' : ''}">${HERO_GRADES[h.grade].icon} ${esc(heroName(h))}</button>`)
    .join('');
  const hero = setupHeroes[setupHeroIdx]!;
  const grade = HERO_GRADES[hero.grade];
  const slots = heroSlots(hero.grade);
  const holding = heldModule != null;
  // Equip "bays" — one per grade slot; the drop targets while a module is held.
  const bays = Array.from({ length: slots }, (_, i) => {
    const id = hero.abilities[i] ?? null;
    const ab = id ? HERO_ABILITIES[id] : undefined;
    return `<div class="tslot ${ab ? '' : 'empty'} ${holding ? 'drop' : ''}" data-aslot="${i}"><span class="ic">${ab ? ab.icon : '＋'}</span><span class="nm">${esc(ab ? ab.name : 'пусто')}</span></div>`;
  }).join('');
  const info = heroLoadoutInfo(hero);
  const syn = info.abilities.length
    ? info.abilities
        .map((a) => `<span class="syn">${a.icon} ${esc(a.name)} — ${esc(a.desc)}${a.live ? '' : ' <em>(скоро)</em>'}</span>`)
        .join('')
    : `<span class="syn none">◇ Слоты пусты — возьми модуль из инвентаря ниже.</span>`;
  // Module "inventory" grid — tap a cell to grab it onto the cursor, then tap a hero slot.
  const equipped = new Set(hero.abilities.slice(0, slots).filter(Boolean) as string[]);
  const inv = HERO_ABILITY_IDS.map((id) => {
    const a = HERO_ABILITIES[id]!;
    const cls = `${equipped.has(id) ? 'equip' : ''} ${heldModule === id ? 'held' : ''} ${a.live ? '' : 'planned'}`;
    return `<div class="mcell ${cls}" data-abil="${id}"><span class="ic">${a.icon}</span><span class="nm">${esc(a.name)}</span>${equipped.has(id) ? '<span class="badge">✓</span>' : ''}</div>`;
  }).join('');
  const heldA = heldModule ? HERO_ABILITIES[heldModule] : undefined;
  const heldBar = heldA
    ? `<div class="mheld active" data-drop="1">В руке: ${heldA.icon} <b>${esc(heldA.name)}</b> — тапни слот героя · <em>(тап сюда — убрать)</em></div>`
    : `<div class="mheld">Возьми модуль из инвентаря и тапни слот героя. Тап по занятому слоту — снять модуль.</div>`;
  setupHeroEl.innerHTML =
    `<p class="ssub">${HERO_ROSTER_COUNT} героя: главный (имя = твой ник) + по одному грейду. Грейд задаёт число слотов под модули (обычный ${HERO_GRADES.common.slots} · редкий ${HERO_GRADES.rare.slots} · легендарный ${HERO_GRADES.legendary.slots} · главный ${HERO_GRADES.main.slots}) + базовая аура (+5% бой флоту). Бери модуль из инвентаря и вставляй в слот. В матче меняется в столице.</p>` +
    `<div class="tpl-tabs">${tabs}</div>` +
    `<div class="hgradeline g-${hero.grade}">${grade.icon} ${esc(grade.name)} · ${slots} ${slots === 1 ? 'слот' : 'слота'} под модули</div>` +
    `<div class="tpl-slots heroslots" style="grid-template-columns:repeat(${Math.min(slots, 4)},1fr)">${bays}</div>` +
    `<div class="tpl-stats"><div class="row"><span>★ Модули ${info.count}/${slots}</span><span>✦ Аура +5%</span></div>${syn}</div>` +
    heldBar +
    `<div class="hpal-h">Инвентарь модулей</div><div class="minv">${inv}</div>`;
}

/** Tap a hero slot: place the held module (swapping out any current one onto the
 *  cursor), or — empty-handed — pick the slot's module up. No duplicate module per hero. */
function tapHeroSlot(i: number): void {
  const hero = setupHeroes[setupHeroIdx];
  if (!hero) return;
  if (heldModule == null) {
    const cur = hero.abilities[i];
    if (cur != null) {
      hero.abilities[i] = null;
      setHeld(cur);
    }
  } else if (!hero.abilities.some((a, j) => j !== i && a === heldModule)) {
    const prev = hero.abilities[i] ?? null;
    hero.abilities[i] = heldModule;
    setHeld(prev); // swap: now holding what the slot had (null = hand emptied)
  }
  renderHeroes();
}

setupHeroEl.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-aslot],[data-hero],[data-abil],[data-drop]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.hero !== undefined) {
    setupHeroIdx = Number(t.dataset.hero);
    renderHeroes();
  } else if (t.dataset.drop !== undefined) {
    setHeld(null); // drop the held module back to the inventory
    renderHeroes();
  } else if (t.dataset.aslot !== undefined) {
    tapHeroSlot(Number(t.dataset.aslot));
  } else if (t.dataset.abil !== undefined) {
    setHeld(heldModule === t.dataset.abil ? null : t.dataset.abil); // grab a copy (tap again = drop)
    moveGhost(ev.clientX, ev.clientY);
    renderHeroes();
  }
});

// --- shipyard designer (main-menu "Верфь" tab) ------------------------------
// The player's ship blueprints: a module loadout per hull class, frozen at session
// start (GDD §2). Reuses the SAME Minecraft-inventory fitting chrome as heroes — but
// ship modules STACK (no per-loadout duplicate guard), and the stat preview is derived
// from the hull's base unit stats. Effects reach combat in a later brick (SHIP-3).
const setupShips: ShipLoadout[] = DEFAULT_SHIP_LOADOUTS.map((l) => ({ hull: l.hull, modules: [...l.modules] }));
let setupShipIdx = 0;

function renderShips(): void {
  const tabs = setupShips
    .map((l, i) => `<button data-hull="${i}" class="${i === setupShipIdx ? 'on' : ''}">${SHIP_HULLS[l.hull]?.icon ?? '▦'} ${esc(SHIP_HULLS[l.hull]?.name ?? l.hull)}</button>`)
    .join('');
  const loadout = setupShips[setupShipIdx]!;
  const hull = SHIP_HULLS[loadout.hull];
  const slots = hullSlots(loadout.hull);
  const holding = heldModule != null;
  const bays = Array.from({ length: slots }, (_, i) => {
    const id = loadout.modules[i] ?? null;
    const m = id ? SHIP_MODULES[id] : undefined;
    return `<div class="tslot ${m ? '' : 'empty'} ${holding ? 'drop' : ''}" data-mslot="${i}"><span class="ic">${m ? m.icon : '＋'}</span><span class="nm">${esc(m ? m.name : 'пусто')}</span></div>`;
  }).join('');
  const baseUnit = hull ? data.units[hull.base] : undefined;
  const base = {
    attack: baseUnit?.stats.attack ?? 0,
    defense: baseUnit?.stats.defense ?? 0,
    speed: baseUnit?.stats.speed ?? 0,
    hp: baseUnit?.stats.hp ?? 0,
  };
  const der = shipStats(base, loadout);
  const stat = (label: string, b: number, d: number): string =>
    `<span>${label} ${d}${d !== b ? ` <em>(${b})</em>` : ''}</span>`;
  const info = shipLoadoutInfo(loadout);
  const syn = info.modules.length
    ? info.modules
        .map((m) => `<span class="syn">${m.icon} ${esc(m.name)} — ${esc(m.desc)}${m.live ? '' : ' <em>(скоро)</em>'}</span>`)
        .join('')
    : `<span class="syn none">◇ Слоты пусты — возьми модуль из инвентаря ниже.</span>`;
  const inv = SHIP_MODULE_IDS.map((id) => {
    const m = SHIP_MODULES[id]!;
    const cls = `${heldModule === id ? 'held' : ''} ${m.live ? '' : 'planned'}`;
    return `<div class="mcell ${cls}" data-smod="${id}"><span class="ic">${m.icon}</span><span class="nm">${esc(m.name)}</span></div>`;
  }).join('');
  const heldM = heldModule ? SHIP_MODULES[heldModule] : undefined;
  const heldBar = heldM
    ? `<div class="mheld active" data-drop="1">В руке: ${heldM.icon} <b>${esc(heldM.name)}</b> — тапни слот корпуса · <em>(тап сюда — убрать)</em></div>`
    : `<div class="mheld">Возьми модуль из инвентаря и вставь в слот корпуса. Модули стэкаются. Тап по слоту — снять.</div>`;
  setupShipEl.innerHTML =
    `<p class="ssub">Чертёж корабля: на класс корпуса навешиваешь модули в слоты (крейсер ${hullSlots('cruiser')} · осадная ${hullSlots('siege_lance')} · скаут ${hullSlots('scout_drone')} · десантный ${hullSlots('dropship')}). Модули стэкаются и меняют статы. На старте матча чертёж замораживается. <em>(статы — превью; бой их читает скоро)</em></p>` +
    `<div class="tpl-tabs">${tabs}</div>` +
    `<div class="hgradeline">${hull?.icon ?? '▦'} ${esc(hull?.name ?? loadout.hull)} · ${slots} ${slots === 1 ? 'слот' : 'слота'} под модули</div>` +
    `<div class="tpl-slots" style="display:grid;gap:8px;margin-bottom:10px;grid-template-columns:repeat(${Math.min(slots, 4)},1fr)">${bays}</div>` +
    `<div class="tpl-stats"><div class="row">${stat('⚔ Атака', base.attack, der.attack)}${stat('🛡 Оборона', base.defense, der.defense)}${stat('» Скор', base.speed, der.speed)}${stat('❤ HP', base.hp, der.hp)}</div>${syn}</div>` +
    heldBar +
    `<div class="hpal-h">Инвентарь модулей</div><div class="minv">${inv}</div>`;
}

/** Tap a hull slot: place the held module (swapping out any current one), or — empty-
 *  handed — pick the slot's module up. Ship modules STACK, so no duplicate guard. */
function tapShipSlot(i: number): void {
  const loadout = setupShips[setupShipIdx];
  if (!loadout) return;
  if (heldModule == null) {
    const cur = loadout.modules[i];
    if (cur != null) {
      loadout.modules[i] = null;
      setHeld(cur, 'ship');
    }
  } else {
    const prev = loadout.modules[i] ?? null;
    loadout.modules[i] = heldModule;
    setHeld(prev, 'ship'); // swap (null = hand emptied)
  }
  renderShips();
}

setupShipEl.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-mslot],[data-hull],[data-smod],[data-drop]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.hull !== undefined) {
    setupShipIdx = Number(t.dataset.hull);
    renderShips();
  } else if (t.dataset.drop !== undefined) {
    setHeld(null);
    renderShips();
  } else if (t.dataset.mslot !== undefined) {
    tapShipSlot(Number(t.dataset.mslot));
  } else if (t.dataset.smod !== undefined) {
    setHeld(heldModule === t.dataset.smod ? null : t.dataset.smod, 'ship'); // grab (tap again = drop)
    moveGhost(ev.clientX, ev.clientY);
    renderShips();
  }
});

// The held module's ghost trails the pointer while carried (desktop hover; on touch it
// sits where you grabbed it). Bound to the setup overlay — never to `document`.
setupEl.addEventListener('pointermove', (ev) => {
  if (heldModule != null) moveGhost(ev.clientX, ev.clientY);
});

// Setup tab switch (Старт ↔ Дивизии ↔ Герои).
document.querySelector('#setup .stabs')?.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-stab]') as HTMLElement | null;
  if (!t) return;
  const tab = t.dataset.stab;
  document.querySelectorAll('#setup .stabs button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.stab === tab));
  $('setup-start').style.display = tab === 'start' ? '' : 'none';
  setupDivEl.style.display = tab === 'div' ? '' : 'none';
  setupHeroEl.style.display = tab === 'hero' ? '' : 'none';
  setupShipEl.style.display = tab === 'ship' ? '' : 'none';
  setHeld(null); // a held module never crosses a tab switch (hero ↔ ship pools differ)
  if (tab === 'div') renderTemplates();
  if (tab === 'hero') renderHeroes();
  if (tab === 'ship') renderShips();
});

function renderSetupMap(): void {
  const pad = 60;
  setupMapEl.setAttribute(
    'viewBox',
    `${MINX - pad} ${MINY - pad} ${MAXX - MINX + pad * 2} ${MAXY - MINY + pad * 2}`,
  );
  const cand = new Set(START_CANDIDATES);
  const byId = new Map(MAP.map((n) => [n.id, n]));
  let svg = '';
  for (const n of MAP) {
    for (const l of n.links) {
      const m = byId.get(l);
      if (!m || m.id < n.id) continue; // draw each undirected edge once
      svg += `<line x1="${n.x}" y1="${n.y}" x2="${m.x}" y2="${m.y}" stroke="#1d3640" stroke-width="3"/>`;
    }
  }
  for (const n of MAP) {
    if (cand.has(n.id)) continue; // candidates drawn last, on top
    const planet = n.sector === 'planet';
    svg += `<circle cx="${n.x}" cy="${n.y}" r="${planet ? 16 : 11}" fill="${planet ? '#2c5460' : '#1b2d34'}" stroke="#33555f" stroke-width="2"/>`;
  }
  for (const id of START_CANDIDATES) {
    const n = byId.get(id);
    if (!n) continue;
    const picked = id === setupStart;
    svg +=
      `<circle class="cand" data-cand="${id}" cx="${n.x}" cy="${n.y}" r="${picked ? 30 : 22}" ` +
      `fill="${picked ? 'rgba(58,209,122,.35)' : 'rgba(53,214,230,.16)'}" ` +
      `stroke="${picked ? '#3ad17a' : '#35d6e6'}" stroke-width="${picked ? 6 : 4}"/>`;
  }
  setupMapEl.innerHTML = svg;
}

function renderSetupSlots(): void {
  let h = '';
  for (let i = 0; i < SEAT_META.length; i++) {
    const m = SEAT_META[i]!;
    const role = setupSlots[i]!;
    if (i === 0) {
      h +=
        `<div class="srow"><span class="dot" style="background:${m.color};color:${m.color}"></span>` +
        `<span class="nm">${esc(m.name)}</span><span class="you">YOU</span></div>`;
    } else {
      const aiOn = role === 'ai';
      h +=
        `<div class="srow ${aiOn ? '' : 'off'}"><span class="dot" style="background:${m.color};color:${m.color}"></span>` +
        `<span class="nm">${esc(m.name)}</span>` +
        `<button class="stog ${aiOn ? 'ai' : ''}" data-slot="${i}">${aiOn ? 'AI' : 'OFF'}</button></div>`;
    }
  }
  setupSlotsEl.innerHTML = h;
}

function renderSetup(): void {
  renderSetupMap();
  renderSetupSlots();
  // Seat 1 (you) is always in, so the match can always launch — including with ZERO
  // rivals: a calm solo sandbox to read descriptions, learn the UI and test in peace
  // (the core never ends a one-player match — victory needs ≥2 active sides).
  const rivals = setupSlots.slice(1).filter((r) => r === 'ai').length;
  setupGoEl.disabled = false;
  setupGoEl.textContent = rivals === 0 ? 'LAUNCH SOLO' : 'LAUNCH';
  setupHintEl.textContent =
    rivals === 0
      ? `Home: ${setupStart} — solo sandbox, no rivals · tap a glowing world to change`
      : `Home: ${setupStart} — tap another glowing world to change`;
  for (const c of Array.from(setupSpeedEl.querySelectorAll('[data-spd]')))
    c.classList.toggle('on', Number((c as HTMLElement).dataset.spd) === setupSpeed);
}

// Where the Setup screen's Back button returns to — the surface that opened it, so
// arriving from the hub goes back to the hub, not the raw identity card.
let setupReturn: 'welcome' | 'hub' = 'welcome';
function openSetup(from: 'welcome' | 'hub' = 'welcome'): void {
  setupReturn = from;
  setupSlots = ['human', 'ai', 'off', 'off'];
  setupStart = START_CANDIDATES[0] ?? MAP[0]!.id;
  setupSpeed = 1; // default to normal time flow each time the setup opens
  showConnect(false);
  setupEl.style.display = 'flex';
  // Always open on the Старт tab (the division designer keeps its own state).
  document.querySelectorAll('#setup .stabs button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.stab === 'start'));
  $('setup-start').style.display = '';
  setupDivEl.style.display = 'none';
  setupHeroEl.style.display = 'none';
  setupShipEl.style.display = 'none';
  setHeld(null);
  renderSetup();
}

function buildSetupConfig(): SetupConfig {
  const seats: SeatConfig[] = [
    { id: SEAT_META[0]!.id, name: SEAT_META[0]!.name, faction: SEAT_META[0]!.faction, start: setupStart, ai: false },
  ];
  // Hand each active AI seat one of the remaining candidate worlds, in order.
  const free = START_CANDIDATES.filter((c) => c !== setupStart);
  let fi = 0;
  for (let i = 1; i < SEAT_META.length; i++) {
    if (setupSlots[i] !== 'ai') continue;
    const start = free[fi++];
    if (!start) break; // ran out of candidate worlds
    const m = SEAT_META[i]!;
    seats.push({ id: m.id, name: m.name, faction: m.faction, start, ai: true });
  }
  // Carry the player's division templates + hero roster into the match (deep-cloned).
  return {
    seats,
    templates: setupTemplates.map((t) => ({ name: t.name, slots: [...t.slots] })),
    heroes: setupHeroes.map((h) => ({ name: heroName(h), grade: h.grade, abilities: [...h.abilities] })),
    ships: setupShips.map((l) => ({ hull: l.hull, modules: [...l.modules] })),
  };
}

// Install a ready GameState as the live match: reset all interaction state, queues,
// camera and log, then hide the setup overlay. `aiPlayers` are the seats the local
// sim drives. Shared by the normal skirmish and (via a hook) the dev test mode.
function installMatch(state: GameState, aiPlayers: Set<string>): void {
  s = state;
  ME = 'p1';
  AI_PLAYERS = aiPlayers;
  lastAiAt = s.time;
  // Reset interaction + queues + camera to the framed whole-map view.
  selFleet = null;
  selPlanet = null;
  selFleets = new Set();
  pendingMerges = [];
  pendingLoads = [];
  aiming = false;
  merging = false;
  additive = false;
  splitState = null;
  killStats = { destroyed: 0, lost: 0 };
  myBattleLocs.clear();
  logLines.length = 0; // fresh log — drop notes from the menu-background match
  banner = null; // clear any end-banner left by the menu-background match (else it sticks)
  for (const k of Object.keys(buildQueues)) delete buildQueues[k];
  defaultView(); // phone: zoom onto home; desktop: whole-map fit
  setupEl.style.display = 'none';
}
function startMatch(setup: SetupConfig): void {
  installMatch(newGame(setup), new Set(setup.seats.filter((x) => x.ai).map((x) => x.id)));
  applyTimeSpeed(setupSpeed); // launch running at the chosen time-flow multiplier
}

setupMapEl.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-cand]');
  if (!t) return;
  setupStart = t.getAttribute('data-cand')!;
  renderSetup();
});
setupSlotsEl.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-slot]');
  if (!t) return;
  const i = Number(t.getAttribute('data-slot'));
  setupSlots[i] = setupSlots[i] === 'ai' ? 'off' : 'ai';
  renderSetup();
});
setupSpeedEl.addEventListener('click', (ev) => {
  const t = (ev.target as Element).closest('[data-spd]');
  if (!t) return;
  setupSpeed = Number(t.getAttribute('data-spd'));
  renderSetup();
});
setupGoEl.addEventListener('click', () => startMatch(buildSetupConfig()));
$('setupcancel').addEventListener('click', () => {
  setupEl.style.display = 'none';
  if (setupReturn === 'hub') openHub();
  else showConnect(true);
});

function connect(): void {
  const srv = resolveServer();
  if (!srv) return;
  const { base, nick } = srv;
  // Nick-login: the server maps this name → a fixed side and hands it back, so we
  // learn our seat from the welcome (snap.playerId), not from a side picker.
  const url = `${base}/matches/${encodeURIComponent(currentMatchId)}?nick=${encodeURIComponent(nick)}`;
  statusEl.textContent = `Подключение: ${nick}…`;
  localStorage.setItem('void.server', base);
  localStorage.setItem('void.nick', nick); // resume this seat next visit

  // WS "open" only means the socket connected, not that the server admitted us — it
  // may still reject (slot taken / unknown player). Flip to "in the match" only on
  // the first welcome snapshot, so a rejected join never flashes the map.
  let admitted = false;
  if (netSock) netSock.close();
  const sock = (netSock = new WebSocket(url));
  const client = (netClient = new MultiplayerClient(
    { send: (d: string) => sock.send(d), close: () => sock.close() },
    {
      onStatus: () => {
        // Intentionally no-op on "open": admission is confirmed by the first
        // welcome snapshot (see onSnapshot), not by the socket opening.
      },
      onPong: (_serverTime, clientTime) => {
        if (clientTime === undefined) return;
        const rtt = performance.now() - clientTime;
        rttEma = rttEma === null ? rtt : rttEma * 0.7 + rtt * 0.3;
      },
      onSnapshot: (snap) => {
        if (sock !== netSock) return; // a superseded socket must not touch globals
        if (!admitted) {
          // Server accepted us — NOW we're really in the match.
          admitted = true;
          reconnecting = false; // a fresh welcome ends any reconnect cycle
          reconnectAttempts = 0;
          if (banner && banner.startsWith('⟳')) banner = null;
          NET = true;
          ME = snap.playerId ?? ME;
          clearSelection();
          pendingLoads = []; // drop any queued loads from a prior/local session
          showConnect(false);
          note(`● connected as ${NAME[ME] ?? ME}`);
          // Latency probe: ping every 2s with a client timestamp the pong echoes.
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = setInterval(() => client.ping(performance.now()), 2000);
          client.ping(performance.now()); // seed an RTT reading immediately
        }
        s = snap.state;
        if (snap.playerId) ME = snap.playerId;
        // Desync check (M0): the server tags each snapshot with hashState(view); we
        // hash our just-reconstructed view and compare. Mismatch ⇒ the client and
        // server disagree — the core invariant we most want to catch on a playtest.
        if (snap.hash !== undefined) {
          netDesync = hashState(snap.state) !== snap.hash;
          if (netDesync) netDesyncCount++;
        }
        // mirror apply()'s selection cleanup (we replace `s` directly here)
        if (selFleet && !s.fleets[selFleet]) selFleet = null;
        selFleets = new Set([...selFleets].filter((id) => s.fleets[id]?.owner === ME));
        // Lobby roster (manual-start). The lobby overlay (renderLobby) supersedes the
        // old "⏳ waiting" banner; fall back to the banner only if no roster is sent.
        lobbyInfo = snap.lobby ?? null;
        if (!lobbyInfo && snap.waiting) {
          banner = `⏳ Waiting for ${NAME[ME === 'p1' ? 'p2' : 'p1']} to join…`;
        } else if (banner && banner.startsWith('⏳')) {
          banner = null;
        }
        lastPanelHtml = '';
      },
      onRejection: (_id, code) =>
        note('✖ ' + code.replace(/^E_/, '').toLowerCase().replace(/_/g, ' ')),
      // Server-relayed ally pings (own + allies, hidden from enemies): merge them into
      // the coalition channel so they render as map markers + chat lines, same as solo.
      onPingAdded: (ping: MultiplayerPing) => {
        const node = ping.target.node;
        if (!node) return; // prototype markers are province-anchored
        if (sessionMessages.some((m) => m.pingId === ping.id)) return; // dedup the echo
        sessionMessages.push({
          at: ping.createdAt,
          from: ping.owner,
          to: COALITION,
          text: ping.label ?? `метка ${node}`,
          sys: false,
          ping: node,
          pingId: ping.id,
          realAt: Date.now(),
        });
        if (diploOpen && diploTab === 'msgs') renderDiploFeed();
        if (chatOpen && !chatMin) renderChatFeed();
      },
      onPingRemoved: (pingId: string) => {
        sessionMessages = sessionMessages.filter((m) => m.pingId !== pingId);
        closePingPop();
        if (diploOpen && diploTab === 'msgs') renderDiploFeed();
      },
      onError: (code) => {
        if (sock !== netSock) return; // ignore errors from a superseded socket
        if (!admitted && code === 'E_SLOT_TAKEN') {
          statusEl.textContent = 'that name is already playing (another tab or device?)';
        } else if (!admitted && code === 'E_UNKNOWN_PLAYER') {
          statusEl.textContent = 'could not get a seat';
        } else {
          statusEl.textContent = 'error: ' + code;
        }
      },
    },
  ));
  sock.onopen = () => client.open();
  sock.onmessage = (ev) => client.receive(String(ev.data));
  sock.onclose = () => {
    // A superseded socket (the user clicked Connect again) must NOT tear down the
    // fresh session — its late close would kill the new socket's ping timer and
    // pop the overlay back over a healthy connection.
    if (sock !== netSock) return;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    rttEma = null;
    if (NET) {
      NET = false;
      lobbyInfo = null; // drop the lobby overlay if we were still in it
      if (userClosed) {
        statusEl.textContent = 'disconnected';
        note('● disconnected from server');
        showConnect(true);
      } else {
        // unexpected drop → auto-rejoin our seat (the match keeps running server-side)
        note('● connection lost — reconnecting…');
        reconnecting = true;
        scheduleReconnect();
      }
    } else if (reconnecting && !admitted) {
      scheduleReconnect(); // a reconnect attempt failed to admit → back off and retry
    }
    // If we were never admitted (a normal rejected join), leave the rejection
    // message in the status line; the overlay is already showing.
  };
  sock.onerror = () => {
    if (sock !== netSock) return; // ignore errors from a superseded socket
    statusEl.textContent = 'connection failed — is the server running / URL right?';
  };
}

// --- match browser (the meta-shell "Play" tab) -------------------------------
// Reads the server's read-model (`GET /matches?nick=`) into three tabs and joins /
// archives a chosen match. Meta lives on the server (no menu state in GameState).

/** Normalize the pasted server box to a ws(s):// ORIGIN + read the nick. Returns
 *  null (and sets the status line) when either is missing/invalid. Shared by the
 *  match browser and `connect()`. */
function resolveServer(): { base: string; nick: string } | null {
  let raw = srvInput.value.trim();
  if (!raw) {
    statusEl.textContent = 'Укажи адрес сервера';
    return null;
  }
  // Accept http(s)://, ws(s)://, or a bare host:port and normalize. Kills three
  // silent failures: https page + ws:// (mixed content) → wss://; a pasted /matches
  // path → 404; a bare host with no scheme can't open.
  raw = raw.replace(/^http(s?):\/\//i, 'ws$1://');
  if (!/^wss?:\/\//i.test(raw)) {
    raw = (location.protocol === 'https:' ? 'wss://' : 'ws://') + raw;
  }
  if (location.protocol === 'https:' && raw.startsWith('ws://')) {
    raw = 'wss://' + raw.slice('ws://'.length);
  }
  let base: string;
  try {
    base = `${new URL(raw).protocol}//${new URL(raw).host}`; // drop any path/query
  } catch {
    statusEl.textContent = 'Неверный адрес сервера';
    return null;
  }
  const nick = nickInput.value.trim();
  if (!nick) {
    statusEl.textContent = 'Введи позывной';
    return null;
  }
  return { base, nick };
}

const httpBase = (wsBase: string): string => wsBase.replace(/^ws/, 'http');

interface MatchRow {
  matchId: string;
  mapId: string;
  rules: { timeScale?: number; victory?: { dominationPercent?: number; scoreLimit?: number } };
  days: number;
  players: { seated: number; capacity: number };
  status: string;
}
type MatchTab = 'available' | 'active' | 'archived';
let matchLists: Record<MatchTab, MatchRow[]> | null = null;
let activeTab: MatchTab = 'available';

function ruleSummary(r: MatchRow['rules']): string {
  const parts = [`×${r.timeScale ?? 1}`];
  if (r.victory?.scoreLimit) parts.push(`до ${r.victory.scoreLimit} очк.`);
  if (r.victory?.dominationPercent) parts.push(`${Math.round(r.victory.dominationPercent * 100)}% карты`);
  return parts.join(' · ');
}

/** Join a chosen match: set it as the (re)connect target, then dial via `connect()`. */
function connectToMatch(id: string): void {
  currentMatchId = id;
  reconnecting = false;
  reconnectAttempts = 0;
  userClosed = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

async function refreshMatches(): Promise<void> {
  const srv = resolveServer();
  if (!srv) return;
  statusEl.textContent = 'загрузка матчей…';
  try {
    const res = await fetch(`${httpBase(srv.base)}/matches?nick=${encodeURIComponent(srv.nick)}`);
    if (!res.ok) throw new Error('http ' + res.status);
    matchLists = (await res.json()) as Record<MatchTab, MatchRow[]>;
    localStorage.setItem('void.server', srv.base);
    localStorage.setItem('void.nick', srv.nick);
    statusEl.textContent = '';
  } catch {
    matchLists = null;
    statusEl.textContent = 'сервер недоступен';
  }
  renderMatches();
}

async function toggleArchive(id: string, restore: boolean): Promise<void> {
  const srv = resolveServer();
  if (!srv) return;
  const op = restore ? 'unarchive' : 'archive';
  try {
    const res = await fetch(
      `${httpBase(srv.base)}/matches/${encodeURIComponent(id)}/${op}?nick=${encodeURIComponent(srv.nick)}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      statusEl.textContent = restore ? 'не удалось восстановить' : 'не удалось в архив';
      return;
    }
    await refreshMatches();
  } catch {
    statusEl.textContent = 'ошибка архива';
  }
}

function renderMatches(): void {
  const el = $('mlist');
  if (!matchLists) {
    el.innerHTML = '<div class="mempty">нажмите «Обновить список»</div>';
    return;
  }
  const rows = matchLists[activeTab] ?? [];
  if (rows.length === 0) {
    el.innerHTML = '<div class="mempty">пусто</div>';
    return;
  }
  el.textContent = '';
  for (const m of rows) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const info = document.createElement('div');
    info.className = 'minfo';
    info.innerHTML =
      `<div class="mname">${esc(m.mapId)} <span class="mid">${esc(m.matchId)}</span></div>` +
      `<div class="mmeta">День ${m.days} · ${m.players.seated}/${m.players.capacity} игроков · ` +
      `${esc(ruleSummary(m.rules))} · ${m.status === 'ended' ? 'завершён' : 'идёт'}</div>`;
    row.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'mbtns';
    const join = document.createElement('button');
    join.className = 'mbtn';
    join.textContent = 'Войти';
    join.addEventListener('click', () => connectToMatch(m.matchId));
    btns.appendChild(join);
    if (activeTab !== 'available') {
      const restore = activeTab === 'archived';
      const arch = document.createElement('button');
      arch.className = 'mbtn ghost';
      arch.textContent = restore ? 'Восстановить' : 'В архив';
      arch.addEventListener('click', () => void toggleArchive(m.matchId, restore));
      btns.appendChild(arch);
    }
    row.appendChild(btns);
    el.appendChild(row);
  }
}

for (const btn of Array.from(document.querySelectorAll('.mtab'))) {
  btn.addEventListener('click', () => {
    activeTab = ((btn as HTMLElement).dataset.tab as MatchTab) ?? 'available';
    for (const b of Array.from(document.querySelectorAll('.mtab'))) {
      b.classList.toggle('active', b === btn);
    }
    renderMatches();
  });
}

// "Обновить список" reloads the read-model; per-row "Войти"/"В архив" act on a match.
$('cgo').addEventListener('click', () => void refreshMatches());

// The match browser (stage 2) loads its list on entry — "Новый командир" / "Вход"
// call refreshMatches() themselves; nothing to prefetch while the clean welcome is up.

// Auto-reconnect after an unexpected drop: rejoin our seat with capped exponential
// backoff (1,2,4,8,8,8s, then give up). Same saved server + nick → same side.
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > 6) {
    reconnecting = false;
    reconnectAttempts = 0;
    banner = null;
    statusEl.textContent = 'Переподключение не удалось — войди заново';
    showConnect(true);
    return;
  }
  banner = '⟳ переподключение…';
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 8000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(); // reuse the saved server + nick; don't reset the attempt counter
  }, delay);
}

// --- lobby overlay (manual-start) -------------------------------------------
// Pre-match staging screen: shows every side with its connection status, marks the
// host + you, and gives the host a Start button. The world clock stays frozen
// (server-side) until the host presses it.
const lobbyEl = $('lobby');
const lrosterEl = $('lroster');
const lactionsEl = $('lactions');
let lastLobbyHtml = '';
// One delegated handler: the host's Start button asks the server to begin.
lactionsEl.addEventListener('click', (e) => {
  if ((e.target as HTMLElement | null)?.id === 'lstart') netClient?.start();
});
function renderLobby(): void {
  const info = lobbyInfo;
  if (!info || info.started) {
    if (lobbyEl.style.display === 'flex') {
      lobbyEl.style.display = 'none';
      lastLobbyHtml = '';
    }
    return;
  }
  const rosterHtml = Object.keys(s.players)
    .map((id) => {
      const on = info.connected.includes(id);
      const color = COLOR[id] ?? COLOR.null;
      const badges =
        (id === ME ? '<span class="me">YOU</span>' : '') +
        (id === info.host ? '<span class="host">HOST</span>' : '');
      return `<div class="lrow ${on ? '' : 'off'}"><span class="dot" style="background:${color};color:${color}"></span><span class="nm">${esc(NAME[id] ?? id)}</span>${badges}<span style="font-size:10px;opacity:.75">${on ? 'connected' : 'waiting'}</span></div>`;
    })
    .join('');
  const actionsHtml =
    ME === info.host
      ? '<button id="lstart" class="lbtn">▶ START MATCH</button>'
      : '<div class="lwait">Waiting for the host to start…</div>';
  const html = rosterHtml + '|' + actionsHtml;
  if (html !== lastLobbyHtml) {
    lrosterEl.innerHTML = rosterHtml;
    lactionsEl.innerHTML = actionsHtml;
    lastLobbyHtml = html;
  }
  if (lobbyEl.style.display !== 'flex') lobbyEl.style.display = 'flex';
}

// --- loop --------------------------------------------------------------------

const fpsEl = $('fps');
let fpsEma = 60; // smoothed frames-per-second readout
let lastFpsText = '';
let lastTechAt = 0; // throttle for live re-rendering the tech window while it's open
let lastReal = performance.now();
// Build tag for the dev overlay so the RUNNING build is always visible in-game (not just
// on the welcome screen) — makes "am I on the latest APK?" answerable at a glance. Empty
// in the browser / dev build (no baked __BUILD__).
const BUILD_TAG = (() => {
  const b = currentBuild();
  return b ? buildLabel(b) : '';
})();
function frame(nowReal: number) {
  const dt = nowReal - lastReal;
  lastReal = nowReal;
  // smooth FPS; ignore absurd gaps (tab backgrounded) so the readout stays sane
  if (dt > 0 && dt < 1000) fpsEma = fpsEma * 0.9 + (1000 / dt) * 0.1;
  if (!NET && speed > 0 && !banner) {
    // Local single-player sim. In net mode the server owns the clock, combat,
    // construction and every rival — a connected human, or the server-side AI for
    // an empty seat — so we only render its snapshots (no local AI runs here).
    const target = s.time + (dt / 1000) * speed * HOUR;
    apply(advance(s, target));
    autoEngage();
    checkFleetClashes();
    runAI();
    pumpBuildQueues();
    closeIdleRallies(); // drop the 'rally' tag once a world's build pipeline empties
  }
  // The orbit spin only advances while the world is actually running (sim ticking, or a
  // live net match), so pausing freezes the ships on their rings instead of drifting on.
  if (dt > 0 && dt < 1000 && (NET || (speed > 0 && !banner))) orbitPhase += dt;
  pumpPendingLoads(); // fire ~1h cargo loads whose hour has elapsed (both modes)
  resolvePendingMerges(); // complete fleet merges whose movers have arrived
  checkEnd(); // terminal banner from `match` — runs in BOTH modes (net snapshots carry it)
  vision = computeVision(); // fog projection for this frame (always on)
  if (vision) updateMemory(vision.identify); // variant B: remember what we see
  render(nowReal);
  renderPanel();
  renderCmdBar();
  renderSplitDialog();
  renderLobby();
  // Status strip below the top bar: day/time + victory progress, plus the donate currency
  // (Суверены ◆) pushed to the right end — it sits one level down, directly under the
  // resource bar, instead of crowding the six session-resource chips. (World/fleet counts
  // moved to the player card — tap the crest in the top-left corner.)
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  const min = floor((s.time % HOUR) / 60000);
  const score = Math.round(s.match?.scores?.[ME]?.total ?? 0);
  const need = Math.max(0, SCORE_LIMIT - score);
  const statusHtml =
    `<span id="clock">Day ${d} · ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}</span>` +
    `<span class="dstat${need === 0 ? ' win' : ''}">✦ ${score}/${SCORE_LIMIT}${need === 0 ? ' · ★ WIN' : ' · ' + need + ' to win'}</span>` +
    `<span class="dl-donate" title="Суверены — donate currency"><i>◆</i>${kfmt(SOVEREIGNS)}</span>`;
  if (statusHtml !== lastClockText) {
    devlineEl.innerHTML = statusHtml;
    lastClockText = statusHtml;
  }
  // Dev net overlay (M0): FPS always; when connected, append round-trip latency and
  // a desync flag (✓ in sync with the server, ✗ + running mismatch count if not).
  let fpsText = `${Math.round(fpsEma)} FPS`;
  if (NET) {
    const rtt = rttEma === null ? '· · ms' : `${Math.round(rttEma)} ms`;
    const sync = netDesync ? `desync ✗ ${netDesyncCount}` : 'sync ✓';
    fpsText += ` · ${rtt} · ${sync}`;
  }
  if (BUILD_TAG) fpsText += ` · ${BUILD_TAG}`; // running build, always visible
  if (fpsText !== lastFpsText) {
    fpsEl.textContent = fpsText;
    fpsEl.style.color = NET && netDesync ? 'var(--red, #ff5a4d)' : '';
    lastFpsText = fpsText;
  }
  // Top bar = the five session resources (icon + amount). The donate currency (Суверены ◆)
  // is rendered separately on the status line right under this bar (see statusHtml above).
  const r = s.players[ME]?.resources ?? {};
  // Monochrome line glyphs from the console's own icon family (no emoji variants, so
  // they render as text, not colour emoji). Name in `title` for hover/long-press.
  const chip = (icon: string, val: string, name: string) =>
    `<span class="res" title="${name}"><i>${icon}</i><b>${val}</b></span>`;
  const hudHtml =
    chip('¤', kfmt(r.credits ?? 0), 'Credits') +
    chip('❖', kfmt(r.food ?? 0), 'Food') +
    chip('⬢', kfmt(r.metal ?? 0), 'Metal') +
    chip('↯', kfmt(r.energy ?? 0), 'Energy') +
    chip('▦', kfmt(r.microelectronics ?? 0), 'Microelectronics');
  if (hudHtml !== lastHudHtml) {
    purse.innerHTML = hudHtml;
    lastHudHtml = hudHtml;
  }
  const battles = Object.keys(s.battles).length;
  const alertText = String(battles);
  if (alertText !== lastAlertText) {
    alertBadge.style.display = battles > 0 ? 'grid' : 'none';
    alertBadge.textContent = alertText;
    lastAlertText = alertText;
  }
  const logHtml = logLines.map((l) => `<div>${esc(l)}</div>`).join('');
  if (logHtml !== lastLogHtml) {
    logEl.innerHTML = logHtml;
    lastLogHtml = logHtml;
  }
  if (banner) {
    // On a genuine single-player match END, offer a restart straight from the banner
    // (back to bot selection). Net-status banners (reconnecting / waiting) get no button.
    const ended = !NET && s.match?.status === 'ended';
    const html = ended
      ? `<div class="bn-text">${esc(banner)}</div><button class="bn-btn" data-restart>⟳ К выбору ботов</button>`
      : `<div class="bn-text">${esc(banner)}</div>`;
    if (html !== lastBannerHtml) {
      bannerEl.innerHTML = html;
      lastBannerHtml = html;
    }
    bannerEl.style.display = 'block';
  } else if (bannerEl.style.display !== 'none') {
    bannerEl.style.display = 'none'; // banner cleared (e.g. a fresh match) → hide it
    lastBannerHtml = '';
  }
  // Speedbar restart — only the no-bots sandbox (no match end to restart from); other
  // modes use the end-banner button instead. Toggle each frame as the mode can change.
  const soloNoBots = !NET && AI_PLAYERS.size === 0;
  restartBtn.style.display = soloNoBots ? '' : 'none';
  restartSep.style.display = soloNoBots ? '' : 'none';
  // Keep the tech window live while open (research progress bar / eta), throttled.
  if (techWin.classList.contains('show') && nowReal - lastTechAt > 500) {
    lastTechAt = nowReal;
    renderTech();
  }
  requestAnimationFrame(frame);
}

// Codex popup: full specs for a building/ship tile, with a contextual "Build here"
// button. Tiles live in the build menu + fleet panel now (no global HUD strip).
const codexEl = document.getElementById('codex');
if (codexEl) {
  codexEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const build = (tg.closest('.cx-build') as HTMLElement | null)?.dataset.build;
    if (build && selPlanet) {
      const [kind, id] = build.split(':');
      enqueueBuild(selPlanet, { kind: kind as BuildKind, id: id!, count: 1 });
      codexEl.classList.remove('show');
      lastPanelHtml = '';
      renderPanel();
      return;
    }
    if (tg.id === 'codex' || tg.classList.contains('cx-close')) codexEl.classList.remove('show');
  });
}

// Player card: tap the top-left crest to open your session dossier (faction, worlds,
// fleets, score, treasury); tap the backdrop or CLOSE to dismiss.
document.querySelector('.crest')?.addEventListener('click', () => openPlayerCard());
const playerCardEl = document.getElementById('playercard');
if (playerCardEl) {
  playerCardEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.id === 'playercard' || tg.classList.contains('pc-close')) playerCardEl.classList.remove('show');
  });
}

// War prompt: a move routed through a player you're at peace with asks for
// confirmation — DECLARE WAR dispatches it (after declaring war), CANCEL/backdrop drops it.
const warPromptEl = document.getElementById('warprompt');
if (warPromptEl) {
  warPromptEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.classList.contains('wp-yes')) confirmWarPrompt();
    else if (tg.id === 'warprompt' || tg.classList.contains('wp-no')) cancelWarPrompt();
  });
}

// Ping marker popup: jump the camera to the marker, or (your own) remove it.
const pingPopEl = document.getElementById('pingpop');
if (pingPopEl) {
  pingPopEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const jump = (tg.closest('.pp-jump') as HTMLElement | null)?.dataset.loc;
    if (jump) {
      closePingPop();
      jumpToPing(jump);
      return;
    }
    const del = (tg.closest('.pp-del') as HTMLElement | null)?.dataset.loc;
    if (del) removePing(del);
  });
}

// Session menu: the rail's Diplomacy / Dispatches buttons open the roster / message log.
document.getElementById('rail-diplo')?.addEventListener('click', () => openDiplo('diplo'));
document.getElementById('rail-msgs')?.addEventListener('click', () => openDiplo('msgs'));

// === floating chat window (desktop only) =====================================
// A naive profanity scrub for the optional censor toggle — whole-word match, the
// letters swapped for asterisks (length kept so the line doesn't reflow).
const CHAT_BADWORDS = ['идиот', 'дурак', 'тупой', 'damn', 'hell', 'crap'];
function censorText(t: string): string {
  let out = t;
  for (const w of CHAT_BADWORDS) out = out.replace(new RegExp(w, 'gi'), (m) => '*'.repeat(m.length));
  return out;
}
/** The chat's tabs: the three fixed group rooms, then a tab per DM that exists (plus
 *  the open one). Other rooms (e.g. a coalition-to-coalition line) join here later. */
function chatChannels(): Array<{ key: string; label: string; icon: string }> {
  const base = [
    { key: CH_SESSION, label: 'Сессия', icon: '△' },
    { key: CH_GLOBAL, label: 'Глобальный', icon: '🌐' },
    { key: COALITION, label: 'Коалиция', icon: '⬡' },
  ];
  const dm = new Set<string>();
  for (const m of sessionMessages) {
    if (GROUP_CHANNELS.has(m.to)) continue;
    if (m.from === ME) dm.add(m.to);
    else if (m.to === ME) dm.add(m.from);
  }
  if (!GROUP_CHANNELS.has(chatTab)) dm.add(chatTab); // keep a freshly opened DM's tab
  for (const id of dm) if (s.players[id]) base.push({ key: id, label: NAME[id] ?? id, icon: seatBadge(id).icon });
  return base;
}
function chatChannelLabel(key: string): string {
  return chatChannels().find((c) => c.key === key)?.label ?? NAME[key] ?? key;
}
/** Cap geometry at half the screen and keep the window on-screen (title bar reachable). */
function clampChatGeom(): void {
  const maxW = Math.max(220, Math.floor(VW / 2));
  const maxH = Math.max(150, Math.floor(VH / 2));
  chatGeom.w = Math.max(220, Math.min(chatGeom.w, maxW));
  chatGeom.h = Math.max(150, Math.min(chatGeom.h, maxH));
  chatGeom.x = Math.max(0, Math.min(chatGeom.x, Math.max(0, VW - chatGeom.w)));
  chatGeom.y = Math.max(46, Math.min(chatGeom.y, Math.max(46, VH - 40)));
}
/** Push geometry / opacity / font to the DOM without rebuilding it (frame-safe). */
function applyChatGeom(): void {
  const win = document.getElementById('chatwin');
  if (!win) return;
  const st = (win as HTMLElement).style;
  st.left = chatGeom.x + 'px';
  st.top = chatGeom.y + 'px';
  st.width = chatGeom.w + 'px';
  st.height = chatMin ? 'auto' : chatGeom.h + 'px';
  // Transparency fades both the fill AND the frame (not element opacity — that would
  // dim the settings popover and text too). Background and border alpha track together.
  const k = 1 - chatCfg.transparency / 100;
  st.background = `rgba(3,14,18,${(0.82 * k).toFixed(3)})`;
  st.borderColor = `rgba(53,214,230,${k.toFixed(3)})`;
  const feed = document.getElementById('cw-feed') as HTMLElement | null;
  if (feed) feed.style.fontSize = chatCfg.fontPx + 'px';
}
function chatFeedInnerHtml(key: string): string {
  const msgs = convoMessages(key);
  if (!msgs.length) return `<div class="cw-empty">Канал «${esc(chatChannelLabel(key))}» пуст.<br>Напишите первое сообщение.</div>`;
  const stamp: StampOpts = { day: chatCfg.showDay, time: chatCfg.showTime, real: chatCfg.showReal };
  return msgs
    .map((m) => convoLineHtml(chatCfg.censor ? { ...m, text: censorText(m.text) } : m, stamp))
    .join('');
}
function renderChatFeed(): void {
  const feed = document.getElementById('cw-feed');
  if (!feed) return;
  feed.innerHTML = chatFeedInnerHtml(chatTab);
  (feed as HTMLElement).scrollTop = (feed as HTMLElement).scrollHeight;
}
/** Settings popover (flown out to the right): size (h,w on one line), font, colour
 *  (sub-only, label inline), censor, transparency, and the message-stamp toggles.
 *  Inputs carry data-cset; their handler patches state live and caches it. */
function chatSettingsHtml(): string {
  const maxW = Math.max(220, Math.floor(VW / 2));
  const maxH = Math.max(150, Math.floor(VH / 2));
  const chk = (on: boolean) => (on ? ' checked' : '');
  return (
    `<div class="cw-set">` +
    `<h4>НАСТРОЙКИ</h4>` +
    `<div class="cw-srow"><label>Размер h,w</label>` +
    `<input type="number" data-cset="h" min="150" max="${maxH}" value="${chatGeom.h}">` +
    `<input type="number" data-cset="w" min="220" max="${maxW}" value="${chatGeom.w}"></div>` +
    `<div class="cw-srow"><label>Шрифт, пт</label><input type="number" data-cset="font" min="8" max="42" value="${chatCfg.fontPx}"></div>` +
    `<div class="cw-srow"><label>Цвет шрифта</label><input type="color" data-cset="color" value="#7fe7ff" disabled><span class="cw-sub">🔒 подписка</span></div>` +
    `<div class="cw-srow"><label>Цензура</label><input type="checkbox" data-cset="censor"${chk(chatCfg.censor)}></div>` +
    `<div class="cw-srow"><label>Прозрачность</label><input type="range" data-cset="opacity" min="0" max="100" value="${chatCfg.transparency}"><span class="cw-opval">${chatCfg.transparency}%</span></div>` +
    `<div class="cw-shdr">Штамп сообщений</div>` +
    `<div class="cw-srow"><label>День</label><input type="checkbox" data-cset="showDay"${chk(chatCfg.showDay)}></div>` +
    `<div class="cw-srow"><label>Время</label><input type="checkbox" data-cset="showTime"${chk(chatCfg.showTime)}></div>` +
    `<div class="cw-srow"><label>Реальное время</label><input type="checkbox" data-cset="showReal"${chk(chatCfg.showReal)}></div>` +
    `</div>`
  );
}
/** Full (innerHTML) rebuild — only on an interaction (open / tab / button), never per
 *  frame. Geometry/feed are then applied/patched in place. */
function renderChat(): void {
  const win = document.getElementById('chatwin');
  if (!win) return;
  win.classList.toggle('open', chatOpen);
  win.classList.toggle('min', chatMin);
  win.classList.toggle('pinned', chatPinned);
  if (!chatOpen) {
    win.innerHTML = '';
    return;
  }
  const tabs = chatChannels()
    .map(
      (c) =>
        `<button class="cw-tab${c.key === chatTab ? ' on' : ''}" data-cwtab="${esc(c.key)}" title="${esc(c.label)}">${c.icon} ${esc(c.label)}</button>`,
    )
    .join('');
  win.innerHTML =
    `<div class="cw-head" data-cwhead title="${chatPinned ? '' : 'Тащите за шапку, чтобы переместить'}">` +
    `<span class="cw-title">ЧАТ — ${esc(chatChannelLabel(chatTab))}</span>` +
    `<button class="cw-btn${chatPinned ? ' on' : ''}" data-cwact="pin" title="Закрепить размер и положение">📎</button>` +
    `<button class="cw-btn${chatSettingsOpen ? ' on' : ''}" data-cwact="settings" title="Настройки">⚙</button>` +
    `<button class="cw-btn" data-cwact="min" title="${chatMin ? 'Развернуть' : 'Свернуть'}">${chatMin ? '▢' : '—'}</button>` +
    `</div>` +
    `<div class="cw-tabs">${tabs}</div>` +
    `<div class="cw-feed" id="cw-feed">${chatFeedInnerHtml(chatTab)}</div>` +
    `<div class="cw-compose"><input id="cw-text" type="text" maxlength="240" placeholder="Сообщение…" autocomplete="off"><button class="cw-send" data-cwact="send" title="Отправить">▶</button></div>` +
    (chatSettingsOpen ? chatSettingsHtml() : '');
  applyChatGeom();
  const feed = document.getElementById('cw-feed') as HTMLElement | null;
  if (feed) feed.scrollTop = feed.scrollHeight;
}
const CHAT_STORE_KEY = 'vd.chat.v1';
/** Persist chat preferences client-side (localStorage) — never on the server, so the
 *  same machine reopens to the same look. Geometry, pin and every setting ride along. */
function saveChat(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      CHAT_STORE_KEY,
      JSON.stringify({ cfg: chatCfg, geom: chatGeom, pinned: chatPinned }),
    );
  } catch {
    /* storage disabled / full — preferences just won't persist */
  }
}
/** Restore cached chat preferences (once, at startup). Marks the window placed so its
 *  first open uses the saved geometry instead of the default bottom-left parking. */
function loadChat(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CHAT_STORE_KEY);
    if (!raw) return;
    const v = JSON.parse(raw) as { cfg?: Partial<typeof chatCfg>; geom?: Partial<typeof chatGeom>; pinned?: boolean };
    if (v.cfg) Object.assign(chatCfg, v.cfg);
    if (v.geom) {
      Object.assign(chatGeom, v.geom);
      chatPlaced = true;
    }
    if (typeof v.pinned === 'boolean') chatPinned = v.pinned;
  } catch {
    /* corrupt cache — fall back to defaults */
  }
}
function openChat(): void {
  if (MOBILE) return;
  chatOpen = true;
  chatMin = false;
  if (!chatPlaced) {
    // First open (no cached geometry): park it in the bottom-left corner.
    chatGeom.w = Math.min(360, Math.max(220, Math.floor(VW / 2)));
    chatGeom.h = Math.min(300, Math.max(150, Math.floor(VH / 2)));
    chatGeom.x = 12;
    chatGeom.y = Math.max(46, VH - chatGeom.h - 12);
    chatPlaced = true;
    saveChat();
  }
  clampChatGeom();
  renderChat();
  (document.getElementById('cw-text') as HTMLInputElement | null)?.focus?.();
}
function closeChat(): void {
  chatOpen = false;
  chatMin = false;
  renderChat();
}
function sendChatMsg(): void {
  const input = document.getElementById('cw-text') as HTMLInputElement | null;
  const text = input?.value.trim();
  if (!text) return;
  pushMsg(chatTab, text, false); // to the open channel / DM (net play would broadcast)
  if (input) {
    input.value = '';
    input.focus?.();
  }
}
/** Mirror a drag back into the size fields while the settings popover is open. */
function syncChatSizeInputs(): void {
  const w = document.querySelector('[data-cset="w"]') as HTMLInputElement | null;
  const h = document.querySelector('[data-cset="h"]') as HTMLInputElement | null;
  if (w) w.value = String(chatGeom.w);
  if (h) h.value = String(chatGeom.h);
}
/** Which window edge (n/s/e/w + corners, or '') the pointer is within a few px of —
 *  drives both the resize cursor and which edge a drag from here moves. */
function chatEdgeAt(e: PointerEvent): string {
  if (!chatwinEl) return '';
  const r = (chatwinEl as HTMLElement).getBoundingClientRect();
  const EDGE = 7;
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  let d = '';
  if (y <= EDGE) d += 'n';
  else if (y >= r.height - EDGE) d += 's';
  if (x <= EDGE) d += 'w';
  else if (x >= r.width - EDGE) d += 'e';
  return d;
}
function chatResizeCursor(d: string): string {
  if (d === 'n' || d === 's') return 'ns-resize';
  if (d === 'e' || d === 'w') return 'ew-resize';
  if (d === 'ne' || d === 'sw') return 'nesw-resize';
  if (d === 'nw' || d === 'se') return 'nwse-resize';
  return '';
}
loadChat(); // restore cached preferences before the window can be opened
document.getElementById('rail-chat')?.addEventListener('click', () => (chatOpen ? closeChat() : openChat()));
const chatwinEl = document.getElementById('chatwin');
if (chatwinEl) {
  // Begin a gesture: a drag near any edge resizes in that direction; a drag on the
  // title bar moves the window. The pin (📎) locks both. Interactive controls opt out.
  chatwinEl.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, input, .cw-tab, .cw-set')) return;
    if (chatPinned) return;
    const pe = e as PointerEvent;
    const dir = chatMin ? '' : chatEdgeAt(pe); // collapsed → no resize, header still moves
    const onHead = !!t.closest('[data-cwhead]');
    if (!dir && !onHead) return;
    e.preventDefault();
    chatDrag = {
      mode: dir ? 'resize' : 'move',
      dir,
      px: pe.clientX,
      py: pe.clientY,
      gx: chatGeom.x,
      gy: chatGeom.y,
      gw: chatGeom.w,
      gh: chatGeom.h,
    };
  });
  // Hover cursor: show the resize arrow when near an edge (unless pinned/collapsed).
  chatwinEl.addEventListener('pointermove', (e) => {
    if (chatDrag) return; // an active gesture owns the cursor
    const dir = !chatPinned && !chatMin ? chatEdgeAt(e as PointerEvent) : '';
    (chatwinEl as HTMLElement).style.cursor = chatResizeCursor(dir);
  });
  // Tabs / head buttons / send.
  chatwinEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tab = (t.closest('[data-cwtab]') as HTMLElement | null)?.dataset.cwtab;
    if (tab) {
      chatTab = tab;
      renderChat();
      (document.getElementById('cw-text') as HTMLInputElement | null)?.focus?.();
      return;
    }
    const act = (t.closest('[data-cwact]') as HTMLElement | null)?.dataset.cwact;
    if (act === 'pin') {
      chatPinned = !chatPinned;
      saveChat();
      renderChat();
    } else if (act === 'settings') {
      chatSettingsOpen = !chatSettingsOpen;
      renderChat();
    } else if (act === 'min') {
      chatMin = !chatMin;
      renderChat();
    } else if (act === 'send') {
      sendChatMsg();
    }
  });
  chatwinEl.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (ke.target as HTMLElement).id === 'cw-text') {
      e.preventDefault();
      sendChatMsg();
    }
  });
  // Live settings: size/font/opacity patch geometry in place (no rebuild → no focus
  // loss); stamp + censor toggles repaint just the feed. Every change is cached.
  chatwinEl.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const k = t.dataset.cset;
    if (!k) return;
    if (k === 'w') {
      chatGeom.w = Number(t.value) || chatGeom.w;
      clampChatGeom();
      applyChatGeom();
    } else if (k === 'h') {
      chatGeom.h = Number(t.value) || chatGeom.h;
      clampChatGeom();
      applyChatGeom();
    } else if (k === 'font') {
      chatCfg.fontPx = Math.max(8, Math.min(42, Number(t.value) || chatCfg.fontPx));
      applyChatGeom();
    } else if (k === 'opacity') {
      chatCfg.transparency = Math.max(0, Math.min(100, Number(t.value) || 0));
      applyChatGeom();
      const lbl = chatwinEl.querySelector('.cw-opval');
      if (lbl) lbl.textContent = chatCfg.transparency + '%';
    } else if (k === 'censor') {
      chatCfg.censor = t.checked;
      renderChatFeed();
    } else if (k === 'showDay') {
      chatCfg.showDay = t.checked;
      renderChatFeed();
    } else if (k === 'showTime') {
      chatCfg.showTime = t.checked;
      renderChatFeed();
    } else if (k === 'showReal') {
      chatCfg.showReal = t.checked;
      renderChatFeed();
    }
    saveChat();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => {
    if (!chatDrag) return;
    const pe = e as PointerEvent;
    const dx = pe.clientX - chatDrag.px;
    const dy = pe.clientY - chatDrag.py;
    if (chatDrag.mode === 'move') {
      chatGeom.x = chatDrag.gx + dx;
      chatGeom.y = chatDrag.gy + dy;
    } else {
      const maxW = Math.max(220, Math.floor(VW / 2));
      const maxH = Math.max(150, Math.floor(VH / 2));
      const d = chatDrag.dir;
      // Edges anchored opposite the drag: pulling 'w'/'n' moves that edge while the
      // far edge stays put (so the box grows toward the pointer, not away from it).
      if (d.includes('e')) chatGeom.w = chatDrag.gw + dx;
      if (d.includes('s')) chatGeom.h = chatDrag.gh + dy;
      if (d.includes('w')) {
        const nw = Math.max(220, Math.min(chatDrag.gw - dx, maxW));
        chatGeom.x = chatDrag.gx + (chatDrag.gw - nw);
        chatGeom.w = nw;
      }
      if (d.includes('n')) {
        const nh = Math.max(150, Math.min(chatDrag.gh - dy, maxH));
        chatGeom.y = chatDrag.gy + (chatDrag.gh - nh);
        chatGeom.h = nh;
      }
    }
    clampChatGeom();
    applyChatGeom();
    if (chatDrag.mode === 'resize' && chatSettingsOpen) syncChatSizeInputs();
  });
  window.addEventListener('pointerup', () => {
    if (chatDrag) saveChat(); // cache the new geometry once the drag ends
    chatDrag = null;
  });
}

function toggleSet<T>(set: Set<T>, v: T): void {
  if (set.has(v)) set.delete(v);
  else set.add(v);
}
function sendDiploMsg(): void {
  const input = document.getElementById('dp-text') as HTMLInputElement | null;
  const text = input?.value.trim();
  if (!text) return;
  pushMsg(convoOpen, text, false); // to the open conversation (in net play this would broadcast)
  if (input) {
    input.value = '';
    input.focus();
  }
}
/** Ping the selected province into the coalition channel — also a clickable map
 *  marker. The composer text becomes the marker's short description. */
function pingSelected(): void {
  if (!selPlanet || !s.planets[selPlanet]) {
    note('Сначала выберите провинцию на карте');
    return;
  }
  const input = document.getElementById('dp-text') as HTMLInputElement | null;
  const desc = (input?.value.trim() ?? '').slice(0, 80);
  if (NET && netClient) {
    // The server is authoritative for pings: it stamps the marker and relays a
    // `ping.added` back to us + allies — that echo is what adds it (see onPingAdded).
    netClient.placePing({ kind: 'mark', target: { node: selPlanet }, label: desc });
  } else {
    pushMsg(COALITION, desc || `метка ${selPlanet}`, false, ME, selPlanet);
  }
  if (input) {
    input.value = '';
    input.focus();
  }
}
/** Active coalition pings, one marker per province (the latest ping there wins). The
 *  coalition chat log and the map markers share this single source. */
function activePings(): SessionMsg[] {
  const byLoc = new Map<string, SessionMsg>();
  for (const m of sessionMessages) if (m.to === COALITION && m.ping) byLoc.set(m.ping, m);
  return [...byLoc.values()];
}
/** Drop the marker (and its chat lines) for one of YOUR pings. */
function removePing(loc: string): void {
  const mine = activePings().find((p) => p.ping === loc && p.from === ME);
  if (NET && netClient && mine?.pingId) {
    netClient.clearPing(mine.pingId); // server echoes ping.removed → drops it for everyone
    closePingPop();
    return;
  }
  sessionMessages = sessionMessages.filter((m) => !(m.to === COALITION && m.ping === loc && m.from === ME));
  closePingPop();
  if (diploOpen && diploTab === 'msgs') renderDiploFeed();
}
/** A tapped map marker → a small popup with who pinged it and their description. */
function openPingPop(loc: string): void {
  const m = activePings().find((p) => p.ping === loc);
  const pl = s.planets[loc];
  const el = document.getElementById('pingpop');
  if (!m || !pl || !el) return;
  const c = world(pl.position);
  const r = canvas.getBoundingClientRect();
  const who = m.from === ME ? 'Вы' : NAME[m.from] ?? m.from;
  const mine = m.from === ME;
  el.innerHTML =
    `<div class="pp-top"><b style="color:${ownerColor(m.from)}">📍 ${esc(who)}</b><span>${esc(loc)}</span></div>` +
    `<div class="pp-desc">${m.text ? esc(m.text) : '<i>без описания</i>'}</div>` +
    `<div class="pp-act"><button class="pp-jump" data-loc="${esc(loc)}">↪ камера</button>` +
    (mine ? `<button class="pp-del" data-loc="${esc(loc)}">убрать</button>` : '') +
    `</div>`;
  el.style.left = `${Math.round(r.left + (c.x / VW) * r.width)}px`;
  el.style.top = `${Math.round(r.top + (c.y / VH) * r.height)}px`;
  el.classList.add('show');
}
function closePingPop(): void {
  document.getElementById('pingpop')?.classList.remove('show');
}
/** Draw a pin per active coalition ping (owner-coloured), recording screen hit-boxes
 *  for tap detection. Pins float just above the node, tip pointing at it. */
function drawPings(now: number): void {
  pingHits = [];
  for (const m of activePings()) {
    const pl = s.planets[m.ping!];
    if (!pl) continue;
    const c = world(pl.position);
    if (!visible(c, 40)) continue;
    const x = c.x;
    const y = c.y - 18; // pin head floats above the node
    const col = ownerColor(m.from);
    const pulse = 0.7 + 0.3 * Math.sin(now / 360 + x * 0.05);
    cx.save();
    cx.shadowColor = 'rgba(0,0,0,.7)';
    cx.shadowBlur = 4;
    cx.fillStyle = rgba(col, pulse);
    cx.strokeStyle = 'rgba(4,10,12,.85)';
    cx.lineWidth = 1.4;
    cx.beginPath(); // teardrop pin: head + tip toward the node
    cx.moveTo(x, y + 11);
    cx.lineTo(x - 5, y);
    cx.arc(x, y - 1, 5.5, Math.PI, 0);
    cx.lineTo(x, y + 11);
    cx.fill();
    cx.stroke();
    cx.shadowBlur = 0;
    cx.fillStyle = 'rgba(6,18,22,.95)';
    cx.beginPath();
    cx.arc(x, y - 1, 2.1, 0, TAU);
    cx.fill();
    cx.restore();
    pingHits.push({ loc: m.ping!, x, y: y - 1 });
  }
}
/** Tap a ping → fly the camera to that province (and select it); close the menu. */
function jumpToPing(id: string): void {
  const pl = s.planets[id];
  if (!pl) return;
  centerOn(pl.position, 3);
  selPlanet = id;
  selFleet = null;
  selFleets = new Set();
  lastPanelHtml = '';
  closeDiplo();
}
const diploEl = document.getElementById('diplo');
if (diploEl) {
  diploEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.id === 'diplo' || tg.closest('.dp-close')) return closeDiplo();
    const tab = (tg.closest('.dp-tab') as HTMLElement | null)?.dataset.tab;
    if (tab) {
      diploTab = tab as 'diplo' | 'msgs';
      renderDiplo();
      return;
    }
    const sort = (tg.closest('.dp-sortb') as HTMLElement | null)?.dataset.sort;
    if (sort) {
      diploSort = sort as typeof diploSort;
      renderDiplo();
      return;
    }
    const fstance = (tg.closest('.dp-fchip[data-fstance]') as HTMLElement | null)?.dataset.fstance;
    if (fstance) {
      toggleSet(diploStanceFilter, fstance as DiplomaticStance);
      renderDiplo();
      return;
    }
    const ftype = (tg.closest('.dp-fchip[data-ftype]') as HTMLElement | null)?.dataset.ftype;
    if (ftype) {
      toggleSet(diploTypeFilter, ftype as 'human' | 'ai');
      renderDiplo();
      return;
    }
    if (tg.closest('.dp-fclear')) {
      diploStanceFilter.clear();
      diploTypeFilter.clear();
      renderDiplo();
      return;
    }
    const actBtn = tg.closest('.dp-act') as HTMLElement | null;
    if (actBtn) {
      proposeStance(actBtn.dataset.seat!, actBtn.dataset.stance as DiplomaticStance);
      renderDiplo();
      return;
    }
    const msgseat = (tg.closest('.dp-msg') as HTMLElement | null)?.dataset.msgseat;
    if (msgseat) {
      convoOpen = msgseat;
      diploTab = 'msgs';
      renderDiplo();
      document.getElementById('dp-text')?.focus();
      return;
    }
    const convo = (tg.closest('.dp-cv') as HTMLElement | null)?.dataset.convo;
    if (convo) {
      convoOpen = convo;
      renderDiplo();
      document.getElementById('dp-text')?.focus();
      return;
    }
    if (tg.closest('.dp-ping')) return pingSelected();
    const ping = (tg.closest('.dp-line.ping') as HTMLElement | null)?.dataset.ping;
    if (ping) return jumpToPing(ping);
    if (tg.closest('.dp-send')) return sendDiploMsg();
    const row = tg.closest('.dp-row') as HTMLElement | null;
    if (row?.dataset.seat) {
      diploExpanded = diploExpanded === row.dataset.seat ? null : row.dataset.seat;
      renderDiplo();
    }
  });
  // Enter sends the composed message.
  diploEl.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (ke.target as HTMLElement).id === 'dp-text') {
      e.preventDefault();
      sendDiploMsg();
    }
  });
}

note(
  'Welcome, Commander. A wide frontier of provinces separates you from CRIMSON — the worlds among them score 50, every other sector 10. Reach 600 points or take the enemy capital.',
);
requestAnimationFrame(frame);

// --- in-app APK auto-update -------------------------------------------------
// Only live in the packaged APK (it carries a baked window.__BUILD__); the browser /
// dev build has none, so currentBuild() is null and every path below no-ops. We check
// the rolling release on launch (when online) and via a manual button, and surface a
// banner whose "Обновить" hands the APK asset URL to the SYSTEM BROWSER via the native
// bridge (window.VoidNative.open) — the browser downloads it and offers to install,
// which is reliable on any device. See prototype/src/updater.ts and mobile/patch-updater.mjs.
{
  const myBuild = currentBuild();
  if (myBuild) {
    const cver = $('cver');
    if (cver) cver.textContent = `сборка ${buildLabel(myBuild)}`;
    const cupd = $('cupd');
    if (cupd) cupd.style.display = '';

    const showUpdate = (u: UpdateInfo): void => {
      const ver = $('ub-ver');
      if (ver) ver.textContent = buildLabel(u);
      const go = $('ub-go') as HTMLAnchorElement | null;
      if (go) go.href = u.apkUrl;
      $('updbar').style.display = 'block'; // override the stylesheet's display:none
    };

    let checking = false;
    const runCheck = async (manual: boolean): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const u = await checkForUpdate();
        if (u) showUpdate(u);
        else if (manual && cupd) {
          const prev = cupd.textContent;
          cupd.textContent = 'Установлена последняя версия';
          window.setTimeout(() => {
            cupd.textContent = prev;
          }, 2200);
        }
      } finally {
        checking = false;
      }
    };

    // "Обновить" → open the APK in the system browser via the native bridge (downloads +
    // offers install, reliable everywhere). Falls back to the plain <a href> navigation
    // when the bridge is absent (a real browser / dev build).
    $('ub-go')?.addEventListener('click', (e) => {
      const native = (globalThis as { VoidNative?: { open?: (u: string) => void } }).VoidNative;
      const url = ($('ub-go') as HTMLAnchorElement).href;
      if (native?.open && url) {
        e.preventDefault();
        native.open(url);
      }
    });
    $('ub-later')?.addEventListener('click', () => {
      $('updbar').style.display = 'none';
    });
    cupd?.addEventListener('click', () => void runCheck(true));
    // Silent check on launch — only when the device reports it's online.
    if (navigator.onLine !== false) void runCheck(false);
  }
}
