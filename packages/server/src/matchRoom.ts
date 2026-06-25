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
import { diffState, identifiedNodes, visibleState } from '@void/shared-core';
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
}

export interface ActionReceipt {
  actionId: string;
  playerId: PlayerId;
  seq: number;
  ok: boolean;
  code?: string;
}

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
    const playerPeers = this.peers.get(playerId) ?? new Set<RoomPeer>();
    playerPeers.add(peer);
    this.peers.set(playerId, playerPeers);
    const view = this.viewFor(playerId);
    this.lastVisible.set(playerId, view.base);
    this.send(peer, {
      type: 'welcome',
      matchId: this.id,
      playerId,
      seq: this.seq,
      serverTime: this.now(),
      state: view.base,
      signatures: view.signatures,
      remembered: view.remembered,
    });
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
    if (playerPeers.size === 0) this.peers.delete(playerId);
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
          ? { type: 'pong' as const, matchId: this.id, serverTime: this.now() }
          : {
              type: 'pong' as const,
              matchId: this.id,
              serverTime: this.now(),
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

    const serverNow = this.now();
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
      serverTime: this.now(),
      state: view.base,
      events: [],
      signatures: view.signatures,
      remembered: view.remembered,
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
    return receipt;
  }

  private broadcastState(events: DomainEvent[]): void {
    // Fog of war is a server boundary: each player gets a delta against THEIR own
    // last visible view, so hidden worlds/fleets are physically never sent. Only
    // what changed in that player's view goes out (an idle world ⇒ tiny payload).
    const now = this.now();
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
