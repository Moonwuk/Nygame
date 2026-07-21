# Engineering risks and decisions

This is a working checklist for the non-obvious problems that will matter once Void Dominion moves from prototype to always-on multiplayer.

## 1. Real-time simulation without per-second ticking

**Risk:** a 24/7 game can accidentally become a server that ticks every match every second. That does not scale and creates drift between server restarts.

**Decision:** keep the core event-driven:

- state stores authoritative `time` and a serialized `scheduled[]` timeline;
- server wakes only for due events or player actions;
- `advanceTo(now)` processes due events in deterministic `(at, seq)` order;
- continuous systems accrue by formula over `time.advanced {from,to}` spans.

**Guardrails:** cap catch-up work per `advanceTo`, dead-letter failed scheduled events, and record metrics for long catch-up spans so old inactive matches can be archived or advanced in batches.

## 2. Race conditions around player actions

**Risk:** two concurrent actions can double-spend resources, move the same fleet twice, or resolve against different world times.

**Decision:** action processing should be serialized at the match/player boundary:

1. load state in a DB transaction;
2. `advanceTo(authoritativeNow)`;
3. validate action authorization/idempotency;
4. `applyAction`;
5. persist state + action receipt atomically;
6. publish diffs after commit.

For a single player, process actions through a per-player queue. For cross-player conflicts in one match, protect the match row/version with optimistic locking (`version = version + 1`) and retry the whole pure reducer on conflict.

## 3. Idempotency and retries

**Risk:** mobile clients and WebSockets retry aggressively. A valid retry must not build a unit twice or issue a second move.

**Decision:** Stage 2 action IDs stay `session:player:sequence`. Persist an idempotency table with the stable result code/hash for a short TTL. Reject gaps or replays according to the chosen sequence policy; never let the core infer idempotency from current state.

## 4. Determinism drift

**Risk:** server/client preview diverges because of RNG changes, data changes, floating-point shortcuts, or module order changes.

**Decision:** pin per match:

- game-data version;
- module manifest order/version;
- match config (`timeScale`, victory rules, etc.);
- RNG state.

Keep golden RNG tests, avoid `Date.now()`/`Math.random()` in core, and treat data migrations as explicit match-version migrations rather than silent edits.

## 5. Fog of war and data leaks

**Risk:** sending full `GameState` to clients makes cheating trivial even if the UI hides enemies.

**Decision:** Stage 2/3 must expose `visibleState(playerId)` projections. The server filters before WebSocket publish and before REST/debug endpoints. The client should receive only visible fleets, planets, schedules and battle details.

## 6. UI/map performance

**Risk:** the prototype draws everything every frame; the real map will have many sectors, fleets, effects and labels.

**Decision:** keep the canvas/Skia render path data-oriented:

- cull by viewport and zoom before drawing;
- split static layers (grid, lanes, planet base markers) from dynamic layers (fleets, battles, selection);
- avoid measuring/layouting labels in the hot path;
- aggregate icons/counts at low zoom;
- throttle non-critical panels/logs separately from the render loop.

For React Native, keep `shared-core` preview work off the UI thread where possible and apply server diffs incrementally.

## 7. Scheduling explosions

**Risk:** combat, construction, events and traits can schedule recursive events at the same timestamp and create runaway loops.

**Decision:** keep kernel guardrails (`MAX_EVENTS_PER_STEP`, `MAX_ADVANCE_STEPS`) and add observability around which event type hit the cap. Recurring systems must schedule strictly in the future after `timeScale` adjustment.

## 8. Economy balance versus technical abuse

**Risk:** offline production and upkeep can be gamed if catch-up order is ambiguous.

**Decision:** settle time in chronological segments. If a fleet arrives at 10:00 and production is checked at 12:00, run `time.advanced(08:00→10:00)`, arrival/capture, then `time.advanced(10:00→12:00)`. Never compute offline income from only the final ownership snapshot.

## 9. Deployment and long-lived matches

**Risk:** deployments can change rules under active matches.

**Decision:** active matches load their pinned manifest and data. New code may contain compatibility adapters, but old matches must not silently get new balance constants or module order. Migrations need a replay/golden scenario before rollout.

## 10. Prototype-specific traps

**Risk:** prototype UX can accidentally hard-code mechanics that should stay data-driven.

**Decision:** prototype-only helpers are allowed (`fleet.launch` currently lives there), but anything used by server/client gameplay should graduate into `shared-core` as a module with tests. UI affordances such as selection groups must submit player intent only, not mutate state directly.

## 11. Action latency and optimistic UI

**Risk:** every player action round-trips to the server before visual feedback. On a mobile
4G connection (RTT 100–300 ms) moving a fleet or starting construction feels sluggish and
unresponsive — a hard UX problem for a genre where instant feedback is the norm.

**Decision:** the client applies actions *optimistically* using the same `shared-core`
reducer it already embeds, then reconciles against the server's authoritative ack:

1. On action submit the client runs `applyAction(localState, action, {now})` immediately and
   renders the result. The action is queued as *pending*.
2. The server processes the same action and broadcasts a snapshot delta.
3. On ack the client drops the optimistic state and adopts the server's version. Because the
   core is deterministic and the client's `localState` was already the latest server snapshot,
   the results will be identical in the common case — no visible flicker.
4. On reject (server returns `ok: false`) the client rolls back to the pre-action state and
   shows an error note.

