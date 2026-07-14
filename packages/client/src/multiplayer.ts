import { applyDelta, hashState, type Action, type DomainEvent, type GameState, type PlayerId, type SignatureContact, type StateDelta } from '@void/shared-core';
import { createActionEnvelope, type ActionEnvelope } from '@void/action-layer';

// BF-2 (bug-hunt CRIT): the gate's sequence cursor is strict (1,2,3…) and a throttled
// (`E_RATE_LIMIT`) or out-of-order action does NOT consume its clientSeq — the server
// expects the SAME seq again. Burning a fresh seq on every send therefore wedged the
// session forever after one throttle (every later action → E_OUT_OF_ORDER). The client
// now remembers its recent envelopes and RE-SENDS the same envelope after a backoff.
const RESEND_DELAY_MS = 400; // one flush per window — spreads a big burst below the rate cap
const RESEND_BATCH = 10; // envelopes per flush, lowest clientSeq first (chain re-admits in order)
const RESEND_MAX = 5; // give up after this many attempts and surface the rejection
const SENT_CAP = 64; // remembered recent envelopes (retry window, not a full history)

export type MultiplayerStatus = 'connecting' | 'open' | 'closed';

export interface MultiplayerSocket {
  send(data: string): void;
  close(): void;
}

export interface MultiplayerSnapshot {
  matchId: string;
  playerId?: PlayerId;
  seq: number;
  state: GameState;
  /** True while the match is paused waiting for the required players to connect. */
  waiting?: boolean;
  /** Server's `hashState` of this view, if sent — compare to detect desync. */
  hash?: string;
  /** Manual-start lobby roster (who's host, who's connected, has it started). */
  lobby?: LobbyRoster;
  /** Radar-only enemy contacts (fog extras riding beside the fogged state) —
   *  position + coarse size, no identity. Without these the client cannot draw
   *  radar blips at all: detected-but-unidentified fleets are physically absent
   *  from `state.fleets` (BF-18). */
  signatures?: SignatureContact[];
  /** Ids of worlds shown from MEMORY (stale last-known view, not live). */
  remembered?: string[];
}

export interface LobbyRoster {
  host: PlayerId | null;
  connected: PlayerId[];
  started: boolean;
}

// Tactical ally pings — mirrors the server's `@void/server` protocol wire shape. They
// are ephemeral coordination markers (never part of GameState); the server stamps the
// id/timestamps and relays only to the owner + allies.
export type PingKind = 'mark' | 'move' | 'attack' | 'defend' | 'build';
export interface PingAnchor {
  /** A planet/sector id (snapped). */
  node?: string;
  /** A free position in map space. */
  point?: { x: number; y: number };
}
export interface MultiplayerPing {
  id: string;
  owner: PlayerId;
  kind: PingKind;
  target: PingAnchor;
  to?: PingAnchor;
  payload?: { building?: string };
  /** Short label written by the placer (server-clamped). */
  label?: string;
  createdAt: number;
  expiresAt: number;
}
/** A ping to place — the server fills in id/createdAt/expiresAt. */
export type PingDraft = Pick<MultiplayerPing, 'kind' | 'target' | 'to' | 'payload' | 'label'>;

// Session chat — mirrors the server's wire shape. Ephemeral relay (never part of
// GameState): the server stamps id/at, clamps the text and decides recipients
// (`session` = everyone, `coalition` = live allies, `dm` = the two parties).
export type ChatChannel = 'session' | 'coalition' | 'dm';
export interface MultiplayerChatMessage {
  /** `chat:<from>:<seq>` (server-assigned) — dedupe key across live + join replay. */
  id: string;
  from: PlayerId;
  channel: ChatChannel;
  /** DM addressee (present iff `channel === 'dm'`). */
  to?: PlayerId;
  text: string;
  /** Match-clock stamp. */
  at: number;
}

