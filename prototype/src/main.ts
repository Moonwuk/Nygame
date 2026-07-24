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
  ctx,
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
  spyOn,
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
  cancelConstruction,
  resumeConstruction,
  aiOrders,
  declareWar,
  netIncome,
  retreatFleet,
  STANCE_RANK,
  marketLots,
  marketList,
  marketTake,
  marketCancel,
  canTraverse,
  START_CANDIDATES,
  DEFAULT_TEMPLATES,
  FORMATION_UNITS,
  FORMATION_SLOTS,
  formationStats,
  divisionsOf,
  templatesOf,
  mobilizeDivision,
  renameDivisionTemplate,
  OFFICER_TEMPLATES,
  setDivisionTemplate,
  loadDivision,
  unloadDivision,
  designateCapital,
  capitalOf,
  isInhabited,
  divisionCargo,
  fleetCargoFree,
  type FormationTemplate,
  type FormationUnit,
  type SetupConfig,
  type SeatConfig,
  type StepOut,
  orderAuto,
  orderScramble,
  fleetIdle,
  squadronTake,
  squadronStrikeRange,
  sortieSpec,
  freshSortie,
  tickRearm,
  scrambleOrder,
  botFavour,
  FAVOUR_BASE,
  FAVOUR_EMBARGO,
  FAVOUR_WAR,
  delegateSteward,
  recallSteward,
  setHoldPoint,
  stewardActive,
  MAX_STEWARD_HOLD_POINTS,
  castHeroAbility,
  spawnHero,
  unlockHeroSkill,
  fitHero,
  buildShip,
  serverChainActions,
  chainStamp,
  orderChain,
  forceMarchFleet,
  FORCED_MARCH_MULT,
  instantRepairFleet,
  instantRepairCost,
  repairFleet,
  dockRepairCost,
  fleetAtOwnDock,
  MARKET_FEE,
  MAX_CHAIN_STEPS,
  type ChainStep,
  type Patrol,
} from './game';
import {
  ARCHETYPE_PATH,
  dominantUnit,
  unitArchetype,
  unitGlyphSvg,
  unitSizeClass,
} from './unitGlyphs';
import { fleetCallsign, fleetKindKey } from './fleetName';
import { planetName } from './planetName';
import { provinceScore } from '../../packages/shared-core/src/state/sectorKind';
import { OFFICERS, GROUND_ROSTER } from './groundcombat';
import { DEFAULT_HEROES, type HeroLoadout } from './heroes';
import { DEFAULT_SHIP_LOADOUTS, type ShipLoadout } from './ships';
// The «Оснащение корабля» loadout constructor reuses the framework-agnostic view-model
// from @void/client (typed slots + canEquip/effectiveStats/loadoutCost via shared-core).
import {
  createLoadoutEditor,
  applyLoadoutAction,
  type LoadoutModel,
  type LoadoutEditorResult,
} from '../../packages/client/src/loadoutEditor';
import {
  buildingLevel,
  buildingMaxLevel,
  cappedUnitStat,
  COMBAT_UNIT_CAP,
  effectiveStats,
  estimateTravelHours,
  findHealthyStack,
  fleetBaseSpeed,
  sumUnitStat,
  getStance,
  getOffer,
  pairHas,
  hashState,
  planRoute,
  previewBattle,
  previewLossCount,
  scanNodeThreats,
  identifiedNodes,
  thresholdRamp,
  BLACKOUT_MULT,
  type PausedConstructionSite,
} from '../../packages/shared-core/src/index';
import {
  MultiplayerClient,
  type MultiplayerPing,
  type MultiplayerChatMessage,
  createBattleModel,
  type BattleSideView,
} from '../../packages/client/src/index';
import {
  worldToScreen as camWorldToScreen,
  zoomAt as camZoomAt,
  clampCam as camClampCam,
  centerOn as camCenterOn,
} from '../../packages/client/src/camera';
import {
  rgba,
  blitGlow as hdBlitGlow,
  blitSphere as hdBlitSphere,
} from '../../packages/client/src/holoDraw';
import {
  drawTerritory,
  computePowerCell,
  type TerritorySeed,
} from '../../packages/client/src/territory';
import {
  buildLabel,
  checkForUpdateDetailed,
  currentBuild,
  type UpdateCheck,
  type UpdateInfo,
} from './updater';
// Localization: one locale = one file (src/locale/*). Msgid = the canonical
// Russian source string; `t()` wraps every user-visible literal, `tData()` maps
// English data/*.json names, the static HTML is localized by a boot pass.
import { t, tData, LOCALE, LOCALE_LABEL, setLocale, localizeStaticDom } from './i18n';
import {
  META_TREE,
  META_BRANCH_RU,
  metaLevel,
  metaLevelProgress,
  metaPoints,
  canUnlock,
  unlockNode,
  matchXp,
  metaGrant,
  parseMetaState,
  type MetaState,
  type MetaBranch,
} from './meta';
// ARS-5 — arsenal witryna (pure filter/group/parse; see prototype/src/arsenal.ts).
import {
  filterArsenal,
  gradesOf,
  originOf,
  ownedDefIds,
  parseArsenalItems,
  type ArsenalFilter,
} from './arsenal';
// AVA-C1/C2 — corporation cabinet (pure types/parsers; see prototype/src/corp.ts).
import {
  parseCorpRecord,
  parseCorpSummaries,
  parseMembership,
  parseMemberships,
  parseAudit,
  parseChallenges,
  parseReadyPool,
  parseRosterView,
  parseAccountIds,
  parseFeed,
  sortMembers,
  canManage,
  type CorpRole,
  type CorpRecord,
  type CorpMembership,
  type CorpSummary,
  type CorpAuditEntry,
  type AvaChallenge,
  type AvaChallengeStatus,
  type AvaRosterView,
  type AvaFeedEntry,
} from './corp';
// DEV TEST MODE — self-contained dev-only scenarios; remove this import + the
// initTestMode(...) call below + the #testmode HTML/CSS to cut it cleanly.
// (The player build already does: the only uses sit under `!__PLAYER_BUILD__`, so
// esbuild tree-shakes the whole module out of that bundle.)
import { initTestMode, openTestMode } from './testmode';
// ONB-1 — the reusable guide-mark (spotlight) engine + its browser adapter.
// `playerOrder` feeds it real actions so `action` steps advance; ONB-2 builds
// the full guided first match on the same `startTour` primitive.
import { startTour, type RunningTour } from './spotlightDom';
import type { TourResult } from './spotlight';
import { HUD_ORIENTATION_TOUR } from './onboardingTour';
// ONB-2 — the guided first match (a data chain over this same engine).
import { buildFirstMatchTour } from './firstMatchTour';
// ONB-4 — searchable codex/help index (pure) over the existing article corpus.
import {
  buildCodexIndex,
  searchCodex,
  GLOSSARY,
  type CodexEntry,
  type CodexCategory,
} from './codexIndex';
// ONB-3 — just-in-time mechanic intros (per-nick seen-set, shown once on first contact).
import { resolveIntro, parseSeenIntros, type IntroCard } from './intros';
// ONB-5 — return digest ("пока тебя не было"): aggregate the away-window event log.
import { buildRecap, type RecapEvent } from './recap';
// ONB-7 — first-session goals checklist (mine/fleet/capture/score, ticked from state).
import { FIRST_GOALS, metGoals, mergeDone, goalsComplete, type GoalSignals } from './firstGoals';
import { reconnectDelayMs } from './reconnect';
// ONB-0 — first-run onboarding state + funnel (per-callsign localStorage). Pure
// model; main.ts persists it and drives the hub offer / «Ещё → Обучение» replay.
import {
  applyTourOutcome,
  markSkipped,
  markStarted,
  parseOnboardState,
  welcomeMode,
  type OnboardState,
} from './onboarding';
import type {
  GameState,
  Fleet,
  Battle,
  Planet,
  Action,
  DiplomaticStance,
  DomainEvent,
  IntelGrant,
  ArsenalItem,
  UnitStack,
} from '../../packages/shared-core/src/index';

// --- constants ---------------------------------------------------------------

// Political palette (Bytro/Paradox-style): YOU = green, ally = blue, neutral =
// gray, enemy = red — used for fleets/planets and to tint each owner's province.
// Cyan stays the console-chrome accent (grid, borders, targeting reticle).
const COLOR: Record<string, string> = {
  p1: '#3ad17a', // you — green
  p2: '#ff5a4d',
  p3: '#ffb43a',
  p4: '#b07cff',
  p5: '#35d6e6',
  p6: '#ff7ac8',
  p7: '#9ed85a',
  p8: '#e58b4a',
  p9: '#6f9cff',
  p10: '#d8cf5a',
  ally: '#4a8cff', // ally — blue (latent: no allied player in the skirmish yet)
  null: '#6f8a93', // neutral — gray
};
// Distinct hues for the OTHER commanders (you are always green), assigned in a stable
// order so each rival keeps its colour across the match (up to 9 rivals).
const RIVAL_COLORS = [
  COLOR.p2!,
  COLOR.p3!,
  COLOR.p4!,
  COLOR.p5!,
  COLOR.p6!,
  COLOR.p7!,
  COLOR.p8!,
  COLOR.p9!,
  COLOR.p10!,
];
const SEAT_IDS = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
const VOID_COLOR = '#46606e'; // empty-space provinces — uncapturable void
// --- side-colour preferences (client-only, localStorage) ---------------------
// Постер «цвет = принадлежность»: свой/нейтральный цвет настраиваются, палитра
// соперников выбирается пресетом (включая дальтоник-безопасный, Okabe–Ito-подобные
// оттенки). Чистая косметика поверх ownerColor — механика сторон не трогается.
const RIVAL_PALETTES: Record<string, readonly string[]> = {
  classic: RIVAL_COLORS,
  warm: [
    '#ff4d3d',
    '#ff9d2e',
    '#ffd23d',
    '#ff6fa0',
    '#e8703a',
    '#d94f6c',
    '#ffb073',
    '#c9522f',
    '#ff8355',
  ],
  cvd: [
    '#e69f00',
    '#56b4e9',
    '#f0e442',
    '#0072b2',
    '#d55e00',
    '#cc79a7',
    '#999999',
    '#a6761d',
    '#8da0cb',
  ],
};
const readPref = (k: string): string | null =>
  typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null;
/** Side colours feed inline `style="color:…"` and `<input type=color value>` sinks, so a
 *  value reaching them MUST be a literal `#rrggbb` — never free text. They originate from
 *  `<input type="color">` (already constrained) but round-trip through localStorage, which a
 *  hostile extension/page could tamper. Validate on the way IN and rebuild the string from
 *  the matched digits so every downstream sink is safe by construction — a tampered value
 *  degrades to the default instead of injecting markup (CWE-79 / CodeQL js/xss-through-dom).
 *  The fallback is a trusted constant, used verbatim. */
function safeHexColor(c: string | null | undefined, fallback: string): string {
  // A validating GUARD (not a rebuild): the value is used only when it matched
  // `#rrggbb` — a pattern that cannot contain HTML metacharacters — so it is inert
  // in the inline `style`/attribute sinks. Anything else degrades to the trusted
  // default. (The guard form is what taint-analysis recognizes as a sanitizer.)
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}
let youColor = safeHexColor(readPref('void.colorYou'), COLOR.p1!);
let neutralColor = safeHexColor(readPref('void.colorNeutral'), COLOR.null!);
let rivalPaletteId = readPref('void.rivalPalette') ?? 'classic';
if (!RIVAL_PALETTES[rivalPaletteId]) rivalPaletteId = 'classic';
function setSideColors(you: string, neutral: string, palette: string): void {
  youColor = safeHexColor(you, COLOR.p1!);
  neutralColor = safeHexColor(neutral, COLOR.null!);
  rivalPaletteId = RIVAL_PALETTES[palette] ? palette : 'classic';
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('void.colorYou', youColor);
    localStorage.setItem('void.colorNeutral', neutralColor);
    localStorage.setItem('void.rivalPalette', rivalPaletteId);
  }
}
// Political colour is relative to the local commander: YOU are always green (or
// your configured hue), neutral gray, each rival its own palette hue. Works for
// solo (you = p1) and net (you may be any seat).
function ownerColor(owner: string | null | undefined): string {
  if (!owner) return neutralColor;
  if (owner === ME) return youColor;
  const rivals = SEAT_IDS.filter((id) => id !== ME);
  const i = rivals.indexOf(owner);
  const pal = RIVAL_PALETTES[rivalPaletteId] ?? RIVAL_COLORS;
  return i >= 0 ? pal[i % pal.length]! : pal[0]!;
}
// Build profile. `__PLAYER_BUILD__` is an esbuild define — REQUIRED by every bundler
// of this file (build.mjs sets it for both artifacts, uitest.mjs pins `false`); a
// missing define fails loudly at boot with this exact name. `true` bakes the PLAYER
// artifact (void-dominion-player.html): the dev affordances gated on it below (test
// mode, single-player skirmish, time acceleration) are compiled OUT of the bundle
// (the literal define is what lets esbuild dead-code-eliminate the branches — a
// `const` alias would fold but not propagate), and build.mjs strips their markup.
// `false` = the full dev client, today's behavior unchanged.
declare const __PLAYER_BUILD__: boolean;
// Runtime dev chrome (FPS overlay, the welcome-screen «Тесты» button): hidden from
// players, flipped on with `?dev` in the URL or localStorage 'vd.dev'='1' (persists
// per device). A live DESYNC still surfaces the overlay to everyone — that's a bug
// players must see and report, not diagnostics. Independent of __PLAYER_BUILD__: `?dev`
// on a player build only re-reveals diagnostics (FPS), never the compiled-out tools.
const DEV_UI = ((): boolean => {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev'))
      return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('vd.dev') === '1';
  } catch {
    return false;
  }
})();
// The ten possible commanders, in stable seat order. Seat 1 is always you (human);
// seats 2-10 are AI or off in the setup screen. Four faction passives cycle across seats.
const SEAT_META: ReadonlyArray<{ id: string; name: string; faction: string; color: string }> = [
  { id: 'p1', name: 'Azure Compact', faction: 'blue', color: COLOR.p1! },
  { id: 'p2', name: 'Crimson Hegemony', faction: 'red', color: COLOR.p2! },
  { id: 'p3', name: 'Amber Concord', faction: 'amber', color: COLOR.p3! },
  { id: 'p4', name: 'Violet Ascendancy', faction: 'violet', color: COLOR.p4! },
  { id: 'p5', name: 'Azure Compact II', faction: 'blue', color: COLOR.p5! },
  { id: 'p6', name: 'Crimson Hegemony II', faction: 'red', color: COLOR.p6! },
  { id: 'p7', name: 'Amber Concord II', faction: 'amber', color: COLOR.p7! },
  { id: 'p8', name: 'Violet Ascendancy II', faction: 'violet', color: COLOR.p8! },
  { id: 'p9', name: 'Azure Compact III', faction: 'blue', color: COLOR.p9! },
  { id: 'p10', name: 'Crimson Hegemony III', faction: 'red', color: COLOR.p10! },
];
const GRID = 'rgba(46,150,160,0.07)';
const LOCK = '#7df0d0'; // selection / targeting reticle accent
const TAU = Math.PI * 2;
const TOP = 50; // top-bar height
const RAIL = 50; // left-rail width
const BUILDABLE = [
  'mine',
  'refinery',
  'farm',
  'power_plant',
  'fabricator',
  'tax_office',
  'barracks',
  'radar',
  'fort',
  'orbital_aa',
];
// `orbital_aa` (orbital ПВО — anti-ship near-orbit emplacement) is a defensive BUILDING:
// the player builds it like a fort. It fires on hostile fleets over the world (core
// `aaStrengthAt` sums building AA) but does NOT block ground capture — only ground troops
// do that. A space fortress also comes with one pre-installed (installFortressAA).
const BUILD_UNITS = ['cruiser', 'scout', 'siege', 'strike_carrier', 'fighter_squadron'];
const BUILD_ICON: Record<string, string> = {
  mine: '⬢',
  refinery: '◇',
  tax_office: '⛁',
  farm: '❖',
  power_plant: '↯',
  fabricator: '▦',
  barracks: '▤',
  fort: '⬡',
  starfort: '✦',
  radar: '⊚',
  orbital_aa: '⌁',
};
const UNIT_ICON: Record<string, string> = {
  cruiser: '▲',
  scout: '◌',
  siege: '✦',
  strike_carrier: '◈', // a flat-top capital hull — hangar bays for the wing
  fighter_squadron: '△', // light strike wing (hollow, to read apart from the cruiser ▲)
  hero: '♔', // the player's projection — a crowned flagship
  militia: '▿', // massed light foot
  heavy_infantry: '◆', // the armoured line
  special_forces: '✱', // the elite few
  tank: '▰',
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
const SOVEREIGNS = 500;
type PlanetTab = 'ground' | 'ships' | 'squadron' | 'buildings';
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

// Holographic draw primitives (rgba tint, cached glow/sphere sprites) now live in the
// shared render kit (@void/client · holoDraw.ts, CP0.2 — one render implementation). The
// prototype keeps thin same-named delegators so every call site is unchanged; it passes its
// canvas ctx (`cx`) + current DPR, and the module owns the dpr-keyed sprite caches. `rgba`
// is imported directly (a pure colour helper).
function blitGlow(color: string, x: number, y: number, r: number, a: number): void {
  if (!glowFx) return; // graphics pref: glow & haloes off → skip the bloom discs entirely
  hdBlitGlow(cx, DPR, color, x, y, r, a);
}
function blitSphere(color: string, x: number, y: number, r: number, a = 1): void {
  hdBlitSphere(cx, DPR, color, x, y, r, a);
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
let speed = 1 / 3600; // game-hours per real second (0 = paused); ×1 = wall-clock, overwritten at launch
let banner: string | null = null;
// Terminal end screen (the match-over overlay): outcome + reason + XP award, filled
// once by checkEnd from the authoritative `match` state. `dismissed` lets the player
// hide it to look at the final board (the match stays frozen). Reset on a fresh match
// / reconnect so a new game never opens straight into the old result.
let endScreen: {
  won: boolean;
  draw: boolean;
  why: string;
  xp: number;
  levelUp: number | null;
  dismissed: boolean;
} | null = null;
let selFleet: string | null = null;
let selPlanet: string | null = null;
let selFleets = new Set<string>();
let aiming = false; // "Move" command armed → next world tap orders the move
// PC ШТУРМ: armed like "Move", but the target must be someone else's capturable
// world — the fleet flies there and assaults on arrival (one-shot, not the CC-2
// standing auto-storm). Keyed by fleet id → destination world.
let assaultAim = false;
const assaultOnArrival = new Map<string, string>();
let barrageAim = false; // "Обстрел" armed → next tap picks the artillery's focus target
// Hero window armed modes: a cast waits for its target world; a deploy waits for the
// point the hero's ship rises at (own world / own fleet / allied world by markers).
let heroAim: { heroId: string; abilityId: string } | null = null;
let heroSpawnAim: string | null = null;
// CC-2 standing order: fleets whose owner opted into AUTO-STORM — they descend and assault
// a hostile world on arrival by themselves (the AI's autoEngage capture loop, opted-in).
const autoAssault = new Set<string>();
// CC-4 reactive auto-scramble: squadron fleets on "дежурный вылет" — they auto-sortie at
// any identified, at-war contact that enters their strike radius (SQ-4.1 patrol core),
// burning fuel and rearming on a game-hour cadence (SQ-2.1). Client-side plan, like the
// order queue; single-player only (the server owns fleets in net play).
const patrols = new Map<string, Patrol>();
// Fuel/rearm stashed when a SOLO patrol is toggled OFF, so OFF→ON resumes the wing's
// sortie instead of handing back a full tank — BF-26 parity with the server's
// order.scramble path (st.wingSorties in game.ts); without it, toggling free-refuels a
// dry wing. (NET arms via order.scramble, which does its own stash server-side.)
const wingSorties = new Map<string, Patrol['sortie']>();
let lastPatrolTick = 0; // game-time (ms) the rearm cadence last advanced
// A staged move that would cross territory of a player you're at PEACE with: held
// until you confirm in the war-prompt (declaring war opens the route) or cancel.
let warPrompt: {
  fleetIds: string[];
  destId: string;
  edge?: { from: string; to: string; t: number };
  blockers: string[];
  /** PC ШТУРМ command: confirm → the moved fleets also assault on arrival; the
   *  prompt reads as "this is a friendly faction's world — declare war?". */
  assault?: boolean;
} | null = null;
// TGT-1: target-order composer over CC-1 chains. «Цель» arms targeting; the next
// world tap opens a small composer BESIDE the target; a standing marker stays on the
// target while a plan referencing it lives, and tapping it re-opens the composer.
let targetAim = false;
let tgtEditor: { fleetIds: string[]; target: string; steps: ChainStep[] } | null = null;
let tgtHits: Array<{ target: string; fleetIds: string[]; x: number; y: number }> = [];
// SEL-1 «Выбрать+»: touch multi-select. While ON the bottom sheet collapses, map
// taps only toggle OWN fleets in/out of the group, and the group takes any common
// order (Курс/Штурм/Цель…) — issuing one drops back out of the mode.
let pickMode = false;
let cmdMore = false; // ☰ — the second row of the command bar (extras live there)
let fireMenu = false; // 🔥 — режим огня артиллерии: поповер-меню над командным рядом
let merging = false; // "Merge" armed → next tap on a friendly fleet picks the anchor
// Fleets ordered to merge but not yet co-located: each flies to its anchor and the
// fusion fires once they share a docked sector (see resolvePendingMerges()).
let pendingMerges: Array<{ mover: string; into: string }> = [];
let additive = false; // Shift or Ctrl/⌘ held on the current tap → add to the fleet selection
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
  chatId?: string; // net only: server-assigned chat id — dedupes live echo vs join replay
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
let diploTab: 'diplo' | 'msgs' | 'intel' = 'diplo';
let diploSort: 'name' | 'worlds' | 'stance' = 'stance';
let diploExpanded: string | null = null; // participant row showing its action buttons
// Roster filters (alongside sort): show only seats matching the picked stance(s) and
// type(s). Empty set = no constraint from that category. They AND across categories,
// OR within one. A stance filter excludes your own seat (you have no self-stance).
const diploStanceFilter = new Set<DiplomaticStance>();
const diploTypeFilter = new Set<'human' | 'ai'>();
let convoOpen = COALITION; // the open conversation in the messages tab (seat id or COALITION)
let pingMenuLoc: string | null = null; // province whose ping composer is open (null = closed)
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
// M2 perf telemetry: a light fps/rtt/mem sample every 30s while in a network match —
// lands in the server's metrics stream (observe → JSONL/сводка), never answered.
let perfTimer: ReturnType<typeof setInterval> | null = null;
const PERF_SAMPLE_MS = 30_000;
let netDesync = false; // last snapshot's hash mismatched (server vs our rebuild)
let netDesyncCount = 0; // how many snapshots have mismatched this session
// Auto-reconnect: on an UNEXPECTED drop (not a user action), rejoin our seat with
// backoff — the server keeps the match running and the nick maps us back.
let userClosed = false;
let reconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let aimPointer: { x: number; y: number } | null = null; // last canvas pointer (for the move preview)
let hoverObj: string | null = null; // side-panel object under the pointer (data-desc key)
let planetTab: PlanetTab = 'buildings';
// Bytro-карточка: тап по имени флота открывает сводку армии — какой флот сейчас
// в режиме сводки (другой флот в панели → обычная карточка сама собой).
let fleetInfoFor: string | null = null;
// Тап по имени МИРА открывает карточку статистики планеты (какой мир сейчас в
// режиме сводки; другой мир в панели → обычная карточка сама собой).
let planetInfoFor: string | null = null;
let mobTplIdx = 0; // which division template the mobilisation panel is assembling
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
// Orbital-AA volleys to visualize (H2): map-space endpoints captured at event time
// (the target may die in that very volley), drawn as a fading flak burst ~0.7s.
const aaShots: Array<{
  from: { x: number; y: number };
  to: { x: number; y: number };
  at: number;
  close: boolean; // ближняя ПВО (гарнизон, залп раз в 15 мин) — рисуется легче
}> = [];
// Siege (artillery) volleys to visualize: map-space endpoints captured at event
// time, drawn as a ballistic ARC with a stagger of shell particles and an impact
// burst — so a standoff bombardment visibly points at WHO is being hit.
const siegeShots: Array<{
  from: { x: number; y: number };
  to: { x: number; y: number };
  at: number; // performance.now() at event time
  seed: number; // stable per-volley variation (spark angles, shell jitter)
}> = [];
let siegeSeed = 0;
// Capture flashes: a province that changed hands lights up in its NEW owner's colour —
// a wave sweeps across its cell and the frontier ignites, fading over ~1.5s, so a
// silent capture (previously only a toast) reads on the map at a glance. Fog-gated at
// push time (a hidden flip never flashes). Keyed by node so a re-capture restarts it.
const captureFlashes = new Map<string, { owner: string; at: number }>();
// Casualties per contested location (owner → unit → count), accumulated from
// unit.died while a battle runs and paid out as a result note on battle.resolved.
const battleLosses = new Map<string, Record<string, Record<string, number>>>();
// Single-player setup screen state: per-seat role (seat 0 is always you) + your
// chosen homeworld. Seats 2-10 toggle 'ai'/'off'; an 'ai' seat spawns a rival.
const freshSetupSlots = (): Array<'human' | 'ai' | 'off'> =>
  SEAT_META.map((_, i) => (i === 0 ? 'human' : i === 1 ? 'ai' : 'off'));
let setupSlots: Array<'human' | 'ai' | 'off'> = freshSetupSlots();
// Team battle (2v2 etc.): when on, seats fight in sides — same side ALLIED (win
// together, no friendly fire), across sides at WAR from the first hour. Seat 0 (you)
// is always side A; the default when enabling pairs you with seat 1 vs seats 2-3.
// Off ⇒ classic free-for-all. See newGame's team-aware diplomacy seeding.
let setupTeams = false;
const DEFAULT_TEAM_SIDES: ReadonlyArray<'A' | 'B'> = [
  'A',
  'A',
  'B',
  'B',
  'A',
  'A',
  'B',
  'B',
  'A',
  'B',
];
let setupSeatTeam: Array<'A' | 'B'> = [...DEFAULT_TEAM_SIDES];
let setupStart: string = START_CANDIDATES[0] ?? MAP[0]!.id;
let setupScientists: string[] = []; // the human's chosen research-leader council (≤2), picked at setup
let setupFaction = 'blue'; // H3: the house the HUMAN plays; AI seats take the remaining ones
// Chosen time-flow multiplier for the launched match (×1/×2/×5/×10/×50/×100). ×1 = today's
// normal play pace; the launch maps it onto the speedbar (applyTimeSpeed). ×100 is a
// single-player-only sandbox pace — in net mode the server owns the clock, so this list
// (and the in-match pace chips) only ever affect the local sim (see `frame()`'s `!NET` guard).
const SETUP_SPEEDS = [1, 2, 5, 10, 50, 100];
let setupSpeed = 10;
let lastPanelHtml = '';
let lastCmdHtml = '';
let lastSplitHtml = '';
let lastHudHtml = '';
let lastClockText = '';
let lastObjDescHtml = '';
let lastLogHtml = '';
let lastAlertText = '';
let lastRailAlert = '';
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
const spdCtl = $('spd-ctl'); // speedbar time-control group
const speedbarEl = $('speedbar');
const alertBadge = $('alertbadge');
const cmdbar = $('cmdbar');
const splitdlg = $('splitdlg');
// top-bar right cluster + collapsible rail
const railEl = $('rail');
const railToggle = $('railtoggle');
const railGlyph = $('railglyph');
const railAlert = $('railalert');
const crestMark = $('crestmark');

// Player emblem — a cosmetic console crest the player picks in the main menu (hub) and
// wears in the in-match top-bar corner. Client-side only (localStorage) — never match
// state, never sent to the server. Falls back to the first glyph if unset/unknown.
const EMBLEMS = ['◆', '◇', '⬡', '⬢', '✦', '✧', '★', '⚛', '◉', '⌖', '❖', '⟡'];
function playerEmblem(): string {
  const e = (typeof localStorage !== 'undefined' && localStorage.getItem('void.emblem')) || '';
  return EMBLEMS.includes(e) ? e : EMBLEMS[0]!;
}
function applyEmblem(): void {
  const g = playerEmblem();
  const hubAv = document.getElementById('hubav');
  if (hubAv) hubAv.textContent = g;
  crestMark.textContent = g;
}
function setPlayerEmblem(g: string): void {
  if (!EMBLEMS.includes(g)) return;
  try {
    localStorage.setItem('void.emblem', g);
  } catch {
    /* private mode — keep the in-memory choice only */
  }
  applyEmblem();
}

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
  // Width alone misses a LANDSCAPE phone (wide but short, finger-driven): treat a
  // coarse-pointer device with a short viewport as mobile too, so it never falls
  // into the hover-dependent desktop layout (audit: ландшафт проваливался в десктоп).
  MOBILE = VW < 720 || (matchMedia('(pointer: coarse)').matches && VH < 520);
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
// a slow radar sweep across the plotting table — console chrome that follows the
// HARDWARE: one rotating arm per OWN radar source (planet array / radar ship),
// pivoted on the source and clipped to ITS reach; co-located sources collapse into
// one arm showing only the farthest radius. All arms share one rotation phase; map
// blips light up as an arm crosses them (radar "ping" afterglow). sweepOn guards
// engines without conic gradients (no visible sweep → no ping).
type SweepArm = { x: number; y: number; r: number }; // screen-space pivot + reach
let sweepArms: SweepArm[] = [];
let sweepAng = 0;
let sweepOn = false;
let sweepPrevAng = -1; // previous frame's arm angle, for "did the arm cross X" tests
// Player display preference (client-only, localStorage): the sweep's VISUAL opacity 0..1.
// 0 hides the wedge + arm entirely; any value only dims the CHROME — the radar MECHANIC
// (contact snapshots + blip afterglow) is computed before the visual gate, so it is
// unaffected at every setting. Absent key ⇒ full (1); a stored 0 must NOT be read as absent.
let sweepOpacity = ((): number => {
  const raw =
    typeof localStorage !== 'undefined' ? localStorage.getItem('void.sweepOpacity') : null;
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
})();
function setSweepOpacity(v: number): void {
  sweepOpacity = Math.min(1, Math.max(0, v));
  try {
    localStorage.setItem('void.sweepOpacity', String(sweepOpacity));
  } catch {
    /* private-mode / storage-full: keep the in-memory value, just don't persist */
  }
}
// Player display preference (client-only, localStorage): show YOUR OWN ping markers
// on the map. Purely visual — the ping itself (chat line, allies' view, the server
// relay) is untouched; allies' pins are always drawn. Default on.
let showOwnPings =
  typeof localStorage === 'undefined' || localStorage.getItem('void.showOwnPings') !== '0';
function setShowOwnPings(v: boolean): void {
  showOwnPings = v;
  try {
    localStorage.setItem('void.showOwnPings', v ? '1' : '0');
  } catch {
    /* private-mode / storage-full: keep the in-memory value, just don't persist */
  }
}
// --- graphics preferences (client-only, localStorage) ------------------------
// Cosmetic quality knobs, never sent to the server and never touching the sim.
// Both default ON; a stored '0' turns the effect off on weaker devices / for a
// flatter, faster read of the map.
// Glow & haloes: the soft bloom discs (blitGlow) around worlds, fleets and
// frontiers. Off makes blitGlow a no-op — cheaper frames, a crisper flat map.
let glowFx = typeof localStorage === 'undefined' || localStorage.getItem('void.glowFx') !== '0';
function setGlowFx(v: boolean): void {
  glowFx = v;
  try {
    localStorage.setItem('void.glowFx', v ? '1' : '0');
  } catch {
    /* private-mode / storage-full: keep the in-memory value, just don't persist */
  }
}
// Deep-space backdrop: the drifting nebulae + faint star ticks baked into the
// static layer. Off leaves the flat fill + plotting grid. Toggling rebuilds the
// bake (starfield flag rides the static-layer cache signature in buildStaticLayer).
let starfield =
  typeof localStorage === 'undefined' || localStorage.getItem('void.starfield') !== '0';
function setStarfield(v: boolean): void {
  starfield = v;
  try {
    localStorage.setItem('void.starfield', v ? '1' : '0');
  } catch {
    /* private-mode / storage-full: keep the in-memory value, just don't persist */
  }
}
// «Компактный режим меню» (PC): a denser sector panel — tighter paddings, smaller
// type/chips/tiles. Rides a body class so pure CSS restyles the panel live; the
// panel markup and behaviour are untouched. Default off.
let compactPanel =
  typeof localStorage !== 'undefined' && localStorage.getItem('void.compactPanel') === '1';
function applyCompactPanel(): void {
  document.body.classList.toggle('compact-panel', compactPanel);
}
applyCompactPanel();
function setCompactPanel(v: boolean): void {
  compactPanel = v;
  applyCompactPanel();
  try {
    localStorage.setItem('void.compactPanel', v ? '1' : '0');
  } catch {
    /* private-mode / storage-full: keep the in-memory value, just don't persist */
  }
}
// Developer setting (PC): show the speedbar time controls (pause + speed multipliers).
// Off for a normal player — the world runs at its launch pace, real-time-async; a dev
// flips it on to pause / accelerate for testing. Defaults on in the dev client so its
// long-standing speedbar stays; off in the player build. Client-only (localStorage).
let devSpeedControl = ((): boolean => {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('void.devSpeed') : null;
  return raw === null ? !__PLAYER_BUILD__ : raw === '1';
})();
function setDevSpeedControl(v: boolean): void {
  devSpeedControl = v;
  try {
    localStorage.setItem('void.devSpeed', v ? '1' : '0');
  } catch {
    /* private-mode / storage-full: keep the in-memory value, just don't persist */
  }
}
// The compact-mode CSS is gated on the PC media query — JS-side string shortening
// (ping button, conveyor idle line, upgrade buttons) must follow the same gate, or
// a phone with the pref on would get PC-compact wording under phone styling.
const PC_FINE =
  typeof matchMedia !== 'undefined'
    ? matchMedia('(min-width:900px) and (hover:hover) and (pointer:fine)')
    : null;
/** True only in the PC layout mode (the same media query that gates the PC CSS).
 *  Every JS-side PC-only tweak MUST ride this gate — the mobile build is frozen. */
function pcUi(): boolean {
  return PC_FINE?.matches ?? false;
}
function compactUi(): boolean {
  return compactPanel && pcUi();
}
const SWEEP_DIV = 1600; // sweep angular rate: ang = now / SWEEP_DIV
const SWEEP_PERIOD = TAU * SWEEP_DIV; // ms for a full rotation (~10s) — the radar refresh tick
/** Radar contacts as PAINTED BY THE SWEEP: a signature is refreshed only as the arm
 *  crosses it, then lingers at that last-swept spot (a dim ghost) until the next
 *  pass repaints it — so radar gives periodic snapshots, never a live feed. */
const radarMemory = new Map<string, { node: string; size: 'S' | 'M' | 'L'; at: number }>();
/** NET radar picture (BF-18): the server's per-frame contact list. In a network
 *  match the fogged state carries NO radar-only enemy fleets, so the sweep paints
 *  these server-sent contacts instead of scanning `s.fleets`. */
let netSignatures: Array<{ location: string; size: 'S' | 'M' | 'L' }> = [];

/** How brightly a contact at screen-point `c` is lit by the sweep: 1 the instant
 *  the arm crosses it, fading linearly back to 0 just before the next pass (so the
 *  imprint lingers a whole rotation). 0 when the sweep is inactive. */
function sweepGlow(c: { x: number; y: number }): number {
  if (!sweepOn) return 0;
  let best = 0;
  for (const a of sweepArms) {
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    if (dx * dx + dy * dy > a.r * a.r) continue; // outside this arm's reach
    let delta = (sweepAng - Math.atan2(dy, dx)) % TAU; // canvas-clockwise, matches the conic
    if (delta < 0) delta += TAU;
    const t = 1 - delta / TAU;
    if (t * t > best) best = t * t; // ease so the just-crossed flash reads
  }
  return best;
}

function drawScanSweep(now: number) {
  sweepArms = [];
  sweepOn = false;
  if (!cx.createConicGradient) return; // graceful: skip on engines without it
  // One arm per OWN radar source, pivoted on the array / the ship itself (a moving
  // ship carries its arm along). Sources sharing a pivot (a radar world with a
  // radar ship docked) merge — only the farthest radius is shown.
  const merged = new Map<string, SweepArm>();
  const add = (at: { x: number; y: number }, reach: number): void => {
    const c = world(at);
    const r = world({ x: at.x + reach, y: at.y }).x - c.x; // uniform projection ⇒ true circle
    if (r <= 0) return;
    const key = `${Math.round(c.x)}:${Math.round(c.y)}`;
    const cur = merged.get(key);
    if (!cur || r > cur.r) merged.set(key, { x: c.x, y: c.y, r });
  };
  for (const p of Object.values(s.planets)) {
    if (p.owner !== ME) continue;
    const r = planetRadar(p);
    if (r > 0) add(p.position, r);
  }
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME) continue;
    const r = fleetRadar(f);
    const pos = r > 0 ? fleetPos(f) : null;
    if (pos) add(pos, r);
  }
  sweepArms = [...merged.values()];
  sweepAng = (now / SWEEP_DIV) % TAU;
  sweepOn = sweepArms.length > 0;
  if (!sweepOn) return;
  // Visual gate (player preference). Everything above — arms, angle, sweepOn — is the
  // MECHANIC and always runs; only the chrome below is skipped/dimmed. At 0 the sweep is
  // invisible yet still snapshots contacts and lights blips exactly as before.
  const op = sweepOpacity;
  if (op <= 0) return;
  cx.save();
  cx.globalCompositeOperation = 'lighter';
  for (const a of sweepArms) {
    if (!visible(a, a.r + 40)) continue; // draw-cull; the arm still paints contacts
    // subtle trailing wedge, clipped to this source's reach — reads as a slow
    // rotating radar sweep (fades over ~0.4 turn behind the leading edge). Alpha is
    // scaled by the player's opacity preference so it can be dimmed toward invisible.
    const grd = cx.createConicGradient(sweepAng, a.x, a.y);
    grd.addColorStop(0, `rgba(53,214,230,${0.05 * op})`);
    grd.addColorStop(0.16, `rgba(53,214,230,${0.012 * op})`);
    grd.addColorStop(0.4, 'rgba(53,214,230,0)');
    grd.addColorStop(1, 'rgba(53,214,230,0)');
    cx.save();
    cx.beginPath();
    cx.arc(a.x, a.y, a.r, 0, TAU);
    cx.clip();
    cx.fillStyle = grd;
    cx.fillRect(a.x - a.r, a.y - a.r, a.r * 2, a.r * 2);
    cx.restore();
    // the leading edge — the visible radar arm itself
    cx.strokeStyle = `rgba(53,214,230,${0.26 * op})`;
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(a.x, a.y);
    cx.lineTo(a.x + Math.cos(sweepAng) * a.r, a.y + Math.sin(sweepAng) * a.r);
    cx.stroke();
  }
  cx.restore();
}

// --- threat alert (THREAT-HUD): «враг у ваших рубежей» ------------------------
// The same fog-honest node-threat tripwire the Steward keys off (ST-3.1,
// scanNodeThreats), surfaced to the LIVE player: one note per (node, fleet)
// EPISODE — a camping fleet doesn't re-toast every step, a fresh approach after
// the episode ended alerts again (the radarMemory pattern). Throttled to once
// per GAME-HOUR bucket: solo advances s.time every frame, so a raw s.time guard
// would be a no-op and the coverage flood would run per frame; threats move on
// multi-hour ETAs, so an hourly sweep loses nothing. NET is naturally
// fog-clean — the fogged state only ever holds fleets the player may see.
const threatMemory = new Set<string>();
let threatScanAt = -1;
function updateThreatAlerts(): void {
  const bucket = Math.floor(s.time / HOUR);
  if (bucket === threatScanAt) return;
  threatScanAt = bucket;
  if (s.players[ME]?.status !== 'active') return;
  const c = ctx(s.time);
  const identified = identifiedNodes(s, ME, data);
  const live = new Set<string>();
  for (const p of Object.values(s.planets)) {
    if (p.owner !== ME) continue;
    for (const th of scanNodeThreats(s, p.id, ME, c, identified)) {
      const key = `${p.id}|${th.fleetId}`;
      live.add(key);
      if (threatMemory.has(key)) continue;
      threatMemory.add(key);
      note(
        th.kind === 'inbound' && th.eta > s.time
          ? t('⚠ Враг идёт к {node}: прибытие через {dur}', {
              node: p.id,
              dur: stewFmtDur(th.eta - s.time),
            })
          : t('⚠ Враг у {node}!', { node: p.id }),
        p.id,
      );
    }
  }
  // Episodes that ended are forgotten — a NEW approach to the node re-alerts.
  for (const k of threatMemory) if (!live.has(k)) threatMemory.delete(k);
}

/** Did the sweep arm cross screen-angle `target` between last frame and this one? */
function sweptThisFrame(target: number): boolean {
  if (sweepPrevAng < 0) return false;
  const d = (sweepAng - sweepPrevAng + TAU) % TAU; // arc the arm swept this frame
  if (d <= 0) return false;
  const t = ((((target % TAU) + TAU) % TAU) - sweepPrevAng + TAU) % TAU;
  return t > 0 && t <= d;
}

/** Refresh radar contacts the arm crossed this frame: snapshot each radar-only enemy
 *  fleet's spot + coarse size when the sweep paints it. Runs every frame. */
function updateRadarContacts(now: number): void {
  if (!sweepOn) return;
  if (vision) {
    // What the sweep may paint. Solo scans the full state for radar-only enemy
    // fleets; in NET those fleets are physically ABSENT from the fogged state —
    // the server ships them as coarse contacts (snapshot.signatures, BF-18).
    const contacts: Array<{ key: string; node: string; size: 'S' | 'M' | 'L' }> = [];
    if (NET) {
      netSignatures.forEach((c, i) => {
        if (!known(c.location))
          contacts.push({ key: `sig:${c.location}:${i}`, node: c.location, size: c.size });
      });
    } else {
      for (const f of Object.values(s.fleets)) {
        if (f.owner === ME) continue;
        const fn = fleetNode(f);
        if (!fn || known(fn) || !radarHas(fn)) continue; // identified or out of radar → not a signature
        contacts.push({ key: f.id, node: fn, size: sigClass(fleetSignature(f)) });
      }
    }
    for (const c of contacts) {
      const node = s.planets[c.node];
      if (!node) continue;
      const pos = world(node.position);
      // painted only by an arm whose radar disc actually covers the blip
      const painted = sweepArms.some((a) => {
        const dx = pos.x - a.x;
        const dy = pos.y - a.y;
        return dx * dx + dy * dy <= a.r * a.r && sweptThisFrame(Math.atan2(dy, dx));
      });
      if (painted) {
        if (!radarMemory.has(c.key))
          note(t('◆ новый радарный контакт ({size}) у {at}', { size: c.size, at: c.node }), c.node);
        radarMemory.set(c.key, { node: c.node, size: c.size, at: now });
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
// The view transform (fit / zoom / pan / projection) lives in the shared camera module
// (@void/client · camera.ts, CP0.2 — one render implementation for the prototype and the
// Stage-4 client). MINX..MAXY (set once from MAP above) are the map bounds it projects.
const mapBounds = () => ({ minX: MINX, minY: MINY, maxX: MAXX, maxY: MAXY });

// Camera: pan offset + zoom over the base fit (scale range MIN_SCALE..MAX_SCALE lives in
// the module: 1 = whole-map fit, 6 = one province + neighbours). Node/label sizes stay
// constant in screen px; only positions transform (node-graph style zoom). On a phone the
// opening view zooms onto the home region; double-tap resets, pinch out to the overview.
const cam = { scale: 1, x: 0, y: 0 };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// node sector type by id — drives asteroid-junction rendering + capture-by-arrival
const SECTOR_OF: Record<string, string> = Object.fromEntries(MAP.map((n) => [n.id, n.sector]));
function world(p: { x: number; y: number }): { x: number; y: number } {
  return camWorldToScreen(p, cam, insets(), mapBounds());
}
function visible(c: { x: number; y: number }, pad = 80): boolean {
  return c.x >= -pad && c.x <= VW + pad && c.y >= -pad && c.y <= VH + pad;
}
/** Extra pan slack while the selection panel (#side) covers the play area: let the
 *  camera overshoot the map border by the covered strip, so worlds hidden behind the
 *  open panel can be dragged into the clear part of the screen. The panel is a
 *  full-width bottom sheet on phones (→ slack below) and a right-hand column on wide
 *  screens (→ slack on the right); measure its live rect so both layouts just work. */
function panelSlack(): { right?: number; bottom?: number } {
  const el = typeof document !== 'undefined' ? document.getElementById('side') : null;
  if (!el || getComputedStyle(el).display === 'none') return {};
  const r = el.getBoundingClientRect();
  if (r.height <= 0 || r.width <= 0) return {};
  if (r.width >= VW * 0.7) return { bottom: Math.max(0, VH - r.top) }; // bottom sheet
  return { right: Math.max(0, VW - r.left) }; // right-hand column
}

function zoomAt(fx: number, fy: number, factor: number) {
  // Zoom anchored on the focal point (cursor / pinch centre) — camera.ts clamps scale + pan.
  const n = camZoomAt(cam, fx, fy, factor, insets(), mapBounds(), panelSlack());
  cam.scale = n.scale;
  cam.x = n.x;
  cam.y = n.y;
}

/** Keep the map filling the play area with SLACK at the edges (module: PAN_SLACK) so the
 *  outermost provinces don't jam against the border. Delegates to the shared camera;
 *  an open panel widens the range (panelSlack) so it never traps the view. */
function clampCam(): void {
  const n = camClampCam(cam, insets(), mapBounds(), panelSlack());
  cam.x = n.x;
  cam.y = n.y;
}

/** Put map-point `p` at the centre of the play area at `scale` (clamped + bounded). */
function centerOn(p: { x: number; y: number }, scale: number): void {
  const n = camCenterOn(cam, p, scale, insets(), mapBounds(), panelSlack());
  cam.scale = n.scale;
  cam.x = n.x;
  cam.y = n.y;
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
// Squadrons/carriers are their own build category (air wing): a carrier (◈) ferries the
// fighter squadrons (△) it launches, so both live under the Wings tab — apart from line
// spacecraft (which stay under Ships).
const isSquadron = (u: string) => {
  const t = data.units[u]?.traits ?? [];
  return t.includes('squadron') || t.includes('carrier');
};
const isShip = (u: string) => !data.units[u]?.traits.includes('ground') && !isSquadron(u);
const isGround = (u: string) => data.units[u]?.domain === 'ground';
const floor = Math.floor;
/** Compact number like Iron Order's bar: 15.7k, 728, … */
function kfmt(n: number): string {
  const v = Math.round(n);
  return Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(v);
}

function cost(bag: Record<string, number> | undefined): string {
  if (!bag) return 'free';
  const parts = Object.entries(bag).map(([r, n]) => `${n}${TECH_CUR[r] ?? r[0]}`);
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
// Path2D-кэш силуэтов постера для канвы — панель берёт те же пути через SVG,
// так что карта и карточка не могут разъехаться по форме.
const ARCH_PATH2D: Partial<Record<keyof typeof ARCHETYPE_PATH, Path2D>> = {};
function archPath2d(arch: keyof typeof ARCHETYPE_PATH): Path2D {
  return (ARCH_PATH2D[arch] ??= new Path2D(ARCHETYPE_PATH[arch]));
}
function displayUnit(unit: string): string {
  // Unit ids are English-ish ("scout_drone") — the space-joined id is the DATA name
  // the RU locale translates (see locale/ru.ts); EN shows it as-is.
  return tData(unit.replace(/_/g, ' '));
}
/** Localized display name of a building id (data/*.json names are English). */
function buildingName(id: string): string {
  return tData(data.buildings[id]?.name ?? id);
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
    return `${BUILD_ICON[p.building] ?? '▣'} ${tData(data.buildings[p.building]?.name ?? p.building)} → L${p.level ?? '?'}`;
  }
  if (p.building) {
    return `${BUILD_ICON[p.building] ?? '▣'} ${tData(data.buildings[p.building]?.name ?? p.building)}`;
  }
  return t('неизвестный заказ');
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
  return fmtEta(Math.max(0, (at - s.time) / HOUR));
}
/** Format a travel-time-remaining in hours as `1.4ч` / `35м` (localized suffixes). */
function fmtEta(totalH: number): string {
  return totalH >= 1
    ? t('{n}ч', { n: totalH.toFixed(1) })
    : t('{n}м', { n: Math.ceil(totalH * 60) });
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
    // PC: icon·count chips (like the garrison tiles) — the hover dossier names the
    // unit. Mobile keeps the full name.
    if (pcUi()) return `${unitIcon(q.id)} ${q.count}`;
    return `${q.count}× ${unitIcon(q.id)} ${displayUnit(q.id)}`;
  }
  if (q.kind === 'upgrade') {
    return t('{b} — улучшение', {
      b: `${BUILD_ICON[q.id] ?? '▣'} ${tData(data.buildings[q.id]?.name ?? q.id)}`,
    });
  }
  return `${BUILD_ICON[q.id] ?? '▣'} ${tData(data.buildings[q.id]?.name ?? q.id)}`;
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
  note(t('в очередь: {what} на {at}', { what: queuedLabel(order), at: planetId }));
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
        note(t('{what} — не вышло: {err}', { what: queuedLabel(next), err: errText(r.error) }));
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
  return (
    !!f &&
    f.units.some((u) => u.count > 0 && (data.units[u.unit]?.traits.includes('artillery') ?? false))
  );
}

/** Does this fleet carry a launchable strike wing (squadron-trait ships)? The carrier
 *  can split them off as a fast, short-range fleet (squadrons-roadmap SQ-1.1). */
function fleetHasSquadron(f: Fleet | undefined): boolean {
  return (
    !!f &&
    f.units.some((u) => u.count > 0 && (data.units[u.unit]?.traits.includes('squadron') ?? false))
  );
}

/** Can the fleet launch its squadrons right now? `fleet.split` refuses to take the whole
 *  stack (E_SPLIT_ALL) and only works on a stationary fleet (E_IN_TRANSIT / E_IN_BATTLE),
 *  so the launch is offered only when a non-squadron ship stays behind and the carrier is
 *  parked and out of combat (squadrons-roadmap SQ-1.1). */
function fleetCanLaunchSquadron(f: Fleet | undefined): boolean {
  if (!fleetHasSquadron(f) || f!.movement || !f!.location || f!.battleId) return false;
  const total = f!.units.reduce((n, u) => n + u.count, 0);
  const wing = squadronTake(f!).reduce((n, u) => n + u.count, 0);
  return wing > 0 && total > wing;
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
  const here = Object.values(divisionsOf(s)).filter(
    (d) => d.owner === ME && d.location === planetId,
  );
  let h = `<div class="sec">${t('Дивизии')}</div>`;
  if (here.length) {
    for (const d of here) {
      const comp = d.units.map((u) => `${formIcon(u.type)}${u.count}`).join(' ') || '—';
      const hp = Math.round(d.units.reduce((n, u) => n + u.hp, 0));
      const off = d.officer ? t(OFFICERS[d.officer]?.name ?? '') : '';
      // Офицер — часть ИМЕННОГО шаблона (готовый, менять нельзя): показываем, не редактируем.
      h += `<div class="asset-row" data-desc="division"><span class="bicon">⊞</span><b>${esc(t(d.name))}</b><span class="dim">${comp} · ❤${hp}${off ? ' · ★' + esc(off) : ''}</span></div>`;
    }
  } else {
    h += `<div class="row dim">${pcUi() ? t('Нет дивизий.') : t('Нет дивизий — мобилизуй по шаблону ниже.')}</div>`;
  }
  const tpls = templatesOf(s, ME);
  const res = s.players[ME]?.resources ?? {};
  // Stellaris-style: the panel only PICKS a ready design and mobilises it; editing
  // lives in the designer window («⚙ Конструктор»). Named officer templates ride
  // after the custom three, marked ★ — ready-made, composition locked.
  const officerBase = tpls.length;
  const all: Array<{ tpl: FormationTemplate; officer?: string }> = [
    ...tpls.map((tpl) => ({ tpl })),
    ...OFFICER_TEMPLATES.map((tpl) => ({ tpl, officer: tpl.officer })),
  ];
  const idx = Math.max(0, Math.min(mobTplIdx, all.length - 1));
  const pick = all[idx]!;
  h += `<div class="sec">${t('Мобилизация')}</div>`;
  h += `<div class="row">`;
  for (let i = 0; i < all.length; i++) {
    const star = all[i]!.officer ? '★ ' : '';
    h += btn('mobtpl', String(i), star + esc(t(all[i]!.tpl.name)), i !== idx);
  }
  h += `</div>`;
  const f = formationStats(pick.tpl);
  const afford = Object.entries(f.cost).every(([r, a]) => (res[r] ?? 0) >= a);
  const slots = pick.tpl.slots.filter(Boolean) as string[];
  const offLine = pick.officer ? ` · ★${esc(t(OFFICERS[pick.officer]?.name ?? ''))}` : '';
  if (pcUi()) {
    // PC: every icon self-describes on hover — composition glyphs → unit dossiers,
    // ⚔/🛡/❤ → the stat's name, cost glyphs → the resource's name.
    const comp =
      slots.map((u) => `<span data-desc="u:${esc(u)}">${formIcon(u)}</span>`).join('') || '—';
    const cost =
      Object.entries(f.cost)
        .map(([r, a]) => `<span data-desc="res:${esc(r)}">${a}${TECH_CUR[r] ?? r[0]}</span>`)
        .join(' ') || '—';
    h += `<div class="row dim">${comp} · <span data-desc="stat:datk">⚔${f.attack}</span> <span data-desc="stat:ddef">🛡${f.defense}</span> <span data-desc="stat:dhp">❤${f.hp}</span>${offLine} · ${cost}</div>`;
  } else {
    const comp = slots.map((u) => formIcon(u)).join('') || '—';
    const cost =
      Object.entries(f.cost)
        .map(([r, a]) => `${a}${TECH_CUR[r] ?? r[0]}`)
        .join(' ') || '—';
    h += `<div class="row dim">${comp} · ⚔${f.attack} 🛡${f.defense} ❤${f.hp}${offLine} · ${cost}</div>`;
  }
  h += `<div class="row">`;
  h += btn(
    'mobilize',
    pick.officer ? `o${idx - officerBase}` : String(idx),
    t('Мобилизовать «{name}»', { name: esc(t(pick.tpl.name)) }),
    afford && f.count > 0,
    pcUi() ? 'division' : undefined,
  );
  h += btn('divdesign', '', t('⚙ Конструктор'), true, pcUi() ? 'act:divdesign' : undefined);
  h += `</div>`;
  // PC dropped this hint (its content lives in hover dossiers); mobile keeps it.
  if (!pcUi()) {
    h += `<div class="hint">${t('Дивизия — снапшот шаблона: правка шаблона в конструкторе не меняет уже собранные. На своём мире +1 HP/юнит/день; выбитая исчезает.')}</div>`;
  }
  return h;
}

/** Division ⇄ hold transport for a docked fleet `f` over world `here`: load the
 *  player's garrisoning divisions (if they fit the free hold) and unload the ones it
 *  carries (onto an enemy world = a landing). Empty string when there's nothing to do. */
function fleetDivisionsHtml(f: Fleet, here: Planet): string {
  const all = Object.values(divisionsOf(s));
  const carried = all.filter((d) => d.carriedBy === f.id);
  const loadable = all.filter(
    (d) => d.owner === ME && d.carriedBy == null && d.location === here.id,
  );
  if (!carried.length && !loadable.length) return '';
  // Clamp the readout: a carrier that lost ships while loaded can hold more footprint
  // than its remaining capacity (carried footprint is reserved at load time, not
  // re-validated against later losses), so raw free can go negative.
  const free = Math.max(0, fleetCargoFree(s, f));
  let g = `<div class="sec">${t('Дивизии ⇄ трюм (своб. {n})', { n: free })}</div>`;
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
      const comp = d.units.map((u) => `${formIcon(u.type)}${u.count}`).join('') || '—';
      g += btn('divunload', d.id, `▼ ${esc(d.name)} ${comp}`, true);
    }
    g += `</div>`;
  }
  g += `<div class="hint">${t('Загрузка — дивизия должна влезть в трюм; выгрузка высаживает её на этот мир (на чужом — захват, если не обороняется).')}</div>`;
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
  const scale =
    nearest === Infinity ? orbitZoom() : Math.min(orbitZoom(), (nearest * 0.4) / ORBIT_R);
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
// ONB-5: a structured, bounded mirror of the event log — feeds the return digest.
const eventLog: RecapEvent[] = [];
let lastNoteMsg = '';
let lastNoteAtMs = 0;
function note(msg: string, at?: string) {
  // Dedupe guard: an order loop re-rejecting every frame must not machine-gun the
  // same toast/log line — an identical message within 2s (real time) is dropped.
  const nowMs = Date.now();
  if (msg === lastNoteMsg && nowMs - lastNoteAtMs < 2000) return;
  lastNoteMsg = msg;
  lastNoteAtMs = nowMs;
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  logLines.push(`D${d} ${String(h).padStart(2, '0')}h · ${msg}`);
  while (logLines.length > 9) logLines.shift();
  eventLog.push({ at: s.time, text: msg, anchor: at });
  while (eventLog.length > 80) eventLog.shift();
  toast(msg, at);
}

/** Transient event toast over the map — feedback must not live only in a hidden
 *  log window. Tap dismisses; with a map anchor the tap also flies the camera
 *  there (the jumpToPing path). At most 3 stacked, ~5s life each. */
function toast(msg: string, at?: string): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = at ? 'toast jump' : 'toast';
  el.textContent = at ? `${msg} ↪` : msg;
  el.addEventListener('click', () => {
    if (at) jumpToPing(at);
    el.remove();
  });
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 450);
  }, 5200);
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

// --- espionage (SPY-1 in the prototype) ---------------------------------------
// The core `espionageModule` grants time-boxed intel windows (`state.intel[ME]`);
// here the client fog honours them: a `planet` grant identifies that node, a
// `fleets` grant shows the target's fleets through the fog, a `treasury` grant is
// read by the diplomacy roster. Mirrors what `visibleState` does server-side.
/** Base fee of one attempt — mirrors the core module's BASE_COST (UI label only;
 *  the kernel is authoritative and rejects with E_INSUFFICIENT when short). */
const SPY_COST = 150;
/** My LIVE intel windows (expired ones are ignored even before the core prunes them). */
function myIntel(): IntelGrant[] {
  return (s.intel?.[ME] ?? []).filter((g) => g.until > s.time);
}
/** Live grants of one kind, as a target-id set (planet ids / player ids). */
function intelTargets(kind: IntelGrant['kind']): Set<string> {
  const out = new Set<string>();
  for (const g of myIntel()) if (g.kind === kind) out.add(g.target);
  return out;
}
// Owners whose fleets are revealed this frame by a live `fleets` grant — rebuilt
// alongside `vision` each frame so the render path checks a Set, not the grant list.
let intelFleetOwners = new Set<string>();
// SPY-UX: bounded session journal of espionage outcomes (mine + counter-intel hits
// on me) — feeds the «Шпионаж» tab in diplomacy. Stores the final localized line.
const spyLog: { at: number; text: string }[] = [];
function pushSpyLog(text: string): void {
  spyLog.push({ at: s.time, text });
  while (spyLog.length > 30) spyLog.shift();
  if (diploOpen && diploTab === 'intel') renderDiplo();
}

/** Variant-B visibility: an identify range (full detail, feeds memory) plus a
 *  wider radar range (enemy fleets seen only as coarse signatures). The radar
 *  reach scales with radar-array level and radar-ships. null vision = fog off. */
function computeVision(): Vision {
  const identify = new Set<string>();
  const radar = new Set<string>();
  // ECON-2 «блэкаут»: неоплаченная энергия глушит каждый свой радар вдвое —
  // зеркалит серверную fog-проекцию (radarMultiplier, visibility.ts).
  const dim = (s.players[ME]?.arrears ?? []).includes('energy') ? BLACKOUT_MULT : 1;
  for (const p of Object.values(s.planets))
    if (p.owner === ME) {
      floodHops(p.id, SENSOR_HOPS, identify);
      const rr = planetRadar(p) * dim;
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
      const rr = fleetRadar(f) * dim;
      if (rr > 0) {
        const pos = fleetPos(f); // radar from the SHIP's position, not its destination
        if (pos) {
          withinRadiusAt(pos, rr, radar); // signatures (outer)
          withinRadiusAt(pos, rr * IDENTIFY_REACH_FRACTION, identify); // full reveal (inner)
        }
      }
    }
  // Stolen `planet` windows identify their node (feeds memory too, so the scan
  // is remembered after the window closes); `fleets` windows fill the owner set
  // that fleet rendering consults.
  for (const id of intelTargets('planet')) if (s.planets[id]) identify.add(id);
  intelFleetOwners = intelTargets('fleets');
  for (const id of identify) radar.add(id); // identify implies radar
  return { identify, radar };
}

/** Is this fleet visible? Own always; enemy — when its node is identified OR a
 *  live `fleets` intel window covers its owner. */
function fleetSeen(f: Fleet): boolean {
  if (f.owner === ME) return true;
  return known(fleetNode(f)) || intelFleetOwners.has(f.owner);
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
function drawSignatureAt(
  pos: { x: number; y: number },
  cls: 'S' | 'M' | 'L',
  fade: number,
  now: number,
): void {
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

// A space fortress comes with a fixed orbital-AA emplacement (prototype scenario rule).
// It's a building now: its AA fires on near-orbit attackers, but it does NOT make the
// junction "defended" against a walk-in — only ground troops block ground capture.
function installFortressAA(planetId: string) {
  const pl = s.planets[planetId];
  if (!pl) return;
  if (pl.buildings.some((b) => b.type === 'orbital_aa')) return; // already emplaced
  pl.buildings.push({ type: 'orbital_aa', level: 1, hp: data.buildings.orbital_aa?.hp ?? 30 });
}

/** Apply a player-issued order and surface a rejection in the log (so a denied
 *  click — wrong orbit, no capacity, can't afford — isn't silently swallowed). */
// Kernel rejection codes → a human phrase (canonical Russian msgid → the locale
// translates). Unlisted codes fall back to the de-mangled code itself.
const ERR_RU: Record<string, string> = {
  E_INSUFFICIENT: 'не хватает ресурсов',
  E_NO_FUNDS: 'не хватает средств',
  E_BAD_TARGET: 'недопустимая цель',
  E_NO_TARGET: 'нет цели',
  E_FORBIDDEN: 'действие запрещено',
  E_NO_PLAYER: 'игрок не найден',
  E_NO_PLANET: 'мир не найден',
  E_NO_FLEET: 'флот не найден',
  E_BAD_PAYLOAD: 'некорректный приказ',
  E_FLEET_BUSY: 'флот занят',
  E_LIMIT: 'достигнут предел',
  E_CONDITIONS_UNMET: 'условия не выполнены',
  E_BOMBARDED: 'стройка под бомбардировкой',
  E_NO_SHIPYARD: 'нужна верфь/космопорт',
  E_WRONG_SECTOR: 'не тот тип сектора',
  E_WRONG_ORBIT: 'не та орбита',
  E_SAME_LOCATION: 'флот уже здесь',
  E_OWN_PLANET: 'это ваш собственный мир',
  E_OUT_OF_RANGE: 'вне радиуса действия',
  E_NO_SHIPS: 'нет кораблей',
  E_NO_CAPACITY: 'нет места в трюме',
  E_NO_ARTILLERY: 'нет артиллерии',
  E_UNKNOWN_UNIT: 'неизвестный юнит',
  E_UNKNOWN_BUILDING: 'неизвестное здание',
  E_UNKNOWN_TECHNOLOGY: 'неизвестная технология',
  E_RESEARCH_SLOTS_FULL: 'все исследовательские слоты заняты',
  E_TOO_EARLY: 'слишком рано',
  E_BOT_ALLIANCE: 'боты не вступают в коалиции',
  E_CONSENT_REQUIRED: 'нужно согласие второй стороны',
  E_ALREADY_OFFERED: 'предложение уже отправлено',
  E_ALREADY: 'уже действует',
  E_CHAT_RATE: 'не так быстро — подождите пару секунд',
  E_CHAT_TARGET: 'адресат не найден',
  E_CHAT_TEXT: 'пустое сообщение',
  E_NO_HERO: 'герой не найден',
  E_HERO_NOT_DEPLOYED: 'герой не развёрнут — сначала поднимите корабль',
  E_NO_CAPITAL: 'нет столицы для отзыва',
  E_BAD_EFFECT: 'способность настроена некорректно',
  E_HERO_DEAD: 'герой погиб — дождитесь возрождения',
  E_HERO_ALIVE: 'герой уже командует кораблём',
  E_HERO_CAP: 'достигнут предел развёрнутых героев',
  E_BAD_SPAWN: 'здесь нельзя развернуть героя',
  E_RESPAWN_COOLDOWN: 'герой ещё восстанавливается',
  E_NO_ABILITY: 'неизвестная способность',
  E_NOT_EQUIPPED: 'у героя нет этой способности',
  E_NO_EFFECT: 'эффект ещё не реализован',
  E_COOLDOWN: 'способность перезаряжается',
  E_NO_NODE: 'неизвестный узел дерева',
  E_ALREADY_UNLOCKED: 'узел уже изучен',
  E_WRONG_BRANCH: 'узел чужой ветви',
  E_REQUIRES: 'сначала изучите предыдущий узел',
  E_NO_FITTING: 'неизвестный фиттинг',
  E_ALREADY_FITTED: 'фиттинг уже установлен',
  E_NO_SLOTS: 'слоты фиттингов заняты',
  E_NOT_DESTRUCTIBLE: 'этот мир нельзя уничтожить',
  E_NO_TROOPS: 'мир защищён — для штурма нужен десант на борту',
  E_INTERNAL: 'внутренняя ошибка',
};
function errText(code: string): string {
  return t(ERR_RU[code] ?? code.replace(/^E_/, '').toLowerCase().replace(/_/g, ' '));
}
function playerOrder(action: Action) {
  if (NET && netClient) {
    netClient.sendAction(action); // server is authoritative — await its broadcast
    activeTour?.notifyAction(action.type); // optimistic — server result is async
    return;
  }
  // Net match, socket temporarily down (auto-reconnecting): DON'T run the local reducer
  // — the order would apply to `s`, look accepted on-screen, then vanish when the
  // reconnect `welcome` overwrites state (the server never saw it). Refuse with feedback
  // instead of silently losing it. (Solo/skirmish has `reconnecting === false`.)
  if (reconnecting) {
    note('⟳ ' + t('переподключение — приказ не отправлен, повтори через миг'));
    return;
  }
  const out = order(s, action, s.time);
  apply(out);
  if (out.error) note('✖ ' + errText(out.error));
  else {
    activeTour?.notifyAction(action.type); // an accepted intent advances `action` steps
    // ONB-5: the first fleet leaving on a course is when "the world runs offline"
    // becomes real — teach it once (but not mid-guide, where the tour owns the screen).
    if (action.type === 'fleet.move' && !activeTour?.active) maybeIntro('asyncDelay');
  }
}

// --- ONB-1 guide-mark launcher ------------------------------------------------
// One tour at a time; `playerOrder` above notifies it of accepted actions so a
// step's `advance: { on: 'action' }` fires on the real order. Exposed on `window`
// as the reusable seam ONB-0/ONB-2 (auto-offer, «Ещё → Обучение») and headless
// e2e drive — starting a HUD tour needs an active match, which those own.
let activeTour: RunningTour | null = null;
// Player build: the 'clock' step points at the pause/acceleration controls, which are
// stripped there (the server owns the clock in a net match) — drop it so the tour
// never narrates a control that doesn't exist. Dev client keeps the full chain.
const ORIENTATION_TOUR = __PLAYER_BUILD__
  ? HUD_ORIENTATION_TOUR.filter((step) => step.id !== 'clock')
  : HUD_ORIENTATION_TOUR;
function launchTour(steps = ORIENTATION_TOUR, onEnd?: (r: TourResult) => void): void {
  activeTour = startTour(steps, (r) => {
    activeTour = null;
    onEnd?.(r);
  });
}
interface TourWindow {
  __vdTour?: {
    start: (steps?: typeof HUD_ORIENTATION_TOUR) => void;
    stop: () => void;
    readonly active: boolean;
  };
}
(window as unknown as TourWindow).__vdTour = {
  start: (steps) => launchTour(steps),
  stop: () => activeTour?.stop(),
  get active() {
    return activeTour?.active ?? false;
  },
};

// --- ONB-0/ONB-2 first-run onboarding: flag + funnel + guided first match -----
// The "passed onboarding" signal lives per-nick in localStorage (separate from the
// saved callsign — a returning device can still be new to the guide). A brand-new
// commander gets a one-time hub offer; accepting (or «Ещё → Обучение») launches the
// ONB-2 guided first match: a bot-free solo sandbox with the data-described guide
// (firstMatchTour) walking produce→build→move→capture→score over the live HUD.
function onboardKey(): string {
  return 'vd.onboard.' + (nickInput.value.trim() || 'guest');
}
function loadOnboard(): OnboardState {
  return parseOnboardState(localStorage.getItem(onboardKey()));
}
function saveOnboard(st: OnboardState): void {
  localStorage.setItem(onboardKey(), JSON.stringify(st));
}
// A guide queued to launch once the next match's HUD is live (from installMatch).
let pendingGuide: (() => void) | null = null;
function maybeStartPendingTour(): void {
  if (!pendingGuide || NET) return;
  const run = pendingGuide;
  pendingGuide = null;
  requestAnimationFrame(run); // let the fresh HUD paint a frame so selectors resolve
}
const myScore = (): number => Math.round(s.match?.scores?.[ME]?.total ?? 0);
const myWorldCount = (): number => Object.values(s.planets).filter((p) => p.owner === ME).length;
// ONB-2: start a bot-free solo sandbox and arm the guided first match over its HUD.
function startGuidedMatch(): void {
  setupSlots = ['human', 'off', 'off', 'off']; // no rivals — a safe, calm sandbox
  setupStart = START_CANDIDATES[0] ?? MAP[0]!.id; // a deterministic homeworld
  pendingGuide = () => {
    const startScore = myScore();
    const startWorlds = myWorldCount(); // baseline: home only
    startFirstGoals(); // ONB-7: the first-session checklist rides alongside the guide
    launchTour(
      buildFirstMatchTour({
        capturedWorld: () => myWorldCount() > startWorlds,
        scoreRose: () => myScore() > startScore + 1,
      }),
      onGuidedTourEnded,
    );
  };
  showHub(false);
  showConnect(false);
  startMatch(buildSetupConfig()); // installMatch → maybeStartPendingTour runs the guide
}
// Fold the finished guide into the flag (+funnel); first completion earns XP + a nudge.
function onGuidedTourEnded(r: TourResult): void {
  const { state, rewarded } = applyTourOutcome(loadOnboard(), r);
  saveOnboard(state);
  if (rewarded) {
    const cur = loadMeta();
    const xp = matchXp({ won: false, score: 100 }); // a modest onboarding packet
    saveMeta({ ...cur, xp: cur.xp + xp });
    note(t('✔ Обучение пройдено · +{n} XP — теперь сыграй настоящий матч!', { n: xp }));
  }
  stopFirstGoals(); // ONB-7: the checklist belongs to the onboarding session only
  if (DEV_UI)
    console.debug(
      `[onboard] ${r.completed ? 'completed' : r.skipped ? 'skipped' : 'stopped'} @ step ${r.reachedStep + 1}`,
    );
}

// --- ONB-7 first-session goals checklist -------------------------------------
// A light "am I playing right?" list, shown only in the onboarding match: four
// goals tick from live state (mine built, fleet raised, world taken, 100 score),
// and finishing all four praises the player + nudges them to a real match.
let goalsActive = false;
let goalsCollapsed = false;
let goalsRewarded = false;
let goalsDone: string[] = [];
let goalBase = { worlds: 0, mines: 0, fleets: 0 };
const myMineCount = (): number =>
  Object.values(s.planets)
    .filter((p) => p.owner === ME)
    .reduce((n, p) => n + p.buildings.filter((b) => b.type === 'mine').length, 0);
const myFleetCount = (): number => Object.values(s.fleets).filter((f) => f.owner === ME).length;
function goalSignals(): GoalSignals {
  return {
    builtMine: myMineCount() > goalBase.mines,
    launchedFleet: myFleetCount() > goalBase.fleets,
    capturedWorld: myWorldCount() > goalBase.worlds,
    score: myScore(),
  };
}
function startFirstGoals(): void {
  goalBase = { worlds: myWorldCount(), mines: myMineCount(), fleets: myFleetCount() };
  goalsDone = [];
  goalsRewarded = false;
  goalsCollapsed = false;
  goalsActive = true;
  renderGoals();
}
function stopFirstGoals(): void {
  goalsActive = false;
  document.getElementById('goals')?.classList.remove('show');
}
// Called each frame while active: tick newly-met goals; all-done → praise + XP once.
function updateGoals(): void {
  if (!goalsActive) return;
  const next = mergeDone(goalsDone, metGoals(goalSignals()));
  if (next.length === goalsDone.length) return; // nothing new
  goalsDone = next;
  renderGoals();
  if (goalsComplete(goalsDone) && !goalsRewarded) {
    goalsRewarded = true;
    const cur = loadMeta();
    const bonus = 40;
    saveMeta({ ...cur, xp: cur.xp + bonus });
    note(
      t('🏅 Все цели первой сессии выполнены! +{n} XP — ты готов к настоящему матчу.', {
        n: bonus,
      }),
    );
  }
}
function renderGoals(): void {
  const el = document.getElementById('goals');
  if (!el) return;
  const items = FIRST_GOALS.map((g) => {
    const done = goalsDone.includes(g.id);
    return `<div class="gl-item${done ? ' done' : ''}"><span class="gl-ck">${done ? '✓' : '○'}</span><span>${esc(t(g.label))}</span></div>`;
  }).join('');
  el.innerHTML =
    `<div class="gl-box"><div class="gl-head"><b>${t('Цели первой сессии')}</b>` +
    `<span class="gl-count">${goalsDone.length}/${FIRST_GOALS.length}</span>` +
    `<button class="gl-tg" id="gl-tg" type="button">${goalsCollapsed ? '▸' : '▾'}</button></div>` +
    (goalsCollapsed ? '' : `<div class="gl-list">${items}</div>`);
  el.classList.add('show');
}
document.getElementById('goals')?.addEventListener('click', (ev) => {
  if ((ev.target as HTMLElement).closest('#gl-tg')) {
    goalsCollapsed = !goalsCollapsed;
    renderGoals();
  }
});
// Show the first-run offer to a not-yet-onboarded commander (idempotent per visit).
function refreshOnboardOffer(): void {
  const nudge = document.getElementById('onboard-nudge');
  if (nudge) nudge.style.display = welcomeMode(loadOnboard()) === 'new' ? 'flex' : 'none';
}
// «Начать обучение» / «Ещё → Обучение»: launch the guided first match.
function beginOnboarding(): void {
  saveOnboard(markStarted(loadOnboard()));
  const nudge = document.getElementById('onboard-nudge');
  if (nudge) nudge.style.display = 'none';
  startGuidedMatch();
}
document.getElementById('ob-start')?.addEventListener('click', beginOnboarding);
document.getElementById('ob-skip')?.addEventListener('click', () => {
  saveOnboard(markSkipped(loadOnboard())); // respected forever — never nagged again
  refreshOnboardOffer();
});
document.getElementById('hub-tutorial')?.addEventListener('click', beginOnboarding);

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

/** How many of `unit` are already promised to in-progress loads lifting from the
 *  SAME garrison (planet), so a queued load never over-draws a world's stock. Any
 *  fleet docked at `planetId` shares that garrison, so reservations span fleets. */
function pendingLoadUnits(planetId: string, unit: string): number {
  let n = 0;
  for (const p of pendingLoads) {
    if (p.unit !== unit) continue;
    if (s.fleets[p.fleetId]?.location === planetId) n++;
  }
  return n;
}

/** Queue a ~1h ground-army load if the hold has room AND the garrison still holds
 *  a free unit (both reserving for loads already under way), so the player can't
 *  over-fill the trim, nor queue more troops than the world can actually spare
 *  — which would later fire real `army.load`s that reject with `E_NO_ARMY`. */
function beginLoad(fleetId: string, unit: string): void {
  const f = s.fleets[fleetId];
  if (!f || f.movement || f.battleId || !f.location) return;
  const need = data.units[unit]?.stats.cargoSize ?? 1;
  if (need > fleetCargoFree(s, f) - pendingLoadCargo(fleetId)) {
    note('✖ ' + t('нет места в трюме')); // hold full once the loads already in progress land
    return;
  }
  // Match the core's acceptance: only a healthy, default-loadout garrison stack embarks.
  const stock = findHealthyStack(s.planets[f.location]!.garrison, unit)?.count ?? 0;
  if (pendingLoadUnits(f.location, unit) >= stock) {
    note('✖ ' + t('в гарнизоне не осталось')); // nothing left once the queued loads lift
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
/** PC ШТУРМ: send every selected fleet at `destId` (someone else's capturable world)
 *  and assault on arrival. A peaceful target/route stages the war prompt first —
 *  worded as "this is a friendly faction's world". */
function tryAssaultGroup(fleetIds: string[], destId: string): void {
  const movers = fleetIds.filter((id) => s.fleets[id]);
  if (!movers.length) return;
  const blockers = new Set<string>();
  for (const id of movers)
    for (const b of peaceBlockers(fleetNode(s.fleets[id]!), destId)) blockers.add(b);
  const owner = s.planets[destId]?.owner;
  if (owner != null && owner !== ME && !canTraverse(s, ME, owner)) blockers.add(owner);
  if (blockers.size) {
    warPrompt = { fleetIds: movers, destId, blockers: [...blockers], assault: true };
    renderWarPrompt();
    return;
  }
  dispatchAssault(movers, destId);
}
/** A defended world can only be stormed with landing troops aboard — pressing the
 *  assault anyway just spams E_NO_TROOPS rejections. */
function assaultNeedsTroops(f: Fleet, planetId: string): boolean {
  const defended = (s.planets[planetId]?.garrison ?? []).some((u) => u.count > 0);
  return defended && !(f.landing ?? []).some((u) => u.count > 0);
}
function dispatchAssault(fleetIds: string[], destId: string): void {
  let warnedNoTroops = false;
  for (const id of fleetIds) {
    const f = s.fleets[id];
    if (!f) continue;
    if (f.location === destId && !f.movement) {
      if (assaultNeedsTroops(f, destId)) {
        if (!warnedNoTroops) {
          warnedNoTroops = true;
          note(t('⚔ штурм невозможен: на борту нет десанта, а мир защищён — погрузите войска'), destId);
        }
        continue;
      }
      // already parked at the target — storm right away (orbit first if needed)
      if (f.orbit !== 'near') playerOrder(orbitFleet(ME, id, 'near'));
      playerOrder(assaultFleet(ME, id));
    } else {
      if (!warnedNoTroops && assaultNeedsTroops(f, destId)) {
        warnedNoTroops = true;
        note(t('⚔ внимание: на борту нет десанта — защищённый мир штурмом не взять'), destId);
      }
      playerOrder(moveFleet(ME, id, destId));
      assaultOnArrival.set(id, destId);
    }
  }
}
/** Fire the one-shot assault orders of fleets that reached their ШТУРМ target
 *  (runs each frame beside autoEngage). Redirected fleets drop the order. */
function pumpAssaultOrders(): void {
  if (!assaultOnArrival.size) return;
  for (const [id, destId] of [...assaultOnArrival]) {
    const f = s.fleets[id];
    if (!f) {
      assaultOnArrival.delete(id);
      continue;
    }
    if (f.movement) {
      if ((f.movement.destination ?? f.movement.to) !== destId) assaultOnArrival.delete(id); // re-routed by hand
      continue;
    }
    if (f.battleId) continue; // the arrival battle IS the assault path — wait it out
    if (f.location !== destId) {
      assaultOnArrival.delete(id); // parked elsewhere — the order lapsed
      continue;
    }
    const here = s.planets[destId];
    if (!here || here.owner === ME || here.owner == null) {
      assaultOnArrival.delete(id); // captured meanwhile / emptied — nothing to storm
      continue;
    }
    if (assaultNeedsTroops(f, destId)) {
      // one clear message instead of an E_NO_TROOPS rejection loop
      note(t('⚔ штурм невозможен: на борту нет десанта, а мир защищён — погрузите войска'), destId);
      assaultOnArrival.delete(id);
      continue;
    }
    if (f.orbit !== 'near') playerOrder(orbitFleet(ME, id, 'near'));
    playerOrder(assaultFleet(ME, id));
    assaultOnArrival.delete(id);
  }
}
/** As tryMoveGroup, but the target is a point on a lane (continuous order). Either lane
 *  endpoint sitting on PEACE territory blocks the march until war is declared. */
function tryMoveEdgeGroup(fleetIds: string[], edge: { from: string; to: string; t: number }): void {
  const blockers = new Set<string>();
  for (const id of fleetIds) {
    const node = fleetNode(s.fleets[id]!);
    for (const end of [edge.from, edge.to])
      for (const b of peaceBlockers(node, end)) blockers.add(b);
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
  if (wp.assault) {
    dispatchAssault(wp.fleetIds, wp.destId); // wars are declared → flies + storms on arrival
  } else {
    for (const id of wp.fleetIds) {
      if (wp.edge) playerOrder(moveFleetEdge(ME, id, wp.edge));
      else playerOrder(moveFleet(ME, id, wp.destId));
    }
  }
  note(t('⚔ Война объявлена — флоты выдвигаются'));
}
function cancelWarPrompt(): void {
  warPrompt = null;
  hideWarPrompt();
}
function renderWarPrompt(): void {
  const el = document.getElementById('warprompt');
  if (!el || !warPrompt) return;
  const names = warPrompt.blockers.map((b) => esc(blockerName(b))).join(', ');
  const body = warPrompt.assault
    ? t('Это мир дружественной фракции. Вы хотите объявить войну <b>{names}</b>?', { names })
    : t(
        'Маршрут проходит через миры <b>{names}</b>, с кем у вас <b>мир</b>. Мирного прохода нет — движение сюда объявит <b>войну</b>.',
        { names },
      );
  el.innerHTML =
    `<div class="wpbox">` +
    `<div class="wp-head">⚔ ${t('ОБЪЯВИТЬ ВОЙНУ?')}</div>` +
    `<div class="wp-body">${body}</div>` +
    `<div class="wp-actions"><button class="wp-no">${warPrompt.assault ? t('НЕТ') : t('ОТМЕНА')}</button>` +
    `<button class="wp-yes">${warPrompt.assault ? t('ДА') : t('ОБЪЯВИТЬ ВОЙНУ')}</button></div>` +
    `</div>`;
  el.classList.add('show');
}
function hideWarPrompt(): void {
  document.getElementById('warprompt')?.classList.remove('show');
}

const NAME: Record<string, string> = Object.fromEntries(SEAT_META.map((m) => [m.id, m.name]));
function syncPlayerNames(state: GameState): void {
  for (const [id, player] of Object.entries(state.players)) NAME[id] = player.name;
}
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
        // Fogged: a bots' brawl behind the fog is not our intel (NET already fogs
        // events server-side; this matches it for the local sim).
        if (p.attacker === ME || p.defender === ME || known(p.location as string))
          note(
            t('⚔️ бой у {at} ({phase})', {
              at: p.location as string,
              phase: p.phase === 'ground' ? t('десант') : t('орбита'),
            }),
            p.location as string,
          );
        if (p.attacker === ME || p.defender === ME) myBattleLocs.add(p.location as string);
        break;
      case 'battle.resolved': {
        const loc = p.location as string;
        if (myBattleLocs.has(loc) || known(loc)) {
          const losses = battleLosses.get(loc);
          const tally = losses
            ? Object.entries(losses)
                .map(([who, units]) => {
                  const total = Object.values(units).reduce((a, b) => a + b, 0);
                  return `${NAME[who] ?? who} −${total}`;
                })
                .join(', ')
            : '';
          note(
            t('⚔ бой у {at} завершён — {res}', {
              at: loc,
              res: p.winner
                ? t('победа: {who}', { who: NAME[p.winner as string] ?? (p.winner as string) })
                : t('ничья'),
            }) + (tally ? t(' · потери: {tally}', { tally }) : ''),
            loc,
          );
        }
        battleLosses.delete(loc);
        myBattleLocs.delete(loc);
        break;
      }
      case 'technology.researched':
        if (p.playerId === ME)
          note(
            t('⚛ изучено: {tech}', {
              tech: tData(
                data.technologies[p.technology as string]?.name ?? (p.technology as string),
              ),
            }),
          );
        if (techWin.classList.contains('show')) renderTech();
        break;
      // «Хранитель» lifecycle: snapshot at delegation, diff on expiry (the morning report).
      case 'steward.delegated':
        if (p.playerId === ME) {
          stewSnapshot = stewMetrics();
          note(
            (p as { posture?: string }).posture === 'active_defend'
              ? t(
                  '😴 Хранитель принял командование (Активная оборона) — держит рубежи и контратакует у своих миров.',
                )
              : t('😴 Хранитель принял командование (Оборона) — держит рубежи, пока вы спите.'),
          );
          if (stewWin.classList.contains('show')) renderSteward();
        }
        break;
      case 'steward.recalled':
        if (p.playerId === ME) {
          stewSnapshot = null;
          note(t('🎮 Вы вернули командование себе.'));
          if (stewWin.classList.contains('show')) renderSteward();
        }
        break;
      case 'steward.expired':
        if (p.playerId === ME) {
          const now = stewMetrics();
          const base = stewSnapshot;
          stewSnapshot = null;
          const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
          const diff = base
            ? ` Пока вы спали: планет ${base.planets}→${now.planets}, металл ${sign(now.metal - base.metal)}, кредиты ${sign(now.credits - base.credits)}.`
            : '';
          const logged = s.players[ME]?.stewardLog?.length ?? 0;
          const sitrep =
            logged > 0
              ? ' ' + t('Решений за вахту: {n} — журнал в окне Хранителя.', { n: String(logged) })
              : '';
          note(
            ((p as { posture?: string }).posture === 'active_defend'
              ? t('🌅 Хранитель вернул вам управление (была «Активная оборона»).')
              : t('🌅 Хранитель вернул вам управление (была «Оборона»).')) +
              diff +
              sitrep,
          );
          if (stewWin.classList.contains('show')) renderSteward();
        }
        break;
      // Both espionage events are addressed to the ACTOR (`owner`); in NET play the
      // server's fog filter already withholds them from the victim — mirror it here.
      case 'intel.stolen': {
        if (p.owner !== ME) break;
        const whoT = NAME[p.target as string] ?? (p.target as string);
        const what =
          p.kind === 'treasury'
            ? t('казна {who}', { who: whoT })
            : p.kind === 'fleets'
              ? t('флоты {who}', { who: whoT })
              : t('мир {at}', { at: String(p.intelPlanet ?? p.target) });
        note(t('🕵 Агент добыл разведданные: {what} — окно 24ч', { what }));
        pushSpyLog(t('🗝 Успех: {what}', { what }));
        if (diploOpen && diploTab === 'diplo') renderDiplo(); // the intel row appeared
        break;
      }
      case 'espionage.failed':
        if (p.owner === ME) {
          const whoF = NAME[p.target as string] ?? (p.target as string);
          note(t('🕵 Агент провалился ({who}) — плата сгорела', { who: whoF }));
          pushSpyLog(t('✖ Провал против {who} — плата сгорела', { who: whoF }));
        }
        break;
      // Counter-intel (SPY-2): addressed to the VICTIM. A failed attempt names the
      // spy (caught red-handed); a noticed clean theft only says WHAT leaked.
      case 'espionage.detected': {
        // A caught spy shifts the victim-bot's favour meter — repaint the roster.
        if (diploOpen && diploTab === 'diplo') renderDiplo();
        if (p.owner !== ME) break;
        const what =
          p.kind === 'treasury'
            ? t('казна')
            : p.kind === 'fleets'
              ? t('данные о флотах')
              : t('данные мира');
        {
          const line = p.spy
            ? t('🛡 Контрразведка: агент {who} пойман при попытке кражи ({what})!', {
                who: NAME[p.spy as string] ?? (p.spy as string),
                what,
              })
            : t('🛡 Контрразведка: утечка разведданных ({what}) — вор не установлен', { what });
          note(line);
          pushSpyLog(line);
        }
        break;
      }
      case 'planet.captured':
        if (p.owner === ME || known(p.planetId as string)) {
          note(
            t('🚩 {who} захватил {at}', {
              who: NAME[p.owner as string] ?? (p.owner as string),
              at: p.planetId as string,
            }),
            p.planetId as string,
          );
          // light the flipped province up in its new owner's colour (fog-gated: only
          // a capture we may see flashes) — re-capture restarts the wave.
          captureFlashes.set(p.planetId as string, {
            owner: p.owner as string,
            at: performance.now(),
          });
        }
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
            st === 'war'
              ? t('{a} объявил войну {b}', { a: na, b: nb })
              : t('{a} и {b}: {stance}', { a: na, b: nb, stance: stanceRu(st).toLowerCase() }),
            true,
            a,
          );
          note(`${na} → ${nb}: ${stanceRu(st)}`);
        }
        if (diploOpen && diploTab === 'diplo') renderDiplo();
        break;
      }
      case 'diplomacy.offered': {
        const from = p.from as string;
        const to = p.to as string;
        const st = p.stance as DiplomaticStance;
        if (to === ME) {
          note(
            t('🕊 {who} предлагает: {stance} — ответьте тем же в Дипломатии', {
              who: NAME[from] ?? from,
              stance: stanceRu(st),
            }),
          );
          pushMsg(from, t('Предложение: {stance}', { stance: stanceRu(st) }), true, from);
          unreadMsgs++;
        } else if (from === ME && !isAiSeat(to)) {
          // A bot answers inside the same order (accept/decline follows in this very
          // batch) — the "sent" line is only worth showing when a human must reply.
          note(
            t('⏳ {who}: предложение отправлено — {stance}', {
              who: NAME[to] ?? to,
              stance: stanceRu(st),
            }),
          );
        }
        if (diploOpen && diploTab === 'diplo') renderDiplo();
        break;
      }
      case 'diplomacy.declined': {
        const from = p.from as string;
        const to = p.to as string;
        const st = p.stance as DiplomaticStance;
        if (from === ME) {
          pushMsg(
            to,
            t('{who} отклонил предложение: {stance}', {
              who: NAME[to] ?? to,
              stance: stanceRu(st),
            }),
            true,
            to,
          );
          note(t('✖ {who} отклонил: {stance}', { who: NAME[to] ?? to, stance: stanceRu(st) }));
        }
        if (diploOpen && diploTab === 'diplo') renderDiplo();
        break;
      }
      case 'building.constructed':
        note(
          t('🏗️ {b}: построено на {at}', {
            b: buildingName(p.building as string),
            at: p.planetId as string,
          }),
        );
        if (p.building === 'starfort') installFortressAA(p.planetId as string);
        break;
      case 'building.upgraded':
        note(
          t('⬆️ {b} → L{lvl} на {at}', {
            b: buildingName(p.building as string),
            lvl: String(p.level),
            at: p.planetId as string,
          }),
        );
        break;
      case 'building.destroyed':
        note(
          t('💥 {b}: разрушено на {at}', {
            b: buildingName(p.building as string),
            at: p.planetId as string,
          }),
          p.planetId as string,
        );
        break;
      case 'unit.built':
        note(`🛠️ ${p.count}× ${displayUnit(p.unit as string)} · ${p.planetId}`);
        break;
      case 'fleet.launched':
        note(
          t('🚀 {who} поднял флот с {at}', {
            who: NAME[p.owner as string] ?? (p.owner as string),
            at: p.planetId as string,
          }),
        );
        break;
      case 'aa.fired': {
        const planet = s.planets[p.planetId as string];
        if (!planet || !known(p.planetId as string)) break; // fogged flak stays unseen
        const target = s.fleets[p.fleetId as string];
        const to = (target && fleetPos(target)) ?? {
          x: planet.position.x + 6,
          y: planet.position.y - 14, // the victim died this volley — burst over the orbit
        };
        aaShots.push({
          from: { ...planet.position },
          to,
          at: performance.now(),
          close: p.tier === 'close',
        });
        while (aaShots.length > 40) aaShots.shift();
        break;
      }
      case 'artillery.fired': {
        // Standoff bombardment: arc from the shooter to its victim. Endpoints are
        // captured NOW — the victim may already be wiped from the state (the core
        // emits after damage), so fall back to the `near` node anchor it sent.
        const shooter = s.fleets[p.fleetId as string];
        const from = shooter && fleetPos(shooter);
        if (!from) break;
        const anchorNode = (id: string | null | undefined) =>
          id ? (s.planets[id]?.position ?? null) : null;
        const victim = s.fleets[p.target as string];
        const to = (victim && fleetPos(victim)) ?? anchorNode(p.near as string);
        if (!to) break;
        // Fog: show the exchange only if either end sits on a node we can see.
        const shooterNode = shooter.location ?? shooter.edge?.from;
        const nearNode = (p.near as string) ?? '';
        if (!(shooterNode && known(shooterNode)) && !known(nearNode)) break;
        siegeShots.push({
          from: { ...from },
          to: { x: to.x, y: to.y },
          at: performance.now(),
          seed: siegeSeed++,
        });
        while (siegeShots.length > 24) siegeShots.shift();
        break;
      }
      case 'market.bought':
        if (p.seller === ME || p.buyer === ME)
          note(
            t('⇄ биржа: {n} {res} за {paid} ¤ ({side})', {
              n: String(p.amount),
              res: TECH_CUR[p.resource as string] ?? tData(p.resource as string),
              paid: String(p.paid ?? '?'),
              side: p.buyer === ME ? t('покупка') : t('продажа'),
            }),
          );
        break;
      case 'fleet.merged':
        if (p.owner === ME) note(t('⛬ флоты объединены у {at}', { at: p.at as string }));
        break;
      case 'fleet.split':
        if (p.owner === ME) note(t('⊟ флот разделён у {at}', { at: p.at as string }));
        break;
      case 'fleet.destroyed':
        note(t('☠️ флот {who} уничтожен', { who: NAME[p.owner as string] ?? (p.owner as string) }));
        break;
      case 'unit.died': {
        // War record — only count casualties in battles you're part of, so the AI's
        // fights elsewhere don't pad your numbers. Your dead = lost; the rest = destroyed.
        if (myBattleLocs.has(p.at as string)) {
          const n = (p.count as number) ?? 0;
          if (p.owner === ME) killStats.lost += n;
          else killStats.destroyed += n;
        }
        // Ledger for the battle-result card (visible fights only).
        if (myBattleLocs.has(p.at as string) || known(p.at as string)) {
          const at = p.at as string;
          const owner = (p.owner as string) ?? '?';
          const perOwner = battleLosses.get(at) ?? {};
          const perUnit = (perOwner[owner] ??= {});
          perUnit[p.unit as string] = (perUnit[p.unit as string] ?? 0) + ((p.count as number) ?? 0);
          battleLosses.set(at, perOwner);
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
  // «Хранитель»: while your own seat is delegated, the local AI plays it too — on its
  // posture (defend), so solo delegation actually holds the line, not just shows a timer.
  const myPosture = stewardActive(s, ME, s.time);
  if (myPosture && !AI_PLAYERS.has(ME)) {
    for (const a of aiOrders(s, ME, myPosture)) apply(order(s, a, s.time));
  }
}

// Enemy (AI) auto-engagement: an idle hostile fleet over a world it doesn't own,
// with the orbit clear, descends and lands automatically — keeps the AI pressing
// the capture loop. The player's own fleets are driven by hand (orbit/bombard/
// assault controls in the fleet panel), so they are skipped here.
function autoEngage() {
  for (const f of Object.values(s.fleets)) {
    if (f.location == null || f.movement || f.battleId) continue;
    const mine = f.owner === ME;
    // AI fleets always press the capture loop; the player's do so only when opted into
    // auto-storm (CC-2) — otherwise the player drives assaults by hand.
    if (mine && !autoAssault.has(f.id)) continue;
    if (!SECTOR_TYPES[SECTOR_OF[f.location]]?.capturable) continue; // empty space can't be taken
    const here = s.planets[f.location];
    if (!here || here.owner === f.owner) continue;
    const enemyHere = Object.values(s.fleets).some(
      (g) => g.owner !== f.owner && g.location === f.location && g.units.some((u) => u.count > 0),
    );
    if (enemyHere) continue; // let the auto orbital battle settle first
    // A defended world + no landing troops = the assault can only be rejected
    // (E_NO_TROOPS) — skip instead of re-pressing it every frame (toast spam).
    if (here.garrison.some((u) => u.count > 0) && !(f.landing ?? []).some((u) => u.count > 0)) continue;
    // Player fleets go through playerOrder (server-authoritative in net play); AI applies locally.
    const issue = (a: Action) => (mine ? playerOrder(a) : apply(order(s, a, s.time)));
    if (f.orbit !== 'near') issue(orbitFleet(f.owner, f.id, 'near'));
    issue(assaultFleet(f.owner, f.id));
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

/** The CC-2 auto-storm stance of a fleet — authoritative state in NET, local Set solo. */
function isAutoAssault(fleetId: string): boolean {
  return NET
    ? ((s as { autoAssault?: Record<string, true> }).autoAssault?.[fleetId] ?? false)
    : autoAssault.has(fleetId);
}
/** The CC-4 standing patrol of a fleet — authoritative state in NET, local Map solo. */
function patrolOf(fleetId: string): Patrol | undefined {
  return NET
    ? (s as { patrols?: Record<string, Patrol> }).patrols?.[fleetId]
    : patrols.get(fleetId);
}
/** CC-2: set the auto-storm stance UNIFORMLY on the given own fleets (☰-row toggle —
 *  a mixed group snaps to one state instead of flipping each). Authoritative in NET
 *  (order.auto — the server presses the storm while you're offline), local Set solo. */
function setAutoAssault(ids: string[], on: boolean): void {
  for (const id of ids) {
    if (!s.fleets[id] || s.fleets[id]!.owner !== ME) continue;
    if (isAutoAssault(id) === on) continue;
    if (NET) playerOrder(orderAuto(ME, id, on));
    else if (on) autoAssault.add(id);
    else autoAssault.delete(id);
  }
}
/** CC-4: stand (or stand down) «дежурный вылет» UNIFORMLY on the given fleets' wings.
 *  Authoritative in NET (order.scramble — the server computes the patrol and flies it
 *  while you're offline); the local Map + frame-loop driver in solo. */
function setScramble(ids: string[], on: boolean): void {
  for (const id of ids) {
    const f = s.fleets[id];
    if (!f || f.owner !== ME || !fleetHasSquadron(f)) continue;
    if (!!patrolOf(id) === on) continue;
    if (!on) {
      if (NET) playerOrder(orderScramble(ME, id, false));
      else {
        // Stash the wing's sortie so OFF→ON resumes it (BF-26) instead of a free full tank.
        const pt = patrols.get(id);
        if (pt) wingSorties.set(id, pt.sortie);
        patrols.delete(id);
      }
      continue;
    }
    const pos = f.location ? s.planets[f.location]?.position : undefined;
    if (!pos) {
      note(t('🛩 дежурный вылет — только со стоянки в узле'));
      continue;
    }
    // Mirror the reducer's order.scramble gate (game.ts): a patrol only stands from a
    // parked, out-of-combat wing. Without this, solo would arm a patrol the net path
    // rejects (E_CONDITIONS_UNMET), and the UI would offer an action the server refuses.
    if (!fleetIdle(f)) {
      note(t('🛩 дежурный вылет — только когда флот свободен'));
      continue;
    }
    if (NET) {
      playerOrder(orderScramble(ME, id, true));
    } else {
      if (patrols.size === 0) lastPatrolTick = s.time; // start the rearm cadence from now
      const spec = sortieSpec(f);
      const stashed = wingSorties.get(id);
      patrols.set(id, {
        center: { x: pos.x, y: pos.y },
        radius: squadronStrikeRange(f),
        // Resume the stashed sortie (clamped to the current wing spec), like the server;
        // only a never-flown wing starts on a fresh full tank.
        sortie: stashed
          ? {
              fuel: Math.min(stashed.fuel, spec.maxFuel),
              rearming: Math.min(stashed.rearming, spec.rearmRounds),
            }
          : freshSortie(spec.maxFuel),
      });
      wingSorties.delete(id);
    }
  }
}
/** «≈14ч» / «≈2д 3ч» — plan durations are game-hours, like every duration in the UI. */
function fmtHrs(h: number): string {
  const r = Math.max(0, Math.round(h));
  return r >= 48 ? t('{d}д {h}ч', { d: Math.floor(r / 24), h: r % 24 }) : t('{n}ч', { n: r });
}

// CC-4 reactive auto-scramble driver: each frame, a squadron fleet on "дежурный вылет"
// that's idle auto-sorties at the lowest-id identified, at-war contact inside its strike
// radius — burning one fuel (SQ-2.1) — and rearms one round per elapsed game-hour. The
// pure decision is scrambleOrder (tested); this just reads the world (vision + diplomacy)
// CC-1 chain driver (solo): the same pure core the netserver runs — stamp the chain
// forward (consume-on-issue), then issue the head step's orders. In net play the
// server drives chains; this runs only inside the solo sim block of the frame loop.
function driveChains(): void {
  for (const c of serverChainActions(s, s.time)) {
    const issue = (a: Action) => (c.owner === ME ? playerOrder(a) : apply(order(s, a, s.time)));
    if (c.patch) issue(chainStamp(c.owner, c.fleetId, c.patch.steps, c.patch.waitUntil));
    for (const a of c.actions) issue(a);
  }
}

// and issues the order. Same host-side shape as autoEngage/driveQueues; single-player only
// (net play → the server owns fleets — promoting this server-side is the CC-server brick).
function drivePatrols(): void {
  if (patrols.size === 0) return;
  const rounds = Math.max(0, Math.floor((s.time - lastPatrolTick) / HOUR));
  if (rounds > 0) lastPatrolTick += rounds * HOUR;
  for (const [fid, p] of [...patrols]) {
    const f = s.fleets[fid];
    if (!f || f.owner !== ME || !fleetHasSquadron(f)) {
      patrols.delete(fid);
      continue;
    }
    const spec = sortieSpec(f);
    for (let i = 0; i < rounds && p.sortie.rearming > 0; i++)
      p.sortie = tickRearm(p.sortie, spec.maxFuel);
    if (!fleetIdle(f)) continue; // busy (transit / battle) — let it resolve first
    // Hostile, identified contacts parked on a node — the wing's legal targets.
    const targets: Array<{ id: string; location: string; pos: { x: number; y: number } }> = [];
    for (const g of Object.values(s.fleets)) {
      if (g.owner === ME || !g.location || g.movement || !g.units.some((u) => u.count > 0))
        continue;
      if (g.battleId) continue; // in a battle — engage would reject, yet the sortie fuel is spent (BF-30)
      if (getStance(s, ME, g.owner) !== 'war') continue; // only declared enemies — never auto-war
      if (!known(g.location)) continue; // identified only — "опознанная цель в зоне видимости"
      const pos = s.planets[g.location]?.position;
      if (pos) targets.push({ id: g.id, location: g.location, pos });
    }
    const { action, sortie } = scrambleOrder(ME, f, p, targets, spec.rearmRounds);
    p.sortie = sortie;
    if (action) playerOrder(action);
  }
}

/** How the match ended, in plain words (perspective comes from the prefix). */
function endReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'domination':
      return t('доминированием в галактике');
    case 'elimination':
      return t('уничтожением соперников');
    case 'score':
      return t('достижением лимита очков');
    case 'timeout':
      return t('истечением времени');
    default:
      return t('матч завершён');
  }
}

/** Terminal banner read from the AUTHORITATIVE `match` state (the victory module
 *  in the kernel — local sim and the net server both run it), not a hand-rolled
 *  guess. Fires once; a draw (no winner on timeout) is its own line. */
function checkEnd() {
  // `xpAwarded` marks this match's end as already handled — it survives navigating
  // away (hub/setup) while the match stays 'ended', so the overlay isn't re-created
  // over the menu; only a fresh match / reconnect resets it.
  if (endScreen || xpAwarded) return;
  if (s.match?.status !== 'ended') return;
  const why = endReasonText(s.match.reason);
  // A coalition wins together (SES-1): every member of match.winners is a victor,
  // not only the top scorer in match.winner.
  const iWon = s.match.winner === ME || (s.match.winners?.includes(ME) ?? false);
  const draw = !iWon && s.match.winner === null;
  // Meta-progression: one XP award per finished match (прокачка командующего).
  // `xpAwarded` alone is a per-INSTALL latch — a reconnect to an already-ended
  // match resets it (net welcome handler), so refreshing the page would farm the
  // award repeatedly. A durable per-match marker (keyed by the match's endedAt,
  // unique per finished match for this nick) makes the award idempotent; the
  // recorded amount replays on the end screen instead of a misleading «+0».
  let gained = 0;
  let levelUp: number | null = null;
  const awardKey = 'vd.xpawarded.' + (nickInput.value.trim() || 'guest');
  const endStamp = String(s.match.endedAt ?? 'ended');
  let prior: { at: string; xp: number } | null = null;
  try {
    prior = JSON.parse(localStorage.getItem(awardKey) ?? 'null') as typeof prior;
  } catch {
    prior = null; // a corrupt marker never blocks the flow — fail open to a fresh award
  }
  if (!xpAwarded) {
    xpAwarded = true;
    if (prior?.at === endStamp) {
      gained = prior.xp; // this match already paid out — just replay the receipt
    } else {
      const st = loadMeta();
      gained = matchXp({ won: iWon, score: s.match.scores?.[ME]?.total ?? 0 });
      const before = metaLevel(st.xp);
      const after = { xp: st.xp + gained, spent: st.spent };
      saveMeta(after);
      localStorage.setItem(awardKey, JSON.stringify({ at: endStamp, xp: gained }));
      if (metaLevel(after.xp) > before) levelUp = metaLevel(after.xp);
    }
  }
  // The full end screen (renderEndScreen) reads this — outcome, reason, XP. The old
  // thin victory `banner` is retired; `banner` now carries only NET-status lines.
  endScreen = { won: iWon, draw, why, xp: gained, levelUp, dismissed: false };
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

function drawBattlePulse(
  x: number,
  y: number,
  pulse: number,
  phase: 'orbital' | 'ground' = 'orbital',
) {
  // Two DIFFERENT pictures for the two battle phases (the audit found them
  // indistinguishable): orbital = the familiar red expanding rings (a dogfight in
  // space); ground = an amber pulse hugging the surface + a flat "front line" bar.
  const col = phase === 'ground' ? '#f0b429' : '#ff5a4d';
  cx.save();
  cx.shadowColor = col;
  cx.shadowBlur = 12;
  for (let i = 0; i < 3; i++) {
    const k = (pulse + i / 3) % 1;
    cx.strokeStyle = rgba(col, 0.55 * (1 - k));
    cx.lineWidth = 1.2 + i * 0.25;
    cx.beginPath();
    if (phase === 'ground') {
      cx.setLineDash([5, 4]);
      cx.arc(x, y, 14 + k * 12, 0, TAU); // tight, dashed — clamped to the world
    } else {
      cx.arc(x, y, 18 + k * 24, 0, TAU);
    }
    cx.stroke();
  }
  if (phase === 'ground') {
    cx.setLineDash([]);
    cx.strokeStyle = rgba(col, 0.85);
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(x - 10, y + 16);
    cx.lineTo(x + 10, y + 16); // the front line under the world
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

/** While ШТУРМ is armed (PC): ring every valid target — someone else's capturable
 *  world (enemy or friendly faction alike; the friendly path asks to declare war). */
function drawAssaultTargets() {
  if (!assaultAim) return;
  cx.save();
  cx.strokeStyle = 'rgba(255,90,77,.85)';
  cx.lineWidth = 1.6;
  cx.setLineDash([4, 4]);
  cx.shadowColor = '#ff5a4d';
  cx.shadowBlur = 8;
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p || p.owner == null || p.owner === ME) continue;
    if (!(SECTOR_TYPES[SECTOR_OF[n.id]]?.capturable ?? false)) continue;
    const c = world(n);
    cx.beginPath();
    cx.arc(c.x, c.y, 16, 0, TAU);
    cx.stroke();
  }
  cx.restore();
}

/** While "Move" is armed: a dashed line from each selected fleet to the world under
 *  the pointer (snaps to the nearest blip) — preview before committing. */
function drawAimPreview() {
  if (!(aiming || assaultAim) || !aimPointer) return;
  const ids = selectedFleetIds();
  if (!ids.length) return;
  // Prefer a node target; if none is near, aim at the closest point ON a lane —
  // the army will route to that road and park there (Bytro continuous order).
  // The node pick radius MUST match selectAt's rNode (24px mouse / 30px touch):
  // any mismatch makes the preview draw a path the release will not dispatch.
  let target: { x: number; y: number } | null = null;
  let targetId: string | null = null;
  let best = tapByTouch ? 30 : 24;
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
    const anchor = fleetAnchor(f);
    if (!anchor) continue;
    // draw the ROUTED march path through province centres (Bytro-style), so you
    // see the actual road the army will take — not a straight line to the target.
    const from = fleetNode(f);
    const a: { x: number; y: number } = anchor;
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

/** The owner of node `id` AS THE VIEWER MAY KNOW IT: live when identified (or fog
 *  off), last-known from memory when only remembered, unknown otherwise. The
 *  political fill and its cache signature both read THIS, never the raw truth —
 *  the map must not repaint a hidden capture (an intel leak the fog exists to stop). */
function knownOwner(id: string): string | null {
  if (known(id)) return s.planets[id]?.owner ?? null;
  return memory.get(id)?.owner ?? null;
}
function ownersSig(): string {
  let out = '';
  for (const n of MAP) out += (knownOwner(n.id) ?? '·') + ',';
  return out;
}

/** Rebuild the cached province map when the camera/ownership/viewport moves. */
function buildStaticLayer(): void {
  // Rebuild only when the content/size changes, or when the camera has SETTLED at a
  // new spot. During an active pan/zoom we skip the O(n²) re-tessellation entirely
  // and let blitStaticLayer follow the camera with the last bake (transformed).
  const content = `${VW}x${VH}:${DPR.toFixed(2)}|${ME}|${ownersSig()}|${starfield ? 1 : 0}`;
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
  // Graphics pref: `starfield` off leaves the flat fill + grid (nebulae/stars skipped).
  if (starfield)
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
  if (starfield)
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
    seeds.push({ x: c.x, y: c.y, w: (p.size ?? 1) * W, owner: knownOwner(n.id), kind: n.sector });
  }
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
  // Weighted-Voronoi political fill + classified borders — the shared @void/client
  // territory renderer clamps the weights (so no cell is swallowed), tessellates the
  // power diagram, fills each province in its owner's colour, and draws same-owner
  // inner hairlines vs glowing owner frontiers. Fog is honoured upstream: each seed
  // carries the owner AS THE VIEWER KNOWS IT (knownOwner), so a hidden capture never
  // repaints the map. Owned land is painted strongly (who-holds-what at a glance);
  // neutral stays a faint wash; a faint terrain tint reads through per sector kind.
  drawTerritory(g, seeds, clip, {
    ownerColor,
    neutralFill: COLOR.null!,
    kindAccent: (kind) => SECTOR_TYPES[kind]?.color,
  });

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
  // Semantic zoom (LOD): zoomed far out the map turns SCHEMATIC — holo type
  // badges, callout text, fleet pyramids/cargo/counts, orbit rings and battle
  // timers dissolve away (a globalAlpha cross-fade over scale 1.2→1.45, fully
  // schematic below), leaving territories, node art, fleet chevrons, battle
  // pulses and pings. Skipping those draws over the widest views — where the
  // most nodes are on screen at once — is also the frame-time win.
  const detail = clamp((cam.scale - 1.2) / 0.25, 0, 1);
  blitStaticLayer(); // backdrop + province political map (re-baked on camera move, else cached)
  drawCaptureFlashes(now); // wave over a just-flipped province, over the political fill
  drawScanSweep(now); // slow radar sweep — pure console chrome
  updateRadarContacts(now); // the arm paints enemy signatures as it crosses them
  updateThreatAlerts(); // «враг у ваших рубежей» — once per game step
  drawRadarCoverage(); // my sensor reach (radar arrays + ships)

  drawFleetRoutes();
  drawGoFlash(now); // brief ring on a world reached via a plan row's target link

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
    drawBattlePulse(c.x, c.y, wave, b.phase);
    if (typeof b.nextRoundAt === 'number' && detail > 0) {
      cx.save();
      cx.globalAlpha = detail; // LOD: the timer text dissolves on the schematic view
      cx.font = '700 10px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.fillStyle = b.phase === 'ground' ? '#f5cf6b' : '#ff8a7d';
      cx.fillText(
        `${b.phase === 'ground' ? t('⚒ десант') : t('⚔ орбита')} · ${timeLeft(b.nextRoundAt)}`,
        c.x,
        c.y - 28,
      );
      cx.restore();
    }
  }

  // orbital-AA flak (H2): a dashed ground-to-orbit tracer with a burst at the
  // target end, fading out — a fleet under AA fire no longer melts silently.
  if (aaShots.length) {
    const nowMs = performance.now();
    cx.save();
    for (let i = aaShots.length - 1; i >= 0; i--) {
      const shot = aaShots[i]!;
      const age = nowMs - shot.at;
      if (age > 700) {
        aaShots.splice(i, 1);
        continue;
      }
      const a = world(shot.from);
      const b = world(shot.to);
      if (!visible(a, 160) && !visible(b, 160)) continue;
      const fade = 1 - age / 700;
      // Two tiers, two looks: the hourly ORBITAL volley is a heavy orange lance;
      // the 15-minute CLOSE flak is a thinner, paler stitch with a smaller burst.
      const col = shot.close ? '#9adfe8' : '#ff8a3d';
      cx.strokeStyle = rgba(col, (shot.close ? 0.55 : 0.7) * fade);
      cx.lineWidth = shot.close ? 0.8 : 1.1;
      cx.setLineDash(shot.close ? [2, 4] : [3, 5]);
      cx.lineDashOffset = -age / 12; // the tracer visibly climbs from the surface
      cx.shadowColor = col;
      cx.shadowBlur = shot.close ? 5 : 8;
      cx.beginPath();
      cx.moveTo(a.x, a.y);
      cx.lineTo(b.x, b.y);
      cx.stroke();
      cx.setLineDash([]);
      cx.fillStyle = rgba(shot.close ? '#d9f4f7' : '#ffd29b', 0.8 * fade);
      cx.beginPath();
      cx.arc(b.x, b.y, (shot.close ? 1.5 : 2) + (age / 700) * (shot.close ? 3 : 5), 0, TAU);
      cx.fill();
    }
    cx.restore();
  }

  // Siege bombardment (artillery.fired): a ballistic ARC from the shooter to its
  // victim with a stagger of shell particles and impact bursts — the map answers
  // «who is shelling whom» at a glance. Endpoints are map-space; projected each
  // frame so the volley tracks pan/zoom.
  if (siegeShots.length) {
    const nowMs = performance.now();
    const SHELLS = 3; // shells per volley, launched in a stagger
    const FLIGHT = 780; // ms a shell spends on the arc
    const STAGGER = 130; // ms between shell launches
    const BURST = 520; // ms an impact burst lives
    const LIFE = FLIGHT + STAGGER * (SHELLS - 1) + BURST;
    // LOD: the volley stays visible on the schematic view (a battle is a signal),
    // but compact — arcs/bursts shrink with the node art so they can't swallow a
    // zoomed-out province.
    const sk = 0.45 + 0.55 * detail;
    cx.save();
    for (let i = siegeShots.length - 1; i >= 0; i--) {
      const shot = siegeShots[i]!;
      const age = nowMs - shot.at;
      if (age > LIFE) {
        siegeShots.splice(i, 1);
        continue;
      }
      const a = world(shot.from);
      const b = world(shot.to);
      if (!visible(a, 200) && !visible(b, 200)) continue;
      // Ballistic lob: the mid-point lifts straight up in screen space, scaled by
      // the span — long-range fire arches higher, point-blank stays flat-ish.
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const lift = Math.min(64 * sk, Math.max(16 * sk, dist * 0.24));
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - lift };
      const q = (t: number) => ({
        x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
        y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
      });
      // 1) the traced arc — a faint amber dashed path up to the lead shell.
      const lead = Math.min(1, age / FLIGHT);
      const pathFade = Math.max(0, 1 - age / LIFE);
      cx.strokeStyle = rgba('#ffb066', 0.34 * pathFade);
      cx.lineWidth = 1;
      cx.setLineDash([4, 5]);
      cx.lineDashOffset = -age / 16;
      cx.beginPath();
      cx.moveTo(a.x, a.y);
      const STEPS = 18;
      for (let sgm = 1; sgm <= Math.ceil(STEPS * lead); sgm++) {
        const pt = q(Math.min(lead, sgm / STEPS));
        cx.lineTo(pt.x, pt.y);
      }
      cx.stroke();
      cx.setLineDash([]);
      // 2) the shells — bright tracer dots with a short glowing tail.
      cx.shadowColor = '#ffb066';
      for (let sh = 0; sh < SHELLS; sh++) {
        const t = (age - sh * STAGGER) / FLIGHT;
        if (t <= 0 || t >= 1) continue;
        const pt = q(t);
        const tail = q(Math.max(0, t - 0.06));
        cx.strokeStyle = rgba('#ffd29b', 0.85);
        cx.lineWidth = 1.6;
        cx.shadowBlur = 7;
        cx.beginPath();
        cx.moveTo(tail.x, tail.y);
        cx.lineTo(pt.x, pt.y);
        cx.stroke();
        cx.fillStyle = rgba('#fff1dc', 0.95);
        cx.beginPath();
        cx.arc(pt.x, pt.y, 1.7, 0, TAU);
        cx.fill();
      }
      cx.shadowBlur = 0;
      // 3) impacts — each landed shell pops an expanding ring + sparks on stable
      // per-volley angles (seeded — no per-frame randomness, replays stay clean).
      for (let sh = 0; sh < SHELLS; sh++) {
        const landed = age - (sh * STAGGER + FLIGHT);
        if (landed < 0 || landed > BURST) continue;
        const k = landed / BURST;
        const burstFade = 1 - k;
        // Hot core flash first — the «попал!» read — then the expanding ring.
        if (k < 0.45) {
          cx.fillStyle = rgba('#fff1dc', 0.9 * (1 - k / 0.45));
          cx.shadowColor = '#ff8a3d';
          cx.shadowBlur = 10;
          cx.beginPath();
          cx.arc(b.x, b.y, (3.2 - k * 3) * sk, 0, TAU);
          cx.fill();
          cx.shadowBlur = 0;
        }
        cx.strokeStyle = rgba('#ff8a3d', 0.75 * burstFade);
        cx.lineWidth = 1.6;
        cx.beginPath();
        cx.arc(b.x, b.y, (2 + k * 14) * sk, 0, TAU);
        cx.stroke();
        cx.fillStyle = rgba('#ffd29b', 0.85 * burstFade);
        for (let spk = 0; spk < 5; spk++) {
          const ang = ((shot.seed * 7 + sh * 5 + spk) % 12) * (TAU / 12) + 0.35;
          const r = (4 + k * 14) * sk;
          cx.beginPath();
          cx.arc(
            b.x + Math.cos(ang) * r,
            b.y + Math.sin(ang) * r * 0.8,
            Math.max(0.8, 1.3 * sk),
            0,
            TAU,
          );
          cx.fill();
        }
      }
    }
    cx.restore();
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

  // planets — wireframe blips with sensor rings + monospace callouts.
  // LOD: the blip and every screen-space satellite around it (aura, sensor ring,
  // badges, sphere, ticks) draw at R×ns — 45% on the schematic view, so far-out
  // provinces aren't swallowed by their own markers (owner-reported APK pile-up
  // at min zoom: node art + badges + fx stacked on top of each other).
  cx.textAlign = 'left';
  const ns = 0.45 + 0.55 * detail; // node scale: schematic → detail
  const R = 13 * ns;
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

    // province-type badge — a holographic type icon that HOVERS above the province:
    // a projected hologram (soft glow halo + holo capsule ring + a faint projector
    // tether down to the node), gently bobbing in the sector-type colour so the type
    // reads at a glance regardless of the bespoke art below (planet / asteroid / …).
    if (KIND_ICON[n.sector] && detail > 0) {
      const kc = SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? '#9fb6bd';
      const bob = Math.sin(now / 700 + n.x * 0.021 + n.y * 0.017) * 2.4;
      const brad = 11;
      const bx = c.x;
      const by = c.y - R - 6 - brad - 6 + bob; // badge centre floats above, softly bobbing
      cx.save();
      cx.globalAlpha = detail; // LOD: the hologram dissolves on the schematic view
      blitGlow(kc, bx, by, brad + 9, 0.5); // holographic bloom (cached disc)
      // projector tether — a faint dashed beam from the node up to the badge
      cx.strokeStyle = rgba(kc, 0.16);
      cx.setLineDash([2, 3]);
      cx.lineWidth = 1;
      cx.beginPath();
      cx.moveTo(bx, c.y - R);
      cx.lineTo(bx, by + brad);
      cx.stroke();
      cx.setLineDash([]);
      // holo capsule: translucent disc + bright rim + inner scanline ring
      cx.fillStyle = rgba(kc, 0.12);
      cx.beginPath();
      cx.arc(bx, by, brad, 0, TAU);
      cx.fill();
      cx.strokeStyle = rgba(kc, 0.6);
      cx.lineWidth = 1.2;
      cx.beginPath();
      cx.arc(bx, by, brad, 0, TAU);
      cx.stroke();
      cx.strokeStyle = rgba(kc, 0.26);
      cx.beginPath();
      cx.arc(bx, by, brad - 3, 0, TAU);
      cx.stroke();
      // the type glyph, glowing in the sector colour
      cx.font = '700 15px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      cx.shadowColor = kc;
      cx.shadowBlur = 5;
      cx.fillStyle = rgba(kc, 0.95);
      cx.fillText(KIND_ICON[n.sector]!, bx, by + 0.5);
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
      if (fort) {
        // a fortress stays a prominent, special designation (unchanged)
        cx.fillStyle = p.owner ? col : '#9fc9c4';
        cx.font = '700 11px ui-monospace,Menlo,monospace';
        cx.fillText(n.id, c.x + 16, c.y - 1);
        cx.fillStyle = 'rgba(150,210,205,0.55)';
        cx.font = '9px ui-monospace,Menlo,monospace';
        cx.fillText('void fortress ✦', c.x + 16, c.y + 11);
      } else {
        // a plain asteroid field is a minor sector — de-emphasised (dim, smaller)
        cx.fillStyle = p.owner ? rgba(col, 0.72) : 'rgba(150,190,196,0.5)';
        cx.font = '600 10px ui-monospace,Menlo,monospace';
        cx.fillText(n.id, c.x + 16, c.y - 1);
        cx.fillStyle = 'rgba(150,210,205,0.38)';
        cx.font = '9px ui-monospace,Menlo,monospace';
        cx.fillText('asteroid field', c.x + 16, c.y + 11);
      }
      cx.restore();
      continue;
    }

    // territory aura — cached glow disc (no per-node gradient)
    blitGlow(col, c.x, c.y, R + 34 * ns, showOwner ? 0.3 : 0.1);

    // sensor-range ring (dashed, faint)
    cx.save();
    cx.setLineDash([3, 5]);
    cx.lineDashOffset = -now / 180;
    cx.strokeStyle = rgba(col, 0.18 + 0.13 * ownerPulse);
    cx.lineWidth = 1;
    cx.beginPath();
    cx.arc(c.x, c.y, R + (14 + 2 * ownerPulse) * ns, 0, TAU);
    cx.stroke();
    cx.restore();

    // fort = hex containment ring
    if (kn && p.buildings.some((b) => b.type === 'fort')) {
      cx.strokeStyle = rgba(col, 0.5);
      cx.lineWidth = 1;
      poly(c.x, c.y, R + 6 * ns, 6, Math.PI / 6);
      cx.stroke();
    }

    // building badges are detail-only: on the schematic view the province colour
    // and score already tell the story — a row of 10px chips just piles onto the
    // shrunken blip (the APK min-zoom overlap).
    if (kn && p.buildings.length && detail > 0) {
      cx.save();
      cx.globalAlpha = detail;
      cx.font = `${Math.max(7, Math.round(11 * ns))}px ui-monospace,Menlo,monospace`;
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      const step = 13 * ns;
      const half = 5 * ns;
      const start = c.x - ((p.buildings.length - 1) * step) / 2;
      for (let i = 0; i < p.buildings.length; i++) {
        const b = p.buildings[i];
        if (!b) continue;
        const bx = start + i * step;
        const by = c.y + R + 19 * ns;
        cx.fillStyle = 'rgba(2,9,13,.78)';
        cx.strokeStyle = rgba(col, 0.55);
        cx.lineWidth = 1;
        cx.beginPath();
        cx.rect(bx - half, by - half, half * 2, half * 2);
        cx.fill();
        cx.stroke();
        cx.fillStyle = rgba(col, 0.9);
        cx.fillText(BUILD_ICON[b.type] ?? '▪', bx, by + 0.5);
      }
      cx.restore();
    }

    if (n.sector === 'planet') {
      // Planet: holographic volume — a lit sphere inside the ring, subtle at far view,
      // blooming to full once you zoom into a region
      blitSphere(col, c.x, c.y, R, clamp(0.3 + (cam.scale - 1) * 0.7, 0.3, 1));

      // wireframe body + bright core (glow comes from the cached aura/bloom discs,
      // not shadowBlur — shadowBlur per node per frame is a major CPU cost)
      blitGlow(col, c.x, c.y, R + 7, showOwner ? 0.22 : 0.12);
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
    } else if (n.sector === 'nebula' || n.sector === 'dense_nebula') {
      // Nebula: soft diamond (rotated square) with diffuse glow
      const kc = SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? col;
      const dr = R * 0.85;
      blitGlow(kc, c.x, c.y, R + 7, showOwner ? 0.2 : 0.1);
      cx.save();
      cx.strokeStyle = rgba(kc, 0.7);
      cx.fillStyle = rgba(kc, 0.12 + 0.08 * ownerPulse);
      cx.lineWidth = 1.6;
      cx.beginPath();
      cx.moveTo(c.x, c.y - dr);
      cx.lineTo(c.x + dr, c.y);
      cx.lineTo(c.x, c.y + dr);
      cx.lineTo(c.x - dr, c.y);
      cx.closePath();
      cx.fill();
      cx.stroke();
      // inner diamond (scanline effect)
      cx.strokeStyle = rgba(kc, 0.3);
      cx.lineWidth = 1;
      const ir = dr * 0.55;
      cx.beginPath();
      cx.moveTo(c.x, c.y - ir);
      cx.lineTo(c.x + ir, c.y);
      cx.lineTo(c.x, c.y + ir);
      cx.lineTo(c.x - ir, c.y);
      cx.closePath();
      cx.stroke();
      // core dot
      cx.fillStyle = rgba(kc, 0.7 + 0.3 * ownerPulse);
      cx.beginPath();
      cx.arc(c.x, c.y, 2, 0, TAU);
      cx.fill();
      cx.restore();
    } else if (n.sector === 'ion_storm' || n.sector === 'solar_flare') {
      // Storm: spiky burst (6-pointed star)
      const kc = SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? col;
      const outerR = R * 0.9;
      const innerR = R * 0.4;
      const spikes = n.sector === 'ion_storm' ? 5 : 8;
      blitGlow(kc, c.x, c.y, R + 7, showOwner ? 0.22 : 0.1);
      cx.save();
      cx.strokeStyle = rgba(kc, 0.75);
      cx.fillStyle = rgba(kc, 0.1 + 0.06 * ownerPulse);
      cx.lineWidth = 1.4;
      cx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * TAU - Math.PI / 2;
        const rr = i % 2 === 0 ? outerR : innerR;
        if (i === 0) cx.moveTo(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr);
        else cx.lineTo(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr);
      }
      cx.closePath();
      cx.fill();
      cx.stroke();
      // core dot
      cx.fillStyle = rgba(kc, 0.7 + 0.3 * ownerPulse);
      cx.beginPath();
      cx.arc(c.x, c.y, 2, 0, TAU);
      cx.fill();
      cx.restore();
    } else if (n.sector === 'graveyard') {
      // Derelict Graveyard: scattered debris fragments around a dim hub
      const kc = SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? col;
      blitGlow(kc, c.x, c.y, R + 5, showOwner ? 0.16 : 0.06);
      cx.save();
      cx.strokeStyle = rgba(kc, 0.5);
      cx.lineWidth = 1.2;
      // scattered wreck fragments — short dashes at fixed angles
      const frags = [0, 0.7, 1.5, 2.3, 3.1, 4.0, 4.9, 5.6];
      for (const a of frags) {
        const r0 = 5 + 2 * Math.sin(a * 3.7);
        const r1 = 9 + 3 * Math.sin(a * 2.1 + 1);
        cx.beginPath();
        cx.moveTo(c.x + Math.cos(a) * r0, c.y + Math.sin(a) * r0);
        cx.lineTo(c.x + Math.cos(a) * r1, c.y + Math.sin(a) * r1);
        cx.stroke();
      }
      // dim centre hub
      cx.fillStyle = rgba(kc, 0.5 + 0.2 * ownerPulse);
      cx.beginPath();
      cx.arc(c.x, c.y, 3, 0, TAU);
      cx.fill();
      cx.strokeStyle = rgba(kc, 0.4);
      cx.beginPath();
      cx.arc(c.x, c.y, 7, 0, TAU);
      cx.stroke();
      cx.restore();
    } else if (n.sector === 'dead_world') {
      // Dead World: broken/dashed circle with an X through it
      const kc = SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? col;
      blitGlow(kc, c.x, c.y, R + 5, showOwner ? 0.16 : 0.08);
      cx.save();
      cx.setLineDash([4, 4]);
      cx.strokeStyle = rgba(kc, 0.6);
      cx.lineWidth = 1.6;
      cx.beginPath();
      cx.arc(c.x, c.y, R * 0.8, 0, TAU);
      cx.stroke();
      cx.setLineDash([]);
      // cross through the centre (the "dead" mark)
      const xr = R * 0.45;
      cx.strokeStyle = rgba(kc, 0.45);
      cx.lineWidth = 1.3;
      cx.beginPath();
      cx.moveTo(c.x - xr, c.y - xr);
      cx.lineTo(c.x + xr, c.y + xr);
      cx.moveTo(c.x + xr, c.y - xr);
      cx.lineTo(c.x - xr, c.y + xr);
      cx.stroke();
      // dim core dot
      cx.fillStyle = rgba(kc, 0.5 + 0.2 * ownerPulse);
      cx.beginPath();
      cx.arc(c.x, c.y, 2, 0, TAU);
      cx.fill();
      cx.restore();
    } else {
      // Fallback for any other non-planet type: small hexagon marker
      const kc = SECTOR_TYPES[SECTOR_OF[n.id]]?.color ?? col;
      blitGlow(kc, c.x, c.y, R + 5, showOwner ? 0.14 : 0.06);
      cx.save();
      cx.strokeStyle = rgba(kc, 0.55);
      cx.fillStyle = rgba(kc, 0.08);
      cx.lineWidth = 1.4;
      poly(c.x, c.y, R * 0.7, 6, Math.PI / 6);
      cx.fill();
      cx.stroke();
      cx.fillStyle = rgba(kc, 0.5 + 0.2 * ownerPulse);
      cx.beginPath();
      cx.arc(c.x, c.y, 2, 0, TAU);
      cx.fill();
      cx.restore();
    }

    if (selPlanet === n.id) targetBrackets(c.x, c.y, R + 10, now);

    // callout: id + garrison/buildings, monospace. Worlds (planets — the capturable
    // prize) get a BRIGHT designation; every other sector is de-emphasised to a dim,
    // smaller coordinate so the map reads "worlds first" (fogged → no telemetry).
    // LOD: callout text dissolves on the schematic view — except YOUR OWN worlds,
    // which stay labelled like city names on a globe (your anchor at any zoom).
    const isWorld = n.sector === 'planet';
    const mineWorld = isWorld && p.owner === ME;
    if (detail === 0 && !mineWorld) continue;
    cx.save();
    cx.globalAlpha = mineWorld ? Math.max(detail, 0.9) : detail;
    cx.shadowColor = 'rgba(0,0,0,0.85)';
    cx.shadowBlur = 3;
    if (isWorld) {
      cx.fillStyle = kn ? (p.owner ? col : '#9fc9c4') : 'rgba(120,140,150,0.55)';
      cx.font = '700 12px ui-monospace,Menlo,monospace';
    } else {
      cx.fillStyle = kn
        ? p.owner
          ? rgba(col, 0.72)
          : 'rgba(150,190,196,0.5)'
        : 'rgba(120,140,150,0.4)';
      cx.font = '600 10px ui-monospace,Menlo,monospace';
    }
    cx.fillText(n.id, c.x + R + 12, c.y - 1);
    // the telemetry line is detail-only — on the schematic view a labelled own
    // world keeps just its name
    if (kn && detail > 0) {
      const g = p.garrison.reduce((a, st) => a + st.count, 0);
      const icons = p.buildings.map((b) => BUILD_ICON[b.type] ?? '▪').join('');
      // worlds always show telemetry; a quiet sector only when it holds something
      if (isWorld || g > 0 || p.buildings.length) {
        cx.fillStyle = rgba('#96d2cd', isWorld ? 0.6 : 0.42);
        cx.font = isWorld
          ? '10px ui-monospace,Menlo,monospace'
          : '9px ui-monospace,Menlo,monospace';
        cx.fillText(`G:${g}  B:${icons || '—'}`, c.x + R + 12, c.y + (isWorld ? 12 : 11));
      }
    } else if (!kn && detail > 0) {
      cx.fillStyle = 'rgba(110,130,140,0.5)';
      cx.font = '10px ui-monospace,Menlo,monospace';
      cx.fillText('· no telemetry', c.x + R + 12, c.y + 12);
    }
    cx.restore();
  }

  // the orbit ring around any CITY that holds a stationed fleet (a single orbit).
  // Asteroid-field junctions have no orbits, so they are skipped.
  const stationed: Record<string, Fleet[]> = {};
  for (const f of Object.values(s.fleets))
    if (f.location && !f.movement) {
      if (!fleetSeen(f)) continue; // hidden enemy orbit (no identify, no intel window)
      (stationed[f.location] ??= []).push(f);
    }
  // LOD: stationed-orbit rings are gone entirely on the schematic view
  for (const pid of detail > 0 ? Object.keys(stationed) : []) {
    const pl = s.planets[pid];
    if (!pl) continue;
    // orbit only on types that have one (cities); a fortress gives a junction one too
    const fortified =
      pl.buildings.some((b) => b.type === 'starfort') ||
      (pl.garrison ?? []).some((u) => u.count > 0);
    if (!SECTOR_TYPES[SECTOR_OF[pid]]?.orbit && !fortified) continue;
    const pc = world(pl.position);
    if (!visible(pc, 80)) continue;
    // A single orbit ring (GDD §7.4) — one orbit, so no N/F labels cluttering the map.
    const rr = orbitRingRadius(pl);
    cx.save();
    cx.globalAlpha = detail;
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
    if (!fleetSeen(f)) {
      // not identified and no intel window: a radar contact is shown only as a
      // swept signature (drawRadarContacts), painted by the arm — never live here.
      continue;
    }
    const A = fleetAnchor(f);
    if (!A || !visible(A, 120)) continue;
    const col = ownerColor(f.owner);
    // Squadrons ABOARD a carrier live in the hold, not in the battle line: with any
    // non-squadron hull present they leave the triangle pyramid and ride the cargo
    // tail as diamonds. A pure strike wing in flight IS its squadrons — triangles.
    const allUnits = sumUnits(f.units);
    const wingAboard = sumUnits(f.units.filter((st) => isSquadron(st.unit)));
    const hulls = allUnits - wingAboard;
    const ships = hulls > 0 ? hulls : allUnits;
    const wingPips = hulls > 0 ? wingAboard : 0;
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

    // LOD: far out a fleet is ONE glowing chevron, nose on course — the pyramid,
    // cargo pips and ship count cross-fade away (schematic view keeps who/where).
    if (detail < 1) {
      cx.save();
      cx.globalAlpha = 1 - detail;
      cx.translate(A.x, A.y);
      cx.rotate(A.ang + Math.PI / 2);
      cx.shadowColor = col;
      cx.shadowBlur = 5 + 4 * engine;
      cx.fillStyle = rgba(col, 0.92);
      cx.strokeStyle = 'rgba(4,10,12,.8)';
      cx.lineWidth = 1;
      cx.beginPath();
      cx.moveTo(0, -7);
      cx.lineTo(5.5, 5);
      cx.lineTo(-5.5, 5);
      cx.closePath();
      cx.fill();
      cx.stroke();
      cx.restore();
    }
    if (detail === 0) {
      // selection still reads on the schematic view; the rest of the kit is gone
      if (selFleet === f.id || selFleets.has(f.id)) targetBrackets(A.x, A.y, 12, now);
      continue;
    }
    cx.globalAlpha = detail; // full detail fades back in toward 1.45

    // Fleet emblem (постер «Типы кораблей»): ОДИН силуэт ДОМИНАНТА — сильнейшего
    // корабля флота — вместо пирамиды треугольников; количество несёт счётчик
    // «×N» за хвостом («флот на карте = доминант + счёт», полный состав — в
    // панели выделения). Размер S/M/L по hp доминанта, гало-кольцо при щите
    // (у флагмана — всегда), нос по курсу — heading от fleetAnchor, как раньше;
    // карго-хвост и счётчик едут по тому же курсу.
    const dom = dominantUnit(f.units, data);
    const arch = dom ? unitArchetype(dom.def) : 'combat';
    const domK = dom ? { S: 0.62, M: 0.8, L: 1 }[unitSizeClass(dom.def.stats.hp ?? 0)] : 0.62;
    const domStack = dom ? f.units.find((st) => st.unit === dom.unit && st.count > 0) : undefined;
    const domShield =
      dom && domStack ? (effectiveStats(dom.def, domStack, data).shield ?? 0) > 0 : false;
    cx.save();
    cx.translate(A.x, A.y);
    cx.rotate(A.ang + Math.PI / 2);
    cx.shadowColor = col;
    cx.shadowBlur = 6 + 6 * engine;
    if (domShield || arch === 'flagship') {
      // модификатор «есть щит»: пунктирная орбита вокруг силуэта
      cx.strokeStyle = rgba(col, 0.7);
      cx.lineWidth = 1.1;
      cx.setLineDash([2.6, 2.8]);
      cx.beginPath();
      cx.arc(0, 0, 12.5 * domK + 2, 0, TAU);
      cx.stroke();
      cx.setLineDash([]);
    }
    cx.scale(domK, domK);
    cx.translate(-12, -12);
    cx.fillStyle = rgba(col, 0.92);
    cx.strokeStyle = 'rgba(4,10,12,.8)';
    cx.lineWidth = 1;
    const p2d = archPath2d(arch);
    cx.fill(p2d, 'evenodd');
    cx.stroke(p2d);
    cx.restore();

    // cargo glued to the tail (behind the base, following the heading), SPLIT by
    // shape so counts read at a glance: row 1 — only diamonds (carried divisions,
    // hold squadrons — «ромбик размером с квадратик»), row 2 — only squares (ground
    // troops). A loading pip (~1h) fills up in place inside its shape's row. Cell
    // centres ride the rotated baseline, the pips themselves stay upright.
    const loads = pendingLoads.filter((p) => p.fleetId === f.id); // empty for enemy/idle fleets
    type CargoPip = { kind: 'div' | 'wing' | 'troop' | 'load'; load?: PendingLoad };
    const diaRow: CargoPip[] = []; // ромбы: дивизии + эскадрильи в трюме
    const sqRow: CargoPip[] = []; // квадраты: десант
    for (let i = 0; i < (carriedDivCount[f.id] ?? 0); i++) diaRow.push({ kind: 'div' });
    for (let i = 0; i < wingPips; i++) diaRow.push({ kind: 'wing' });
    for (let i = 0; i < troops; i++) sqRow.push({ kind: 'troop' });
    for (const p of loads) (isSquadron(p.unit) ? diaRow : sqRow).push({ kind: 'load', load: p });
    // The same rotation the pyramid uses; local +y = the tail. Pips and the ship
    // count are placed through this, drawn upright at their rotated spots.
    const th = A.ang + Math.PI / 2;
    const tailAt = (lx: number, ly: number): { x: number; y: number } => ({
      x: A.x + lx * Math.cos(th) - ly * Math.sin(th),
      y: A.y + lx * Math.sin(th) + ly * Math.cos(th),
    });
    const CELL = 8,
      SQ = 5,
      DR = 3.75,
      DS = 3.1, // squadron pip: a diamond with the footprint of the square
      MAX = 8; // per-row cap; rare overflow gets a "+N" tail
    const diamond = (cxr: number, cyr: number, r: number, fill: boolean): void => {
      cx.beginPath();
      cx.moveTo(cxr, cyr - r);
      cx.lineTo(cxr + r, cyr);
      cx.lineTo(cxr, cyr + r);
      cx.lineTo(cxr - r, cyr);
      cx.closePath();
      if (fill) cx.fill();
      cx.stroke();
    };
    const drawCargoRow = (row: CargoPip[], ly: number): void => {
      if (!row.length) return;
      const n = Math.min(row.length, MAX);
      const over = row.length - n;
      const rowW = n * CELL + (over > 0 ? 12 : 0);
      let lx = -rowW / 2 + CELL / 2; // local x of the first cell centre
      cx.save();
      cx.shadowColor = col;
      cx.shadowBlur = 3;
      cx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const pip = row[i]!;
        const c0 = tailAt(lx, ly);
        if (pip.kind === 'div' || pip.kind === 'wing') {
          // carried division / hold squadron → a solid diamond ("ромбик")
          cx.fillStyle = rgba(col, 0.85);
          cx.strokeStyle = rgba(col, 0.95);
          diamond(c0.x, c0.y, pip.kind === 'div' ? DR : DS, true);
        } else if (pip.kind === 'troop') {
          // loaded troop → solid square
          const x = c0.x - SQ / 2,
            y = c0.y - SQ / 2;
          cx.fillStyle = rgba(col, 0.85);
          cx.fillRect(x, y, SQ, SQ);
          cx.strokeStyle = rgba(col, 0.95);
          cx.strokeRect(x + 0.5, y + 0.5, SQ - 1, SQ - 1);
        } else {
          // loading pip → fills in place over ~1h (squadron = growing diamond,
          // ground troop = empty square filling bottom-up)
          const p = pip.load!;
          const prog = clamp((s.time - p.startAt) / (p.doneAt - p.startAt), 0, 1);
          if (isSquadron(p.unit)) {
            cx.strokeStyle = rgba(col, 0.85);
            diamond(c0.x, c0.y, DS, false);
            if (prog > 0) {
              cx.fillStyle = rgba(col, 0.8);
              cx.strokeStyle = rgba(col, 0);
              diamond(c0.x, c0.y, DS * prog, true);
            }
          } else {
            const x = c0.x - SQ / 2,
              y = c0.y - SQ / 2;
            cx.strokeStyle = rgba(col, 0.85);
            cx.strokeRect(x + 0.5, y + 0.5, SQ - 1, SQ - 1);
            if (prog > 0) {
              const fh = (SQ - 1) * prog;
              cx.fillStyle = rgba(col, 0.8);
              cx.fillRect(x + 0.5, y + 0.5 + (SQ - 1 - fh), SQ - 1, fh);
            }
          }
        }
        lx += CELL;
      }
      cx.restore();
      if (over > 0) {
        const o = tailAt(lx, ly);
        cx.fillStyle = rgba(col, 0.92);
        cx.font = '700 8px ui-monospace,Menlo,monospace';
        cx.fillText(`+${over}`, o.x, o.y + SQ / 2);
      }
    };
    drawCargoRow(diaRow, 5); // ромбы — ближний к базе ряд
    drawCargoRow(sqRow, diaRow.length ? 5 + CELL : 5); // квадраты — своим рядом ниже

    if (f.owner === ME && chainStepsOf(f.id)) {
      // TGT-1: an army carrying a standing plan breathes a dashed accent ring —
      // one glance tells which fleets are already "spoken for".
      const pu = 0.5 + 0.5 * Math.sin(now / 300);
      cx.save();
      cx.strokeStyle = rgba(ownerColor(ME), 0.3 + 0.4 * pu);
      cx.lineWidth = 1.3;
      cx.setLineDash([4, 4]);
      cx.beginPath();
      cx.arc(A.x, A.y, 12.5, 0, TAU);
      cx.stroke();
      cx.restore();
    }
    if (selFleet === f.id || selFleets.has(f.id)) {
      targetBrackets(A.x, A.y, 15, now);
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

    // ship count («×N» — счёт при доминанте, как на постере), small, past the
    // cargo tail — placed along the heading like the pips, glyph upright.
    const cnt = tailAt(0, diaRow.length && sqRow.length ? 21 + CELL : 21);
    cx.fillStyle = rgba(col, 0.95);
    cx.font = '700 10px ui-monospace,Menlo,monospace';
    cx.fillText(`×${ships}`, cnt.x, cnt.y);

    cx.globalAlpha = 1; // end of the per-fleet LOD cross-fade
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
  drawTargetMarkers(now); // TGT-1: standing order reticles (tap = edit the plan)
  drawAssaultTargets();
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
function cardHeader(color: string, title: string, sub: string, titleAct?: string): string {
  // PC: the one-line header truncates the subtitle — drop the spaces around the
  // separator dots so more of it fits. Mobile keeps the airy ' · '.
  const subFit = pcUi() ? sub.replace(/ · /g, '·') : sub;
  // Bytro-стиль: тап по ИМЕНИ открывает сводку (армии) — заголовок становится
  // кнопкой только когда карточка передала действие, прочие панели не меняются.
  const tt = titleAct
    ? `<button class="ptitle-btn" data-act="${titleAct}" data-arg="">${esc(title)} ▸</button>`
    : `<b>${esc(title)}</b>`;
  return `<div class="phead">
    <span class="pflag" style="background:${color}"></span>
    <div class="ptitle">${tt}<span>${esc(subFit)}</span></div>
    <button class="pclose" data-act="close" data-arg="">✕</button>
  </div>`;
}
function tabButton(tab: PlanetTab, label: string, count: number, desc?: string): string {
  const on = planetTab === tab ? ' on' : '';
  const d = desc ? ` data-desc="${desc}"` : '';
  return `<button class="ptab${on}" data-act="tab" data-arg="${tab}"${d}>${label}<b>${count}</b></button>`;
}
function unitRows(stacks: Array<{ unit: string; count: number }>): string {
  if (!stacks.length) {
    return `<div class="row dim">${t('нет')}</div>`;
  }
  return stacks
    .map(
      (st) =>
        `<div class="asset-row" data-desc="u:${esc(st.unit)}"><span class="bicon">${unitIcon(st.unit)}</span><b>${st.count}× ${displayUnit(st.unit)}</b><span class="dim">${isGround(st.unit) ? t('земля') : t('космос')}</span></div>`,
    )
    .join('');
}
/** Localized one-line label for a paused site (shares `ConstructionPayload`'s field
 *  names, so `constructionLabel` reads it directly — the extra `id`/`progress`/
 *  `remainingHours`/`remainingCost` fields are simply ignored). */
function pausedLabel(site: PausedConstructionSite): string {
  return constructionLabel(site);
}
function conveyorHtml(planetId: string, lane: BuildLane): string {
  const active = activeConstruction(planetId, lane);
  const queued = queueOf(planetId)[lane];
  const paused = (s.planets[planetId]?.pausedConstruction ?? []).filter(
    (p) => laneOf(p.kind) === lane,
  );
  let html = `<div class="conveyor">`;
  if (active) {
    // The live % / remaining-time are patched in each frame by updatePanelLive() and
    // deliberately kept OUT of the panel's HTML signature — otherwise the panel (and its
    // build buttons) would be rebuilt 60×/s, and a click whose down/up straddle a rebuild
    // is dropped (the bug where rapid build orders only queued one ship in real time).
    const dur = buildDurationHours(active.payload) * HOUR;
    html += `<div class="current" data-desc="c:${planetId}:${lane}:active:${active.seq}"><span>${t('СЕЙЧАС')}</span><b>${constructionLabel(active.payload)}</b><em class="conv-time" data-at="${active.at}">—</em>`;
    html += `<button class="conv-cancel" data-act="cancelbuild" data-arg="${active.seq}" title="${t('Отменить — вернёт часть ресурсов и поставит на паузу')}">✕</button></div>`;
    html += `<div class="bar"><i class="conv-fill" data-at="${active.at}" data-dur="${dur}" style="width:0%"></i></div>`;
  } else if (pcUi() && queued[0] && !canStartQueued(planetId, queued[0])) {
    // The queue is NOT stuck — its head simply can't be paid yet. Say so, with the
    // price, instead of an idle line that reads like a broken conveyor.
    html += `<div class="current idle"><b>⏳ ${t('Ждёт ресурсы: {c}', { c: cost(buildCost(planetId, queued[0])) })}</b></div>`;
    html += `<div class="bar"><i style="width:0%"></i></div>`;
  } else if (compactUi()) {
    html += `<div class="current idle"><b>${t('Ожидание заказов')}</b></div>`;
    html += `<div class="bar"><i style="width:0%"></i></div>`;
  } else {
    html += `<div class="current idle"><span>${t('ПРОСТОЙ')}</span><b>${t('готов к следующему заказу')}</b><em>—</em></div>`;
    html += `<div class="bar"><i style="width:0%"></i></div>`;
  }
  if (queued.length) {
    html += `<div class="queue">${queued
      .map(
        (q, i) =>
          `<span data-desc="c:${planetId}:${lane}:queued:${i}"><em>${i + 1}</em>${queuedLabel(q)}<button class="q-x" data-act="dequeue" data-arg="${lane}:${i}" title="${t('Убрать из очереди')}">✕</button></span>`,
      )
      .join('')}</div>`;
  } else if (!compactUi()) {
    html += `<div class="queue empty">${t('очередь пуста')}</div>`;
  }
  if (paused.length) {
    html += `<div class="paused">${paused
      .map(
        (p) =>
          `<span data-desc="c:${planetId}:${lane}:paused:${p.id}"><em>${t('Приостановлено {n}%', { n: Math.round(p.progress * 100) })}</em>${pausedLabel(p)}<button class="p-go" data-act="resumebuild" data-arg="${p.id}" title="${t('Возобновить — доплатить остаток')}">▶</button></span>`,
      )
      .join('')}</div>`;
  }
  return html + `</div>`;
}
// Buildable options as codex tiles (icon + cost). Tapping a tile opens the full-info
// panel, which carries a "Build here" button for the selected province — so browsing
// specs and committing the build share one control (no separate text button row).
function buildButtons(_planetId: string, ids: string[], kind: 'building' | 'unit'): string {
  const k = kind === 'unit' ? 'u' : 'b';
  const tiles = ids
    .map((id) =>
      codexTile(
        k,
        id,
        cost(kind === 'unit' ? data.units[id]?.cost : data.buildings[id]?.cost),
        true,
        // Buildings are one-per-planet — grey out a committed (queued/building/paused)
        // one so a second order can't be placed. PC only (the mobile build UI is frozen
        // in this chat); units stack freely so they're never locked.
        kind === 'building' && pcUi() && !NET ? (buildingLocked(_planetId, id) ?? undefined) : undefined,
      ),
    )
    .join('');
  return tiles ? `<div class="ptiles">${tiles}</div>` : '';
}

/** Side-panel: the multi-fleet TASK-GROUP card (Shift-frame selection). */
function taskGroupPanelHtml(group: Fleet[]): string {
  const ships = group.reduce((a, f) => a + sumUnits(f.units), 0);
  const troops = group.reduce((a, f) => a + sumUnits(f.landing ?? []), 0);
  let h = cardHeader(
    ownerColor(ME),
    t('ОПЕРАТИВНАЯ ГРУППА'),
    t('{f} флот(ов) · {s} кораблей · {tr} десанта', { f: group.length, s: ships, tr: troops }),
  );
  h += `<div class="hint">${t('Нажмите «Курс» и тапните цель — все выбранные флоты пойдут туда (проложат маршрут и встанут). «Слить» сплавляет группу в один флот (дальние сначала подлетят). Shift- или Ctrl/⌘-клик по флоту добавляет его в группу; Shift-рамка по пустому месту выделяет несколько.')}</div>`;
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
  h += btn('cancel', '', t('Снять выделение группы'), true);
  return h;
}

/** Side-panel: a single selected fleet — combat stats, orders, docking. */
/** Тайлы состава флота Bytro-стиля: силуэт-архетип в цвете стороны (наземные —
 *  прежние текст-глифы), счётчик и мини-бар корпуса стека; тап — досье юнита. */
function fleetTilesHtml(f: Fleet, stacks: UnitStack[]): string {
  const tiles = stacks
    .filter((u) => u.count > 0)
    .map((u) => {
      const def = data.units[u.unit];
      if (!def) return '';
      const name = unitDossier(u.unit)?.name ?? displayUnit(u.unit);
      const eff = effectiveStats(def, u, data);
      const full = u.count * (eff.hp ?? 0);
      const pct = full > 0 ? Math.round((Math.min(u.hp ?? full, full) / full) * 100) : 100;
      const icon =
        def.domain === 'ground'
          ? `<span class="pt-ic">${unitIcon(u.unit)}</span>`
          : `<span class="pt-ic">${unitGlyphSvg(def, { color: ownerColor(f.owner), shield: (eff.shield ?? 0) > 0 })}</span>`;
      return `<button class="ptile" data-codex="u:${esc(u.unit)}" data-desc="u:${esc(u.unit)}" data-name="${esc(name)}" title="${esc(name)} — ${t('тап — полное досье')}">${icon}<span class="pt-c">×${u.count}</span><span class="pt-hp${pct < 30 ? ' low' : ''}"><i style="width:${pct}%"></i></span></button>`;
    })
    .join('');
  return tiles ? `<div class="ptiles">${tiles}</div>` : '';
}

/** Сводка армии (тап по имени в шапке карточки): состав по архетипам, боевой вес
 *  с капом, пулы корпуса/щита, скорость с активными множителями, трюм, радар,
 *  содержание. Обратно — тем же тапом по имени или кнопкой «назад». */
function fleetSummaryHtml(f: Fleet): string {
  const rows: string[] = [];
  // состав по архетипам постера
  const byArch = new Map<string, number>();
  for (const st of f.units) {
    const def = data.units[st.unit];
    if (!def || st.count <= 0) continue;
    const a = unitArchetype(def);
    byArch.set(a, (byArch.get(a) ?? 0) + st.count);
  }
  const ARCH_LABEL: Record<string, string> = {
    scout: t('скауты'),
    combat: t('боевые'),
    artillery: t('артиллерия'),
    transport: t('транспорты'),
    flagship: t('флагман'),
    swarm: t('рой'),
  };
  const comp = [...byArch.entries()].map(([a, n]) => `${ARCH_LABEL[a] ?? a} ×${n}`).join(' · ');
  const nTr = sumUnits(f.landing ?? []);
  rows.push(
    `<div class="row">${t('Состав')}: <b>${comp || t('нет')}</b>${nTr ? ` · ${t('десант')} ×${nTr}` : ''}</div>`,
  );
  // боевой вес: кап против полной суммы — видно, сколько стволов «за линией»
  const atkCap = Math.round(cappedUnitStat(f.units, data, 'attack'));
  const atkAll = Math.round(sumUnitStat(f.units, data, 'attack'));
  const defCap = Math.round(cappedUnitStat(f.units, data, 'defense'));
  rows.push(
    `<div class="row">⚔ ${t('Атака')}: <b>${atkCap}</b>${atkAll > atkCap ? ` <span class="dim">(${t('всего')} ${atkAll} — ${t('бьют {n} юнитов', { n: COMBAT_UNIT_CAP })})</span>` : ''}</div>`,
  );
  rows.push(`<div class="row">🛡 ${t('Защита')}: <b>${defCap}</b></div>`);
  // пулы
  let curHull = 0,
    maxHull = 0,
    curSh = 0,
    maxSh = 0;
  for (const st of [...f.units, ...(f.landing ?? [])]) {
    const def = data.units[st.unit];
    if (!def || st.count <= 0) continue;
    const eff = effectiveStats(def, st, data);
    const m = st.count * (eff.hp ?? 0);
    maxHull += m;
    curHull += Math.min(st.hp ?? m, m);
    const ms = st.count * (eff.shield ?? 0);
    maxSh += ms;
    curSh += Math.min(st.shieldHp ?? ms, ms);
  }
  rows.push(
    `<div class="row">♥ ${t('Корпус')}: <b>${kfmt(Math.round(curHull))}/${kfmt(maxHull)}</b>${maxSh > 0 ? ` · ◈ ${t('Щит')}: <b>${kfmt(Math.round(curSh))}/${kfmt(maxSh)}</b>` : ''}</div>`,
  );
  // скорость: база (мин по корпусам, лимп учтён) + активные множители
  const spd = fleetBaseSpeed(f, data);
  const mults: string[] = [];
  if (marchFlagged(f.id)) mults.push(`⚡ ${t('форс-марш')} ×${FORCED_MARCH_MULT}`);
  if (
    (f as { retreatHasteUntil?: number }).retreatHasteUntil != null &&
    s.time < (f as { retreatHasteUntil?: number }).retreatHasteUntil!
  )
    mults.push(`⤺ ${t('рывок отхода')} ×1.5`);
  rows.push(
    `<div class="row">⚡ ${t('Скорость')}: <b>${spd > 0 ? Math.round(spd) : '—'}</b>${mults.length ? ` <span class="dim">${mults.join(' · ')}</span>` : ''} <span class="dim">· ${t('по самому медленному; техи/фракция/местность — на переходе')}</span></div>`,
  );
  // трюм и радар
  const cargoCap = sumUnitStat(f.units, data, 'cargoCapacity');
  const cargoUsed = (f.landing ?? []).reduce((n, st) => {
    const def = data.units[st.unit];
    return n + (def ? st.count * (effectiveStats(def, st, data).cargoSize ?? 1) : 0);
  }, 0);
  if (cargoCap > 0)
    rows.push(
      `<div class="row">📦 ${t('Трюм')}: <b>${cargoUsed}/${Math.round(cargoCap)}</b></div>`,
    );
  const radar = Math.max(
    0,
    ...f.units.filter((u) => u.count > 0).map((u) => data.units[u.unit]?.radarRange ?? 0),
  );
  if (radar > 0) rows.push(`<div class="row">📡 ${t('Радар')}: <b>${radar}</b></div>`);
  // содержание
  const upkeep: Record<string, number> = {};
  for (const st of f.units) {
    const def = data.units[st.unit];
    if (!def || st.count <= 0) continue;
    for (const [r, n] of Object.entries(def.upkeep ?? {}))
      upkeep[r] = (upkeep[r] ?? 0) + st.count * (n ?? 0);
  }
  const up = Object.entries(upkeep)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${tData(r)}`)
    .join(', ');
  if (up) rows.push(`<div class="row dim">${t('Содержание')}: ${up}/${t('день')}</div>`);
  return (
    `<div class="sec">${t('Сводка армии')}</div>` +
    rows.join('') +
    `<div class="row">${btn('fleetinfo', '', t('‹ Назад к карточке'), true)}</div>`
  );
}

function fleetPanelHtml(f: Fleet): string {
  const nShips = sumUnits(f.units);
  const nTr = sumUnits(f.landing ?? []);
  const inOrbit = f.orbit === 'near';
  // Hull integrity across the squadron (persistent between fights now): a stack's
  // current hp ?? full — по ЭФФЕКТИВНОМУ hp (обшивка-фитинг считается), корабли +
  // десант вместе, как в Bytro-карточке. Below 30% the fleet limps (route.ts)
  // until it repairs. Щит — отдельный пул (регенит бесплатно сам).
  let curHull = 0,
    maxHull = 0,
    curSh = 0,
    maxSh = 0;
  for (const st of [...f.units, ...(f.landing ?? [])]) {
    const u = data.units[st.unit];
    if (!u || st.count <= 0) continue;
    const eff = effectiveStats(u, st, data);
    const m = st.count * (eff.hp ?? 0);
    maxHull += m;
    curHull += Math.min(st.hp ?? m, m);
    const ms = st.count * (eff.shield ?? 0);
    maxSh += ms;
    curSh += Math.min(st.shieldHp ?? ms, ms);
  }
  const hullPct = maxHull > 0 ? Math.round((curHull / maxHull) * 100) : 100;
  const hullTag = hullPct < 30 ? ` · ⚠ ${t('корпус {p}%', { p: hullPct })}` : '';
  // ECON-1: голодный десант — владелец в food-arrears бьёт на земле на −25%.
  const hungry =
    nTr > 0 && f.owner === ME && (s.players[ME]?.arrears ?? []).includes('food')
      ? ` · 🍽 ${t('голод: −25% на земле')}`
      : '';
  // Bytro-стиль: авто-имя соединения (тип по размеру + позывной), тап → сводка.
  const fleetTitle = `${t(fleetKindKey(nShips))} «${fleetCallsign(f.id)}»`;
  let h = cardHeader(
    ownerColor(f.owner),
    fleetTitle,
    (pcUi()
      ? t('Корабли: {s} · Десант: {tr}', { s: nShips, tr: nTr })
      : t('{s} кораблей · {tr} десанта', { s: nShips, tr: nTr })) +
      hullTag +
      hungry +
      (inOrbit ? ' · ' + t('на орбите') : '') +
      (f.bombarding ? ' · ⊗ ' + t('бомбардирует') : ''),
    'fleetinfo',
  );
  // Тап по имени открыл сводку армии — карточка целиком уступает ей место.
  if (fleetInfoFor === f.id) return h + fleetSummaryHtml(f);
  // ХП-бар Bytro-стиля + два ремонта: ECON-3а — экспресс за METAL у своего дока
  // (дешёвый, основной), и ненавязчивый платный за кредиты — где угодно вне боя
  // (цены — те же формулы, что в гейте).
  const repairCost = instantRepairCost(f, data);
  const canRepair = f.owner === ME && !f.battleId && repairCost > 0;
  const atDock = canRepair && fleetAtOwnDock(f, s, data);
  if (maxHull > 0) {
    h += `<div class="row hullrow" data-desc="stat:hull"><span class="hico">♥</span><span class="hbar${hullPct < 30 ? ' low' : ''}"><i style="width:${hullPct}%"></i></span><b>${kfmt(Math.round(curHull))}/${kfmt(maxHull)}</b>${
      atDock
        ? `<button class="chip-metal" data-act="dockrepair" data-arg="${f.id}" title="${t('Экспресс-ремонт у своего дока за металл')}">🔧 ${dockRepairCost(f, data)}⬢</button>`
        : ''
    }${
      canRepair
        ? `<button class="chip-gold" data-act="instantrepair" data-arg="${f.id}" title="${t('Мгновенный ремонт всего корпуса за кредиты')}">🔧 ${repairCost}💰</button>`
        : ''
    }</div>`;
    if (maxSh > 0)
      h += `<div class="row hullrow" data-desc="stat:shield"><span class="hico">◈</span><span class="hbar sh"><i style="width:${Math.round((curSh / maxSh) * 100)}%"></i></span><b>${kfmt(Math.round(curSh))}/${kfmt(maxSh)}</b></div>`;
  }
  // Aggregate combat weight — БОЕВОЙ вес, как его считает ядро: effectiveStats +
  // кап линии огня (топ-10 стволов). Скорость — базовая скорость флота (мин по
  // корпусам, лимп <30% учтён), с меткой форс-марша. The hero aura (+5%, noted
  // below) is not folded into these totals.
  const atk = Math.round(cappedUnitStat(f.units, data, 'attack'));
  const def = Math.round(cappedUnitStat(f.units, data, 'defense'));
  const spd = fleetBaseSpeed(f, data);
  const boosted = marchFlagged(f.id);
  const spdTxt =
    spd > 0
      ? boosted
        ? `${Math.round(spd)} ⚡×${FORCED_MARCH_MULT}`
        : String(Math.round(spd))
      : '—';
  const flavor: string[] = [];
  if (f.units.some((u) => u.count > 0 && data.units[u.unit]?.traits.includes('hero')))
    flavor.push(t('с героем-флагманом'));
  if (f.units.some((u) => u.count > 0 && data.units[u.unit]?.traits.includes('artillery')))
    flavor.push(t('с осадной артиллерией'));
  if (f.units.some((u) => u.count > 0 && (data.units[u.unit]?.radarRange ?? 0) > 0))
    flavor.push(t('со своим радарным дозором'));
  // PC drops the intro blurb (the header + stat chips already say it); phones keep it.
  if (!pcUi()) {
    const blurb =
      nShips === 0
        ? t('Пустая группа корпусов — кораблей на борту нет.')
        : t(
            'Эскадра из {n} корабл.{fl} Суммарный вес ниже; идёт со скоростью самого медленного корпуса.',
            { n: nShips, fl: flavor.length ? ' — ' + flavor.join(', ') + '.' : '.' },
          );
    h += `<div class="row dim">${blurb}</div>`;
  }
  h += `<div class="pstats"><span data-desc="stat:atk">⚔ ${t('АТК')} ${atk}</span><span data-desc="stat:def">🛡 ${t('ЗАЩ')} ${def}</span><span data-desc="stat:cap">Ⅹ ${Math.min(nShips, COMBAT_UNIT_CAP)}/${COMBAT_UNIT_CAP}</span><span data-desc="stat:spd">⚡ ${t('СКР')} ${spdTxt}</span></div>`;
  h += nShips
    ? `<div class="sec">${t('Корабли — тап для характеристик')}</div>` + fleetTilesHtml(f, f.units)
    : '';
  if (nTr > 0)
    h += `<div class="sec">${t('Десант на борту')}</div>` + fleetTilesHtml(f, f.landing ?? []);

  // Artillery rules of engagement moved to the ☰ command bar («🔥 Режим огня»
  // button + popover menu) — the bottom sheet keeps information, not controls.

  // Carrier air wing (squadrons-roadmap SQ-1.1) — launch the squadron ships as a
  // separate fast strike fleet. Needs a non-squadron ship left behind (fleet.split
  // refuses to take the whole stack), so an all-fighter fleet just flies itself.
  if (f.owner === ME && fleetHasSquadron(f)) {
    const wing = squadronTake(f).reduce((n, u) => n + u.count, 0);
    h += `<div class="sec">${t('Авиагруппа')}</div><div class="row">`;
    h += btn(
      'launchsquad',
      '',
      t('🛩 Запустить эскадрилью ({n})', { n: wing }),
      fleetCanLaunchSquadron(f),
    );
    h += `</div>`;
    h += `<div class="hint">${t('Отделяет эскадрильи в отдельный быстрый флот — уводите его на удар, а носитель остаётся в строю. Нужен хотя бы один не-эскадрильный корабль. Контрится орбитальным ПВО.')}</div>`;

    // CC-4 status only — the «🛩 Деж. вылет» TOGGLE moved to the ☰ command row
    // (SO-UI: the panel keeps information, the bar keeps controls).
    const pt = patrolOf(f.id);
    if (pt) {
      const status =
        pt.sortie.rearming > 0
          ? t('перезарядка {n}', { n: pt.sortie.rearming })
          : t('топливо {n}', { n: pt.sortie.fuel });
      h += `<div class="row dim">${t('🛩 дежурный вылет: ВКЛ')} · ${t('радиус {r}', { r: Math.round(pt.radius) })} · ${status}</div>`;
    }
  }

  // The player's projection hero rides here → name it and flag its fleet aura.
  if (f.units.some((u) => u.count > 0 && data.units[u.unit]?.traits.includes('hero'))) {
    const hero = Object.values(s.heroes ?? {}).find((x) => x.owner === f.owner);
    const heroName = hero?.name ?? s.players[f.owner]?.name ?? f.owner;
    h += `<div class="row"><b>♔ ${esc(heroName)}</b> <span class="dim">${t('— проекция · +5% атаки/обороны этому флоту')}</span></div>`;
  }

  // CC-2 auto-storm: the whole «Дежурный режим» section moved to the ☰ command
  // row («⚔ Авто-штурм» toggle) — SO-UI unloads the bottom sheet.

  if (f.movement) {
    // total travel-time estimate to the final destination (next-hop ETA from the
    // authoritative schedule + the remaining route at base speed). The ETA ticks
    // every frame, so it's a placeholder here (stable signature → no rebuild) and
    // patched in place by updatePanelLive() — keeps the panel's buttons put.
    const dest = f.movement.destination ?? f.movement.to;
    // Гибкое время в пути: остаток маршрута за текущим лейном пересчитывается с
    // учётом форс-марша (×1.5 с СЛЕДУЮЩЕГО лейна — текущий уже расписан
    // авторитетно в arrivesAt, его не трогаем). Выключил буст — оценка удлиняется.
    const rawRestH =
      dest !== f.movement.to ? (estimateTravelHours(s, data, f.movement.to, dest, f) ?? 0) : 0;
    const restH = boosted ? rawRestH / FORCED_MARCH_MULT : rawRestH;
    h += `<div class="row">${t('↗ идёт к {dest} · прибытие через', { dest: `<b>${esc(dest)}</b>` })} <b class="pn-eta" data-arrive="${f.movement.arrivesAt}" data-rest="${restH}">…</b>${boosted ? ' <span class="dim">⚡</span>' : ''}</div>`;
  } else if (f.edge) {
    const pct = Math.round(f.edge.t * 100);
    h += `<div class="row">${t('⟜ стоит на трассе {lane} · {p}% пути', { lane: `<b>${esc(f.edge.from)}–${esc(f.edge.to)}</b>`, p: pct })}</div>`;
  }

  const here = planet(f.location);
  const docked = !!here && !f.movement && !f.battleId;
  if (f.battleId) {
    // The battle card (framework-agnostic view-model from @void/client): both
    // sides, hull bars, phase, live round countdown — and the one action, retreat.
    const bm = createBattleModel(s, f.battleId, ME, data);
    if (bm.ok) {
      const bar = (v: { current: number; max: number } | undefined, glyph: string): string =>
        v && v.max > 0 ? ` · ${glyph} ${kfmt(v.current)}/${kfmt(v.max)}` : '';
      const sideRow = (sv: BattleSideView, tag: string): string => {
        const troops = sv.units.map((u) => `${u.count}× ${u.unit}`).join(', ') || '—';
        return `<div class="row${sv.mine ? '' : ' dim'}">${sv.mine ? '▶' : '·'} <b>${esc(sv.ownerName)}</b> (${tag}, ${
          sv.kind === 'garrison' ? t('гарнизон') : sv.kind === 'landing' ? t('десант') : t('флот')
        }): ${esc(troops)}${bar(sv.hull, '♥')}${bar(sv.shield, '◈')}</div>`;
      };
      h += `<div class="sec">${t('⚔ Бой — {phase} · раунд {r}', { phase: bm.phase === 'ground' ? t('высадка') : t('орбита'), r: bm.round })}</div>`;
      h += sideRow(bm.attacker, t('атака')) + sideRow(bm.defender, t('оборона'));
      if (bm.nextRoundAt != null)
        h += `<div class="row">${t('следующий раунд через')} <span class="pn-timer" data-at="${bm.nextRoundAt}">…</span></div>`;
      h += `<div class="row">${btn('retreat', '', t('⤺ Отступить'), bm.retreatFleetId === f.id)}</div>`;
      h += `<div class="hint">${t('Отход стоит −40% ТЕКУЩЕГО корпуса и щита (израненный флот теряет 40% остатка — отход не добивает) и даёт рывок скорости для бегства. Десант в высадке отступить не может; с орбиты вне боя корабль уходит свободно.')}</div>`;
    }
  }
  if (docked) {
    // enemy/neutral world you can act on — empty space is pass-through only
    const hostile =
      here!.owner !== f.owner && (SECTOR_TYPES[SECTOR_OF[here!.id]]?.capturable ?? false);
    const cols: string[] = [];
    if (hostile) {
      let at = `<div class="sec">${t('Удар')}</div><div class="row">`;
      at += btn(
        'bombard',
        f.bombarding ? 'off' : 'on',
        f.bombarding ? t('⊗ Прекратить бомбардировку') : t('⊗ Бомбардировать'),
        inOrbit && nShips > 0,
      );
      at += btn('assault', '', t('⚔ Штурм'), inOrbit);
      at += `</div>`;
      at += `<div class="hint">${t('С орбиты можно бомбардировать (изнашивает здания и замораживает их выпуск), но ПВО гарнизона достаёт до вас. Штурм высаживает десант против гарнизона.')}</div>`;
      // Combat forecast (ONB-6): «если атакую — что будет?» — the pure base-model
      // sim over the landing force vs the garrison the viewer SEES (the fleet is
      // docked here, so the world is identified — no fog leak). A forecast, not an
      // oracle: terrain/fortification/tech bonuses of the live fight are not folded
      // in — the hedge in the copy says so.
      const landing = f.landing ?? [];
      const garrison = here!.garrison;
      if (landing.some((u) => u.count > 0) && garrison.some((u) => u.count > 0)) {
        const pv = previewBattle(landing, garrison, data);
        const verdict =
          pv.outcome === 'attacker'
            ? t('десант возьмёт мир')
            : pv.outcome === 'defender'
              ? t('гарнизон устоит')
              : t('затяжной пат');
        at += `<div class="row dim">${t(
          'Прогноз штурма: {v} · ~{r} р. · потери {a} дес. ({pa}%) / {d} гарн. ({pd}%)',
          {
            v: `<b>${verdict}</b>`,
            r: pv.roundsEst,
            a: previewLossCount(pv.attacker),
            pa: Math.round(pv.attacker.damageFraction * 100),
            d: previewLossCount(pv.defender),
            pd: Math.round(pv.defender.damageFraction * 100),
          },
        )}</div>`;
        at += `<div class="hint">${t('Прогноз по видимым составам, без бонусов местности, укреплений и технологий — реальный бой может отличаться.')}</div>`;
      }
      cols.push(at);
    }
    // load / unload ground army at your own world
    if (here!.owner === ME) {
      let ga = `<div class="sec">${t('Наземная армия ⇄ гарнизон')}</div>`;
      const groundHere = here!.garrison.filter((st) => isGround(st.unit));
      const carried = f.landing ?? [];
      const loadingN = pendingLoads.filter((p) => p.fleetId === f.id).length;
      const freeHold = fleetCargoFree(s, f) - pendingLoadCargo(f.id); // reserve in-progress loads
      if (groundHere.length) {
        ga += `<div class="row">`;
        for (const st of groundHere) {
          const sz = data.units[st.unit]?.stats.cargoSize ?? 1;
          ga += btn(
            'load',
            st.unit,
            t('▲ Погрузить {u}', { u: displayUnit(st.unit) }),
            sz <= freeHold,
          );
        }
        ga += `</div>`;
      }
      if (carried.length) {
        ga += `<div class="row">`;
        for (const st of carried)
          ga += btn('unload', st.unit, t('▼ Выгрузить {u}', { u: displayUnit(st.unit) }), true);
        ga += `</div>`;
      }
      if (loadingN)
        ga += `<div class="hint">${t('⏳ погрузка: {n} (≈1ч на единицу)', { n: loadingN })}</div>`;
      if (!groundHere.length && !carried.length && !loadingN)
        ga += `<div class="row dim">${t('наземной армии здесь нет')}</div>`;
      cols.push(ga);
    }
    const dh = fleetDivisionsHtml(f, here!); // load/unload divisions (landing on a hostile world)
    if (dh) cols.push(dh);
    h += pcols(cols);
  }
  return h;
}

/** Side-panel: a world outside sensor coverage — last-scan memory, or no telemetry. */
function unknownPlanetHtml(p: Planet): string {
  const mem = memory.get(p.id);
  if (mem) {
    const icons =
      mem.buildings
        .map((b) => `${BUILD_ICON[b.type] ?? '▪'} ${buildingName(b.type)} L${b.level}`)
        .join(', ') || t('построек не видели');
    // Espionage from memory: you know WHOSE world this was — an agent can reveal
    // its live contents without flying there. Wrong/stale owner → the kernel
    // rejects the attempt (bad target), which is honest: intel decays.
    const spyRow =
      mem.owner && mem.owner !== ME
        ? `<div class="row">${btn('spyplanet', mem.owner, t('🕵 Разведать мир · {c}¤', { c: SPY_COST }), afford({ credits: SPY_COST }))}</div>`
        : '';
    return (
      cardHeader(ownerColor(mem.owner), p.id, t('ПОСЛЕДНИЕ ДАННЫЕ ✦')) +
      `<div class="row dim">${t('Вне сенсорного охвата — последний скан (мог устареть).')}</div>` +
      `<div class="row">${t('Владелец')}: <b>${mem.owner ? NAME[mem.owner] : t('Нейтрал')}</b></div>` +
      `<div class="row">${t('Гарнизон на момент скана')}: <b>${mem.garrison}</b></div>` +
      `<div class="row">${t('Постройки')}: ${icons}</div>` +
      spyRow +
      `<div class="hint">${t('Обновите данные флотом или радаром.')}</div>`
    );
  }
  // No «Снять выделение» on planet cards: it only clears FLEET selection (selPlanet
  // stays, the card would not even close) — the ✕ in the corner is the real close.
  return (
    cardHeader('#5f8f8c', p.id, t('НЕТ ТЕЛЕМЕТРИИ')) +
    `<div class="row dim">${t('Не исследовано — вне сенсоров и радаров. Содержимое неизвестно.')}</div>` +
    `<div class="hint">${t('Отправьте флот к этой системе (или расширьте радар), чтобы обнаружить её.')}</div>`
  );
}

/** Side-panel: a known world — ownership header + ground/ships/squadron/buildings tabs. */
/** Карточка статистики мира (тап по имени планеты) — полная сводка: обозначение,
 *  владелец, вид/тип/местность, пассивный выход по ресурсам (ECON-7 перекос),
 *  бонусы типа, гарнизон, постройки, очки победы, флоты на орбите. */
function planetSummaryHtml(p: Planet): string {
  const rows: string[] = [];
  const pt = p.planetType ? data.planetTypes[p.planetType] : undefined;
  const ptName = tData(pt?.name ?? p.planetType ?? '—');
  const kindName = tData(SECTOR_TYPES[SECTOR_OF[p.id]]?.name ?? SECTOR_OF[p.id] ?? '—');
  const sec = tData(data.sectors[p.terrain ?? '']?.name ?? p.terrain ?? '—');
  const ground = p.garrison.filter((st) => isGround(st.unit));
  const ships = p.garrison.filter((st) => isShip(st.unit));
  const wing = p.garrison.filter((st) => isSquadron(st.unit));
  rows.push(`<div class="row">${t('Обозначение')}: <b>${esc(p.id)}</b></div>`);
  rows.push(
    `<div class="row">${t('Владелец')}: <b style="color:${ownerColor(p.owner)}">${p.owner ? esc(NAME[p.owner] ?? p.owner) : t('Нейтрал')}</b></div>`,
  );
  rows.push(
    `<div class="row">${t('Вид / тип / местность')}: <b>${esc(kindName)}</b> · ${esc(ptName)} · ${esc(sec)}</div>`,
  );
  // ECON-7: пассивный базовый выход мира по ресурсам — перекос типа планеты.
  const base = (pt?.baseOutput ?? {}) as Record<string, number>;
  const baseStr = ['metal', 'credits', 'food', 'energy']
    .filter((r) => (base[r] ?? 0) > 0)
    .map((r) => `${TECH_CUR[r] ?? tData(r)} ${base[r]}`)
    .join(' · ');
  if (baseStr)
    rows.push(
      `<div class="row">${t('Базовый выход/ч')}: <b>${baseStr}</b> <span class="dim">${t('— перекос типа мира')}</span></div>`,
    );
  const pctf = (n: number) => (n >= 0 ? '+' : '') + Math.round(n * 100) + '%';
  const bonus: string[] = [];
  if (pt && pt.productionBonus !== 0) bonus.push(`${t('произв.')} ${pctf(pt.productionBonus)}`);
  if (pt && (pt.defenseBonus ?? 0) !== 0)
    bonus.push(`${t('оборона')} ${pctf(pt.defenseBonus ?? 0)}`);
  if (bonus.length)
    rows.push(`<div class="row">${t('Бонусы типа')}: <b>${bonus.join(' · ')}</b></div>`);
  rows.push(
    `<div class="row">⚔ ${t('Гарнизон')}: <b>${sumUnits(ground)}</b> ${t('наземных')} · <b>${sumUnits(ships)}</b> ${t('кораблей')}${sumUnits(wing) ? ` · <b>${sumUnits(wing)}</b> ${t('эскадрилий')}` : ''}</div>`,
  );
  const blist =
    p.buildings
      .map(
        (b) =>
          `${BUILD_ICON[b.type] ?? '▣'} ${buildingName(b.type)}${b.level > 1 ? ' L' + b.level : ''}`,
      )
      .join(', ') || t('нет');
  rows.push(`<div class="row">▣ ${t('Постройки')} (${p.buildings.length}): <b>${blist}</b></div>`);
  rows.push(
    `<div class="row">✦ ${t('Очки победы')}: <b>${Math.round(provinceScore(data, p))}</b></div>`,
  );
  const here = Object.values(s.fleets).filter((f) => f.location === p.id);
  if (here.length) {
    const fShips = here.reduce((n, f) => n + sumUnits(f.units), 0);
    rows.push(
      `<div class="row">▲ ${t('Флоты на орбите')}: <b>${here.length}</b> <span class="dim">(${t('{n} кораблей', { n: fShips })})</span></div>`,
    );
  }
  if (p.owner === ME && capitalOf(s, ME) === p.id)
    rows.push(`<div class="row"><b style="color:var(--grn)">★ ${t('Столица')}</b></div>`);
  return (
    `<div class="sec">${t('Сводка мира')}</div>` +
    rows.join('') +
    `<div class="row">${btn('planetinfo', '', t('‹ Назад к карточке'), true)}</div>`
  );
}

function planetPanelHtml(p: Planet): string {
  const mine = p.owner === ME;
  const sec = tData(data.sectors[p.terrain ?? '']?.name ?? p.terrain ?? '—');
  const pt = p.planetType ? data.planetTypes[p.planetType] : undefined;
  const ptName = tData(pt?.name ?? p.planetType ?? '—');
  // Province type (the structural kind) — shown so the map's provinces read clearly.
  const kindName = tData(SECTOR_TYPES[SECTOR_OF[p.id]]?.name ?? SECTOR_OF[p.id] ?? '—');
  const ground = p.garrison.filter((st) => isGround(st.unit));
  const ships = p.garrison.filter((st) => isShip(st.unit));
  const wing = p.garrison.filter((st) => isSquadron(st.unit));
  const gcount = sumUnits(p.garrison);
  const here = Object.values(s.fleets).filter((f) => f.location === p.id);
  // Bytro-стиль: у мира авто-имя (тап → карточка статистики); координата (grid id)
  // остаётся отдельным обозначением в подзаголовке.
  const header = cardHeader(
    ownerColor(p.owner),
    planetName(p.id),
    `${esc(p.id)} · ${p.owner ? NAME[p.owner] : t('Нейтрал')} · ${kindName} · ${ptName} · ${sec}`,
    'planetinfo',
  );
  // Тап по имени открыл сводку мира — панель целиком уступает ей место.
  if (planetInfoFor === p.id) return header + planetSummaryHtml(p);
  let h =
    header +
    `<div class="pstats"><span data-desc="stat:garrison">⚔ ${gcount} <span class="pl">${t('гарнизон')}</span></span><span data-desc="stat:ground">${unitIcon('heavy_infantry')} ${sumUnits(ground)} <span class="pl">${t('наземных')}</span></span><span data-desc="stat:gships">${unitIcon('cruiser')} ${sumUnits(ships)} <span class="pl">${t('кораблей')}</span></span><span data-desc="stat:pbuild">▣ ${p.buildings.length} <span class="pl">${t('построек')}</span></span></div>`;
  // ECON-2: блэкаут — неоплаченная энергия глушит радары и ПВО этого владельца вдвое.
  if (mine && (s.players[ME]?.arrears ?? []).includes('energy')) {
    h += `<div class="row" style="color:var(--red)">⚡ ${t('блэкаут: радары и ПВО −50%')}</div>`;
  }
  if (pt && (pt.productionBonus !== 0 || pt.defenseBonus !== 0)) {
    const pct = (n: number) => (n >= 0 ? '+' : '') + Math.round(n * 100) + '%';
    const parts: string[] = [];
    if (pt.productionBonus !== 0) parts.push(t('произв. {p}', { p: pct(pt.productionBonus) }));
    if (pt.defenseBonus !== 0) parts.push(t('оборона {p}', { p: pct(pt.defenseBonus) }));
    h += `<div class="row dim">${pcUi() ? t('Тип: «{pt}» — {mods}', { pt: esc(ptName), mods: parts.join(' · ') }) : t('Мир типа «{pt}» — {mods}', { pt: esc(ptName), mods: parts.join(' · ') })}</div>`;
  }

  // Capital marker / designate — heroes respawn here (and re-fit modules, Phase C).
  if (mine) {
    if (capitalOf(s, ME) === p.id) {
      h += `<div class="row"><b style="color:var(--grn)">★ ${t('Столица')}</b>${compactUi() ? '' : ` <span class="dim">${t('— здесь возродятся и сменят модули герои')}</span>`}</div>`;
    } else if (isInhabited(p)) {
      h += `<div class="row">${btn('capital', '', t('★ Сделать столицей'), true)}</div>`;
    }
    // Hold point (ST-2.1): a standing order for the Steward — the anchor is never
    // auto-evacuated and gets reinforced under threat. Same tech gate as delegation.
    if (stewardTechDone()) {
      const points = s.players[ME]?.stewardHoldPoints ?? [];
      h += `<div class="row">${
        points.includes(p.id)
          ? `<b style="color:var(--cyan)">🚩 ${t('Точка удержания')}</b> ${btn('holdpoint', 'off', t('Снять точку'), true)}`
          : btn(
              'holdpoint',
              'on',
              compactUi() ? t('🚩 Держать') : t('🚩 Назначить точкой удержания'),
              points.length < MAX_STEWARD_HOLD_POINTS,
            )
      }</div>`;
    }
  }

  // Tactical ping — mark this province and share it (coalition chat, or a player's DM).
  h += `<div class="row">${btn('ping', '', compactUi() ? t('📍 Пинг') : t('📍 Пинг — отметить и отправить…'), true)}</div>`;

  // Espionage: steal a 24h intel window on this enemy world (SPY-1). While a
  // window lives its countdown replaces the button — the node stays identified.
  if (!mine && p.owner) {
    const live = myIntel().find((g) => g.kind === 'planet' && g.target === p.id);
    h += `<div class="row">${
      live
        ? `<b style="color:var(--cyan)">${t('🕵 Окно разведки')}</b> <span class="dim">${t('ещё {left}', { left: fmtEta(Math.max(0, live.until - s.time) / HOUR) })}</span>`
        : btn(
            'spyplanet',
            p.owner,
            t('🕵 Разведать мир · {c}¤', { c: SPY_COST }),
            afford({ credits: SPY_COST }),
          )
    }</div>`;
  }

  h += `<div class="ptabs">${tabButton('ground', t('Земля'), ground.length, 'tab:ground')}${tabButton(
    'ships',
    t('Флот'),
    ships.length + here.length,
    'tab:ships',
  )}${tabButton('squadron', t('Крылья'), wing.length, 'tab:squadron')}${tabButton('buildings', t('Здания'), p.buildings.length, 'tab:buildings')}</div>`;

  // Tab content is split into self-contained blocks; on desktop they flow into
  // side-by-side columns (filling the wide panel), on phones they stack vertically.
  const cols: string[] = [];
  if (planetTab === 'ground') {
    // PC: one tile row of icon·count chips (the tab's old bottom hint lives in the
    // ЗЕМЛЯ tab's hover dossier, 'tab:ground'). Mobile keeps the original row list
    // and bottom hint untouched.
    // ECON-1: голодный гарнизон — владелец мира в food-arrears теряет 25% на земле.
    const starving =
      p.owner === ME && ground.length > 0 && (s.players[ME]?.arrears ?? []).includes('food')
        ? `<div class="row" style="color:var(--red)">🍽 ${t('голод: −25% на земле')}</div>`
        : '';
    cols.push(
      `<div class="sec">${t('Наземные части')}</div>` +
        starving +
        (pcUi() ? garrisonTilesHtml(ground) : unitRows(ground)),
    );
    if (mine) {
      cols.push(divisionsHtml(p.id));
      const groundBuilds = BUILD_UNITS.filter((u) => isGround(u));
      cols.push(
        `<div class="sec">${t('Наземный конвейер')}</div>` +
          conveyorHtml(p.id, 'units') +
          buildButtons(p.id, groundBuilds, 'unit'),
      );
    }
    if (!pcUi()) {
      cols.push(
        `<div class="hint">${t('Наземные части обороняют ваши миры. Их можно погрузить на флот для захвата вражеских миров.')}</div>`,
      );
    }
  } else if (planetTab === 'ships') {
    // Built ships now auto-rally to orbit (see fleetLaunchModule), so the garrison
    // normally holds no spacecraft — only surface the section if some linger.
    if (ships.length) {
      cols.push(`<div class="sec">${t('Корабли в гарнизоне')}</div>` + unitRows(ships));
    }
    if (here.length) {
      let orbit = `<div class="sec">${t('Флоты на орбите')}</div>`;
      for (const f of here) {
        const fShips = sumUnits(f.units);
        const tr = sumUnits(f.landing ?? []);
        const sel = f.owner === ME ? btn('selfleet', f.id, t('Выбрать →'), true) : '';
        orbit += `<div class="asset-row" data-desc="fleet" style="color:${ownerColor(f.owner)}"><span class="bicon">▲</span><b>${t('{n} кораблей', { n: fShips })}${tr ? ' ' + t('+{n} десанта', { n: tr }) : ''}</b>${sel}</div>`;
      }
      cols.push(orbit);
    }
    if (mine) {
      const shipBuilds = BUILD_UNITS.filter((u) => isShip(u));
      cols.push(
        `<div class="sec">${t('Конвейер верфи')}</div>` +
          conveyorHtml(p.id, 'units') +
          buildButtons(p.id, shipBuilds, 'unit'),
      );
    }
    if (!pcUi()) {
      // PC carries this in the ФЛОТ tab's hover dossier ('tab:ships')
      cols.push(
        `<div class="hint">${t('Флот -ваше оружие и защита. Здесь вы можете заказывать корабли для пополнения флота.')}</div>`,
      );
    }
  } else if (planetTab === 'squadron') {
    if (wing.length) {
      cols.push(`<div class="sec">${t('Авиагруппа в гарнизоне')}</div>` + unitRows(wing));
    }
    if (mine) {
      const wingBuilds = BUILD_UNITS.filter((u) => isSquadron(u));
      cols.push(
        `<div class="sec">${t('Верфь авиагруппы')}</div>` +
          conveyorHtml(p.id, 'units') +
          buildButtons(p.id, wingBuilds, 'unit'),
      );
    }
    if (!pcUi()) {
      // PC carries this in the КРЫЛЬЯ tab's hover dossier ('tab:squadron')
      cols.push(
        `<div class="hint">${t('Носитель (◈) несёт эскадрильи (△). Запускайте авиагруппу из панели выбранного флота кнопкой «🛩 Запустить эскадрилью».')}</div>`,
      );
    }
  } else {
    cols.push(
      `<div class="sec">${t('Строительный конвейер')}</div>` +
        (mine
          ? conveyorHtml(p.id, 'buildings')
          : `<div class="row dim">${t('Строительная телеметрия врага недоступна')}</div>`),
    );
    let blds = `<div class="sec">${t('Здания')}</div>`;
    if (p.buildings.length === 0) blds += `<div class="row dim">${t('нет')}</div>`;
    for (const b of p.buildings) {
      const def = data.buildings[b.type];
      const max = def ? buildingMaxLevel(def) : 1;
      const prod = def ? producesLine(buildingLevel(def, b.level).produces) : '';
      blds += `<div class="asset-row" data-desc="b:${b.type}:${b.level}"><span class="bicon">${BUILD_ICON[b.type] ?? '▪'}</span><b>${buildingName(b.type)}</b><span class="dim">L${b.level}/${max} · ${t('оз')} ${floor(b.hp)}/${hpOfLevel(b.type, b.level)}${prod ? ` · <span class="prod">${prod}</span>` : ''}</span>`;
      if (mine && b.level < max) {
        const c = def?.upgrades[b.level - 1]?.cost;
        // hovering Upgrade previews the NEXT level's dossier (output it will unlock)
        blds += btn(
          'upgrade',
          b.type,
          compactUi() ? `▲ ${cost(c)}` : t('▲ Улучшить {c}', { c: cost(c) }),
          afford(c),
          `b:${b.type}:${b.level + 1}`,
        );
      }
      blds += `</div>`;
    }
    if (mine) {
      // Province-centric roster (data-driven): each province type lists what it can
      // raise (SECTOR_TYPES.allowedBuildings); absent = the default BUILDABLE set.
      const buildable = SECTOR_TYPES[SECTOR_OF[p.id]]?.allowedBuildings ?? BUILDABLE;
      const missing = buildable.filter((bt) => !p.buildings.some((b) => b.type === bt));
      if (missing.length) blds += buildButtons(p.id, missing, 'building');
    }
    cols.push(blds);
  }
  return h + pcols(cols);
}

/** The side-panel dispatcher: task group → single fleet → unknown world → known world. */
function panelHtml(): string {
  const group = [...selFleets].map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  if (group.length > 1) return taskGroupPanelHtml(group);
  if (selFleet) {
    const f = s.fleets[selFleet];
    if (f) return fleetPanelHtml(f); // a stale selection falls through to the planet
  }
  const p = planet(selPlanet);
  if (!p) return `<div class="hint">${t('Тапните мир.')}</div>`;
  if (!known(p.id) && p.owner !== ME) return unknownPlanetHtml(p);
  return planetPanelHtml(p);
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
  const name = tData(def.name);
  switch (id) {
    case 'mine':
      return {
        name,
        body: t('Буровая платформа вгрызается в планету и добывает {m}⬢ в час. Улучшение позволяет копать глубже, чтобы добраться до самых богатых жил. Основа для строительства флота.', { m: hl(metal) }),
      };
    case 'refinery':
      return {
        name,
        body: t('Перерабатывающий комплекс, превращающий руду и логистику в ликвидные кредиты — {c}¤ в час. Топливо для имперской бюрократии, верфей и наёмных эскадр.', { c: hl(credits) }),
      };
    case 'barracks':
      return {
        name,
        body: t('Казармы нужны для защиты вашего мира от захватчиков. Тут живут ваши доблестные защитники.'),
      };
    case 'radar':
      return {
        name,
        body: t('Комплекс радаров просвечивает пространство вокруг вашего мира и ловит вражеские сигнатуры задолго до того, как они посмеют на вас напасть. Улучшения обеспечивают большее покрытие.', { r: hl(lv.radarRange ?? 0) }),
      };
    case 'fort':
      return {
        name,
        body: t(
          'Эшелонированный планетарный бастион. Поднимает оборону гарнизона на {d} и держит {hp} структурной прочности под орбитальным огнём. Последний рубеж осаждённого мира.',
          { d: hl(pct(lv.defenseBonus ?? 0)), hp: hl(lv.hp) },
        ),
      };
    case 'starfort':
      return {
        name,
        body: t('Автономная крепость, возведённая в астероидное поле: {d} к обороне и {hp} прочности. Превращает безликий перекрёсток в укреплённый узел с орбитой и ПКО', { d: hl(pct(lv.defenseBonus ?? 0)), hp: hl(lv.hp) }),
      };
    case 'orbital_aa':
      return {
        name,
        body: t('Стационарная зенитная батарея защищает воздушное пространство вашего мира и наносит {dmg} урона в час по кораблям на орбите. Кошмар для бомбардировщиков, повисших над планетой, и для налетающих эскадрилий. Захват мира не блокирует — это дело наземной обороны; батарея лишь выкашивает флот над головой.', { dmg: hl(lv.aaDamage ?? 0) }),
      };
    case 'metal_station':
      return {
        name,
        body: t('Добывающая платформа, вгрызается в спёкшуюся кору мёртвого мира. Там, где аннигиляция выжгла всё живое, обнажилась чистая металлическая руда — станция качает {m}⬢ в час. Улучшение увеличивает добычу.', { m: hl(metal) }),
      };
    case 'tax_office':
      return {
        name,
        body: t('Налоговая управа имперского образца: сама ничего не добывает, но ставит на учёт население мира и поднимает его кредитный сбор на {b}.', { b: hl(pct(TAX_OFFICE_BONUS)) }),
      };
    case 'farm':
      return {
        name,
        body: t('Ярусы гидропонных оранжерей под спектральными лампами позволяют вашим подопечным питаться, ведь голод беспощаден. Выращивает {f}❖ в час. Ваши рабочие и воины едят каждый день, было бы глупо проиграть сражение из-за голодного обморока.', { f: hl(lv.produces.food ?? 0) }),
      };
    case 'power_plant':
      return {
        name,
        body: t('Термоядерный реактор питает энергией ваши миры, он производит {e}↯ в час. Энергия — кровь ваших построек, ведь они работают не на волшебстве. При дефиците всё проседает до половины мощности.', { e: hl(lv.produces.energy ?? 0) }),
      };
    case 'fabricator':
      return {
        name,
        body: t('Чистые цеха литографии печатают {m}▦ в час. Прожорлива к энергии и людям, зато её продукция ведёт эскадрильи и открывает осадные доктрины. Апгрейды окупаются собственной продукцией.', { m: hl(lv.produces.microelectronics ?? 0) }),
      };
    default:
      return { name, body: t('Планетарное сооружение.') };
  }
}

function unitDossier(id: string): Dossier | null {
  const def = data.units[id];
  if (!def) return null;
  const st = def.stats;
  switch (id) {
    case 'scout':
      return {
        name: t('Разведчик'),
        body: t(
          'Лёгкий разведывательный корпус. Быстрый (ход {sp}) и почти неслышный (сигнатура {sig}) — чертит карту пустоты там, куда боится соваться линейный флот.',
          { sp: hl(st.speed), sig: hl(def.signature ?? 1) },
        ),
      };
    case 'cruiser':
      return {
        name: t('Крейсер'),
        body: t(
          'Рабочая лошадь линейного флота: {a} атаки, {hp} корпуса и трюм на {c}. Универсальный боевой корабль, одинаково уверенный в обороне и в наступлении.',
          { a: hl(st.attack), hp: hl(st.hp), c: hl(st.cargoCapacity ?? 0) },
        ),
      };
    case 'siege':
      return {
        name: t('Осадная платформа'),
        body: t(
          'Тяжёлая осадная платформа: {a} урона с дистанции {r}, но тонкая броня ({d} защиты). Её место за спинами крейсеров, откуда она крушит укрепления и верфи.',
          { a: hl(st.attack), r: hl(st.range ?? 0), d: hl(st.defense) },
        ),
      };
    case 'strike_carrier':
      return {
        name: t('Ударный носитель'),
        body: t(
          'Медленный бронированный носитель ({hp} корпуса, трюм на {c}) — своих пушек почти нет, вся его сила в эскадрильях, что он несёт. Держите его позади и запускайте авиагруппу по цели кнопкой «🛩 Запустить эскадрилью».',
          { hp: hl(st.hp), c: hl(st.cargoCapacity ?? 0) },
        ),
      };
    case 'fighter_squadron':
      return {
        name: t('Истребительная эскадрилья'),
        body: t(
          'Палубная эскадрилья: стремительная (ход {sp}) и больно бьёт ({a} атаки), но брони почти нет ({hp} корпуса). Отделяется от носителя в отдельный быстрый флот и наносит удар с дистанции {r}. Контрится орбитальным ПВО — не гоните её на прикрытую ПВО планету.',
          { sp: hl(st.speed), a: hl(st.attack), hp: hl(st.hp), r: hl(st.strikeRange ?? 0) },
        ),
      };
    case 'hero':
      return {
        name: t('Флагман'),
        body: t(
          'Боевая проекция самого командующего — флагман во главе родного флота: {a} атаки и {hp} корпуса. Но решает не это: его присутствие держит эскадру в кулаке, давая {b} к атаке и обороне всем кораблям рядом. Падёт — командующий лишается проекции, пока та не отстроится заново на родном мире.',
          { a: hl(st.attack), hp: hl(st.hp), b: hl('+5%') },
        ),
      };
    default:
      // PC hover tooltip: the name alone is enough (an empty body is skipped by the
      // tooltip); the mobile tap-modal keeps the old filler line.
      return { name: displayUnit(id), body: pcUi() ? '' : t('Боевая единица.') };
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** "+10 металл/ч, +5 кредиты/ч" — the always-visible output readout on a built
 *  building's row (not just on hover). Empty string for a produces-less building
 *  (defense/radar/etc.), so the row's dim-text separator (" · ") is skipped. */
function producesLine(produces: Record<string, number>): string {
  return Object.entries(produces)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([res, n]) => `+${round1(n ?? 0)} ${tData(res)}/ч`)
    .join(', ');
}

/** Dossier for an in-flight/queued/paused construction/upgrade/unit order — "what is
 *  this, what does it yield NOW vs once finished". `progress` is 0 for a not-yet-
 *  started queued order, the live 0..1 fraction for an active one, or the frozen
 *  `PausedConstructionSite.progress` for a paused one; `remainingH` is null only for
 *  a queued order (it hasn't started, so there's no ETA yet). The same base+delta×ramp
 *  formula construction.ts/economy.ts use: for a fresh building `base` is 0 (nothing
 *  exists below the threshold), for an upgrade `base` is the CURRENT level's output
 *  (already running in full) and only the delta to the target level ramps in. */
function taskDossier(
  planetId: string,
  kind: BuildKind,
  building: string | undefined,
  unit: string | undefined,
  count: number | undefined,
  level: number | undefined,
  progress: number,
  remainingH: number | null,
): Dossier {
  const eta =
    remainingH !== null
      ? t('Осталось: {r}', { r: hl(fmtEta(remainingH)) })
      : t('В очереди — ещё не начато.');
  if (kind === 'unit' && unit) {
    return {
      name: `${count ?? 1}× ${unitIcon(unit)} ${displayUnit(unit)}`,
      body: [eta, t('По готовности пополнит гарнизон/флот планеты.')].join('<br>'),
    };
  }
  if (!building) return { name: t('Стройка'), body: eta };
  const def = data.buildings[building];
  if (!def) return { name: building, body: eta };
  const name =
    kind === 'upgrade'
      ? `${BUILD_ICON[building] ?? '▣'} ${tData(def.name)} → L${level ?? '?'}`
      : `${BUILD_ICON[building] ?? '▣'} ${tData(def.name)}`;
  const ramp = thresholdRamp(progress);
  let base: Record<string, number> = {};
  let final: Record<string, number> = {};
  if (kind === 'upgrade' && typeof level === 'number') {
    const instance = s.planets[planetId]?.buildings.find((b) => b.type === building);
    base = instance ? buildingLevel(def, instance.level).produces : {};
    final = buildingLevel(def, level).produces;
  } else {
    final = buildingLevel(def, 1).produces;
  }
  const lines: string[] = [];
  for (const res of new Set([...Object.keys(base), ...Object.keys(final)])) {
    const b = base[res] ?? 0;
    const f = final[res] ?? 0;
    if (b === 0 && f === 0) continue;
    const now = b + (f - b) * ramp;
    lines.push(
      t('{r}: {now}/ч сейчас → {final}/ч по готовности', {
        r: tData(res),
        now: hl(round1(now)),
        final: hl(round1(f)),
      }),
    );
  }
  return { name, body: [eta, ...lines].join('<br>') };
}

function constructionDossier(key: string): Dossier | null {
  const [, planetId, lane, state, ref] = key.split(':');
  if (!planetId || !lane || !state || ref === undefined) return null;
  if (state === 'active') {
    const active = activeConstruction(planetId, lane as BuildLane);
    if (!active || String(active.seq) !== ref) return null;
    const p = active.payload;
    return taskDossier(
      planetId,
      (p.kind ?? 'building') as BuildKind,
      p.building,
      p.unit,
      p.count,
      p.level,
      progressPct(active) / 100,
      Math.max(0, (active.at - s.time) / HOUR),
    );
  }
  if (state === 'queued') {
    const q = queueOf(planetId)[lane as BuildLane][Number(ref)];
    if (!q) return null;
    const level =
      q.kind === 'upgrade'
        ? (s.planets[planetId]?.buildings.find((b) => b.type === q.id)?.level ?? 0) + 1
        : undefined;
    return taskDossier(
      planetId,
      q.kind,
      q.kind === 'unit' ? undefined : q.id,
      q.kind === 'unit' ? q.id : undefined,
      q.count,
      level,
      0,
      null,
    );
  }
  if (state === 'paused') {
    const site = (s.planets[planetId]?.pausedConstruction ?? []).find((p) => String(p.id) === ref);
    if (!site) return null;
    return taskDossier(
      planetId,
      site.kind,
      site.building,
      site.unit,
      site.count,
      site.level,
      site.progress,
      site.remainingHours,
    );
  }
  return null;
}

function objDossier(key: string): Dossier | null {
  if (key === 'fleet') {
    return {
      name: t('Флот'),
      body: t(
        'Мобильное оперативное соединение кораблей. Выберите его, чтобы отдавать приказы на манёвр, орбиту и удар по врагу.',
      ),
    };
  }
  if (key === 'tab:ground') {
    // The ЗЕМЛЯ tab's hover dossier — carries what used to be the tab's bottom hint.
    return {
      name: t('Земля'),
      body: t('Наземные части обороняют ваши миры. Их можно погрузить на флот для захвата вражеских миров.'),
    };
  }
  if (key === 'tab:ships') {
    return {
      name: t('Флот'),
      body: t('Флот -ваше оружие и защита. Здесь вы можете заказывать корабли для пополнения флота.'),
    };
  }
  if (key === 'tab:squadron') {
    return {
      name: t('Крылья'),
      body: t(
        'Носитель (◈) несёт эскадрильи (△). Запускайте авиагруппу из панели выбранного флота кнопкой «🛩 Запустить эскадрилью».',
      ),
    };
  }
  if (key === 'tab:buildings') {
    return {
      name: t('Здания'),
      body: t('Постройки мира и строительный конвейер: состояние, уровни и улучшения.'),
    };
  }
  if (key === 'division') {
    return {
      name: t('Дивизия'),
      body: t(
        'Наземное соединение, собранное по шаблону. Обороняет мир; грузится на флот из панели флота.',
      ),
    };
  }
  if (key.startsWith('stat:')) {
    const STAT_DOSSIER: Record<string, [string, string]> = {
      atk: [t('Атака'), t('Суммарная атака кораблей флота.')],
      def: [t('Защита'), t('Суммарная защита кораблей флота.')],
      hp: [t('Очки здоровья'), t('Суммарная прочность кораблей флота.')],
      cap: [
        t('Линия огня'),
        t(
          'В залпе бьют максимум {n} юнитов — сильнейшие первыми; все сверх капа только впитывают урон.',
          {
            n: COMBAT_UNIT_CAP,
          },
        ),
      ],
      hull: [
        t('Корпус'),
        t(
          'Текущая/полная прочность армии. Чинится у своего мира с верфью — или мгновенно за кредиты.',
        ),
      ],
      shield: [
        t('Щит'),
        t('Аблятивный щит: принимает урон первым и бесплатно восстанавливается вне боя.'),
      ],
      spd: [
        t('Скорость'),
        t('Скорость перелёта — флот движется со скоростью самого медленного корабля.'),
      ],
      garrison: [t('Гарнизон'), t('Численность наземных войск, обороняющих мир.')],
      ground: [t('Наземные части'), t('Пехота и техника на поверхности мира.')],
      gships: [t('Корабли в гарнизоне'), t('Корабли, стоящие в гарнизоне мира (не на орбите).')],
      pbuild: [t('Постройки'), t('Число построек на мире.')],
      datk: [t('Атака'), t('Суммарная атака дивизии.')],
      ddef: [t('Защита'), t('Суммарная защита дивизии.')],
      dhp: [t('ОЗ'), t('Суммарные очки здоровья дивизии.')],
    };
    const d = STAT_DOSSIER[key.slice(5)];
    return d ? { name: d[0], body: d[1] } : null;
  }
  if (key.startsWith('res:')) {
    // Resource glyph → the resource's localized name (data name, e.g. metal/credits).
    const r = key.slice(4);
    return { name: tData(r), body: '' };
  }
  if (key === 'act:divdesign') {
    return {
      name: t('Конструктор дивизий'),
      body: t('Редактор шаблонов: состав слотов и доктрина дивизий.'),
    };
  }
  if (key.startsWith('c:')) return constructionDossier(key);
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
  if (kind === 'm') {
    // ONB-4 glossary article — a short mechanic/term explainer (plain text copy).
    const g = GLOSSARY.find((x) => x.id === id);
    if (!g) return '';
    return (
      `<div class="cx-head"><span class="cx-ic">?</span><b>${esc(t(g.title))}</b><span class="cx-tag">${t('механика')}</span></div>` +
      `<div class="cx-desc">${esc(t(g.body))}</div>`
    );
  }
  if (kind === 'b') {
    const def = data.buildings[id];
    if (!def) return '';
    const lv = buildingLevel(def, 1);
    const maxLvl = 1 + (def.upgrades?.length ?? 0);
    const rows = [
      cxRow(t('Стоимость'), cost(def.cost)),
      cxRow(t('Время постройки'), t('{n} ч', { n: def.buildTimeHours ?? 0 })),
      cxRow(t('Прочность'), String(def.hp ?? 0)),
    ];
    const prod = Object.entries(lv.produces ?? {})
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([r, n]) => t('{n} {r}/ч', { n: n ?? 0, r: tData(r) }))
      .join(', ');
    if (prod) rows.push(cxRow(t('Производит'), prod));
    const keep = Object.entries(lv.upkeep ?? {})
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([r, n]) => t('{n} {r}/день', { n: n ?? 0, r: tData(r) }))
      .join(', ');
    if (keep) rows.push(cxRow(t('Содержание'), keep));
    if ((lv.defenseBonus ?? 0) > 0.01)
      rows.push(cxRow(t('Оборона гарнизона'), `+${Math.round((lv.defenseBonus ?? 0) * 100)}%`));
    if ((lv.aaDamage ?? 0) > 0) rows.push(cxRow(t('ПВО'), String(lv.aaDamage)));
    if ((lv.radarRange ?? 0) > 0) rows.push(cxRow(t('Радиус радара'), String(lv.radarRange)));
    if ((def.scoreValue ?? 0) > 0)
      rows.push(cxRow(t('Очки победы'), t('{n} / уровень', { n: def.scoreValue ?? 0 })));
    rows.push(cxRow(t('Уровней'), maxLvl > 1 ? t('{n} (улучшаемо)', { n: maxLvl }) : '1'));
    const dos = buildingDossier(id, 1);
    return (
      `<div class="cx-head"><span class="cx-ic">${BUILD_ICON[id] ?? '▣'}</span><b>${esc(tData(def.name))}</b><span class="cx-tag">${t('здание')}</span></div>` +
      `<div class="cx-stats">${rows.join('')}</div><div class="cx-desc">${dos?.body ?? ''}</div>`
    );
  }
  // ARS-5: module/hero-fitting cards deep-link here too — the arsenal witryna is the
  // first caller for kinds the codex never covered (only units/buildings had pages).
  if (kind === 'md') {
    const def = data.modules[id];
    if (!def) return '';
    const rows = [cxRow(t('Слот'), tData(def.slot)), cxRow(t('Стоимость'), cost(def.cost))];
    for (const [k, v] of Object.entries(def.effects?.stats ?? {}))
      rows.push(cxRow(tData(k), String(v)));
    return (
      `<div class="cx-head"><span class="cx-ic">◆</span><b>${esc(tData(def.name))}</b><span class="cx-tag">${t('модуль')}</span></div>` +
      `<div class="cx-stats">${rows.join('')}</div>`
    );
  }
  if (kind === 'hf') {
    const def = data.heroFittings[id];
    if (!def) return '';
    const rows = [cxRow(t('Стоимость'), cost(def.cost))];
    for (const [k, v] of Object.entries(def.statMods ?? {}))
      rows.push(cxRow(tData(k), (v > 0 ? '+' : '') + String(v)));
    return (
      `<div class="cx-head"><span class="cx-ic">◆</span><b>${esc(tData(def.name))}</b><span class="cx-tag">${t('фитинг')}</span></div>` +
      `<div class="cx-stats">${rows.join('')}</div><div class="cx-desc">${esc(tData(def.description ?? ''))}</div>`
    );
  }
  const def = data.units[id];
  if (!def) return '';
  const st = def.stats;
  const rows = [
    cxRow(t('Стоимость'), cost(def.cost)),
    cxRow(t('Время постройки'), t('{n} ч', { n: def.buildTimeHours ?? 0 })),
    cxRow(t('Атака / Оборона'), `${st.attack ?? 0} / ${st.defense ?? 0}`),
    cxRow(t('Корпус'), String(st.hp ?? 0)),
  ];
  if ((st.speed ?? 0) > 0) rows.push(cxRow(t('Скорость'), String(st.speed)));
  if ((st.range ?? 0) > 0) rows.push(cxRow(t('Дальность'), String(st.range)));
  if ((st.cargoCapacity ?? 0) > 0)
    rows.push(cxRow(t('Вместимость трюма'), String(st.cargoCapacity)));
  if ((st.aaDamage ?? 0) > 0) rows.push(cxRow(t('ПВО'), String(st.aaDamage)));
  rows.push(cxRow(t('Радарная сигнатура'), String(def.signature ?? 1)));
  if ((def.radarRange ?? 0) > 0) rows.push(cxRow(t('Радиус радара'), String(def.radarRange)));
  const upkeep = Object.entries(def.upkeep ?? {})
    .map(([r, n]) => t('{n} {r}/день', { n: n ?? 0, r: tData(r) }))
    .join(', ');
  if (upkeep) rows.push(cxRow(t('Содержание'), upkeep));
  const tags = [def.domain ?? 'space', def.line, ...(def.traits ?? [])]
    .filter((x): x is string => !!x)
    .map((x) => tData(x))
    .join(', ');
  if (tags) rows.push(cxRow(t('Класс'), tags));
  const dos = unitDossier(id);
  return (
    `<div class="cx-head"><span class="cx-ic">${unitIcon(id)}</span><b>${esc(dos?.name ?? displayUnit(id))}</b><span class="cx-tag">${def.domain === 'ground' ? t('наземный юнит') : t('корабль')}</span></div>` +
    `<div class="cx-stats">${rows.join('')}</div><div class="cx-desc">${dos?.body ?? ''}</div>`
  );
}
// --- player card (tap the top-left crest) ------------------------------------
/** Your dossier in this session: faction, worlds, fleets, score, and the treasury.
 *  Opened by tapping the crest in the top-left corner. */
function playerCardHtml(): string {
  const pl = s.players[ME];
  const name = pl?.name ?? NAME[ME] ?? ME;
  // H3: the LIVE faction (chosen at setup, stamped on the player) — name + its passive.
  const fid = pl?.faction ?? SEAT_META.find((m) => m.id === ME)?.faction ?? '';
  const fdef = data.factions[fid];
  const bonus = factionBonusLine(fid);
  const faction = fdef ? `${tData(fdef.name)}${bonus ? ` · ${bonus}` : ''}` : fid || '—';
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
  const row = (k: string, v: string) =>
    `<div class="pc-row"><span class="pc-k">${k}</span><span class="pc-v">${v}</span></div>`;
  return (
    `<div class="pc-head"><span class="pc-dia" style="background:${col};box-shadow:0 0 10px ${col}"></span>` +
    `<b>${esc(name)}</b><span class="pc-tag">${t('командующий')}</span></div>` +
    `<div class="pc-stats">` +
    row(t('Фракция'), esc(faction)) +
    row(t('Миров под контролем'), String(worlds)) +
    row(t('Юнитов'), String(units)) +
    row(t('Очки'), `${score} / ${SCORE_LIMIT}${need === 0 ? ' · ★ ' + t('ПОБЕДА') : ''}`) +
    `</div><div class="pc-sec">${t('Боевой счёт')}</div><div class="pc-stats">` +
    row(t('⚔ Уничтожено юнитов врага'), kfmt(killStats.destroyed)) +
    row(t('☠ Потеряно своих'), kfmt(killStats.lost)) +
    `</div><button class="pc-close">${t('ЗАКРЫТЬ')}</button>`
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
/** Localized stance label (canonical Russian msgid → the locale translates). */
function stanceRu(st: DiplomaticStance): string {
  return t(STANCE_RU[st]);
}
const STANCE_COLOR: Record<DiplomaticStance, string> = {
  war: '#ff5a4d',
  peace: '#9fb8c0',
  pact: '#35d6e6',
  alliance: '#5ff0a8',
};
// Friendliness rank: war (hostile) < peace < pact < alliance (closest). Warming the
// relation up a rank needs the other side's consent; cooling it down is unilateral.
const STANCES: DiplomaticStance[] = ['war', 'peace', 'pact', 'alliance'];

function worldsOf(id: string): number {
  let n = 0;
  for (const p of Object.values(s.planets)) if (p.owner === id) n++;
  return n;
}
/** A seat the AI drives. Everyone else (ME, or another human in net play) is human —
 *  this drives the roster's human/AI icon and whether a proposal is auto-decided. */
function isAiSeat(id: string): boolean {
  // The authoritative flag lives in state (Player.ai, seeded by newGame). The local
  // AI_PLAYERS set stays only as a local-mode fallback for installed scenarios; in
  // NET play the server state is the single source — a human-claimed seat is human.
  return s.players[id]?.ai === true || (!NET && AI_PLAYERS.has(id));
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

/** Append a line to the session log (bounded). Patches the feed if it's on screen. */
/** Unread social events (war declarations, stance shifts) — badge on the ✉ rail. */
let unreadMsgs = 0;
/** Diplomacy events don't pass the server's fog filter (their payload names no
 *  location a client owns), so a NET client would never hear a war being declared
 *  on it or a peace being offered. Diff the stance map AND the offer ledger of
 *  consecutive snapshots for pairs with ME and surface changes through the normal
 *  note/DM path. (The offer ledger rides the delta already fogged to the pair.)
 *  Returns true when something shifted — the CALLER re-renders the roster after
 *  it assigns the new state (rendering here would paint from the old `s`). */
function diffNetDiplomacy(prev: GameState, next: GameState): boolean {
  let shifted = false;
  const keys = new Set([
    ...Object.keys(prev.diplomacy ?? {}),
    ...Object.keys(next.diplomacy ?? {}),
  ]);
  for (const key of keys) {
    if (!pairHas(key, ME)) continue;
    const before = prev.diplomacy?.[key] ?? 'war';
    const after = next.diplomacy?.[key] ?? 'war';
    if (before === after) continue;
    const [a, b] = key.split('|');
    const other = a === ME ? b! : a!;
    const who = NAME[other] ?? other;
    if (after === 'war') note(t('⚔ {who} объявил вам войну!', { who }));
    else note(t('🕊 {who}: отношения → {stance}', { who, stance: stanceRu(after) }));
    pushMsg(other, t('Стойка изменена: {stance}', { stance: stanceRu(after) }), true, other);
    unreadMsgs++;
    shifted = true;
  }
  const offKeys = new Set([
    ...Object.keys(prev.diplomacyOffers ?? {}),
    ...Object.keys(next.diplomacyOffers ?? {}),
  ]);
  for (const key of offKeys) {
    const before = prev.diplomacyOffers?.[key];
    const after = next.diplomacyOffers?.[key];
    if (before === after || !after) continue; // withdrawals ride the stance toast above
    const [from, to] = key.split('>');
    if (to === ME) {
      const who = NAME[from!] ?? from!;
      note(
        t('🕊 {who} предлагает: {stance} — ответьте тем же в Дипломатии', {
          who,
          stance: stanceRu(after),
        }),
      );
      pushMsg(from!, t('Предложение: {stance}', { stance: stanceRu(after) }), true, from!);
      unreadMsgs++;
      shifted = true;
    } else if (from === ME) {
      note(
        t('⏳ {who}: предложение отправлено — {stance}', {
          who: NAME[to!] ?? to!,
          stance: stanceRu(after),
        }),
      );
      shifted = true;
    }
  }
  return shifted;
}

function pushMsg(to: string, text: string, sys: boolean, from = ME, ping?: string): void {
  sessionMessages.push({ at: s.time, from, to, text, sys, ping, realAt: Date.now() });
  if (sessionMessages.length > 300) sessionMessages.shift();
  if (diploOpen && diploTab === 'msgs') renderDiploFeed();
  if (chatOpen && !chatMin) renderChatFeed();
}

/** Route an outgoing chat line for conversation key `key` (a group channel const or
 *  a seat id = DM). NET: the server relays it and echoes a `chat.msg` back — the echo
 *  is what appends the line (see onChatMessage), so everyone renders the same
 *  server-stamped message. Solo: append locally. */
function dispatchChat(key: string, text: string): void {
  if (NET && netClient) {
    if (key === CH_GLOBAL) {
      note(t('глобальный канал появится вместе с глобальным сервером'));
      return;
    }
    if (key === CH_SESSION) netClient.sendChat('session', text);
    else if (key === COALITION) netClient.sendChat('coalition', text);
    else netClient.sendChat('dm', text, key);
    return;
  }
  pushMsg(key, text, false);
}

/** Player-driven stance change toward `target`. Escalation (toward war) is
 *  unilateral; warming the relation up files an OFFER the target must answer with
 *  the same declaration (consent — game.ts diplomacyModule). A bot answers on the
 *  spot by its favour meter; a human sees the offer in their roster (NET: the offer
 *  ledger rides the fogged delta) and taps the highlighted stance to accept. */
function proposeStance(target: string, to: DiplomaticStance): void {
  if (target === ME || !s.players[target]) return;
  if (getStance(s, ME, target) === to) return;
  if (to === 'alliance' && isAiSeat(target)) {
    note(t('Боты не вступают в коалиции'));
    return;
  }
  // diplomacy.declare escalates / files the offer / commits a matching counter-offer;
  // feedback comes back uniformly via handleEvents (solo) or the snapshot diff (NET).
  playerOrder(declareWar(ME, target, to));
}

function openDiplo(tab: 'diplo' | 'msgs' | 'intel'): void {
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
/** A bot's approval-of-you meter (game.ts botDiplomacyModule). A bot only ever sits at
 *  ≤ FAVOUR_BASE, so a full bar = its passive-friendly baseline; your aggression drains it
 *  past the embargo tick (won't trade on the market) and then the war tick (declares war).
 *  Only shown for AI seats — humans have no favour meter. */
function favourBarHtml(bot: string): string {
  const f = botFavour(s, bot, ME);
  const pct = clamp(f / FAVOUR_BASE, 0, 1) * 100;
  const embPct = (FAVOUR_EMBARGO / FAVOUR_BASE) * 100;
  const warPct = (FAVOUR_WAR / FAVOUR_BASE) * 100;
  const tier = f < FAVOUR_WAR ? 'war' : f < FAVOUR_EMBARGO ? 'embargo' : 'ok';
  const label =
    tier === 'war' ? t('на грани войны') : tier === 'embargo' ? t('эмбарго') : t('дружелюбно');
  const title = t(
    'Одобрение бота: {f}/{base} — {label}. Ниже {emb} бот вводит эмбарго на рынке, ниже {war} — объявляет войну.',
    {
      f: Math.round(f),
      base: FAVOUR_BASE,
      label,
      emb: FAVOUR_EMBARGO,
      war: FAVOUR_WAR,
    },
  );
  return (
    `<div class="dp-fav ${tier}" title="${esc(title)}">` +
    `<span class="dp-fav-cap">☺</span>` +
    `<div class="dp-fav-track"><div class="dp-fav-fill" style="width:${pct.toFixed(1)}%"></div>` +
    `<span class="dp-fav-tick emb" style="left:${embPct.toFixed(1)}%"></span>` +
    `<span class="dp-fav-tick war" style="left:${warPct.toFixed(1)}%"></span></div>` +
    `<span class="dp-fav-lbl">${label}</span></div>`
  );
}
/** Live stolen-intel readout for one seat (under its expanded actions): the
 *  treasury window prints the victim's actual resources, a fleets window says the
 *  map shows them, planet windows list the scanned worlds. Empty when nothing lives. */
function intelRowHtml(target: string): string {
  const bits: string[] = [];
  for (const g of myIntel()) {
    const left = fmtEta(Math.max(0, g.until - s.time) / HOUR);
    if (g.kind === 'treasury' && g.target === target) {
      const r = s.players[target]?.resources ?? {};
      const bag = Object.entries(r)
        .map(([k, v]) => `${TECH_CUR[k] ?? k}${Math.floor(v as number)}`)
        .join(' ');
      bits.push(t('казна: <b>{bag}</b> <em>{left}</em>', { bag: bag || '—', left }));
    } else if (g.kind === 'fleets' && g.target === target) {
      bits.push(t('флоты видны на карте <em>{left}</em>', { left }));
    } else if (g.kind === 'planet' && s.planets[g.target]?.owner === target) {
      bits.push(t('мир <b>{id}</b> раскрыт <em>{left}</em>', { id: esc(g.target), left }));
    }
  }
  if (!bits.length) return '';
  return `<div class="dp-intel">🕵 ${bits.join(' · ')}</div>`;
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
  if (!ordered.length) return `<div class="dp-empty">${t('Под фильтр никто не подходит.')}</div>`;
  return ordered
    .map((id) => {
      const bdg = seatBadge(id);
      const col = ownerColor(id);
      const w = worldsOf(id);
      const isMe = id === ME;
      const st = isMe ? null : getStance(s, ME, id);
      const stanceTag = isMe
        ? `<span class="dp-tag">${t('ВЫ')}</span>`
        : `<span class="dp-stance" style="color:${STANCE_COLOR[st!]};border-color:${STANCE_COLOR[st!]}">${stanceRu(st!)}</span>`;
      // Bots (AI seats) carry a favour meter toward you; humans/you don't.
      const favBar = !isMe && isAiSeat(id) ? favourBarHtml(id) : '';
      const expanded = diploExpanded === id && !isMe;
      const actions = expanded
        ? `<div class="dp-actions">` +
          STANCES.map((sk) => {
            const barred = sk === 'alliance' && isAiSeat(id); // боты не вступают в коалиции
            // Consent affordances: THEIR pending offer of this stance → tapping accepts
            // (✓, pulsing); MY pending offer → sent, waiting on them (⏳, disabled).
            const theirs = !barred && getOffer(s, id, ME) === sk;
            const mine = !barred && !theirs && getOffer(s, ME, id) === sk;
            const cls = `dp-act${sk === st ? ' on' : ''}${theirs ? ' offer' : ''}${mine ? ' pend' : ''}`;
            const label = theirs ? `✓ ${stanceRu(sk)}` : mine ? `⏳ ${stanceRu(sk)}` : stanceRu(sk);
            const title = barred
              ? t('Боты не вступают в коалиции')
              : theirs
                ? t('{who} предлагает — нажмите, чтобы принять', { who: NAME[id] ?? id })
                : mine
                  ? t('предложение уже отправлено')
                  : '';
            return `<button class="${cls}" data-stance="${sk}" data-seat="${id}" style="--sc:${STANCE_COLOR[sk]}"${barred || mine ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
          }).join('') +
          `<button class="dp-spy" data-spy="treasury" data-seat="${id}" title="${t('Украсть данные казны · {c}¤ · шанс ~60% · окно 24ч (плата сгорает и при провале)', { c: SPY_COST })}">🕵 ${t('казна')}</button>` +
          `<button class="dp-spy" data-spy="fleets" data-seat="${id}" title="${t('Украсть данные о флотах · {c}¤ · шанс ~60% · окно 24ч (плата сгорает и при провале)', { c: SPY_COST })}">🕵 ${t('флоты')}</button>` +
          `<button class="dp-msg" data-msgseat="${id}">✉</button></div>` +
          intelRowHtml(id)
        : '';
      return (
        `<div class="dp-row${expanded ? ' open' : ''}${isMe ? ' me' : ''}"${isMe ? '' : ` data-seat="${id}"`}>` +
        `<span class="dp-ic" style="color:${col}">${bdg.icon}</span>` +
        `<span class="dp-name">${esc(NAME[id] ?? id)} <em>${bdg.tag}</em></span>` +
        `<span class="dp-w" title="${t('провинций')}">⬣ ${w}</span>` +
        stanceTag +
        favBar +
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
      !GROUP_CHANNELS.has(m.to) &&
      ((m.from === ME && m.to === key) || (m.from === key && m.to === ME)),
  );
}
function convoLast(key: string): SessionMsg | undefined {
  const ms = convoMessages(key);
  return ms[ms.length - 1];
}
function fromName(id: string): string {
  return id === ME ? t('Вы') : (NAME[id] ?? id);
}
/** One message line. A ping renders as a clickable marker that flies the camera.
 *  `stamp` overrides which time fields show (the chat passes its cached toggles);
 *  omitted → the default `Day N · HH:MM` used by the diplomacy feed. */
function convoLineHtml(m: SessionMsg, stamp?: StampOpts): string {
  const stampTxt = fmtStamp(m.at, stamp && { ...stamp, realAt: m.realAt });
  if (m.ping) {
    return (
      `<div class="dp-line ping" data-ping="${esc(m.ping)}"><span class="dp-when">${stampTxt}</span>` +
      `📍 <b>${esc(fromName(m.from))}</b> ${esc(m.ping)}: ${esc(m.text)}<span class="dp-jump">${t('↪ камера')}</span></div>`
    );
  }
  if (m.sys)
    return `<div class="dp-line sys"><span class="dp-when">${stampTxt}</span>${esc(m.text)}</div>`;
  return `<div class="dp-line${m.from === ME ? ' me' : ''}"><span class="dp-when">${stampTxt}</span><b>${esc(fromName(m.from))}:</b> ${esc(m.text)}</div>`;
}
function convoFeedInnerHtml(key: string): string {
  const msgs = convoMessages(key);
  if (msgs.length) return msgs.map((m) => convoLineHtml(m)).join('');
  const hint =
    key === COALITION
      ? t('Чат коалиции пуст.<br>Отметьте провинцию пингом 📍 или напишите.')
      : key === CH_SESSION
        ? t('Общий канал матча — вас слышат все участники.')
        : t('Сообщений пока нет.');
  return `<div class="dp-empty">${hint}</div>`;
}
/** Left column: the match-wide session channel + the coalition channel pinned on
 *  top, then a DM per participant (most-recently-active first). Selecting one
 *  opens its thread on the right. Session here is what makes the NET chat fully
 *  reachable from a PHONE — the floating chat window is desktop-only. */
function convoListHtml(): string {
  const dms = diploSeats()
    .filter((id) => id !== ME)
    .sort(
      (a, b) =>
        (convoLast(b)?.at ?? -1) - (convoLast(a)?.at ?? -1) ||
        (NAME[a] ?? a).localeCompare(NAME[b] ?? b),
    );
  const sessLast = convoLast(CH_SESSION);
  const sessPrev = sessLast
    ? esc((sessLast.from === ME ? t('Вы') + ': ' : '') + sessLast.text)
    : t('{n} уч.', { n: Object.keys(s.players).length });
  const sess =
    `<button class="dp-cv coal${convoOpen === CH_SESSION ? ' on' : ''}" data-convo="${CH_SESSION}">` +
    `<span class="dp-cv-ic" style="color:var(--cyan)">△</span>` +
    `<span class="dp-cv-nm">${t('Сессия')}<em>${sessPrev}</em></span></button>`;
  const coal =
    `<button class="dp-cv coal${convoOpen === COALITION ? ' on' : ''}" data-convo="${COALITION}">` +
    `<span class="dp-cv-ic" style="color:var(--amber)">⚡</span>` +
    `<span class="dp-cv-nm">${t('Коалиция')}<em>${t('{n} уч.', { n: coalitionMembers().length })}</em></span></button>`;
  const items = dms
    .map((id) => {
      const last = convoLast(id);
      const prev = last
        ? esc(
            (last.from === ME ? t('Вы') + ': ' : '') + (last.ping ? '📍 ' + last.ping : last.text),
          )
        : '—';
      return (
        `<button class="dp-cv${convoOpen === id ? ' on' : ''}" data-convo="${id}">` +
        `<span class="dp-cv-ic" style="color:${ownerColor(id)}">${seatBadge(id).icon}</span>` +
        `<span class="dp-cv-nm">${esc(NAME[id] ?? id)}<em>${prev}</em></span></button>`
      );
    })
    .join('');
  return `<div class="dp-cvlist">${sess}${coal}${items}</div>`;
}
/** Right column: header, the open conversation's messages, and the composer (with a
 *  ping button in the coalition channel). */
function convoThreadHtml(): string {
  const isCoal = convoOpen === COALITION;
  const title =
    convoOpen === CH_SESSION
      ? t('△ Сессия · {n} в матче', { n: Object.keys(s.players).length })
      : isCoal
        ? t('⚡ Коалиция · {n} уч.', { n: coalitionMembers().length })
        : `${seatBadge(convoOpen).icon} ${esc(NAME[convoOpen] ?? convoOpen)}`;
  const pingBtn = isCoal
    ? `<button class="dp-ping" title="${t('Отметить выбранную провинцию пингом')}">📍</button>`
    : '';
  // The composer is networked (chat.send relay): dispatchChat routes it — NET sends
  // to the server (rendered from the echo), solo appends locally.
  const compose = `<div class="dp-compose">${pingBtn}<input id="dp-text" maxlength="160" placeholder="${t('Сообщение…')}" autocomplete="off"><button class="dp-send">▶</button></div>`;
  return (
    `<div class="dp-thread">` +
    `<div class="dp-thhead">${title}</div>` +
    `<div class="dp-feed" id="dp-feed">${convoFeedInnerHtml(convoOpen)}</div>` +
    compose +
    `</div>`
  );
}

/** SPY-UX (плейтест, вариант 1): весь шпионаж в одном месте — активные окна интела
 *  с таймерами, операции по каждому противнику (те же .dp-spy обработчики, что и в
 *  ростере) и сессионный журнал попыток. Разведка мира остаётся на карточке планеты
 *  (нужна цель) — вкладка ведёт к ней подсказкой. */
function intelTabHtml(): string {
  const grantLabel = (g: IntelGrant): string =>
    g.kind === 'treasury'
      ? t('казна {who}', { who: NAME[g.target] ?? g.target })
      : g.kind === 'fleets'
        ? t('флоты {who}', { who: NAME[g.target] ?? g.target })
        : t('мир {at}', { at: g.target });
  const rows = myIntel()
    .sort((a, b) => a.until - b.until)
    .map((g) => {
      const left = Math.max(0, Math.ceil((g.until - s.time) / HOUR));
      const jump = g.kind === 'planet' ? ` data-iw="${esc(g.target)}"` : '';
      return (
        `<div class="in-row"${jump}><span class="in-k">🗝</span><b>${esc(grantLabel(g))}</b>` +
        `<span class="in-t">⏳ ${t('{n}ч', { n: left })}</span>${g.kind === 'planet' ? '<span class="in-go">↪</span>' : ''}</div>`
      );
    })
    .join('');
  const ops = Object.keys(s.players)
    .filter((id) => id !== ME)
    .map(
      (id) =>
        `<div class="in-row"><b>${esc(NAME[id] ?? id)}</b>` +
        `<button class="dp-spy" data-spy="treasury" data-seat="${id}">🕵 ${t('казна')}</button>` +
        `<button class="dp-spy" data-spy="fleets" data-seat="${id}">🕵 ${t('флоты')}</button></div>`,
    )
    .join('');
  const log = [...spyLog]
    .reverse()
    .map((e) => {
      const d = floor(e.at / DAY) + 1;
      const h = floor((e.at % DAY) / HOUR);
      return `<div class="in-log">D${d} ${String(h).padStart(2, '0')}ч · ${esc(e.text)}</div>`;
    })
    .join('');
  return (
    `<div class="dp-list in-list">` +
    `<div class="in-hint">${t('Попытка: {c}¤ · шанс ~60% · окно интела 24ч · провал сжигает плату. Разведка мира — кнопка 🕵 на карточке вражеской планеты.', { c: SPY_COST })}</div>` +
    `<div class="in-sec">${t('АКТИВНЫЕ ОКНА ИНТЕЛА')}</div>` +
    (rows ||
      `<div class="in-empty">${t('нет активных окон — добудьте интел операцией ниже')}</div>`) +
    `<div class="in-sec">${t('ОПЕРАЦИИ')}</div>` +
    (ops || `<div class="in-empty">${t('противников нет')}</div>`) +
    `<div class="in-sec">${t('ЖУРНАЛ')}</div>` +
    (log || `<div class="in-empty">${t('попыток ещё не было')}</div>`) +
    `</div>`
  );
}
function renderDiplo(): void {
  const el = document.getElementById('diplo');
  if (!el) return;
  const tabBtn = (k: 'diplo' | 'msgs' | 'intel', label: string) =>
    `<button class="dp-tab${diploTab === k ? ' on' : ''}" data-tab="${k}">${label}</button>`;
  const sortBtn = (k: typeof diploSort, label: string) =>
    `<button class="dp-sortb${diploSort === k ? ' on' : ''}" data-sort="${k}">${label}</button>`;
  const stChip = (k: DiplomaticStance) =>
    `<button class="dp-fchip${diploStanceFilter.has(k) ? ' on' : ''}" data-fstance="${k}" style="--sc:${STANCE_COLOR[k]}">${stanceRu(k)}</button>`;
  const tyChip = (k: 'human' | 'ai', label: string) =>
    `<button class="dp-fchip ty${diploTypeFilter.has(k) ? ' on' : ''}" data-ftype="${k}">${label}</button>`;
  const anyFilter = diploStanceFilter.size || diploTypeFilter.size;
  const filterRow =
    `<div class="dp-filters"><span>${t('Фильтр')}:</span>` +
    STANCES.map(stChip).join('') +
    `<span class="dp-fsep"></span>${tyChip('human', '☻ ' + t('Человек'))}${tyChip('ai', '⌬ ' + t('ИИ'))}` +
    (anyFilter ? `<button class="dp-fclear" data-fclear="1">${t('Сброс')}</button>` : '') +
    `</div>`;
  const body =
    diploTab === 'diplo'
      ? `<div class="dp-sorts"><span>${t('Сорт.')}:</span>${sortBtn('name', t('Имя'))}${sortBtn('worlds', t('Провинции'))}${sortBtn('stance', t('Отношение'))}</div>` +
        filterRow +
        `<div class="dp-list">${diploRowsHtml()}</div>`
      : diploTab === 'intel'
        ? intelTabHtml()
        : `<div class="dp-convo">${convoListHtml()}${convoThreadHtml()}</div>`;
  el.innerHTML =
    `<div class="dpbox">` +
    `<div class="dp-head"><b>${t('ДИПЛОМАТИЯ')}</b>${tabBtn('diplo', t('Дипломатия'))}${tabBtn('msgs', t('Сообщения'))}${tabBtn('intel', t('Шпионаж'))}<button class="dp-close">✕</button></div>` +
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
 *  panel — not in a global HUD strip. Identification is the game tooltip only: the
 *  PC cursor dossier (#objtip, via data-desc) and the mobile long-press bubble
 *  (data-name). No native `title` — it duplicated #objtip as a second, uglier popup. */
/** A building is one-per-planet (the reducer grows it via upgrade, never a 2nd copy).
 *  Returns why a fresh build order would be refused — so the build tile can grey out
 *  the moment it's committed (built / building / queued / paused), instead of taking
 *  the order and only rejecting it when the queue reaches it. `null` = orderable. */
function buildingLocked(planetId: string, id: string): 'built' | 'queued' | null {
  const p = s.planets[planetId];
  if (!p) return null;
  if (p.buildings.some((b) => b.type === id)) return 'built';
  if (queueOf(planetId).buildings.some((q) => q.kind === 'building' && q.id === id)) return 'queued';
  const act = activeConstruction(planetId, 'buildings');
  if (act && act.payload.kind === 'building' && act.payload.building === id) return 'queued';
  if (p.pausedConstruction?.some((s) => s.kind === 'building' && s.building === id)) return 'queued';
  return null;
}
function codexTile(kind: 'b' | 'u', id: string, label: string, orderable = false, lockedFor?: string): string {
  if (!(kind === 'b' ? data.buildings[id] : data.units[id])) return '';
  const icon = kind === 'b' ? (BUILD_ICON[id] ?? '▣') : unitIcon(id);
  const name = kind === 'b' ? buildingName(id) : (unitDossier(id)?.name ?? displayUnit(id));
  if (lockedFor) {
    // Committed already — a dim, non-ordering tile. Keeps data-desc (hover dossier),
    // drops data-codex/data-buildorder so neither left- nor right-click builds again.
    const mark = lockedFor === 'built' ? '✓' : '⏳';
    return `<button class="ptile locked" data-desc="${kind}:${id}" data-name="${esc(name)}"><span class="pt-ic">${icon}</span><span class="pt-c">${mark} ${esc(label)}</span></button>`;
  }
  // Build-menu tiles carry the enqueue order (PC right-click = build w/o the codex
  // confirmation); composition/garrison tiles don't — right-click is inert there.
  const order = orderable ? ` data-buildorder="${kind === 'u' ? 'unit' : 'building'}:${id}"` : '';
  return `<button class="ptile" data-codex="${kind}:${id}" data-desc="${kind}:${id}"${order} data-name="${esc(name)}"><span class="pt-ic">${icon}</span><span class="pt-c">${esc(label)}</span></button>`;
}
/** Ground-garrison tiles (the ЗЕМЛЯ tab): one flowing row of icon·count chips — no
 *  names; the hover dossier (PC) / tap dossier (touch) carries the identification. */
function garrisonTilesHtml(stacks: Array<{ unit: string; count: number }>): string {
  const tiles = stacks
    .filter((u) => u.count > 0)
    .map((u) => {
      const name = unitDossier(u.unit)?.name ?? displayUnit(u.unit);
      return `<button class="ptile mini" data-codex="u:${esc(u.unit)}" data-desc="u:${esc(u.unit)}" data-name="${esc(name)}"><span class="pt-ic">${unitIcon(u.unit)}</span><span class="pt-c">${u.count}</span></button>`;
    })
    .join('');
  return tiles ? `<div class="ptiles">${tiles}</div>` : `<div class="row dim">${t('нет')}</div>`;
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
  el.innerHTML = `<div class="cxbox">${codexHtml(kind, id)}${codexBuildBtn(kind, id)}<button class="cx-close">${t('ЗАКРЫТЬ')}</button></div>`;
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
    return `<button class="cx-build" data-build="building:${id}">▣ ${t('Построить здесь')} · ${cost(data.buildings[id]?.cost)}</button>`;
  }
  if (kind === 'u' && data.units[id]) {
    return `<button class="cx-build" data-build="unit:${id}">${unitIcon(id)} ${t('Построить здесь')} · ${cost(data.units[id]?.cost)}</button>`;
  }
  return '';
}

// --- ONB-4 codex/help hub: searchable index over the article corpus ----------
// The pure index (src/codexIndex.ts) flattens every unit/building + a glossary of
// tricky terms; here we localise labels and render a searchable «?» surface. A tap
// on a result deep-links into the single-article codex (openCodex), so any
// term/unit/mechanic is two taps away. Entry points: hub «Ещё → Справочник» + the
// in-match rail «?».
const CODEX_INDEX = buildCodexIndex(data, GLOSSARY);
const CODEX_SECTIONS: Array<[CodexCategory, string]> = [
  ['unit', 'Юниты'],
  ['building', 'Здания'],
  ['mechanic', 'Механики'],
];
function codexEntryLabel(e: CodexEntry): string {
  const id = e.key.slice(2);
  if (e.category === 'unit') return unitDossier(id)?.name ?? displayUnit(id);
  if (e.category === 'building') return buildingName(id);
  return t(e.title); // mechanic: title is the canonical-Russian msgid
}
function codexEntryIcon(e: CodexEntry): string {
  const id = e.key.slice(2);
  if (e.category === 'unit') return unitIcon(id);
  if (e.category === 'building') return BUILD_ICON[id] ?? '▣';
  return '?';
}
function codexItemHtml(e: CodexEntry): string {
  return `<button class="ch-item" data-codex="${esc(e.key)}"><span class="ch-ic">${codexEntryIcon(e)}</span><span>${esc(codexEntryLabel(e))}</span></button>`;
}
// Search folds the LOCALISED label into the haystack so RU and EN queries both hit.
function renderCodexResults(query: string): void {
  const host = document.getElementById('ch-results');
  if (!host) return;
  const hits = searchCodex(CODEX_INDEX, query, (e) =>
    (codexEntryLabel(e) + ' ' + e.title + ' ' + e.tags.join(' ')).toLowerCase(),
  );
  if (!query.trim()) {
    // Empty query → browse by category.
    host.innerHTML = CODEX_SECTIONS.map(([cat, label]) => {
      const items = hits.filter((e) => e.category === cat);
      return items.length
        ? `<div class="ch-sec">${t(label)}</div><div class="ch-grid">${items.map(codexItemHtml).join('')}</div>`
        : '';
    }).join('');
    return;
  }
  host.innerHTML = hits.length
    ? `<div class="ch-grid">${hits.map(codexItemHtml).join('')}</div>`
    : `<div class="ch-empty">${t('Ничего не найдено')}</div>`;
}
function openCodexHub(): void {
  const box = document.getElementById('codexhub');
  if (!box) return;
  box.innerHTML =
    `<div class="chbox"><div class="ch-head"><span class="cx-ic">?</span><b>${t('СПРАВОЧНИК')}</b></div>` +
    `<input id="ch-search" class="ch-search" type="text" placeholder="${t('Поиск: юнит, здание, термин…')}" aria-label="${t('Поиск по справочнику')}">` +
    `<div class="ch-body" id="ch-results"></div>` +
    `<button class="cx-close" id="ch-close">${t('ЗАКРЫТЬ')}</button></div>`;
  const input = document.getElementById('ch-search') as HTMLInputElement | null;
  if (input) input.oninput = () => renderCodexResults(input.value);
  renderCodexResults('');
  box.classList.add('show');
  input?.focus();
}
// One delegated handler for the hub (rebuilt each open, so wire the container once).
document.getElementById('codexhub')?.addEventListener('click', (ev) => {
  const box = document.getElementById('codexhub')!;
  const tg = ev.target as HTMLElement;
  if (tg === box || tg.closest('#ch-close')) {
    box.classList.remove('show'); // backdrop / CLOSE
    return;
  }
  const item = tg.closest('.ch-item') as HTMLElement | null;
  if (item?.dataset.codex) openCodex(item.dataset.codex); // deep-link → single article (layers on top)
});
document.getElementById('hub-help')?.addEventListener('click', openCodexHub);
document.getElementById('rail-help')?.addEventListener('click', openCodexHub);

// --- ONB-3 just-in-time mechanic intros --------------------------------------
// The first time a player opens an advanced panel, a one-screen card explains it,
// then never again (per-callsign seen-set). A veteran (has finished a match →
// meta XP > 0) is marked seen silently, so they are never nagged.
function seenIntrosKey(): string {
  return 'vd.seenIntros.' + (nickInput.value.trim() || 'guest');
}
function showIntro(card: IntroCard): void {
  const el = document.getElementById('intro');
  if (!el) return;
  el.innerHTML =
    `<div class="inbox"><div class="in-head"><span class="in-ic">✦</span><b>${esc(t(card.title))}</b>` +
    `<span class="in-tag">${t('впервые')}</span></div>` +
    `<div class="in-body">${esc(t(card.body))}</div>` +
    `<button class="in-ok">${t('Понятно')}</button></div>`;
  el.classList.add('show');
}
// Panel-open hook: show the intro for `id` once (unless already seen / a veteran).
function maybeIntro(id: string): void {
  const seen = parseSeenIntros(localStorage.getItem(seenIntrosKey()));
  const veteran = loadMeta().xp > 0; // finished at least one match → knows the ropes
  const { card, seen: next } = resolveIntro(seen, id, { veteran });
  localStorage.setItem(seenIntrosKey(), JSON.stringify(next));
  if (card) showIntro(card);
}
document.getElementById('intro')?.addEventListener('click', (ev) => {
  const el = document.getElementById('intro')!;
  const tg = ev.target as HTMLElement;
  if (tg === el || tg.closest('.in-ok')) el.classList.remove('show'); // backdrop / «Понятно»
});

// --- ONB-5 return digest ("пока тебя не было") -------------------------------
// The world runs while you're away (a backgrounded tab catches up on return, and
// on the server it runs 24/7). Rather than a silently-changed map, brief the player
// on what happened since they left — attention items first, tap to jump to the spot.
let awayFromGameTime: number | null = null;
function recapItemHtml(i: { text: string; anchor?: string; high: boolean }): string {
  const jump = i.anchor ? ` data-jump="${esc(i.anchor)}"` : '';
  return `<button class="rc-item${i.high ? ' hi' : ''}"${jump}><span class="rc-dot"></span><span>${esc(i.text)}</span></button>`;
}
/** Render the digest of events at/after `since`. No-op when nothing happened. */
function openRecap(since: number): void {
  const el = document.getElementById('recap');
  if (!el) return;
  const r = buildRecap(eventLog, since);
  if (!r.count) return; // nothing accrued — don't nag with an empty briefing
  const hi = r.items.filter((i) => i.high);
  const lo = r.items.filter((i) => !i.high);
  let body = '';
  if (hi.length)
    body +=
      `<div class="rc-sec hi">${t('Требуют внимания · {n}', { n: r.attention })}</div>` +
      hi.map(recapItemHtml).join('');
  if (lo.length)
    body += `<div class="rc-sec">${t('Пока тебя не было')}</div>` + lo.map(recapItemHtml).join('');
  el.innerHTML =
    `<div class="rcbox"><div class="rc-head"><span class="cx-ic">🛰</span><b>${t('СВОДКА ВОЗВРАЩЕНИЯ')}</b></div>` +
    `<div class="rc-body">${body}</div><button class="cx-close" id="rc-close">${t('ЗАКРЫТЬ')}</button></div>`;
  el.classList.add('show');
}
document.getElementById('recap')?.addEventListener('click', (ev) => {
  const el = document.getElementById('recap')!;
  const tg = ev.target as HTMLElement;
  if (tg === el || tg.closest('#rc-close')) {
    el.classList.remove('show');
    return;
  }
  const jump = tg.closest('.rc-item') as HTMLElement | null;
  if (jump?.dataset.jump) {
    el.classList.remove('show');
    jumpToPing(jump.dataset.jump); // fly the camera to the event's world
  }
});
// The «🛰» button in the log window → the whole-session briefing on demand.
document.getElementById('lw-recap')?.addEventListener('click', () => openRecap(0));
// Auto-briefing: mark where we left when the tab hides; on return (after the sim has
// caught up the elapsed time) summarise what happened — only for a real absence.
let awayAtRealMs = 0;
document.addEventListener?.('visibilitychange', () => {
  if (document.hidden) {
    if (inMatch()) {
      awayFromGameTime = s.time;
      awayAtRealMs = Date.now();
    }
    return;
  }
  if (awayFromGameTime == null || !inMatch()) return;
  const since = awayFromGameTime;
  awayFromGameTime = null;
  if (Date.now() - awayAtRealMs < 15000) return; // a quick glance away — no briefing
  // Give the frame loop a beat to catch the world up before we summarise it.
  window.setTimeout(() => {
    if (inMatch()) openRecap(since);
  }, 500);
});

/** A `b:<id>:<lvl>` key embeds its building level in the title (as `hl(lvl)`) — shared
 *  by the desktop hover pane and the mobile tap modal so both read identically. */
function dossierTitleHtml(key: string, d: Dossier): string {
  const lvl = key.startsWith('b:') ? Number(key.split(':')[2]) || 0 : 0;
  return lvl ? `${esc(d.name)} ${hl(lvl)}` : esc(d.name);
}

/** Right-docked description pane HTML for the currently hovered menu object. */
function objDescHtml(): string {
  const d = hoverObj ? objDossier(hoverObj) : null;
  if (!d) {
    return `<div class="pd-empty">${t('Наведи на объект слева — здесь появится его досье.')}</div>`;
  }
  return `<div class="pd-title">${dossierTitleHtml(hoverObj!, d)}</div><div class="pd-body">${d.body}</div>`;
}

/** Touch has no hover — a tap on a `[data-desc]` object opens the SAME dossier in the
 *  codex overlay instead (reuses its box/close chrome; no "Build here" button here). */
function openDossier(key: string): void {
  const d = objDossier(key);
  const el = document.getElementById('codex');
  if (!el || !d) return;
  el.innerHTML = `<div class="cxbox"><div class="cx-head"><b>${dossierTitleHtml(key, d)}</b></div><div class="cx-desc">${d.body}</div><button class="cx-close">${t('ЗАКРЫТЬ')}</button></div>`;
  el.classList.add('show');
}

function renderObjDesc(): void {
  const pane = document.getElementById('pdesc');
  if (!pane) return;
  const html = objDescHtml();
  if (html === lastObjDescHtml) return;
  lastObjDescHtml = html;
  pane.innerHTML = html;
}

let sheetWasOpen = false;
function renderPanel() {
  // While arming a merge target, collapse the panel so the map (and the fleet to
  // merge with) is fully tappable — important on phones where the sheet covers it.
  // «Выбрать+» collapses the sheet the same way merging does — picking needs the map.
  const open =
    !merging && !pickMode && (selFleet !== null || selPlanet !== null || selFleets.size > 0);
  side.style.display = open ? 'flex' : 'none';
  document.body.classList.toggle('sheet-open', open); // mobile: hide log/comms under the sheet
  // Phone: the bottom sheet covers ~50vh — when it OPENS, pan the camera so the
  // selected object is not the one thing the panel talks about yet hides.
  if (open && !sheetWasOpen && MOBILE) {
    const anchor = selFleet
      ? (s.fleets[selFleet] && fleetAnchor(s.fleets[selFleet]!)) || null
      : selPlanet && s.planets[selPlanet]
        ? world(s.planets[selPlanet]!.position)
        : null;
    if (anchor && anchor.y > VH * 0.42) {
      cam.y -= anchor.y - VH * 0.3; // lift it into the visible upper half
      clampCam();
    }
  }
  sheetWasOpen = open;
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
    const totalH =
      Math.max(0, (Number(el.dataset.arrive) - s.time) / HOUR) + Number(el.dataset.rest);
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
  if (ids.length === 0 && !pickMode) {
    // (pickMode keeps the bar alive at zero selection — the ⊕ toggle must stay
    // reachable, or an emptied group would strand the player in the mode.)
    if (aiming) aiming = false;
    if (assaultAim) assaultAim = false;
    if (targetAim) targetAim = false;
    if (merging) merging = false;
    fireMenu = false; // пустое выделение — 🔥-меню не должно всплыть при новом выборе
    cmdbar.classList.remove('show');
    lastCmdHtml = '';
    return;
  }
  const fleets = ids.map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  const anyMoving = fleets.some((f) => f.movement);
  // Режим огня артиллерии (одна кнопка + меню): на кнопке — общий режим арт-флотов
  // выделения, при разнобое — нейтральная подпись.
  const artFleets = fleets.filter((f) => f.owner === ME && fleetHasArtillery(f));
  const FIRE_MODES: Array<{ m: string; lbl: string; sub: string }> = [
    { m: 'passive', lbl: t('Пассив'), sub: t('не стреляет') },
    { m: 'return', lbl: t('Ответ'), sub: t('только после урона по флоту') },
    { m: 'standard', lbl: t('Станд'), sub: t('по тем, с кем война') },
    { m: 'aggressive', lbl: t('Агрес'), sub: t('по любому, кроме пакта/союза') },
  ];
  const artModes = new Set(artFleets.map((f) => f.barrageMode ?? 'standard'));
  const uniMode = artModes.size === 1 ? [...artModes][0] : null;
  const fmLabel = uniMode
    ? (FIRE_MODES.find((x) => x.m === uniMode)?.lbl ?? t('Режим огня'))
    : t('Режим огня');
  if (artFleets.length === 0) fireMenu = false; // выделение без артиллерии — меню гаснет
  const docked = fleets.filter((f) => f.location && !f.movement && !f.battleId);
  // PC: ШТУРМ is a targeting command (fly there + storm on arrival) — armable
  // whenever the selection has ships. Mobile keeps the in-orbit-only button.
  const canAssault = pcUi()
    ? fleets.some((f) => sumUnits(f.units) > 0)
    : docked.some(
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
  const canSplit =
    !!lone && !!lone.location && !lone.movement && !lone.battleId && sumUnits(lone.units) >= 2;
  // Artillery in the selection → offer the standoff-fire focus order.
  const anyArtillery = fleets.some(fleetHasArtillery);
  const html =
    `<span class="cmdlabel">${ids.length > 1 ? t('{n} ФЛОТОВ', { n: ids.length }) : t('ФЛОТ')}</span>` +
    cmdBtn('move', '⤳', t('Курс'), aiming ? 'on' : '', false) +
    cmdBtn('stop', '■', t('Стоп'), 'danger', !anyMoving) +
    cmdBtn('attack', '⚔', t('Штурм'), assaultAim ? 'on' : '', !canAssault) +
    cmdBtn('target', '◎', t('Цель'), targetAim ? 'on' : '', false) +
    (anyArtillery ? cmdBtn('barrage', '🎯', t('Обстрел'), barrageAim ? 'on' : '', false) : '') +
    (artFleets.length > 0 ? cmdBtn('firemode', '🔥', fmLabel, fireMenu ? 'on' : '', false) : '') +
    cmdBtn(
      'merge',
      '⛬',
      ids.length > 1 ? t('Слить') : t('Слить…'),
      merging ? 'on' : '',
      !canMerge,
    ) +
    cmdBtn('split', '⊟', t('Разделить'), splitState ? 'on' : '', !canSplit) +
    // ☰ — the extras row (hamburger, NOT «...» — референс не копируем дословно):
    // «Выбрать+» и будущие Ускорить/Задержка живут здесь, базовый ряд не пухнет.
    cmdBtn('more', '☰', t('Ещё'), cmdMore ? 'on' : '', false) +
    (cmdMore || pickMode ? cmdBtn('pick', '⊕', t('Выбрать+'), pickMode ? 'on' : '', false) : '') +
    (cmdMore
      ? cmdBtn(
          'boost',
          '⚡',
          t('Ускорить'),
          ids.length > 0 && ids.every((id) => marchFlagged(id)) ? 'on' : '',
          ids.length === 0,
        ) +
        // SO-UI: standing orders live here now — the bottom sheet keeps only info.
        cmdBtn(
          'qauto',
          '⚔',
          t('Авто-штурм'),
          ids.length > 0 && ids.every((id) => isAutoAssault(id)) ? 'on' : '',
          ids.length === 0,
        ) +
        (fleets.some(fleetHasSquadron)
          ? cmdBtn(
              'qscramble',
              '🛩',
              t('Деж. вылет'),
              fleets.filter(fleetHasSquadron).every((fl) => patrolOf(fl.id)) ? 'on' : '',
              false,
            )
          : '')
      : '') +
    // 🔥 поповер над баром: четыре режима с подписью-правилом; ● — текущий.
    (fireMenu && artFleets.length > 0
      ? `<div class="cmdpop">` +
        FIRE_MODES.map(
          (x) =>
            `<button data-cmd="fmset" data-mode="${x.m}"${uniMode === x.m ? ' class="on"' : ''}><b>${uniMode === x.m ? '● ' : ''}${x.lbl}</b><span>${x.sub}</span></button>`,
        ).join('') +
        `</div>`
      : '');
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
        <button data-sx="all" data-unit="${esc(unit)}" ${tk >= have ? 'disabled' : ''}>${t('Все')}</button>
      </span>
      <b class="snew">→ ${tk}</b>
    </div>`;
  }
  const valid = takeTotal > 0 && takeTotal < total;
  const html = `<div class="sbox">
    <div class="shead">${t('РАЗДЕЛЕНИЕ ФЛОТА')} <b>${esc(splitState.fleetId)}</b></div>
    <div class="ssub">${t('Отделите корабли в новый флот — он останется в том же секторе. Хотя бы один корабль остаётся; десант в трюме остаётся с исходным флотом.')}</div>
    <div class="srows">${rows}</div>
    <div class="sfoot">${t('новый флот: {a} кораблей · у исходного останется {b}', { a: `<b>${takeTotal}</b>`, b: `<b>${total - takeTotal}</b>` })}</div>
    <div class="sactions">
      <button data-sx="confirm" class="cbtn" ${valid ? '' : 'disabled'}>${t('Подтвердить')}</button>
      <button data-sx="cancel" class="cbtn ghost">${t('Отмена')}</button>
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
  const bEl = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!bEl || bEl.disabled || !splitState) return;
  const sx = bEl.dataset.sx;
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
  const unit = bEl.dataset.unit ?? '';
  const f = s.fleets[splitState.fleetId];
  if (!f) return;
  const have = fleetShipCounts(f)[unit] ?? 0;
  const cur = splitState.take[unit] ?? 0;
  if (sx === 'inc') splitState.take[unit] = Math.min(have, cur + Number(bEl.dataset.n));
  else if (sx === 'dec') splitState.take[unit] = Math.max(0, cur - Number(bEl.dataset.n));
  else if (sx === 'all') splitState.take[unit] = have;
  renderSplitDialog();
});

side.addEventListener('click', (ev) => {
  // A queued order's target is a link: pan the map to that world (briefly ringed)
  // WITHOUT touching the selection — the plan panel must stay open under your finger.
  const go = (ev.target as HTMLElement).closest('[data-goto]') as HTMLElement | null;
  if (go?.dataset.goto) {
    focusWorld(go.dataset.goto);
    return;
  }
  const bEl = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!bEl || bEl.disabled) {
    // Touch has no hover: a tap that lands on a dossier-able row (not one of its own
    // action buttons, handled below) opens the same summary the desktop pane shows
    // on hover — building/task name, current vs full output, ETA.
    if (MOBILE) {
      const key = (ev.target as HTMLElement).closest('[data-desc]')?.dataset.desc ?? null;
      // stat:/tab:/division dossiers exist for the PC hover tooltip only — the
      // mobile tap behaviour stays exactly as it was before they were added.
      if (
        key !== null &&
        !key.startsWith('stat:') &&
        !key.startsWith('tab:') &&
        key !== 'division'
      ) {
        openDossier(key);
      }
    }
    return;
  }
  if (bEl.dataset.codex) {
    openCodex(bEl.dataset.codex); // a build/ship tile → full specs (+ Build here)
    return;
  }
  const act = bEl.dataset.act;
  const arg = bEl.dataset.arg ?? '';
  if (act === 'close') {
    clearSelection();
  } else if (act === 'cancel') {
    selFleet = null;
    selFleets = new Set();
  } else if (act === 'selfleet') {
    setFleetSelection([arg]);
  } else if (act === 'tab') {
    if (arg === 'ground' || arg === 'ships' || arg === 'squadron' || arg === 'buildings') {
      planetTab = arg;
    }
  } else if (act === 'build') {
    enqueueBuild(selPlanet!, { kind: 'building', id: arg, count: 1 });
  } else if (act === 'upgrade') {
    enqueueBuild(selPlanet!, { kind: 'upgrade', id: arg, count: 1 });
  } else if (act === 'unit') {
    enqueueBuild(selPlanet!, { kind: 'unit', id: arg, count: 1 });
  } else if (act === 'cancelbuild') {
    // The active order only — refunds the unbuilt share and pauses it (resumable).
    playerOrder(cancelConstruction(ME, selPlanet!, Number(arg)));
  } else if (act === 'resumebuild') {
    playerOrder(resumeConstruction(ME, selPlanet!, Number(arg)));
  } else if (act === 'dequeue') {
    // Nothing was ever paid for a not-yet-dispatched queued order (single-player
    // local buffer only — net mode sends immediately, so there's nothing to dequeue
    // there) — a plain local removal, no action needed.
    const [qLane, qIdx] = arg.split(':');
    queueOf(selPlanet!)[qLane as BuildLane].splice(Number(qIdx), 1);
  } else if (act === 'mobtpl') {
    mobTplIdx = Number(arg); // switch which template the assembler shows (local, re-renders)
  } else if (act === 'mobilize') {
    // 'oN' = named officer premade (locked composition, officer attached server-side).
    if (arg.startsWith('o'))
      playerOrder(mobilizeDivision(ME, selPlanet!, Number(arg.slice(1)), true));
    else playerOrder(mobilizeDivision(ME, selPlanet!, Number(arg)));
  } else if (act === 'divdesign') {
    ddIdx = Math.min(mobTplIdx, templatesOf(s, ME).length - 1);
    divDesignWin.classList.add('show');
    renderDivDesign();
  } else if (act === 'spyplanet') {
    playerOrder(spyOn(ME, arg, 'planet', selPlanet!)); // arg = the world's (last known) owner
  } else if (act === 'capital') {
    playerOrder(designateCapital(ME, selPlanet!));
  } else if (act === 'holdpoint') {
    playerOrder(setHoldPoint(ME, selPlanet!, arg === 'on'));
  } else if (act === 'ping') {
    openPingMenu();
  } else if (act === 'bombard') {
    playerOrder(bombardFleet(ME, selFleet!, arg === 'on'));
  } else if (act === 'assault') {
    playerOrder(assaultFleet(ME, selFleet!));
  } else if (act === 'retreat') {
    playerOrder(retreatFleet(ME, selFleet!));
  } else if (act === 'instantrepair') {
    // Платный мгновенный ремонт: цена и отказы — на сервере; панель перерисуется
    // по факту (полный бар = получилось), нотификаций-обещаний не даём.
    playerOrder(instantRepairFleet(ME, arg || selFleet!));
  } else if (act === 'dockrepair') {
    // ECON-3а: экспресс-ремонт за metal — кнопка видна только у своего дока.
    playerOrder(repairFleet(ME, arg || selFleet!));
  } else if (act === 'fleetinfo') {
    // Тап по имени армии: карточка ⇄ сводка (для текущего выбранного флота).
    if (selFleet) fleetInfoFor = fleetInfoFor === selFleet ? null : selFleet;
  } else if (act === 'planetinfo') {
    // Тап по имени мира: карточка ⇄ сводка статистики (для выбранной планеты).
    if (selPlanet) planetInfoFor = planetInfoFor === selPlanet ? null : selPlanet;
  } else if (act === 'launchsquad') {
    // Split the squadron stack off into its own fast strike fleet (SQ-1.1).
    const f = selFleet ? s.fleets[selFleet] : undefined;
    if (fleetCanLaunchSquadron(f)) {
      playerOrder(splitFleet(ME, f!.id, squadronTake(f!)));
      note(t('🛩 эскадрилья запущена — ведите её на цель'));
    }
  } else if (act === 'load') {
    beginLoad(selFleet!, arg); // ~1h timed load (animated in the marker)
  } else if (act === 'unload') {
    playerOrder(unloadArmy(ME, selFleet!, arg, 1));
  } else if (act === 'divload') {
    playerOrder(loadDivision(ME, arg, selFleet!));
  } else if (act === 'divunload') {
    playerOrder(unloadDivision(ME, arg));
  }
  lastPanelHtml = '';
  renderPanel();
});

// Side-panel object hover → dossier. On PC the docked pane is hidden (it ate a slab
// of the panel) — the dossier follows the cursor as a translucent tooltip (#objtip)
// that sizes to its text. Below the PC breakpoint the old right-docked pane behaviour
// stays. Touch has no hover — phones keep the tap-to-open modal.
const objTipEl = document.getElementById('objtip');
function placeObjTip(ev: PointerEvent): void {
  if (!objTipEl) return;
  const pad = 14;
  const w = objTipEl.offsetWidth;
  const hgt = objTipEl.offsetHeight;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad; // flip left of the cursor
  if (y + hgt > window.innerHeight - 8) y = ev.clientY - hgt - pad; // flip above
  objTipEl.style.left = `${Math.max(8, x)}px`;
  objTipEl.style.top = `${Math.max(8, y)}px`;
}
side.addEventListener('pointermove', (ev) => {
  if (MOBILE) return;
  const t = ev.target as HTMLElement;
  if (t.closest('#pdesc')) return; // over the docked pane itself — keep what's shown
  const key = (t.closest('[data-desc]') as HTMLElement | null)?.dataset.desc ?? null;
  if (PC_FINE?.matches && objTipEl) {
    // Cursor tooltip: shown only while an object is actually under the pointer.
    if (key !== hoverObj) {
      hoverObj = key;
      const d = key ? objDossier(key) : null;
      if (d) {
        // A body-less dossier (bare names — resources, plain units) shows just the title.
        objTipEl.innerHTML =
          `<div class="pd-title">${dossierTitleHtml(key!, d)}</div>` +
          (d.body ? `<div class="pd-body">${d.body}</div>` : '');
        objTipEl.style.display = 'block';
      } else {
        objTipEl.style.display = 'none';
      }
    }
    if (objTipEl.style.display === 'block') placeObjTip(ev);
    return;
  }
  // Docked-pane path (narrow desktop windows): only swap when landing on a DIFFERENT
  // object; passing over a gap (key === null) keeps the last dossier shown, so the pane
  // never flashes empty while the cursor travels between rows. pointerleave clears it.
  if (key !== null && key !== hoverObj) {
    hoverObj = key;
    renderObjDesc();
  }
});
side.addEventListener('pointerleave', () => {
  if (objTipEl) objTipEl.style.display = 'none';
  if (hoverObj !== null) {
    hoverObj = null;
    renderObjDesc();
  }
});

// PC: the browser context menu is suppressed across the whole game surface (the
// map, the HUD, every overlay) — right-click is a game input now. Text fields keep
// their native menu (paste!).
document.addEventListener('contextmenu', (ev) => {
  if (!pcUi()) return;
  if ((ev.target as HTMLElement).closest('input,textarea')) return;
  ev.preventDefault();
});

// PC: right-click on a build tile orders it immediately — same enqueue path as the
// codex «Построить здесь» button, minus the confirmation window (left-click keeps
// opening the full dossier). The browser context menu is suppressed on these tiles.
side.addEventListener('contextmenu', (ev) => {
  if (!pcUi()) return;
  const tile = (ev.target as HTMLElement).closest('[data-buildorder]') as HTMLElement | null;
  if (!tile) return;
  ev.preventDefault();
  const [kind, id] = (tile.dataset.buildorder ?? '').split(':');
  if (!kind || !id || !selPlanet) return;
  const p = s.planets[selPlanet];
  if (!p || p.owner !== ME) return;
  if (kind === 'building') {
    // mirror codexBuildBtn's gates: the sector must allow it, one copy per world —
    // AND already-committed (built/building/queued/paused), to stop a fast double
    // right-click from queueing a second copy before the tile re-renders locked.
    const buildable = (SECTOR_TYPES[SECTOR_OF[p.id]]?.allowedBuildings ?? BUILDABLE).includes(id);
    if (!buildable || buildingLocked(p.id, id)) return;
  }
  enqueueBuild(selPlanet, { kind: kind as BuildKind, id, count: 1 });
  lastPanelHtml = '';
  renderPanel();
});

// Mobile long-press on a codex tile (.ptile): touch has no hover, so the desktop
// `title` tooltip is unreachable — press-and-HOLD shows a small bubble with the
// tile's localized name (from `data-name`) instead. While held it stays; releasing
// hides it AND swallows the click, so a long-press never falls through into the
// tap action (opening the full codex). A plain tap keeps opening the codex as
// before. Listeners are optional-called: the headless harness DOM has no
// document.addEventListener.
let holdTipEl: HTMLElement | null = null;
let holdTimer: number | null = null;
let holdTipShown = false; // the press matured into a bubble → eat the click tail
let holdStart: { x: number; y: number } | null = null;
const HOLD_TIP_MS = 400;
const HOLD_SLOP_PX = 12; // a moving finger is a scroll/drag, not a hold
function showHoldTip(btn: HTMLElement): void {
  const name = btn.dataset.name;
  if (!name) return;
  if (!holdTipEl) {
    holdTipEl = document.createElement('div');
    holdTipEl.id = 'holdtip';
    document.body.appendChild(holdTipEl);
  }
  holdTipEl.textContent = name;
  holdTipEl.style.display = 'block';
  // above the tile, clamped to the viewport
  const r = btn.getBoundingClientRect();
  const w = holdTipEl.offsetWidth;
  const h = holdTipEl.offsetHeight;
  holdTipEl.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2))}px`;
  holdTipEl.style.top = `${Math.max(6, r.top - h - 8)}px`;
}
function cancelHoldTip(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  holdStart = null;
  if (holdTipEl) holdTipEl.style.display = 'none';
}
document.addEventListener?.('pointerdown', (ev) => {
  if (!MOBILE) return;
  const btn = (ev.target as HTMLElement).closest?.('.ptile') as HTMLElement | null;
  if (!btn) return;
  holdTipShown = false;
  holdStart = { x: ev.clientX, y: ev.clientY };
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    holdTimer = null;
    holdTipShown = true;
    showHoldTip(btn);
  }, HOLD_TIP_MS);
});
document.addEventListener?.('pointermove', (ev) => {
  if (holdTimer === null || !holdStart) return;
  if (Math.hypot(ev.clientX - holdStart.x, ev.clientY - holdStart.y) > HOLD_SLOP_PX) {
    cancelHoldTip(); // the finger is scrolling the panel, not holding the tile
  }
});
document.addEventListener?.('pointerup', () => cancelHoldTip());
document.addEventListener?.('pointercancel', () => cancelHoldTip());
document.addEventListener?.(
  'click',
  (ev) => {
    if (!holdTipShown) return;
    holdTipShown = false;
    // the click is the tail of a matured long-press — it must not open the codex
    if ((ev.target as HTMLElement).closest?.('.ptile')) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  },
  true, // capture — ahead of the side panel's click handler
);

cmdbar.addEventListener('click', (ev) => {
  const bEl = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!bEl || bEl.disabled) return;
  const cmd = bEl.dataset.cmd;
  const ids = selectedFleetIds();
  if (cmd !== 'merge') merging = false; // any other command disarms merge-targeting
  if (cmd !== 'barrage') barrageAim = false; // any other command disarms barrage-targeting
  if (cmd !== 'firemode' && cmd !== 'fmset') fireMenu = false; // другой приказ закрывает 🔥-меню
  if (cmd !== 'attack') assaultAim = false; // any other command disarms assault-targeting
  if (cmd !== 'target') targetAim = false; // any other command disarms order-targeting
  // A real order leaves «Выбрать+» (the group stays selected and takes it);
  // ☰ and the ⊕ toggle itself keep the picking session alive.
  if (cmd !== 'pick' && cmd !== 'more') pickMode = false;
  heroAim = null; // any command disarms a pending hero cast / deploy
  heroSpawnAim = null;
  if (cmd === 'move') {
    aiming = !aiming; // arm / disarm the move order
    assaultAim = false;
  } else if (cmd === 'merge') {
    if (ids.length >= 2) mergeGroup(ids);
    else {
      merging = !merging; // lone fleet → arm: next friendly-fleet tap is the anchor
      aiming = false;
      if (merging) note(t('⛬ выберите флот для объединения'));
    }
  } else if (cmd === 'stop') {
    for (const id of ids) if (s.fleets[id]?.movement) playerOrder(stopFleet(ME, id));
  } else if (cmd === 'attack') {
    if (pcUi()) {
      // PC: ШТУРМ aims like «Курс» — the next click on someone else's world sends
      // the fleet there and it storms on arrival (valid targets ring up on the map).
      assaultAim = !assaultAim;
      aiming = false;
      if (assaultAim) note(t('⚔ выберите чужой мир для штурма'));
    } else {
      for (const id of ids) if (s.fleets[id]?.orbit === 'near') playerOrder(assaultFleet(ME, id));
      aiming = false;
    }
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
    if (barrageAim) note(t('🎯 тапните вражеский флот для сосредоточенного огня · пустота = авто'));
  } else if (cmd === 'target') {
    // TGT-1: arm order-targeting — the next world tap opens the plan composer
    // beside the target (CC-1 chain: wait/move/assault/barrage, editable later).
    targetAim = !targetAim;
    aiming = false;
    if (targetAim) note(t('◎ тапните цель на карте — соберём приказ'));
  } else if (cmd === 'more') {
    cmdMore = !cmdMore; // ☰ — show/hide the extras row
  } else if (cmd === 'firemode') {
    fireMenu = !fireMenu; // 🔥 — открыть/закрыть меню выбора режима огня
    aiming = false;
  } else if (cmd === 'fmset') {
    // Выбор в 🔥-меню: единый режим всем выделенным флотам с артиллерией.
    const mode = bEl.dataset.mode ?? 'standard';
    for (const id of ids) {
      const f = s.fleets[id];
      if (f && f.owner === ME && fleetHasArtillery(f) && (f.barrageMode ?? 'standard') !== mode) {
        playerOrder(barrageModeFleet(ME, id, mode));
      }
    }
    fireMenu = false;
  } else if (cmd === 'boost') {
    // BOOST-1 форс-марш: toggle for the whole selection — ON unless everyone
    // already marches. Wear only bites while actually flying.
    const on = !ids.every((id) => marchFlagged(id));
    for (const id of ids) if (marchFlagged(id) !== on) playerOrder(forceMarchFleet(ME, id, on));
    if (on) note(t('⚡ форс-марш: +50% скорости, −5% прочности за час хода'));
  } else if (cmd === 'qauto') {
    // SO-UI: the CC-2 auto-storm stance, group-uniform (moved off the bottom sheet).
    const on = !ids.every((id) => isAutoAssault(id));
    setAutoAssault(ids, on);
    if (on) note(t('⚔ авто-штурм включён — флот сам штурмует вражеский мир по прибытии'));
  } else if (cmd === 'qscramble') {
    // SO-UI: the CC-4 «дежурный вылет», group-uniform over the squadron fleets.
    const wings = ids.filter((id) => fleetHasSquadron(s.fleets[id]));
    const on = !wings.every((id) => patrolOf(id));
    setScramble(wings, on);
    if (on) note(t('🛩 дежурный вылет включён — эскадрилья бьёт врага в радиусе'));
  } else if (cmd === 'pick') {
    // SEL-1: touch multi-select — the sheet collapses, taps toggle own fleets.
    pickMode = !pickMode;
    aiming = false;
    if (pickMode) note(t('⊕ тапайте свои флоты — соберите группу и отдайте общий приказ'));
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
  closeTgtEditor(); // same for the order composer — its own marker tap reopens it
  // Hit radii: widened for a finger (44px-target rule); nearest-in-radius wins, so
  // clustered objects resolve to what the player aimed at, not iteration order.
  const rFleet = tapByTouch ? 24 : 16;
  const rPing = tapByTouch ? 18 : 12;
  const rNode = tapByTouch ? 30 : 24;
  // Merge armed: the next tap on a friendly fleet (not itself in the selection) is
  // the anchor — the selected fleet(s) fly to it and fuse. Any other tap cancels.
  if (merging) {
    const movers = selectedFleetIds();
    const anchor = nearestHit(
      Object.values(s.fleets).filter((f) => f.owner === ME && !movers.includes(f.id)),
      fleetAnchor,
      mx,
      my,
      rFleet,
    );
    if (anchor) orderMerge(movers, anchor.id);
    merging = false;
    lastPanelHtml = '';
    return;
  }
  // Barrage armed: the next tap on an enemy fleet focuses the selected artillery's
  // standoff fire on it; a tap on empty space (no enemy fleet) clears back to
  // auto-targeting the nearest hostile in range. A mis-aimed/peace target is
  // rejected server-side (surfaced as a log note).
  if (barrageAim) {
    const target = nearestHit(
      Object.values(s.fleets).filter((f) => f.owner !== ME),
      fleetAnchor,
      mx,
      my,
      rFleet,
    );
    const targetId: string | null = target?.id ?? null;
    for (const id of selectedFleetIds()) {
      if (fleetHasArtillery(s.fleets[id])) playerOrder(barrageFleet(ME, id, targetId));
    }
    if (targetId) note(t('🎯 сосредоточенный огонь назначен'));
    else note(t('🎯 автоприцел'));
    barrageAim = false;
    lastPanelHtml = '';
    return;
  }
  // Hero cast armed: the next tap picks the target world. Range / cooldown / cost
  // are the core's gates — a mis-aim comes back as an honest rejection note.
  if (heroAim) {
    const cast = heroAim;
    heroAim = null;
    const n = nearestHit(MAP, (nn) => world(nn), mx, my, rNode);
    if (n) playerOrder(castHeroAbility(ME, cast.heroId, cast.abilityId, n.id));
    else note(t('✖ каст отменён'));
    lastPanelHtml = '';
    return;
  }
  // Hero deploy armed: the tap picks WHERE the ship rises — your own world; with the
  // marker perks also one of your fleets (boarding) / an allied world. Own-fleet hits
  // are only considered when the hero actually carries the boarding marker, so a tap
  // on a world under your fleet still means the world.
  if (heroSpawnAim) {
    const heroId = heroSpawnAim;
    heroSpawnAim = null;
    const hero = s.heroes?.[heroId];
    const canBoard = (hero?.abilities ?? []).some(
      (a) => a !== null && data.heroAbilities[a]?.type === 'spawn_fleet',
    );
    const host = canBoard
      ? nearestHit(
          Object.values(s.fleets).filter((f) => f.owner === ME),
          fleetAnchor,
          mx,
          my,
          rFleet,
        )
      : null;
    const n = host ? null : nearestHit(MAP, (nn) => world(nn), mx, my, rNode);
    if (host) playerOrder(spawnHero(ME, heroId, host.id));
    else if (n) playerOrder(spawnHero(ME, heroId, n.id));
    else note(t('✖ развёртывание отменено'));
    lastPanelHtml = '';
    return;
  }
  // ШТУРМ armed (PC): the click picks the target world — someone else's capturable
  // world only. An enemy at war → fly + storm on arrival; a peaceful owner → the
  // "friendly faction — declare war?" dialog. Anything else keeps the aim armed.
  if (assaultAim) {
    const n = nearestHit(MAP, (nn) => world(nn), mx, my, rNode);
    if (!n) {
      assaultAim = false; // empty space — cancel, like an armed move
      lastPanelHtml = '';
      return;
    }
    const target = s.planets[n.id];
    const capturable = SECTOR_TYPES[SECTOR_OF[n.id]]?.capturable ?? false;
    if (!target || !capturable || target.owner == null || target.owner === ME) {
      note(t('⚔ штурмовать можно только чужой мир'));
      return; // stay armed — pick another target
    }
    tryAssaultGroup(selectedFleetIds(), n.id);
    assaultAim = false;
    lastPanelHtml = '';
    return;
  }
  // SEL-1 «Выбрать+»: while picking, taps only toggle OWN fleets in/out of the
  // group — nothing deselects, worlds don't grab the tap, the map is a picking
  // surface until the mode is left (⊕ again, or any common order).
  if (pickMode && !aiming) {
    const mine = nearestHit(
      Object.values(s.fleets).filter((f) => f.owner === ME),
      fleetAnchor,
      mx,
      my,
      rFleet,
    );
    if (mine) toggleFleetInSelection(mine.id);
    return;
  }
  // TGT-1: «Цель» armed → the next world tap opens the order composer beside it.
  if (targetAim) {
    const n = nearestHit(MAP, (nn) => world(nn), mx, my, rNode);
    targetAim = false;
    lastCmdHtml = '';
    if (n) openTgtEditor(n.id, selectedFleetIds());
    else note(t('◎ цель не выбрана'));
    return;
  }
  // A standing order marker: tap re-opens the composer with the live plan.
  if (!aiming) {
    const tm = nearestHit(tgtHits, (h) => h, mx, my, rPing);
    if (tm) {
      openTgtEditor(tm.target, tm.fleetIds);
      return;
    }
  }
  // Plain tap = selection. Movement happens only when "Move" is armed (aiming), so a
  // fleet selection never blocks picking a planet (and vice versa).
  // A tap on an ally ping marker opens its description popup (takes priority over
  // selection, since markers float above the node they mark).
  if (!aiming) {
    const ping = nearestHit(pingHits, (h) => h, mx, my, rPing);
    if (ping) {
      openPingPop(ping.loc);
      return;
    }
  }
  // Move armed → send the selected fleet(s) to the tapped world (or the nearest lane
  // point if no world is hit). A route crossing a player you're at peace with stages a
  // war prompt instead of dispatching.
  if (aiming) {
    const n = nearestHit(MAP, (nn) => world(nn), mx, my, rNode);
    if (n) tryMoveGroup(selectedFleetIds(), n.id);
    else {
      const lane = nearestLanePoint(mx, my);
      if (lane) tryMoveEdgeGroup(selectedFleetIds(), { from: lane.from, to: lane.to, t: lane.t });
    }
    aiming = false;
    lastPanelHtml = '';
    return;
  }
  // Plain tap = selection.
  const n = nearestHit(MAP, (nn) => world(nn), mx, my, rNode);
  if (!pcUi()) {
    // Mobile (frozen in this chat): the original fleet-first behaviour — nearest own
    // fleet under the tap, else the world, else clear.
    const mine = nearestHit(
      Object.values(s.fleets).filter((f) => f.owner === ME),
      fleetAnchor,
      mx,
      my,
      rFleet,
    );
    if (mine) {
      if (additive)
        toggleFleetInSelection(mine.id); // Shift / Ctrl / ⌘ → extend the group
      else setFleetSelection([mine.id]); // (clears any selected planet)
      return;
    }
    if (n) {
      selPlanet = n.id;
      selFleet = null;
      selFleets = new Set();
      lastPanelHtml = '';
      return;
    }
    clearSelection();
    return;
  }
  // PC — RimWorld-style cycling: gather EVERY selectable object under the tap — your
  // fleets (nearest first), then the world beneath them — and each repeat tap on the
  // same spot advances to the next. So a fleet parked on its home world (or a stack of
  // fleets on one orbit) no longer permanently masks the world / the fleets below it.
  const fleetHits = Object.values(s.fleets)
    .filter((f) => f.owner === ME)
    .map((f) => {
      const a = fleetAnchor(f);
      return a ? { id: f.id, d: Math.hypot(mx - a.x, my - a.y) } : null;
    })
    .filter((h): h is { id: string; d: number } => !!h && h.d < rFleet)
    .sort((a, b) => a.d - b.d);
  if (additive) {
    // Ctrl/⌘ → extend the fleet group with the nearest fleet under the tap (no cycling).
    if (fleetHits[0]) toggleFleetInSelection(fleetHits[0].id);
    return;
  }
  const cands: string[] = fleetHits.map((h) => 'f:' + h.id);
  if (n) cands.push('p:' + n.id);
  if (cands.length === 0) {
    clearSelection();
    return;
  }
  // Advance from whatever is selected now: a repeat tap on the same cluster steps to
  // the next candidate; a tap on a fresh spot (current selection not in the cluster)
  // starts at the topmost (index 0). One candidate → tapping it just keeps it selected.
  const curKey = selFleet ? 'f:' + selFleet : selPlanet ? 'p:' + selPlanet : null;
  const at = curKey ? cands.indexOf(curKey) : -1;
  const pick = cands[(at + 1) % cands.length]!;
  if (pick.startsWith('f:')) {
    setFleetSelection([pick.slice(2)]); // (clears any selected planet)
  } else {
    selPlanet = pick.slice(2);
    selFleet = null;
    selFleets = new Set();
    lastPanelHtml = '';
  }
}

// --- camera control: drag-pan, pinch-zoom, wheel-zoom, tap-select ------------

/** A finger wobbles more than a mouse: the pan-vs-tap threshold widens on touch. */
function tapSlop(ev: PointerEvent): number {
  return ev.pointerType === 'touch' ? 11 : 6;
}
/** Set per tap: hit radii in selectAt widen for a finger (44px-target rule). */
let tapByTouch = false;
/** Nearest candidate within `r` of the tap — NOT the first in iteration order, so
 *  overlapping objects (an orbit ring of fleets) resolve to what the player aimed at. */
function nearestHit<T>(
  items: Iterable<T>,
  pos: (t: T) => { x: number; y: number } | null,
  mx: number,
  my: number,
  r: number,
): T | null {
  let best: T | null = null;
  let bd = r;
  for (const it of items) {
    const c = pos(it);
    if (!c) continue;
    const d = Math.hypot(mx - c.x, my - c.y);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best;
}

const pointers = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number } | null = null;
let dragged = false;
// Long-press (touch): ~350ms still finger = additive fleet pick on a fleet, or a
// box-select anywhere else — the touch stand-ins for Ctrl-click and Shift-drag.
let longPressTimer: number | null = null;
let longPressFired = false;
function cancelLongPress(): void {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}
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
    tapByTouch = ev.pointerType === 'touch'; // preview + commit share the snap radius
    longPressFired = false;
    // Shift OR Ctrl/⌘ extends the fleet selection (the RTS/Bytro habit — Shift-click
    // gathers fleets for one group order). Shift over EMPTY space still opens a
    // box-select; Shift over one of YOUR fleets is an additive click instead, so the
    // two never fight (a rubber-band from a fleet would eat the click).
    const overOwnFleet = !!nearestHit(
      Object.values(s.fleets).filter((f) => f.owner === ME),
      fleetAnchor,
      p.x,
      p.y,
      ev.pointerType === 'touch' ? 24 : 16,
    );
    additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    boxSelecting = ev.shiftKey && !overOwnFleet;
    selectionBox = boxSelecting ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y } : null;
    dragged = false;
    if (aiming || assaultAim) aimPointer = p; // the aim preview starts under the finger at once
    // Touch long-press: a still finger for ~350ms picks a fleet ADDITIVELY (the
    // Ctrl-click of phones) or opens a BOX-SELECT from empty space (the Shift-drag).
    // Not while an armed mode (move/merge/barrage) owns the taps.
    if (ev.pointerType === 'touch' && !aiming && !merging && !barrageAim) {
      cancelLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (pointers.size !== 1 || dragged) return;
        longPressFired = true;
        navigator.vibrate?.(25);
        const mine = nearestHit(
          Object.values(s.fleets).filter((f) => f.owner === ME),
          fleetAnchor,
          p.x,
          p.y,
          24,
        );
        if (mine) {
          toggleFleetInSelection(mine.id); // add / drop from the group
        } else {
          boxSelecting = true; // drag now stretches the selection box
          selectionBox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        }
      }, 350);
    }
  } else if (pointers.size === 2) {
    cancelLongPress();
    if (aiming) {
      // Second finger = cancel the armed move (the audit's escape hatch).
      aiming = false;
      lastPanelHtml = '';
      note(t('прицеливание отменено'));
    }
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (ev) => {
  const prev = pointers.get(ev.pointerId);
  if (!prev) return;
  const p = ptXY(ev);
  pointers.set(ev.pointerId, p);
  const moved = dragStart && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > tapSlop(ev);
  if (moved) cancelLongPress(); // a moving finger is a drag, not a long-press
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    pinchDist = d;
    dragged = true;
  } else if ((aiming || assaultAim) && !pcUi()) {
    // TOUCH with Move/ШТУРМ armed: the finger DRAGS THE AIM (live preview via
    // aimPointer), the camera stays put — releasing commits. Panning used to hijack
    // this drag and silently swallow the order (the audit's blind-order finding).
    // On PC the mouse hovers to aim, so an LMB drag stays a normal camera pan and
    // the armed order survives it (commit is a clean click).
    void 0;
  } else if (boxSelecting && dragStart) {
    selectionBox = { x1: dragStart.x, y1: dragStart.y, x2: p.x, y2: p.y };
    if (moved) dragged = true;
  } else {
    cam.x += p.x - prev.x;
    cam.y += p.y - prev.y;
    clampCam(); // keep the map from being dragged entirely off-screen
    if (moved) dragged = true;
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
    // A modifier-held box ADDS to the running group (Shift-gather is cumulative);
    // a plain box replaces it. An empty additive box leaves the group untouched.
    if (picked.length) {
      if (additive) setFleetSelection([...new Set([...selectedFleetIds(), ...picked])]);
      else setFleetSelection(picked);
    } else if (!additive) {
      selFleets = new Set();
      selFleet = null;
      lastPanelHtml = '';
    }
    selectionBox = null;
    boxSelecting = false;
  }
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  cancelLongPress();
  if (longPressFired) {
    longPressFired = false; // the long-press already acted; this release is spent
    return;
  }
  // Touch: while an aim is armed the drag steered the preview, so a dragged release
  // still commits. PC: a drag is a camera pan — only a clean click commits, and the
  // armed order stays armed through pans.
  const aimDragCommits = (aiming || assaultAim) && !pcUi();
  if (single && p && (aimDragCommits || !dragged)) {
    tapByTouch = ev.pointerType === 'touch';
    selectAt(p.x, p.y);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (ev) => {
  cancelLongPress();
  longPressFired = false;
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
// Pace chips (×1/×10/×50): retune the play/fast pair mid-match and start running at
// the new multiplier — the same mapping the setup screen launches with.
for (const b of Array.from(document.querySelectorAll('[data-mult]'))) {
  b.addEventListener('click', () => applyTimeSpeed(Number((b as HTMLElement).dataset.mult)));
}

// Map a setup time-flow multiplier (×1/×2/×5/×10) onto the speedbar and start running at
// it. ×1 is true wall-clock — 1 game-hour per real hour — matching the real-time MMO
// design; each higher multiplier accelerates from there (×5 = 5 game-hours per real hour,
// …), and fast-forward (▶▶) runs at 3× the chosen play. The play/fast buttons carry the
// live values so pause→resume returns to the chosen pace, not the default.
const PLAY_BASE = 1 / 3600; // game-hours per real second; 1/3600 ⇒ 1 game-hour per real hour (×1 = wall-clock)
function applyTimeSpeed(mult: number): void {
  const play = PLAY_BASE * mult;
  const playBtn = $('spd-play');
  const fastBtn = $('spd-fast');
  if (playBtn) playBtn.dataset.speed = String(play);
  if (fastBtn) fastBtn.dataset.speed = String(play * 3);
  speed = play;
  for (const x of Array.from(document.querySelectorAll('[data-speed]')))
    x.classList.toggle('on', Number((x as HTMLElement).dataset.speed) === speed);
  for (const x of Array.from(document.querySelectorAll('[data-mult]')))
    x.classList.toggle('on', Number((x as HTMLElement).dataset.mult) === mult);
}

// Restart → back to the skirmish setup (bot selection). The speedbar button serves the
// no-bots sandbox; the end-banner button (delegated) serves a finished bot match.
// Player build: the button is stripped with the rest of the time controls (no skirmish).
if (!__PLAYER_BUILD__) restartBtn.addEventListener('click', () => openSetup());
bannerEl.addEventListener('click', (ev) => {
  if ((ev.target as Element).closest('[data-restart]')) openSetup();
});

// --- end screen (match over): outcome + stats + rematch ----------------------
const endscreenEl = $('endscreen');
let lastEndHtml = '';
/** Paint the terminal end screen from `endScreen` (set by checkEnd). Reads final
 *  numbers straight from the AUTHORITATIVE `match` state, so the same panel serves a
 *  solo match and a net one. Hidden while no match is over or the player dismissed it
 *  to look at the board. */
function renderEndScreen(): void {
  if (!endScreen || endScreen.dismissed) {
    if (endscreenEl.style.display !== 'none') {
      endscreenEl.style.display = 'none';
      lastEndHtml = '';
    }
    return;
  }
  const sc = s.match?.scores ?? {};
  const mine = sc[ME];
  // Placement: rank among all scored seats by total (1st of N).
  const ranked = Object.keys(sc).sort((a, b) => (sc[b]?.total ?? 0) - (sc[a]?.total ?? 0));
  const place = ranked.indexOf(ME) + 1;
  const total = Math.round(mine?.total ?? 0);
  const provinces = mine?.controlledPlanets ?? worldsOf(ME);
  const fleets = mine?.fleets ?? 0;
  const units = mine?.units ?? 0;
  const elapsed = Math.max(0, (s.match?.endedAt ?? s.time) - (s.startedAt ?? 0));
  const dur = fmtStamp(elapsed, { day: true, time: true });
  const cls = endScreen.won ? 'win' : endScreen.draw ? 'draw' : 'lose';
  const head = endScreen.won
    ? s.match?.winners && s.match.winners.length > 1
      ? t('🏆 ПОБЕДА КОАЛИЦИИ')
      : t('🏆 ПОБЕДА')
    : endScreen.draw
      ? t('⚖️ НИЧЬЯ')
      : t('💀 ПОРАЖЕНИЕ');
  const cell = (k: string, v: string) =>
    `<div class="es-cell"><span class="es-k">${k}</span><span class="es-v">${v}</span></div>`;
  const xpLine =
    endScreen.xp > 0
      ? `<div class="es-xp">${t('★ Опыт командующего: +{n}', { n: endScreen.xp })}` +
        (endScreen.levelUp !== null
          ? `<span class="lvl">${t('★ Новый уровень {lvl} — очко прокачки ждёт в меню «Прокачка»', { lvl: endScreen.levelUp })}</span>`
          : '') +
        `</div>`
      : '';
  // Rematch wording is honest per mode: solo restarts a skirmish; a NET match can't
  // re-seat the same table client-side (server brick), so "again" opens the browser.
  const againLabel = NET ? t('⟳ Новый матч') : t('⟳ Играть ещё');
  const html =
    `<div class="es-box">` +
    `<div class="es-head ${cls}">${head}</div>` +
    `<div class="es-why">${esc(endScreen.why)}</div>` +
    `<div class="es-grid">` +
    `<div class="es-cell wide"><span class="es-k">${t('Итоговый счёт')}</span><span class="es-v">✦ ${total} <small>· ${t('{p}-е место из {n}', { p: place, n: ranked.length })}</small></span></div>` +
    cell(t('Провинции'), `⬣ ${provinces}`) +
    cell(t('Флоты'), `⛴ ${fleets}`) +
    cell(t('Юниты'), `⚔ ${units}`) +
    cell(t('Длительность'), dur) +
    `</div>` +
    xpLine +
    `<div class="es-acts">` +
    `<button class="es-btn primary" data-es="again">${againLabel}</button>` +
    `<button class="es-btn" data-es="menu">⌂ ${t('В меню')}</button>` +
    `<button class="es-btn ghost" data-es="board">${t('Смотреть доску')}</button>` +
    `</div></div>`;
  if (html !== lastEndHtml) {
    endscreenEl.innerHTML = html;
    lastEndHtml = html;
  }
  endscreenEl.style.display = 'flex';
}
endscreenEl.addEventListener('click', (ev) => {
  const act = (ev.target as Element).closest('[data-es]') as HTMLElement | null;
  if (!act) return;
  const which = act.dataset.es;
  if (which === 'board') {
    if (endScreen) endScreen.dismissed = true; // hide the panel, leave the frozen board
    return;
  }
  // Leaving a net match is a deliberate disconnect (no auto-reconnect).
  const wasNet = NET;
  if (NET) {
    userClosed = true;
    NET = false;
    if (netSock) netSock.close();
  }
  endScreen = null; // leaving the finished match — the overlay must not linger over the hub
  lastEndHtml = '';
  if (which === 'again') {
    // Solo: straight back into a skirmish setup. Net: the match browser (a same-table
    // rematch needs server support — a separate brick); either way, one tap to next game.
    if (wasNet) {
      openHub();
      hubTab('games');
    } else {
      openSetup('hub');
    }
  } else {
    openHub(); // "В меню"
  }
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
  stopFirstGoals(); // ONB-7: leaving the match ends the onboarding checklist
  openHub();
});
// Rail: «Покинуть сессию» — same exit as the speedbar ⌂, reachable from the rail too.
document.getElementById('rail-exit')?.addEventListener('click', () => $('tomenu').click());

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

// --- division template designer (H4, Stellaris-style) ------------------------------
// Editing happens HERE, before building: the planet panel only picks a ready design.
// Custom templates (3) are editable + renamable; named officer templates are locked
// premades («готовый шаблон, менять нельзя») shown for reference. A mobilised division
// is a snapshot — editing a template later never touches armies already in the field.
const divDesignWin = $('divdesign');
let ddIdx = 0; // selected design: 0..2 custom, 3+ officer premades
function renderDivDesign(): void {
  const tpls = templatesOf(s, ME);
  const all: Array<{ tpl: FormationTemplate; officer?: string }> = [
    ...tpls.map((tpl) => ({ tpl })),
    ...OFFICER_TEMPLATES.map((tpl) => ({ tpl, officer: tpl.officer })),
  ];
  ddIdx = Math.max(0, Math.min(ddIdx, all.length - 1));
  const pick = all[ddIdx]!;
  const locked = pick.officer !== undefined;
  let h = `<div class="dd-tabs">`;
  for (let i = 0; i < all.length; i++) {
    h += `<button data-ddtab="${i}" class="${i === ddIdx ? 'on' : ''}">${all[i]!.officer ? '★ ' : ''}${esc(t(all[i]!.tpl.name))}</button>`;
  }
  h += `</div>`;
  if (locked) {
    const off = OFFICERS[pick.officer!];
    const bonus = [
      off?.atk ? `+${Math.round(off.atk * 100)}% ${t('атака')}` : '',
      off?.def ? `+${Math.round(off.def * 100)}% ${t('оборона')}` : '',
      off?.hp ? `+${Math.round(off.hp * 100)}% ${t('живучесть')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    h += `<div class="dd-lock">★ ${esc(t(off?.name ?? ''))} — ${bonus}</div>`;
    h += `<div class="dd-lock">${t('Именной шаблон офицера: состав закреплён, редактировать нельзя.')}</div>`;
  } else {
    h += `<div class="dd-name"><input id="dd-name" maxlength="24" value="${esc(pick.tpl.name)}"><button class="b" data-ddrename>${t('Переименовать')}</button></div>`;
  }
  h += `<div class="dd-slots">`;
  for (let i = 0; i < FORMATION_SLOTS; i++) {
    const u = pick.tpl.slots[i] ?? null;
    h += `<button data-ddslot="${i}"${locked ? ' disabled' : ''}>${u ? `${formIcon(u)} ${esc(t(FORM_RU[u] ?? u))}` : '＋'}</button>`;
  }
  h += `</div>`;
  const f = formationStats(pick.tpl);
  // Per-target damage preview: the counter matrix made visible — Σ atk of the
  // composition against each of the four unit types.
  const vs = (target: string): number =>
    pick.tpl.slots.reduce(
      (n, u) => n + (u ? (GROUND_ROSTER[u]?.atk[target as FormationUnit] ?? 0) : 0),
      0,
    );
  h += `<div class="dd-vs">`;
  for (const tgt of FORMATION_UNITS) {
    const v = vs(tgt);
    h += `<div class="vrow"><span class="vnm">${t('Урон по:')} ${formIcon(tgt)} ${esc(t(FORM_RU[tgt] ?? tgt))}</span><div class="vtrack"><div class="vbar" style="width:${Math.min(100, Math.round((v / 90) * 100))}%"></div></div><span>${v}</span></div>`;
  }
  h += `</div>`;
  const cost =
    Object.entries(f.cost)
      .map(([r, a]) => `${a}${TECH_CUR[r] ?? r[0]}`)
      .join(' ') || '—';
  const syn = f.synergies.map((x) => `${esc(t(x.name))} — ${esc(t(x.desc))}`).join('<br>');
  h += `<div class="row dim">⚔${f.attack} 🛡${f.defense} ❤${f.hp} · ${t('состав {n}/{s} · {rest}', { n: f.count, s: FORMATION_SLOTS, rest: cost })}</div>`;
  if (syn) h += `<div class="hint2">${syn}</div>`;
  h += `<div class="hint2">${t('Тап по слоту меняет род войск: ополчение → тяжёлая пехота → спецназ → танк. Танки бьют любую пехоту; спецназ — единственная пехота, опасная танкам; тяжёлая пехота держит оборону.')}</div>`;
  $('divdesignbody').innerHTML = h;
}
divDesignWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'divdesign' || tg.closest('.tw-close')) {
    divDesignWin.classList.remove('show');
    lastPanelHtml = ''; // the mobilise picker mirrors the templates — refresh it
    return;
  }
  const tab = tg.closest('[data-ddtab]') as HTMLElement | null;
  if (tab) {
    ddIdx = Number(tab.dataset.ddtab);
    renderDivDesign();
    return;
  }
  const slot = tg.closest('[data-ddslot]') as HTMLButtonElement | null;
  if (slot && !slot.disabled && ddIdx < templatesOf(s, ME).length) {
    const si = Number(slot.dataset.ddslot);
    const cur = templatesOf(s, ME)[ddIdx]?.slots[si] ?? null;
    const order: (string | null)[] = [null, ...FORMATION_UNITS];
    const next = order[(order.indexOf(cur) + 1) % order.length] ?? null;
    playerOrder(setDivisionTemplate(ME, ddIdx, si, next));
    renderDivDesign();
    return;
  }
  if (tg.closest('[data-ddrename]')) {
    const name = ($('dd-name') as HTMLInputElement).value.trim();
    if (name && ddIdx < templatesOf(s, ME).length) {
      playerOrder(renameDivisionTemplate(ME, ddIdx, name));
      renderDivDesign();
    }
  }
});
const TECH_CUR: Record<string, string> = {
  credits: '¤',
  food: '❖',
  metal: '⬢',
  energy: '↯',
  microelectronics: '▦',
};
const TECH_BRANCHES: Array<{ key: string; label: string }> = [
  { key: 'space', label: 'Космос' },
  { key: 'ground', label: 'Земля' },
  { key: 'squadron', label: 'Эскадрильи' },
  { key: 'missile', label: 'Ракеты' },
  { key: 'command', label: 'Командование' }, // automation / C2 — «Хранитель» lives here
];
const branchLabel = (key: string): string =>
  t(TECH_BRANCHES.find((b) => b.key === key)?.label ?? key);
const techCost = (c: Record<string, number>): string =>
  Object.entries(c)
    .map(([k, v]) => `${TECH_CUR[k] ?? k} ${v}`)
    .join(' · ');
// --- TT-3.1: экран-дерево (макет v4) — вкладки-ветки, рельса дней, досье по тапу ----
// Presentation-only layout: named sub-columns per branch, ids in day order. The
// canonical data stays layout-free; a tech missing from this map falls into an
// auto-column appended at the end, so fresh data never breaks the screen.
const TECH_COLS: Record<string, Array<{ label: string; ids: string[] }>> = {
  space: [
    { label: 'Индустрия', ids: ['industrial_automation', 'microelectronics_fabrication'] },
    { label: 'Флот', ids: ['orbital_logistics', 'siege_doctrine', 'void_armadas'] },
    { label: 'Сенсоры', ids: ['deep_survey'] },
  ],
  ground: [
    { label: 'Доктрины', ids: ['combined_arms', 'garrison_networks'] },
    { label: 'Укрепления', ids: ['fortified_infrastructure', 'planetary_bastions'] },
  ],
  squadron: [{ label: 'Авиакрыло', ids: ['flight_decks', 'strike_vectors', 'ace_programs'] }],
  missile: [
    { label: 'Арсенал', ids: ['guidance_arrays', 'warhead_miniaturization', 'saturation_barrage'] },
  ],
  command: [
    { label: 'Связь', ids: ['signal_corps', 'logistics_command'] },
    { label: 'Автоматизация', ids: ['ai_stewardship'] },
  ],
};
const TECH_ICONS: Record<string, string> = {
  industrial_automation: '⚙',
  microelectronics_fabrication: '▦',
  deep_survey: '📡',
  orbital_logistics: '⛽',
  siege_doctrine: '☄',
  void_armadas: '🛸',
  combined_arms: '⚔',
  garrison_networks: '⛺',
  fortified_infrastructure: '🏰',
  planetary_bastions: '🛡',
  flight_decks: '🛫',
  strike_vectors: '🎯',
  ace_programs: '🎖',
  guidance_arrays: '🧭',
  warhead_miniaturization: '🧨',
  saturation_barrage: '🚀',
  signal_corps: '📶',
  logistics_command: '🧠',
  ai_stewardship: '😴',
};
const TECH_FX_LABEL: Record<string, string> = {
  productionBonus: 'производство',
  fleetSpeedBonus: 'скорость флотов',
  combatDamageBonus: 'урон',
  radarRangeBonus: 'радиус радаров',
};
let techTab = 'space'; // активная вкладка-ветка
let techModalId: string | null = null; // открытое досье узла
type TechDefLike = (typeof data.technologies)[string];
type TechCond = TechDefLike['conditions'][number];
function techCondText(c: TechCond): string {
  switch (c.type) {
    case 'has_scientist':
      return t('нужен учёный: {b}', { b: c.branch ? branchLabel(c.branch) : t('любой ветки') });
    case 'own_sectors':
      return t('своих секторов: {n}', { n: c.min });
    case 'has_building':
      return t('здание: {b} ×{n}', {
        b: tData(data.buildings[c.building]?.name ?? c.building),
        n: c.min,
      });
    case 'controls_planet_type':
      return t('мир типа {p} ×{n}', { p: tData(c.planetType), n: c.min });
    case 'has_unit':
      return t('юнит: {u} ×{n}', { u: tData(data.units[c.unit]?.name ?? c.unit), n: c.min });
    default:
      return t('особое условие');
  }
}
// Клиентская проверка — только для подсветки узла; финальную правду говорит ядро
// (technologyLock, fail-secure). Типы, которых нет в живых данных, честно показываем
// закрытыми — reducer их всё равно проверит сам.
function techCondOk(c: TechCond): boolean {
  const me = s.players[ME];
  switch (c.type) {
    case 'has_scientist':
      return (me?.scientists ?? []).some((sc) => {
        const def = data.scientists[sc.id];
        return (
          !!def && (!c.branch || def.branch === c.branch) && (sc.level ?? 1) >= (c.minLevel ?? 1)
        );
      });
    case 'own_sectors':
      return Object.values(s.planets).filter((p) => p.owner === ME).length >= c.min;
    default:
      return false;
  }
}
/** «+10% производство · открывает: Fort» — эффекты и анлоки узла одной строкой. */
function techFx(td: TechDefLike): string {
  const fx = Object.entries(td.effects ?? {})
    .filter(([, v]) => (v as number) !== 0)
    .map(([k, v]) => `+${Math.round((v as number) * 100)}% ${t(TECH_FX_LABEL[k] ?? k)}`);
  for (const u of td.unlocks?.units ?? [])
    fx.push(t('открывает: {x}', { x: esc(tData(data.units[u]?.name ?? u)) }));
  for (const b of td.unlocks?.buildings ?? [])
    fx.push(t('открывает: {x}', { x: esc(tData(data.buildings[b]?.name ?? b)) }));
  for (const a of td.unlocks?.abilities ?? [])
    fx.push(t('способность: {x}', { x: a === 'steward' ? t('Хранитель') : esc(a) }));
  return fx.join(' · ');
}
function renderTech(): void {
  const body = $('techbody');
  const me = s.players[ME];
  // Meta-progression grants (meta_*) are account perks, not researchable session
  // techs — the tree shows only the real nodes.
  const techs = Object.fromEntries(
    Object.entries(data.technologies).filter(([id]) => !id.startsWith('meta_')),
  );
  const done = new Set(me?.technologies?.completed ?? []);
  // Research runs in CONCURRENT slots (core: technologies.active is a list).
  const activeRaw = me?.technologies?.active;
  const activeList = Array.isArray(activeRaw) ? activeRaw : activeRaw ? [activeRaw] : [];
  const res = (me?.resources ?? {}) as Record<string, number>;
  const started = s.startedAt ?? 0;
  const hudDay = floor(s.time / DAY) + 1; // счёт статус-бара: день 1 — первый
  // Рельса дней: объединение day-гейтов ВСЕХ веток (+ старт) — календарь общий,
  // при смене вкладки строки не прыгают (правило макета). Подпись = dayGate+1,
  // тот же счёт, что у часов в статус-баре.
  const gates = [
    ...new Set(
      Object.values(techs)
        .map((td) => td.dayGate ?? 0)
        .concat(0),
    ),
  ].sort((a, b) => a - b);
  const nowGate = gates.filter((g) => g + 1 <= hudDay).pop() ?? 0;
  // Пилюля слотов зеркалит кламп ядра: 2 базовых, +1 от учёного, максимум 3.
  const slotBonus = (me?.scientists ?? []).reduce(
    (n, c) => n + (data.scientists[c.id]?.slotBonus ?? 0),
    0,
  );
  const slots = Math.min(3, Math.max(2, 2 + slotBonus));
  // Состояние узла в порядке проверок ядра (technologyLock): prereq → день → условия.
  const nodeState = (id: string): { st: string; prog: number; eta: number } => {
    const td = techs[id]!;
    if (done.has(id)) return { st: 'done', prog: 1, eta: 0 };
    const act = activeList.find((a) => a.technology === id);
    if (act) {
      const total = act.completesAt - act.startedAt;
      return {
        st: 'res',
        prog: total > 0 ? clamp((s.time - act.startedAt) / total, 0, 1) : 1,
        eta: Math.max(0, Math.ceil((act.completesAt - s.time) / HOUR)),
      };
    }
    if ((td.prerequisites ?? []).some((p) => !done.has(p))) return { st: 'chain', prog: 0, eta: 0 };
    if ((td.dayGate ?? 0) > 0 && s.time - started < (td.dayGate ?? 0) * DAY)
      return { st: 'gate', prog: 0, eta: 0 };
    if ((td.conditions ?? []).some((c) => !techCondOk(c))) return { st: 'cond', prog: 0, eta: 0 };
    return { st: 'avail', prog: 0, eta: 0 };
  };
  const tabs = TECH_BRANCHES.map(
    (b) =>
      `<button class="tt-tab${b.key === techTab ? ' on' : ''}" data-ttab="${b.key}">${t(b.label)}</button>`,
  ).join('');
  // Кто из совета курирует эту ветку — и честное предупреждение, если никто.
  const lead = (me?.scientists ?? [])
    .map((c) => data.scientists[c.id])
    .find((d) => d?.branch === techTab);
  const leadHtml = lead
    ? `🧪 ${t('Ветку курирует')} <b>${esc(tData(lead.name))}</b>`
    : `🔭 ${t('Без лидера ветки — узлы с условием «учёный» закрыты')}`;
  // Колонки вкладки: из карты раскладки; техи вне карты — в автоколонку в конце.
  const colsDef = TECH_COLS[techTab] ?? [];
  const branchIds = Object.keys(techs).filter((id) => (techs[id]!.branch ?? 'space') === techTab);
  const placed = new Set(colsDef.flatMap((c) => c.ids));
  const extras = branchIds
    .filter((id) => !placed.has(id))
    .sort((a, b) => techs[a]!.tier - techs[b]!.tier || a.localeCompare(b));
  const cols = [
    ...colsDef.map((c) => ({ label: c.label, ids: c.ids.filter((id) => branchIds.includes(id)) })),
    ...(extras.length ? [{ label: '—', ids: extras }] : []),
  ].filter((c) => c.ids.length);
  const wide = cols.length <= 2 ? ' w2' : '';
  let rail = `<div class="tt-rail"><div class="tt-dhead">${t('ДЕНЬ')}</div>`;
  for (const g of gates) {
    const cls = g === nowGate ? ' now' : g + 1 > hudDay ? ' future' : '';
    rail += `<div class="tt-drow${cls}"><b>${g + 1}</b><small>${g === 0 ? t('старт') : t('день')}</small></div>`;
  }
  rail += `</div>`;
  let colsHtml = '';
  for (const col of cols) {
    let cells = '';
    for (const g of gates) {
      const nodes = col.ids
        .filter((id) => (techs[id]!.dayGate ?? 0) === g)
        .map((id) => {
          const td = techs[id]!;
          const st = nodeState(id);
          const badge =
            st.st === 'done'
              ? `<span class="tt-tick">✓</span>`
              : st.st === 'gate'
                ? `<span class="tt-lock">🔒</span>`
                : st.st === 'cond'
                  ? `<span class="tt-cnd">⚗</span>`
                  : '';
          const prog =
            st.st === 'res'
              ? `<span class="tt-prog"><i style="width:${Math.round(st.prog * 100)}%"></i></span>`
              : '';
          return (
            `<div class="tt-node st-${st.st}" data-tech="${id}">` +
            `<div class="tt-box">${TECH_ICONS[id] ?? '🔬'}${prog}${badge}</div>` +
            `<div class="tt-lbl">${esc(tData(td.name))}</div></div>`
          );
        })
        .join('');
      cells += `<div class="tt-cell${g === nowGate ? ' now' : ''}">${nodes}</div>`;
    }
    colsHtml += `<div class="tt-col${wide}"><div class="tt-chead">${t(col.label)}</div><div class="tt-cellwrap">${cells}</div></div>`;
  }
  // Досье узла (тап) — рендерится из состояния, так что живой 500мс-ререндер
  // обновляет прогресс/день, не закрывая окно.
  let modal = '';
  if (techModalId && !techs[techModalId]) techModalId = null;
  if (techModalId) {
    const id = techModalId;
    const td = techs[id]!;
    const st = nodeState(id);
    const gate = td.dayGate ?? 0;
    const prereqNames = (td.prerequisites ?? [])
      .map((p) => esc(tData(techs[p]?.name ?? p)))
      .join(', ');
    const condRows = (td.conditions ?? [])
      .map((c) => `<span>${techCondOk(c) ? '☑' : '⚗'} <b>${esc(techCondText(c))}</b></span>`)
      .join('');
    const affordable = Object.entries(td.cost).every(([k, v]) => (res[k] ?? 0) >= (v as number));
    const tag =
      st.st === 'done'
        ? `<span class="tt-tag">${t('ИЗУЧЕНО')}</span>`
        : st.st === 'res'
          ? `<span class="tt-tag amb">${t('ИССЛЕДУЕТСЯ')}</span>`
          : st.st === 'avail'
            ? `<span class="tt-tag">${t('ДОСТУПНО')}</span>`
            : `<span class="tt-tag dim">${t('ЗАКРЫТО')}</span>`;
    const btn =
      st.st === 'avail'
        ? `<button class="tt-mbtn" data-go="${id}"${affordable ? '' : ' disabled'}>🔬 ${affordable ? t('Исследовать') : t('Не хватает ресурсов')}</button>`
        : st.st === 'done'
          ? `<button class="tt-mbtn wait" disabled>✓ ${t('Изучено')}</button>`
          : st.st === 'res'
            ? `<button class="tt-mbtn wait" disabled>⏳ ${t('Идёт — ≈ {n} ч', { n: st.eta })}</button>`
            : st.st === 'gate'
              ? `<button class="tt-mbtn wait" disabled>🔒 ${t('Откроется в День {n}', { n: gate + 1 })}</button>`
              : st.st === 'chain'
                ? `<button class="tt-mbtn wait" disabled>🔒 ${t('Сначала изучите узел выше')}</button>`
                : `<button class="tt-mbtn wait" disabled>⚗ ${t('Условие не выполнено')}</button>`;
    modal =
      `<div class="tt-modal"><div class="tt-mback" data-mclose="1"></div><div class="tt-mwin">` +
      `<button class="tt-mx" data-mclose="1">✕</button>` +
      `<div class="tt-mhead"><div class="tt-mico">${TECH_ICONS[id] ?? '🔬'}</div><div>` +
      `<div class="tt-mname">${esc(tData(td.name))}<span class="tt-tier">T${td.tier}</span></div>` +
      `<div class="tt-mtags">${tag}</div></div></div>` +
      (td.description ? `<div class="tt-mdesc">${esc(t(td.description))}</div>` : '') +
      `<div class="tt-mstats">` +
      `<span>💰 <b>${techCost(td.cost)} · ${t('{n}ч', { n: td.researchTimeHours })}</b></span>` +
      (techFx(td) ? `<span>✦ <b>${techFx(td)}</b></span>` : '') +
      (gate > 0 ? `<span>📅 <b>${t('с дня {n}', { n: gate + 1 })}</b></span>` : '') +
      (prereqNames ? `<span>🔗 <b>${t('Требует:')} ${prereqNames}</b></span>` : '') +
      condRows +
      `</div>${btn}</div></div>`;
  }
  const html =
    `<div class="tt-top"><span class="tt-day">📅 ${t('День {n}', { n: hudDay })}</span>` +
    `<span class="tt-slots">⚛ ${t('слоты {a}/{b}', { a: activeList.length, b: slots })}</span></div>` +
    `<div class="tt-tabs">${tabs}</div>` +
    `<div class="tt-lead${lead ? '' : ' closed'}">${leadHtml}</div>` +
    `<div class="tt-scroll"><div class="tt-grid">${rail}${colsHtml}</div></div>` +
    modal;
  // Живой ререндер (innerHTML) сбрасывал бы скролл панели — сохраняем и возвращаем.
  const scr0 = body.querySelector('.tt-scroll');
  const sx = scr0?.scrollLeft ?? 0;
  const sy = scr0?.scrollTop ?? 0;
  body.innerHTML = html;
  const scr1 = body.querySelector('.tt-scroll');
  if (scr1) {
    scr1.scrollLeft = sx;
    scr1.scrollTop = sy;
  }
}
document.getElementById('rail-tech')?.addEventListener('click', () => {
  techModalId = null; // свежее открытие — без прошлого досье
  techWin.classList.add('show');
  renderTech();
  maybeIntro('tech');
});
techWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'tech' || tg.classList.contains('tw-close')) {
    techModalId = null;
    techWin.classList.remove('show');
    return;
  }
  if (tg.closest('[data-mclose]')) {
    techModalId = null;
    renderTech();
    return;
  }
  const go = (tg.closest('.tt-mbtn') as HTMLElement | null)?.dataset.go;
  if (go) {
    playerOrder(researchTech(ME, go));
    renderTech(); // узел тут же перекрашивается в «исследуется»
    return;
  }
  const tab = (tg.closest('.tt-tab') as HTMLElement | null)?.dataset.ttab;
  if (tab) {
    if (tab !== techTab) {
      techTab = tab;
      techModalId = null;
    }
    renderTech();
    return;
  }
  const node = (tg.closest('.tt-node') as HTMLElement | null)?.dataset.tech;
  if (node) {
    techModalId = node;
    renderTech();
  }
});

// --- steward («Хранитель»): hand the seat to the AI while you sleep ----------
// Delegate control to a defensive AI until a game-time deadline; it holds the line and
// returns control on time (stewardModule). Gated by the Steward tech (researched via the
// «Командование» branch, day 15, scientist Куратор). A "morning report" note fires on expiry.
const stewWin = $('steward');
let lastStewAt = 0;
let lastIntelAt = 0; // throttle for the live intel-window timers (диплом. вкладка «Шпионаж»)
const STEW_DURATIONS = [4, 8, 12]; // game-hours a single delegation can run
// Snapshot of my standing at delegation time, diffed on expiry for the morning report.
let stewSnapshot: { planets: number; metal: number; credits: number } | null = null;
// The posture the next delegation will run (ST-3.3): «Оборона» is the safe default,
// «Активная оборона» adds the forecast-gated counterstrike + squadron fire-watch.
let stewPosture: 'defend' | 'active_defend' = 'defend';
function stewMetrics(): { planets: number; metal: number; credits: number } {
  let planets = 0;
  for (const pl of Object.values(s.planets)) if (pl.owner === ME) planets += 1;
  const r = (s.players[ME]?.resources ?? {}) as Record<string, number>;
  return { planets, metal: Math.round(r.metal ?? 0), credits: Math.round(r.credits ?? 0) };
}
function stewFmtDur(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}ч ${mins % 60}м` : `${mins}м`;
}
function stewardTechDone(): boolean {
  return s.players[ME]?.technologies?.completed.includes('ai_stewardship') ?? false;
}
/** One localized line of the Steward's decision journal (SITREP, ST-2.4). */
function stewLogLine(e: {
  kind: string;
  node?: string;
  fleetId?: string;
  to?: string;
  count?: number;
  fraction?: number;
}): string {
  const pct = e.fraction !== undefined ? String(Math.round(e.fraction * 100)) : '?';
  const node = e.node ?? '?';
  switch (e.kind) {
    case 'evac':
      return t('🏃 Эвакуация с {node} → {to}: прогноз потерь {pct}%, крыльев уведено: {n}', {
        node,
        to: e.to ?? '?',
        pct,
        n: String(e.count ?? 0),
      });
    case 'ferry':
      return t('🚚 Паром выслан к {node} за гарнизоном', { node });
    case 'stranded':
      return t('⚠ Гарнизон {node} не эвакуировать: транспорт не успевает (прогноз потерь {pct}%)', {
        node,
        pct,
      });
    case 'strike':
      return t('⚔ Контрудар у {node}: прогноз потерь {pct}%', { node, pct });
    case 'watch':
      return t('🛫 Дежурный вылет поднят у {node}', { node });
    case 'hold':
      return t('🛡 Рубеж {node} удержан: прогноз потерь {pct}%', { node, pct });
    case 'reinforce':
      return t('🚩 Подкрепление выслано к {node}: прогноз потерь {pct}%', { node, pct });
    default:
      return `${e.kind}: ${node}`;
  }
}
/** The journal section of the steward window — the last watch's decisions, newest
 *  first. Rendered whenever a journal exists (it survives expiry: the morning
 *  report is read AFTER the watch ends). */
function stewLogHtml(): string {
  const log = s.players[ME]?.stewardLog;
  if (!log || log.length === 0) return '';
  const lines = [...log]
    .reverse()
    .slice(0, 12)
    .map(
      (e) =>
        `<div class="st-log-line"><span class="st-log-when">${t('{dur} назад', { dur: stewFmtDur(Math.max(0, s.time - e.at)) })}</span> ${stewLogLine(e)}</div>`,
    )
    .join('');
  return `<div class="st-h">${t('Журнал Хранителя')}</div><div class="st-log">${lines}</div>`;
}
function renderSteward(): void {
  const body = $('stewardbody');
  const posture = stewardActive(s, ME, s.time); // null unless a live delegation
  const cur = s.players[ME]?.steward;
  let html = '';
  if (posture && cur) {
    html +=
      `<div class="st-status on">🤖 <b>${posture === 'active_defend' ? t('Хранитель ведёт активную оборону.') : t('Хранитель ведёт оборону.')}</b><br>` +
      t('Управление вернётся через <b>{dur}</b>.', { dur: stewFmtDur(cur.until - s.time) }) +
      `<br>` +
      `${posture === 'active_defend' ? t('Пока вы спите: держит рубежи, поднимает дежурные эскадрильи и контратакует у своих миров, когда прогноз потерь приемлем.') : t('Пока вы спите: держит рубежи и отбивает атаки, застраивает очередь и торгует — без наступлений.')}</div>` +
      `<div class="st-row"><button class="st-btn warn" data-stew="recall">${t('Вернуть управление')}</button></div>` +
      `<div class="st-note">${t('«Автопилот держит вас в игре — побеждает активная игра.» Оборонительная поза не ходит в атаку и не ведёт дипломатию.')}</div>`;
  } else if (!stewardTechDone()) {
    const day = Math.floor((s.time - (s.startedAt ?? 0)) / DAY) + 1; // счёт статус-бара: день 1 — первый
    html +=
      `<div class="st-status locked">🔒 <b>${t('«Протокол Хранитель» ещё не изучен.')}</b><br>` +
      t(
        'Ветка <b>Командование</b>, открывается в <b>День 16</b> учёному <b>Куратор</b> (сейчас день {day}).',
        { day: String(day) },
      ) +
      `<br>` +
      `${t('Изучите его в окне технологий — затем сможете передать место ИИ на время сна.')}</div>` +
      `<div class="st-row"><button class="st-btn" data-stew="tech">${t('Открыть технологии')}</button></div>`;
  } else {
    html +=
      `<div class="st-status">😴 <b>${t('Хранитель готов.')}</b><br>` +
      `${t('Передайте место доверенному ИИ, пока вы офлайн — он удержит рубежи и вернёт управление к сроку.')}</div>` +
      `<div class="st-h">${t('Поза')}</div><div class="st-row">` +
      (['defend', 'active_defend'] as const)
        .map(
          (p) =>
            `<button class="st-btn${stewPosture === p ? ' sel' : ''}" data-stew="posture" data-p="${p}">${p === 'defend' ? t('Оборона') : t('Активная оборона')}</button>`,
        )
        .join('') +
      `</div>` +
      `<div class="st-h">${t('Передать на')}</div><div class="st-row">` +
      STEW_DURATIONS.map(
        (h) =>
          `<button class="st-btn" data-stew="go" data-h="${h}">${t('{h} ч', { h: String(h) })}</button>`,
      ).join('') +
      `</div>` +
      `<div class="st-note">${
        stewPosture === 'active_defend'
          ? t(
              'Активная оборона: всё то же, плюс контрудар по врагу у своих миров при приемлемом прогнозе потерь (до 35%) и дежурные вылеты эскадрилий. Свою территорию не покидает.',
            )
          : t(
              'Поза «Оборона»: держит и отбивает, застраивает очередь, торгует — без наступлений и дипломатии. Управление вернётся автоматически, с утренней сводкой.',
            )
      }</div>`;
  }
  html += stewLogHtml();
  body.innerHTML = html;
}
document.getElementById('rail-steward')?.addEventListener('click', () => {
  stewWin.classList.add('show');
  renderSteward();
  maybeIntro('steward');
});
stewWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'steward' || tg.classList.contains('tw-close')) {
    stewWin.classList.remove('show');
    return;
  }
  const btn = tg.closest('[data-stew]') as HTMLElement | null;
  if (!btn) return;
  const kind = btn.dataset.stew;
  if (kind === 'posture') {
    stewPosture = btn.dataset.p === 'active_defend' ? 'active_defend' : 'defend';
  } else if (kind === 'go') {
    const h = Number(btn.dataset.h) || 8;
    playerOrder(delegateSteward(ME, s.time + h * HOUR, stewPosture));
  } else if (kind === 'recall') {
    playerOrder(recallSteward(ME));
  } else if (kind === 'tech') {
    stewWin.classList.remove('show');
    techWin.classList.add('show');
    renderTech();
    return;
  }
  renderSteward();
});

// --- heroes («штаб героев»): the CORE hero engine over the inline catalogs -----
// One window for the whole hero loop: deploy reserves (`hero.spawn`), cast abilities
// (`hero.ability` — built-ins live, typed-but-unwired honestly say «скоро»), walk the
// skill tree (`hero.skill.unlock`) and install fittings (`hero.fit`). All gates
// (range/cooldown/cost/slots/branch) are the core's — the window only shows them.
const HERO_ACTIVE_CAP = 3; // mirrors the core heroModule's active cap (not exported)
const HERO_BRANCH_RU: Record<string, string> = { transhuman: 'трансгуман', psionic: 'псионик' };
/** The cooldown slot an ability occupies — mirrors the core's `cooldownKey`. */
const heroCdKey = (type: string): string =>
  type === 'temp_lane' ? 'path' : type === 'annihilate' ? 'annihilate' : `fx:${type}`;
// Ability types the prototype kernel can actually resolve: the two heroModule
// built-ins + every `hero.effect.<type>` the kernel's MODULES provide (heroEffects →
// recall/aura/reveal). Types not here have no engine effect yet → the «скоро» badge.
const HERO_CASTABLE = new Set(['temp_lane', 'annihilate', 'recall', 'aura', 'reveal']);
/** The hero-roster body HTML (roster cards + abilities + skill tree + fittings). Rendered
 *  inside the constructor's «Герои» pane; hero actions are routed by the constructor. */
function heroBodyHtml(): string {
  const mine = Object.values(s.heroes ?? {}).filter((h) => h.owner === ME);
  const active = mine.filter((h) => h.alive !== false && h.fleetId && s.fleets[h.fleetId]).length;
  let html = `<div class="hx-note">${t('Развёрнуто {a}/{cap}. Герой действует со своего корабля; резерв разворачивается на своём мире (перки открывают свой флот / мир союзника).', { a: active, cap: HERO_ACTIVE_CAP })}</div>`;
  for (const h of mine) {
    const def = h.archetype !== undefined ? data.heroes[h.archetype] : undefined;
    const dead = h.alive === false;
    const fleet = !dead && h.fleetId !== undefined ? s.fleets[h.fleetId] : undefined;
    const status = dead
      ? `<span class="hx-badge cd">${t('погиб')}</span>`
      : fleet
        ? `<span class="hx-badge on">⚓ ${esc(typeof fleet.location === 'string' ? fleet.location : t('в пути'))}</span>`
        : `<span class="hx-badge">${t('резерв · {at}', { at: esc(h.location ?? '') })}</span>`;
    html +=
      `<div class="hx-card${dead ? ' dead' : ''}">` +
      `<div style="display:flex;align-items:center;gap:8px;"><div class="hx-grow">` +
      `<div class="hx-name">♔ ${esc(h.name ?? h.id)}</div>` +
      `<div class="hx-sub">${esc(t(def?.name ?? h.archetype ?? ''))}${def?.branch ? ' · ' + t(HERO_BRANCH_RU[def.branch] ?? def.branch) : ''}</div>` +
      `</div>${status}` +
      (!dead && !fleet
        ? `<button class="hx-btn" data-hspawn="${h.id}" ${active >= HERO_ACTIVE_CAP ? 'disabled' : ''}>${t('Развернуть')}</button>`
        : '') +
      `</div>`;
    // abilities — the hero's data-driven loadout
    const abilities = h.abilities ?? [];
    if (abilities.length) {
      html += `<div class="hx-h">${t('Способности')}</div>`;
      for (const ab of abilities) {
        const ad = ab !== null ? data.heroAbilities[ab] : undefined;
        if (ab === null || !ad) continue;
        const cdLeft = Math.max(0, (h.cooldowns?.[heroCdKey(ad.type)] ?? 0) - s.time);
        const action = ad.type.startsWith('spawn_')
          ? `<span class="hx-badge">${t('перк развёртывания')}</span>`
          : cdLeft > 0
            ? `<span class="hx-badge cd">${t('КД {h}', { h: fmtHrs(cdLeft / HOUR) })}</span>`
            : HERO_CASTABLE.has(ad.type)
              ? `<button class="hx-btn" data-hcast="${h.id}" data-ab="${ab}" ${dead ? 'disabled' : ''}>${(ad.range ?? 0) > 0 ? t('Цель…') : t('Активировать')}</button>`
              : `<span class="hx-badge">${t('скоро')}</span>`;
        html +=
          `<div class="hx-row"><div class="hx-grow"><span class="hx-an">${esc(t(ad.name))}</span>` +
          `<div class="hx-note">${esc(t(ad.description ?? ''))}</div></div>${action}</div>`;
      }
    }
    // skill tree — common nodes + the hero's own branch
    const nodes = Object.entries(data.heroSkillTrees).filter(
      ([, nd]) => nd.branch === undefined || nd.branch === def?.branch,
    );
    if (nodes.length) {
      const skills = h.skills ?? [];
      html += `<div class="hx-h">${t('Дерево скиллов')}</div>`;
      for (const [nid, nd] of nodes) {
        const action = skills.includes(nid)
          ? `<span class="hx-badge on">✓ ${t('изучено')}</span>`
          : !nd.requires.every((r) => skills.includes(r))
            ? `<span class="hx-badge">🔒 ${t('нужен пред. узел')}</span>`
            : `<button class="hx-btn" data-hskill="${h.id}" data-node="${nid}" ${dead || !afford(nd.cost) ? 'disabled' : ''}>${esc(cost(nd.cost))}</button>`;
        html +=
          `<div class="hx-row"><div class="hx-grow"><span class="hx-an">${esc(t(nd.name))}</span>` +
          `<div class="hx-note">${esc(t(nd.description ?? ''))}</div></div>${action}</div>`;
      }
    }
    // fittings — the archetype's slot budget, locked in for good (no refit)
    const slots = def?.slots ?? 0;
    if (slots > 0) {
      const fitted = h.fittings ?? [];
      html += `<div class="hx-h">${t('Фиттинги · {u}/{n}', { u: fitted.length, n: slots })}</div>`;
      for (const [fid, fd] of Object.entries(data.heroFittings)) {
        const action = fitted.includes(fid)
          ? `<span class="hx-badge on">✓ ${t('установлен')}</span>`
          : fitted.length >= slots
            ? `<span class="hx-badge">${t('нет слотов')}</span>`
            : `<button class="hx-btn" data-hfit="${h.id}" data-fit="${fid}" ${dead || !afford(fd.cost) ? 'disabled' : ''}>${esc(cost(fd.cost))}</button>`;
        html +=
          `<div class="hx-row"><div class="hx-grow"><span class="hx-an">${esc(t(fd.name))}</span>` +
          `<div class="hx-note">${esc(t(fd.description ?? ''))}</div></div>${action}</div>`;
      }
    }
    html += `</div>`;
  }
  return html;
}

// --- session market: a two-sided order book, one tab per tradeable good -------
// Sell lots (asks) and buy lots (bids) per resource; place your own, take a rival's.
// The whole box is rendered from JS (like #diplo) so each tab re-renders in place.
type MarketGood = 'metal' | 'food' | 'energy' | 'microelectronics';
const MARKET_RES: Array<{ key: MarketGood; label: string }> = [
  { key: 'metal', label: 'Металл' },
  { key: 'food', label: 'Пища' },
  { key: 'energy', label: 'Энергия' },
  { key: 'microelectronics', label: 'Микро' },
];
let marketTab: MarketGood = 'metal';
let marketFormSide: 'sell' | 'buy' = 'sell';
const marketWin = $('market');
function renderMarket(): void {
  const res = (s.players[ME]?.resources ?? {}) as Record<string, number>;
  const good = marketTab;
  const glyph = TECH_CUR[good] ?? '';
  const nameOf = (id: string): string => esc(s.players[id]?.name ?? id);
  const lots = marketLots(s);
  const asks = lots
    .filter((l) => l.side === 'sell' && l.resource === good)
    .sort((a, b) => a.price - b.price);
  const bids = lots
    .filter((l) => l.side === 'buy' && l.resource === good)
    .sort((a, b) => b.price - a.price);
  const lotRow = (l: (typeof lots)[number], bid: boolean): string => {
    const mine = l.owner === ME;
    // ECON-4: получатель кредитов получает net (5% сгорает) — в биде это исполнитель.
    const takerNet = Math.floor(l.amount * l.price * (1 - MARKET_FEE));
    const qp = `<span class="mk-qp"><b>${l.amount}</b> ${TECH_CUR[l.resource] ?? ''} @ ${l.price} ¤${
      bid && !mine ? ` <span class="mk-net">→ ${takerNet} ¤</span>` : ''
    }</span>`;
    const who = `<span class="mk-who">${mine ? t('ваш лот') : nameOf(l.owner)}</span>`;
    let btn: string;
    if (mine) {
      btn = `<button class="mk-btn cancel" data-mkcancel="${l.id}">${t('Отменить')}</button>`;
    } else {
      const can = l.side === 'sell' ? (res.credits ?? 0) >= l.price : (res[l.resource] ?? 0) >= 1;
      btn = `<button class="mk-btn" data-mktake="${l.id}"${can ? '' : ' disabled'}>${l.side === 'sell' ? t('Купить') : t('Продать')}</button>`;
    }
    return `<div class="mk-row ${bid ? 'buy' : ''}">${qp}${who}${btn}</div>`;
  };
  const seg = (side: 'sell' | 'buy', label: string): string =>
    `<button class="${marketFormSide === side ? 'on' : ''}" data-mkside="${side}">${label}</button>`;
  const tabBtn = (k: string, label: string): string =>
    `<button class="mk-tab${marketTab === k ? ' on' : ''}" data-mtab="${k}">${label}</button>`;
  const stock =
    `<div class="mk-lbl" style="margin-bottom:8px">${t('В казне')}: ${glyph} <b style="color:var(--ink)">${Math.round(res[good] ?? 0)}</b>` +
    ` · ¤ <b style="color:var(--ink)">${Math.round(res.credits ?? 0)}</b></div>`;
  const form =
    `<div class="mk-form"><div class="mk-seg">${seg('sell', t('Продать'))}${seg('buy', t('Купить'))}</div>` +
    `<span class="mk-lbl">${t('кол-во')}</span><input class="mk-in" id="mk-amt" type="number" min="1" value="10">` +
    `<span class="mk-lbl">${t('цена')}</span><input class="mk-in" id="mk-price" type="number" min="0" value="3">` +
    `<button class="mk-go" data-mkgo>${t('Выставить')}</button></div>` +
    `<div class="mk-lbl" id="mk-net"></div>`;
  const askList = asks.length
    ? asks.map((l) => lotRow(l, false)).join('')
    : `<div class="mk-empty">${t('Нет лотов на продажу')}</div>`;
  const bidList = bids.length
    ? bids.map((l) => lotRow(l, true)).join('')
    : `<div class="mk-empty">${t('Нет лотов на покупку')}</div>`;
  marketWin.innerHTML =
    `<div class="mkbox"><div class="lw-head"><b>${t('РЫНОК')}</b><button class="mk-close" style="margin-left:auto">✕</button></div>` +
    `<div class="mk-tabs">${MARKET_RES.map((r) => tabBtn(r.key, t(r.label))).join('')}</div>` +
    `<div id="marketbody">${stock}${form}` +
    `<div class="mk-sec">${t('Продажа')} · ${asks.length}</div>${askList}` +
    `<div class="mk-sec buy">${t('Покупка')} · ${bids.length}</div>${bidList}</div></div>`;
  // ECON-4: живой «к получению» под формой — net после комиссии для стороны,
  // которая получит кредиты (sell-лот: вы, когда его исполнят; buy-бид: эскроу).
  const updNet = (): void => {
    const el = document.getElementById('mk-net');
    if (!el) return;
    const amt = Number((document.getElementById('mk-amt') as HTMLInputElement | null)?.value) || 0;
    const price =
      Number((document.getElementById('mk-price') as HTMLInputElement | null)?.value) || 0;
    const gross = amt * price;
    el.textContent =
      marketFormSide === 'sell'
        ? t('к получению после комиссии {p}%: {n} ¤', {
            p: Math.round(MARKET_FEE * 100),
            n: Math.floor(gross * (1 - MARKET_FEE)),
          })
        : t('в эскроу уйдёт {n} ¤ · комиссию {p}% платит получатель кредитов', {
            n: Math.ceil(gross),
            p: Math.round(MARKET_FEE * 100),
          });
  };
  updNet();
  document.getElementById('mk-amt')?.addEventListener('input', updNet);
  document.getElementById('mk-price')?.addEventListener('input', updNet);
}
document.getElementById('rail-market')?.addEventListener('click', () => {
  marketWin.classList.add('show');
  renderMarket();
  maybeIntro('market');
});
marketWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'market' || tg.closest('.mk-close')) {
    marketWin.classList.remove('show');
    return;
  }
  const tab = (tg.closest('.mk-tab') as HTMLElement | null)?.dataset.mtab;
  if (tab) {
    marketTab = tab as MarketGood;
    renderMarket();
    return;
  }
  const side = (tg.closest('.mk-seg button') as HTMLElement | null)?.dataset.mkside;
  if (side) {
    marketFormSide = side as 'sell' | 'buy';
    renderMarket();
    return;
  }
  if (tg.closest('[data-mkgo]')) {
    const amt = Math.floor(Number(($('mk-amt') as HTMLInputElement).value) || 0);
    const price = Math.max(0, Number(($('mk-price') as HTMLInputElement).value) || 0);
    if (amt > 0) playerOrder(marketList(ME, marketFormSide, marketTab, amt, price));
    renderMarket();
    return;
  }
  const takeId = (tg.closest('[data-mktake]') as HTMLElement | null)?.dataset.mktake;
  if (takeId) {
    playerOrder(marketTake(ME, takeId));
    renderMarket();
    return;
  }
  const cancelId = (tg.closest('[data-mkcancel]') as HTMLElement | null)?.dataset.mkcancel;
  if (cancelId) {
    playerOrder(marketCancel(ME, cancelId));
    renderMarket();
  }
});

// --- constructor («Верфь»): the unified loadout tab --------------------------
// One in-match screen that switches between the loadout constructors (ships now;
// squadrons / army / heroes fold in next). The «Корабли» pane renders the shared
// @void/client `loadoutEditor` view-model — typed slots + live derived-stats + cost —
// and confirms into `unit.build{modules}` (the core validates/prices/stamps the set).
const constructorWin = $('constructor');
type ConTab = 'ships' | 'squads' | 'army' | 'heroes';
let conTab: ConTab = 'ships';
const CON_TABS: [ConTab, string][] = [
  ['ships', 'Корабли'],
  ['squads', 'Эскадрильи'],
  ['army', 'Армия'],
  ['heroes', 'Герои'],
];
// Buildable space hulls the «Корабли» pane fits; squadron/carrier hulls → the «Эскадрильи» pane.
const CON_HULLS = ['cruiser', 'siege', 'scout', 'dropship'];
const CON_SQUAD_HULLS = ['fighter_squadron', 'strike_carrier'];
let conHull = 'cruiser';
let conTplIdx = 0; // which division template the «Армия» pane is editing
let conModules: string[] = [];
let conCount = 1;
let conPlanet = '';
const SLOT_RU: Record<string, string> = { weapon: 'Оружие', defense: 'Защита', utility: 'Система' };
const SLOT_ICON: Record<string, string> = { weapon: '🎯', defense: '🛡', utility: '⊞' };
const MODULE_ICON: Record<string, string> = {
  targeting_array: '🎯',
  shield_booster: '🛡',
  ablative_plating: '🧱',
  ion_engine: '🚀',
  radar_module: '📡',
  cargo_bay: '📦',
};
const RES_RU: Record<string, string> = {
  metal: 'металла',
  credits: 'кредитов',
  energy: 'энергии',
  food: 'еды',
  microelectronics: 'микроэлектроники',
};
// Short stat labels for module-effect chips («+4 атака», «+15 щит»).
const STAT_RU: Record<string, string> = {
  attack: 'атака',
  defense: 'оборона',
  hp: 'корпус',
  shield: 'щит',
  speed: 'скорость',
  cargoCapacity: 'трюм',
  radarRange: 'радар',
};
function bagRu(bag: Record<string, number>): string {
  const parts = Object.entries(bag)
    .filter(([, n]) => n)
    .map(([r, n]) => `${Math.round(n)} ${t(RES_RU[r] ?? r)}`);
  return parts.length ? parts.join(' · ') : t('бесплатно');
}
function myRes(): Record<string, number> {
  return (s.players[ME]?.resources ?? {}) as Record<string, number>;
}
/** One live stat row: label · base → effective (+delta) · track bar (base cyan, delta green). */
function conBar(
  line: { label: string; base: number; effective: number; delta: number },
  max: number,
): string {
  const basePct = max > 0 ? Math.min(100, (line.base / max) * 100) : 0;
  const deltaPct = max > 0 ? Math.min(100 - basePct, (Math.max(0, line.delta) / max) * 100) : 0;
  const val =
    line.delta !== 0
      ? `${line.base} <span class="dim">→</span> <b>${line.effective}</b> <span class="cn-up">${line.delta > 0 ? '+' : ''}${line.delta}</span>`
      : `<b>${line.effective}</b>`;
  return (
    `<div class="cn-stat"><div class="cn-srow"><span class="cn-snm">${esc(line.label)}</span><span class="cn-sval">${val}</span></div>` +
    `<div class="cn-strack"><span class="cn-sbar" style="width:${basePct}%"></span><span class="cn-sdelta" style="width:${deltaPct}%"></span></div></div>`
  );
}
/** The loadout constructor pane for a family of hulls (ships or squadrons) — same
 *  `loadoutEditor` view-model, just a different hull list. Resets the draft when the
 *  selected hull isn't in this family (a tab switch). */
/** LARS-4 — a small "откуда" tag for a Верфь card, from whatever the hub Arsenal
 *  witryna has cached (best-effort: blank if the player never opened that tab this
 *  session, never a guess). Only flags a NON-starter origin — a starter blueprint
 *  sitting in every match isn't news; a fresh drop/craft/auction pickup is. */
function conOriginTag(defId: string): string {
  const origin = originOf(arsenalItems, defId);
  if (!origin || origin === 'starter') return '';
  return `<span class="cn-mo">${t(ARSENAL_ORIGIN_RU[origin])}</span>`;
}
function conLoadoutPane(hullList: string[]): string {
  // ARS-5: the constructor offers only what the match's arsenal snapshot (ARS-3)
  // says the player owns — the same `Player.arsenal` the core build gate reads, so
  // the palette can never promise a build the server would then reject. No snapshot
  // (regular/dev match, bots) ⇒ unrestricted, mirroring the core's own degradation.
  const snap = s.players[ME]?.arsenal;
  const ownedHulls = snap ? hullList.filter((h) => snap.hulls.includes(h)) : hullList;
  const ownedModules = snap ? new Set(snap.modules) : undefined;
  if (!ownedHulls.length)
    return `<div class="cn-soon">${t('В арсенале нет корпусов этого класса.')}</div>`;
  if (!ownedHulls.includes(conHull)) {
    conHull = ownedHulls[0]!;
    conModules = [];
  }
  const ed: LoadoutEditorResult = createLoadoutEditor(conHull, data, myRes(), {
    modules: conModules,
    count: conCount,
    ownedModules,
  });
  if (!ed.ok) return `<div class="cn-soon">${t('Корпус недоступен.')}</div>`;
  const m: LoadoutModel = ed;
  const hulls = ownedHulls
    .map(
      (h) =>
        `<button class="cn-hbtn${h === conHull ? ' on' : ''}" data-cnhull="${h}">${UNIT_ICON[h] ?? '▲'} ${esc(displayUnit(h))}</button>`,
    )
    .join('');
  const freeTypes = [...new Set(m.slots.filter((sl) => !sl.moduleId).map((sl) => sl.type))];
  const hullCard =
    `<div class="cn-hull"><div class="cn-hic">${UNIT_ICON[conHull] ?? '▲'}</div><div><div class="cn-hn">${esc(displayUnit(conHull))}</div>` +
    `<div class="cn-hm">${t('{n} слота под модули (по размеру корпуса)', { n: String(m.slots.length) })}</div></div></div>`;
  const bays = m.slots
    .map((sl) => {
      if (sl.moduleId) {
        const md = data.modules[sl.moduleId];
        const eff = md
          ? Object.entries(md.effects.stats)
              .map(([k, v]) => `+${v} ${t(STAT_RU[k] ?? k)}`)
              .join(' ')
          : '';
        return (
          `<div class="cn-bay filled" data-cnun="${sl.moduleId}" title="${t('снять модуль')}"><div class="cn-bic">${MODULE_ICON[sl.moduleId] ?? '▪'}</div>` +
          `<div><div class="cn-bt">${t(SLOT_RU[sl.type])}</div><div class="cn-bn">${esc(tData(sl.moduleName ?? sl.moduleId))}${conOriginTag(sl.moduleId)}</div></div><div class="cn-bd">${eff}</div></div>`
        );
      }
      return (
        `<div class="cn-bay empty"><div class="cn-bic">${SLOT_ICON[sl.type] ?? '＋'}</div>` +
        `<div><div class="cn-bt">${t(SLOT_RU[sl.type])}</div><div class="cn-bn">${t('пусто — выбери модуль')}</div></div></div>`
      );
    })
    .join('');
  const palette = m.palette
    .map((o) => {
      const eff = Object.entries(o.effect)
        .map(([k, v]) => `+${v} ${t(STAT_RU[k] ?? k)}`)
        .join(' ');
      if (o.installable) {
        return (
          `<button class="cn-mod" data-cnmod="${o.id}"><span class="cn-mic">${MODULE_ICON[o.id] ?? '▪'}</span>` +
          `<span class="cn-mn">${esc(tData(o.name))}${conOriginTag(o.id)}</span><span class="cn-me">${eff}</span><span class="cn-mc">${bagRu(o.cost)}</span></button>`
        );
      }
      return (
        `<div class="cn-mod locked"><span class="cn-mic">${MODULE_ICON[o.id] ?? '▪'}</span>` +
        `<span class="cn-mn">${esc(tData(o.name))}</span><span class="cn-me">${t('слот «{s}»', { s: t(SLOT_RU[o.slot]) })}</span><span class="cn-mc">${bagRu(o.cost)}</span></div>`
      );
    })
    .join('');
  const palHead = freeTypes.length
    ? t('Доступные модули — для слота «{s}»', {
        s: freeTypes.map((ty) => t(SLOT_RU[ty])).join(' / '),
      })
    : t('Доступные модули — все слоты заняты');
  // LARS-4: the palette above already reads the LIVE arsenal snapshot (a module
  // bought mid-match shows up here without a new match) — this note is the only
  // thing that needed adding: make the timing honest (built, not instant).
  const liveNote = snap
    ? `<div class="cn-note">${t('⚡ Арсенал живой: докупленное в матче видно здесь сразу, но начинает работать только когда ты это ПОСТРОИШЬ — постройка и логистика, не мгновенно.')}</div>`
    : '';
  const left =
    `<div class="cn-fit"><div class="cn-hulls">${hulls}</div>${hullCard}${bays}` +
    `<div class="cn-ph">${palHead}</div><div class="cn-pal">${palette}</div>` +
    `<div class="cn-note">${t('Типизированные слоты: модуль встаёт только в свой тип. <b>Серые</b> — не для свободного слота или уже стоят.')}</div>${liveNote}</div>`;
  // right: live preview + cost + build
  const maxStat = Math.max(1, ...m.preview.map((p) => p.effective));
  const bars = m.preview.map((p) => conBar(p, maxStat)).join('');
  const owned = Object.values(s.planets).filter(
    (p) => p.owner === ME && SECTOR_TYPES[p.kind ?? '']?.buildable,
  );
  if (!conPlanet || !owned.some((p) => p.id === conPlanet)) conPlanet = owned[0]?.id ?? '';
  const planOpts = owned
    .map(
      (p) =>
        `<option value="${p.id}"${p.id === conPlanet ? ' selected' : ''}>${esc(p.id)}</option>`,
    )
    .join('');
  const cost =
    `<div class="cn-cost">` +
    `<div class="cn-crow"><span class="cn-cl">${t('Корпус ×{n}', { n: String(m.count) })}</span><span class="cn-cv">${bagRu(m.hullCost)}</span></div>` +
    (conModules.length
      ? `<div class="cn-crow"><span class="cn-cl">${t('Модули ×{n}', { n: String(m.count) })}</span><span class="cn-cv">${bagRu(m.modulesCost)}</span></div>`
      : '') +
    `<div class="cn-crow total"><span class="cn-cl">${t('Итого')}</span><span class="cn-cv">${bagRu(m.totalCost)}</span></div></div>`;
  const canBuild = m.affordable && conPlanet !== '';
  const right =
    `<div class="cn-side"><div class="cn-ph">${t('Итог с модулями')} — <em>${t('пересчёт вживую')}</em></div>${bars}${cost}` +
    `<div class="cn-row2"><div class="cn-step"><button data-cncount="-" ${conCount <= 1 ? 'disabled' : ''}>−</button><span class="cn-sv">${conCount}</span><button data-cncount="+" ${conCount >= 20 ? 'disabled' : ''}>+</button></div>` +
    `<select class="cn-plan" id="cn-planet"${owned.length ? '' : ' disabled'}>${planOpts || `<option>${t('нет своих миров')}</option>`}</select></div>` +
    `<button class="cn-build" data-cnbuild ${canBuild ? '' : 'disabled'}>${t('Построить ×{n} →', { n: String(conCount) })}</button>` +
    `<div class="cn-lock">🔒 <span>${t('Лоадаут фиксируется при постройке. Готовый корабль не переоснастить — только построить новый с другим набором.')}</span></div></div>`;
  return `<div class="cn-grid">${left}${right}</div>`;
}
function conSoonPane(what: string): string {
  return `<div class="cn-soon"><div class="cn-si">🚧</div>${t('«{what}» переезжает в конструктор следующим кирпичом.', { what })}</div>`;
}
/** The «Армия» pane: edit a division template's 6 slots (per-player, global). Live
 *  aggregate stats + synergies; mobilisation stays in the planet panel. */
function conArmyPane(): string {
  const tpls = templatesOf(s, ME);
  if (!tpls.length) return `<div class="cn-soon">${t('Нет шаблонов.')}</div>`;
  const idx = Math.max(0, Math.min(conTplIdx, tpls.length - 1));
  const tpl = tpls[idx]!;
  const tabs = tpls
    .map(
      (tp, i) =>
        `<button class="cn-hbtn${i === idx ? ' on' : ''}" data-contpl="${i}">⚔ ${esc(tp.name)}</button>`,
    )
    .join('');
  const f = formationStats(tpl);
  const slots = tpl.slots
    .map((u, i) => {
      const inner = u
        ? `<span class="cn-fic">${formIcon(u)}</span><span class="cn-fn">${esc(FORM_RU[u] ?? u)}</span>`
        : `<span class="cn-fic dim">＋</span><span class="cn-fn dim">${t('пусто')}</span>`;
      return `<button class="cn-fslot${u ? ' filled' : ''}" data-confslot="${idx}|${i}">${inner}</button>`;
    })
    .join('');
  const card =
    `<div class="cn-hull"><div class="cn-hic">⚔</div><div><div class="cn-hn">${esc(tpl.name)}</div>` +
    `<div class="cn-hm">${t('{n}/{s} юнитов · тапни слот, чтобы менять род войск', { n: String(f.count), s: String(FORMATION_SLOTS) })}</div></div></div>`;
  const left =
    `<div class="cn-fit"><div class="cn-hulls">${tabs}</div>${card}<div class="cn-fgrid">${slots}</div>` +
    `<div class="cn-note">${t('Тап по слоту: пусто → пехота → танк. Мобилизация дивизии — в панели своего мира (вкладка «Дивизии»).')}</div></div>`;
  const max = Math.max(1, f.attack, f.defense, f.hp);
  const bars = [
    conBar({ label: t('Атака'), base: f.attack, effective: f.attack, delta: 0 }, max),
    conBar({ label: t('Оборона'), base: f.defense, effective: f.defense, delta: 0 }, max),
    conBar({ label: t('Корпус'), base: f.hp, effective: f.hp, delta: 0 }, max),
  ].join('');
  const syn = f.synergies.length
    ? `<div class="cn-ph" style="margin-top:14px">${t('Доктрина состава')}</div>` +
      f.synergies.map((x) => `<div class="cn-syn">✦ ${esc(t(x.name))}</div>`).join('')
    : `<div class="cn-note" style="margin-top:12px">${t('Смешай рода войск — состав задаёт доктрину.')}</div>`;
  const cost =
    `<div class="cn-cost"><div class="cn-crow total"><span class="cn-cl">${t('Стоимость мобилизации')}</span>` +
    `<span class="cn-cv">${bagRu(f.cost)}</span></div></div>`;
  const right = `<div class="cn-side"><div class="cn-ph">${t('Итог по формации')} — <em>${t('пересчёт вживую')}</em></div>${bars}${syn}${cost}</div>`;
  return `<div class="cn-grid">${left}${right}</div>`;
}
/** The «Герои» pane: the hero roster/штаб (folded from the old #hero window). The
 *  `#herobody` id keeps the `.hx-*` styling; hero clicks route via the constructor. */
function conHeroPane(): string {
  return `<div id="herobody">${heroBodyHtml()}</div>`;
}
function renderConstructor(): void {
  const tabBtn = (k: ConTab, label: string) =>
    `<button class="cn-tab${conTab === k ? ' on' : ''}" data-ctab="${k}">${t(label)}</button>`;
  const body =
    conTab === 'ships'
      ? conLoadoutPane(CON_HULLS)
      : conTab === 'squads'
        ? conLoadoutPane(CON_SQUAD_HULLS)
        : conTab === 'army'
          ? conArmyPane()
          : conHeroPane();
  constructorWin.innerHTML =
    `<div class="cnbox"><div class="cn-head"><b>${t('КОНСТРУКТОР')}</b><button class="cn-close">✕</button></div>` +
    `<div class="cn-tabs">${CON_TABS.map(([k, l]) => tabBtn(k, l)).join('')}</div>` +
    `<div id="constructorbody">${body}</div></div>`;
}
/** Equip / unequip a module through the core-validated reducer, then re-render. */
function conFit(moduleId: string, remove: boolean): void {
  const snap = s.players[ME]?.arsenal;
  const ed = createLoadoutEditor(conHull, data, myRes(), {
    modules: conModules,
    count: conCount,
    ownedModules: snap ? new Set(snap.modules) : undefined,
  });
  if (!ed.ok) return;
  const r = applyLoadoutAction({ kind: remove ? 'unequip' : 'equip', moduleId }, ed, data, myRes());
  if (r.ok) conModules = r.modules;
  else note('✖ ' + errText(r.code));
}
document.getElementById('rail-constructor')?.addEventListener('click', () => {
  constructorWin.classList.add('show');
  renderConstructor();
  maybeIntro('constructor');
});
constructorWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.id === 'constructor' || tg.closest('.cn-close')) {
    constructorWin.classList.remove('show');
    return;
  }
  const tab = (tg.closest('.cn-tab') as HTMLElement | null)?.dataset.ctab;
  if (tab) {
    conTab = tab as ConTab;
    renderConstructor();
    return;
  }
  const hull = (tg.closest('.cn-hbtn') as HTMLElement | null)?.dataset.cnhull;
  if (hull) {
    conHull = hull;
    conModules = []; // a fresh draft per hull (its slot types differ)
    renderConstructor();
    return;
  }
  const mod = (tg.closest('.cn-mod') as HTMLElement | null)?.dataset.cnmod;
  if (mod) {
    conFit(mod, false);
    renderConstructor();
    return;
  }
  const un = (tg.closest('.cn-bay.filled') as HTMLElement | null)?.dataset.cnun;
  if (un) {
    conFit(un, true);
    renderConstructor();
    return;
  }
  const step = (tg.closest('[data-cncount]') as HTMLElement | null)?.dataset.cncount;
  if (step) {
    conCount = Math.max(1, Math.min(20, conCount + (step === '+' ? 1 : -1)));
    renderConstructor();
    return;
  }
  const tpl = (tg.closest('[data-contpl]') as HTMLElement | null)?.dataset.contpl;
  if (tpl !== undefined) {
    conTplIdx = Number(tpl);
    renderConstructor();
    return;
  }
  const fslot = (tg.closest('[data-confslot]') as HTMLElement | null)?.dataset.confslot;
  if (fslot) {
    const [ti, si] = fslot.split('|').map(Number);
    const cur = templatesOf(s, ME)[ti!]?.slots[si!] ?? null;
    const order: (string | null)[] = [null, ...FORMATION_UNITS];
    const next = order[(order.indexOf(cur) + 1) % order.length] ?? null;
    playerOrder(setDivisionTemplate(ME, ti!, si!, next));
    renderConstructor();
    return;
  }
  // --- «Герои» pane actions (folded from the old #hero window) ---
  const castBtn = tg.closest('[data-hcast]') as HTMLElement | null;
  if (castBtn) {
    const heroId = castBtn.dataset.hcast!;
    const abilityId = castBtn.dataset.ab!;
    if ((data.heroAbilities[abilityId]?.range ?? 0) > 0) {
      heroAim = { heroId, abilityId }; // ranged cast → arm the map (next world tap is the target)
      constructorWin.classList.remove('show');
      note(t('✨ выберите мир-цель на карте'));
    } else {
      playerOrder(castHeroAbility(ME, heroId, abilityId));
      renderConstructor();
    }
    return;
  }
  const spawnBtn = tg.closest('[data-hspawn]') as HTMLElement | null;
  if (spawnBtn) {
    heroSpawnAim = spawnBtn.dataset.hspawn!;
    constructorWin.classList.remove('show');
    const hero = s.heroes?.[heroSpawnAim];
    const perks = (hero?.abilities ?? []).map((a) =>
      a !== null ? data.heroAbilities[a]?.type : undefined,
    );
    note(
      t('⚓ выберите свой мир{fl}{al} — там поднимется корабль героя', {
        fl: perks.includes('spawn_fleet') ? t(' / свой флот') : '',
        al: perks.includes('spawn_allied') ? t(' / мир союзника') : '',
      }),
    );
    return;
  }
  const skillBtn = tg.closest('[data-hskill]') as HTMLElement | null;
  if (skillBtn) {
    playerOrder(unlockHeroSkill(ME, skillBtn.dataset.hskill!, skillBtn.dataset.node!));
    renderConstructor();
    return;
  }
  const fitBtn = tg.closest('[data-hfit]') as HTMLElement | null;
  if (fitBtn) {
    playerOrder(fitHero(ME, fitBtn.dataset.hfit!, fitBtn.dataset.fit!));
    renderConstructor();
    return;
  }
  if (tg.closest('[data-cnbuild]')) {
    if (conPlanet) {
      playerOrder(buildShip(ME, conPlanet, conHull, conCount, conModules));
      note(t('⚒ заказано: {n}× {hull}', { n: String(conCount), hull: displayUnit(conHull) }));
    }
    return;
  }
});
constructorWin.addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  if (sel.id === 'cn-planet') conPlanet = sel.value;
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

// Local skirmish + dev test mode are DEV-CLIENT features: the player build compiles
// them out (and build.mjs strips their buttons/markup), so a regular player's client
// has no single-player entry and no test overlay at all.
if (!__PLAYER_BUILD__) {
  $('csolo').addEventListener('click', () => {
    userClosed = true; // intentional leave → don't auto-reconnect
    NET = false;
    openSetup(); // pick start + rivals before the skirmish begins
  });

  // DEV TEST MODE — fenced hook. The "Тесты" button opens the dev test overlay;
  // initTestMode wires it to the host with two tiny callbacks. Cut this whole block
  // (and the import + #testmode HTML/CSS) to remove the feature without a trace.
  // The dev client hides the button behind `?dev` / vd.dev (dev chrome).
  if (!DEV_UI) $('ctest').style.display = 'none';
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
}

// --- welcome stage: first-launch identity screen → match browser ------------
// The entry overlay opens on a clean welcome (new commander / sign-in / single-
// player); "Новый командир" and "Вход" reveal the match browser (stage 2). Social
// sign-in is a styled stub until accounts land (docs/accounts-roadmap.md AC-1.1):
// it drops you straight into guest play by callsign, with a "скоро" notice.
const welcomeStageEl = $('cwelcome');
const registerStageEl = $('cregister');
const recoverStageEl = $('crecover');
const resetStageEl = $('creset');
const browseStageEl = $('cbrowse');
function showStage(stage: 'welcome' | 'register' | 'recover' | 'reset' | 'browse'): void {
  welcomeStageEl.style.display = stage === 'welcome' ? '' : 'none';
  registerStageEl.style.display = stage === 'register' ? '' : 'none';
  recoverStageEl.style.display = stage === 'recover' ? '' : 'none';
  resetStageEl.style.display = stage === 'reset' ? '' : 'none';
  browseStageEl.style.display = stage === 'browse' ? '' : 'none';
}

// A fresh callsign for a brand-new commander. Deterministic on purpose (no random/
// time even in UI glue): a persisted counter walks a fixed wordlist.
const CALLSIGNS = ['Носорог', 'Комета', 'Гадюка', 'Орион', 'Вектор', 'Сокол', 'Титан', 'Квазар'];
function suggestCallsign(): string {
  const n = (Number(localStorage.getItem('void.newcount') ?? '0') || 0) + 1;
  localStorage.setItem('void.newcount', String(n));
  return `${t(CALLSIGNS[(n - 1) % CALLSIGNS.length]!)}-${n}`;
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
const HUB_PANELS: Record<string, string> = {
  home: 'hp-home',
  rank: 'hp-rank',
  meta: 'hp-meta',
  arsenal: 'hp-arsenal',
  ally: 'hp-ally',
  more: 'hp-more',
};
let currentHubTab = 'home'; // the visible hub panel, so an async XP sync can repaint it
function hubTab(tab: string): void {
  hubNote.textContent = '';
  if (tab === 'games') {
    showHub(false);
    showConnect(true);
    enterBrowse(); // hand off to the existing match browser
    return;
  }
  currentHubTab = tab;
  if (tab === 'meta') renderMetaPanel(); // live numbers every visit (XP may have grown)
  if (tab === 'arsenal') void refreshArsenal(); // cache paints now, server refresh trails
  for (const [k, pid] of Object.entries(HUB_PANELS))
    $(pid).style.display = k === tab ? 'flex' : 'none';
  for (const b of Array.from(document.querySelectorAll('.hub-tab')))
    b.classList.toggle('active', (b as HTMLElement).dataset.hub === tab);
}

// --- «Прокачка» — the commander's meta-progression trees (hub tab) -----------------
// Three straight tracks (командование/экономика/наука); XP comes ONLY from finished
// matches, a node costs its tier in points. Effects are session-start snapshots
// (hidden techs / council level / starting treasury) — see prototype/src/meta.ts.
function renderMetaPanel(): void {
  const el = $('hp-meta');
  const st = loadMeta();
  const lvl = metaLevel(st.xp);
  const [got, need] = metaLevelProgress(st.xp);
  const pts = metaPoints(st);
  let h =
    `<div class="mp-head"><b>${t('Уровень {n}', { n: lvl })}</b>` +
    `<span class="mp-xp">${t('{got}/{need} XP', { got, need })}</span>` +
    `<span class="mp-pts">${t('Очков: {n}', { n: pts })}</span></div>`;
  h += `<div class="mp-track"><div class="mp-fill" style="width:${Math.round((got / need) * 100)}%"></div></div>`;
  for (const branch of ['command', 'economy', 'science'] as MetaBranch[]) {
    h += `<div class="mp-branch"><div class="mp-bt">${t(META_BRANCH_RU[branch])}</div>`;
    for (const node of META_TREE.filter((x) => x.branch === branch)) {
      const owned = st.spent.includes(node.id);
      const can = canUnlock(st, node.id);
      h +=
        `<div class="mp-node ${owned ? 'own' : can ? 'can' : 'lock'}">` +
        `<div class="mp-nm">${owned ? '✓ ' : ''}${esc(t(node.name))} <em>· ${t('{n} очк.', { n: node.tier })}</em></div>` +
        `<div class="mp-ds">${esc(t(node.desc))}</div>` +
        (owned
          ? ''
          : `<button class="mp-buy" data-meta="${node.id}" ${can ? '' : 'disabled'}>${can ? t('Изучить') : t('Закрыто')}</button>`) +
        `</div>`;
    }
    h += `</div>`;
  }
  h += `<p class="mp-note">${t('Опыт даётся за завершённые матчи: участие + счёт + победа. Прокачка не продаётся — только игра.')}</p>`;
  el.innerHTML = h;
}
$('hp-meta').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('[data-meta]') as HTMLElement | null;
  if (!b || (b as HTMLButtonElement).disabled) return;
  const next = unlockNode(loadMeta(), b.dataset.meta!);
  if (next) {
    saveMeta(next);
    renderMetaPanel();
  }
});

// --- «Арсенал» — the account's persistent collection (hub tab, ARS-5) --------
// ARS-1..4 built the server-side store; nothing client-facing read it before this.
// Cache-first (localStorage per callsign, like meta): the tab always paints instantly
// from the last known collection, then a background GET /arsenal/me (session-gated,
// only when a session token from a prior join is already on hand — never prompts for
// a password just to LOOK at the hub) refreshes it. No server/no account yet ⇒ the
// empty state, same "no restriction without a snapshot" spirit as the core build gate.
const ARSENAL_KIND_ICON: Record<ArsenalItem['kind'], string> = {
  hull: '◈',
  module: '◆',
  hero_fitting: '◇',
};
const ARSENAL_CODEX_KIND: Record<ArsenalItem['kind'], string> = {
  hull: 'u',
  module: 'md',
  hero_fitting: 'hf',
};
const ARSENAL_KIND_RU: Record<ArsenalItem['kind'], string> = {
  hull: 'Корпуса',
  module: 'Модули',
  hero_fitting: 'Фитинги',
};
const ARSENAL_ORIGIN_RU: Record<ArsenalItem['origin'], string> = {
  starter: 'стартовый',
  drop: 'дроп',
  craft: 'крафт',
  auction: 'аукцион',
  lootbox: 'лутбокс',
  rent: 'аренда',
};
function arsenalKey(): string {
  return 'vd.arsenal.' + (nickInput.value.trim() || 'guest');
}
function loadArsenalCache(): ArsenalItem[] {
  try {
    return parseArsenalItems(JSON.parse(localStorage.getItem(arsenalKey()) ?? 'null'));
  } catch {
    return [];
  }
}
function saveArsenalCache(items: ArsenalItem[]): void {
  localStorage.setItem(arsenalKey(), JSON.stringify(items));
}
let arsenalItems: ArsenalItem[] = [];
let arsenalFilter: ArsenalFilter = {};
function arsenalItemName(item: ArsenalItem): string {
  if (item.kind === 'hull') return unitDossier(item.defId)?.name ?? displayUnit(item.defId);
  if (item.kind === 'module') return tData(data.modules[item.defId]?.name ?? item.defId);
  return tData(data.heroFittings[item.defId]?.name ?? item.defId);
}
function arsenalCardHtml(item: ArsenalItem): string {
  const badges = [
    item.grade ? `+${item.grade}` : '',
    typeof item.durability === 'number' ? `⛭${item.durability}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const origin = t(ARSENAL_ORIGIN_RU[item.origin]);
  return (
    `<button class="hub-tile ar-card" data-codex="${ARSENAL_CODEX_KIND[item.kind]}:${esc(item.defId)}">` +
    `<span class="ht-ic">${ARSENAL_KIND_ICON[item.kind]}</span><span>${esc(arsenalItemName(item))}</span>` +
    `<span class="ar-meta">${badges ? badges + ' · ' : ''}${origin}</span></button>`
  );
}
function renderArsenalPanel(): void {
  const el = $('hp-arsenal');
  if (arsenalItems.length === 0) {
    el.innerHTML = `<div class="hub-empty"><span class="he-ic">⚔</span>${t('Арсенал пуст')}<br><span style="font-size:11px;color:var(--cyan-dim)">${t('войдите под аккаунтом на сервере с накоплением, чтобы увидеть коллекцию')}</span></div>`;
    return;
  }
  const kinds: Array<ArsenalItem['kind']> = ['hull', 'module', 'hero_fitting'];
  let chips = `<button class="ar-fchip${arsenalFilter.kind ? '' : ' on'}" data-ar-kind="">${t('Всё')}</button>`;
  for (const k of kinds)
    chips += `<button class="ar-fchip${arsenalFilter.kind === k ? ' on' : ''}" data-ar-kind="${k}">${t(ARSENAL_KIND_RU[k])}</button>`;
  const grades = gradesOf(arsenalItems);
  if (grades.length) {
    chips += `<span class="ar-fsep"></span>`;
    for (const g of grades)
      chips += `<button class="ar-fchip${arsenalFilter.grade === g ? ' on' : ''}" data-ar-grade="${g}">+${g}</button>`;
  }
  const cards = filterArsenal(arsenalItems, arsenalFilter).map(arsenalCardHtml).join('');
  el.innerHTML = `<div class="ar-filters">${chips}</div><div class="hub-grid ar-grid">${cards}</div>`;
}
$('hp-arsenal').addEventListener('click', (ev) => {
  const tg = ev.target as HTMLElement;
  const kindBtn = tg.closest('[data-ar-kind]') as HTMLElement | null;
  if (kindBtn) {
    const k = kindBtn.dataset.arKind as ArsenalItem['kind'] | '';
    arsenalFilter = { ...arsenalFilter, kind: k || undefined };
    renderArsenalPanel();
    return;
  }
  const gradeBtn = tg.closest('[data-ar-grade]') as HTMLElement | null;
  if (gradeBtn) {
    const g = Number(gradeBtn.dataset.arGrade);
    arsenalFilter = { ...arsenalFilter, grade: arsenalFilter.grade === g ? undefined : g };
    renderArsenalPanel();
    return;
  }
  const card = tg.closest('[data-codex]') as HTMLElement | null;
  if (card?.dataset.codex) openCodex(card.dataset.codex);
});
/** Cache-first paint, then a best-effort session-gated refresh (never prompts for
 *  a password — only reuses a session token a prior join already stashed). */
async function refreshArsenal(): Promise<void> {
  arsenalItems = loadArsenalCache();
  renderArsenalPanel();
  const srv = resolveServer();
  if (!srv) return;
  await probeAuthMode(srv.base);
  if (!authMode) return;
  const session = sessionToken(srv.base);
  if (!session) return;
  try {
    const res = await fetch(`${httpBase(srv.base)}/arsenal/me`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
    arsenalItems = parseArsenalItems(body?.items);
    saveArsenalCache(arsenalItems);
    renderArsenalPanel();
  } catch {
    // offline/unreachable — the cache painted above stays the source of truth
  }
}
/** Accounts mode (EC-*): pull the DURABLE account XP into the local meta mirror, so
 *  the commander level/progress a player sees is account-backed and follows them to a
 *  new device — not the per-callsign localStorage that only lived in one browser. The
 *  server total is authoritative (it sums every credited match across devices); the
 *  per-match award still lands optimistically at checkEnd (same formula as the core's
 *  `data.rewards`, so they agree). Guest/nick mode has no account → keeps localStorage. */
async function syncCommanderFromServer(): Promise<void> {
  const srv = resolveServer();
  if (!srv) return;
  await probeAuthMode(srv.base);
  if (!authMode) return;
  const session = sessionToken(srv.base);
  if (!session) return;
  try {
    const res = await fetch(`${httpBase(srv.base)}/commander/me`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { xp?: unknown } | null;
    if (typeof body?.xp !== 'number') return;
    const cur = loadMeta();
    // XP only ever grows (accumulated per finished match). Take the max, never a
    // regression: the server is the durable cross-device total, but if this device
    // just awarded a match optimistically and the server hasn't credited it yet, we
    // must NOT drop below the local figure. Both converge once the credit lands.
    const total = Math.max(cur.xp, body.xp);
    if (total !== cur.xp) {
      saveMeta({ ...cur, xp: total }); // local `spent` tree is kept
      // repaint the open hub panel so the new level/points show without a manual switch
      if (hubEl.style.display !== 'none' && (currentHubTab === 'home' || currentHubTab === 'meta'))
        hubTab(currentHubTab);
    }
  } catch {
    // offline — the last mirrored total stays; a later login reconciles
  }
}
function openHub(note = ''): void {
  if (!nickInput.value.trim()) nickInput.value = suggestCallsign();
  const nick = nickInput.value.trim();
  $('hub-name').textContent = nick || t('Командир');
  showConnect(false);
  showHub(true);
  hubTab('home');
  hubNote.textContent = note;
  refreshOnboardOffer(); // ONB-0: first-run offer/nudge for a not-yet-onboarded commander
  void syncCommanderFromServer(); // account-backed XP → local mirror (accounts mode only)
}

$('cnew').addEventListener('click', () => {
  // «Новый командир» → the dedicated registration PAGE (its own stage of #connect, no live
  // game behind it): callsign + password + repeat. Awaiting the probe closes the race — a
  // tap before /auth/status answers must not take the guest branch on an accounts server.
  // With accounts OFF (nick-only server) there is no password to set, so a new commander
  // just gets a suggested callsign and drops into the hub.
  void authProbe.then(() => {
    if (authMode) {
      openRegister();
      return;
    }
    openHub();
  });
});
// «Вход по позывному»: reveal an inline field and enter under a callsign YOU type (vs
// «Новый командир», which auto-suggests one). The chosen callsign is remembered
// (`void.nick`) so the next visit auto-recognises you (the first-run gate above).
// With accounts on the server (authMode) the same form carries a password and the
// welcome card itself registers/logs in (registration IS the first login).
const wLoginEl = $('cwlogin');
const wNickInput = $('cwnick') as HTMLInputElement;
const wPassRowEl = $('cwpassrow');
const wPassInput = $('cwpass') as HTMLInputElement;
function signInByCallsign(): void {
  const nick = wNickInput.value.trim();
  if (!nick) {
    statusEl.textContent = t('Введи позывной');
    wNickInput.focus();
    return;
  }
  // Same race guard as «Новый командир»: never pick the guest branch while the
  // /auth/status probe is still in flight.
  void authProbe.then(() => {
    if (authMode) {
      void welcomeSignIn(nick);
      return;
    }
    nickInput.value = nick;
    localStorage.setItem('void.nick', nick); // remembered — next visit skips the welcome card
    openHub();
  });
}
let signingIn = false; // in-flight guard: Enter + click must not double-register
/** Bytro-style welcome sign-in: register-or-login right on the greeting card, then
 *  land on the hub. Reuses ensureSession (login → 401 → register), so a fresh
 *  callsign creates the account and a known one just logs in. */
async function welcomeSignIn(nick: string): Promise<void> {
  if (signingIn) return; // a second Enter/click while the first runs would double-POST
  signingIn = true;
  try {
    wPassRowEl.style.display = 'flex'; // make sure the password is visible before we demand it
    nickInput.value = nick;
    const srv = resolveServer();
    if (!srv) return;
    const session = await ensureSession(srv.base, nick);
    if (!session) {
      wPassInput.focus(); // ensureSession already explained why in the status line
      return;
    }
    localStorage.setItem('void.nick', nick);
    wPassInput.value = ''; // the session JWT is stored instead — a password never lingers
    statusEl.textContent = '';
    openHub();
  } finally {
    signingIn = false;
  }
}
wPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') signInByCallsign();
});
$('clogin').addEventListener('click', () => {
  const show = wLoginEl.style.display === 'none';
  wLoginEl.style.display = show ? 'flex' : 'none';
  statusEl.textContent = '';
  if (show) {
    wNickInput.value = (localStorage.getItem('void.nick') ?? '').trim();
    wNickInput.focus();
  }
});
$('cwgo').addEventListener('click', signInByCallsign);
wNickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') signInByCallsign();
});
$('cgoogle').addEventListener('click', () =>
  openHub(t('Вход через Google — скоро · ты вошёл гостем')),
);
$('capple').addEventListener('click', () =>
  openHub(t('Вход через Apple — скоро · ты вошёл гостем')),
);
$('cback').addEventListener('click', () => {
  showStage('welcome'); // reset #connect's inner stage for next time
  statusEl.textContent = '';
  openHub(); // back from the browser → the hub
});
// Language picker: RU ⇄ EN. The choice persists; a reload rebuilds every renderer
// in the new language (the picker lives on the welcome screen — no match to lose).
$('clang').textContent = LOCALE_LABEL[LOCALE] + ' ▾';
$('clang').addEventListener('click', () => {
  setLocale(LOCALE === 'ru' ? 'en' : 'ru');
  if (typeof location !== 'undefined' && location.reload) location.reload();
});
localizeStaticDom(); // static markup is canonical-Russian; translate it in place
for (const a of Array.from(document.querySelectorAll('.cfoot a'))) {
  a.addEventListener('click', () => {
    statusEl.textContent = t('{what} — скоро', { what: (a.textContent ?? '').trim() });
  });
}

// --- «Новый командир» → dedicated registration page (its own #connect stage) -------
// Callsign + password + repeat, on a page of its own (no live game behind it). Registration
// IS the first login (ensureSession: login → 401 → register), so a fresh callsign creates
// the account. «Восстановить доступ» is a stub until the accounts backend grows a real reset
// (no email on file yet — docs/accounts-roadmap.md).
const crNickInput = $('crnick') as HTMLInputElement;
const crMailInput = $('crmail') as HTMLInputElement;
const crPassInput = $('crpass') as HTMLInputElement;
const crPass2Input = $('crpass2') as HTMLInputElement;
function openRegister(): void {
  showStage('register');
  crNickInput.value = crNickInput.value.trim() || suggestCallsign();
  crPassInput.value = '';
  crPass2Input.value = '';
  statusEl.textContent = '';
  crPassInput.focus();
}
async function submitRegister(): Promise<void> {
  const nick = crNickInput.value.trim();
  const pass = crPassInput.value;
  const email = crMailInput.value.trim();
  if (!nick) {
    statusEl.textContent = t('Введи имя командира');
    crNickInput.focus();
    return;
  }
  if (pass.length < 8) {
    statusEl.textContent = t('Введите пароль (мин. 8 символов)');
    crPassInput.focus();
    return;
  }
  if (pass !== crPass2Input.value) {
    statusEl.textContent = t('Пароли не совпадают');
    crPass2Input.focus();
    return;
  }
  if (signingIn) return; // Enter + click must not double-register
  signingIn = true;
  try {
    const srv = resolveServer();
    if (!srv) return;
    // Email is OPTIONAL — it exists only so the account can be recovered later; skipping it
    // just means no self-service reset. A malformed one is caught by the server (400).
    const session = await ensureSession(srv.base, nick, pass, email || undefined);
    if (!session) {
      crPassInput.focus(); // ensureSession already explained why in the status line
      return;
    }
    localStorage.setItem('void.nick', nick);
    nickInput.value = nick;
    crPassInput.value = '';
    crPass2Input.value = '';
    statusEl.textContent = '';
    openHub();
  } finally {
    signingIn = false;
  }
}
$('crgo').addEventListener('click', () => void submitRegister());
crNickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') crMailInput.focus();
});
crMailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') crPassInput.focus();
});
crPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') crPass2Input.focus();
});
crPass2Input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitRegister();
});
$('crback').addEventListener('click', () => {
  showStage('welcome');
  statusEl.textContent = '';
});

// --- Password recovery: request a reset link (email → /auth/recover) ------------------
// Anti-enumeration mirrors the server: the confirmation is identical whether or not the
// email is on file. «Восстановить доступ» on the registration page opens this stage.
const crecMailInput = $('crecmail') as HTMLInputElement;
async function submitRecover(): Promise<void> {
  const email = crecMailInput.value.trim();
  if (!email) {
    statusEl.textContent = t('Введите почту');
    crecMailInput.focus();
    return;
  }
  const srv = resolveServer();
  if (!srv) return;
  try {
    await fetch(`${httpBase(srv.base)}/auth/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch {
    /* swallow — never reveal a delivery/lookup outcome */
  }
  statusEl.textContent = t('Если такая почта есть — прислали ссылку для сброса');
}
$('crrecover').addEventListener('click', () => {
  showStage('recover');
  crecMailInput.value = crMailInput.value.trim();
  statusEl.textContent = '';
  crecMailInput.focus();
});
$('crecgo').addEventListener('click', () => void submitRecover());
crecMailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitRecover();
});
$('crecback').addEventListener('click', () => {
  showStage('welcome');
  statusEl.textContent = '';
});

// --- Password reset: spend a mailed «?reset=<token>» link (→ /auth/reset) -------------
// The reset stage is opened by the boot deep-link (see the first-run gate). On success the
// server hands back a session (reset IS a login) → straight into the hub.
const cresetPassInput = $('cresetpass') as HTMLInputElement;
const cresetPass2Input = $('cresetpass2') as HTMLInputElement;
let resetToken = ''; // the token carried by the ?reset= deep-link
async function submitReset(): Promise<void> {
  const pass = cresetPassInput.value;
  if (pass.length < 8) {
    statusEl.textContent = t('Введите пароль (мин. 8 символов)');
    cresetPassInput.focus();
    return;
  }
  if (pass !== cresetPass2Input.value) {
    statusEl.textContent = t('Пароли не совпадают');
    cresetPass2Input.focus();
    return;
  }
  if (signingIn) return;
  signingIn = true;
  try {
    const srv = resolveServer();
    if (!srv) return;
    const res = await fetch(`${httpBase(srv.base)}/auth/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password: pass }),
    }).catch(() => null);
    const body = ((res && (await res.json().catch(() => ({})))) ?? {}) as {
      login?: string;
      token?: string;
    };
    if (!res || !res.ok || !body.token || !body.login) {
      statusEl.textContent = t('Ссылка недействительна или устарела');
      return;
    }
    localStorage.setItem(
      sessionKey(srv.base),
      JSON.stringify({ login: body.login, token: body.token }),
    );
    localStorage.setItem('void.nick', body.login);
    nickInput.value = body.login;
    resetToken = '';
    cresetPassInput.value = '';
    cresetPass2Input.value = '';
    statusEl.textContent = '';
    note('✔ ' + t('Пароль изменён'));
    openHub();
  } finally {
    signingIn = false;
  }
}
$('cresetgo').addEventListener('click', () => void submitReset());
cresetPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') cresetPass2Input.focus();
});
cresetPass2Input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitReset();
});
/** Open the reset stage for a «?reset=<token>» deep-link (called from the first-run gate). */
function openReset(token: string): void {
  resetToken = token;
  // Strip ?reset=<token> from the address bar + history: the token is a live 15-minute
  // account-takeover capability and must not linger in the URL (referer leaks, shoulder
  // surfing, back/forward, synced history). Remove only `reset`, keep any other params.
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('reset')) {
      url.searchParams.delete('reset');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch {
    /* history/URL unavailable (non-browser test env) — nothing to scrub */
  }
  showConnect(true);
  showHub(false);
  showStage('reset');
  cresetPassInput.value = '';
  cresetPass2Input.value = '';
  statusEl.textContent = '';
  cresetPassInput.focus();
}

// hub interactions
$('hub-play').addEventListener('click', () => hubTab('games'));
// Single-player entry from the hub home — offline skirmish vs bots (both builds).
$('hub-solo').addEventListener('click', () => {
  userClosed = true; // intentional leave → don't auto-reconnect to a server
  NET = false;
  showHub(false);
  openSetup('hub');
});
$('hub-msg').addEventListener('click', () => {
  hubNote.textContent = t('Сообщения — скоро');
});
$('hub-logout').addEventListener('click', () => {
  // «Сменить командира» must really switch identity: drop this server's session so
  // the next sign-in authenticates the NEW callsign instead of replaying the old JWT.
  const srv = resolveServer();
  if (srv) localStorage.removeItem(sessionKey(srv.base));
  statusEl.textContent = '';
  showHub(false);
  showConnect(true);
  showStage('welcome');
});
for (const b of Array.from(document.querySelectorAll('.hub-tab'))) {
  b.addEventListener('click', () => hubTab((b as HTMLElement).dataset.hub ?? 'home'));
}
for (const tile of Array.from(document.querySelectorAll('#hp-more .hub-tile[data-more]'))) {
  tile.addEventListener('click', () => {
    // The tile's own label span is already localized (localizeStaticDom ran at boot);
    // read IT, not the Russian-only data-more attribute, so the toast matches the UI language.
    const label =
      tile.querySelector('[data-i18n]')?.textContent ?? (tile as HTMLElement).dataset.more ?? '';
    hubNote.textContent = t('{what} — скоро', { what: label });
  });
}

// --- settings overlay (hub → «Ещё» → Настройки) -----------------------------
// Client-only display preferences (localStorage), never sent to the server, grouped into
// «Интерфейс» (radar-sweep opacity, own ping markers) and «Графика» (glow & haloes,
// star backdrop). All purely cosmetic — the radar mechanic (contact detection) and the
// simulation are untouched at every setting.
const settingsEl = $('settings');
function renderSettings(): void {
  const pct = Math.round(sweepOpacity * 100);
  settingsEl.innerHTML =
    `<div class="setbox">` +
    `<div class="pc-head"><span class="pc-dia" style="background:var(--cyan)"></span><b>${t('НАСТРОЙКИ')}</b><span class="pc-tag">${t('интерфейс')}</span></div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Радарная развёртка')}<span class="set-sub">${t('вращающийся луч на карте — только вид, не влияет на обнаружение')}</span></div>` +
    `<div class="set-ctl"><input id="set-sweep" type="range" min="0" max="100" step="5" value="${pct}" aria-label="${t('Прозрачность радарной развёртки')}"><span id="set-sweep-val" class="set-val">${pct}%</span></div>` +
    `</div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Свои метки на карте')}<span class="set-sub">${t('булавки 📍 ваших пингов — метки союзников видны всегда')}</span></div>` +
    `<div class="set-ctl"><label class="set-switch"><input id="set-ownpings" type="checkbox"${showOwnPings ? ' checked' : ''} aria-label="${t('Свои метки на карте')}"><span class="sw-track"></span><span class="sw-knob"></span></label><span id="set-ownpings-val" class="set-val">${showOwnPings ? t('вкл') : t('выкл')}</span></div>` +
    `</div>` +
    (pcUi()
      ? `<div class="set-row">` +
        `<div class="set-lbl">${t('Компактный режим меню')}<span class="set-sub">${t('плотная панель сектора — меньше отступов, мельче шрифт (на ПК)')}</span></div>` +
        `<div class="set-ctl"><label class="set-switch"><input id="set-compact" type="checkbox"${compactPanel ? ' checked' : ''} aria-label="${t('Компактный режим меню')}"><span class="sw-track"></span><span class="sw-knob"></span></label><span id="set-compact-val" class="set-val">${compactPanel ? t('вкл') : t('выкл')}</span></div>` +
        `</div>`
      : '') +
    `<div class="pc-sec">${t('Цвета сторон')}</div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Свой цвет')}<span class="set-sub">${t('вы на карте и в панелях — форма несёт тип, цвет несёт сторону')}</span></div>` +
    `<div class="set-ctl"><input id="set-colyou" type="color" value="${youColor}" aria-label="${t('Свой цвет')}"></div>` +
    `</div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Нейтральные')}<span class="set-sub">${t('ничейные миры и неопознанные силы')}</span></div>` +
    `<div class="set-ctl"><input id="set-colneutral" type="color" value="${neutralColor}" aria-label="${t('Нейтральные')}"></div>` +
    `</div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Палитра соперников')}<span class="set-sub">${t('«дальтоник» — оттенки, различимые при цветослепоте')}</span></div>` +
    `<div class="set-ctl set-pals">` +
    (['classic', 'warm', 'cvd'] as const)
      .map(
        (p) =>
          `<button type="button" class="set-pal${rivalPaletteId === p ? ' on' : ''}" data-pal="${p}">${
            p === 'classic' ? t('классика') : p === 'warm' ? t('тёплая') : t('дальтоник')
          }</button>`,
      )
      .join('') +
    `<button type="button" class="set-pal" id="set-colreset" title="${t('Вернуть цвета по умолчанию')}">⟲</button>` +
    `</div>` +
    `</div>` +
    `<div class="pc-sec">${t('Графика')}</div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Свечение и ореолы')}<span class="set-sub">${t('мягкое сияние вокруг миров, флотов и границ — выключите ради чёткой карты и скорости')}</span></div>` +
    `<div class="set-ctl"><label class="set-switch"><input id="set-glow" type="checkbox"${glowFx ? ' checked' : ''} aria-label="${t('Свечение и ореолы')}"><span class="sw-track"></span><span class="sw-knob"></span></label><span id="set-glow-val" class="set-val">${glowFx ? t('вкл') : t('выкл')}</span></div>` +
    `</div>` +
    `<div class="set-row">` +
    `<div class="set-lbl">${t('Звёздный фон')}<span class="set-sub">${t('дрейфующие туманности и звёзды на фоне — выключите для плоского фона')}</span></div>` +
    `<div class="set-ctl"><label class="set-switch"><input id="set-starfield" type="checkbox"${starfield ? ' checked' : ''} aria-label="${t('Звёздный фон')}"><span class="sw-track"></span><span class="sw-knob"></span></label><span id="set-starfield-val" class="set-val">${starfield ? t('вкл') : t('выкл')}</span></div>` +
    `</div>` +
    // Developer section (PC only) — tools a normal player doesn't need.
    (pcUi()
      ? `<div class="pc-sec">${t('Для разработчиков')}</div>` +
        `<div class="set-row">` +
        `<div class="set-lbl">${t('Управление скоростью')}<span class="set-sub">${t('панель времени в матче — пауза и множители ускорения (1× — реальное время)')}</span></div>` +
        `<div class="set-ctl"><label class="set-switch"><input id="set-devspeed" type="checkbox"${devSpeedControl ? ' checked' : ''} aria-label="${t('Управление скоростью')}"><span class="sw-track"></span><span class="sw-knob"></span></label><span id="set-devspeed-val" class="set-val">${devSpeedControl ? t('вкл') : t('выкл')}</span></div>` +
        `</div>`
      : '') +
    `<button class="pc-close" id="set-close" type="button">${t('ГОТОВО')}</button>` +
    `</div>`;
  const slider = document.getElementById('set-sweep') as HTMLInputElement | null;
  const val = document.getElementById('set-sweep-val');
  slider?.addEventListener('input', () => {
    setSweepOpacity(Number(slider.value) / 100);
    if (val) val.textContent = `${Math.round(sweepOpacity * 100)}%`; // 0% reads as hidden
  });
  const own = document.getElementById('set-ownpings') as HTMLInputElement | null;
  const ownVal = document.getElementById('set-ownpings-val');
  own?.addEventListener('change', () => {
    setShowOwnPings(own.checked);
    if (ownVal) ownVal.textContent = own.checked ? t('вкл') : t('выкл');
  });
  const compact = document.getElementById('set-compact') as HTMLInputElement | null;
  const compactVal = document.getElementById('set-compact-val');
  compact?.addEventListener('change', () => {
    setCompactPanel(compact.checked);
    if (compactVal) compactVal.textContent = compact.checked ? t('вкл') : t('выкл');
  });
  const glow = document.getElementById('set-glow') as HTMLInputElement | null;
  const glowVal = document.getElementById('set-glow-val');
  glow?.addEventListener('change', () => {
    setGlowFx(glow.checked);
    if (glowVal) glowVal.textContent = glow.checked ? t('вкл') : t('выкл');
  });
  const star = document.getElementById('set-starfield') as HTMLInputElement | null;
  const starVal = document.getElementById('set-starfield-val');
  star?.addEventListener('change', () => {
    setStarfield(star.checked);
    if (starVal) starVal.textContent = star.checked ? t('вкл') : t('выкл');
  });
  const devspd = document.getElementById('set-devspeed') as HTMLInputElement | null;
  const devspdVal = document.getElementById('set-devspeed-val');
  devspd?.addEventListener('change', () => {
    setDevSpeedControl(devspd.checked);
    if (devspdVal) devspdVal.textContent = devspd.checked ? t('вкл') : t('выкл');
  });
  // Цвета сторон: живые инпуты + пресеты палитры соперников. Карта красится на
  // следующем кадре сама (ownerColor читается при отрисовке), панель — при
  // следующей перестройке.
  const colYou = document.getElementById('set-colyou') as HTMLInputElement | null;
  const colNeutral = document.getElementById('set-colneutral') as HTMLInputElement | null;
  colYou?.addEventListener('input', () =>
    setSideColors(colYou.value, neutralColor, rivalPaletteId),
  );
  colNeutral?.addEventListener('input', () =>
    setSideColors(youColor, colNeutral.value, rivalPaletteId),
  );
  for (const b of Array.from(settingsEl.querySelectorAll('.set-pal[data-pal]'))) {
    b.addEventListener('click', () => {
      setSideColors(youColor, neutralColor, (b as HTMLElement).dataset.pal ?? 'classic');
      renderSettings(); // перерисовать активный пресет
    });
  }
  document.getElementById('set-colreset')?.addEventListener('click', () => {
    setSideColors(COLOR.p1!, COLOR.null!, 'classic');
    renderSettings();
  });
  document
    .getElementById('set-close')
    ?.addEventListener('click', () => settingsEl.classList.remove('show'));
}
$('hub-settings').addEventListener('click', () => {
  renderSettings();
  settingsEl.classList.add('show');
});
// Rail: settings are reachable mid-match too, not only from the hub's «Ещё» tab.
document.getElementById('rail-settings')?.addEventListener('click', () => {
  renderSettings();
  settingsEl.classList.add('show');
});
settingsEl.addEventListener('click', (e) => {
  if (e.target === settingsEl) settingsEl.classList.remove('show'); // tap the backdrop → close
});

// First-run gate: a returning commander (a saved callsign) skips the identity card
// and boots straight into the hub — the raw "Новый командир / войти" screen is only
// for a genuinely new device. "Сменить командира" in the hub goes back to identity.
//
// Deep-link overrides (checked before the returning-player shortcut):
//  «?reset=<token>» — a mailed password-reset link → the reset page (set a new password).
//  «?join=<id>»     — a new tab spawned by «Войти» in the match list → straight into THAT
//                     session, reusing this browser's stored identity (nick / session JWT).
const bootParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const bootReset = (bootParams?.get('reset') ?? '').trim();
const bootJoinId = (bootParams?.get('join') ?? '').trim();
if (bootReset) {
  openReset(bootReset);
} else if (bootJoinId) {
  showConnect(true);
  showHub(false);
  statusEl.textContent = t('Подключение к сессии…');
  void (async () => {
    const srv = resolveServer();
    if (srv) await probeAuthMode(srv.base);
    connectToMatch(bootJoinId);
  })();
} else if ((localStorage.getItem('void.nick') ?? '').trim()) {
  openHub();
}

// --- single-player setup overlay --------------------------------------------
// Pick your homeworld on a mini-map and choose how many AI rivals join, then
// launch a fresh local match. Seat 1 is always you; seats 2-10 toggle AI/off.
// Switch every rival OFF for a solo sandbox — the core never ends a one-player
// match, so it's a peaceful space to read descriptions and learn the interface.
const setupEl = $('setup');
const setupMapEl = $('setupmap');
const setupSlotsEl = $('setupslots');
const setupFactionsEl = $('setupfactions');
const setupSpeedEl = $('setupspeed');
const setupHintEl = $('setuphint');
const setupGoEl = $('setupgo') as HTMLButtonElement;

// The player's division templates / hero roster / ship blueprints. Pre-match loadout
// EDITORS were removed (modules unlock via tech in-match, so freezing a loadout before
// the match is incoherent — loadout now happens in-match: ships at build time, heroes
// in the capital). These default rosters still seed the match via buildSetupConfig.
const setupTemplates: FormationTemplate[] = DEFAULT_TEMPLATES.map((t) => ({
  name: t.name,
  slots: [...t.slots],
}));
/** Unit-type → icon, used by the in-match division roster readout (panelHtml). */
// Mobile keeps the original emoji (phone fonts render them); PC monospace stacks
// have no text glyph for 🪖👥🎖 (they rendered as tofu ▯) and use UNIT_ICON-style
// text glyphs instead. Resolved per render via formIcon() on the pcUi() gate.
const FORM_ICON_EMOJI: Record<string, string> = {
  militia: '👥',
  heavy_infantry: '🪖',
  special_forces: '🎖',
  tank: '🛡',
};
const FORM_ICON_TEXT: Record<string, string> = {
  militia: '▿',
  heavy_infantry: '◆',
  special_forces: '✱',
  tank: '▰',
};
function formIcon(type: string): string {
  return (pcUi() ? FORM_ICON_TEXT[type] : FORM_ICON_EMOJI[type]) ?? '▪';
}
const FORM_RU: Record<string, string> = {
  militia: 'Ополчение',
  heavy_infantry: 'Тяжёлая пехота',
  special_forces: 'Спецназ',
  tank: 'Танк',
};
const setupHeroes: HeroLoadout[] = DEFAULT_HEROES.map((h) => ({
  name: h.name,
  grade: h.grade,
  abilities: [...h.abilities],
}));

/** The hero's display name — the главный hero shows the player's callsign (nick),
 *  falling back to its localized preset name only while the nick field is empty. */
function heroName(h: HeroLoadout): string {
  return h.grade === 'main' ? nickInput.value.trim() || t(h.name) : h.name;
}

const setupShips: ShipLoadout[] = DEFAULT_SHIP_LOADOUTS.map((l) => ({
  hull: l.hull,
  modules: [...l.modules],
}));

// Loadout is chosen in-match now (ships at build time under tech-unlocks, heroes in the
// capital), so the pre-match Верфь / Герои / Дивизии editors and their inventory chrome
// were removed. `setupTemplates` / `setupHeroes` / `setupShips` above keep seeding the
// match with the default rosters via buildSetupConfig.

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

/** H3 — which house each seat plays: seat 0 (you) = `setupFaction`, then the four
 *  passive houses rotate in stable order across the remaining seats. */
function seatFactionIds(): string[] {
  const all = Object.keys(data.factions);
  const ordered = [setupFaction, ...all.filter((f) => f !== setupFaction)];
  return SEAT_META.map((_, i) => ordered[i % ordered.length]!);
}
function seatHouseName(fid: string, fallback: string, index: number): string {
  const base = data.factions[fid]?.name ?? fallback;
  const cycle = Math.floor(index / Math.max(1, Object.keys(data.factions).length)) + 1;
  return cycle === 1 ? base : `${base} ${cycle}`;
}
/** A faction's passive-bonus readout, straight from the data (economy or units). */
function factionBonusLine(fid: string): string {
  const p = data.factions[fid]?.passives;
  if (!p) return '';
  const parts: string[] = [];
  if (p.productionBonus)
    parts.push(t('+{n}% экономика', { n: Math.round(p.productionBonus * 100) }));
  if (p.combatDamageBonus)
    parts.push(t('+{n}% урон', { n: Math.round(p.combatDamageBonus * 100) }));
  if (p.fleetSpeedBonus)
    parts.push(t('+{n}% скорость флотов', { n: Math.round(p.fleetSpeedBonus * 100) }));
  if (p.radarRangeBonus) parts.push(t('+{n}% радар', { n: Math.round(p.radarRangeBonus * 100) }));
  return parts.join(' · ');
}

function renderSetupSlots(): void {
  // The faction picker (H3): four houses, each a pure passive bonus — pick yours.
  // Lives in its own container (#setupfactions, the left setup column); the team
  // toggle + seat rows fill #setupslots (the right column).
  let f2 = `<div class="fph">${t('Фракция — пассивный бонус дома')}</div><div class="fpick">`;
  for (const fid of Object.keys(data.factions)) {
    const f = data.factions[fid];
    if (!f) continue;
    const on = fid === setupFaction;
    f2 +=
      `<button class="fchip${on ? ' on' : ''}" data-fpick="${fid}"><b>${esc(tData(f.name))}</b>` +
      `<span>${factionBonusLine(fid)}</span></button>`;
  }
  f2 += `</div>`;
  setupFactionsEl.innerHTML = f2;
  // Team-battle toggle: sides fight as allies. Only meaningful with ≥2 rivals (a 2v2
  // needs three AI seats on); shown always so the player can arm it before adding them.
  let h =
    `<div class="tmrow"><button class="tmtog${setupTeams ? ' on' : ''}" data-teamtog="1">` +
    `${setupTeams ? '⚔ ' + t('Командный бой: ВКЛ') : t('Командный бой: выкл')}</button>` +
    (setupTeams ? `<span class="tmhint">${t('одна сторона — союзники')}</span>` : '') +
    `</div>`;
  const fids = seatFactionIds();
  // A/B side chip for a seat (you are locked to A; AI seats toggle side).
  const teamChip = (i: number, locked: boolean): string => {
    const side = setupSeatTeam[i]!;
    return `<button class="tmchip s${side}${locked ? ' lock' : ''}" data-teamseat="${i}"${locked ? ' disabled' : ''}>${side}</button>`;
  };
  for (let i = 0; i < SEAT_META.length; i++) {
    const m = SEAT_META[i]!;
    const role = setupSlots[i]!;
    const house = esc(tData(seatHouseName(fids[i]!, m.name, i)));
    if (i === 0) {
      h +=
        `<div class="srow"><span class="dot" style="background:${m.color};color:${m.color}"></span>` +
        `<span class="nm">${house}</span>` +
        (setupTeams ? teamChip(0, true) : '') +
        `<span class="you">${t('ВЫ')}</span></div>`;
    } else {
      const aiOn = role === 'ai';
      h +=
        `<div class="srow ${aiOn ? '' : 'off'}"><span class="dot" style="background:${m.color};color:${m.color}"></span>` +
        `<span class="nm">${house}</span>` +
        (setupTeams && aiOn ? teamChip(i, false) : '') +
        `<button class="stog ${aiOn ? 'ai' : ''}" data-slot="${i}">${aiOn ? t('ИИ') : t('ВЫКЛ')}</button></div>`;
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
  setupGoEl.textContent = rivals === 0 ? t('ЗАПУСК В ОДИНОЧКУ') : t('ЗАПУСК');
  setupHintEl.textContent = t(
    rivals === 0
      ? 'Дом: {home} — одиночная песочница, без соперников · тапните светящийся мир, чтобы сменить'
      : 'Дом: {home} — тапните другой светящийся мир, чтобы сменить',
    { home: setupStart },
  );
  for (const c of Array.from(setupSpeedEl.querySelectorAll('[data-spd]')))
    c.classList.toggle('on', Number((c as HTMLElement).dataset.spd) === setupSpeed);
}

// Where the Setup screen's Back button returns to — the surface that opened it, so
// arriving from the hub goes back to the hub, not the raw identity card.
let setupReturn: 'welcome' | 'hub' = 'welcome';
// --- scientist council picker: choose your 2 research leaders BEFORE the start-point ----
// A start consecration (GDD §5.2): snapshotted into the match, immutable in-match. Empty
// slots pulse to prompt the choice; each pick shows which tech-tree branch (and gated nodes)
// it opens — the influence the player asked to see up front.
const sciWin = $('scipick');
function sciInfluence(id: string): string {
  const def = data.scientists[id];
  if (!def) return '';
  if (!def.branch) return t('+1 слот исследования (генералист, без фокуса ветки)');
  const opens = Object.values(data.technologies)
    .filter(
      (td) =>
        td.branch === def.branch && (td.conditions ?? []).some((c) => c.type === 'has_scientist'),
    )
    .map((td) => tData(td.name));
  const br = branchLabel(def.branch);
  return opens.length
    ? t('Открывает ветку «{br}»: {list}', { br, list: opens.join(', ') })
    : t('Фокус ветки «{br}»', { br });
}
function renderSciPick(): void {
  const chosen = setupScientists;
  const slots = [0, 1]
    .map((i) => {
      const id = chosen[i];
      if (!id) {
        return `<div class="sp-slot empty"><div class="sp-plus">＋</div><div class="sp-hint">${t('Выбрать учёного')}</div></div>`;
      }
      const def = data.scientists[id];
      return (
        `<div class="sp-slot filled"><button class="sp-rm" data-sprm="${i}" title="${t('убрать')}">✕</button>` +
        `<div class="sp-sn">${esc(tData(def?.name ?? id))}</div>` +
        `<div class="sp-inf">${esc(sciInfluence(id))}</div></div>`
      );
    })
    .join('');
  const roster = Object.keys(data.scientists)
    .map((id) => {
      const def = data.scientists[id]!;
      const placed = chosen.includes(id);
      const dis = placed || (chosen.length >= 2 && !placed);
      return (
        `<button class="sp-card${placed ? ' picked' : ''}" data-spadd="${id}"${dis ? ' disabled' : ''}>` +
        `<div class="sp-cn">${esc(tData(def.name))}${placed ? '<span class="sp-tick">✓</span>' : ''}</div>` +
        `<div class="sp-inf">${esc(sciInfluence(id))}</div></button>`
      );
    })
    .join('');
  const ready = chosen.length >= 2;
  $('scipickbody').innerHTML =
    `<div class="sp-slots">${slots}</div>` +
    `<div class="sp-warn">${t('⚠ Совет закрепляется на весь матч. Рекомендованная пара уже выбрана — замените по вкусу.')}</div>` +
    `<div class="sp-h">${t('Кандидаты · нажмите, чтобы занять слот')}</div>` +
    `<div class="sp-roster">${roster}</div>` +
    `<button class="sp-go" id="sp-go"${ready ? '' : ' disabled'}>${ready ? t('Закрепить и продолжить к выбору места →') : t('Выберите двух учёных')}</button>`;
}
function openSciPick(): void {
  sciWin.classList.add('show');
  renderSciPick();
}
sciWin.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement;
  if (tg.closest('.sp-cancel')) {
    sciWin.classList.remove('show');
    $('setupcancel').click(); // back out of setup entirely
    return;
  }
  const add = tg.closest('[data-spadd]') as HTMLElement | null;
  if (add && !add.hasAttribute('disabled')) {
    const id = add.dataset.spadd ?? '';
    if (id && !setupScientists.includes(id) && setupScientists.length < 2) setupScientists.push(id);
    renderSciPick();
    return;
  }
  const rm = tg.closest('[data-sprm]') as HTMLElement | null;
  if (rm) {
    setupScientists.splice(Number(rm.dataset.sprm), 1);
    renderSciPick();
    return;
  }
  if (tg.id === 'sp-go' && setupScientists.length >= 2) sciWin.classList.remove('show');
});

function openSetup(from: 'welcome' | 'hub' = 'welcome'): void {
  setupReturn = from;
  setupSlots = freshSetupSlots();
  setupTeams = false; // a fresh setup opens on the classic free-for-all
  setupSeatTeam = [...DEFAULT_TEAM_SIDES];
  setupStart = START_CANDIDATES[0] ?? MAP[0]!.id;
  // Re-consecrate the council each time setup opens, PRE-SEEDED with the recommended
  // newbie pair (командование «Куратор» + генералист «Полимат»): the first permanent
  // choice a new player faces must never be a wall of empty slots + a disabled button —
  // one tap continues, swapping is optional. Guarded by presence so data edits degrade.
  setupScientists = ['overseer', 'polymath'].filter((id) => data.scientists[id]);
  // A lively default: ×1 wall-clock reads as a FROZEN screen to a newcomer, so the
  // setup opens on the last chosen multiplier (first launch: ×10). True real time
  // stays one tap away — the ×1 chip.
  const savedSpeed = Number(localStorage.getItem('void.setupSpeed'));
  setupSpeed = SETUP_SPEEDS.includes(savedSpeed) ? savedSpeed : 10;
  showConnect(false);
  setupEl.style.display = 'flex';
  $('setup-start').style.display = '';
  renderSetup();
  openSciPick(); // consecrate your 2 research leaders before picking the start point
}

// --- meta-progression (прокачка командующего) --------------------------------
// Per-callsign account state; v1 lives in localStorage next to the guest identity —
// the server account (SE-1.x) takes this over when the meta-layer lands there.
function metaKey(): string {
  return 'vd.meta.' + (nickInput.value.trim() || 'guest');
}
function loadMeta(): MetaState {
  return parseMetaState(localStorage.getItem(metaKey()));
}
function saveMeta(st: MetaState): void {
  localStorage.setItem(metaKey(), JSON.stringify(st));
}
let xpAwarded = false; // one award per installed match

function buildSetupConfig(): SetupConfig {
  // Seats play the HOUSES assigned at setup (H3): you = setupFaction, AI = the rest.
  // Seat name follows the house (its canonical data name); color stays per-seat.
  const fids = seatFactionIds();
  const seats: SeatConfig[] = [
    {
      id: SEAT_META[0]!.id,
      name: seatHouseName(fids[0]!, SEAT_META[0]!.name, 0),
      faction: fids[0]!,
      start: setupStart,
      ai: false,
      ...(setupTeams ? { team: setupSeatTeam[0] } : {}),
    },
  ];
  // Hand each active AI seat one of the remaining candidate worlds, in order.
  const free = START_CANDIDATES.filter((c) => c !== setupStart);
  let fi = 0;
  for (let i = 1; i < SEAT_META.length; i++) {
    if (setupSlots[i] !== 'ai') continue;
    const start = free[fi++];
    if (!start) break; // ran out of candidate worlds
    const m = SEAT_META[i]!;
    seats.push({
      id: m.id,
      name: seatHouseName(fids[i]!, m.name, i),
      faction: fids[i]!,
      start,
      ai: true,
      ...(setupTeams ? { team: setupSeatTeam[i] } : {}),
    });
  }
  // Carry the player's division templates + hero roster into the match (deep-cloned),
  // plus the meta-progression grant (snapshot — no live account reads mid-match).
  return {
    meta: metaGrant(loadMeta()),
    seats,
    ...(setupScientists.length ? { scientists: [...setupScientists] } : {}),
    templates: setupTemplates.map((t) => ({ name: t.name, slots: [...t.slots] })),
    heroes: setupHeroes.map((h) => ({
      name: heroName(h),
      grade: h.grade,
      abilities: [...h.abilities],
    })),
    ships: setupShips.map((l) => ({ hull: l.hull, modules: [...l.modules] })),
  };
}

// Install a ready GameState as the live match: reset all interaction state, queues,
// camera and log, then hide the setup overlay. `aiPlayers` are the seats the local
// sim drives. Shared by the normal skirmish and (via a hook) the dev test mode.
// Tap a resource chip → what the number means: stock and hourly net flow.
purse.addEventListener('click', (ev) => {
  const el = (ev.target as Element).closest('[data-res]') as HTMLElement | null;
  if (!el) return;
  const key = el.dataset.res!;
  const stock = Math.round(s.players[ME]?.resources?.[key] ?? 0);
  // Same rounding as the chip: one decimal below 1/ч, so a slow bleed reads as −0.4,
  // not a lying 0. On phones this note is the only income readout (the bar hides flow).
  const raw = netIncome(s, ME)[key] ?? 0;
  const flow = Math.abs(raw) >= 1 ? Math.round(raw) : Math.round(raw * 10) / 10;
  const short = (s.players[ME]?.arrears ?? []).includes(key);
  note(
    t('{ic} {name}: {stock} в казне · {flow}/ч (производство минус содержание войск и зданий)', {
      ic: TECH_CUR[key] ?? '',
      name: el.title,
      stock: kfmt(stock),
      flow: (flow >= 0 ? '+' : '') + (Math.abs(flow) >= 1 ? kfmt(flow) : String(flow)),
    }) + (short ? ' ' + t('⚠ ДЕФИЦИТ — здания-потребители работают на 50%') : ''),
  );
});

// Tap the ✦ score chip → a plain-words breakdown of how the score is built and how
// the match ends (the victory rule is otherwise invisible mid-match).
devlineEl.addEventListener('click', (ev) => {
  if (!(ev.target as Element).closest('.dstat')) return;
  const mine = Object.values(s.planets).filter((p) => p.owner === ME);
  const worlds = mine.filter((p) => (p.kind ?? 'planet') === 'planet').length;
  const score = Math.round(s.match?.scores?.[ME]?.total ?? 0);
  note(
    t(
      '✦ {score}/{limit}: мир — 50, прочий сектор — 10, здания добавляют по уровню (у вас {w} миров, {s} секторов). Победа: ✦ {limit}, уничтожение соперников или доминирование.',
      {
        score,
        limit: SCORE_LIMIT,
        w: worlds,
        s: mine.length - worlds,
      },
    ),
  );
});

function installMatch(state: GameState, aiPlayers: Set<string>): void {
  s = state;
  syncPlayerNames(s);
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
  assaultAim = false;
  assaultOnArrival.clear();
  merging = false;
  additive = false;
  splitState = null;
  killStats = { destroyed: 0, lost: 0 };
  myBattleLocs.clear();
  memory.clear(); // fog memory belongs to the OLD match — stale intel must not carry over
  radarMemory.clear();
  threatMemory.clear(); // node ids repeat across matches — a stale episode must not mute a real alert
  threatScanAt = -1;
  battleLosses.clear();
  aaShots.length = 0;
  logLines.length = 0; // fresh log — drop notes from the menu-background match
  eventLog.length = 0; // ONB-5: the return digest belongs to THIS match only
  awayFromGameTime = null; // reset the away-window baseline for the new match
  banner = null; // clear any end-banner left by the menu-background match (else it sticks)
  endScreen = null; // a fresh match must not open into the previous result
  xpAwarded = false; // a fresh match earns its own meta-XP award
  // The match goal, written AFTER the wipe so it is the first line a player can read.
  // Kept honest against the kernel: victoryModule ends on score (SCORE_LIMIT), on
  // elimination, or on domination — no "capital capture" victory exists.
  note(t('Задача: ✦ {n} (мир — 50, сектор — 10) или уничтожение соперников.', { n: SCORE_LIMIT }));
  for (const k of Object.keys(buildQueues)) delete buildQueues[k];
  defaultView(); // phone: zoom onto home; desktop: whole-map fit
  setupEl.style.display = 'none';
  maybeStartPendingTour(); // ONB-0: run a queued onboarding guide over the fresh HUD
}
function startMatch(setup: SetupConfig): void {
  const st = newGame(setup);
  installMatch(st, new Set(setup.seats.filter((x) => x.ai).map((x) => x.id)));
  applyTimeSpeed(setupSpeed); // launch running at the chosen time-flow multiplier
}

setupMapEl.addEventListener('click', (ev) => {
  const direct = (ev.target as Element).closest('[data-cand]');
  let pick: string | null = direct?.getAttribute('data-cand') ?? null;
  if (!pick) {
    // The candidate circles are ~8px on a phone — a near miss still counts. Map the
    // tap into viewBox space (preserveAspectRatio=meet: uniform scale, centred) and
    // snap to the nearest start world within a generous reach.
    const r = setupMapEl.getBoundingClientRect();
    const vb = (setupMapEl as unknown as SVGSVGElement).viewBox.baseVal;
    if (vb.width > 0 && r.width > 0) {
      const scale = Math.min(r.width / vb.width, r.height / vb.height);
      const x = vb.x + (ev.clientX - r.left - (r.width - vb.width * scale) / 2) / scale;
      const y = vb.y + (ev.clientY - r.top - (r.height - vb.height * scale) / 2) / scale;
      let best = 90; // viewBox units — roughly three candidate radii
      for (const id of START_CANDIDATES) {
        const n = MAP.find((m) => m.id === id);
        if (!n) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < best) {
          best = d;
          pick = id;
        }
      }
    }
  }
  if (!pick) return;
  setupStart = pick;
  renderSetup();
});
setupFactionsEl.addEventListener('click', (ev) => {
  const fp = (ev.target as Element).closest('[data-fpick]');
  if (!fp) return;
  setupFaction = fp.getAttribute('data-fpick') ?? setupFaction;
  renderSetup();
});
setupSlotsEl.addEventListener('click', (ev) => {
  if ((ev.target as Element).closest('[data-teamtog]')) {
    setupTeams = !setupTeams;
    renderSetup();
    return;
  }
  const ts = (ev.target as Element).closest('[data-teamseat]');
  if (ts) {
    const i = Number(ts.getAttribute('data-teamseat'));
    if (i > 0) setupSeatTeam[i] = setupSeatTeam[i] === 'A' ? 'B' : 'A'; // you (0) are locked to A
    renderSetup();
    return;
  }
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
  localStorage.setItem('void.setupSpeed', String(setupSpeed));
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
  // Seat lock (REL-5): the ticket the server minted for this seat on first join —
  // presented back on every reconnect so nobody else can take the seat by typing
  // our nick. Keyed per server+match+nick (the ticket is seat-scoped).
  const ticketKey = `void.ticket.${base}|${currentMatchId}|${nick}`;
  const seatTicket = localStorage.getItem(ticketKey);
  // Identity on the wire: accounts mode (SES-2.5) dials with the short-lived join
  // token minted by /matches/:id/join — nick/ticket are refused by the server there.
  // Nick mode: the server maps the name → a fixed side and hands it back, so we
  // learn our seat from the welcome (snap.playerId), not from a side picker.
  const url =
    authMode && pendingJoinToken
      ? `${base}/matches/${encodeURIComponent(currentMatchId)}?token=${encodeURIComponent(pendingJoinToken)}`
      : `${base}/matches/${encodeURIComponent(currentMatchId)}?nick=${encodeURIComponent(nick)}` +
        (seatTicket ? `&ticket=${encodeURIComponent(seatTicket)}` : '');
  pendingJoinToken = null; // one dial per token fetch — a reconnect mints a fresh one
  statusEl.textContent = t('Подключение: {nick}…', { nick });
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
      onSeatTicket: (ticket) => {
        // The server minted our seat ticket (first join of this nick) — persist it;
        // every later join must present it, and the server can't re-issue (hash-only).
        localStorage.setItem(ticketKey, ticket);
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
          endScreen = null; // joining a match must not carry the previous result
          xpAwarded = false;
          pendingLoads = []; // drop any queued loads from a prior/local session
          showConnect(false);
          note(t('● подключён как {who}', { who: NAME[ME] ?? ME }));
          // Latency probe: ping every 2s with a client timestamp the pong echoes.
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = setInterval(() => client.ping(performance.now()), 2000);
          client.ping(performance.now()); // seed an RTT reading immediately
          // Perf sample (M2): smoothed fps + rtt + JS-heap (Chrome-only field),
          // every 30s — cheap enough to never matter, useful on every playtest.
          if (perfTimer) clearInterval(perfTimer);
          perfTimer = setInterval(() => {
            const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
              ?.usedJSHeapSize;
            client.sendPerf({
              fps: Math.round(fpsEma),
              ...(rttEma !== null ? { rttMs: Math.round(rttEma) } : {}),
              ...(mem !== undefined ? { memMb: Math.round(mem / 1048576) } : {}),
            });
          }, PERF_SAMPLE_MS);
        }
        const diploShift = admitted && s !== snap.state && diffNetDiplomacy(s, snap.state);
        s = snap.state;
        syncPlayerNames(s);
        // Radar picture (BF-18): detected-but-unidentified enemy fleets are absent
        // from the fogged state — the server sends them as coarse contacts beside
        // each frame. The sweep paints THESE in NET (see updateRadarContacts).
        netSignatures = snap.signatures ?? [];
        // Re-render the open roster only NOW — the new state is in place, so the
        // stance chips and offer affordances (✓ accept / ⏳ pending) paint fresh.
        if (diploShift && diploOpen && diploTab === 'diplo') renderDiplo();
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
        // No lobby (SES-2.1): sessions run from creation, a join lands in a live
        // world. `waiting` survives only for the transport's waitForPlayers mode
        // (unused by our hosts) — show the banner, clear it once the clock runs.
        if (snap.waiting) {
          banner = '⏳ ' + t('Ждём, пока хост начнёт…');
        } else if (banner && banner.startsWith('⏳')) {
          banner = null;
        }
        lastPanelHtml = '';
      },
      onRejection: (_id, code) => note('✖ ' + errText(code)),
      // Fog-filtered domain events ride each delta (the server already cuts what we
      // may not see): feed them to the SAME pipeline the local sim uses, so battle
      // toasts, AA tracers, siege arcs, loss tallies and the victory banner all work
      // in a network match too. Fired after onSnapshot — `s` is already up to date.
      onEvents: (events) => {
        if (sock !== netSock) return; // a superseded socket must not touch globals
        handleEvents(events);
      },
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
          text: ping.label ?? t('метка {node}', { node }),
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
      // Server-relayed chat (recipients decided server-side, like fog). Our own lines
      // render from this echo too; the id dedupes a live line vs the join replay.
      onChatMessage: (m: MultiplayerChatMessage) => {
        if (sock !== netSock) return;
        if (sessionMessages.some((x) => x.chatId === m.id)) return;
        // Group lines carry the channel key in `to`; a DM keeps its true addressee —
        // convoMessages derives the thread from (from, to) like the solo path.
        const to =
          m.channel === 'session'
            ? CH_SESSION
            : m.channel === 'coalition'
              ? COALITION
              : (m.to ?? m.from);
        sessionMessages.push({
          at: m.at,
          from: m.from,
          to,
          text: m.text,
          sys: false,
          chatId: m.id,
          realAt: Date.now(),
        });
        if (sessionMessages.length > 300) sessionMessages.shift();
        if (m.from !== ME) unreadMsgs++;
        if (diploOpen && diploTab === 'msgs') renderDiploFeed();
        if (chatOpen && !chatMin) renderChatFeed();
      },
      onError: (code) => {
        if (sock !== netSock) return; // ignore errors from a superseded socket
        // In-match relay refusals (chat flood/target/…) belong in a toast — the
        // connect overlay's status line is hidden once we're admitted.
        if (admitted && code.startsWith('E_CHAT')) {
          note('✖ ' + errText(code));
          return;
        }
        if (!admitted && code === 'E_SLOT_TAKEN') {
          statusEl.textContent = 'that name is already playing (another tab or device?)';
        } else if (!admitted && code === 'E_UNKNOWN_PLAYER') {
          statusEl.textContent = 'could not get a seat';
        } else if (!admitted && code === 'E_MATCH_FULL') {
          // NETA2-1: the server COMPLETED the handshake just to tell us why — a real
          // refusal, not "server down". Say it plainly instead of a generic error.
          statusEl.textContent = t('матч заполнен — все места заняты');
        } else if (!admitted && code === 'E_ENTRY_CLOSED') {
          statusEl.textContent = t('вход в этот матч закрыт (окно приёма новых игроков истекло)');
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
    if (perfTimer) {
      clearInterval(perfTimer);
      perfTimer = null;
    }
    rttEma = null;
    if (NET) {
      NET = false;
      if (userClosed) {
        statusEl.textContent = 'disconnected';
        note(t('● отключён от сервера'));
        showConnect(true);
      } else {
        // unexpected drop → auto-rejoin our seat (the match keeps running server-side)
        note(t('● связь потеряна — переподключение…'));
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
    statusEl.textContent = t('Укажи адрес сервера');
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
    statusEl.textContent = t('Неверный адрес сервера');
    return null;
  }
  const nick = nickInput.value.trim();
  if (!nick) {
    statusEl.textContent = t('Введи позывной');
    return null;
  }
  return { base, nick };
}

const httpBase = (wsBase: string): string => wsBase.replace(/^ws/, 'http');

// --- accounts (SES-2.5) -------------------------------------------------------
// With AUTH on the server, the playable path runs the full account flow: the nick
// is a LOGIN, a password guards it, and joining goes register/login → session JWT →
// GET /matches/:id/join → short-lived join token → WS `?token=`. The client
// self-configures from GET /auth/status; without accounts the nick+ticket handshake
// stays exactly as before. The password is never persisted — only the session JWT
// (a revocable, expiring credential) lands in localStorage, keyed per server.
let authMode = false;
const passRow = document.getElementById('cpassrow') as HTMLElement | null;
const passInput = document.getElementById('cpass') as HTMLInputElement | null;
const sessionKey = (base: string): string => `void.session.${base}`;
/** Session record: the JWT plus WHOSE it is. A cached token must never silently
 *  authenticate a different callsign (family laptop: «Сменить командира» then a
 *  new sign-in really switches the account). Legacy bare-JWT values fail the
 *  parse → treated as absent, one harmless re-login. */
interface SessionRec {
  login: string;
  token: string;
}
function sessionRecord(base: string): SessionRec | null {
  try {
    const rec = JSON.parse(localStorage.getItem(sessionKey(base)) ?? 'null') as {
      login?: unknown;
      token?: unknown;
    } | null;
    return rec && typeof rec.login === 'string' && typeof rec.token === 'string'
      ? { login: rec.login, token: rec.token }
      : null;
  } catch {
    return null;
  }
}
/** The cached session token for ANY identity on this server (best-effort reads:
 *  arsenal refresh, redial). Auth-critical paths use ensureSession, which checks
 *  the login matches. */
function sessionToken(base: string): string | null {
  return sessionRecord(base)?.token ?? null;
}

/** Probe the server's identity mode and show/hide the password field. Network
 *  failure ⇒ assume nick mode (the old handshake) — the join itself will surface
 *  a real error if the server actually wants accounts. */
async function probeAuthMode(base: string): Promise<void> {
  try {
    const res = await fetch(`${httpBase(base)}/auth/status`);
    authMode = res.ok && ((await res.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    authMode = false;
  }
  if (passRow) passRow.style.display = authMode ? '' : 'none';
}

// First visit, Bytro-style (SES-2.5 UX): when the server runs accounts, sign-up IS
// the welcome — probe the same-origin default and surface callsign+password on the
// greeting card right away, so a new commander registers before the hub, not deep
// inside the join flow. Probe failure ⇒ nick mode, the card stays as it was.
// The probe ALWAYS runs and is awaited by the welcome buttons (cnew / sign-in), so
// an early tap can't race /auth/status into the guest branch; revealing the form
// applies to first visits only (a remembered nick skipped the welcome card above).
const authProbe: Promise<void> = (async () => {
  const base = srvInput.value.trim();
  if (!base) return;
  await probeAuthMode(base);
  if (!authMode) return;
  if ((localStorage.getItem('void.nick') ?? '').trim()) return; // welcome card was skipped
  if (!wNickInput.value.trim()) wNickInput.value = suggestCallsign();
  wLoginEl.style.display = 'flex';
  wPassRowEl.style.display = 'flex';
})();

/** A valid session JWT for this server, or null (with the status line explaining).
 *  Zero-friction identity: try LOGIN first; unknown-or-wrong is a uniform 401, so
 *  then try REGISTER — a fresh login creates the account (registration IS the first
 *  login), while a taken one (409) means the password was simply wrong. */
async function ensureSession(
  base: string,
  login: string,
  passwordArg?: string,
  emailArg?: string,
): Promise<string | null> {
  // Only OUR OWN cached session counts — a token minted for a different callsign
  // (or a legacy unbound one) is ignored and replaced by a fresh login below.
  const cachedRec = sessionRecord(base);
  if (cachedRec && cachedRec.login.toLowerCase() === login.toLowerCase()) return cachedRec.token;
  // Mirror the server's LOGIN_RE (authApi.ts) so a bad callsign gets a human
  // explanation here instead of the server's uniform rejection.
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(login)) {
    statusEl.textContent = t('Позывной для аккаунта: 3–24 символа — буквы, цифры, _ или -');
    return null;
  }
  // The password may come from the welcome card (Bytro-style sign-up) or the match
  // browser's field (custom-server joins) — whichever the player actually filled.
  const password = passwordArg ?? (wPassInput.value || (passInput?.value ?? ''));
  if (password.length < 8) {
    statusEl.textContent = t('Введите пароль (мин. 8 символов)');
    return null;
  }
  const call = async (
    path: string,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; token?: string; error?: string }> => {
    const res = await fetch(`${httpBase(base)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password, ...extra }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    return { status: res.status, token: body.token, error: body.error };
  };
  try {
    const login1 = await call('/auth/login');
    if (login1.token) {
      localStorage.setItem(sessionKey(base), JSON.stringify({ login, token: login1.token }));
      return login1.token;
    }
    if (login1.status === 401) {
      // Registration carries the optional recovery email (login never needs it).
      const reg = await call('/auth/register', emailArg ? { email: emailArg } : {});
      if (reg.token) {
        localStorage.setItem(sessionKey(base), JSON.stringify({ login, token: reg.token }));
        note('✔ ' + t('Аккаунт создан'));
        return reg.token;
      }
      statusEl.textContent =
        reg.error === 'E_EMAIL_TAKEN'
          ? t('Эта почта уже занята')
          : reg.status === 409
            ? t('Неверный пароль') // login 401 + register 409 (E_LOGIN_TAKEN) ⇒ wrong password
            : reg.status === 429
              ? t('Слишком часто — подождите')
              : t('Регистрация отклонена');
      return null;
    }
    statusEl.textContent =
      login1.status === 429 ? t('Слишком часто — подождите') : t('Вход отклонён');
    return null;
  } catch {
    statusEl.textContent = t('сервер недоступен');
    return null;
  }
}

/** Exchange the session for a seat + join token. Клиент запоминает токен для
 *  немедленного коннекта; протухший (15 мин TTL) реконнект просто запрашивает
 *  новый — сессия живёт днями. 401 ⇒ сессия истекла: чистим её и просим пароль. */
async function fetchJoinToken(
  base: string,
  matchId: string,
  session: string,
): Promise<{ token: string; playerId: string } | null> {
  try {
    const res = await fetch(`${httpBase(base)}/matches/${encodeURIComponent(matchId)}/join`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (res.status === 401) {
      localStorage.removeItem(sessionKey(base)); // session expired/revoked — re-login
      statusEl.textContent = t('Сессия истекла — введите пароль ещё раз');
      return null;
    }
    if (res.status === 403) {
      statusEl.textContent = t('вход закрыт'); // entry window shut (SES-2.3)
      return null;
    }
    if (!res.ok) {
      statusEl.textContent = res.status === 409 ? t('все места заняты') : t('не удалось войти');
      return null;
    }
    const body = (await res.json()) as { token?: string; playerId?: string };
    if (!body.token || !body.playerId) return null;
    return { token: body.token, playerId: body.playerId };
  } catch {
    statusEl.textContent = t('сервер недоступен');
    return null;
  }
}

/** The join token for the CURRENT dial attempt (auth mode) — consumed by connect(). */
let pendingJoinToken: string | null = null;

interface MatchRow {
  matchId: string;
  mapId: string;
  rules: { timeScale?: number; victory?: { dominationPercent?: number; scoreLimit?: number } };
  days: number;
  players: { seated: number; capacity: number };
  status: string;
  /** Entry window (SES-2.3/2.4): can a NEW player still take a free seat here, and how
   *  long is left. Absent on an older server ⇒ treat as always open. */
  entryOpen?: boolean;
  entryClosesInMs?: number;
}

/** A large sentinel from the server (`Number.MAX_SAFE_INTEGER`) means «no entry window»
 *  — anything past a decade of real time counts as unbounded here. */
const ENTRY_UNBOUNDED_MS = 3650 * 24 * 60 * 60 * 1000;

/** Real-time-left → «Nд Mч» / «Mч» / «<1ч» for the join-window countdown on a row. */
function fmtJoinWindow(ms: number): string {
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  if (d > 0) return t('{d}д {h}ч', { d, h });
  if (hours > 0) return t('{h}ч', { h: hours });
  return t('<1ч');
}
type MatchTab = 'available' | 'active' | 'archived';
let matchLists: Record<MatchTab, MatchRow[]> | null = null;
let activeTab: MatchTab = 'available';

function ruleSummary(r: MatchRow['rules']): string {
  const parts = [`×${r.timeScale ?? 1}`];
  if (r.victory?.scoreLimit) parts.push(t('до {n} очк.', { n: r.victory.scoreLimit }));
  if (r.victory?.dominationPercent)
    parts.push(t('{p}% карты', { p: Math.round(r.victory.dominationPercent * 100) }));
  return parts.join(' · ');
}

/** Join a chosen match: set it as the (re)connect target, then dial via `connect()`.
 *  Accounts mode (SES-2.5) first exchanges the session for a join token (register/
 *  login happens lazily inside `ensureSession` on the first join). */
function connectToMatch(id: string): void {
  currentMatchId = id;
  reconnecting = false;
  reconnectAttempts = 0;
  userClosed = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!authMode) {
    connect();
    return;
  }
  void (async () => {
    const srv = resolveServer();
    if (!srv) return;
    const session = await ensureSession(srv.base, srv.nick);
    if (!session) return; // status line already explains (password / refused)
    const join = await fetchJoinToken(srv.base, id, session);
    if (!join) return;
    pendingJoinToken = join.token;
    connect();
  })();
}

// Open a session in its OWN browser tab (deep-link «?join=<id>»): the hub/browser stays in
// THIS tab while the match runs in a fresh one, which boots straight into it from the shared
// same-origin localStorage identity (nick / session JWT). Popup blocked → join in this tab so
// the player is never left stuck. (On the APK / a file:// page window.open may hand off to the
// system browser; the deployed https origin is the intended path.)
function openSessionTab(id: string): void {
  const w = window.open(`${location.pathname}?join=${encodeURIComponent(id)}`, '_blank');
  if (!w) connectToMatch(id);
}

async function refreshMatches(quiet = false): Promise<void> {
  const srv = resolveServer();
  if (!srv) return;
  // quiet = a background re-poll (player build): don't flash «загрузка…» over a
  // list that is already on screen — only a real state change repaints.
  if (!quiet) statusEl.textContent = t('загрузка матчей…');
  // Identity mode first (SES-2.5): accounts servers get the password row shown
  // BEFORE the player clicks «Войти» on a row — no surprise prompt mid-join.
  await probeAuthMode(srv.base);
  try {
    const res = await fetch(`${httpBase(srv.base)}/matches?nick=${encodeURIComponent(srv.nick)}`);
    if (!res.ok) throw new Error('http ' + res.status);
    matchLists = (await res.json()) as Record<MatchTab, MatchRow[]>;
    localStorage.setItem('void.server', srv.base);
    localStorage.setItem('void.nick', srv.nick);
    statusEl.textContent = '';
  } catch {
    matchLists = null;
    statusEl.textContent = t('сервер недоступен');
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
      statusEl.textContent = restore ? t('не удалось восстановить') : t('не удалось в архив');
      return;
    }
    await refreshMatches();
  } catch {
    statusEl.textContent = t('ошибка архива');
  }
}

function renderMatches(): void {
  const el = $('mlist');
  const failed = statusEl.textContent === t('сервер недоступен');
  if (__PLAYER_BUILD__) {
    // The player screen is ONLY the three tabs + the list. The hidden server row
    // resurfaces exactly while the list can't be loaded (an APK has no useful page
    // origin — the player types the host's address once, then it hides again), and
    // the status line is not duplicated under the list's own message.
    const srvRow = srvInput.closest('.cfield') as HTMLElement | null;
    if (srvRow) srvRow.style.display = matchLists ? 'none' : '';
    if (failed) statusEl.textContent = '';
  }
  // Never a dead end: whatever the server says (unreachable / empty list), the dev
  // client offers the path that ALWAYS works — a solo skirmish offline. The player
  // build has no single-player, so it states the situation honestly instead.
  const soloCard = (msg: string): void => {
    el.innerHTML =
      `<div class="mempty">${msg}</div>` +
      `<div class="msolo"><button class="mbtn" id="msolo-go">▶ ${t('Одиночный режим')}</button>` +
      `<div class="msolo-sub">${t('Сервер не нужен — свободные места займут боты.')}</div></div>`;
    document.getElementById('msolo-go')?.addEventListener('click', () => {
      userClosed = true;
      NET = false;
      openSetup('hub');
    });
  };
  if (!matchLists) {
    soloCard(
      failed
        ? __PLAYER_BUILD__
          ? t('сервер недоступен — укажи адрес сервера')
          : t('сервер недоступен')
        : __PLAYER_BUILD__
          ? t('загрузка матчей…')
          : t('нажмите «Обновить список»'),
    );
    return;
  }
  const rows = matchLists[activeTab] ?? [];
  if (rows.length === 0) {
    soloCard(t('здесь пусто'));
    return;
  }
  el.textContent = '';
  for (const m of rows) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const info = document.createElement('div');
    info.className = 'minfo';
    // Entry window (SES-2.4): on «Доступные», show how long a newcomer may still take a
    // seat — the server already drops fully-closed sessions from this tab, so an open
    // countdown reassures, a soon-to-close one nudges. Unbounded (dev / old server) or
    // other tabs: omitted. Own «Активные»/«Архив» rows don't gate a reconnect, so no
    // window there.
    let windowLine = '';
    if (activeTab === 'available' && m.entryClosesInMs !== undefined) {
      if (m.entryOpen === false) {
        windowLine = ` · <span class="mwin shut">${t('вход закрыт')}</span>`;
      } else if (m.entryClosesInMs < ENTRY_UNBOUNDED_MS) {
        const soon = m.entryClosesInMs < 24 * 60 * 60 * 1000; // under a real day left
        windowLine = ` · <span class="mwin${soon ? ' soon' : ''}">${t('вход ещё {dur}', { dur: fmtJoinWindow(m.entryClosesInMs) })}</span>`;
      }
    }
    info.innerHTML =
      `<div class="mname">${esc(m.mapId)} <span class="mid">${esc(m.matchId)}</span></div>` +
      `<div class="mmeta">${t('День {n}', { n: m.days })} · ${t('{s}/{c} игроков', { s: m.players.seated, c: m.players.capacity })} · ` +
      `${esc(ruleSummary(m.rules))} · ${m.status === 'ended' ? t('завершён') : t('идёт')}${windowLine}</div>`;
    row.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'mbtns';
    const join = document.createElement('button');
    join.className = 'mbtn';
    join.textContent = t('Войти');
    join.addEventListener('click', () => openSessionTab(m.matchId));
    btns.appendChild(join);
    if (activeTab !== 'available') {
      const restore = activeTab === 'archived';
      const arch = document.createElement('button');
      arch.className = 'mbtn ghost';
      arch.textContent = restore ? t('Восстановить') : t('В архив');
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

// Player build: the match screen is ONLY the tabs + list (Доступные/Активные/Архив).
// The callsign comes from the welcome/hub identity step and the server from the page
// origin, so their rows are noise here — hidden, NOT removed: the inputs stay in the
// DOM as the state carriers resolveServer() reads. The server row resurfaces from
// renderMatches only while the list can't be loaded (see there). With no «Обновить
// список» button, the open screen keeps itself fresh instead: a quiet 10s re-poll
// plus an immediate reload when the player edits the server address.
if (__PLAYER_BUILD__) {
  const browseEl = $('cbrowse');
  const hide = (n: Element | null): void => {
    if (n) (n as HTMLElement).style.display = 'none';
  };
  hide(browseEl.querySelector('.csub'));
  hide(nickInput.closest('.cfield'));
  hide(srvInput.closest('.cfield'));
  hide($('cgo').closest('.crow'));
  srvInput.addEventListener('change', () => void refreshMatches());
  setInterval(() => {
    if (connectEl.style.display === 'none') return; // overlay closed (hub / in match)
    if (browseEl.style.display === 'none') return; // welcome stage, not the browser
    void refreshMatches(true);
  }, 10_000);
}

// The match browser (stage 2) loads its list on entry — "Новый командир" / "Вход"
// call refreshMatches() themselves; nothing to prefetch while the clean welcome is up.

// Auto-reconnect after an unexpected drop: rejoin our seat with capped exponential backoff
// (1,2,4,8,8,… s). The budget (`reconnectDelayMs`, NETA2-2) OUTLASTS the server's ~30s
// socket-reap window on purpose — a reconnect within the reap must not give up before the
// old socket frees the seat (else it loses the race with `E_SLOT_TAKEN`). Same saved
// server + nick → same side.
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = reconnectDelayMs(reconnectAttempts);
  if (delay === null) {
    reconnecting = false;
    reconnectAttempts = 0;
    banner = null;
    statusEl.textContent = t('Переподключение не удалось — войди заново');
    showConnect(true);
    return;
  }
  banner = t('⟳ переподключение…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!authMode) {
      connect(); // reuse the saved server + nick; don't reset the attempt counter
      return;
    }
    // Accounts mode (SES-2.5): the join token is short-lived (15 min), so a redial
    // mints a fresh one off the long-lived session first; an expired session drops
    // the redial to the connect screen with «введите пароль» (fail-explicit).
    void (async () => {
      const srv = resolveServer();
      const session = srv ? sessionToken(srv.base) : null;
      if (!srv || !session) {
        reconnecting = false;
        banner = null;
        showConnect(true);
        return;
      }
      const join = await fetchJoinToken(srv.base, currentMatchId, session);
      if (!join) {
        scheduleReconnect(); // transient (or session expired — status line explains)
        return;
      }
      pendingJoinToken = join.token;
      connect();
    })();
  }, delay);
}

// --- loop --------------------------------------------------------------------

const fpsEl = $('fps');
// Dev FX lab (dev client + DEV_UI only): push a demo siege volley between two nodes
// without staging a real standoff duel — for design review and the FX screenshot
// tests. Compiled out of the player build (dev tooling, not diagnostics).
if (!__PLAYER_BUILD__ && DEV_UI && typeof window !== 'undefined') {
  (window as unknown as { __vdFx?: object }).__vdFx = {
    // e2e probe: page-space anchors of own fleets and all worlds — lets a browser
    // test tap real map objects without guessing coordinates. Dev chrome, read-only.
    probe(): {
      fleets: Array<{ id: string; x: number; y: number }>;
      worlds: Array<{ id: string; x: number; y: number; owner: string | null }>;
    } {
      const r = canvas.getBoundingClientRect();
      const sx = (p: { x: number; y: number }) => ({
        x: r.left + (p.x / VW) * r.width,
        y: r.top + (p.y / VH) * r.height,
      });
      return {
        fleets: Object.values(s.fleets)
          .filter((f) => f.owner === ME)
          .map((f) => ({ id: f.id, ...sx(fleetAnchor(f)) })),
        worlds: Object.values(s.planets).map((p) => ({
          id: p.id,
          owner: p.owner,
          ...sx(world(p.position)),
        })),
      };
    },
    // Stock the first own fleet with hold cargo (squadrons in the hold + landing
    // troops + a fake in-progress load) so the emblem's cargo tail can be previewed
    // without building a carrier — dev chrome, mutates local state only.
    stockFleet(): string | null {
      const f = Object.values(s.fleets).find((x) => x.owner === ME);
      if (!f) return null;
      const wing = f.units.find((st) => isSquadron(st.unit));
      if (wing) wing.count += 2;
      else f.units.push({ unit: 'fighter_squadron', count: 2 });
      (f.landing ??= []).push({ unit: 'militia', count: 2 });
      pendingLoads.push({
        fleetId: f.id,
        unit: 'fighter_squadron',
        startAt: s.time,
        doneAt: s.time + LOAD_TIME,
      });
      return f.id;
    },
    pushSiege(fromId: string, toId: string): boolean {
      const a = s.planets[fromId]?.position;
      const b = s.planets[toId]?.position;
      if (!a || !b) return false;
      siegeShots.push({ from: { ...a }, to: { ...b }, at: performance.now(), seed: siegeSeed++ });
      return true;
    },
    // Preview the capture wave over a province without staging a real ground battle.
    flashCapture(node: string, owner: string): boolean {
      if (!s.planets[node]) return false;
      captureFlashes.set(node, { owner, at: performance.now() });
      return true;
    },
    // Force the match to a terminal state so the end screen can be previewed without
    // grinding to a score/elimination win. Seeds a plausible score if the victory
    // module hasn't populated one yet; checkEnd then paints the overlay.
    endMatch(outcome: 'win' | 'lose' | 'draw'): boolean {
      const m = s.match;
      if (!m) return false;
      m.status = 'ended';
      m.reason = 'score';
      m.endedAt = s.time;
      m.winner = outcome === 'draw' ? null : outcome === 'win' ? ME : ME === 'p1' ? 'p2' : 'p1';
      m.scores ??= {};
      for (const id of Object.keys(s.players)) {
        m.scores[id] ??= {
          controlledPlanets: worldsOf(id),
          fleets: 0,
          units: 0,
          total: worldsOf(id) * 50,
        };
      }
      return true;
    },
  };
}
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
// --- Android Back / Escape = close the top UI layer (APK + desktop) -----------
// The APK's WebView maps the hardware Back to history.back(); desktop maps Escape
// (below). While ANY closable layer is open — OR a match is simply live — we keep
// ONE sentinel entry pushed: Back pops the sentinel (popstate), we close the
// topmost layer and re-arm. With nothing left to close AND a match running, the
// first Back only shows a "press again to leave" hint (BF-17-adjacent: a bare
// in-match Back used to silently unload the page and lose the solo match); a
// second Back within the window is the system's (exit). Browser Back is the same.
let backArmed = false;
// Double-back-to-leave window: after the hint we stop re-arming the sentinel for
// this long, so a second Back within the window is the system's. `performance.now()`
// is fine here (prototype UI, not the deterministic core).
const BACK_EXIT_WINDOW_MS = 2500;
let backHintAt = -Infinity;

/** In a live match (the map backdrop), i.e. none of the chrome SCREENS is up. The
 *  three toggle `display` between 'flex'/'none'; on a fresh boot they read '' (CSS
 *  default) ≠ 'none', so this is false until the player actually enters a match —
 *  exactly when Back must stop silently unloading the page. */
function inMatch(): boolean {
  return (
    connectEl.style.display === 'none' &&
    hubEl.style.display === 'none' &&
    setupEl.style.display === 'none'
  );
}

/** Is any layer open that the Back button should close (probe only)? */
function topLayerOpen(): boolean {
  return Boolean(
    aiming ||
    assaultAim ||
    merging ||
    barrageAim ||
    pingMenuLoc !== null ||
    pingPopEl?.classList.contains('show') ||
    splitState !== null ||
    codexEl?.classList.contains('show') ||
    logWin?.classList.contains('show') ||
    techWin.classList.contains('show') ||
    divDesignWin.classList.contains('show') ||
    marketWin.classList.contains('show') ||
    diploOpen ||
    chatOpen ||
    setupEl.style.display !== 'none' ||
    selFleet !== null ||
    selPlanet !== null ||
    selFleets.size > 0,
  );
}

/** Close the TOPMOST open layer; returns false when nothing was open. The order
 *  mirrors visual stacking: armed order modes → popups → windows → menus →
 *  the selection sheet → the setup screen. */
function closeTopLayer(): boolean {
  if (aiming || assaultAim || merging || barrageAim) {
    aiming = false;
    assaultAim = false;
    merging = false;
    barrageAim = false;
    lastPanelHtml = '';
    return true;
  }
  if (pingMenuLoc !== null) {
    closePingMenu();
    return true;
  }
  if (pingPopEl?.classList.contains('show')) {
    closePingPop();
    return true;
  }
  if (splitState !== null) {
    splitState = null;
    lastPanelHtml = '';
    return true;
  }
  if (codexEl?.classList.contains('show')) {
    codexEl.classList.remove('show');
    return true;
  }
  if (logWin?.classList.contains('show')) {
    logWin.classList.remove('show');
    return true;
  }
  if (techWin.classList.contains('show')) {
    techWin.classList.remove('show');
    return true;
  }
  if (divDesignWin.classList.contains('show')) {
    divDesignWin.classList.remove('show');
    lastPanelHtml = '';
    return true;
  }
  if (marketWin.classList.contains('show')) {
    marketWin.classList.remove('show');
    return true;
  }
  if (diploOpen) {
    closeDiplo();
    return true;
  }
  if (chatOpen) {
    closeChat();
    return true;
  }
  if (selFleet !== null || selPlanet !== null || selFleets.size > 0) {
    clearSelection();
    return true;
  }
  if (setupEl.style.display !== 'none') {
    ($('setupcancel') as HTMLButtonElement | null)?.click(); // its own Back path (hub/welcome)
    return true;
  }
  return false;
}

window.addEventListener('popstate', () => {
  backArmed = false;
  if (closeTopLayer()) {
    if (topLayerOpen() || inMatch()) armBack(); // more layers / still in a match — stay
    return;
  }
  if (inMatch()) {
    // Nothing left to close but a match is live — don't let one stray Back drop it.
    // Show the hint and DON'T re-arm; during the exit window `frame()` won't re-arm
    // either, so a second Back within it is the system's (leaves the match).
    backHintAt = performance.now();
    note(t('Ещё раз «Назад» — выход из матча'));
    return;
  }
  note(t('Ещё раз «Назад» — выход')); // at the hub/welcome — the next Back exits
});
function armBack(): void {
  if (backArmed) return;
  history.pushState({ layer: true }, '');
  backArmed = true;
}

// Desktop parity: Escape closes the topmost layer, exactly like Back. Ignored while
// typing (chat / nick / server inputs) so Escape still blurs a field the native way.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' && e.key !== 'Esc') return;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (closeTopLayer()) e.preventDefault();
});

function frame(nowReal: number) {
  // Keep the Back sentinel armed while something is closable OR a match is live (so a
  // bare in-match Back triggers the double-back hint instead of a silent unload) —
  // but pause re-arming for the exit window after the hint, so the second Back leaves.
  const matchGuard = inMatch() && performance.now() - backHintAt > BACK_EXIT_WINDOW_MS;
  if (!backArmed && (topLayerOpen() || matchGuard)) armBack();
  const dt = nowReal - lastReal;
  lastReal = nowReal;
  // smooth FPS; ignore absurd gaps (tab backgrounded) so the readout stays sane
  if (dt > 0 && dt < 1000) fpsEma = fpsEma * 0.9 + (1000 / dt) * 0.1;
  if (!NET && speed > 0 && !banner && !endScreen) {
    // Local single-player sim. In net mode the server owns the clock, combat,
    // construction and every rival — a connected human, or the server-side AI for
    // an empty seat — so we only render its snapshots (no local AI runs here).
    // A finished match (endScreen set) freezes the world — no advancing a decided game.
    const target = s.time + (dt / 1000) * speed * HOUR;
    apply(advance(s, target));
    autoEngage();
    pumpAssaultOrders();
    checkFleetClashes();
    drivePatrols(); // CC-4: squadrons on дежурный вылет auto-strike contacts in range
    driveChains(); // CC-1: advance fleet order chains (wait → move → assault/barrage)
    runAI();
    pumpBuildQueues();
    closeIdleRallies(); // drop the 'rally' tag once a world's build pipeline empties
  }
  // Aimed ШТУРМ resolves in net too: the server drives fleet travel and the arrival
  // battle, and the client issues the ground assault once the fleet is parked on the
  // target world. (Solo pumps it inside the sim block above; in both modes assaultOnArrival
  // stays empty until a ШТУРМ is actually aimed, so this is a no-op otherwise.)
  if (NET) pumpAssaultOrders();
  updateGoals(); // ONB-7: tick the first-session checklist off live state (no-op when idle)
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
    `<span id="clock">${t('День {n}', { n: d })} · ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}</span>` +
    `<span class="dstat${need === 0 ? ' win' : ''}">✦ ${score}/${SCORE_LIMIT}${need === 0 ? ' · ★ ' + t('ПОБЕДА') : ''}</span>` +
    `<span class="dl-donate" title="${t('Суверены — донат-валюта')}"><i>◆</i>${kfmt(SOVEREIGNS)}</span>`;
  if (statusHtml !== lastClockText) {
    devlineEl.innerHTML = statusHtml;
    lastClockText = statusHtml;
  }

  // Dev net overlay (M0): FPS; when connected, append round-trip latency and a
  // desync flag (✓ in sync with the server, ✗ + running mismatch count if not).
  // Hidden from players (dev chrome) — EXCEPT on a live desync, which everyone
  // must be able to see and report.
  if (DEV_UI || (NET && netDesync)) {
    let fpsText = `${Math.round(fpsEma)} FPS`;
    if (NET) {
      const rtt = rttEma === null ? '· · ms' : `${Math.round(rttEma)} ms`;
      const sync = netDesync ? `desync ✗ ${netDesyncCount}` : 'sync ✓';
      fpsText += ` · ${rtt} · ${sync}`;
    }
    if (BUILD_TAG) fpsText += ` · ${BUILD_TAG}`; // running build, visible in dev
    if (fpsText !== lastFpsText) {
      fpsEl.textContent = fpsText;
      fpsEl.style.color = NET && netDesync ? 'var(--red, #ff5a4d)' : '';
      lastFpsText = fpsText;
    }
  } else if (lastFpsText !== '') {
    fpsEl.textContent = '';
    lastFpsText = '';
  }
  // Top bar = the five session resources (icon + amount). The donate currency (Суверены ◆)
  // is rendered separately on the status line right under this bar (see statusHtml above).
  const r = s.players[ME]?.resources ?? {};
  // Monochrome line glyphs from the console's own icon family (no emoji variants, so
  // they render as text, not colour emoji). Name in `title` for hover/long-press.
  // Flow under the stock: the tested netIncome() (production − upkeep, per hour)
  // finally shown to the player. A resource with no stock AND no flow is dimmed —
  // it plays no part in the current match yet.
  const inc = netIncome(s, ME);
  const myArrears = s.players[ME]?.arrears ?? [];
  const chip = (icon: string, key: string, name: string) => {
    const stock = r[key] ?? 0;
    const raw = inc[key] ?? 0;
    // Building/army upkeep makes sub-1/h drains common — one decimal keeps a slow
    // bleed visible instead of rounding it to a lying zero.
    const flow = Math.abs(raw) >= 1 ? Math.round(raw) : Math.round(raw * 10) / 10;
    // A phone bar has no room for flow digits: the chip carries only the stock, a
    // negative net flow paints that stock red, and the exact rate lives behind a tap
    // (the #purse click handler). Desktop keeps the inline ±N/ч readout.
    const flowTxt =
      !MOBILE && flow !== 0
        ? `<em class="${flow > 0 ? 'up' : 'dn'}">${flow > 0 ? '+' : ''}${Math.abs(flow) >= 1 ? kfmt(flow) : flow}/ч</em>`
        : '';
    const dead = stock === 0 && flow === 0 ? ' dead' : '';
    // Unpaid upkeep on this resource → the chip flags the brownout (tap it for words).
    const short = myArrears.includes(key) ? ' short' : '';
    const bleed = MOBILE && flow < 0 ? ' class="neg"' : '';
    return `<span class="res${dead}${short}" title="${tData(name)}" data-res="${key}"><i>${icon}</i><span class="rv"><b${bleed}>${kfmt(stock)}</b>${short ? '<em class="dn">⚠</em>' : flowTxt}</span></span>`;
  };
  const hudHtml =
    chip('¤', 'credits', 'Credits') +
    chip('❖', 'food', 'Food') +
    chip('⬢', 'metal', 'Metal') +
    chip('↯', 'energy', 'Energy') +
    chip('▦', 'microelectronics', 'Microelectronics');
  if (hudHtml !== lastHudHtml) {
    purse.innerHTML = hudHtml;
    lastHudHtml = hudHtml;
  }
  const msgBadge = document.getElementById('msgbadge');
  if (msgBadge) {
    msgBadge.style.display = unreadMsgs > 0 ? '' : 'none';
    msgBadge.textContent = String(unreadMsgs);
  }
  const battles = Object.values(s.battles).filter(
    (b) => b.attacker.owner === ME || b.defender.owner === ME || known(b.location),
  ).length;
  const alertText = String(battles);
  if (alertText !== lastAlertText) {
    alertBadge.style.display = battles > 0 ? 'grid' : 'none';
    alertBadge.textContent = alertText;
    lastAlertText = alertText;
  }
  // collapsed rail mirrors unread/battle attention onto the hamburger, so notifications
  // still surface while the tool panel (with its per-tool badges) is closed.
  const attn = battles + unreadMsgs;
  const railAlertText = attn > 0 && !railEl.classList.contains('open') ? String(attn) : '';
  if (railAlertText !== lastRailAlert) {
    railAlert.style.display = railAlertText ? 'grid' : 'none';
    if (railAlertText) railAlert.textContent = railAlertText;
    lastRailAlert = railAlertText;
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
      ? `<div class="bn-text">${esc(banner)}</div><button class="bn-btn" data-restart>${t('⟳ К выбору ботов')}</button>`
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
  renderEndScreen();
  // Speedbar restart — only the no-bots sandbox (no match end to restart from); other
  // modes use the end-banner button instead. Toggle each frame as the mode can change.
  // Player build: the button (and the skirmish it restarts into) doesn't exist.
  if (!__PLAYER_BUILD__) {
    const soloNoBots = !NET && AI_PLAYERS.size === 0;
    restartBtn.style.display = soloNoBots ? '' : 'none';
    restartSep.style.display = soloNoBots ? '' : 'none';
  }
  // Speedbar time controls. PC: gated by the developer «speed control» toggle — off
  // for a normal player, so the whole bar (its ⌂/▶▶ are PC-hidden in CSS) disappears.
  // Mobile is frozen: the exit ⌂ lives in the bar there (the rail exit is PC-only), so
  // the bar always shows and the controls follow the old solo/NET rule.
  const showSpdCtl = pcUi() ? devSpeedControl : !NET || !__PLAYER_BUILD__;
  if (spdCtl && spdCtl.style.display !== (showSpdCtl ? '' : 'none')) {
    spdCtl.style.display = showSpdCtl ? '' : 'none';
  }
  const showBar = pcUi() ? devSpeedControl : true;
  if (speedbarEl && speedbarEl.style.display !== (showBar ? '' : 'none')) {
    speedbarEl.style.display = showBar ? '' : 'none';
  }
  // Keep the tech window live while open (research progress bar / eta), throttled.
  if (techWin.classList.contains('show') && nowReal - lastTechAt > 500) {
    lastTechAt = nowReal;
    renderTech();
  }
  // Keep the steward window live while open (countdown to control returning), throttled.
  if (stewWin.classList.contains('show') && nowReal - lastStewAt > 500) {
    lastStewAt = nowReal;
    renderSteward();
  }
  // Intel windows tick in hours — a lazy 5s refresh keeps the «Шпионаж» timers honest.
  if (diploOpen && diploTab === 'intel' && nowReal - lastIntelAt > 5000) {
    lastIntelAt = nowReal;
    renderDiplo();
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
// the left crest (emblem + title) opens the player dossier
document.querySelector('.crest')?.addEventListener('click', () => openPlayerCard());

// mirror the chosen emblem into the top-left corner + the hub avatar
applyEmblem();

// collapsible rail — the hamburger toggles the tool panel; picking a tool closes it.
function setRailOpen(open: boolean): void {
  railEl.classList.toggle('open', open);
  railGlyph.textContent = open ? '✕' : '☰';
  railToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
railToggle.addEventListener('click', () => setRailOpen(!railEl.classList.contains('open')));
document.getElementById('railtools')?.addEventListener('click', () => setRailOpen(false));

// emblem picker — the hub avatar opens a glyph grid; picking one persists + applies it.
const emblemPick = document.getElementById('emblempick');
const epGrid = document.getElementById('ep-grid');
function openEmblemPick(): void {
  if (!emblemPick || !epGrid) return;
  const cur = playerEmblem();
  epGrid.innerHTML = EMBLEMS.map(
    (g) =>
      `<button type="button" class="ep-cell${g === cur ? ' sel' : ''}" data-emblem="${g}">${g}</button>`,
  ).join('');
  emblemPick.classList.add('show');
}
document.getElementById('hubav')?.addEventListener('click', openEmblemPick);
document
  .getElementById('ep-close')
  ?.addEventListener('click', () => emblemPick?.classList.remove('show'));
emblemPick?.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'emblempick') {
    emblemPick.classList.remove('show'); // backdrop tap closes
    return;
  }
  const cell = t.closest('.ep-cell') as HTMLElement | null;
  if (cell?.dataset.emblem) {
    setPlayerEmblem(cell.dataset.emblem);
    emblemPick.classList.remove('show');
  }
});

const playerCardEl = document.getElementById('playercard');
if (playerCardEl) {
  playerCardEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.id === 'playercard' || tg.classList.contains('pc-close'))
      playerCardEl.classList.remove('show');
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
document.getElementById('rail-diplo')?.addEventListener('click', () => {
  openDiplo('diplo');
  maybeIntro('diplomacy');
});
document.getElementById('rail-msgs')?.addEventListener('click', () => {
  unreadMsgs = 0; // reading the tab clears the badge
  openDiplo('msgs');
});

// === floating chat window (desktop only) =====================================
// A naive profanity scrub for the optional censor toggle — whole-word match, the
// letters swapped for asterisks (length kept so the line doesn't reflow).
const CHAT_BADWORDS = ['идиот', 'дурак', 'тупой', 'damn', 'hell', 'crap'];
function censorText(text: string): string {
  let out = text;
  for (const w of CHAT_BADWORDS)
    out = out.replace(new RegExp(w, 'gi'), (m) => '*'.repeat(m.length));
  return out;
}
/** The chat's tabs: the three fixed group rooms, then a tab per DM that exists (plus
 *  the open one). Other rooms (e.g. a coalition-to-coalition line) join here later. */
function chatChannels(): Array<{ key: string; label: string; icon: string }> {
  const base = [
    { key: CH_SESSION, label: t('Сессия'), icon: '△' },
    { key: CH_GLOBAL, label: t('Глобальный'), icon: '🌐' },
    { key: COALITION, label: t('Коалиция'), icon: '⬡' },
  ];
  const dm = new Set<string>();
  for (const m of sessionMessages) {
    if (GROUP_CHANNELS.has(m.to)) continue;
    if (m.from === ME) dm.add(m.to);
    else if (m.to === ME) dm.add(m.from);
  }
  if (!GROUP_CHANNELS.has(chatTab)) dm.add(chatTab); // keep a freshly opened DM's tab
  for (const id of dm)
    if (s.players[id]) base.push({ key: id, label: NAME[id] ?? id, icon: seatBadge(id).icon });
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
  if (!msgs.length)
    return `<div class="cw-empty">${t('Канал «{ch}» пуст.', { ch: esc(chatChannelLabel(key)) })}<br>${t('Напишите первое сообщение.')}</div>`;
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
    `<h4>${t('НАСТРОЙКИ')}</h4>` +
    `<div class="cw-srow"><label>${t('Размер h,w')}</label>` +
    `<input type="number" data-cset="h" min="150" max="${maxH}" value="${chatGeom.h}">` +
    `<input type="number" data-cset="w" min="220" max="${maxW}" value="${chatGeom.w}"></div>` +
    `<div class="cw-srow"><label>${t('Шрифт, пт')}</label><input type="number" data-cset="font" min="8" max="42" value="${chatCfg.fontPx}"></div>` +
    `<div class="cw-srow"><label>${t('Цвет шрифта')}</label><input type="color" data-cset="color" value="#7fe7ff" disabled><span class="cw-sub">🔒 ${t('подписка')}</span></div>` +
    `<div class="cw-srow"><label>${t('Цензура')}</label><input type="checkbox" data-cset="censor"${chk(chatCfg.censor)}></div>` +
    `<div class="cw-srow"><label>${t('Прозрачность')}</label><input type="range" data-cset="opacity" min="0" max="100" value="${chatCfg.transparency}"><span class="cw-opval">${chatCfg.transparency}%</span></div>` +
    `<div class="cw-shdr">${t('Штамп сообщений')}</div>` +
    `<div class="cw-srow"><label>${t('День')}</label><input type="checkbox" data-cset="showDay"${chk(chatCfg.showDay)}></div>` +
    `<div class="cw-srow"><label>${t('Время')}</label><input type="checkbox" data-cset="showTime"${chk(chatCfg.showTime)}></div>` +
    `<div class="cw-srow"><label>${t('Реальное время')}</label><input type="checkbox" data-cset="showReal"${chk(chatCfg.showReal)}></div>` +
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
    `<div class="cw-head" data-cwhead title="${chatPinned ? '' : t('Тащите за шапку, чтобы переместить')}">` +
    `<span class="cw-title">${t('ЧАТ — {ch}', { ch: esc(chatChannelLabel(chatTab)) })}</span>` +
    `<button class="cw-btn${chatPinned ? ' on' : ''}" data-cwact="pin" title="${t('Закрепить размер и положение')}">📎</button>` +
    `<button class="cw-btn${chatSettingsOpen ? ' on' : ''}" data-cwact="settings" title="${t('Настройки')}">⚙</button>` +
    `<button class="cw-btn" data-cwact="min" title="${chatMin ? t('Развернуть') : t('Свернуть')}">${chatMin ? '▢' : '—'}</button>` +
    `</div>` +
    `<div class="cw-tabs">${tabs}</div>` +
    `<div class="cw-feed" id="cw-feed">${chatFeedInnerHtml(chatTab)}</div>` +
    `<div class="cw-compose"><input id="cw-text" type="text" maxlength="240" placeholder="${t('Сообщение…')}" autocomplete="off"><button class="cw-send" data-cwact="send" title="${t('Отправить')}">▶</button></div>` +
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
    const v = JSON.parse(raw) as {
      cfg?: Partial<typeof chatCfg>;
      geom?: Partial<typeof chatGeom>;
      pinned?: boolean;
    };
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
  dispatchChat(chatTab, text); // NET: server relay + echo; solo: local append
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
document
  .getElementById('rail-chat')
  ?.addEventListener('click', () => (chatOpen ? closeChat() : openChat()));
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
  dispatchChat(convoOpen, text); // NET: server relay + echo; solo: local append
  if (input) {
    input.value = '';
    input.focus();
  }
}
/** Ping the selected province into the coalition channel — also a clickable map
 *  marker. The composer text becomes the marker's short description. */
function pingSelected(): void {
  if (!selPlanet || !s.planets[selPlanet]) {
    note(t('Сначала выберите провинцию на карте'));
    return;
  }
  const input = document.getElementById('dp-text') as HTMLInputElement | null;
  const desc = (input?.value.trim() ?? '').slice(0, 80);
  if (NET && netClient) {
    // The server is authoritative for pings: it stamps the marker and relays a
    // `ping.added` back to us + allies — that echo is what adds it (see onPingAdded).
    netClient.placePing({ kind: 'mark', target: { node: selPlanet }, label: desc });
  } else {
    pushMsg(COALITION, desc || t('метка {node}', { node: selPlanet }), false, ME, selPlanet);
  }
  if (input) {
    input.value = '';
    input.focus();
  }
}

// --- province ping composer (tap a province → choose where the ping goes) --------
// A ping marks a province and shares it. Destination is either the coalition channel
// (a shared on-map marker every ally sees) or a single player's DM (a private jump-to
// pointer in that thread). Opened from the province panel's 📍 button.
function openPingMenu(): void {
  if (!selPlanet || !s.planets[selPlanet]) {
    note(t('Сначала выберите провинцию'));
    return;
  }
  pingMenuLoc = selPlanet;
  renderPingMenu();
  document.getElementById('pingmenu')?.classList.add('show');
  (document.getElementById('pm-text') as HTMLInputElement | null)?.focus();
}
function closePingMenu(): void {
  pingMenuLoc = null;
  document.getElementById('pingmenu')?.classList.remove('show');
}
function renderPingMenu(): void {
  const el = document.getElementById('pingmenu');
  if (!el || !pingMenuLoc) return;
  const loc = pingMenuLoc;
  const dstBtn = (
    dest: string,
    color: string,
    ic: string,
    name: string,
    tag: string,
    cls = '',
  ): string =>
    `<button class="pm-dst${cls}" data-pmdest="${esc(dest)}">` +
    `<span class="pm-ic" style="color:${color}">${ic}</span>${esc(name)}` +
    (tag ? `<em>${esc(tag)}</em>` : '') +
    `</button>`;
  const coal = dstBtn(
    COALITION,
    'var(--amber)',
    '⚡',
    t('Коалиция'),
    t('{n} уч.', { n: coalitionMembers().length }),
    ' coal',
  );
  const dms = diploSeats()
    .filter((id) => id !== ME)
    .map((id) => dstBtn(id, ownerColor(id), seatBadge(id).icon, NAME[id] ?? id, seatBadge(id).tag))
    .join('');
  el.innerHTML =
    `<div class="pm-box">` +
    `<div class="pm-head">📍 ${t('Пинг')} · <b>${esc(loc)}</b></div>` +
    `<div class="pm-sub">${t('Отметьте провинцию и отправьте — метка станет кликабельной (↪ камера).')}</div>` +
    `<input id="pm-text" class="pm-text" maxlength="80" placeholder="${t('Описание метки (необязательно)…')}" autocomplete="off">` +
    `<div class="pm-lbl">${t('В чат коалиции')}</div>${coal}` +
    (dms ? `<div class="pm-lbl">${t('В ЛС игроку')}</div>${dms}` : '') +
    `<button class="pm-cancel" data-pmcancel>${t('Отмена')}</button>` +
    `</div>`;
}
/** Place the pending province ping toward `dest`: the coalition channel (shared on-map
 *  marker) or a player's DM (private jump-to pointer). Composer text = the description. */
function createPingTo(dest: string): void {
  const loc = pingMenuLoc;
  if (!loc || !s.planets[loc]) {
    closePingMenu();
    return;
  }
  const input = document.getElementById('pm-text') as HTMLInputElement | null;
  const desc = (input?.value.trim() ?? '').slice(0, 80);
  if (dest === COALITION) {
    // Same path as the coalition composer's 📍: net → server-stamped marker; solo → local line.
    if (NET && netClient) netClient.placePing({ kind: 'mark', target: { node: loc }, label: desc });
    else pushMsg(COALITION, desc || t('метка {loc}', { loc }), false, ME, loc);
    note(t('📍 Пинг → Коалиция'));
  } else {
    pushMsg(dest, desc || t('метка {loc}', { loc }), false, ME, loc);
    note(t('📍 Пинг → {who}', { who: NAME[dest] ?? dest }));
  }
  closePingMenu();
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
  sessionMessages = sessionMessages.filter(
    (m) => !(m.to === COALITION && m.ping === loc && m.from === ME),
  );
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
  const who = m.from === ME ? t('Вы') : (NAME[m.from] ?? m.from);
  const mine = m.from === ME;
  el.innerHTML =
    `<div class="pp-top"><b style="color:${ownerColor(m.from)}">📍 ${esc(who)}</b><span>${esc(loc)}</span></div>` +
    `<div class="pp-desc">${m.text ? esc(m.text) : `<i>${t('без описания')}</i>`}</div>` +
    `<div class="pp-act"><button class="pp-jump" data-loc="${esc(loc)}">${t('↪ камера')}</button>` +
    (mine ? `<button class="pp-del" data-loc="${esc(loc)}">${t('убрать')}</button>` : '') +
    `</div>`;
  el.style.left = `${Math.round(r.left + (c.x / VW) * r.width)}px`;
  el.style.top = `${Math.round(r.top + (c.y / VH) * r.height)}px`;
  el.classList.add('show');
}
function closePingPop(): void {
  document.getElementById('pingpop')?.classList.remove('show');
}

// --- TGT-1: target-order composer (CC-1 chains rendered target-side) ---------
/** BOOST-1: is this fleet on форс-марш? (authoritative map, both modes). */
function marchFlagged(fid: string): boolean {
  return (s as { forcedMarch?: Record<string, true> }).forcedMarch?.[fid] === true;
}
/** CC-1 plan of an OWN fleet — authoritative in both modes (the module runs in MODULES). */
function chainStepsOf(fid: string): ChainStep[] | null {
  const ch = (s as { orders?: Record<string, { steps: ChainStep[] }> }).orders?.[fid];
  return ch ? ch.steps : null;
}
/** The closest OWN world to `fromId` — the «Домой» leg of a composed plan. */
function nearestOwnWorld(fromId: string): string | null {
  const from = s.planets[fromId]?.position;
  if (!from) return null;
  let best: string | null = null;
  let bd = Infinity;
  for (const p of Object.values(s.planets)) {
    if (p.owner !== ME || p.id === fromId) continue;
    const d = Math.hypot(p.position.x - from.x, p.position.y - from.y);
    if (d < bd) {
      bd = d;
      best = p.id;
    }
  }
  return best;
}
function tgStepLabel(st: ChainStep, target: string): string {
  if (st.kind === 'wait') return t('⏱{n}ч', { n: st.hours });
  if (st.kind === 'move') return st.to === target ? '✈' : `✈ ${st.to}`;
  if (st.kind === 'assault') return '⚔';
  if (st.kind === 'strike') return t('🎯{n}ч', { n: st.hours });
  return '🎯';
}
/** Open the composer for `target`, editing the FIRST chained fleet's plan (or a
 *  fresh one). `fleetIds` — who the plan will be sent to (all owned, alive). */
function openTgtEditor(target: string, fleetIds: string[]): void {
  const mine = fleetIds.filter((id) => s.fleets[id]?.owner === ME);
  if (!mine.length || !s.planets[target]) return;
  tgtEditor = { fleetIds: mine, target, steps: [...(chainStepsOf(mine[0]!) ?? [])] };
  renderTgtEditor(true);
}
function closeTgtEditor(): void {
  tgtEditor = null;
  document.getElementById('tgted')?.classList.remove('show');
}
function renderTgtEditor(reposition = false): void {
  const el = document.getElementById('tgted');
  if (!el) return;
  if (!tgtEditor) {
    el.classList.remove('show');
    return;
  }
  const pl = s.planets[tgtEditor.target];
  const alive = tgtEditor.fleetIds.filter((id) => s.fleets[id]?.owner === ME);
  if (!pl || !alive.length) {
    closeTgtEditor();
    return;
  }
  tgtEditor.fleetIds = alive;
  const st = tgtEditor.steps;
  const full = st.length >= MAX_CHAIN_STEPS;
  const plan = st.length
    ? st
        .map(
          (x, i) =>
            `<button data-step="${i}" title="${t('убрать шаг')}">${esc(tgStepLabel(x, tgtEditor!.target))}</button>`,
        )
        .join('<i>→</i>')
    : `<i>${t('план пуст — добавь шаги')}</i>`;
  el.innerHTML =
    `<div class="tg-top"><b>◎ ${t('ПРИКАЗ')}</b><span>${esc(tgtEditor.target)}${
      alive.length > 1 ? ` · ${t('{n} флотов', { n: alive.length })}` : ''
    }</span></div>` +
    `<div class="tg-plan">${plan}</div>` +
    `<div class="tg-add">` +
    `<button data-tg="wait" ${full ? 'disabled' : ''}>${t('⏱ +1ч')}</button>` +
    `<button data-tg="move" ${full ? 'disabled' : ''}>✈ ${t('Сюда')}</button>` +
    `<button data-tg="assault" ${full ? 'disabled' : ''}>⚔ ${t('Штурм')}</button>` +
    `<button data-tg="barrage" ${full ? 'disabled' : ''}>🎯 ${t('Огонь')}</button>` +
    `<button data-tg="home" ${full || !nearestOwnWorld(tgtEditor.target) ? 'disabled' : ''}>⌂ ${t('Домой')}</button>` +
    `</div>` +
    `<div class="tg-act">` +
    `<button data-tg="send" ${st.length ? '' : 'disabled'}>✓ ${t('Отправить')}</button>` +
    `<button data-tg="drop" class="tg-drop" title="${t('снять приказ')}">✕</button>` +
    `</div>`;
  el.classList.add('show');
  if (reposition) {
    const c = world(pl.position);
    const r = canvas.getBoundingClientRect();
    el.style.left = `${Math.round(r.left + (c.x / VW) * r.width)}px`;
    el.style.top = `${Math.round(r.top + (c.y / VH) * r.height)}px`;
    // Clamp into the viewport — a target near a map edge must not clip the composer.
    const b = el.getBoundingClientRect();
    const minLeft = b.width / 2 + 6;
    const maxLeft = window.innerWidth - b.width / 2 - 6;
    el.style.left = `${Math.round(Math.min(maxLeft, Math.max(minLeft, parseFloat(el.style.left))))}px`;
    if (b.top < 96) el.style.top = `${Math.round(parseFloat(el.style.top) + (96 - b.top))}px`;
  }
}
document.getElementById('tgted')?.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('button');
  if (!btn || btn.disabled || !tgtEditor) return;
  if (btn.dataset.step !== undefined) {
    tgtEditor.steps.splice(Number(btn.dataset.step), 1); // tap a chip → drop that step
    renderTgtEditor();
    return;
  }
  const act = btn.dataset.tg;
  const st = tgtEditor.steps;
  if (act === 'wait') {
    const last = st[st.length - 1];
    if (last?.kind === 'wait') last.hours = Math.min(24 * 14, last.hours + 1);
    else st.push({ kind: 'wait', hours: 1 });
  } else if (act === 'move') {
    st.push({ kind: 'move', to: tgtEditor.target });
  } else if (act === 'assault') {
    st.push({ kind: 'assault' });
  } else if (act === 'barrage') {
    // Fire window (STRIKE-1): repeat taps grow the window by an hour, like Задержка.
    const last = st[st.length - 1];
    if (last?.kind === 'strike') last.hours = Math.min(24 * 14, last.hours + 1);
    else st.push({ kind: 'strike', target: null, hours: 1 });
  } else if (act === 'home') {
    const home = nearestOwnWorld(tgtEditor.target);
    if (home) st.push({ kind: 'move', to: home });
  } else if (act === 'send') {
    for (const id of tgtEditor.fleetIds) playerOrder(orderChain(ME, id, st));
    note(t('◎ приказ поставлен — флот исполнит план сам'));
    closeTgtEditor();
    return;
  } else if (act === 'drop') {
    for (const id of tgtEditor.fleetIds) if (chainStepsOf(id)) playerOrder(orderChain(ME, id, []));
    closeTgtEditor();
    return;
  }
  renderTgtEditor();
});
/** Draw a pin per active coalition ping (owner-coloured), recording screen hit-boxes
 *  for tap detection. Pins float just above the node, tip pointing at it. Two sonar
 *  rings expand from the marked node (half a period apart) and the pin head breathes
 *  an owner-coloured glow — a "look here" you can catch from across the map. Your
 *  own pins can be hidden with the settings switch (allies' are always drawn). */
function drawPings(now: number): void {
  pingHits = [];
  for (const m of activePings()) {
    if (m.from === ME && !showOwnPings) continue; // hidden by «Свои метки» switch
    const pl = s.planets[m.ping!];
    if (!pl) continue;
    const c = world(pl.position);
    if (!visible(c, 40)) continue;
    const x = c.x;
    const y = c.y - 22; // pin head floats above the node (плейтест: пинги крупнее)
    const col = ownerColor(m.from);
    const phase = x * 0.05; // de-syncs neighbouring pins so they don't blink in unison
    const pulse = 0.7 + 0.3 * Math.sin(now / 360 + phase);
    cx.save();
    // sonar waves: rings born at the node, growing and thinning out as they fade;
    // a newborn ring flashes a soft filled core so each wave visibly "drops in"
    cx.shadowColor = rgba(col, 0.7);
    for (const off of [0, 0.5]) {
      // 0 → 1 over one 2.2s period; double-mod keeps k positive when phase is
      // negative (a pin near the screen's left edge has x < 0 → JS % keeps sign,
      // and a negative k would feed cx.arc a negative radius = a thrown frame)
      const k = (((now / 2200 + off + phase) % 1) + 1) % 1;
      const rr = 6 + k * 40;
      if (k < 0.18) {
        cx.fillStyle = rgba(col, (1 - k / 0.18) * 0.28); // the drop-in flash
        cx.beginPath();
        cx.arc(c.x, c.y, rr, 0, TAU);
        cx.fill();
      }
      cx.shadowBlur = 6 * (1 - k);
      cx.strokeStyle = rgba(col, (1 - k) * 0.8);
      cx.lineWidth = 3.2 - k * 2.2;
      cx.beginPath();
      cx.arc(c.x, c.y, rr, 0, TAU);
      cx.stroke();
    }
    // the pin itself, breathing an owner-coloured glow (the dark stroke keeps contrast)
    cx.shadowColor = rgba(col, 0.85);
    cx.shadowBlur = 4 + 8 * pulse;
    cx.fillStyle = rgba(col, pulse);
    cx.strokeStyle = 'rgba(4,10,12,.85)';
    cx.lineWidth = 1.4;
    cx.beginPath(); // teardrop pin: head + tip toward the node
    cx.moveTo(x, y + 14);
    cx.lineTo(x - 6.5, y);
    cx.arc(x, y - 1, 7, Math.PI, 0);
    cx.lineTo(x, y + 14);
    cx.fill();
    cx.stroke();
    cx.shadowBlur = 0;
    cx.fillStyle = 'rgba(6,18,22,.95)';
    cx.beginPath();
    cx.arc(x, y - 1, 2.7, 0, TAU);
    cx.fill();
    cx.fillStyle = rgba(col, pulse); // a blinking ember in the pin's eye
    cx.beginPath();
    cx.arc(x, y - 1, 1.4, 0, TAU);
    cx.fill();
    cx.restore();
    pingHits.push({ loc: m.ping!, x, y: y - 1 });
  }
}

/** TGT-1: standing order markers — a breathing crosshair on every world an OWN
 *  chained fleet is planned against (last move leg; a legless plan anchors at the
 *  fleet's spot). The ◎ badge above the ring is the tap handle (screen hit-boxes,
 *  like pings) — tapping it re-opens the composer with the live plan. */
function drawTargetMarkers(now: number): void {
  tgtHits = [];
  const orders = (s as { orders?: Record<string, { steps: ChainStep[] }> }).orders;
  if (!orders) return;
  const byWorld = new Map<string, string[]>();
  for (const fid of Object.keys(orders).sort()) {
    const f = s.fleets[fid];
    if (!f || f.owner !== ME) continue;
    let anchor: string | null = null;
    for (const stp of orders[fid]!.steps) if (stp.kind === 'move') anchor = stp.to;
    anchor ??= f.location;
    if (!anchor || !s.planets[anchor]) continue;
    const arr = byWorld.get(anchor) ?? [];
    if (!arr.length) byWorld.set(anchor, arr);
    arr.push(fid);
  }
  const col = ownerColor(ME);
  for (const [wid, fids] of byWorld) {
    const c = world(s.planets[wid]!.position);
    const pulse = 0.55 + 0.45 * Math.sin(now / 260);
    const rr = 15 + 1.6 * Math.sin(now / 260);
    cx.save();
    cx.strokeStyle = rgba(col, 0.45 + 0.4 * pulse);
    cx.lineWidth = 1.6;
    cx.setLineDash([7, 5]);
    cx.lineDashOffset = -(now / 60) % 12; // slow spin — a "live" reticle
    cx.beginPath();
    cx.arc(c.x, c.y, rr, 0, TAU);
    cx.stroke();
    cx.setLineDash([]);
    for (let q = 0; q < 4; q++) {
      const a = (q * TAU) / 4 + now / 900;
      cx.beginPath();
      cx.moveTo(c.x + Math.cos(a) * (rr + 3), c.y + Math.sin(a) * (rr + 3));
      cx.lineTo(c.x + Math.cos(a) * (rr + 8), c.y + Math.sin(a) * (rr + 8));
      cx.stroke();
    }
    const bx = c.x;
    const by = c.y - rr - 14;
    cx.shadowColor = rgba(col, 0.8);
    cx.shadowBlur = 3 + 6 * pulse;
    cx.fillStyle = 'rgba(6,18,22,.92)';
    cx.strokeStyle = rgba(col, 0.9);
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.arc(bx, by, 7.5, 0, TAU);
    cx.fill();
    cx.stroke();
    cx.shadowBlur = 0;
    cx.beginPath();
    cx.arc(bx, by, 2.6, 0, TAU);
    cx.stroke();
    if (fids.length > 1) {
      cx.fillStyle = rgba(col, 0.95);
      cx.font = '700 8px ui-monospace,monospace';
      cx.textAlign = 'center';
      cx.fillText(String(fids.length), bx + 11, by - 5);
    }
    cx.restore();
    tgtHits.push({ target: wid, fleetIds: fids, x: bx, y: by });
  }
}
/** Tap a ping → fly the camera to that province (and select it); close the menu. */
/** Pan the camera to a world referenced from a plan row (data-goto) — selection stays
 *  untouched (the fleet panel must survive the tap) and a short ring marks the spot. */
let goFlash: { id: string; until: number } | null = null;
function focusWorld(id: string): void {
  const pl = s.planets[id];
  if (!pl) return;
  centerOn(pl.position, Math.max(cam.scale, 2.5));
  goFlash = { id, until: performance.now() + 1600 };
}
function drawGoFlash(now: number): void {
  if (!goFlash) return;
  if (now >= goFlash.until) {
    goFlash = null;
    return;
  }
  const pl = s.planets[goFlash.id];
  if (!pl) return;
  const c = world(pl.position);
  const k = (goFlash.until - now) / 1600; // 1 → 0 as it fades
  cx.save();
  cx.strokeStyle = rgba(LOCK, 0.25 + 0.55 * k);
  cx.lineWidth = 1.6;
  cx.setLineDash([4, 4]);
  cx.beginPath();
  cx.arc(c.x, c.y, 14 + (1 - k) * 10, 0, TAU);
  cx.stroke();
  cx.restore();
}
const CAPTURE_FLASH_MS = 1500;
/** A province that changed hands lights up in its NEW owner's colour: a bright wave
 *  sweeps across the flipped cell from its centre and the frontier ignites, fading
 *  over ~1.5s. The cell polygon is recomputed each frame with the SAME weighted-
 *  Voronoi math the political map bakes (computePowerCell), so the wave lines up
 *  pixel-for-pixel with the fill and tracks pan/zoom. Only runs while a flash is live
 *  (captures are rare), so the O(n) recompute costs nothing on a quiet frame. */
function drawCaptureFlashes(now: number): void {
  if (captureFlashes.size === 0) return;
  // Same seeds + clip the political fill uses, projected THIS frame so the wave
  // tracks the camera. Built once, shared by every concurrent flash.
  const W = 9000 * cam.scale * cam.scale;
  const seeds: TerritorySeed[] = [];
  const idxByNode = new Map<string, number>();
  for (const n of MAP) {
    if (n.sector === 'empty') continue;
    const p = s.planets[n.id];
    if (!p) continue;
    const c = world(n);
    idxByNode.set(n.id, seeds.length);
    seeds.push({ x: c.x, y: c.y, w: (p.size ?? 1) * W, owner: knownOwner(n.id), kind: n.sector });
  }
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
    cx.beginPath();
    cx.moveTo(poly[0]![0], poly[0]![1]);
    for (let i = 1; i < poly.length; i++) cx.lineTo(poly[i]![0], poly[i]![1]);
    cx.closePath();
  };
  for (const [node, flash] of captureFlashes) {
    const age = now - flash.at;
    if (age >= CAPTURE_FLASH_MS) {
      captureFlashes.delete(node);
      continue;
    }
    const idx = idxByNode.get(node);
    if (idx === undefined) continue; // province gone (shouldn't happen mid-flash)
    const cell = computePowerCell(seeds, clip, idx);
    if (!cell) continue;
    const c = { x: seeds[idx]!.x, y: seeds[idx]!.y }; // seeds are already screen-space
    // rAF's frame timestamp can predate the push by a hair → clamp so k ≥ 0 (a
    // negative radius throws from cx.arc).
    const k = Math.max(0, age) / CAPTURE_FLASH_MS; // 0 → 1
    const fade = 1 - k;
    const col = ownerColor(flash.owner);
    // cell radius (centre → farthest vertex) sets how far the wave travels
    let maxR = 0;
    for (const [px, py] of cell.poly) maxR = Math.max(maxR, Math.hypot(px - c.x, py - c.y));
    cx.save();
    // 1) colour wash of the whole cell, fading — the province "flips" to the new hue
    trace(cell.poly);
    cx.fillStyle = rgba(col, 0.3 * fade);
    cx.fill();
    // 2) the wave: a bright ring expanding from the centre, CLIPPED to the cell so it
    //    reads as energy sweeping across the province out to its border
    trace(cell.poly);
    cx.clip();
    cx.globalCompositeOperation = 'lighter';
    const rr = k * maxR * 1.25;
    cx.strokeStyle = rgba(col, 0.85 * fade);
    cx.lineWidth = 3 + 5 * fade;
    cx.shadowColor = col;
    cx.shadowBlur = 12 * fade;
    cx.beginPath();
    cx.arc(c.x, c.y, rr, 0, TAU);
    cx.stroke();
    cx.restore();
    // 3) the frontier igniting — the cell outline pulses bright then settles
    cx.save();
    trace(cell.poly);
    cx.strokeStyle = rgba(col, 0.9 * fade);
    cx.lineWidth = 1.5 + 2.5 * fade;
    cx.shadowColor = col;
    cx.shadowBlur = 8 * fade;
    cx.stroke();
    cx.restore();
  }
}
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
      diploTab = tab as 'diplo' | 'msgs' | 'intel';
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
    const spyBtn = tg.closest('.dp-spy') as HTMLElement | null;
    if (spyBtn) {
      playerOrder(spyOn(ME, spyBtn.dataset.seat!, spyBtn.dataset.spy as 'treasury' | 'fleets'));
      renderDiplo(); // the intel row (or the rejection note) reflects the outcome
      return;
    }
    const iw = (tg.closest('[data-iw]') as HTMLElement | null)?.dataset.iw;
    if (iw) {
      closeDiplo(); // карта должна быть видна — перелетаем к миру из окна интела
      focusWorld(iw);
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

// Province ping composer: a destination button places the ping; the backdrop or Отмена
// closes it; Enter in the note field defaults to the coalition channel.
const pingMenuEl = document.getElementById('pingmenu');
if (pingMenuEl) {
  pingMenuEl.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const dest = (tg.closest('.pm-dst') as HTMLElement | null)?.dataset.pmdest;
    if (dest) return createPingTo(dest);
    if (tg.closest('[data-pmcancel]') || tg === pingMenuEl) closePingMenu();
  });
  pingMenuEl.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (ke.target as HTMLElement).id === 'pm-text') {
      e.preventDefault();
      createPingTo(COALITION);
    } else if (ke.key === 'Escape') {
      closePingMenu();
    }
  });
}

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
    if (cver) cver.textContent = t('сборка {b}', { b: buildLabel(myBuild) });
    const cupd = $('cupd');
    if (cupd) cupd.style.display = '';

    const showUpdate = (u: UpdateInfo): void => {
      const ver = $('ub-ver');
      if (ver) ver.textContent = buildLabel(u);
      const go = $('ub-go') as HTMLAnchorElement | null;
      if (go) go.href = u.apkUrl;
      $('updbar').style.display = 'block'; // override the stylesheet's display:none
    };

    // A readable line for every check outcome, so a manual check can be TRACED — it tells
    // "you're up to date" apart from "the check couldn't reach GitHub".
    const diagMsg = (r: UpdateCheck): string => {
      switch (r.kind) {
        case 'update':
          return t('⬇ есть обновление → сборка {v}', { v: r.info.versionCode });
        case 'current':
          return t('✓ актуально · локально {l} · сервер {r}', { l: r.local, r: r.remote });
        case 'offline':
          return t('✗ нет связи с GitHub (сеть / VPN?)');
        case 'http':
          return t('✗ GitHub ответил {s}', { s: r.status });
        case 'unparsable':
          return t('✗ ответ получен, но версия не распознана');
        case 'dormant':
          return t('обновления доступны только в APK');
      }
    };
    let checking = false;
    const runCheck = async (manual: boolean, out?: HTMLElement | null): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const r = await checkForUpdateDetailed();
        if (r.kind === 'update') showUpdate(r.info);
        if (manual && out) {
          const prev = out.textContent;
          out.textContent = t('проверка: {msg}', { msg: diagMsg(r) });
          out.style.color = r.kind === 'offline' || r.kind === 'http' ? 'var(--amber)' : '';
          window.setTimeout(() => {
            out.textContent = prev;
            out.style.color = '';
          }, 8000);
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
    cupd?.addEventListener('click', () => void runCheck(true, cver));
    // The hub carries its own manual check (the returning-player path never shows
    // #connect); diagnostics land in the hub's note line.
    const hubUpd = document.getElementById('hub-upd');
    if (hubUpd) {
      hubUpd.style.display = '';
      hubUpd.addEventListener(
        'click',
        () => void runCheck(true, document.getElementById('hub-note')),
      );
    }
    // Silent re-checks: once at launch, whenever the app returns to the FOREGROUND
    // (the phone pattern — launch offline, open later on wifi), and every 4h for a
    // long-lived session. Throttled so foreground flapping can't hammer the API.
    const CHECK_GAP_MS = 15 * 60_000;
    let lastCheckAt = 0;
    const maybeCheck = (): void => {
      if (navigator.onLine === false) return;
      const now = Date.now();
      if (now - lastCheckAt < CHECK_GAP_MS) return;
      lastCheckAt = now;
      void runCheck(false);
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) maybeCheck();
    });
    window.setInterval(maybeCheck, 4 * 3_600_000);
    maybeCheck(); // launch check (throttle-stamped so a foreground right after boot is free)
  }
}

// --- corporation cabinet (AVA-C1/C2) -----------------------------------------
// The cross-session alliance ("corporation") management screen designed in
// docs/corporation-ui.md — the REAL screen now, over the live CORP-0/AVA-2..9/
// MED-1 HTTP API (packages/server/src/corpApi.ts/avaApi.ts/medalApi.ts). Scope
// follows the doc's own §7 degradation order: Обзор/Участники/Войны/Казна are
// real; Владения (sector ownership) and Чат (persistent corp chat) have no
// server counterpart at all (no meta-layer Контур 2 yet) and stay honest "скоро"
// stubs rather than simulated data.
const CORP_TABS: { id: string; label: string }[] = [
  { id: 'overview', label: 'Обзор' },
  { id: 'members', label: 'Участники' },
  { id: 'wars', label: 'Войны' },
  { id: 'treasury', label: 'Казна' },
  { id: 'holdings', label: 'Владения' },
  { id: 'comms', label: 'Чат' },
];
const CORP_ROLE_LABEL: Record<CorpRole, string> = {
  head: 'Глава',
  officer: 'Офицер',
  member: 'Участник',
  recruit: 'Заявка',
};
const corpRoleLabel = (r: CorpRole): string => t(CORP_ROLE_LABEL[r]);
const CORP_ROLE_DOT: Record<CorpRole, string> = {
  head: 'var(--cyan)',
  officer: 'var(--amber)',
  member: 'var(--dim)',
  recruit: 'var(--red)',
};
const CORP_AUDIT_RU: Record<string, string> = {
  create: 'создала корпорацию',
  accept: 'приняла заявку',
  decline: 'отклонила заявку',
  kick: 'исключила',
  role: 'сменила роль',
  transfer: 'передала главенство',
  leave: 'покинула корпорацию',
  disband: 'расформировала корпорацию',
  influence: 'движение влияния',
  ready: 'флаг готовности',
  medal: 'выдала медаль',
  rent: 'выдала предмет в аренду',
  rent_return: 'вернула арендованный предмет',
};

const corpEl = $('corp');
const corpHdEl = $('corphd');
const corpTabsEl = $('corptabs');
const corpBodyEl = $('corpbody');
let corpTab = 'overview';
const nfmt = (n: number): string => n.toLocaleString('ru-RU');

// --- live state (fetched via corpFetch — see refreshCorp) --------------------
let corpMine: { corp: CorpRecord | null; membership: CorpMembership | null } = {
  corp: null,
  membership: null,
};
let corpDetail: { corp: CorpRecord; members: CorpMembership[] } | null = null;
let corpAudit: CorpAuditEntry[] = [];
let corpBrowseList: CorpSummary[] = [];
let avaChallenges: AvaChallenge[] = [];
let avaPool: Array<CorpSummary & { readySince: number }> = [];
let avaFeed: AvaFeedEntry[] = [];
let avaRoster: AvaRosterView | null = null;
// AVA-6 setRoster eligibility — accountIds flagged ready in my corp (head/officer only,
// fetched only while a roster window is open; empty otherwise).
let avaReadyPlayers: string[] = [];
// Optimistic — no GET exists for "am I flagged ready" (server has no such read
// model yet); reflects only what THIS session successfully posted.
let corpReadyOptimistic: boolean | null = null;
let playerReadyOptimistic: boolean | null = null;
let corpFetchBusy = false;

/** Shared authenticated call for the corp/AvA/medals APIs — same session
 *  resolution as ARS-5's /arsenal/me (resolveServer/probeAuthMode/sessionKey),
 *  but no local cache: this data is too volatile (roster windows, challenges)
 *  to show stale. Returns the parsed JSON body, or null on ANY failure (no
 *  server configured, not logged in, network error, non-2xx) — surfaces a
 *  server-given error code via `note()` when there is one, never throws. */
async function corpFetch(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const srv = resolveServer();
  if (!srv) return null;
  await probeAuthMode(srv.base);
  if (!authMode) return null;
  const session = sessionToken(srv.base);
  if (!session) return null;
  try {
    const res = await fetch(`${httpBase(srv.base)}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${session}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const code = (body as { error?: unknown } | null)?.error;
      if (typeof code === 'string') note('✖ ' + errText(code));
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

/** Full refresh of the cabinet's live state, then re-render. Cheap enough to
 *  call after every intent (create/apply/accept/kick/…) — the server is the
 *  only source of truth, no local optimistic membership mutation. */
async function refreshCorp(): Promise<void> {
  if (corpFetchBusy) return;
  corpFetchBusy = true;
  try {
    const mineRaw = (await corpFetch('/corps/me')) as {
      corp?: unknown;
      membership?: unknown;
    } | null;
    corpMine = mineRaw
      ? { corp: parseCorpRecord(mineRaw.corp), membership: parseMembership(mineRaw.membership) }
      : { corp: null, membership: null };

    if (corpMine.membership) {
      const corpId = corpMine.membership.corpId;
      const detailRaw = (await corpFetch(`/corps/${encodeURIComponent(corpId)}`)) as {
        corp?: unknown;
        members?: unknown;
      } | null;
      const corp = detailRaw ? parseCorpRecord(detailRaw.corp) : null;
      corpDetail = corp ? { corp, members: parseMemberships(detailRaw?.members) } : null;
      if (canManage(corpMine.membership.role)) {
        const auditRaw = (await corpFetch(`/corps/${encodeURIComponent(corpId)}/audit`)) as {
          audit?: unknown;
        } | null;
        corpAudit = parseAudit(auditRaw?.audit);
      } else {
        corpAudit = [];
      }
      corpBrowseList = [];
    } else {
      corpDetail = null;
      corpAudit = [];
      const listRaw = (await corpFetch('/corps')) as { corps?: unknown } | null;
      corpBrowseList = parseCorpSummaries(listRaw?.corps);
    }

    const challengesRaw = (await corpFetch('/ava/challenges')) as { challenges?: unknown } | null;
    avaChallenges = parseChallenges(challengesRaw?.challenges);
    const poolRaw = (await corpFetch('/ava/pool')) as { pool?: unknown } | null;
    avaPool = parseReadyPool(poolRaw?.pool);
    const feedRaw = (await corpFetch('/ava/feed?limit=8')) as { feed?: unknown } | null;
    avaFeed = parseFeed(feedRaw?.feed);

    // A locked-or-accepted matchup my corp is party to: show its roster window.
    const myCorpId = corpMine.membership?.corpId;
    const activeMatchup = avaChallenges.find(
      (c) =>
        (c.status === 'accepted' || c.status === 'locked') &&
        (c.challengerCorp === myCorpId || c.targetCorp === myCorpId),
    );
    avaRoster = activeMatchup
      ? parseRosterView(await corpFetch(`/ava/matchup/${encodeURIComponent(activeMatchup.id)}`))
      : null;

    // The setRoster eligibility set (AVA-6) — head/officer only, only while curating.
    avaReadyPlayers =
      avaRoster?.status === 'accepted' &&
      myCorpId &&
      corpMine.membership &&
      canManage(corpMine.membership.role)
        ? parseAccountIds(
            (
              (await corpFetch(`/corps/${encodeURIComponent(myCorpId)}/ready-players`)) as {
                accountIds?: unknown;
              } | null
            )?.accountIds,
          )
        : [];
  } finally {
    corpFetchBusy = false;
  }
  renderCorp();
}

/** Fire an intent, then always refresh (the server is authoritative — no local
 *  guess at the new state). */
async function corpIntent(path: string, body?: unknown): Promise<void> {
  const result = await corpFetch(path, { method: 'POST', body: body ?? {} });
  if (result) await refreshCorp();
}

function corpNameOf(corpId: string): string {
  if (corpId === corpMine.membership?.corpId && corpMine.corp) return corpMine.corp.name;
  return (
    corpBrowseList.find((c) => c.corpId === corpId)?.name ??
    avaPool.find((c) => c.corpId === corpId)?.name ??
    corpId
  );
}

function corpNoneHtml(): string {
  const rows = corpBrowseList
    .map(
      (c) =>
        `<div class="crow2"><span class="cnm">${esc(c.name)}</span>` +
        `<span class="cinf">${nfmt(c.influence)} ⟡</span>` +
        `<span class="cpres">${t('{n} участников', { n: String(c.members) })}</span>` +
        `<span class="cman"><button class="cbtn2" data-corpact="apply" data-corparg="${esc(c.corpId)}">${t('Заявиться')}</button></span></div>`,
    )
    .join('');
  return (
    `<div class="ccols">` +
    `<section class="ccard"><h4>${t('Создать корпорацию')}</h4>` +
    `<div class="cinput"><input id="corpnewname" placeholder="${t('Название (3–24 символа)')}" maxlength="24">` +
    `<button class="cbtn2" data-corpact="create">${t('Создать')}</button></div></section>` +
    `<section class="ccard"><h4>${t('Найти и подать заявку')}</h4>` +
    `<div class="ctable">${rows || `<p class="chint">${t('Пока нет других корпораций.')}</p>`}</div></section>` +
    `</div>`
  );
}

function corpOverviewHtml(): string {
  if (!corpMine.corp || !corpMine.membership) return corpNoneHtml();
  const c = corpMine.corp;
  const feed = corpAudit
    .slice(0, 6)
    .map(
      (a) =>
        `<div class="cline"><span>${esc(a.actor)} ${t(CORP_AUDIT_RU[a.action] ?? a.action)}${a.target ? ` → ${esc(a.target)}` : ''}</span>` +
        `<em class="cwhen">${new Date(a.at).toLocaleString('ru-RU')}</em></div>`,
    )
    .join('');
  const feedHtml = canManage(corpMine.membership.role)
    ? feed || `<p class="chint">${t('Пока пусто.')}</p>`
    : `<p class="chint">${t('Журнал виден главе и офицерам.')}</p>`;
  const nextWar = avaChallenges.find((w) => w.status === 'accepted' || w.status === 'pending');
  const nextWarHtml = nextWar
    ? `<div class="cwarn">⚔ ${t('AvA')} vs ${esc(corpNameOf(nextWar.challengerCorp === corpMine.membership.corpId ? nextWar.targetCorp : nextWar.challengerCorp))} — ${t(nextWar.status === 'accepted' ? 'идёт набор ростера' : 'ждёт ответа')}</div>`
    : '';
  return (
    `${nextWarHtml}` +
    `<div class="ccols">` +
    `<section class="ccard"><h4>${t('Корпорация')}</h4>` +
    `<div class="cline"><span>${t('Влияние')}</span><em>${nfmt(c.influence)} ⟡</em></div>` +
    `<div class="cline"><span>${t('Моя роль')}</span><em>${corpRoleLabel(corpMine.membership.role)}</em></div>` +
    `<p class="chint">${t('Пассивные бонусы владений придут вместе с мета-слоем секторов — пока их нет.')}</p></section>` +
    `<section class="ccard"><h4>${t('Журнал')}</h4>${feedHtml}</section>` +
    `</div>`
  );
}

function corpMembersHtml(): string {
  if (!corpDetail || !corpMine.membership) return corpNoneHtml();
  const myRole = corpMine.membership.role;
  const myId = corpMine.membership.accountId;
  const rows = sortMembers(corpDetail.members)
    .map((m) => {
      const isMe = m.accountId === myId;
      let manage = '';
      if (m.role === 'recruit' && canManage(myRole)) {
        manage =
          `<button class="cbtn2" data-corpact="accept" data-corparg="${esc(m.accountId)}">✓ ${t('принять')}</button>` +
          `<button class="cbtn2 danger" data-corpact="decline" data-corparg="${esc(m.accountId)}">✖ ${t('отклонить')}</button>`;
      } else if (!isMe && m.role !== 'head') {
        const bits: string[] = [];
        if (myRole === 'head') {
          const toRole = m.role === 'officer' ? 'member' : 'officer';
          bits.push(
            `<button class="cbtn2" data-corpact="role" data-corparg="${esc(m.accountId)}" data-corprole="${toRole}">↑ ${corpRoleLabel(toRole)}</button>`,
          );
          bits.push(
            `<button class="cbtn2" data-corpact="transfer" data-corparg="${esc(m.accountId)}">⬆ ${t('передать главенство')}</button>`,
          );
        }
        if (canManage(myRole) && !(myRole === 'officer' && m.role === 'officer')) {
          bits.push(
            `<button class="cbtn2 danger" data-corpact="kick" data-corparg="${esc(m.accountId)}">✖</button>`,
          );
        }
        manage = bits.join('');
      }
      return (
        `<div class="crow2${isMe ? ' me' : ''}">` +
        `<span class="cdot" style="color:${CORP_ROLE_DOT[m.role]}"></span>` +
        `<span class="cnm">${esc(m.login)}${isMe ? ` <i>(${t('вы')})</i>` : ''}</span>` +
        `<span class="crole">${corpRoleLabel(m.role)}</span>` +
        `<span class="cman">${manage}</span>` +
        `</div>`
      );
    })
    .join('');
  const mine = corpMine.membership;
  const leave =
    mine.role === 'head'
      ? `<button class="cbtn2 danger wide" data-corpact="disband">${t('Расформировать корпорацию')}</button>`
      : `<button class="cbtn2 wide" data-corpact="leave">${t('Покинуть корпорацию')}</button>`;
  return `<div class="ctable">${rows}</div>${leave}`;
}

function corpWarsHtml(): string {
  const myCorpId = corpMine.membership?.corpId;
  const iAmHead = corpMine.membership?.role === 'head';
  const iCanFlag = corpMine.membership && corpMine.membership.role !== 'recruit';
  const corpReady = corpReadyOptimistic ?? avaPool.some((p) => p.corpId === myCorpId);
  const flags =
    `<div class="cbig">` +
    `<div><span>${t('Готовность корпорации')}</span><b>${corpReady ? t('да ✓') : t('нет')}</b>` +
    (iAmHead
      ? `<button class="cbtn2" data-corpact="${corpReady ? 'ready-corp-clear' : 'ready-corp'}">${corpReady ? t('снять') : t('в пул')}</button>`
      : `<span class="chint">${t('только глава')}</span>`) +
    `</div>` +
    `<div><span>${t('Моя готовность')}</span><b>${playerReadyOptimistic ? t('да ✓') : t('—')}</b>` +
    (iCanFlag
      ? `<button class="cbtn2" data-corpact="${playerReadyOptimistic ? 'ready-player-clear' : 'ready-player'}">${playerReadyOptimistic ? t('снять') : t('готов')}</button>`
      : '') +
    `</div></div>`;

  const wars = avaChallenges
    .map((w) => {
      const iAmChallenger = w.challengerCorp === myCorpId;
      const foe = corpNameOf(iAmChallenger ? w.targetCorp : w.challengerCorp);
      const st: Record<AvaChallengeStatus, string> = {
        pending: iAmChallenger ? t('ждёт ответа') : t('входящий вызов'),
        accepted: t('набор ростера'),
        declined: t('отклонён'),
        expired: t('истёк'),
        locked: t('заперт — скоро бой'),
        cancelled: t('отменён'),
        ended: t('завершён'),
      };
      const canRespond = w.status === 'pending' && !iAmChallenger && iAmHead;
      const act = canRespond
        ? `<button class="cbtn2" data-corpact="ava-accept" data-corparg="${esc(w.id)}">${t('Принять')}</button>` +
          `<button class="cbtn2 danger" data-corpact="ava-decline" data-corparg="${esc(w.id)}">${t('Отклонить')}</button>`
        : w.status === 'accepted' &&
            corpMine.membership &&
            corpMine.membership.role !== 'recruit' &&
            !avaRoster?.mine.some((r) => r.accountId === corpMine.membership!.accountId)
          ? `<button class="cbtn2" data-corpact="ava-join" data-corparg="${esc(w.id)}">${t('Заявиться в состав')}</button>`
          : '';
      const rosterOpen = w.status === 'accepted' && avaRoster && avaRoster.matchupId === w.id;
      const rosterLine = rosterOpen
        ? `<div class="cwmid">${t('состав')}: ${avaRoster!.counts.challenger}/${avaRoster!.counts.target}</div>`
        : '';
      // AVA-6 setRoster — head/officer curates from the flagged pool wholesale;
      // everyone else still only has self-enroll `join` (rendered in `act` above).
      const curate =
        rosterOpen &&
        canManage(corpMine.membership?.role ?? 'recruit') &&
        avaReadyPlayers.length > 0
          ? `<div class="cwroster">${avaReadyPlayers
              .map((accountId) => {
                const login =
                  corpDetail?.members.find((m) => m.accountId === accountId)?.login ?? accountId;
                const on = avaRoster!.mine.some((r) => r.accountId === accountId);
                return (
                  `<button class="cbtn2 ctoggle${on ? ' on' : ''}" data-corpact="ava-roster-toggle" ` +
                  `data-corparg="${esc(w.id)}" data-corpaccount="${esc(accountId)}">${on ? '✓' : '·'} ${esc(login)}</button>`
                );
              })
              .join('')}</div>`
          : '';
      return (
        `<div class="cwar"><div class="cwtop"><b>⚔ ${esc(foe)}</b><span class="cst st-${w.status}">${st[w.status]}</span></div>` +
        `<div class="cwmid">${iAmChallenger ? t('вызов от нас') : t('вызов нам')} · ${nfmt(w.cost)} ⟡</div>${rosterLine}${curate}` +
        (act ? `<div class="cwact">${act}</div>` : '') +
        `</div>`
      );
    })
    .join('');

  const pool = avaPool
    .filter((p) => p.corpId !== myCorpId)
    .map(
      (p) =>
        `<div class="crow2"><span class="cnm">${esc(p.name)}</span><span class="cinf">${nfmt(p.influence)} ⟡</span>` +
        (iAmHead
          ? `<span class="cman"><button class="cbtn2" data-corpact="ava-challenge" data-corparg="${esc(p.corpId)}">⚔ ${t('Вызвать')}</button></span>`
          : '') +
        `</div>`,
    )
    .join('');

  const feed = avaFeed
    .slice(0, 5)
    .map(
      (f) =>
        `<div class="cline"><span>${esc(f.challengerName)} vs ${esc(f.targetName)}</span>` +
        `<em class="cwhen">${f.kind === 'result' ? (f.winnerCorp ? t('победа') : t('ничья')) : t('назначен')}</em></div>`,
    )
    .join('');

  return (
    flags +
    `<h4>${t('Мои вызовы')}</h4><div class="cwars">${wars || `<p class="chint">${t('Пока нет вызовов.')}</p>`}</div>` +
    `<h4>${t('Готовые к войне')}</h4><div class="ctable">${pool || `<p class="chint">${t('Пул пуст.')}</p>`}</div>` +
    `<h4>${t('Публичная лента AvA')}</h4><div class="cledger">${feed || `<p class="chint">${t('Пока пусто.')}</p>`}</div>`
  );
}

function corpTreasuryHtml(): string {
  if (!corpMine.corp || !corpMine.membership) return corpNoneHtml();
  const rows = corpAudit
    .filter((a) => a.action === 'influence' || a.action === 'rent' || a.action === 'rent_return')
    .map(
      (a) =>
        `<div class="cline"><span>${esc(a.detail ?? t(CORP_AUDIT_RU[a.action] ?? a.action))} <b class="cwhen">· ${new Date(a.at).toLocaleString('ru-RU')}</b></span></div>`,
    )
    .join('');
  const ledgerHtml = canManage(corpMine.membership.role)
    ? rows || `<p class="chint">${t('Пока пусто.')}</p>`
    : `<p class="chint">${t('История видна главе и офицерам.')}</p>`;
  return (
    `<div class="cbig"><div><span>${t('Влияние')}</span><b>${nfmt(corpMine.corp.influence)} ⟡</b></div></div>` +
    `<h4>${t('История')}</h4><div class="cledger">${ledgerHtml}</div>` +
    `<p class="chint">${t('Тратится на вызов AvA (100 ⟡ по умолчанию) — кнопка «Вызвать» во вкладке «Войны».')}</p>`
  );
}

function corpHoldingsHtml(): string {
  return `<div class="hub-empty"><span class="he-ic">▦</span>${t('Владения — скоро')}<br><span style="font-size:11px;color:var(--cyan-dim)">${t('мета-карта секторов появится вместе со вторым контуром метагейма')}</span></div>`;
}

function corpCommsHtml(): string {
  return `<div class="hub-empty"><span class="he-ic">▭</span>${t('Чат — скоро')}<br><span style="font-size:11px;color:var(--cyan-dim)">${t('постоянный корп-чат ждёт мета-слой; журнал действий — во вкладке «Обзор»')}</span></div>`;
}

function renderCorp(): void {
  const c = corpMine.corp;
  const mem = corpMine.membership;
  corpHdEl.innerHTML = c
    ? `<div class="chrow"><span class="cemblem">⬢</span>` +
      `<div class="cident"><b>${esc(c.name)}</b></div>` +
      `<button id="corpclose" class="cx" title="${t('Закрыть')}">✕</button></div>` +
      `<div class="cmetrics">` +
      `<span>${t('влияние')} <b>${nfmt(c.influence)} ⟡</b></span>` +
      `<span>${t('участников')} <b>${corpDetail?.members.filter((m) => m.role !== 'recruit').length ?? '—'}</b></span>` +
      `<span>${t('роль')} <b>${mem ? corpRoleLabel(mem.role) : '—'}</b></span>` +
      `</div>`
    : `<div class="chrow"><span class="cemblem">⬢</span>` +
      `<div class="cident"><b>${t('Без корпорации')}</b></div>` +
      `<button id="corpclose" class="cx" title="${t('Закрыть')}">✕</button></div>`;
  corpTabsEl.innerHTML = CORP_TABS.map(
    (ct) =>
      `<button class="ctab${ct.id === corpTab ? ' on' : ''}" data-corptab="${ct.id}">${t(ct.label)}</button>`,
  ).join('');
  let body = '';
  if (corpTab === 'overview') body = corpOverviewHtml();
  else if (corpTab === 'members') body = corpMembersHtml();
  else if (corpTab === 'wars') body = corpWarsHtml();
  else if (corpTab === 'treasury') body = corpTreasuryHtml();
  else if (corpTab === 'holdings') body = corpHoldingsHtml();
  else if (corpTab === 'comms') body = corpCommsHtml();
  corpBodyEl.innerHTML = body;
}

function openCorp(): void {
  renderCorp(); // paint instantly from whatever's cached in memory…
  corpEl.style.display = 'flex';
  void refreshCorp(); // …then refresh from the server
  maybeIntro('corp');
}
function closeCorp(): void {
  corpEl.style.display = 'none';
}

corpTabsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement | null)?.closest('[data-corptab]') as HTMLElement | null;
  if (!b) return;
  corpTab = b.dataset.corptab ?? 'overview';
  renderCorp();
  if (corpTab === 'wars') maybeIntro('ava');
});
corpEl.addEventListener('click', (e) => {
  const tg = e.target as HTMLElement | null;
  if (!tg) return;
  if (tg.id === 'corpclose' || tg.id === 'corp') {
    closeCorp();
    return;
  }
  const btn = tg.closest('[data-corpact]') as HTMLElement | null;
  const act = btn?.dataset.corpact;
  if (!act) return;
  const arg = btn?.dataset.corparg ?? '';
  const corpId = corpMine.membership?.corpId ?? '';
  const account = btn?.dataset.corpaccount ?? '';
  switch (act) {
    case 'create': {
      const input = document.getElementById('corpnewname') as HTMLInputElement | null;
      const name = input?.value.trim() ?? '';
      if (name) void corpIntent('/corps', { name });
      break;
    }
    case 'apply':
      void corpIntent(`/corps/${encodeURIComponent(arg)}/apply`);
      break;
    case 'accept':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/accept`, { target: arg });
      break;
    case 'decline':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/decline`, { target: arg });
      break;
    case 'kick':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/kick`, { target: arg });
      break;
    case 'role':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/role`, {
        target: arg,
        role: btn?.dataset.corprole,
      });
      break;
    case 'transfer':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/transfer`, { target: arg });
      break;
    case 'leave':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/leave`);
      break;
    case 'disband':
      void corpIntent(`/corps/${encodeURIComponent(corpId)}/disband`);
      break;
    case 'ready-corp':
      void corpFetch('/ava/ready/corp', { method: 'POST' }).then((r) => {
        if (r) {
          corpReadyOptimistic = true;
          void refreshCorp();
        }
      });
      break;
    case 'ready-corp-clear':
      void corpFetch('/ava/ready/corp/clear', { method: 'POST' }).then((r) => {
        if (r) {
          corpReadyOptimistic = false;
          void refreshCorp();
        }
      });
      break;
    case 'ready-player':
      void corpFetch('/ava/ready/player', { method: 'POST' }).then((r) => {
        if (r) {
          playerReadyOptimistic = true;
          renderCorp();
        }
      });
      break;
    case 'ready-player-clear':
      void corpFetch('/ava/ready/player/clear', { method: 'POST' }).then((r) => {
        if (r) {
          playerReadyOptimistic = false;
          renderCorp();
        }
      });
      break;
    case 'ava-challenge':
      void corpIntent('/ava/challenge', { target: arg });
      break;
    case 'ava-accept':
      void corpIntent(`/ava/challenge/${encodeURIComponent(arg)}/accept`);
      break;
    case 'ava-decline':
      void corpIntent(`/ava/challenge/${encodeURIComponent(arg)}/decline`);
      break;
    case 'ava-join':
      void corpIntent(`/ava/matchup/${encodeURIComponent(arg)}/join`);
      break;
    case 'ava-roster-toggle': {
      // arg = matchupId, account = the toggled accountId. Server is wholesale
      // (setRoster REPLACES the side), so send the full desired set every time.
      if (!avaRoster || avaRoster.matchupId !== arg) break;
      const current = avaRoster.mine.map((r) => r.accountId);
      const next = current.includes(account)
        ? current.filter((id) => id !== account)
        : [...current, account];
      void corpIntent(`/ava/matchup/${encodeURIComponent(arg)}/roster`, { players: next });
      break;
    }
  }
});
const corpEntry = $('ccorp');
corpEntry.addEventListener('click', openCorp);
const corpRail = $('railcorp');
corpRail.addEventListener('click', openCorp);
