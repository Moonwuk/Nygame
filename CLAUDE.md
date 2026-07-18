# CLAUDE.md

Guidance for working in this repository. Read `docs/` for the full design;
this file is the short, operational version plus the non-obvious invariants.

## What this is

Void Dominion — a mobile, **real-time**, massively-multiplayer space grand strategy
(Bytro-style genre, original everything). Real-time means continuous wall-clock time
that runs 24/7 even while the player is offline — **not turn-based**; "asynchronous"
describes the play pattern (drop in, issue orders that take real hours, drop out). The
whole bet is a **flexible, extensible core**: add mechanics/units/factions through data,
not by rewriting logic.

Monorepo (pnpm workspaces):

- `packages/shared-core` — the deterministic, data-driven simulation. Built first,
  in isolation (no server, no DB, no network) — the foundation the rest builds on.
- `packages/action-layer` — the action gate in front of the reducer (Stage 2, done):
  envelope validation → per-type zod payload schemas → session authorization →
  idempotency receipts → strict per-session `clientSeq` sequence gate; stable `E_*` codes.
- `packages/server` — authoritative server (Stage 3; the critical path to an online session
  is closed). `MatchRoom` (advance → applyAction → **per-player fog deltas**),
  durable+bounded+rate-limited receipts, strict commit-before-broadcast persistence over a
  Postgres match/receipt store, a **v1 offline scheduler** (`clockDriver.ts`), a
  **multi-match registry** with hibernation (`LazyRoomRegistry`) and a match-browser
  read-model (`GET /matches`), JWT join-token auth + Origin allowlist (`auth.ts`), and the
  `@void/action-layer` gate — auth/gate switched by env (`AUTH_JWT_SECRET`, `GATE=1`,
  `ALLOWED_ORIGINS`). Hosted by `packages/server/src/main.ts`; the prototype host
  (`prototype/netserver.ts`) carries the same slice for playtests. Not yet: OIDC identity,
  multi-process scale (pg-boss). (`MultiplayerClient` already sends `action.v1` envelopes.)
- `packages/client` — client (Stage 4). Direction is a **PWA-first web client** (TWA Android +
  Capacitor iOS), not React Native — see `docs/cross-platform-roadmap.md` (decision record). Holds
  the `MultiplayerClient` transport adapter plus framework-agnostic view-models + theme tokens
  (`welcomeScreen.ts` — welcome screen; `matchHud.ts` — status bar / fleet selection / battle
  panel; `theme.ts`); the app shell is a working Vite scaffold (welcome + live map over the
  shared render kit + `?join=` deep-link speaking `action.v1`) — the full in-match HUD is
  still ahead, so the players' playable client remains `prototype/`. `mobile/` is the thin
  Capacitor wrapper (APK).
- `data/` — game content as JSON. `docs/` — design docs.

## Commands

```bash
pnpm install
pnpm run check        # lint + typecheck + test + docs-check — run this before committing
pnpm test             # Vitest
pnpm run lint         # ESLint (flat config)
pnpm run typecheck    # tsc --noEmit, all packages
pnpm run format       # Prettier --write
```

