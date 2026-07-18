import type {
  Action,
  Context,
  DomainEvent,
  GameData,
  GameState,
  Kernel,
  PlayerArsenal,
  PlayerId,
  PlayerReward,
  SignatureContact,
} from '@void/shared-core';
import { diffState, getStance, hashState, identifiedNodes, visibleView } from '@void/shared-core';
import type { AcceptedAction, ActionGate } from '@void/action-layer';
import {
  parseClientMessage,
  serializeServerMessage,
  CHAT_TEXT_MAX,
  type ChatMessage,
  type ClientChatSendMessage,
  type ClientPingPlaceMessage,
  type LobbyInfo,
  type Ping,
  type ServerMessage,
  type ServerRejectionMessage,
} from './protocol';
import type { ArsenalStore, MatchSnapshot, StoredReceipt } from './store';
import { arsenalSnapshotOf } from './arsenal';
import { InMemoryEphemeralStore, type EphemeralStore } from './ephemeral';
import { PerKeyWindow } from './rateLimit';

export interface RoomPeer {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  readonly readyState?: number;
  /** Bytes queued but not yet flushed to the socket (a `ws` getter). When this
   *  backs up the peer isn't draining — the room drops it rather than grow memory
   *  unbounded. Absent (e.g. an in-memory test peer) ⇒ backpressure is not enforced. */
  readonly bufferedAmount?: number;
}

export interface MatchRoomOptions {
  id: string;
  initialState: GameState;
  kernel: Kernel;
  data: GameData;
  config?: Context['config'];
  now?: () => number;
  maxPayloadBytes?: number;
  /** Lobby gate: the world clock stays FROZEN until every listed player is
   *  connected, and re-freezes if one drops (`now` is then read as raw wall-clock
   *  and only accrues while all are present). Omit ⇒ the clock runs freely. */
  waitForPlayers?: PlayerId[];
  /** Manual-start lobby: the world clock stays FROZEN until the host (the first
   *  player to connect) sends a `start` message — then it runs and never re-freezes.
   *  Snapshots carry a `lobby` roster so the client can show who's in + a Start
   *  button. Mutually exclusive with `waitForPlayers` (this takes precedence). */
  manualStart?: boolean;
  /** Start the match ALREADY RUNNING, its clock anchored at `initialState.time`
   *  and accruing scaled elapsed time from construction. With `manualStart` this
   *  resumes a restored match past its lobby (no fresh Start press); WITHOUT
   *  `manualStart` it is the no-lobby session mode (SES-2.1, Iron Order model):
   *  the world runs from the moment the session is created — a fresh world begins
   *  at Day 1 right away, a restored one continues from its saved instant, and
   *  `timeScale` applies. Omit both flags ⇒ the clock is raw wall time (the
   *  production entry seeds `initialState.time = Date.now()` instead). */
  initiallyStarted?: boolean;
  /** Attach `hashState(view)` to each snapshot so the client can detect desync.
   *  Opt-in (it hashes the per-player view on every broadcast). */
  emitStateHash?: boolean;
  /** Reject a second LIVE connection to an already-occupied player slot, so two
   *  people cannot command the same empire. A slot frees the moment its peer
   *  disconnects, so reconnect-after-drop still works. Default false. */
  singlePeerPerPlayer?: boolean;
  /** Static team assignment (playerId → teamId): same team = allies who see each
   *  other's pings. Omit ⇒ no allies (only self sees own pings). Stopgap until a
   *  real diplomacy relation exists (then read it instead in `areAllied`). */
  teams?: Record<PlayerId, string>;
  /** Ping time-to-live in ms (default 5 minutes). */
  pingTtlMs?: number;
  /** Where ephemeral match data (pings, …) lives. Defaults to an in-memory store;
   *  swap a Redis-backed impl in to share it across server processes (the seam from
   *  docs/tech-stack.md — no room-logic change). */
  ephemeral?: EphemeralStore;
  /** Player-action deny-list (AVA-8): a WIRE rule applied in `receive` to both the
   *  bare and the gated path — return a stable reject code to refuse that action
   *  TYPE from players, or null/undefined to allow it. Server-internal drivers
   *  (`submitAction`/`submitServerAction` — AI, standing orders, the AvA war
   *  escalation) do not pass through `receive` and stay unaffected; e.g. an AvA
   *  room denies `diplomacy.declare` because the orchestrator owns the stances. */
  denyPlayerActions?: (type: string) => string | null | undefined;
  /** Observation-only room-event stream for metrics/playtest logging (M0). */
  observe?: (event: RoomObservation) => void;
  /** Seed the idempotency receipts (e.g. rehydrated from a ReceiptStore on restart),
   *  so an action deduped before a crash stays deduped after it. */
  initialReceipts?: ActionReceipt[];
  /** Resume the action counter (e.g. from a persisted `MatchSnapshot.seq`). Without
   *  it a restarted room restarts `seq` at 0, and an optimistic-by-seq store would
   *  drop its post-restart saves until the counter climbed back past the stored one.
   *  Default 0 (a fresh match). */
  initialSeq?: number;
  /** STRICT commit-before-broadcast (risk14). When set, a player action is routed
   *  through an async, per-room-serialized path that AWAITS this durable write of the
   *  new snapshot + receipt BEFORE committing state or broadcasting the delta — so a
   *  peer never sees state the store hasn't accepted, and a crash can't lose an acked
   *  action. A rejecting/throwing write commits nothing and the action is retriable.
   *  Omit ⇒ the current synchronous path (broadcast then persist-after via `observe`),
   *  which every existing test and the tick/driver path keep using unchanged. */
  persist?: (snapshot: MatchSnapshot, receipt: StoredReceipt) => Promise<void>;
  /** Opt-in `@void/action-layer` front-door (SV-1.1). When set, this room accepts
   *  gated `action.v1` envelope messages and refuses bare `action` messages: every
   *  action is validated → authorized → sequence-checked → deduped BEFORE the reducer,
   *  yielding stable `E_*` codes with no internal leak. `receive` must be passed the
   *  connection's `sessionId` (the transport binds it at handshake). Omit ⇒ the current
   *  bare-action path (no envelope), which every existing caller keeps using unchanged.
   *  Combining `gate` with `persist` routes an accepted action through the durable
   *  commit-before-broadcast path (serialized in the mailbox so the sequence reservation
   *  and the persist are atomic); without `persist`, the gated apply is synchronous. A
   *  server-issued `sessionId` (never client-chosen — it keys the sequence cursor and
   *  authorizes the envelope, SV-1.1-live-A) must reach `receive`. The gate's in-memory
   *  stores are bounded (SV-1.1-live-B: FIFO receipts + LRU cursors) and need NO
   *  cross-restart durability: they are keyed by the per-connection `sessionId`, so a
   *  restart or hibernation drops them exactly when the sessions they track also end — a
   *  reconnect mints a fresh `sessionId` → a fresh cursor and a fresh `actionId` namespace,
   *  so no post-loss action can hit a lost entry (verified). */
  gate?: ActionGate;
  /** Cap on retained idempotency receipts; past it the oldest are evicted (FIFO).
   *  Bounds memory for a long match — a retried action older than the last N is no
   *  longer deduped (idempotency is needed for minutes, not forever). Default 10000. */
  maxReceipts?: number;
  /** Per-player action rate limit: at most `actionRateMax` submits per
   *  `actionRateWindowMs`. A flood past it is rejected transiently (no receipt — a
   *  genuine retry after backoff still lands). Defaults: 20 per 1000ms. */
  actionRateMax?: number;
  actionRateWindowMs?: number;
  /** Wall-clock → game-clock multiplier for the running match clock (NOT the kernel's
   *  duration `config.timeScale`): >1 fast-forwards the whole world for playtests, so a
   *  real minute becomes many game-hours and fleets/builds/economy resolve on-screen.
   *  1 = real-time. Honoured whenever the clock is anchored/gated — a lobby gate
   *  (`manualStart` / `waitForPlayers`) OR the no-lobby auto-start mode
   *  (`initiallyStarted`, SES-2.1). Inert for a plain free-running room, which reads
   *  raw wall time. */
  timeScale?: number;
  /** LARS-1 — live build-catalog ownership. When set, a `unit.build` whose hull/
   *  modules aren't (yet) in the seat's boot-time arsenal snapshot (ARS-3) gets one
   *  fresh `ArsenalStore.listOf(accountId)` read before the gate gets to reject it;
   *  if the account now owns more, an internal `arsenal.sync` action (bypassing the
   *  ActionGate, like the AI/patrol drivers) refreshes `Player.arsenal` first, so a
   *  module bought mid-match is buildable without a new match. Needs the peer's
   *  `accountId` (passed to `addPeer`) and only runs on the durable (`persist`)
   *  paths — the sync itself must be a real, broadcast, hash-consistent action, not
   *  a silent state patch. No `arsenalStore`, no `accountId`, or no snapshot on the
   *  seat ⇒ unchanged ARS-3 behaviour (graceful degradation). */
  arsenalStore?: ArsenalStore;
}

export interface ActionReceipt {
  actionId: string;
  playerId: PlayerId;
  seq: number;
  ok: boolean;
  code?: string;
}

/** Observation-only stream of room events for metrics/playtest logging (M0). The
 *  callback never feeds back into the room — it just sees what happened. */
