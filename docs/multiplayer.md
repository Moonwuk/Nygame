# Multiplayer slice

This is the first server-authoritative multiplayer slice. It is intentionally smaller than the full Stage 3 server from `docs/roadmap.md`: no database, no Redis scheduler, no auth/JWT and no fog-of-war projection yet.

## What exists now

- `@void/server` exposes `MatchRoom` — an in-memory authoritative room around a `shared-core` `Kernel` and `GameState`.
- Clients connect through `createMultiplayerServer()` over WebSocket at:
  `ws://host:port/matches/<matchId>?player=<playerId>`.
- A connected player receives a full authoritative snapshot:
  `welcome { matchId, playerId, seq, serverTime, state }`.
- Client actions are submitted as:
  `action { action: Action }`.
- The room serializes action handling:
  `advanceTo(serverNow)` → authorize player/action owner → `applyAction()` → broadcast a `delta`.
- Broadcasts are **deltas**, not full snapshots: only the entities/fields that changed since the room's last broadcast (a full `state` is sent only on join and idempotent resync). The codec lives in `shared-core` (`diffState`/`applyDelta`), so the client reconstructs state from `welcome` + deltas; `applyDelta(prev, diffState(prev,next))` deep-equals `next`.
- Retried action IDs are idempotent: the same action ID is not applied twice (the retry gets a full `state` resync).
- Cross-player spoofing is rejected with `E_FORBIDDEN`.
- `@void/client` exposes `MultiplayerClient`, a small transport adapter that sends actions and consumes `welcome`/`state`/`delta`/`rejection` messages (applying deltas onto its last snapshot).

## Running a two-player test

A runnable dev harness boots the **real** simulation core (the full base-module
manifest) as a two-player match — `green` and `red`, each with a homeworld and an
idle fleet — and serves it over WebSocket. State is in-memory and the `?player=`
handshake is unauthenticated, so this is for local testing, not production.

```bash
pnpm dev:server                          # 127.0.0.1:8787, match id "dev"
HOST=0.0.0.0 PORT=9000 pnpm dev:server   # reachable from other LAN devices
```

It prints the connect URLs and a health route:

```
health : http://127.0.0.1:8787/health
green  : ws://127.0.0.1:8787/matches/dev?player=green
red    : ws://127.0.0.1:8787/matches/dev?player=red
```

Connecting as an unknown player is refused at the upgrade (HTTP 403). For a test
across the internet, bind `HOST=0.0.0.0` and tunnel the port, or host the server
(Fly.io/Railway, per `docs/roadmap.md`).

The wire is covered headlessly by `packages/server/src/scenario.test.ts` (part of
`pnpm test`): it connects two real WebSocket clients to the dev match, has each
issue a `fleet.orbit` order, and asserts every action is broadcast to **both**
peers and that a peer reconstructs the exact authoritative state from `welcome` +
deltas. The construction (data loader + `createDevMatch`) lives in
`packages/server/src/scenario.ts`, reused by both the runner and the test.

## Playing the real prototype together (and via the APK)

The section above connects clients to a minimal core harness (`dev:server`,
green/red). To play the **actual prototype** — the map, the HUD, the whole
console — as a two-player session, use the prototype dev server. It hosts the
prototype's *own* world (same `kernel` + `data` + `newGame()`), so the client
renders the live session exactly like single-player.

```bash
pnpm dev:proto-server                          # 127.0.0.1:8788, match id "proto"
HOST=0.0.0.0 PORT=8788 pnpm dev:proto-server   # reachable from other devices / a tunnel
```

It prints:

```
health : http://127.0.0.1:8788/health
Azure  : ws://127.0.0.1:8788/matches/proto?player=p1
Crimson: ws://127.0.0.1:8788/matches/proto?player=p2
```

The prototype now opens on a **connect overlay** (build it with `pnpm prototype`,
open `prototype/dist/void-dominion.html`):

- **Single player** — the local skirmish vs the AI, exactly as before.
- **Connect** — paste the server URL, pick **Azure** (p1) or **Crimson** (p2),
  and join the live session. The last URL is remembered (so the APK reconnects in
  one tap). Whoever you join as renders **green** ("you"); the opponent is red.

### Two phones, one session — the APK friend test

The Capacitor APK (`mobile/`, see `mobile/README.md`) wraps this same prototype,
so it ships with net mode built in. To test with a remote friend:

1. **Run the server + a public tunnel** on your machine (the tunnel gives a
   `wss://` URL, which mobile WebViews accept — a plain `ws://` would be blocked
   as cleartext):
   ```bash
   HOST=0.0.0.0 PORT=8788 pnpm dev:proto-server
   cloudflared tunnel --url http://localhost:8788   # or: ngrok http 8788
   ```
   Use the printed `https://…trycloudflare.com` host as `wss://…trycloudflare.com`.
2. **Build the APK** (CI: Actions → "Android APK (prototype)" → download
   `void-dominion-debug-apk`) and send `app-debug.apk` to your friend.
3. Both install/sideload it. In the overlay, **both paste the same `wss://…` URL**;
   you pick Azure, your friend picks Crimson; tap **Connect**.