Run the gate locally before committing — `pnpm run check` = lint + typecheck + test +
docs-check (`scripts/docs-check.mjs`: целостность `.md`-ссылок в docs/ + словарь зон
backlog'а — исполняемая часть правила «verify docs against reality»)
(CI additionally runs an OSV-Scanner SCA pass over the lockfiles; `pnpm audit` is
retired — npm shut down its audit endpoints, 2026-07). CI mirrors it on every push:
`.github/workflows/ci.yml` runs the gate + audit against a service Postgres (so the
durable-store tests run too), `.github/workflows/security.yml` runs the gate + audit alongside
a diverse scanner set (Semgrep, CodeQL, Trivy, OSV, Gitleaks, TruffleHog, zizmor), and
`.github/workflows/android.yml` builds the Android APK. `main` is protected — changes land
via PR with green CI (see `CONTRIBUTING.md`); keep the gate green before pushing.

## Non-negotiable invariants

These come straight from the design docs. Breaking them is a bug, not a style choice.

1. **Determinism.** `shared-core` is a pure function: same `(state, action, context)`
   → same result. No `Math.random()` and no `Date.now()` anywhere in the core — use
   the seeded `Rng` and take time via `Context.now`. ESLint enforces this in
   `packages/shared-core/src/**` (non-test). The RNG stream is locked by a golden
   test (`rng.test.ts`); if you intentionally change the algorithm, update the golden
   values, and understand it invalidates replays of existing matches.
2. **Purity / immutability.** `applyAction` never mutates its input `state`. It works
   on a `deepClone` draft and returns a new state. `GameState` must stay
   JSON-serializable (it is persisted as JSONB) — no class instances, Maps, Dates, or
   functions inside it.
3. **Modules talk only through the bus.** No module imports another module. The three
   mechanisms are events (pub/sub reactions), hooks (value pipelines with a base
   default), and the capability registry (optional links with a fallback). Every
   extension point must degrade gracefully: no module present → base default, never a
   crash. See `docs/modulesystem.md`.
4. **Fail-secure (OWASP A10).** Any error → rejection, never a silent pass. The reducer
   returns `{ ok: false, code }` with a stable error code only — no internal detail
   leaks to the caller (details belong in server logs). `h.reject(code)` is the
   intended path; unexpected throws become `E_INTERNAL`.
5. **Server-authority.** The client sends intent, never state. Validation/authorization/
   idempotency live in the action layer (`@void/action-layer`, wired in front of the reducer
   on gated servers); the core reducer assumes an action already cleared those gates.
6. **Determinism of module order.** Module execution order = their order in the array
   passed to `createKernel`, recorded in `kernel.manifest` and versioned per match.
   Don't introduce order-dependent behavior that isn't driven by that fixed order.

## Architecture quick map

`createKernel(modules)` compiles an immutable kernel from an ordered module list. It
exposes two pure entry points:

- `applyAction(state, action, ctx)` — apply a player's intent at `ctx.now`.
- `advanceTo(state, ctx)` — move the world clock to `ctx.now`, firing due scheduled
  events in `(at, seq)` order and emitting a contiguous `time.advanced` { from, to }
  event for each continuous span (so modules accrue resources by formula, not ticks).
  Real-time server flow: `advanceTo` to the present, then `applyAction`.

A module's `setup(api)` registers: `onAction(type, h)` (one handler per type),
`on(event, h)`, `hook(name, fn)`, `provideCapability(name, impl)`. Handlers receive a
`HandlerContext` with the draft `state`, `ctx` (now + validated game data), the `rng`,
`emit`, `schedule(at, type, payload)` (express a future occurrence / real-time
duration), `hook`, `capability`, and `reject`. A scheduled event whose handler throws is
dead-lettered (dropped, recorded in `failures`) so the timeline never gets stuck.

New game mechanic = new module (subscribe to events + register hooks) + maybe new JSON
data. You should not need to touch the kernel.

## Toolchain notes / gotchas

- **zod v4** is installed. Use the two-arg `z.record(keySchema, valueSchema)` form.
  `safeParseGameData` returns `z.ZodSafeParseResult<GameData>`.
- **`shared-core/tsconfig.json` sets `types: ["node"]`** so tests can read `data/*.json`
  via `node:fs`. This is for typechecking convenience only — the core's no-Node/
  no-`Date` discipline is enforced by ESLint, not by withholding the types. Don't import
  Node built-ins from non-test `shared-core/src` files.
- Game data is split into `data/*.json` fragments + `data/manifest.json` (version).
  A loader composes them into one bundle and runs `parseGameData` (see
  `schemas.test.ts` for the exact composition). All external data is validated before
  it reaches the core (A05/A08).
- Tests live next to source as `*.test.ts`. The root `vitest.config.ts` discovers them.

## Working agreements

- **Code first, docs after (current experiment).** Before changing anything, sync with
  the code you'll touch (read the relevant modules/data). Make the change and get the
  gate green, _then_ update the state artifact (`docs/state.md`) so it matches what
  actually landed — documentation follows the working code, not the other way around.
- **Reconcile, don't append.** When updating `docs/state.md` (or any living doc),
  RESOLVE what the new text supersedes — rewrite or delete the stale claim — instead
  of appending a fresh paragraph next to an old truth. Two live versions of one fact
  are worse than none: the anchor only works while every claim in it is current.
- **Verify docs against reality before writing them.** Any documentation change or new
  doc is gated on checking it against the actual code/behaviour first: read the source,
  run the gate, confirm names / counts / signatures. Never document from memory or
  assumption; if a claim can't be verified against the codebase, don't write it.
- Run `pnpm run check` before committing; keep CI green.
- When you finish a roadmap milestone, update the "Статус реализации" section in
  `docs/roadmap.md`.
- Development happens on the feature branch; open a PR (draft) after pushing.
- **Team workflow & tasks.** `main` is the only integration point — branch off it,
  keep PRs small and single-zone, get the gate green, PR back to `main`. Full regimen
  is in `CONTRIBUTING.md`. The assignable task list ("кирпичики", one brick ≈ one PR ≈
  one session) is `docs/backlog.md` — take a brick scoped to one package/module so
  parallel work can't collide.

## Behavioral guidelines

Accepted team rules (guards against common LLM coding mistakes). They bias toward
caution over speed; use judgment on trivial tasks.

1. **Think before coding.** State assumptions. If multiple interpretations exist,
   surface them instead of picking silently. If a simpler approach exists, say so.
   If something is unclear, stop and ask.
2. **Simplicity first.** Minimum code that solves the problem — nothing speculative:
   no abstractions for single-use code, no unrequested configurability, no error
   handling for impossible cases. _Project nuance:_ the architecture's extensibility
   (data-driven content, modules, hooks) is an explicit requirement — those designed
   extension points are "asked for"; the rule bars speculative complexity _within_ a
   unit, not the planned seams.
3. **Surgical changes.** Touch only what the task requires. Don't refactor or
   reformat unrelated code; match existing style; mention unrelated dead code rather
   than deleting it. Remove only orphans your own change created.
4. **Goal-driven execution.** Turn the task into a verifiable goal and loop until it
   passes — usually: write/extend tests, then make them green. `pnpm run check` is the
   gate.
