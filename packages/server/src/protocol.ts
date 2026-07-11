import type {
  Action,
  DomainEvent,
  GameState,
  PlayerId,
  SignatureContact,
  StateDelta,
} from '@void/shared-core';

/** Fog-of-war extras carried alongside a per-player view (radar contacts and the
 *  ids of worlds shown from memory). Diffed state covers the rest. */
export interface VisibilityFields {
  signatures?: SignatureContact[];
  remembered?: string[];
}

export type ServerErrorCode =
  | 'E_BAD_MESSAGE'
  | 'E_FORBIDDEN'
  | 'E_PAYLOAD_TOO_LARGE'
  | 'E_SLOT_TAKEN'
  | 'E_UNKNOWN_PLAYER'
  | 'E_PING_KIND'
  | 'E_PING_TARGET'
  | 'E_PING_UNSEEN'
  | 'E_PING_BUILD'
  | 'E_PING_RATE'
  | 'E_CHAT_RATE'
  | 'E_CHAT_TARGET'
  | 'E_CHAT_TEXT';

/**
 * Ally ping — a tactical marker one player drops to propose a plan to allies
 * (the icon is `kind`). EPHEMERAL: pings live only in the MatchRoom, never in the
 * deterministic GameState — so they cannot trip `hashState`, replay or the world
 * schedule. JSON-serializable; relayed to the owner + allies, hidden from enemies.
 */
export type PingKind = 'mark' | 'move' | 'attack' | 'defend' | 'build';
export const PING_KINDS: readonly PingKind[] = ['mark', 'move', 'attack', 'defend', 'build'];

/** Where a ping points: a map node (snapped) OR a continuous point (free placement). */
export interface PingAnchor {
  /** A planet/sector id. */
  node?: string;
  /** A free position in map space (empty space, a lane). */
  point?: { x: number; y: number };
}

