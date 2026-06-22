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