export type RoomObservation =
  | { kind: 'join'; playerId: PlayerId }
  | { kind: 'leave'; playerId: PlayerId }
  | { kind: 'lobby'; waiting: boolean }
  | {
      kind: 'action';
      actionId: string;
      playerId: PlayerId;
      type: string;
      ok: boolean;
      seq: number;
      code?: string;
    }
  /** Terminal match report. `rewards` is the session-end table the core computed
   *  (SES-2: place + XP per seated player, GDD §3.4) — surfaced here so the
   *  playtest JSONL carries it until account crediting exists (EC-*). */
  | {
      kind: 'end';
      winner: PlayerId | null;
      reason?: string;
      rewards?: Record<PlayerId, PlayerReward>;
    }
  /** The world clock could not fully reach `now` in one `advance` call. `reason`
   *  distinguishes an enormous-but-legitimate catch-up that was throttled to bound
   *  work (`throttled` — it will finish on the next advance) from a same-instant
   *  runaway where the clock stopped progressing (`stalled` — a content/module bug
   *  that needs attention). Ops should alert on `stalled`. */
  | { kind: 'advance_overflow'; reachedTime: number; targetTime: number; reason: 'throttled' | 'stalled' }
  /** Scheduled events dead-lettered during a catch-up (their handler threw). The
   *  timeline kept moving (by design), but silence here hid real module bugs —
   *  the record must reach the host's logs (bug-hunt: failures had NO consumer). */
  | { kind: 'dead_letter'; failures: Array<{ at: number; type: string; code: string }> }
  /** Domain events that accompanied a committed change (M1) — the raw bus output
   *  BEFORE fog filtering (the observer is server-side and sees everything), so a
   *  metrics consumer can count battles/captures/arrivals. `time.advanced` spans are
   *  excluded (pure clock noise — one per broadcast would swamp the stream). */
  | { kind: 'events'; seq: number; events: DomainEvent[] }
  /** One broadcast round (M1): how long the fan-out took and the serialized size of
   *  each player's delta payload (fog efficiency — the doc target is idle < 1 KB). */
  | { kind: 'broadcast'; seq: number; ms: number; deltaBytes: Record<PlayerId, number> }
  /** Wall-clock cost of one room operation (M1): a player/server action submit
   *  (advance + apply + commit + broadcast, incl. the durable persist when configured)
   *  or an offline-heartbeat advance (`tick`). */
  | { kind: 'timing'; op: 'submit' | 'advance'; ms: number; seq: number; actionType?: string }
  /** A client reported that its reconstructed state hashed differently from the
   *  server's snapshot hash (M1). The room answers with a full resync snapshot;
   *  this record is the log half (the doc's desync-rate target is 0). */
  | { kind: 'desync'; playerId: PlayerId; atSeq: number; clientHash: string }
  /** A client perf sample (M2): smoothed fps + round-trip + JS-heap as the player's
   *  device experiences the match. Rate-limited at the room (floods are dropped
   *  silently — telemetry, not a conversation); values already range-checked at parse. */
  | { kind: 'client_perf'; playerId: PlayerId; fps: number; rttMs?: number; memMb?: number };

export interface SubmitResult {
  ok: boolean;
  seq: number;
  events: DomainEvent[];
  code?: string;
}

/** The durable verdict of a committed apply (`commitApply`). `durable:false` marks a
 *  TRANSIENT failure (the store was unreachable) that the gated path must NOT cache in the
 *  ActionGate — the action stays retriable, exactly like the room's own transient rejects. */
type CommitVerdict =
  | { ok: true }
  | { ok: false; code: string; durable: true }
  | { ok: false; code: string; durable: false };
const TRANSIENT_VERDICT: CommitVerdict = { ok: false, code: 'E_UNAVAILABLE', durable: false };

const OPEN = 1;
/** Backpressure cap: drop a peer whose unflushed outbound buffer exceeds this (it
 *  isn't draining — a fast sender outrunning a slow receiver). Deltas are KB-sized,
 *  so 1 MiB is hundreds of un-acked updates — a genuinely stuck client, not a blip. */
const MAX_BUFFERED_BYTES = 1_048_576;

/** Max partial-advance chunks one `advance` call will chain before returning. Each
 *  chunk is up to the kernel's `MAX_ADVANCE_STEPS` of work, so this bounds the
 *  synchronous work of a single catch-up (an enormous-but-legit backlog finishes
 *  across several calls; a same-instant runaway is caught after one non-progressing
 *  chunk). Keeps the event loop responsive instead of hanging on a huge advance. */
const MAX_CATCHUP_CHUNKS = 10;

function canSend(peer: RoomPeer): boolean {
  return peer.readyState === undefined || peer.readyState === OPEN;
}

/** Best-effort actionId from a raw envelope, for correlating a gate rejection back to the
 *  client's action. A malformed payload may carry none — then `''`, and the client
 *  correlates by its own clientSeq instead. */
function envelopeActionId(envelope: unknown): string {
  if (envelope !== null && typeof envelope === 'object') {
    const id = (envelope as { actionId?: unknown }).actionId;
    if (typeof id === 'string') return id;
  }
  return '';
}

/** LARS-1: is a freshly-read live snapshot the same as what's already on the
 *  player? Both sides come out of `arsenalSnapshotOf` (sorted, deduped), so a
 *  plain per-array compare is exact — used to skip a no-op `arsenal.sync`. */
function sameArsenal(a: PlayerArsenal, b: PlayerArsenal): boolean {
  const eq = (x: string[], y: string[]): boolean =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.hulls, b.hulls) && eq(a.modules, b.modules) && eq(a.fittings, b.fittings);
}

/** Ally-ping tuning (ephemeral, server-side; never part of the deterministic core). */
const PING_DEFAULT_TTL_MS = 5 * 60_000;
const PING_MAX_PER_PLAYER = 8;
const PING_RATE_WINDOW_MS = 2_000;
const PING_RATE_MAX = 4;
const PING_LABEL_MAX = 40;

/** Session-chat tuning (ephemeral relay, same family as pings). The rate limit runs
 *  on WALL clock (flood protection must keep working while the lobby clock is
 *  frozen); the visible back-log is a bounded ring replayed to a (re)joining peer. */
const CHAT_RATE_WINDOW_MS = 4_000;
const CHAT_RATE_MAX = 6;
const CHAT_HISTORY_MAX = 100;

/** Idempotency-receipt + action-rate bounds (DoS / memory; audit F-03/F-04). */
const RECEIPTS_MAX_DEFAULT = 10_000;
const ACTION_RATE_MAX_DEFAULT = 20;
const ACTION_RATE_WINDOW_MS_DEFAULT = 1_000;

/** Desync-report cool-down per player (M1): a full resync snapshot is not free
 *  (fog projection + full-state serialize), so a client claiming desync more often
 *  than this is throttled — the report is still observed (the log must not miss a
 *  real desync storm), only the resync reply is skipped. */
const DESYNC_RESYNC_COOLDOWN_MS = 2_000;

/** Min interval between accepted client perf samples (M2). The client sends every
 *  ~30 s; anything faster is a bug or a flood — dropped silently (telemetry). */
const PERF_SAMPLE_MIN_MS = 5_000;

export class MatchRoom {
  readonly id: string;

  private readonly kernel: Kernel;
  private readonly data: GameData;
  private readonly config: Context['config'];
  private readonly now: () => number;
  private readonly maxPayloadBytes: number;
  /** Lobby gate (null = run freely). The world clock only accrues while all these
   *  players are connected. */
  private readonly waitFor: ReadonlySet<PlayerId> | null;
  private lobbyAccrued = 0; // game-ms accrued while running
  private lobbyRunningSince: number | null = null; // raw ms when running began, else null
  /** Manual-start lobby (host presses Start). `host` = first player to connect. */
  private readonly manualStart: boolean;
  private host: PlayerId | null = null;
  private started = false;
  private readonly emitStateHash: boolean;
  private readonly singlePeerPerPlayer: boolean;
  private readonly observe?: (event: RoomObservation) => void;
  /** Durable write for strict commit-before-broadcast (see options.persist). */
  private readonly persist?: (snapshot: MatchSnapshot, receipt: StoredReceipt) => Promise<void>;
  /** Opt-in action-layer front-door (see options.gate). */
  private readonly gate?: ActionGate;
  /** Player-action deny-list (see options.denyPlayerActions). */
  private readonly denyPlayerActions?: (type: string) => string | null | undefined;
  /** LARS-1 live ownership read (see options.arsenalStore). */
  private readonly arsenalStore?: ArsenalStore;
  /** playerId → accountId for the room's life (see `addPeer`'s `accountId` param).
   *  Only ever set, never cleared on disconnect — the same seat is always the same
   *  account for a given match. */
  private readonly playerAccountId = new Map<PlayerId, string>();
  /** The actor mailbox (SV-0.2): serializes state-touching operations whose critical
   *  section spans an `await` — a committed submit (its persist) and a lobby `start`
   *  — so one runs fully before the next, and neither interleaves with the other's
   *  broadcast. Synchronous ops (the no-persist `submitAction`, `tick`) can't interleave
   *  anyway; `tick` uses the `committing` flag rather than the mailbox (skip ≡ defer for
   *  a recomputable advance, and skip is cheaper). */
  private mailbox: Promise<void> = Promise.resolve();
  /** True during a committed submit's critical section (incl. its persist await) so a
   *  concurrent `tick()` skips instead of mutating the world under the submit, and
   *  `msUntilNextEvent()` reports null so a wakeup driver idles (rather than firing skipped
   *  ticks that look overdue). The submit re-arms the driver when it commits. */
  private committing = false;
  private endObserved = false; // 'end' is reported once
  private readonly peers = new Map<PlayerId, Set<RoomPeer>>();
  private readonly receipts = new Map<string, ActionReceipt>();
  private seq = 0;
  private stateValue: GameState;
  /** Per-player baseline the deltas diff against — each player's last broadcast
   *  *visible* view (fog of war is server-authoritative, so every player holds a
   *  different state). A peer's `welcome` (re)sets its player's baseline. */
  private readonly lastVisible = new Map<PlayerId, GameState>();
  private readonly teams: Record<PlayerId, string>;
  private readonly pingTtlMs: number;
  /** Ally pings live behind the ephemeral store (in-memory now, Redis later) — never
   *  in GameState, so they can't trip hashState / replay / the schedule. */
  private readonly ephemeral: EphemeralStore;
  private pingSeq = 0;
  /** Per-player placement timestamps, for the (local, single-process) rate limit. */
  private readonly pingWindow = new PerKeyWindow<PlayerId>(PING_RATE_MAX, PING_RATE_WINDOW_MS);
  private chatSeq = 0;
  /** Per-player chat timestamps (WALL clock), for the chat rate limit. */
  private readonly chatWindow = new PerKeyWindow<PlayerId>(CHAT_RATE_MAX, CHAT_RATE_WINDOW_MS);
  /** Bounded session-chat back-log, replayed to a (re)joining peer. Room-local and
   *  ephemeral by design (dies with hibernation, like pings); a Redis-backed
   *  EphemeralStore is the seam that would carry it across processes/restarts. */
  private readonly chatHistory: ChatMessage[] = [];
  /** Cap on retained idempotency receipts (FIFO eviction past it — bounds memory). */
  private readonly maxReceipts: number;
  /** Per-player action rate limit (local, single-process; → ephemeral store at >1 proc). */
  private readonly actionRateMax: number;
  private readonly actionRateWindowMs: number;
  /** Per-player submit timestamps, for the action rate limit. */
  private readonly actionWindow: PerKeyWindow<PlayerId>;
  /** Per-player wall time of the last desync-triggered resync reply (cool-down). */
  private readonly lastResyncAt = new Map<PlayerId, number>();
  /** Per-player wall time of the last accepted perf sample (rate limit). */
  private readonly lastPerfAt = new Map<PlayerId, number>();
  /** Wall→game clock multiplier (1 = real-time; >1 fast-forwards the match). */
  private readonly timeScale: number;