export interface Ping {
  /** `ping:<owner>:<seq>` (server-assigned). */
  id: string;
  owner: PlayerId;
  kind: PingKind;
  /** Primary anchor — the marker, or the origin of a move/attack arrow. */
  target: PingAnchor;
  /** Second anchor for directional kinds (`move`/`attack`): target → to. */
  to?: PingAnchor;
  /** Kind-specific extra. For `build`: the proposed building id. */
  payload?: { building?: string };
  /** Optional short label (server-clamped). */
  label?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Chat message — ephemeral session talk relayed by the room (like pings, never part
 * of the deterministic GameState). `session` reaches every seat, `coalition` the
 * sender's live allies, `dm` exactly the sender + `to`. The room stamps `id`/`at`
 * and clamps `text`; recipients are decided SERVER-side, like fog — a peer outside
 * the channel is never sent the message at all.
 */
export type ChatChannel = 'session' | 'coalition' | 'dm';
export const CHAT_CHANNELS: readonly ChatChannel[] = ['session', 'coalition', 'dm'];
export const CHAT_TEXT_MAX = 240;

export interface ChatMessage {
  /** `chat:<from>:<seq>` (server-assigned). */
  id: string;
  from: PlayerId;
  channel: ChatChannel;
  /** DM addressee (present iff `channel === 'dm'`). */
  to?: PlayerId;
  /** Trimmed and clamped to CHAT_TEXT_MAX by the server. */
  text: string;
  /** Match-clock stamp (the same clock as `Ping.createdAt` / `serverTime`). */
  at: number;
}

export interface ClientActionMessage {
  type: 'action';
  action: Action;
}

/** A gated action (SV-1.1): the raw `@void/action-layer` ActionEnvelope on the wire.
 *  The envelope is passed through UNVALIDATED — the `ActionGate` owns its schema check,
 *  so a malformed one yields the gate's stable `E_BAD_PAYLOAD` rather than a generic
 *  `E_BAD_MESSAGE`. Only rooms configured with a `gate` accept this type. */
export interface ClientActionEnvelopeMessage {
  type: 'action.v1';
  envelope: unknown;
}

export interface ClientPingMessage {
  type: 'ping';
  clientTime?: number;
}

/** Host-only lobby control: begin the match now (release the frozen world clock).
 *  Ignored from a non-host or once already started. */
export interface ClientStartMessage {
  type: 'start';
}

/** Drop a tactical ping for allies. The server stamps id / createdAt / expiresAt. */
export interface ClientPingPlaceMessage {
  type: 'ping.place';
  ping: {
    kind: PingKind;
    target: PingAnchor;
    to?: PingAnchor;
    payload?: { building?: string };
    label?: string;
  };
}

/** Clear one of the sender's pings (or all of them when `pingId` is omitted). */
export interface ClientPingClearMessage {
  type: 'ping.clear';
  pingId?: string;
}

/** Say something. The server stamps id / at, clamps the text and picks recipients. */
export interface ClientChatSendMessage {
  type: 'chat.send';
  channel: ChatChannel;
  /** DM addressee — required for (and only meaningful on) the `dm` channel. */
  to?: PlayerId;
  text: string;
}

/** Desync report (M1): the client's reconstructed state hashed differently from the
 *  `hash` the server attached to snapshot `seq`. The room logs it (observation) and
 *  answers with a full `state` snapshot so the client recovers without reconnecting. */
export interface ClientDesyncMessage {
  type: 'desync';
  /** The snapshot seq whose hash mismatched. */
  seq: number;
  /** The client's own `hashState` of its reconstructed view (for the server log). */
  hash: string;
}

/** Lightweight client perf sample (M2): smoothed fps, round-trip and JS-heap during
 *  a network match. Pure telemetry — the room only observes it (rate-limited, never
 *  answered); it cannot touch the simulation. Values are validated to sane ranges at
 *  parse so a hostile client can't write garbage into the metrics stream. */
export interface ClientPerfMessage {
  type: 'perf';
  fps: number;
  rttMs?: number;
  memMb?: number;
}

export type ClientMessage =
  | ClientActionMessage
  | ClientActionEnvelopeMessage
  | ClientPingMessage
  | ClientStartMessage
  | ClientPingPlaceMessage
  | ClientPingClearMessage
  | ClientChatSendMessage
  | ClientDesyncMessage
  | ClientPerfMessage;

/** Roster shown on the pre-match lobby screen (manual-start mode). */
export interface LobbyInfo {
  /** Player who owns the Start button (the first to connect), or null if none. */
  host: PlayerId | null;
  /** Players with a live connection right now (the ones to show as "in"). */
  connected: PlayerId[];
  /** True once the host has started the match (the world clock is running). */
  started: boolean;
}

/** Lobby data on snapshots: `waiting` is true while the world clock is frozen
 *  (waiting for players, or for the host to press Start); `lobby` carries the
 *  roster + host + started flag for the manual-start lobby screen. Absent ⇒ running. */
export interface LobbyField {
  waiting?: boolean;
  lobby?: LobbyInfo;
}

/** Optional `hashState` of the player's authoritative view, attached to snapshots
 *  when the room has `emitStateHash` on. The client hashes its reconstructed state
 *  and compares — a mismatch is a desync (a metrics signal, not a wire requirement). */
export interface HashField {
  hash?: string;
}

export interface ServerWelcomeMessage extends VisibilityFields, LobbyField, HashField {
  type: 'welcome';
  matchId: string;
  playerId: PlayerId;
  seq: number;
  serverTime: number;
  state: GameState;
  /** The server-minted session id for this connection (SV-1.1-live-A). The client echoes
   *  it in every `action.v1` envelope so a gated room can authorize the session binding.
   *  Present only when the transport bound one; absent for a bare in-process room. */
  sessionId?: string;
  /** True when this room runs the action-layer gate: the client MUST send `action.v1`
   *  envelopes (a bare `action` is refused). Absent/false ⇒ send bare actions. Lets the
   *  client self-configure its send path from the handshake instead of a build-time flag. */
  gated?: boolean;
  /** Seat lock (REL-5): the plaintext seat ticket, present ONLY on the join that minted
   *  it (first join of this nick / adoption of a pre-lock seat). The client must store
   *  it and present it (`?ticket=`) on every later join of this seat; the server keeps
   *  only the hash, so a lost ticket is not recoverable from the server. */
  seatTicket?: string;
}

export interface ServerStateMessage extends VisibilityFields, LobbyField, HashField {
  type: 'state';
  matchId: string;
  seq: number;
  serverTime: number;
  state: GameState;
  events: DomainEvent[];
}

/** Incremental update — only the entities/fields that changed since the peer's
 *  last `welcome`/`state` snapshot. A full `state` is sent on join and on resync. */
export interface ServerDeltaMessage extends VisibilityFields, LobbyField, HashField {
  type: 'delta';
  matchId: string;
  seq: number;
  serverTime: number;
  delta: StateDelta;
  events: DomainEvent[];
}

export interface ServerRejectionMessage {
  type: 'rejection';
  matchId: string;
  seq: number;
  actionId: string;
  code: string;
}

export interface ServerPongMessage {
  type: 'pong';
  matchId: string;
  serverTime: number;
  clientTime?: number;
}

export interface ServerErrorMessage {
  type: 'error';
  matchId: string;
  code: ServerErrorCode;
}

/** A ping became visible to this recipient (placed, or sent on join). */
export interface ServerPingAddedMessage {
  type: 'ping.added';
  matchId: string;
  ping: Ping;
}

/** A ping the recipient could see was cleared by its owner or expired. */
export interface ServerPingRemovedMessage {
  type: 'ping.removed';
  matchId: string;
  pingId: string;
  reason: 'cleared' | 'expired';
}

/** A chat message this recipient may read (live, or replayed on join). */
export interface ServerChatMessage {
  type: 'chat.msg';
  matchId: string;
  message: ChatMessage;
}

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerStateMessage
  | ServerDeltaMessage
  | ServerRejectionMessage
  | ServerPongMessage
  | ServerErrorMessage
  | ServerPingAddedMessage
  | ServerPingRemovedMessage
  | ServerChatMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.playerId === 'string' &&
    typeof value.issuedAt === 'number' &&
    'payload' in value
  );
}

