import type {
  Action,
  Context,
  DomainEvent,
  GameData,
  GameState,
  Kernel,
  PlayerId,
  SignatureContact,
} from '@void/shared-core';
import { diffState, hashState, identifiedNodes, visibleState } from '@void/shared-core';
import {
  parseClientMessage,
  serializeServerMessage,
  type ClientPingPlaceMessage,
  type LobbyInfo,
  type Ping,
  type ServerMessage,
  type ServerRejectionMessage,
} from './protocol';
import type { MatchSnapshot, StoredReceipt } from './store';
import { InMemoryEphemeralStore, type EphemeralStore } from './ephemeral';

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
  /** Resume an already-started manual-start match (e.g. restored from a snapshot
   *  after a restart): skip the lobby and continue the clock from `initialState.time`
   *  instead of waiting for a fresh Start press. Ignored unless `manualStart`. */
  initiallyStarted?: boolean;
  /** Attach `hashState(view)` to each snapshot so the client can detect desync.
   *  Opt-in (it hashes the per-player view on every broadcast). */
  emitStateHash?: boolean;
  /** 1v1 lobby guard: reject a second LIVE connection to an already-occupied
   *  player slot, so two people can't both take the same side (which would leave
   *  the lobby waiting forever for the empty side). A slot frees the moment its
   *  peer disconnects, so reconnect-after-drop still works. Default false. */
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
   *  1 = real-time. Requires a lobby gate (manualStart / waitForPlayers). */
  timeScale?: number;
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
  | { kind: 'end'; winner: PlayerId | null; reason?: string }
  /** The world clock could not fully reach `now` in one `advance` call. `reason`
   *  distinguishes an enormous-but-legitimate catch-up that was throttled to bound
   *  work (`throttled` — it will finish on the next advance) from a same-instant
   *  runaway where the clock stopped progressing (`stalled` — a content/module bug
   *  that needs attention). Ops should alert on `stalled`. */
  | { kind: 'advance_overflow'; reachedTime: number; targetTime: number; reason: 'throttled' | 'stalled' };

export interface SubmitResult {
  ok: boolean;
  seq: number;
  events: DomainEvent[];
  code?: string;
}

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

/** Ally-ping tuning (ephemeral, server-side; never part of the deterministic core). */
const PING_DEFAULT_TTL_MS = 5 * 60_000;
const PING_MAX_PER_PLAYER = 8;
const PING_RATE_WINDOW_MS = 2_000;
const PING_RATE_MAX = 4;
const PING_LABEL_MAX = 40;