  constructor(options: MatchRoomOptions) {
    this.id = options.id;
    this.stateValue = options.initialState;
    this.kernel = options.kernel;
    this.data = options.data;
    this.config = options.config ?? { timeScale: 1 };
    this.now = options.now ?? (() => Date.now());
    this.maxPayloadBytes = options.maxPayloadBytes ?? 32_768;
    this.waitFor =
      options.waitForPlayers && options.waitForPlayers.length > 0
        ? new Set(options.waitForPlayers)
        : null;
    this.manualStart = options.manualStart ?? false;
    if (options.initiallyStarted) {
      // Born running: anchor the clock at the initial game time (a fresh world's 0,
      // a restored snapshot's saved instant) and accrue scaled time from now. With
      // manualStart this resumes past the lobby; without it, it IS the no-lobby
      // auto-start mode (SES-2.1) — there is no host and nothing to press.
      this.started = true;
      this.lobbyAccrued = options.initialState.time;
      this.lobbyRunningSince = this.now();
    }
    this.emitStateHash = options.emitStateHash ?? false;
    this.singlePeerPerPlayer = options.singlePeerPerPlayer ?? false;
    this.observe = options.observe;
    this.persist = options.persist;
    this.gate = options.gate;
    if (options.denyPlayerActions) this.denyPlayerActions = options.denyPlayerActions;
    this.arsenalStore = options.arsenalStore;
    if (options.initialSeq && options.initialSeq > 0) this.seq = options.initialSeq;
    this.maxReceipts = options.maxReceipts ?? RECEIPTS_MAX_DEFAULT;
    this.actionRateMax = options.actionRateMax ?? ACTION_RATE_MAX_DEFAULT;
    this.actionRateWindowMs = options.actionRateWindowMs ?? ACTION_RATE_WINDOW_MS_DEFAULT;
    this.actionWindow = new PerKeyWindow(this.actionRateMax, this.actionRateWindowMs);
    this.timeScale = options.timeScale && options.timeScale > 0 ? options.timeScale : 1;
    if (options.initialReceipts) {
      // Rehydration must respect the cap — seed only the most recent `maxReceipts`.
      for (const r of options.initialReceipts.slice(-this.maxReceipts)) {
        this.receipts.set(r.actionId, r);
      }
    }
    this.teams = options.teams ?? {};
    this.pingTtlMs = options.pingTtlMs ?? PING_DEFAULT_TTL_MS;
    // Align store expiry with the room's (lobby-adjusted) clock, not raw wall time.
    this.ephemeral = options.ephemeral ?? new InMemoryEphemeralStore(() => this.clock());
  }

  /** `hashState` of a per-player view, for the desync field (only when enabled). */
  private hashField(view: GameState): { hash?: string } {
    return this.emitStateHash ? { hash: hashState(view) } : {};
  }

  /** Report a match end exactly once (after an action ends it). */
  private observeEndIfNeeded(): void {
    if (this.endObserved || this.stateValue.match.status !== 'ended') return;
    this.endObserved = true;
    this.observe?.({
      kind: 'end',
      winner: this.stateValue.match.winner,
      ...(this.stateValue.match.reason ? { reason: this.stateValue.match.reason } : {}),
      ...(this.stateValue.match.rewards ? { rewards: this.stateValue.match.rewards } : {}),
    });
  }

  /** Whether every required player is currently connected (always true when no
   *  lobby gate is configured). */
  private get lobbyRunning(): boolean {
    if (!this.waitFor) return true;
    for (const p of this.waitFor) if ((this.peers.get(p)?.size ?? 0) === 0) return false;
    return true;
  }

  /** True while the world clock is frozen: in manual-start mode until the host
   *  presses Start; in waitForPlayers mode while a required player is missing. */
  private get waiting(): boolean {
    if (this.manualStart) return !this.started;
    return this.waitFor !== null && !this.lobbyRunning;
  }

  /** Lobby roster + flags for the manual-start screen (only in that mode). */
  private lobbyField(): { waiting?: boolean; lobby?: LobbyInfo } {
    const out: { waiting?: boolean; lobby?: LobbyInfo } = {};
    if (this.waiting) out.waiting = true;
    if (this.manualStart) {
      out.lobby = { host: this.host, connected: [...this.peers.keys()], started: this.started };
    }
    return out;
  }

  /** Host-only: begin the match now (manual-start lobby). Releases the frozen
   *  clock — Day 1 starts at the press — and never re-freezes after. */
  start(playerId: PlayerId): void {
    if (!this.manualStart || this.started || playerId !== this.host) return;
    this.started = true;
    this.lobbyRunningSince = this.now();
    this.observe?.({ kind: 'lobby', waiting: false });
    this.broadcastState([]);
  }

  /** The world clock: raw wall time unless something anchored or gated it — a
   *  lobby gate (waitForPlayers / manualStart) accrues only while running, and an
   *  auto-started room (`initiallyStarted`, no lobby) accrues scaled time from
   *  its anchor at `initialState.time` (SES-2.1). */
  private clock(): number {
    if (!this.waitFor && !this.manualStart && this.lobbyRunningSince === null) return this.now();
    const elapsed = this.lobbyRunningSince === null ? 0 : this.now() - this.lobbyRunningSince;
    return this.lobbyAccrued + elapsed * this.timeScale;
  }

  /** Re-evaluate running/paused after a connection change: freeze or resume the
   *  clock. Returns true if the lobby state flipped (so callers can notify peers). */
  private syncLobbyClock(): boolean {
    if (!this.waitFor) return false;
    const running = this.lobbyRunning;
    if (running && this.lobbyRunningSince === null) {
      this.lobbyRunningSince = this.now(); // start / resume
      this.observe?.({ kind: 'lobby', waiting: false });
      return true;
    }
    if (!running && this.lobbyRunningSince !== null) {
      this.lobbyAccrued += (this.now() - this.lobbyRunningSince) * this.timeScale; // freeze
      this.lobbyRunningSince = null;
      this.observe?.({ kind: 'lobby', waiting: true });
      return true;
    }
    return false;
  }

  get state(): GameState {
    return this.stateValue;
  }

  get sequence(): number {
    return this.seq;
  }

  /** Whether a manual-start match has begun (lobby passed). */
  get isStarted(): boolean {
    return this.started;
  }

  /** Number of connected sockets across all seats — 0 means the match is unwatched
   *  and a lifecycle registry may hibernate it (persist + evict). */
  get peerCount(): number {
    let n = 0;
    for (const set of this.peers.values()) n += set.size;
    return n;
  }

  hasPlayer(playerId: PlayerId): boolean {
    return this.stateValue.players[playerId] !== undefined;
  }

