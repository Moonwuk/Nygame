import type { Action, GameState, PlayerId } from '@void/shared-core';

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
}

export interface MultiplayerClientHandlers {
  onStatus?(status: MultiplayerStatus): void;
  onSnapshot?(snapshot: MultiplayerSnapshot): void;
  onRejection?(actionId: string, code: string): void;
  onError?(code: string): void;
}

interface InboundBase {
  type: string;
  matchId?: string;
  seq?: number;
  playerId?: PlayerId;
  state?: GameState;
  actionId?: string;
  code?: string;
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
    this.socket.close();
    this.setStatus('closed');
  }

  sendAction(action: Action): void {
    this.socket.send(JSON.stringify({ type: 'action', action }));
  }

  ping(clientTime: number): void {
    this.socket.send(JSON.stringify({ type: 'ping', clientTime }));
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
      this.handlers.onSnapshot?.({
        matchId: message.matchId,
        playerId: message.playerId,
        seq: message.seq,
        state: message.state,
      });
      return;
    }
    if (message.type === 'rejection' && message.actionId && message.code) {
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