**Guardrails:**
- Only one action per player may be optimistically in-flight at a time; subsequent actions
  queue behind the pending ack to avoid compounding divergence.
- The client never optimistically advances the world clock; time advancement is
  server-authoritative (the client interpolates visually but does not accrue resources).
- If the server ack does not arrive within a timeout the pending action is retried with the
  original action ID (idempotency — see risk #3); the UI shows a "sending…" indicator.

## 12. Offline and degraded-connection mode

**Risk:** no server connection = blank screen on mobile. Players drop into subways and
tunnels constantly; an app that shows nothing during a 2-minute gap is unacceptable for a
Bytro-style genre where the whole draw is the persistent world.

**Decision:** two-tier fallback:

**Tier 1 — cached read-only view (offline).**
The client persists the last received `visibleState` snapshot to local storage
(AsyncStorage on React Native / IndexedDB on web) keyed by `matchId`. On launch or
reconnect failure the client loads the cache and renders the map with a "last updated N
minutes ago" banner. All build queues, fleet positions and battle countdowns are visible;
actions are disabled and queued locally (submitted once the socket reconnects, relying on
idempotency).

**Tier 2 — local clock interpolation (brief drop).**
For gaps under ~60 seconds the client keeps the local world clock running at the last
known `speed` and animates fleet movement by dead-reckoning against the scheduled arrival
timestamps already in the cached state. No economy is accrued locally — only visual
position. On reconnect the server snapshot replaces the interpolated positions.

**Guardrails:**
- Cached state must be the per-player *visible projection*, not the raw `GameState`
  (which leaks fog-of-war; see risk #5).
- Locally-queued actions are replayed in order on reconnect; actions that have become
  invalid (fleet already arrived, resources drained) are surfaced as errors, not silently
  dropped.

## 13. 24/7 server room cost and scaling

**Risk:** unlike turn-based games, every active match holds an in-process room with live
state indefinitely. At scale this means CPU and memory proportional to *total active
matches*, not *concurrent players* — a fundamentally different cost curve that gets
expensive fast.

**Decision:** match rooms are *demand-driven*, not always-on:

**Room hibernation.** When no player is connected and no scheduled event is due within
`HIBERNATE_WINDOW` (e.g. 10 minutes), the server persists the `GameState` snapshot to the
DB and closes the in-process room. The room entry in the registry becomes a lightweight
record that stores only `nextEventAt`.

**Demand wake.** Two paths wake a hibernated room:
1. A player connects → server loads the snapshot, runs `advanceTo(now)` to catch up all
   due events, then opens the WebSocket session.
2. A scheduled event becomes due → a cron/delayed-job fires at `nextEventAt`, loads the
   room, advances to that time, persists, and re-sleeps if still empty.

**Cost profile.** The cron granularity (e.g. hourly) sets the minimum CPU overhead. A
match with no players active and only hourly economy ticks costs one DB read + one
`advanceTo` call per hour — effectively zero steady-state CPU between events.

**Guardrails:**
- `advanceTo` must be O(events in span), not O(wall-clock span), so catch-up after a
  multi-day sleep is fast (already true by design — risk #1).
- Long-abandoned matches (no action for N days) are archived: state frozen, room never
  woken except for explicit player resumption.
- `nextEventAt` must be kept in the DB alongside the snapshot so the scheduler does not
  need to load and parse the full `GameState` to know when to wake.

## 14. Server restart and match persistence

**Status (✅ RESOLVED):** durable persistence is implemented. With `DATABASE_URL` set the
netserver snapshots `GameState` + idempotency receipts to Postgres (commit-before-broadcast)
and matches resume across a restart (`store/postgres.ts`, `persistence.ts`,
`f8-persistence.test.ts`). Without a DB it falls back to in-memory (restart loses the match).

**Decision (done):** persist `GameState` as JSONB; recover by reload + catch-up on restart.

**Write path (per action):**
1. Load state from DB (or warm room cache).
2. `advanceTo(authoritativeNow)`.
3. Validate and `applyAction`.
4. Persist updated `GameState` + action receipt atomically in one DB transaction.
5. Broadcast diffs to connected peers.

Step 4 happens before step 5: the source of truth is the DB, not the WebSocket broadcast.

**Write path (scheduled events):**
Scheduled events fire inside `advanceTo`. The resulting state is persisted exactly once
after `advanceTo` completes, not after each individual event, to keep DB writes bounded.

**Recovery on restart:**
1. Load all non-archived match snapshots from DB.
2. For each, reconstruct a `MatchRoom` with `initiallyStarted: true` and the stored state.
3. Call `advanceTo(now)` once per room to process any events that fired during the
   downtime window.
4. Resume normal operation — connected clients receive a full snapshot on reconnect.

Because `GameState` encodes the full `scheduled[]` timeline and the `rng` seed, a
reloaded room is deterministically identical to the in-memory room that was lost.

**Guardrails:**
- The `ReceiptStore` (idempotency receipts) must also be persisted or the restart window
  creates a dedup gap. A Redis-backed `ReceiptStore` (already the planned seam in
  `MatchRoom`) naturally survives process restarts.
- DB write latency is on the critical path of every action. Use a write-optimised store
  (Postgres with JSONB + a covering index on `matchId`) and keep snapshot size bounded by
  archiving stale matches.
- Snapshot size grows with match age (more scheduled events, more fog memory). Add a
  compaction pass that prunes already-fired events and expired fog entries on each persist.