export interface MultiplayerClientHandlers {
  onStatus?(status: MultiplayerStatus): void;
  onSnapshot?(snapshot: MultiplayerSnapshot): void;
  onRejection?(actionId: string, code: string): void;
  onError?(code: string): void;
  /** Latency reply to a `ping`. `serverTime` is the server clock; `clientTime` is
   *  the value we sent (absent if we pinged without one) — the caller, which owns
   *  the clock, computes round-trip as `now − clientTime`. */
  onPong?(serverTime: number, clientTime?: number): void;
  /** A tactical ping became visible to us (placed by us or an ally, or on join). */
  onPingAdded?(ping: MultiplayerPing): void;
  /** A ping we could see was cleared by its owner or expired. */
  onPingRemoved?(pingId: string, reason: 'cleared' | 'expired'): void;
  /** Fog-filtered domain events that accompanied a delta (battles, volleys, losses,
   *  captures…) — the server only sends what this player may see. Fired AFTER
   *  `onSnapshot`, so a handler reading the current state sees the post-delta world. */
  onEvents?(events: DomainEvent[]): void;
  /** A chat message we may read — live, or replayed on join (dedupe by `id`). */
  onChatMessage?(message: MultiplayerChatMessage): void;
  /** Seat lock (REL-5): the server minted a seat ticket for our nick on THIS join and
   *  will require it (`?ticket=`) on every later join. Fired once, from the welcome
   *  that carries it — persist it; the server keeps only a hash and cannot re-issue. */
  onSeatTicket?(ticket: string): void;
  /** A delta arrived whose `seq` went BACKWARDS (CP1.4) — our baseline can no longer
   *  be trusted, so the delta was dropped. The transport's remedy is a reconnect:
   *  the fresh `welcome` is the full resync. (Forward gaps are legal in this
   *  protocol — a rejected action bumps the server seq without a broadcast — and
   *  equal seqs are legal too: lobby flips re-broadcast under the current seq.) */
  onDesync?(lastSeq: number, gotSeq: number): void;
  /** Our reconstructed state hashed differently from the server's snapshot hash (M1).
   *  The client already reported it (`desync` message — the server logs it) and asked
   *  for a full resync snapshot in the same breath; this is the UI's chance to flag
   *  it (overlay / diagnostics). Fired at most once per pending resync. */
  onHashDesync?(seq: number): void;
}

/** Cap on actions queued while disconnected (CP1.4) — beyond it new actions are
 *  dropped with `E_OUTBOX_FULL` rather than growing memory without bound. */
const OUTBOX_MAX = 64;

interface InboundBase {
  type: string;
  matchId?: string;
  seq?: number;
  playerId?: PlayerId;
  sessionId?: string;
  gated?: boolean;
  seatTicket?: string;
  state?: GameState;
  delta?: StateDelta;
  actionId?: string;
  code?: string;
  waiting?: boolean;
  hash?: string;
  lobby?: LobbyRoster;
  serverTime?: number;
  clientTime?: number;
  ping?: MultiplayerPing;
  pingId?: string;
  reason?: 'cleared' | 'expired';
  events?: DomainEvent[];
  message?: MultiplayerChatMessage;
  signatures?: SignatureContact[];
  remembered?: string[];
}

function decode(raw: string): InboundBase | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value) {
      return value as InboundBase;
    }
  } catch {
    return null;
  }
  return null;
}

export class MultiplayerClient {
  private status: MultiplayerStatus = 'closed';
  /** Last known authoritative state; deltas are applied on top of it. */
  private lastState: GameState | null = null;
  private matchId?: string;
  private playerId?: PlayerId;
  /** Session binding from `welcome` (SV-1.1). Present ⇒ a gated room expects `action.v1`
   *  envelopes echoing this id; `clientSeq` is the strict per-session counter it authorizes. */
  private sessionId?: string;
  private gated = false;
  private clientSeq = 0;
  /** Recent gated envelopes by actionId — the resend window for transient rejections. */
  private readonly sentEnvelopes = new Map<string, ActionEnvelope>();
  private readonly retryCounts = new Map<string, number>();
  private readonly resendQueue = new Map<string, ActionEnvelope>();
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  /** Seq of the last applied full frame or delta — desync guard (CP1.4). */
  private lastSeq: number | null = null;
  /** True while a hash-desync report is awaiting its full resync snapshot (M1) —
   *  suppresses repeat reports so a persistent mismatch is one request, not a flood. */
  private resyncPending = false;
  /** Actions issued while disconnected, flushed after the reconnect `welcome` (CP1.4).
   *  Only never-sent actions are queued, so the flush cannot duplicate an action the
   *  server already applied (an in-flight send that DID land is visible in the
   *  welcome state; re-sent envelopes are deduped server-side by receipts anyway). */
  private readonly outbox: Action[] = [];
  private queueing = false;

