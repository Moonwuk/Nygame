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
  type ServerMessage,
  type ServerRejectionMessage,
} from './protocol';

export interface RoomPeer {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  readonly readyState?: number;
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
  /** Attach `hashState(view)` to each snapshot so the client can detect desync.
   *  Opt-in (it hashes the per-player view on every broadcast). */
  emitStateHash?: boolean;
  /** 1v1 lobby guard: reject a second LIVE connection to an already-occupied
   *  player slot, so two people can't both take the same side (which would leave
   *  the lobby waiting forever for the empty side). A slot frees the moment its
   *  peer disconnects, so reconnect-after-drop still works. Default false. */
  singlePeerPerPlayer?: boolean;
  /** Observation-only room-event stream for metrics/playtest logging (M0). */
  observe?: (event: RoomObservation) => void;
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
  | { kind: 'action'; playerId: PlayerId; type: string; ok: boolean; seq: number; code?: string }
  | { kind: 'end'; winner: PlayerId | null; reason?: string };

export interface SubmitResult {
  ok: boolean;
  seq: number;
  events: DomainEvent[];
  code?: string;
}

const OPEN = 1;

function canSend(peer: RoomPeer): boolean {
  return peer.readyState === undefined || peer.readyState === OPEN;
}

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
  private readonly emitStateHash: boolean;
  private readonly singlePeerPerPlayer: boolean;
  private readonly observe?: (event: RoomObservation) => void;
  private endObserved = false; // 'end' is reported once
  private readonly peers = new Map<PlayerId, Set<RoomPeer>>();
  private readonly receipts = new Map<string, ActionReceipt>();
  private seq = 0;
  private stateValue: GameState;
  /** Per-player baseline the deltas diff against — each player's last broadcast
   *  *visible* view (fog of war is server-authoritative, so every player holds a
   *  different state). A peer's `welcome` (re)sets its player's baseline. */
  private readonly lastVisible = new Map<PlayerId, GameState>();

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
    this.emitStateHash = options.emitStateHash ?? false;
    this.singlePeerPerPlayer = options.singlePeerPerPlayer ?? false;
    this.observe = options.observe;
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

  /** True while the match is paused waiting for the required players (frozen clock). */
  private get waiting(): boolean {
    return this.waitFor !== null && !this.lobbyRunning;
  }

  /** The world clock: free-running unless a lobby gate is configured, in which case
   *  it only accrues real time while all required players are connected. */
  private clock(): number {
    if (!this.waitFor) return this.now();
    return (
      this.lobbyAccrued + (this.lobbyRunningSince === null ? 0 : this.now() - this.lobbyRunningSince)
    );
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
      this.lobbyAccrued += this.now() - this.lobbyRunningSince; // freeze
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
      ...(this.waiting ? { waiting: true } : {}),
    });
    if (flipped) this.broadcastState([]); // tell the already-present peer the wait ended
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
      this.observe?.({ kind: 'leave', playerId });
    }
    if (this.syncLobbyClock()) this.broadcastState([]); // a required player dropped → freeze + notify
  }

  receive(playerId: PlayerId, peer: RoomPeer, raw: string): void {
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
    this.submitAction(playerId, message.action, peer);
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
      ...(this.waiting ? { waiting: true } : {}),
    };
  }

  private advance(now: number): { ok: true; events: DomainEvent[] } | { ok: false; code: string } {
    if (now <= this.stateValue.time) return { ok: true, events: [] };
    const result = this.kernel.advanceTo(this.stateValue, this.context(now));
    if (!result.ok) return { ok: false, code: result.code };
    this.stateValue = result.state;
    return { ok: true, events: result.events };
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
    this.receipts.set(action.id, receipt);
    this.observe?.({
      kind: 'action',
      playerId,
      type: action.type,
      ok,
      seq: this.seq,
      ...(code ? { code } : {}),
    });
    return receipt;
  }

  private broadcastState(events: DomainEvent[]): void {
    // Fog of war is a server boundary: each player gets a delta against THEIR own
    // last visible view, so hidden worlds/fleets are physically never sent. Only
    // what changed in that player's view goes out (an idle world ⇒ tiny payload).
    const now = this.clock();
    const waiting = this.waiting;
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
        ...(waiting ? { waiting: true } : {}),
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

  private send(peer: RoomPeer, message: ServerMessage): void {
    if (canSend(peer)) peer.send(serializeServerMessage(message));
  }
}