  addPeer(
    playerId: PlayerId,
    peer: RoomPeer,
    sessionId?: string,
    welcomeExtras?: { seatTicket?: string },
    accountId?: string,
  ): boolean {
    if (!this.hasPlayer(playerId)) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_UNKNOWN_PLAYER' });
      peer.close?.(1008, 'unknown player');
      return false;
    }
    // LARS-1: remember which account this seat is, for the live arsenal-ownership
    // read at unit.build admission (options.arsenalStore). Never trust a later,
    // different value for the same seat within one room's life.
    if (accountId && !this.playerAccountId.has(playerId)) this.playerAccountId.set(playerId, accountId);
    if (this.singlePeerPerPlayer && (this.peers.get(playerId)?.size ?? 0) > 0) {
      // That side is already controlled by a live connection.
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_SLOT_TAKEN' });
      peer.close?.(1008, 'slot taken');
      return false;
    }
    const playerPeers = this.peers.get(playerId) ?? new Set<RoomPeer>();
    playerPeers.add(peer);
    this.peers.set(playerId, playerPeers);
    this.observe?.({ kind: 'join', playerId });
    if (this.manualStart && this.host === null) this.host = playerId; // first in hosts
    const flipped = this.syncLobbyClock(); // last player in? the match resumes
    const view = this.viewFor(playerId);
    this.lastVisible.set(playerId, view.base);
    this.send(peer, {
      type: 'welcome',
      matchId: this.id,
      playerId,
      seq: this.seq,
      serverTime: this.clock(),
      state: view.base,
      signatures: view.signatures,
      remembered: view.remembered,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(this.gate ? { gated: true } : {}), // tell the client to send action.v1 envelopes
      // Seat lock: a ticket minted at THIS join rides the welcome once (the transport
      // keeps only its hash) — the client stores it and presents it on reconnect.
      ...(welcomeExtras?.seatTicket !== undefined ? { seatTicket: welcomeExtras.seatTicket } : {}),
      ...this.hashField(view.base),
      ...this.lobbyField(),
    });
    void this.sendVisiblePings(playerId, peer); // existing ally markers, on join (best-effort)
    this.sendVisibleChat(playerId, peer); // the visible chat back-log, on join
    // Tell already-present peers the wait ended (waitForPlayers) or the lobby
    // roster changed (manualStart, pre-start), so their lobby screen updates.
    if (flipped || (this.manualStart && !this.started)) this.broadcastState([]);
    return true;
  }

  /** What `playerId` may see right now: a clean visible `GameState` baseline
   *  (fog applied, internal memory stripped), the fog extras for the wire, and
   *  the identify set behind them (one coverage pass serves view + event fog). */
  private viewFor(playerId: PlayerId): {
    base: GameState;
    signatures: SignatureContact[];
    remembered: string[];
    identified: Set<string>;
  } {
    const { view, identified } = visibleView(this.stateValue, playerId, this.data);
    const { signatures, remembered, ...base } = view;
    return { base: base as GameState, signatures, remembered, identified };
  }

  removePeer(playerId: PlayerId, peer: RoomPeer): void {
    const playerPeers = this.peers.get(playerId);
    if (!playerPeers) return;
    playerPeers.delete(peer);
    if (playerPeers.size === 0) {
      this.peers.delete(playerId);
      this.lastVisible.delete(playerId); // reclaim the per-player snapshot — no leak after a leave
      this.lastResyncAt.delete(playerId); // and the desync-resync cool-down stamp
      this.lastPerfAt.delete(playerId); // and the perf-sample rate-limit stamp
      this.observe?.({ kind: 'leave', playerId });
      // Manual-start lobby: if the host leaves before starting, hand the Start
      // button to whoever's still here (insertion order) so the lobby isn't stuck.
      if (this.manualStart && !this.started && this.host === playerId) {
        this.host = this.peers.keys().next().value ?? null;
      }
    }
    // Broadcast on a waitForPlayers freeze, or on any pre-start manual-start roster
    // change, so the remaining lobby screens update.
    if (this.syncLobbyClock() || (this.manualStart && !this.started)) this.broadcastState([]);
  }

  async receive(
    playerId: PlayerId,
    peer: RoomPeer,
    raw: string,
    sessionId?: string,
  ): Promise<void> {
    if (raw.length > this.maxPayloadBytes) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_PAYLOAD_TOO_LARGE' });
      return;
    }
    const message = parseClientMessage(raw);
    if (!message) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_BAD_MESSAGE' });
      return;
    }
    if (message.type === 'ping') {
      const pong =
        message.clientTime === undefined
          ? { type: 'pong' as const, matchId: this.id, serverTime: this.clock() }
          : {
              type: 'pong' as const,
              matchId: this.id,
              serverTime: this.clock(),
              clientTime: message.clientTime,
            };
      this.send(peer, pong);
      return;
    }
    if (message.type === 'start') {
      // Serialize the lobby release through the mailbox in committed mode, so its
      // broadcast can't interleave with an in-flight action's persist await. (`start`
      // itself is synchronous and host-only; ignored otherwise.)
      if (this.persist) await this.enqueue(() => this.start(playerId));
      else this.start(playerId);
      return;
    }
    if (message.type === 'ping.place') {
      await this.handlePingPlace(playerId, peer, message);
      return;
    }
    if (message.type === 'ping.clear') {
      await this.handlePingClear(playerId, message.pingId);
      return;
    }
    if (message.type === 'chat.send') {
      this.handleChatSend(playerId, peer, message);
      return;
    }
    if (message.type === 'desync') {
      // M1 desync detector, server half: log the report (observation), answer with a
      // full resync snapshot so the client recovers in place. The reply is cooled down
      // per player (a resync costs a fog projection + full serialize); the observation
      // is NOT — a desync storm must be visible in the metrics even while throttled.
      this.observe?.({ kind: 'desync', playerId, atSeq: message.seq, clientHash: message.hash });
      const wallNow = this.now();
      const last = this.lastResyncAt.get(playerId);
      if (last === undefined || wallNow - last >= DESYNC_RESYNC_COOLDOWN_MS) {
        this.lastResyncAt.set(playerId, wallNow);
        this.send(peer, this.stateMessageFor(playerId));
      }
      return;
    }
    if (message.type === 'perf') {
      // M2 client perf telemetry: observe-and-forget. Rate-limited per player; a
      // too-frequent sample is dropped silently (telemetry is not a conversation,
      // and answering floods would be the amplification we're avoiding).
      const wallNow = this.now();
      const last = this.lastPerfAt.get(playerId);
      if (last === undefined || wallNow - last >= PERF_SAMPLE_MIN_MS) {
        this.lastPerfAt.set(playerId, wallNow);
        this.observe?.({
          kind: 'client_perf',
          playerId,
          fps: message.fps,
          ...(message.rttMs !== undefined ? { rttMs: message.rttMs } : {}),
          ...(message.memMb !== undefined ? { memMb: message.memMb } : {}),
        });
      }
      return;
    }
    if (message.type === 'action.v1') {
      // Gated envelope path (SV-1.1). Requires a configured gate AND the connection's
      // sessionId (bound by the transport at handshake) — without both there is nothing
      // to authorize against, so it is an unroutable message.
      if (this.gate && sessionId !== undefined) {
        // Player-action deny-list (e.g. AvA mode owns the diplomacy stances, AVA-8):
        // peek the envelope's action type BEFORE the gate — a denied type never
        // reaches validation/sequencing, so it costs the client no `clientSeq`.
        const envAction = (message.envelope as { action?: { id?: unknown; type?: unknown } } | null)
          ?.action;
        const deniedCode =
          typeof envAction?.type === 'string' ? this.denyPlayerActions?.(envAction.type) : undefined;
        if (deniedCode) {
          this.sendReject(
            peer,
            typeof envAction?.id === 'string' ? envAction.id : 'unknown',
            deniedCode,
          );
          return;
        }
        await this.admitEnvelope(playerId, peer, message.envelope, sessionId);
      } else {
        this.send(peer, { type: 'error', matchId: this.id, code: 'E_BAD_MESSAGE' });
      }
      return;
    }
    // Bare-action path. A gated room refuses it: a bare action would bypass envelope
    // validation, authorization and the sequence gate.
    if (this.gate) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_BAD_MESSAGE' });
      return;
    }
    // The same player deny-list on the bare path. Server-internal drivers (AI /
    // standing orders / the AvA war escalation itself) do NOT pass through `receive`,
    // so they stay unaffected — the deny is a WIRE rule, not a reducer rule.
    const denied = this.denyPlayerActions?.(message.action.type);
    if (denied) {
      this.sendReject(peer, message.action.id, denied);
      return;
    }
    if (this.persist) {
      await this.submitActionCommitted(playerId, message.action, peer);
    } else {
      this.submitAction(playerId, message.action, peer);
    }
  }

  /**
   * The `@void/action-layer` front door (SV-1.1): validate → authorize → sequence →
   * dedup an incoming envelope, then apply an accepted action through the sync reducer
   * core and record the verdict in the gate for idempotent replay. Every failure is a
   * stable `E_*` code with no internal detail (fail-secure, OWASP A10).
   */
  private async admitEnvelope(
    playerId: PlayerId,
    peer: RoomPeer,
    envelope: unknown,
    sessionId: string,
  ): Promise<void> {
    // Durable committed path: serialize the WHOLE admit+commit through the actor mailbox,
    // so the ActionGate's sequence reservation and the async durable apply are one atomic
    // step. Otherwise a later action's admit could advance the cursor past an earlier one
    // whose persist is still in flight, making that earlier one's transient failure
    // un-retriable (E_REPLAY). The sync path can't interleave, so it needs no mailbox.
    if (this.persist) {
      await this.enqueue(() =>
        this.admitCommitted(playerId, peer, envelope, sessionId).catch(() => {
          try {
            this.sendReject(peer, envelopeActionId(envelope), 'E_INTERNAL');
          } catch {
            /* peer gone */
          }
        }),
      );
      return;
    }
    const accepted = this.admitDecision(playerId, peer, envelope, sessionId);
    if (!accepted) return;
    // Apply through the shared SYNC reducer core — no re-dedup / re-rate-limit /
    // re-ownership (the gate + the rate-limit above already enforced them).
    const result = this.applyAndBroadcast(playerId, accepted.action, peer);
    this.gate!.commit(
      accepted.envelope,
      result.ok ? { ok: true } : { ok: false, code: result.code ?? 'E_INTERNAL' },
    );
  }

  /** Gated committed apply (runs inside the mailbox): admit, then push an accepted action
   *  through the durable `commitApply`, recording the durable verdict in the ActionGate. A
   *  transient (non-durable) failure is NOT cached, so the action stays retriable. */
  private async admitCommitted(
    playerId: PlayerId,
    peer: RoomPeer,
    envelope: unknown,
    sessionId: string,
  ): Promise<void> {
    const accepted = this.admitDecision(playerId, peer, envelope, sessionId);
    if (!accepted) return;
    await this.maybeSyncArsenal(playerId, accepted.action);
    const verdict = await this.commitApply(playerId, accepted.action, peer);
    if (verdict.ok) {
      this.gate!.commit(accepted.envelope, { ok: true });
    } else if (verdict.durable) {
      this.gate!.commit(accepted.envelope, { ok: false, code: verdict.code });
    } else {
      // Transient failure (store down): release the sequence reservation so a backoff-retry
      // of the same clientSeq is admitted again instead of hitting E_REPLAY. Safe because
      // this admit→commit ran serialized in the mailbox — nothing reserved past it.
      this.gate!.rollback(accepted.envelope);
    }
  }

  /** The shared front of the gated path (both sync and committed): rate-limit → gate.admit,
   *  handling a duplicate replay or a rejection inline. Returns the accepted action to apply,
   *  or null when it was already handled (rejected / replayed). */
  private admitDecision(
    playerId: PlayerId,
    peer: RoomPeer,
    envelope: unknown,
    sessionId: string,
  ): AcceptedAction | null {
    // Rate-limit BEFORE the sequence-reserving admit: a throttled action must not reserve
    // its clientSeq, or a legitimate backoff-retry of the same seq would hit E_REPLAY. This
    // is the fine-grained per-player limit (the connection-level flood guard is in wsServer).
    if (this.rateLimited(playerId)) {
      this.sendReject(peer, envelopeActionId(envelope), 'E_RATE_LIMIT');
      return null;
    }
    const admission = this.gate!.admit(envelope, { matchId: this.id, playerId, sessionId });
    if (!admission.ok) {
      this.sendReject(peer, envelopeActionId(envelope), admission.code);
      return null;
    }
    const value = admission.value;
    if (value.status === 'duplicate') {
      // Idempotent replay — mirror the bare path's dedup response: a full resync for an
      // action that succeeded, the cached rejection otherwise. No re-apply.
      if (value.receipt.ok) this.send(peer, this.stateMessageFor(playerId));
      else this.sendReject(peer, value.receipt.actionId, value.receipt.code ?? 'E_INTERNAL');
      return null;
    }
    return value;
  }

  submitAction(playerId: PlayerId, action: Action, peer?: RoomPeer): SubmitResult {
    const cached = this.receipts.get(action.id);
    if (cached) {
      if (peer) {
        if (cached.ok) this.send(peer, this.stateMessageFor(playerId));
        else this.sendRejection(peer, cached);
      }
      return { ok: cached.ok, seq: cached.seq, events: [], code: cached.code };
    }

    // Rate limit (F-03): cap submits per player per window. A flood past the cap is
    // rejected TRANSIENTLY — no receipt is recorded, so a genuine retry after backoff
    // still lands (idempotency must never turn a rate-limit into a permanent reject).
    if (this.rateLimited(playerId)) {
      if (peer) {
        this.send(peer, {
          type: 'rejection',
          matchId: this.id,
          seq: this.seq,
          actionId: action.id,
          code: 'E_RATE_LIMIT',
        });
      }
      return { ok: false, seq: this.seq, events: [], code: 'E_RATE_LIMIT' };
    }

    if (action.playerId !== playerId || !this.hasPlayer(playerId)) {
      const receipt = this.recordReceipt(action, playerId, false, 'E_FORBIDDEN');
      if (peer) this.sendRejection(peer, receipt);
      return { ok: false, seq: receipt.seq, events: [], code: receipt.code };
    }

    return this.applyAndBroadcast(playerId, action, peer);
  }

  /** Server-internal submit (AI stand-ins / standing orders / steward drivers). On an
   *  in-memory room it is the plain sync submit; on a DURABLE room it serializes
   *  through the actor mailbox and commits-before-broadcast like any player action —
   *  a raw sync `submitAction` there mutates `stateValue`/`seq` in the middle of a
   *  `commitApply` persist await, and the await's resolution then overwrites the
   *  driver's acked change and rewinds `seq` (bug-hunt CRIT: silent state loss). */
  async submitServerAction(playerId: PlayerId, action: Action): Promise<{ ok: boolean; code?: string }> {
    if (!this.persist) {
      const r = this.submitAction(playerId, action);
      return { ok: r.ok, ...(r.code !== undefined ? { code: r.code } : {}) };
    }
    let out: { ok: boolean; code?: string } = { ok: false, code: 'E_INTERNAL' };
    await this.enqueue(async () => {
      const cached = this.receipts.get(action.id);
      if (cached) {
        out = { ok: cached.ok, ...(cached.code !== undefined ? { code: cached.code } : {}) };
        return;
      }
      if (this.rateLimited(playerId)) {
        out = { ok: false, code: 'E_RATE_LIMIT' }; // transient — the driver's next pass retries
        return;
      }
      const verdict = await this.commitApply(playerId, action);
      out = verdict.ok ? { ok: true } : { ok: false, code: verdict.code ?? 'E_INTERNAL' };
    }).catch(() => {
      out = { ok: false, code: 'E_INTERNAL' };
    });
    return out;
  }

  /**
   * The reducer core, AFTER the front gates (dedup, rate-limit, ownership): catch the
   * world up to now, apply the action, commit + broadcast. Shared by the bare
   * `submitAction` and the gated `admitEnvelope` (which pre-clears the gates via the
   * ActionGate), so neither re-runs a gate the other already applied.
   */
  private applyAndBroadcast(playerId: PlayerId, action: Action, peer?: RoomPeer): SubmitResult {
    const startedAt = this.observe ? performance.now() : 0;
    try {
      const serverNow = this.clock();
      const advanced = this.advance(serverNow);
      if (!advanced.ok) {
        const receipt = this.recordReceipt(action, playerId, false, advanced.code);
        if (peer) this.sendRejection(peer, receipt);
        return { ok: false, seq: receipt.seq, events: [], code: receipt.code };
      }

      const context = this.context(Math.max(serverNow, this.stateValue.time));
      const result = this.kernel.applyAction(this.stateValue, action, context);
      if (!result.ok) {
        // SRV-1: the action is rejected, but `advance` above already COMMITTED the
        // world forward and produced events (arrivals, battles, captures). Flush them
        // so peers see the advanced world instead of losing it until the next accepted
        // action — without a tick loop, that could be hours of game time.
        if (advanced.events.length > 0) this.broadcastState(advanced.events);
        const receipt = this.recordReceipt(action, playerId, false, result.code);
        if (peer) this.sendRejection(peer, receipt);
        return { ok: false, seq: receipt.seq, events: [], code: receipt.code };
      }

      this.stateValue = result.state;
      const receipt = this.recordReceipt(action, playerId, true);
      const events = [...advanced.events, ...result.events];
      this.broadcastState(events);
      this.observeEndIfNeeded();
      return { ok: true, seq: receipt.seq, events };
    } finally {
      // M1 submit timing: the whole advance→apply→broadcast span (the doc's
      // "submit → broadcast" latency; target p95 < 20 ms on the sync path).
      this.observe?.({
        kind: 'timing',
        op: 'submit',
        ms: performance.now() - startedAt,
        seq: this.seq,
        actionType: action.type,
      });
    }
  }

  /** Per-player action rate limit (F-03): true if `playerId` is over `actionRateMax`
   *  submits in the trailing `actionRateWindowMs`. When under, records this submit's
   *  timestamp and returns false. Shared by every action path so the cap is per-player,
   *  not per-path. Pure check-and-record — the caller sends the transient reject. */
  private rateLimited(playerId: PlayerId): boolean {
    const rateNow = this.now();
    if (this.actionWindow.limited(playerId, rateNow)) return true;
    this.actionWindow.record(playerId, rateNow);
    return false;
  }

  /** Advance the world to the current clock and broadcast what changed — the
   *  offline heartbeat. It fires due scheduled events (arrivals, battles,
   *  captures) with NO player action, so the world keeps running 24/7 while
   *  everyone is away. A wakeup driver calls this when `msUntilNextEvent` elapses.
   *  No-op while the clock is frozen (lobby) or when nothing is due yet. */
  tick(): boolean {
    // Skip while a committed submit holds the world: its catch-up is computed but not yet
    // committed to `stateValue` (commit-before-broadcast), so advancing here would race
    // the submit's pending commit. `msUntilNextEvent` reports null while committing, so a
    // driver idles rather than firing skipped ticks; the submit re-arms it on commit.
    if (this.waiting || this.committing) return false;
    const before = this.stateValue.time;
    const startedAt = this.observe ? performance.now() : 0;
    const advanced = this.advance(this.clock());
    if (advanced.ok && advanced.events.length > 0) {
      this.broadcastState(advanced.events);
      this.observeEndIfNeeded();
      // M1 advance timing: the cost of this heartbeat catch-up (advance + fan-out).
      // Only ticks that actually fired events are reported — an idle heartbeat that
      // moved nothing would just flood the stream with 0 ms noise.
      this.observe?.({
        kind: 'timing',
        op: 'advance',
        ms: performance.now() - startedAt,
        seq: this.seq,
      });
    }
    // Whether the world clock moved forward — a wakeup driver uses this to tell a
    // legit (progressing) catch-up from a same-instant runaway (stalled) and back off.
    return this.stateValue.time > before;
  }

  /** Wall-ms until the soonest scheduled event comes due — what an offline wakeup
   *  driver sleeps for before calling `tick`. `null` when nothing is pending or
   *  the clock is frozen (lobby): there is nothing to wake for. The world clock
   *  advances 1:1 with wall-time, so the game-ms gap to the event IS the wall-ms
   *  to sleep; clamped at 0 for an already-overdue event. */
  msUntilNextEvent(): number | null {
    // While a committed submit owns the world, its catch-up isn't committed to
    // `stateValue` yet, so the still-pending events read as overdue (ms 0). Report
    // "nothing to wake for" so a driver idles instead of spinning on skipped ticks and
    // tripping its stall guard — the submit re-arms the driver when it commits.
    if (this.waiting || this.committing) return null;
    const scheduled = this.stateValue.scheduled;
    if (scheduled.length === 0) return null;
    let soonest = Infinity;
    for (const e of scheduled) if (e.at < soonest) soonest = e.at;
    // game-ms gap → wall-ms to sleep (the clock runs `timeScale`× faster than wall-time).
    return Math.max(0, (soonest - this.clock()) / this.timeScale);
  }

  /** A full per-player resync snapshot (fog applied), e.g. for a deduped retry.
   *  Resets that player's delta baseline. */
  private stateMessageFor(playerId: PlayerId): ServerMessage {
    const view = this.viewFor(playerId);
    this.lastVisible.set(playerId, view.base);
    return {
      type: 'state',
      matchId: this.id,
      seq: this.seq,
      serverTime: this.clock(),
      state: view.base,
      events: [],
      signatures: view.signatures,
      remembered: view.remembered,
      ...this.hashField(view.base),
      ...this.lobbyField(),
    };
  }

  /** Advance `this.stateValue` to `now`, committing the catch-up in place. Thin wrapper
   *  over the pure `computeAdvance` — used by the sync `submitAction` and `tick`. */
  private advance(now: number): { ok: true; events: DomainEvent[] } | { ok: false; code: string } {
    const r = this.computeAdvance(this.stateValue, now);
    if (!r.ok) return { ok: false, code: r.code };
    this.stateValue = r.state;
    return { ok: true, events: r.events };
  }

  /**
   * Pure world catch-up from `from` to `now` — returns the advanced state WITHOUT
   * mutating `this.stateValue`, so the committed path can compute the advance, persist
   * it, and only THEN expose it (a mid-persist read / new-peer welcome must not see a
   * not-yet-durable world). The kernel bounds each `advanceTo` and returns a `partial`
   * advance rather than discarding it; chain a bounded number of chunks so an
   * enormous-but-legit backlog finishes without hanging the event loop, and a
   * same-instant runaway (clock stops progressing) is surfaced instead of looping.
   */
  private computeAdvance(
    from: GameState,
    now: number,
  ): { ok: true; state: GameState; events: DomainEvent[] } | { ok: false; code: string } {
    if (now <= from.time) return { ok: true, state: from, events: [] };
    let state = from;
    const events: DomainEvent[] = [];
    for (let chunk = 0; chunk < MAX_CATCHUP_CHUNKS; chunk++) {
      const before = state.time;
      const result = this.kernel.advanceTo(state, this.context(now));
      if (!result.ok) return { ok: false, code: result.code };
      if (result.failures.length > 0) {
        // Dead-lettered events must not vanish silently — surface them to the host's
        // observation stream (JSONL log / metrics), the "details belong in server
        // logs" half of invariant #4.
        this.observe?.({ kind: 'dead_letter', failures: result.failures });
      }
      state = result.state;
      events.push(...result.events);
      if (!result.partial) return { ok: true, state, events }; // reached `now`
      if (state.time <= before) {
        // Clock did not move despite work being done → a same-instant runaway. Stop.
        this.observe?.({ kind: 'advance_overflow', reachedTime: state.time, targetTime: now, reason: 'stalled' });
        return { ok: true, state, events };
      }
    }
    // Made forward progress but ran out of chunks — a genuinely huge backlog. Yield.
    this.observe?.({ kind: 'advance_overflow', reachedTime: state.time, targetTime: now, reason: 'throttled' });
    return { ok: true, state, events };
  }

  private context(now: number): Context {
    return { now, data: this.data, config: this.config };
  }

  private recordReceipt(
    action: Action,
    playerId: PlayerId,
    ok: boolean,
    code?: string,
  ): ActionReceipt {
    this.seq += 1;
    const receipt =
      code === undefined
        ? { actionId: action.id, playerId, seq: this.seq, ok }
        : { actionId: action.id, playerId, seq: this.seq, ok, code };
    // Sync path: not inside a `committing` window, so emitting the observation now is safe
    // (a driver reschedule sees the committed clock). The committed path retains + observes
    // separately so it can defer the observation past its `committing` window.
    this.retainReceipt(receipt);
    this.observeAction(receipt, action.type);
    return receipt;
  }

  /** Retain a receipt in the in-memory idempotency map (FIFO-capped). No side effects
   *  beyond the map, so the committed path can retain during its `committing` window and
   *  emit the observation only after it clears. */
  private retainReceipt(receipt: ActionReceipt): void {
    this.receipts.set(receipt.actionId, receipt);
    // Bound memory (F-04): idempotency is needed for the retry window (minutes), not
    // forever — evict the oldest receipts past the cap (Map preserves insertion order).
    while (this.receipts.size > this.maxReceipts) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
  }

  /** Emit the `action` observation (metrics + the driver re-arm). MUST be called with
   *  `committing` false: a driver's `reschedule` reads `msUntilNextEvent`, which reports
   *  null while committing — so emitting mid-commit would leave the driver un-armed and
   *  the 24/7 world stalled for connected players until their next action. */
  private observeAction(receipt: ActionReceipt, actionType: string): void {
    this.observe?.({
      kind: 'action',
      actionId: receipt.actionId,
      playerId: receipt.playerId,
      type: actionType,
      ok: receipt.ok,
      seq: receipt.seq,
      ...(receipt.code ? { code: receipt.code } : {}),
    });
  }

  /** Builds a durable snapshot of a specific `(state, seq)` — used by the committed
   *  path to persist a prospective result BEFORE committing it. */
  private snapshot(state: GameState, seq: number): MatchSnapshot {
    return {
      matchId: this.id,
      dataVersion: state.version.data,
      seq,
      status: state.match.status === 'ended' ? 'ended' : 'ongoing',
      state,
    };
  }

  /** Append a task to the actor mailbox — it runs after any in-flight one, so their
   *  critical sections (incl. awaits) never interleave. The stored link must NEVER be a
   *  rejected promise: `.then` on a rejected upstream skips its callback, which would
   *  silently stop EVERY future task on this room. Tasks own their error handling; this
   *  is the backstop. */
  private enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.mailbox.then(task);
    this.mailbox = run.catch(() => undefined);
    return run;
  }

  /**
   * Strict commit-before-broadcast action path (options.persist). Serialized per room
   * via the actor mailbox, so the async persist await can never let a second action (or
   * a lobby start) race the reducer. The tail (advance → apply → persist → commit →
   * broadcast) runs with `committing` set so a concurrent `tick()` skips. An unexpected
   * throw is contained (transient reject) and never wedges the mailbox.
   */
  private submitActionCommitted(playerId: PlayerId, action: Action, peer?: RoomPeer): Promise<void> {
    return this.enqueue(() =>
      this.doCommittedSubmit(playerId, action, peer).catch(() => {
        // Last-resort: report and swallow. The `send` itself must not throw (a dead
        // socket would otherwise reject the task), so guard it too.
        try {
          if (peer) this.sendReject(peer, action.id, 'E_INTERNAL');
        } catch {
          /* peer gone */
        }
      }),
    );
  }

  private async doCommittedSubmit(
    playerId: PlayerId,
    action: Action,
    peer?: RoomPeer,
  ): Promise<void> {
    // Idempotent replay of a prior result (dedup) — mirrors submitAction, sync/no-await.
    const cached = this.receipts.get(action.id);
    if (cached) {
      if (peer) {
        if (cached.ok) this.send(peer, this.stateMessageFor(playerId));
        else this.sendRejection(peer, cached);
      }
      return;
    }
    // Rate limit — transient reject, NO receipt (a genuine retry after backoff lands).
    if (this.rateLimited(playerId)) {
      if (peer) this.sendReject(peer, action.id, 'E_RATE_LIMIT');
      return;
    }
    await this.maybeSyncArsenal(playerId, action);
    await this.commitApply(playerId, action, peer);
  }

  /** LARS-1 — refresh a seat's live build-catalog ownership right before a
   *  `unit.build` that the BOOT-TIME snapshot (ARS-3) would reject. A no-op unless
   *  every precondition holds: `arsenalStore` configured, the seat's `accountId`
   *  known (from `addPeer`), a snapshot present on the player (no snapshot = already
   *  unrestricted — nothing to refresh), and the requested hull/modules actually miss
   *  from it. On a hit, submits an internal `arsenal.sync` (own id namespace, own
   *  `commitApply` — a REAL, persisted, broadcast, hash-consistent action, never a
   *  silent state patch) BEFORE the caller's `commitApply` for the original action,
   *  so the unchanged ARS-3 check in `construction.ts` sees current ownership. */
  private async maybeSyncArsenal(playerId: PlayerId, action: Action): Promise<void> {
    if (!this.arsenalStore || action.type !== 'unit.build') return;
    const accountId = this.playerAccountId.get(playerId);
    if (!accountId) return;
    const player = this.stateValue.players[playerId];
    if (!player?.arsenal) return;
    const payload = action.payload as { unit?: unknown; modules?: unknown } | null;
    const unit = typeof payload?.unit === 'string' ? payload.unit : undefined;
    const modules = Array.isArray(payload?.modules)
      ? payload.modules.filter((m): m is string => typeof m === 'string')
      : [];
    const alreadyOwned =
      (!unit || player.arsenal.hulls.includes(unit)) &&
      modules.every((m) => player.arsenal!.modules.includes(m));
    if (alreadyOwned) return; // covered by the boot snapshot — no live read needed
    const fresh = arsenalSnapshotOf(await this.arsenalStore.listOf(accountId));
    if (sameArsenal(player.arsenal, fresh)) return; // still doesn't own it — the
    // unchanged core check below will reject with E_NOT_OWNED as before
    await this.commitApply(
      playerId,
      { id: `srv:arsenal-sync:${playerId}:${this.seq}`, type: 'arsenal.sync', playerId, payload: fresh, issuedAt: this.clock() },
      undefined,
    );
  }

  /**
   * The durable commit-before-broadcast CORE (advance → apply → persist → commit →
   * broadcast), AFTER the front gates (dedup, rate-limit — and, on the gated path, the
   * ActionGate's authorize/sequence). Runs with `committing` set so a concurrent `tick()`
   * skips. Returns the durable verdict so the gated path can record it in the ActionGate;
   * a `durable:false` verdict is a transient failure (persist down) that must NOT be
   * cached (the action stays retriable). Shared by the bare committed path and the gated
   * committed path.
   */
  private async commitApply(
    playerId: PlayerId,
    action: Action,
    peer?: RoomPeer,
  ): Promise<CommitVerdict> {
    this.committing = true;
    const startedAt = this.observe ? performance.now() : 0;
    // Deferred to the `finally` (after `committing` clears): emitting the `action`
    // observation re-arms the clock driver, which reads `msUntilNextEvent` — null while
    // committing. Emitting mid-commit would leave the driver un-armed and stall the 24/7
    // world for connected players until their next action.
    let observeCommitted: (() => void) | undefined;
    try {
      // Authorization — a durable failure receipt (no state change).
      if (action.playerId !== playerId || !this.hasPlayer(playerId)) {
        const receipt = await this.commitReject(playerId, action, 'E_FORBIDDEN', peer);
        if (!receipt) return TRANSIENT_VERDICT;
        observeCommitted = () => this.observeAction(receipt, action.type);
        return { ok: false, code: 'E_FORBIDDEN', durable: true };
      }

      // Catch the world up PURELY — without touching `this.stateValue` — so an external
      // read during the persist await (a new peer's `welcome`, a ping handler) never sees
      // a not-yet-durable world. We commit the advance only after the write acks.
      const serverNow = this.clock();
      const advanced = this.computeAdvance(this.stateValue, serverNow);
      if (!advanced.ok) {
        const receipt = await this.commitReject(playerId, action, advanced.code, peer);
        if (!receipt) return TRANSIENT_VERDICT;
        observeCommitted = () => this.observeAction(receipt, action.type);
        return { ok: false, code: advanced.code, durable: true };
      }

      const context = this.context(Math.max(serverNow, advanced.state.time));
      const result = this.kernel.applyAction(advanced.state, action, context);
      const seq = this.seq + 1;

      if (!result.ok) {
        // Reject-but-advanced: persist the advanced state + failure receipt, and only on a
        // durable ack commit the recomputable catch-up and broadcast its events (SRV-1). A
        // failed write commits nothing → the retry re-derives and re-broadcasts the advance.
        const receipt: ActionReceipt = { actionId: action.id, playerId, seq, ok: false, code: result.code };
        if (!(await this.persistGuarded(this.snapshot(advanced.state, seq), receipt, action.id, peer))) {
          return TRANSIENT_VERDICT;
        }
        this.stateValue = advanced.state;
        this.seq = seq;
        this.retainReceipt(receipt);
        observeCommitted = () => this.observeAction(receipt, action.type);
        if (advanced.events.length > 0) this.broadcastState(advanced.events);
        if (peer) this.sendRejection(peer, receipt);
        return { ok: false, code: result.code, durable: true };
      }

      // Success: persist the final state + receipt, and ONLY on a durable ack commit the
      // new state, the receipt and the broadcast. A failed write commits nothing.
      const receipt: ActionReceipt = { actionId: action.id, playerId, seq, ok: true };
      if (!(await this.persistGuarded(this.snapshot(result.state, seq), receipt, action.id, peer))) {
        return TRANSIENT_VERDICT;
      }
      this.stateValue = result.state;
      this.seq = seq;
      this.retainReceipt(receipt);
      observeCommitted = () => this.observeAction(receipt, action.type);
      this.broadcastState([...advanced.events, ...result.events]);
      this.observeEndIfNeeded();
      return { ok: true };
    } finally {
      this.committing = false;
      observeCommitted?.(); // now that committing is false, the driver re-arm sees the real next event
      // M1 submit timing for the durable path: advance→apply→persist→commit→broadcast —
      // the client-felt submit latency INCLUDING the durable write. Emitted after
      // `committing` clears, same as the action observation above.
      this.observe?.({
        kind: 'timing',
        op: 'submit',
        ms: performance.now() - startedAt,
        seq: this.seq,
        actionType: action.type,
      });
    }
  }

  /** Persist a failure receipt (state unchanged) before acking the rejection, so a
   *  retry after a restart stays deduped. A failed write ⇒ transient reject, no commit.
   *  Returns the committed receipt (for the caller's deferred observation) or null on a
   *  transient failure. Retains the receipt but does NOT observe — the caller emits the
   *  observation after its `committing` window (see commitApply). */
  private async commitReject(
    playerId: PlayerId,
    action: Action,
    code: string,
    peer?: RoomPeer,
  ): Promise<ActionReceipt | null> {
    const seq = this.seq + 1;
    const receipt: ActionReceipt = { actionId: action.id, playerId, seq, ok: false, code };
    if (!(await this.persistGuarded(this.snapshot(this.stateValue, seq), receipt, action.id, peer))) {
      return null;
    }
    this.seq = seq;
    this.retainReceipt(receipt);
    if (peer) this.sendRejection(peer, receipt);
    return receipt;
  }

  /** Awaits the durable write. On reject/throw: commit nothing, send a TRANSIENT reject
   *  (no receipt) so the client's retry lands once the store recovers. Returns success. */
  private async persistGuarded(
    snapshot: MatchSnapshot,
    receipt: StoredReceipt,
    actionId: string,
    peer?: RoomPeer,
  ): Promise<boolean> {
    try {
      await this.persist!(snapshot, receipt);
      return true;
    } catch {
      if (peer) this.sendReject(peer, actionId, 'E_UNAVAILABLE');
      return false;
    }
  }

  /** Send a rejection that records NO room receipt. Whether the action is retriable is
   *  per-code and the client's call: transient (E_RATE_LIMIT / E_UNAVAILABLE / E_INTERNAL)
   *  vs. permanent (E_FORBIDDEN / E_BAD_PAYLOAD / a sequence code). Used by both the bare
   *  committed path and the action-layer gate front door. */
  private sendReject(peer: RoomPeer, actionId: string, code: string): void {
    this.send(peer, { type: 'rejection', matchId: this.id, seq: this.seq, actionId, code });
  }

  private broadcastState(events: DomainEvent[]): void {
    // M1 events observation: surface the raw (pre-fog) domain events of this committed
    // change to the metrics stream — battles/captures/arrivals are countable even with
    // no peer connected (the 24/7 world fights alone). Clock spans are pure noise here.
    if (this.observe && events.length > 0) {
      const observable = events.filter((e) => e.type !== 'time.advanced');
      if (observable.length > 0) {
        this.observe({ kind: 'events', seq: this.seq, events: observable });
      }
    }
    // Fog of war is a server boundary: each player gets a delta against THEIR own
    // last visible view, so hidden worlds/fleets are physically never sent. Only
    // what changed in that player's view goes out (an idle world ⇒ tiny payload).
    const now = this.clock();
    const lobby = this.lobbyField();
    const startedAt = this.observe ? performance.now() : 0;
    const deltaBytes: Record<PlayerId, number> = {};
    for (const [playerId, playerPeers] of this.peers) {
      // Broadcast is BEST-EFFORT and per-player isolated: computing one player's fogged
      // view (viewFor/diffState/identifiedNodes) must never abort delivery to the others,
      // and must never escape into the action path — a delivery slip can't undo an
      // already-committed, already-persisted action (the client resyncs on reconnect). The
      // durable commit is the source of truth; this is just how we tell peers about it.
      try {
        const view = this.viewFor(playerId);
        const baseline = this.lastVisible.get(playerId) ?? view.base;
        const identify = view.identified;
        const delta = diffState(baseline, view.base);
        const message: ServerMessage = {
          type: 'delta',
          matchId: this.id,
          seq: this.seq,
          serverTime: now,
          delta,
          events: events.filter((e) => this.eventVisibleTo(e, playerId, identify)),
          signatures: view.signatures,
          remembered: view.remembered,
          ...this.hashField(view.base),
          ...lobby,
        };
        this.lastVisible.set(playerId, view.base);
        if (this.observe) deltaBytes[playerId] = JSON.stringify(delta).length;
        for (const peer of playerPeers) this.send(peer, message);
      } catch {
        /* skip this player's delta this round; a reconnect gets a fresh welcome */
      }
    }
    // M1 broadcast observation: fan-out cost + per-player delta size (fog efficiency).
    // Only when someone actually received a delta — an empty room has nothing to report.
    if (this.observe && this.peers.size > 0) {
      this.observe({
        kind: 'broadcast',
        seq: this.seq,
        ms: performance.now() - startedAt,
        deltaBytes,
      });
    }
  }

  /** Whether a domain event may be revealed to `playerId` — events leak intent
   *  too, so they pass the same fog as state: your own actions, anything at a
   *  world you identify, and global clock/match events; everything else is cut.
   *
   *  ⚠ CONVENTION COUPLING: this filter reads the payload KEY NAMES every core
   *  module uses today (audience: `owner`/`playerId`/`a`/`b`/`from`/`to`/
   *  `buyer`/`seller`; place: `location`/`planetId`/`at`; ownership: `fleetId`)
   *  — documented in docs/modulesystem.md («События и фог»). A new module that
   *  names its addressee differently (`target`, `recipient`, …) will have its
   *  events silently HIDDEN from that player (fail-closed, never a leak) until
   *  the key is added here. Name payload keys by the convention — or extend the
   *  lists below together with a test in matchRoom.test.ts. */
  private eventVisibleTo(event: DomainEvent, playerId: PlayerId, identify: Set<string>): boolean {
    if (event.type === 'time.advanced' || event.type.startsWith('match.')) return true;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    // Hero events are strictly owner-only: their payloads carry the hero's node
    // (`at`) and fleet, which the fog projection deliberately hides from everyone
    // else — an identified-node match must NOT reveal them.
    if (event.type.startsWith('hero.')) return p.owner === playerId;
    if (p.owner === playerId) return true;
    // Personal and bilateral events name their audience with these keys (research,
    // steward, elimination, diplomacy offers/changes, market trades) — a named
    // participant always sees their own event.
    for (const key of ['playerId', 'a', 'b', 'from', 'to', 'buyer', 'seller'] as const) {
      if (p[key] === playerId) return true;
    }
    for (const key of ['location', 'planetId', 'at'] as const) {
      const node = p[key];
      if (typeof node === 'string' && identify.has(node)) return true;
    }
    const fleetId = p.fleetId;
    if (typeof fleetId === 'string' && this.stateValue.fleets[fleetId]?.owner === playerId) {
      return true;
    }
    return false;
  }

  private sendRejection(peer: RoomPeer, receipt: ActionReceipt): void {
    const message: ServerRejectionMessage = {
      type: 'rejection',
      matchId: this.id,
      seq: receipt.seq,
      actionId: receipt.actionId,
      code: receipt.code ?? 'E_INTERNAL',
    };
    this.send(peer, message);
  }

  // --- ally pings (ephemeral, server-side; never part of the deterministic core) ---

  /** Same player, the same static team, or a LIVE in-state alliance (the diplomacy
   *  relation this predicate was always meant to read). Evaluated at delivery time,
   *  so ally-only traffic (pings, coalition chat) follows the current stance map:
   *  a new ally starts seeing it, an ex-ally stops. */
  private areAllied(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    const ta = this.teams[a];
    if (ta !== undefined && ta === this.teams[b]) return true;
    return getStance(this.stateValue, a, b) === 'alliance';
  }

  /** A ping is visible to its owner and the owner's allies; never to enemies. The
   *  privacy guarantee is enforced HERE (server-side): an enemy is never sent the
   *  ping at all, exactly like fog. Allies see it even on tiles they can't see —
   *  that is the whole point ("look here"). */
  private canSeePing(recipient: PlayerId, ping: Ping): boolean {
    return this.areAllied(recipient, ping.owner);
  }

  /** Relay a ping message to every connected peer who may see that ping. */
  private relayToViewers(ping: Ping, message: ServerMessage): void {
    for (const [pid, peers] of this.peers) {
      if (!this.canSeePing(pid, ping)) continue;
      for (const peer of peers) this.send(peer, message);
    }
  }

  private pingKey(pingId: string): string {
    return `match:${this.id}:ping:${pingId}`;
  }
  private get pingPrefix(): string {
    return `match:${this.id}:ping:`;
  }

  private async handlePingPlace(
    playerId: PlayerId,
    peer: RoomPeer,
    message: ClientPingPlaceMessage,
  ): Promise<void> {
    if (!this.hasPlayer(playerId)) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_FORBIDDEN' });
      return;
    }
    const now = this.clock();
    // rate limit (local, single-process): at most PING_RATE_MAX placements per window.
    // Moves into the ephemeral store as an atomic counter once there's >1 process.
    // WALL clock, like chat: on the frozen lobby clock the window would never
    // expire and PING_RATE_MAX placements would lock the player out for good.
    const wall = this.now();
    if (this.pingWindow.limited(playerId, wall)) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_PING_RATE' });
      return;
    }
    const draft = message.ping;
    if ((draft.kind === 'move' || draft.kind === 'attack') && draft.to === undefined) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_PING_TARGET' });
      return;
    }
    if (draft.kind === 'build') {
      const building = draft.payload?.building;
      if (typeof building !== 'string' || !this.data.buildings[building]) {
        this.send(peer, { type: 'error', matchId: this.id, code: 'E_PING_BUILD' });
        return;
      }
    }
    // Node anchors must reference a real planet the owner can currently identify —
    // you can't pin a precise marker on a world you've never scouted. Point anchors
    // ({x,y}) are always allowed; they reveal nothing hidden.
    const seen = identifiedNodes(this.stateValue, playerId, this.data);
    for (const anchor of [draft.target, draft.to]) {
      if (!anchor || anchor.node === undefined) continue;
      if (!this.stateValue.planets[anchor.node]) {
        this.send(peer, { type: 'error', matchId: this.id, code: 'E_PING_TARGET' });
        return;
      }
      if (!seen.has(anchor.node)) {
        this.send(peer, { type: 'error', matchId: this.id, code: 'E_PING_UNSEEN' });
        return;
      }
    }
    // Evict this player's oldest pings down to the cap (never hard-block the UX).
    const mine = (await this.ephemeral.entries<Ping>(this.pingPrefix))
      .map((e) => e.value)
      .filter((p) => p.owner === playerId)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= PING_MAX_PER_PLAYER) {
      const old = mine.shift()!;
      await this.ephemeral.delete(this.pingKey(old.id));
      this.relayToViewers(old, {
        type: 'ping.removed',
        matchId: this.id,
        pingId: old.id,
        reason: 'cleared',
      });
    }
    const ping: Ping = {
      id: `ping:${playerId}:${this.pingSeq++}`,
      owner: playerId,
      kind: draft.kind,
      target: draft.target,
      createdAt: now,
      expiresAt: now + this.pingTtlMs,
    };
    if (draft.to) ping.to = draft.to;
    if (draft.payload?.building) ping.payload = { building: draft.payload.building };
    if (draft.label) ping.label = draft.label.slice(0, PING_LABEL_MAX);
    await this.ephemeral.set(this.pingKey(ping.id), ping, this.pingTtlMs);
    this.pingWindow.record(playerId, wall);
    this.relayToViewers(ping, { type: 'ping.added', matchId: this.id, ping });
  }

  private async handlePingClear(playerId: PlayerId, pingId?: string): Promise<void> {
    for (const { value: ping } of await this.ephemeral.entries<Ping>(this.pingPrefix)) {
      if (ping.owner !== playerId) continue;
      if (pingId !== undefined && ping.id !== pingId) continue;
      await this.ephemeral.delete(this.pingKey(ping.id));
      this.relayToViewers(ping, {
        type: 'ping.removed',
        matchId: this.id,
        pingId: ping.id,
        reason: 'cleared',
      });
    }
  }

  /** On join: send the recipient every currently-visible ping. The store drops
   *  expired ones lazily, so there is no separate sweep; the client fades a ping on
   *  its own `expiresAt`. */
  private async sendVisiblePings(playerId: PlayerId, peer: RoomPeer): Promise<void> {
    for (const { value: ping } of await this.ephemeral.entries<Ping>(this.pingPrefix)) {
      if (this.canSeePing(playerId, ping)) {
        this.send(peer, { type: 'ping.added', matchId: this.id, ping });
      }
    }
  }

  // --- session chat (ephemeral relay; never part of the deterministic core) -----

  /** `session` reaches every seat; `dm` exactly the two parties; `coalition` the
   *  sender's CURRENT allies. Enforced HERE (server-side), like fog: a peer outside
   *  the channel is never sent the message at all. */
  private canSeeChat(recipient: PlayerId, message: ChatMessage): boolean {
    if (message.channel === 'session') return true;
    if (message.channel === 'dm') return recipient === message.from || recipient === message.to;
    return this.areAllied(recipient, message.from);
  }

  private handleChatSend(
    playerId: PlayerId,
    peer: RoomPeer,
    message: ClientChatSendMessage,
  ): void {
    if (!this.hasPlayer(playerId)) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_FORBIDDEN' });
      return;
    }
    // Rate limit on WALL clock — the lobby freeze stops the match clock, not the
    // need for flood protection (people talk in the lobby; a frozen window would
    // never expire and lock everyone out after CHAT_RATE_MAX lines).
    const wall = this.now();
    if (this.chatWindow.limited(playerId, wall)) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_CHAT_RATE' });
      return;
    }
    const text = message.text.trim().slice(0, CHAT_TEXT_MAX);
    if (!text) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_CHAT_TEXT' });
      return;
    }
    const msg: ChatMessage = {
      id: `chat:${playerId}:${this.chatSeq++}`,
      from: playerId,
      channel: message.channel,
      text,
      at: this.clock(), // display stamp in match time, like Ping.createdAt
    };
    if (message.channel === 'dm') {
      // A DM must name a real, other seat — the sender is a recipient implicitly.
      if (message.to === undefined || message.to === playerId || !this.hasPlayer(message.to)) {
        this.send(peer, { type: 'error', matchId: this.id, code: 'E_CHAT_TARGET' });
        return;
      }
      msg.to = message.to;
    }
    this.chatWindow.record(playerId, wall);
    this.chatHistory.push(msg);
    if (this.chatHistory.length > CHAT_HISTORY_MAX) this.chatHistory.shift();
    for (const [pid, peers] of this.peers) {
      if (!this.canSeeChat(pid, msg)) continue;
      for (const p of peers) this.send(p, { type: 'chat.msg', matchId: this.id, message: msg });
    }
  }

  /** On join: replay the visible back-log so a (re)connecting player has the talk.
   *  Channel visibility is re-evaluated NOW — a fresh ally reads coalition history,
   *  an ex-ally no longer does. The client dedupes by message id. */
  private sendVisibleChat(playerId: PlayerId, peer: RoomPeer): void {
    for (const msg of this.chatHistory) {
      if (this.canSeeChat(playerId, msg)) {
        this.send(peer, { type: 'chat.msg', matchId: this.id, message: msg });
      }
    }
  }

  private send(peer: RoomPeer, message: ServerMessage): void {
    if (!canSend(peer)) return;
    // Backpressure: a peer whose buffer is backing up isn't draining — keep queuing
    // and the server's memory grows without bound (a fast sender flooding a slow
    // receiver). Drop it; the client auto-reconnects and gets a fresh `welcome` (a
    // full resync), so it can't desync from the delta we skip here.
    if (peer.bufferedAmount !== undefined && peer.bufferedAmount > MAX_BUFFERED_BYTES) {
      peer.close?.(1013, 'backpressure');
      return;
    }
    // A socket that went OPEN→CLOSING after `canSend` (TOCTOU) throws synchronously from
    // `ws.send`. Never let a dead peer throw into room logic — it would abort a broadcast
    // loop or, on the committed path, escape into the commit queue. Drop the peer instead.
    try {
      peer.send(serializeServerMessage(message));
    } catch {
      peer.close?.();
    }
  }
}
