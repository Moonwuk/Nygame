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
 * Storage lives behind the EphemeralStore seam (see ephemeral.test.ts for its TTL).
 * These tests assert the privacy boundary, the fog gate, store-backed join delivery
 * and the rate limit.
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

function makeRoom(
  opts: {
    teams?: Record<string, string>;
    now?: () => number;
    ttl?: number;
    manualStart?: boolean;
  } = {},
): MatchRoom {
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
    manualStart: opts.manualStart,
  });
}

const place = (ping: unknown): string => JSON.stringify({ type: 'ping.place', ping });
/** Flush the fire-and-forget store read that addPeer kicks off for join-pings. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('ally pings', () => {
  it('relays a ping to the owner + allies but never to enemies', async () => {
    const room = makeRoom({ teams: { green: 'A', blue: 'A', red: 'B' } });
    const g = new Peer();
    const b = new Peer();
    const r = new Peer();
    room.addPeer('green', g);
    room.addPeer('blue', b);
    room.addPeer('red', r);

    await room.receive('green', g, place({ kind: 'mark', target: { node: 'home_green' } }));

    expect(g.ofType('ping.added')).toHaveLength(1); // owner sees own
    expect(b.ofType('ping.added')).toHaveLength(1); // ally sees it
    expect(r.ofType('ping.added')).toHaveLength(0); // enemy never sees it
  });

  it('allows free point anchors but fog-gates node anchors (E_PING_UNSEEN)', async () => {
    const room = makeRoom({ teams: { green: 'A', blue: 'A' } });
    const g = new Peer();
    room.addPeer('green', g);

    // a point ping anywhere is fine (reveals nothing hidden)
    await room.receive('green', g, place({ kind: 'mark', target: { point: { x: 400, y: 0 } } }));
    expect(g.ofType('ping.added')).toHaveLength(1);

    // an attack arrow whose `to` is an unseen enemy world is rejected
    await room.receive(
      'green',
      g,
      place({ kind: 'attack', target: { node: 'home_green' }, to: { node: 'home_red' } }),
    );
    expect(g.ofType('error').some((m) => m.code === 'E_PING_UNSEEN')).toBe(true);

    // a build ping for a real building on a seen world is accepted
    await room.receive(
      'green',
      g,
      place({ kind: 'build', target: { node: 'home_green' }, payload: { building: 'mine_t1' } }),
    );
    expect(g.ofType('ping.added')).toHaveLength(2);
  });

  it('delivers existing pings to a late-joining ally via the store', async () => {
    const room = makeRoom({ teams: { green: 'A', blue: 'A' } });
    const g = new Peer();
    room.addPeer('green', g);
    await room.receive('green', g, place({ kind: 'mark', target: { node: 'home_green' } }));

    // blue connects AFTER the ping was placed → gets it on join, read from the store
    const b = new Peer();
    room.addPeer('blue', b);
    await flush();
    expect(b.ofType('ping.added')).toHaveLength(1);
  });

  it('rate-limits a flood of placements', async () => {
    const room = makeRoom({ teams: { green: 'A' } });
    const g = new Peer();
    room.addPeer('green', g);
    for (let i = 0; i < 5; i++) {
      await room.receive('green', g, place({ kind: 'mark', target: { point: { x: i, y: 0 } } }));
    }
    expect(g.ofType('error').some((m) => m.code === 'E_PING_RATE')).toBe(true);
  });

  it('the rate window follows the WALL clock — a frozen lobby never locks pings forever', async () => {
    // manualStart with nobody pressing Start = the match clock stays frozen at 0.
    // The window must still expire on wall time (same fix chat got), or the
    // player is locked out for the whole lobby after PING_RATE_MAX placements.
    let wall = 0;
    const room = makeRoom({ teams: { green: 'A' }, manualStart: true, now: () => wall });
    const g = new Peer();
    room.addPeer('green', g);
    for (let i = 0; i < 5; i++) {
      await room.receive('green', g, place({ kind: 'mark', target: { point: { x: i, y: 0 } } }));
    }
    expect(g.ofType('error').some((m) => m.code === 'E_PING_RATE')).toBe(true);

    wall += 61_000; // beyond PING_RATE_WINDOW_MS — the window has rolled over
    await room.receive('green', g, place({ kind: 'mark', target: { point: { x: 99, y: 0 } } }));
    const errors = g.ofType('error').filter((m) => m.code === 'E_PING_RATE');
    expect(errors).toHaveLength(1); // no NEW rate error after the window expired
  });
});
