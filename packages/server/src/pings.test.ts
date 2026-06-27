import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  createKernel,
  type GameState,
  type Planet,
  type Player,
} from '@void/shared-core';
import { MatchRoom, type RoomPeer } from './matchRoom';
import { DEV_MODULES, loadShippedData } from './scenario';

/**
 * Ally pings are an EPHEMERAL server side-channel: relayed to the owner + allies,
 * hidden from enemies, fog-gated for node anchors, and never part of GameState.
 * These tests assert the privacy boundary, the fog gate, expiry and the rate limit.
 */

interface WireMsg {
  type: string;
  code?: string;
  ping?: { id: string; owner: string };
  pingId?: string;
}

class Peer implements RoomPeer {
  readonly msgs: WireMsg[] = [];
  send(data: string): void {
    this.msgs.push(JSON.parse(data) as WireMsg);
  }
  close(): void {}
  ofType(type: string): WireMsg[] {
    return this.msgs.filter((m) => m.type === type);
  }
}

const planet = (id: string, owner: string, x: number): Planet => ({
  id,
  owner,
  position: { x, y: 0 },
  links: [],
  resources: {},
  buildings: [],
  garrison: [],
  traits: [],
});

function makeRoom(opts: { teams?: Record<string, string>; now?: () => number; ttl?: number } = {}): MatchRoom {
  const data = loadShippedData();
  const base = createInitialState({ seed: 'pings', version: { data: data.version, manifest: '1' }, time: 0 });
  const players: Record<string, Player> = {
    green: { id: 'green', name: 'G', faction: 'vanguard', status: 'active', resources: {} },
    blue: { id: 'blue', name: 'B', faction: 'vanguard', status: 'active', resources: {} },
    red: { id: 'red', name: 'R', faction: 'vanguard', status: 'active', resources: {} },
  };
  const planets: Record<string, Planet> = {
    home_green: planet('home_green', 'green', 0),
    home_blue: planet('home_blue', 'blue', 100),
    home_red: planet('home_red', 'red', 900),
  };
  const state: GameState = { ...base, players, planets };
  return new MatchRoom({
    id: 't',
    initialState: state,
    kernel: createKernel(DEV_MODULES),
    data,
    now: opts.now ?? (() => 0),
    teams: opts.teams,
    pingTtlMs: opts.ttl ?? 1000,
  });
}

const place = (ping: unknown): string => JSON.stringify({ type: 'ping.place', ping });

// mirror of the room's internal PING_RATE_MAX (4) + 1
const PING_RATE_MAX_PLUS_ONE = 5;

describe('ally pings', () => {
  it('relays a ping to the owner + allies but never to enemies', () => {
    const room = makeRoom({ teams: { green: 'A', blue: 'A', red: 'B' } });
    const g = new Peer();
    const b = new Peer();
    const r = new Peer();
    room.addPeer('green', g);
    room.addPeer('blue', b);
    room.addPeer('red', r);

    room.receive('green', g, place({ kind: 'mark', target: { node: 'home_green' } }));

    expect(g.ofType('ping.added')).toHaveLength(1); // owner sees own
    expect(b.ofType('ping.added')).toHaveLength(1); // ally sees it
    expect(r.ofType('ping.added')).toHaveLength(0); // enemy never sees it
  });

  it('allows free point anchors but fog-gates node anchors (E_PING_UNSEEN)', () => {
    const room = makeRoom({ teams: { green: 'A', blue: 'A' } });
    const g = new Peer();
    room.addPeer('green', g);

    // a point ping anywhere is fine (reveals nothing hidden)
    room.receive('green', g, place({ kind: 'mark', target: { point: { x: 400, y: 0 } } }));
    expect(g.ofType('ping.added')).toHaveLength(1);

    // an attack arrow whose `to` is an unseen enemy world is rejected
    room.receive(
      'green',
      g,
      place({ kind: 'attack', target: { node: 'home_green' }, to: { node: 'home_red' } }),
    );
    expect(g.ofType('error').some((m) => m.code === 'E_PING_UNSEEN')).toBe(true);

    // a build ping for a real building on a seen world is accepted
    room.receive(
      'green',
      g,
      place({ kind: 'build', target: { node: 'home_green' }, payload: { building: 'mine_t1' } }),
    );
    expect(g.ofType('ping.added')).toHaveLength(2);
  });

  it('expires pings and does not replay them to a late joiner', () => {
    let t = 0;
    const room = makeRoom({ teams: { green: 'A', blue: 'A' }, now: () => t, ttl: 1000 });
    const g = new Peer();
    room.addPeer('green', g);
    room.receive('green', g, place({ kind: 'mark', target: { node: 'home_green' } }));
    expect(g.ofType('ping.added')).toHaveLength(1);

    t = 2000; // past the TTL
    const b = new Peer();
    room.addPeer('blue', b); // join triggers a sweep first
    expect(b.ofType('ping.added')).toHaveLength(0); // the expired ping is not sent
    expect(g.ofType('ping.removed').some((m) => m.pingId)).toBe(true); // owner told it expired
  });

  it('rate-limits a flood of placements', () => {
    const room = makeRoom({ teams: { green: 'A' } });
    const g = new Peer();
    room.addPeer('green', g);
    for (let i = 0; i < PING_RATE_MAX_PLUS_ONE; i++) {
      room.receive('green', g, place({ kind: 'mark', target: { point: { x: i, y: 0 } } }));
    }
    expect(g.ofType('error').some((m) => m.code === 'E_PING_RATE')).toBe(true);
  });
});
