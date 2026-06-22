import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type Action,
  type GameData,
  type GameModule,
  type GameState,
  type Player,
} from '@void/shared-core';
import { MatchRoom, type RoomPeer } from './matchRoom';
import type { ServerMessage } from './protocol';

class MemoryPeer implements RoomPeer {
  readonly messages: ServerMessage[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
}

const renameModule: GameModule = {
  id: 'rename-test',
  version: '1.0.0',
  setup(api) {
    api.onAction('player.rename', (action, h) => {
      const payload = action.payload;
      if (typeof payload !== 'object' || payload === null || !('name' in payload)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const name = (payload as { name: unknown }).name;
      if (typeof name !== 'string' || name.length === 0) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_FORBIDDEN');
      player.name = name;
      h.emit('player.renamed', { playerId: action.playerId, name });
    });
  },
};

function player(id: string, name: string): Player {
  return { id, name, faction: id, status: 'active', resources: {} };
}

function testData(): GameData {
  return parseGameData({
    version: 'test',
    resources: ['credits'],
    units: {},
    factions: {},
    buildings: {},
    events: {},
    sectors: {},
    planetTypes: {},
  });
}

function testState(): GameState {
  const base = createInitialState({
    seed: 'server-test',
    version: { data: 'test', manifest: 'test' },
  });
  return { ...base, players: { p1: player('p1', 'One'), p2: player('p2', 'Two') } };
}

function action(id: string, playerId: string, name: string): Action {
  return { id, type: 'player.rename', playerId, issuedAt: 1, payload: { name } };
}

function room(): MatchRoom {
  return new MatchRoom({
    id: 'test-room',
    initialState: testState(),
    kernel: createKernel([renameModule]),
    data: testData(),
    now: () => 10,
  });
}

describe('MatchRoom', () => {
  it('welcomes each player with the authoritative snapshot', () => {
    const r = room();
    const p1 = new MemoryPeer();

    expect(r.addPeer('p1', p1)).toBe(true);

    expect(p1.messages).toHaveLength(1);
    expect(p1.messages[0]).toMatchObject({ type: 'welcome', matchId: 'test-room', playerId: 'p1' });
  });

  it('serializes an action and broadcasts the new state to every peer', () => {
    const r = room();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);

    const result = r.submitAction('p1', action('a1', 'p1', 'Commander'), p1);

    expect(result.ok).toBe(true);
    expect(r.state.players.p1?.name).toBe('Commander');
    expect(p1.messages.at(-1)).toMatchObject({ type: 'state', seq: 1 });
    expect(p2.messages.at(-1)).toMatchObject({ type: 'state', seq: 1 });
  });

  it('rejects cross-player spoofed actions without broadcasting state', () => {
    const r = room();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);

    const result = r.submitAction('p2', action('spoof', 'p1', 'Spoofed'), p2);

    expect(result).toMatchObject({ ok: false, code: 'E_FORBIDDEN' });
    expect(r.state.players.p1?.name).toBe('One');
    expect(p2.messages.at(-1)).toMatchObject({
      type: 'rejection',
      actionId: 'spoof',
      code: 'E_FORBIDDEN',
    });
    expect(p1.messages).toHaveLength(1);
  });

  it('deduplicates retried action ids', () => {
    const r = room();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    const first = r.submitAction('p1', action('a1', 'p1', 'First'), p1);
    const second = r.submitAction('p1', action('a1', 'p1', 'Second'), p1);

    expect(first).toMatchObject({ ok: true, seq: 1 });
    expect(second).toMatchObject({ ok: true, seq: 1 });
    expect(r.state.players.p1?.name).toBe('First');
    expect(p1.messages.filter((m) => m.type === 'state')).toHaveLength(2);
  });

  it('validates inbound client messages before applying them', () => {
    const r = room();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    r.receive('p1', p1, '{bad json');
    r.receive('p1', p1, JSON.stringify({ type: 'action', action: action('a2', 'p1', 'Valid') }));

    expect(p1.messages[1]).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
    expect(r.state.players.p1?.name).toBe('Valid');
  });
});
