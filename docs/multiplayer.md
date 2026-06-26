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

## Playing the real prototype together — the 2-person test

The section above connects to a minimal core harness (`dev:server`, green/red). To
play the **actual prototype** — the map, the HUD, the whole console — as a
two-player session, use the prototype dev server. It hosts the prototype's *own*
world (same `kernel` + `data` + `newGame()`), so the client renders the live
session exactly like single-player, and it **serves the game HTML at `/`** so a
peer needs no file at all.

### One command to host

```bash
pnpm host        # builds the prototype HTML, serves it + the match on 0.0.0.0:8788
```

It prints the URLs and detects your LAN IP, e.g.:

```
  game   : http://localhost:8788/   (open in a browser → Connect)
  Two-person test:
   • You:    open http://localhost:8788/   → Connect → Azure (p1)
   • Friend: open http://192.168.1.23:8788/  (same Wi-Fi) → Connect → Crimson (p2)
```

(Under the hood that's `pnpm prototype` + `HOST=0.0.0.0 pnpm dev:proto-server`;
`PORT=… pnpm host` changes the port.)

The game opens on a **connect overlay**:

- **Single player** — the local skirmish vs the AI, exactly as before.
- **Connect** — the server URL is **pre-filled from the page's origin**, so just
  pick **Azure** (p1) or **Crimson** (p2) and tap **Connect**. Whoever you join as
  renders **green** ("you"); the opponent is red. The URL is remembered (the APK
  reconnects in one tap).

### Path A — same Wi-Fi, zero install (easiest)

1. Host runs `pnpm host` and reads off the two URLs.
2. **You** open the `localhost` URL in a browser → Connect → Azure.
3. **Friend** (same Wi-Fi) opens the `http://<LAN-IP>:8788/` URL in their phone/laptop
   browser → Connect → Crimson.
4. You're in one live session. (If the friend can't reach it, allow port 8788 through
   the host's firewall.)

### Path B — same Wi-Fi, via the APK

The Capacitor APK (`mobile/`) wraps this same prototype and ships net mode built in;
the debug build allows cleartext (`usesCleartextTraffic`), so it connects over plain
`ws://` on a LAN — no tunnel needed.

1. Host runs `pnpm host`.
2. Get the APK: **Actions → "Android APK (prototype)" → download `void-dominion-debug-apk`**
   (or trigger it manually via *Run workflow*); send `app-debug.apk` to your friend.
3. Both sideload it. In the overlay each types `ws://<host-LAN-IP>:8788` (the host can
   use `ws://localhost:8788`), one picks Azure, the other Crimson → **Connect**.

### Path C — remote friend (different network)

Keep `pnpm host` running and expose the port with a tunnel — it gives a `wss://` URL
that works from anywhere (and from a mobile WebView):

```bash
cloudflared tunnel --url http://localhost:8788   # or: ngrok http 8788
```

Both (browser **or** APK) paste the printed `wss://…trycloudflare.com` URL; one picks
Azure, the other Crimson.

Keep the server (and tunnel) running for the session — state is in-memory, so a restart
loses the match. Do **not** leave an unauthenticated server tunnelled long-term (auth is
brick F7 / SE-0.1).

### Path D — hosted, truly "just a link" (no local server)

Deploy the server once and nobody runs anything locally — you just share a permanent
URL. The repo ships a `Dockerfile` (builds the prototype + runs the proto-server,
serving the game at `/`) and a `render.yaml` blueprint:

- **Render (free):** New → Blueprint → point at this repo → it builds the Dockerfile
  and gives `https://<app>.onrender.com`. Share it; both open it, pick Azure / Crimson.
  The overlay auto-fills the same-origin `wss://`, so there's nothing to type.
- **Any Docker host / Fly.io / Railway:** `docker build -t void-dominion . && docker run -p 8788:8788 void-dominion`, or push the image. The server reads `$PORT`.

Free hosts sleep when idle (cold start on first hit) and state is in-memory (a restart
loses the match) — fine for testing, and the handshake is unauthenticated, so don't
leave it public long-term (auth is brick F7 / SE-0.1).

### Lobby — the match waits for both players

However you connect, the world starts **paused** ("⏳ Waiting for … to join"): the
server freezes the clock until BOTH Azure and Crimson are connected, and re-freezes if
one drops. So whoever opens the link first just waits on the start screen; the match
clock begins the moment the second player joins. (You can pre-position fleets while
waiting — orders apply, but no time passes until both are in.)

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