  constructor(
    private readonly socket: MultiplayerSocket,
    private readonly handlers: MultiplayerClientHandlers = {},
  ) {
    this.setStatus('connecting');
  }

  open(): void {
    this.setStatus('open');
  }

  close(): void {
    this.clearRetryState();
    this.socket.close();
    this.setStatus('closed');
  }

  /** The transport lost its socket (CP1.4): flip back to 'connecting' and queue
   *  outgoing actions until the reconnect `welcome` rebinds the session — the gated
   *  envelope needs the FRESH sessionId/clientSeq, so flushing any earlier would be
   *  rejected by the gate. A no-op after a deliberate close(). */
  connectionLost(): void {
    if (this.status === 'closed') return;
    this.queueing = true;
    this.setStatus('connecting');
  }

  /** Submit a player intent. On a GATED room (welcome carried `gated` + a `sessionId`)
   *  this wraps it in an `action.v1` envelope — echoing the session id, stamping the next
   *  strict `clientSeq`, and deriving the `actionId` the sequence gate keys on — so the
   *  action-layer gate admits it. Otherwise it sends the bare action (un-gated dev room). */
  sendAction(action: Action): void {
    if (this.queueing) {
      if (this.outbox.length >= OUTBOX_MAX) {
        this.handlers.onError?.('E_OUTBOX_FULL');
        return;
      }
      this.outbox.push(action);
      return;
    }
    if (this.gated && this.sessionId && this.matchId && this.playerId) {
      const envelope = createActionEnvelope({
        matchId: this.matchId,
        playerId: this.playerId,
        sessionId: this.sessionId,
        clientSeq: (this.clientSeq += 1), // strict 1,2,3… per session
        issuedAt: action.issuedAt,
        type: action.type,
        payload: action.payload,
      });
      // Remember for the transient-rejection resend window (BF-2), bounded FIFO.
      this.sentEnvelopes.set(envelope.actionId, envelope);
      while (this.sentEnvelopes.size > SENT_CAP) {
        const oldest = this.sentEnvelopes.keys().next().value;
        if (oldest === undefined) break;
        this.sentEnvelopes.delete(oldest);
      }
      this.socket.send(JSON.stringify({ type: 'action.v1', envelope }));
      return;
    }
    this.socket.send(JSON.stringify({ type: 'action', action }));
  }

  /** Transient rejection (throttle / ordering): the server did NOT consume this
   *  clientSeq — queue the SAME envelope for a backed-off resend. Returns true when
   *  the rejection was absorbed (a retry is scheduled) so it isn't surfaced yet. */
  private queueResend(actionId: string): boolean {
    const envelope = this.sentEnvelopes.get(actionId);
    if (!envelope || envelope.sessionId !== this.sessionId) return false; // stale session
    const attempts = (this.retryCounts.get(actionId) ?? 0) + 1;
    if (attempts > RESEND_MAX) {
      // Give up: drop the retry state and let the rejection reach the caller.
      this.retryCounts.delete(actionId);
      this.sentEnvelopes.delete(actionId);
      this.resendQueue.delete(actionId);
      return false;
    }
    this.retryCounts.set(actionId, attempts);
    this.resendQueue.set(actionId, envelope);
    this.resendTimer ??= setTimeout(() => {
      this.resendTimer = null;
      this.flushResend();
    }, RESEND_DELAY_MS);
    return true;
  }

