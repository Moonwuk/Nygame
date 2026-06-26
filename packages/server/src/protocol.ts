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
  | 'E_UNKNOWN_PLAYER';

export interface ClientActionMessage {
  type: 'action';
  action: Action;
}

export interface ClientPingMessage {
  type: 'ping';
  clientTime?: number;
}

export type ClientMessage = ClientActionMessage | ClientPingMessage;

/** Lobby flag carried on snapshots: true while the match is paused waiting for the
 *  required players to connect (the world clock is frozen). Absent ⇒ running. */
export interface LobbyField {
  waiting?: boolean;
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

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerStateMessage
  | ServerDeltaMessage
  | ServerRejectionMessage
  | ServerPongMessage
  | ServerErrorMessage;

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
  if (decoded.type === 'ping') {
    return typeof decoded.clientTime === 'number'
      ? { type: 'ping', clientTime: decoded.clientTime }
      : { type: 'ping' };
  }
  return null;
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