/** A well-formed ping anchor: exactly one of a node id OR a finite {x,y} point. */
function isPingAnchor(value: unknown): value is PingAnchor {
  if (!isRecord(value)) return false;
  const hasNode = typeof value.node === 'string';
  const p = value.point;
  const hasPoint =
    isRecord(p) && Number.isFinite(p.x as number) && Number.isFinite(p.y as number);
  return hasNode !== hasPoint; // exactly one
}

/** A well-formed chat.send: a known channel + a string text (+ an optional string
 *  addressee). Semantic rules (dm needs a real `to`, non-empty text after trim) are
 *  the room's job — they answer with specific E_CHAT_* codes, not E_BAD_MESSAGE. */
function isChatSend(value: Record<string, unknown>): boolean {
  if (!CHAT_CHANNELS.includes(value.channel as ChatChannel)) return false;
  if (typeof value.text !== 'string') return false;
  if (value.to !== undefined && typeof value.to !== 'string') return false;
  return true;
}

function isPingDraft(value: unknown): value is ClientPingPlaceMessage['ping'] {
  if (!isRecord(value)) return false;
  if (!PING_KINDS.includes(value.kind as PingKind)) return false;
  if (!isPingAnchor(value.target)) return false;
  if (value.to !== undefined && !isPingAnchor(value.to)) return false;
  if (value.label !== undefined && typeof value.label !== 'string') return false;
  if (value.payload !== undefined) {
    if (!isRecord(value.payload)) return false;
    if (value.payload.building !== undefined && typeof value.payload.building !== 'string')
      return false;
  }
  return true;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(decoded) || typeof decoded.type !== 'string') return null;
  if (decoded.type === 'action' && isAction(decoded.action)) {
    return { type: 'action', action: decoded.action };
  }
  if (decoded.type === 'action.v1') {
    // Pass the envelope through as-is; the ActionGate validates it (stable E_BAD_PAYLOAD).
    return { type: 'action.v1', envelope: decoded.envelope };
  }
  if (decoded.type === 'ping') {
    return typeof decoded.clientTime === 'number'
      ? { type: 'ping', clientTime: decoded.clientTime }
      : { type: 'ping' };
  }
  if (decoded.type === 'start') {
    return { type: 'start' };
  }
  if (decoded.type === 'ping.place' && isPingDraft(decoded.ping)) {
    return { type: 'ping.place', ping: decoded.ping };
  }
  if (decoded.type === 'ping.clear') {
    return typeof decoded.pingId === 'string'
      ? { type: 'ping.clear', pingId: decoded.pingId }
      : { type: 'ping.clear' };
  }
  if (decoded.type === 'chat.send' && isChatSend(decoded)) {
    const message: ClientChatSendMessage = {
      type: 'chat.send',
      channel: decoded.channel as ChatChannel,
      text: decoded.text as string,
    };
    if (typeof decoded.to === 'string') message.to = decoded.to;
    return message;
  }
  if (
    decoded.type === 'desync' &&
    typeof decoded.seq === 'number' &&
    Number.isFinite(decoded.seq) &&
    typeof decoded.hash === 'string'
  ) {
    return { type: 'desync', seq: decoded.seq, hash: decoded.hash };
  }
  if (decoded.type === 'perf') {
    const inRange = (v: unknown, max: number): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
    if (!inRange(decoded.fps, 1_000)) return null;
    const message: ClientPerfMessage = { type: 'perf', fps: decoded.fps };
    if (inRange(decoded.rttMs, 120_000)) message.rttMs = decoded.rttMs;
    if (inRange(decoded.memMb, 1_000_000)) message.memMb = decoded.memMb;
    return message;
  }
  return null;
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