  /** Re-send queued envelopes lowest clientSeq first (the strict cursor re-admits them
   *  in order), a bounded batch per window so a big burst stays under the rate cap. */
  private flushResend(): void {
    const batch = [...this.resendQueue.values()]
      .sort((a, b) => a.clientSeq - b.clientSeq)
      .slice(0, RESEND_BATCH);
    for (const envelope of batch) {
      this.resendQueue.delete(envelope.actionId);
      this.socket.send(JSON.stringify({ type: 'action.v1', envelope }));
    }
    if (this.resendQueue.size > 0) {
      this.resendTimer ??= setTimeout(() => {
        this.resendTimer = null;
        this.flushResend();
      }, RESEND_DELAY_MS);
    }
  }

  private clearRetryState(): void {
    if (this.resendTimer !== null) {
      clearTimeout(this.resendTimer);
      this.resendTimer = null;
    }
    this.sentEnvelopes.clear();
    this.retryCounts.clear();
    this.resendQueue.clear();
  }

  ping(clientTime: number): void {
    this.socket.send(JSON.stringify({ type: 'ping', clientTime }));
  }

  /** Send a lightweight perf sample (M2): smoothed fps + optional rtt/mem. Pure
   *  telemetry — the server observes it into the metrics stream (rate-limited) and
   *  never answers. Dropped while disconnected (nothing to report a dead wire to). */
  sendPerf(sample: { fps: number; rttMs?: number; memMb?: number }): void {
    if (this.queueing) return;
    this.socket.send(JSON.stringify({ type: 'perf', ...sample }));
  }

  /** Host-only: ask the server to begin the match (manual-start lobby). */
  start(): void {
    this.socket.send(JSON.stringify({ type: 'start' }));
  }

  /** Drop a tactical ping for allies; the server stamps id/createdAt/expiresAt and
   *  relays a `ping.added` back to us + allies. */
  placePing(ping: PingDraft): void {
    this.socket.send(JSON.stringify({ type: 'ping.place', ping }));
  }

  /** Clear one of our pings (or all of them when `pingId` is omitted). */
  clearPing(pingId?: string): void {
    this.socket.send(
      JSON.stringify(pingId ? { type: 'ping.clear', pingId } : { type: 'ping.clear' }),
    );
  }

  /** Say something. The server stamps id/at, clamps the text, picks the recipients
   *  and echoes the message back to us via `onChatMessage` — render from the echo. */
  sendChat(channel: ChatChannel, text: string, to?: PlayerId): void {
    this.socket.send(
      JSON.stringify(
        channel === 'dm' && to !== undefined
          ? { type: 'chat.send', channel, to, text }
          : { type: 'chat.send', channel, text },
      ),
    );
  }