4. You are now in one live session: move fleets, build, assault — each side sees
   the other's orders in real time, served by the authoritative core.

Keep the server + tunnel running for the session (state is in-memory — a restart
loses the match). Do **not** leave an unauthenticated server tunnelled long-term
(auth is brick F7 / SE-0.1).

### Net-mode scope (first MP test)

The prototype was built single-player, so some rules live in the client. Against
the authoritative server those are suspended; the server only enforces the
**kernel** rules. What that means in MP:

- **Capture** is via the kernel's combat: orbit **near** → **assault** (the
  walk-into-an-undefended-neutral-sector shortcut is a client-only convenience
  and does not apply in MP).
- **No AI** — the opponent is a human (the local red AI is off in net mode).
- **Builds** send one order per tap (the server times construction); the local
  multi-item build queue is single-player only.
- Starfort auto-AA and in-MP event toast notifications are not wired yet.

State still updates fully on every snapshot; these are follow-ups, not blockers
for a connectivity test. The natural next step is promoting walk-in capture into
a real kernel rule so MP and single-player share one capture mechanic.

## Preparing for a live multiplayer test

**Seat more than two players.** `createDevMatch(data, { players: ['green', 'red', 'blue', 'gold'] })`
seats N players — each gets a homeworld (spread around the neutral `nexus`) and an idle fleet
`<id>_1`. The default is `['green', 'red']`.

**Expose the server.**
- *Same machine:* open two browser contexts (two tabs / a private window) as `green` and `red`.
- *LAN (two devices):* `HOST=0.0.0.0 PORT=9000 pnpm dev:server`, then dial
  `ws://<this-machine-LAN-IP>:9000/matches/dev?player=green`.
- *Internet (throwaway):* tunnel the port — `cloudflared tunnel --url http://localhost:8787`
  (or `ngrok http 8787`) — and use the printed `wss://…` URL; or host it (Fly.io/Railway). Do
  **not** expose an unauthenticated dev server long-term — JWT is brick F7 / SE-0.1.

**Headless coverage (runs in `pnpm test`):**
- `scenario.test.ts` — the two-player wire (action → broadcast to both → exact reconstruction).
- `restart.test.ts` — graceful restart: `close()` drains active clients (clean 1001) and a fresh
  server resumes a client from preserved state (the only missing piece for crash-safe restart is
  durable state, F2).
- `soak.test.ts` — N clients fire K actions concurrently; the room serializes all N×K and every
  client converges on the same authoritative state. (This caught a real JSON-stability bug: a `-0`
  coordinate desynced reconstruction, since JSON has no `-0`.)

**Manual checklist for a human two-player test:**
1. Both clients connect and receive a `welcome` snapshot.
2. An action from one player is reflected on the **other** within the broadcast.
3. An unknown `?player=` is refused (HTTP 403).
4. Kill the server mid-session → clients disconnect cleanly; restart → they reconnect and resync
   from `welcome` (state is lost until persistence/F2 — expected for now).
5. Bad / oversized messages are rejected (`E_BAD_MESSAGE` / `E_PAYLOAD_TOO_LARGE`), not crashing.

**Known constraints before this is "real" multiplayer** (see limitations below): in-memory
(restart loses the match), no auth, lazy world clock (advances on action, no scheduler), and deltas
are not yet visibility-filtered per player (F6).

## Protocol

Client → server:

```ts
{ type: 'action', action: Action }
{ type: 'ping', clientTime?: number }
```

Server → client:

```ts
{ type: 'welcome', matchId, playerId, seq, serverTime, state }       // full snapshot (join)
{ type: 'state',   matchId, seq, serverTime, state, events }         // full snapshot (resync)
{ type: 'delta',   matchId, seq, serverTime, delta, events }         // incremental update
{ type: 'rejection', matchId, seq, actionId, code }
{ type: 'pong',    matchId, serverTime, clientTime? }
{ type: 'error',   matchId, code }
```

Broadcasts are entity-level deltas (changed entities per collection + removed ids + changed top-level fields). What remains for production is **per-player visibility filtering** — diffing against `visibleState(playerId)` instead of the full state, which is gated on fog-of-war (backlog A1).

## Important limitations before real production multiplayer

- **Persistence:** match state and idempotency receipts are memory-only. Stage 3 must store `GameState`, match version and receipts in PostgreSQL.
- **Scheduling:** delayed events are still advanced on action/sync. Stage 3 needs a Redis/BullMQ wake-up path for long offline durations.
- **Auth:** `playerId` is currently a query parameter. Production needs JWT/session auth in the WebSocket handshake.
- **Fog of war:** deltas are diffed against the full state for everyone. Production must diff against `visibleState(playerId)` so a player only ever receives what they can see (needs A1).
- **Diffs:** ✅ deltas are sent (full snapshots only on join/resync). Reconnect already works via the `welcome`/`state` full snapshot.
- **Queues:** JavaScript message handling is serialized in one process. Multi-instance deployment needs DB optimistic locking or a per-match/per-player queue.