/** Idempotency-receipt + action-rate bounds (DoS / memory; audit F-03/F-04). */
const RECEIPTS_MAX_DEFAULT = 10_000;
const ACTION_RATE_MAX_DEFAULT = 20;
const ACTION_RATE_WINDOW_MS_DEFAULT = 1_000;

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
  private readonly pingTimes = new Map<PlayerId, number[]>();
  /** Cap on retained idempotency receipts (FIFO eviction past it — bounds memory). */
  private readonly maxReceipts: number;
  /** Per-player action rate limit (local, single-process; → ephemeral store at >1 proc). */
  private readonly actionRateMax: number;
  private readonly actionRateWindowMs: number;
  /** Per-player submit timestamps, for the action rate limit. */
  private readonly actionTimes = new Map<PlayerId, number[]>();
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
    if (this.manualStart && options.initiallyStarted) {
      // Resume a started match: skip the lobby and continue the clock from the
      // restored game time (accrued so far) starting now.
      this.started = true;
      this.lobbyAccrued = options.initialState.time;
      this.lobbyRunningSince = this.now();
    }
    this.emitStateHash = options.emitStateHash ?? false;
    this.singlePeerPerPlayer = options.singlePeerPerPlayer ?? false;
    this.observe = options.observe;
    this.persist = options.persist;
    if (options.initialSeq && options.initialSeq > 0) this.seq = options.initialSeq;
    this.maxReceipts = options.maxReceipts ?? RECEIPTS_MAX_DEFAULT;
    this.actionRateMax = options.actionRateMax ?? ACTION_RATE_MAX_DEFAULT;
    this.actionRateWindowMs = options.actionRateWindowMs ?? ACTION_RATE_WINDOW_MS_DEFAULT;
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

  /** The world clock: free-running unless a lobby gate (waitForPlayers OR
   *  manualStart) is configured, in which case it only accrues once running. */
  private clock(): number {
    if (!this.waitFor && !this.manualStart) return this.now();
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

  hasPlayer(playerId: PlayerId): boolean {
    return this.stateValue.players[playerId] !== undefined;
  }

  addPeer(playerId: PlayerId, peer: RoomPeer): boolean {
    if (!this.hasPlayer(playerId)) {
      this.send(peer, { type: 'error', matchId: this.id, code: 'E_UNKNOWN_PLAYER' });
      peer.close?.(1008, 'unknown player');
      return false;
    }
    if (this.singlePeerPerPlayer && (this.peers.get(playerId)?.size ?? 0) > 0) {
      // That side is already controlled by a live connection — refuse so the two
      // players can't both take the same slot (which strands the lobby).
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
      ...this.hashField(view.base),
      ...this.lobbyField(),
    });
    void this.sendVisiblePings(playerId, peer); // existing ally markers, on join (best-effort)
    // Tell already-present peers the wait ended (waitForPlayers) or the lobby
    // roster changed (manualStart, pre-start), so their lobby screen updates.
    if (flipped || (this.manualStart && !this.started)) this.broadcastState([]);
    return true;
  }

  /** What `playerId` may see right now: a clean visible `GameState` baseline
   *  (fog applied, internal memory stripped) plus the fog extras for the wire. */
  private viewFor(playerId: PlayerId): {
    base: GameState;
    signatures: SignatureContact[];
    remembered: string[];
  } {
    const { signatures, remembered, ...base } = visibleState(this.stateValue, playerId, this.data);
    return { base: base as GameState, signatures, remembered };
  }

  removePeer(playerId: PlayerId, peer: RoomPeer): void {
    const playerPeers = this.peers.get(playerId);
    if (!playerPeers) return;
    playerPeers.delete(peer);
    if (playerPeers.size === 0) {
      this.peers.delete(playerId);
      this.lastVisible.delete(playerId); // reclaim the per-player snapshot — no leak after a leave
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

  async receive(playerId: PlayerId, peer: RoomPeer, raw: string): Promise<void> {
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
    if (this.persist) {
      await this.submitActionCommitted(playerId, message.action, peer);
    } else {
      this.submitAction(playerId, message.action, peer);
    }
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
    const rateNow = this.now();
    const recent = (this.actionTimes.get(playerId) ?? []).filter(
      (t) => rateNow - t < this.actionRateWindowMs,
    );
    if (recent.length >= this.actionRateMax) {
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
    recent.push(rateNow);
    this.actionTimes.set(playerId, recent);

    if (action.playerId !== playerId || !this.hasPlayer(playerId)) {
      const receipt = this.recordReceipt(action, playerId, false, 'E_FORBIDDEN');
      if (peer) this.sendRejection(peer, receipt);
      return { ok: false, seq: receipt.seq, events: [], code: receipt.code };
    }

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
    const advanced = this.advance(this.clock());
    if (advanced.ok && advanced.events.length > 0) {
      this.broadcastState(advanced.events);
      this.observeEndIfNeeded();
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
    this.storeReceipt(receipt, action.type);
    return receipt;
  }

  /** Records a receipt in the in-memory idempotency map (FIFO-capped) and emits the
   *  `action` observation. Split from `recordReceipt` so the committed path can build
   *  the receipt with a prospective `seq`, persist it, and only THEN commit it here. */
  private storeReceipt(receipt: ActionReceipt, actionType: string): void {
    this.receipts.set(receipt.actionId, receipt);
    // Bound memory (F-04): idempotency is needed for the retry window (minutes), not
    // forever — evict the oldest receipts past the cap (Map preserves insertion order).
    while (this.receipts.size > this.maxReceipts) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
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
          if (peer) this.sendTransientReject(peer, action.id, 'E_INTERNAL');
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
    const rateNow = this.now();
    const recent = (this.actionTimes.get(playerId) ?? []).filter(
      (t) => rateNow - t < this.actionRateWindowMs,
    );
    if (recent.length >= this.actionRateMax) {
      if (peer) this.sendTransientReject(peer, action.id, 'E_RATE_LIMIT');
      return;
    }
    recent.push(rateNow);
    this.actionTimes.set(playerId, recent);

    this.committing = true;
    try {
      // Authorization — a durable failure receipt (no state change).
      if (action.playerId !== playerId || !this.hasPlayer(playerId)) {
        await this.commitReject(playerId, action, 'E_FORBIDDEN', peer);
        return;
      }

      // Catch the world up PURELY — without touching `this.stateValue` — so an external
      // read during the persist await (a new peer's `welcome`, a ping handler) never sees
      // a not-yet-durable world. We commit the advance only after the write acks.
      const serverNow = this.clock();
      const advanced = this.computeAdvance(this.stateValue, serverNow);
      if (!advanced.ok) {
        await this.commitReject(playerId, action, advanced.code, peer);
        return;
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
          return;
        }
        this.stateValue = advanced.state;
        this.seq = seq;
        this.storeReceipt(receipt, action.type);
        if (advanced.events.length > 0) this.broadcastState(advanced.events);
        if (peer) this.sendRejection(peer, receipt);
        return;
      }

      // Success: persist the final state + receipt, and ONLY on a durable ack commit the
      // new state, the receipt and the broadcast. A failed write commits nothing.
      const receipt: ActionReceipt = { actionId: action.id, playerId, seq, ok: true };
      if (!(await this.persistGuarded(this.snapshot(result.state, seq), receipt, action.id, peer))) {
        return;
      }
      this.stateValue = result.state;
      this.seq = seq;
      this.storeReceipt(receipt, action.type);
      this.broadcastState([...advanced.events, ...result.events]);
      this.observeEndIfNeeded();
    } finally {
      this.committing = false;
    }
  }

  /** Persist a failure receipt (state unchanged) before acking the rejection, so a
   *  retry after a restart stays deduped. A failed write ⇒ transient reject, no commit. */
  private async commitReject(
    playerId: PlayerId,
    action: Action,
    code: string,
    peer?: RoomPeer,
  ): Promise<void> {
    const seq = this.seq + 1;
    const receipt: ActionReceipt = { actionId: action.id, playerId, seq, ok: false, code };
    if (!(await this.persistGuarded(this.snapshot(this.stateValue, seq), receipt, action.id, peer))) {
      return;
    }
    this.seq = seq;
    this.storeReceipt(receipt, action.type);
    if (peer) this.sendRejection(peer, receipt);
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
      if (peer) this.sendTransientReject(peer, actionId, 'E_UNAVAILABLE');
      return false;
    }
  }

  /** A rejection that records NO receipt — the action is retriable (rate-limit / a
   *  durable-write failure / an unexpected error), not a permanent verdict. */
  private sendTransientReject(peer: RoomPeer, actionId: string, code: string): void {
    this.send(peer, { type: 'rejection', matchId: this.id, seq: this.seq, actionId, code });
  }

  private broadcastState(events: DomainEvent[]): void {
    // Fog of war is a server boundary: each player gets a delta against THEIR own
    // last visible view, so hidden worlds/fleets are physically never sent. Only
    // what changed in that player's view goes out (an idle world ⇒ tiny payload).
    const now = this.clock();
    const lobby = this.lobbyField();
    for (const [playerId, playerPeers] of this.peers) {
      const view = this.viewFor(playerId);
      const baseline = this.lastVisible.get(playerId) ?? view.base;
      const identify = identifiedNodes(this.stateValue, playerId, this.data);
      const message: ServerMessage = {
        type: 'delta',
        matchId: this.id,
        seq: this.seq,
        serverTime: now,
        delta: diffState(baseline, view.base),
        events: events.filter((e) => this.eventVisibleTo(e, playerId, identify)),
        signatures: view.signatures,
        remembered: view.remembered,
        ...this.hashField(view.base),
        ...lobby,
      };
      this.lastVisible.set(playerId, view.base);
      for (const peer of playerPeers) this.send(peer, message);
    }
  }

  /** Whether a domain event may be revealed to `playerId` — events leak intent
   *  too, so they pass the same fog as state: your own actions, anything at a
   *  world you identify, and global clock/match events; everything else is cut. */
  private eventVisibleTo(event: DomainEvent, playerId: PlayerId, identify: Set<string>): boolean {
    if (event.type === 'time.advanced' || event.type.startsWith('match.')) return true;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (p.owner === playerId) return true;
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

  /** Same player, or the same static team. The single swap-point for a future real
   *  diplomacy relation (read `this.stateValue` instead of `this.teams`). */
  private areAllied(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    const ta = this.teams[a];
    return ta !== undefined && ta === this.teams[b];
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
    const recent = (this.pingTimes.get(playerId) ?? []).filter((t) => now - t < PING_RATE_WINDOW_MS);
    if (recent.length >= PING_RATE_MAX) {
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
    recent.push(now);
    this.pingTimes.set(playerId, recent);
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