  receive(raw: string): void {
    const message = decode(raw);
    if (!message) {
      this.handlers.onError?.('E_BAD_MESSAGE');
      return;
    }
    if (
      (message.type === 'welcome' || message.type === 'state') &&
      message.matchId &&
      typeof message.seq === 'number' &&
      message.state
    ) {
      // Full snapshot — resets the local baseline (join / resync). It also settles a
      // pending hash-desync report: the state IS the server's view, nothing to compare.
      this.lastState = message.state;
      this.lastSeq = message.seq;
      this.resyncPending = false;
      this.matchId = message.matchId;
      this.playerId = message.playerId ?? this.playerId;
      if (message.type === 'welcome') {
        // Bind the session for the gated send path. A reconnect mints a fresh sessionId
        // (server resets its cursor), so a changed id restarts our clientSeq at 0 → 1.
        if (message.sessionId !== this.sessionId) {
          this.clientSeq = 0;
          this.clearRetryState(); // stale-session envelopes are unauthorizable — drop them
        }
        this.sessionId = message.sessionId;
        this.gated = message.gated ?? false;
        // Seat lock: a freshly-minted ticket rides the welcome exactly once — surface
        // it BEFORE onSnapshot so the caller has persisted it by the time it reacts.
        if (message.seatTicket) this.handlers.onSeatTicket?.(message.seatTicket);
      }
      this.handlers.onSnapshot?.({
        matchId: message.matchId,
        playerId: this.playerId,
        seq: message.seq,
        state: message.state,
        waiting: message.waiting,
        hash: message.hash,
        lobby: message.lobby,
        signatures: message.signatures,
        remembered: message.remembered,
      });
      // Reconnect resume (CP1.4): the welcome above rebound the session, so actions
      // queued while offline can flush now — through the normal send path, minting
      // fresh envelopes under the new sessionId/clientSeq.
      if (message.type === 'welcome' && this.queueing) {
        this.queueing = false;
        for (const queued of this.outbox.splice(0)) this.sendAction(queued);
      }
      return;
    }
    if (
      message.type === 'delta' &&
      message.delta &&
      typeof message.seq === 'number' &&
      this.lastState &&
      this.matchId
    ) {
      // Desync guard (CP1.4): deltas chain against OUR last applied view, and within
      // one connection the server delivers them in order — seq may legally skip
      // forward (rejections bump it without a broadcast) or repeat (lobby flips),
      // but it can never go BACKWARDS. If it did, the baseline is untrustworthy:
      // drop the delta and let the transport resync via reconnect (fresh welcome).
      if (this.lastSeq !== null && message.seq < this.lastSeq) {
        this.handlers.onDesync?.(this.lastSeq, message.seq);
        return;
      }
      // Incremental update — patch the baseline and surface the new full state.
      this.lastState = applyDelta(this.lastState, message.delta);
      this.lastSeq = message.seq;
      // M1 hash-desync detector: the server tagged this snapshot with hashState(view);
      // hash our reconstruction and compare. On mismatch, report it (the server logs
      // the metric) and ask for a full resync in the same message — one in-flight
      // request at a time, so a persistent mismatch can't flood the wire.
      if (message.hash !== undefined && !this.resyncPending && !this.queueing) {
        const ours = hashState(this.lastState);
        if (ours !== message.hash) {
          this.resyncPending = true;
          this.socket.send(JSON.stringify({ type: 'desync', seq: message.seq, hash: ours }));
          this.handlers.onHashDesync?.(message.seq);
        }
      }
      this.handlers.onSnapshot?.({
        matchId: this.matchId,
        playerId: this.playerId,
        seq: message.seq,
        state: this.lastState,
        waiting: message.waiting,
        hash: message.hash,
        lobby: message.lobby,
        signatures: message.signatures,
        remembered: message.remembered,
      });
      // Domain events ride the same delta (already fog-filtered server-side); deliver
      // them after the snapshot so consumers resolve ids against the updated state.
      if (Array.isArray(message.events) && message.events.length > 0) {
        this.handlers.onEvents?.(message.events);
      }
      return;
    }
    if (message.type === 'pong' && typeof message.serverTime === 'number') {
      this.handlers.onPong?.(message.serverTime, message.clientTime);
      return;
    }
    if (message.type === 'ping.added' && message.ping) {
      this.handlers.onPingAdded?.(message.ping);
      return;
    }
    if (message.type === 'ping.removed' && message.pingId) {
      this.handlers.onPingRemoved?.(message.pingId, message.reason ?? 'cleared');
      return;
    }
    if (message.type === 'chat.msg' && message.message) {
      this.handlers.onChatMessage?.(message.message);
      return;
    }
    if (message.type === 'rejection' && message.actionId && message.code) {
      // Transient, non-seq-consuming rejections are retried silently (BF-2); the
      // rejection surfaces only when the retry budget is exhausted. Everything else
      // consumed its seq — drop it from the resend window and surface as before.
      if (
        (message.code === 'E_RATE_LIMIT' || message.code === 'E_OUT_OF_ORDER') &&
        this.queueResend(message.actionId)
      ) {
        return;
      }
      this.sentEnvelopes.delete(message.actionId);
      this.retryCounts.delete(message.actionId);
      this.handlers.onRejection?.(message.actionId, message.code);
      return;
    }
    if (message.type === 'error' && message.code) {
      this.handlers.onError?.(message.code);
    }
  }

  private setStatus(status: MultiplayerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }
}
