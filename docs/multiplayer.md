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
  `advanceTo(serverNow)` → authorize player/action owner → `applyAction()` → broadcast `state`.
- Retried action IDs are idempotent: the same action ID is not applied twice.
- Cross-player spoofing is rejected with `E_FORBIDDEN`.
- `@void/client` exposes `MultiplayerClient`, a small transport adapter that sends actions and consumes `welcome`/`state`/`rejection` messages.

## Protocol

Client → server:

```ts
{ type: 'action', action: Action }
{ type: 'ping', clientTime?: number }
```

Server → client:

```ts
{ type: 'welcome', matchId, playerId, seq, serverTime, state }
{ type: 'state', matchId, seq, serverTime, state, events }
{ type: 'rejection', matchId, seq, actionId, code }
{ type: 'pong', matchId, serverTime, clientTime? }
{ type: 'error', matchId, code }
```

The first slice broadcasts full state, not diffs. That is acceptable for development and tests; production should replace it with visibility-filtered diffs.

## Important limitations before real production multiplayer

- **Persistence:** match state and idempotency receipts are memory-only. Stage 3 must store `GameState`, match version and receipts in PostgreSQL.
- **Scheduling:** delayed events are still advanced on action/sync. Stage 3 needs a Redis/BullMQ wake-up path for long offline durations.
- **Auth:** `playerId` is currently a query parameter. Production needs JWT/session auth in the WebSocket handshake.
- **Fog of war:** broadcasts currently send full `GameState`. Production must send `visibleState(playerId)` only.
- **Diffs:** full snapshots are simple but expensive. Production should send monotonic diffs with periodic snapshots for reconnect.
- **Queues:** JavaScript message handling is serialized in one process. Multi-instance deployment needs DB optimistic locking or a per-match/per-player queue.
