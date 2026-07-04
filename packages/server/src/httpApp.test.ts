import { describe, expect, it } from 'vitest';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import type { RoomRegistry } from './roomRegistry';

// SV-0.1 — the Fastify HTTP app. /health is a contentless liveness probe (must not leak
// match ids/seq — audit F-13, which the old node:http /health did). /ready is a separate
// readiness signal: 503 while a hard dependency is down or the server is draining, so a
// load balancer stops routing new traffic before shutdown without failing liveness.

const data = loadShippedData();

function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');
}

describe('SV-0.1 · HTTP app', () => {
  it('/health is contentless — no match id or seq leak (F-13)', async () => {
    const server = createMultiplayerServer({ room: createDevMatch(data) });
    const url = await server.listen();
    try {
      const res = await fetch(`${httpBase(url)}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown;
      expect(body).toEqual({ ok: true });
      const text = JSON.stringify(body);
      expect(text).not.toContain('dev'); // the match id must not appear
      expect(text).not.toContain('seq');
    } finally {
      await server.close();
    }
  });

  it('/ready is 200 when ready, 503 when the readiness probe fails', async () => {
    let healthy = true;
    const server = createMultiplayerServer({ room: createDevMatch(data), ready: () => healthy });
    const url = await server.listen();
    try {
      const up = await fetch(`${httpBase(url)}/ready`);
      expect(up.status).toBe(200);
      expect(await up.json()).toEqual({ ready: true });

      healthy = false; // e.g. the durable store went unreachable
      const down = await fetch(`${httpBase(url)}/ready`);
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ ready: false });
    } finally {
      await server.close();
    }
  });

  it('/metrics reports aggregate gauges without leaking match ids', async () => {
    const server = createMultiplayerServer({ room: createDevMatch(data) });
    const url = await server.listen();
    try {
      const res = await fetch(`${httpBase(url)}/metrics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: number; connections: number };
      expect(body).toEqual({ matches: 1, connections: 0 }); // one live match, nobody connected
      expect(JSON.stringify(body)).not.toContain('dev'); // aggregate only, no ids
    } finally {
      await server.close();
    }
  });

  it('/ready flips to 503 while the server is draining', async () => {
    // A registry whose shutdown hangs until released — close() sets `draining` and then
    // awaits it, holding the HTTP server up (still listening) so we can probe mid-drain.
    const room = createDevMatch(data);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const registry: RoomRegistry = {
      get: (id) => (id === room.id ? room : undefined),
      ids: () => [room.id],
      shutdown: () => held,
    };
    const server = createMultiplayerServer({ registry });
    const url = await server.listen();
    const base = httpBase(url);

    const closing = server.close(); // draining = true, then awaits the held shutdown
    await new Promise((r) => setTimeout(r, 10)); // let close() reach the await
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false });

    release();
    await closing;
  });
});
