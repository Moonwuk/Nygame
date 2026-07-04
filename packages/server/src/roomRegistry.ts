import type { MatchRoom } from './matchRoom';

/**
 * A set of independent match-actors hosted in one process, addressed by match id
 * (SV-0.2). Each `MatchRoom` already serializes its own messages — the actor mailbox
 * (committed submits via `commitChain`, ticks, etc.) — so the registry only needs to
 * hand the WebSocket layer the right match to route a connection to. That lifts the
 * "one process = one match" limit: a single server process can host many ISOLATED
 * matches (no shared mutable state between them) instead of exactly one.
 *
 * Lifecycle (lazy load on demand, idle-evict / hibernation to the store) is a later
 * brick — this is the routing core. Read-only from the WS layer's perspective.
 */
export interface RoomRegistry {
  /** The LIVE room for `matchId` (in memory now), or undefined. Synchronous — used by
   *  the health endpoint and non-blocking checks; use `resolve` to load on demand. */
  get(matchId: string): MatchRoom | undefined;
  /** Ids of all currently-LIVE matches. */
  ids(): string[];
  /** Load-on-demand: return the room, loading it from the store if this process holds a
   *  durable snapshot but no live copy, or undefined if no such match exists. Absent ⇒
   *  the transport falls back to `get` (eager registries hold every match live). */
  resolve?(matchId: string): Promise<MatchRoom | undefined>;
  /** Lifecycle signals from the transport: a socket connected to / disconnected from a
   *  match. A lazy registry uses these to hibernate (persist + evict) an unwatched match
   *  after an idle window. No-ops for an eager registry. */
  retain?(matchId: string): void;
  release?(matchId: string): void;
  /** Persist + release every live match (graceful shutdown). */
  shutdown?(): Promise<void>;
}

/** In-memory registry: the matches this process holds live in a Map. The default for
 *  dev/tests and the single-process deployment; a lazy/DB-backed impl swaps in behind
 *  the same interface when hibernation lands. */
export class InMemoryRoomRegistry implements RoomRegistry {
  private readonly rooms = new Map<string, MatchRoom>();

  constructor(rooms: readonly MatchRoom[] = []) {
    for (const room of rooms) this.add(room);
  }

  /** Host a match (upsert by id — re-adding the same id replaces it, e.g. on reload). */
  add(room: MatchRoom): void {
    this.rooms.set(room.id, room);
  }

  get(matchId: string): MatchRoom | undefined {
    return this.rooms.get(matchId);
  }

  ids(): string[] {
    return [...this.rooms.keys()];
  }
}

/** A room the lazy registry is hosting, paired with the teardown that persists it and
 *  stops its clock driver when it hibernates or the server shuts down. */
export interface LoadedMatch {
  room: MatchRoom;
  dispose: () => void | Promise<void>;
}

export interface LazyRoomRegistryOptions {
  /** Build + fully wire (persist, clock driver) a live room for `matchId` from the store,
   *  paired with its teardown, or null if no such match exists durably. */
  load: (matchId: string) => Promise<LoadedMatch | null>;
  /** How long a match may sit with zero connected sockets before it is hibernated.
   *  Default 5 minutes. */
  idleMs?: number;
  /** Timer injection for deterministic tests. Defaults to global setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Lifecycle-managing registry (SV-0.2): matches are loaded from the store ON DEMAND and
 * hibernated (persisted + evicted) after they sit unwatched for `idleMs`, so a process's
 * live memory scales with CONCURRENTLY-ACTIVE matches, not the total ever created (the
 * risk13 cost profile). An evicted match keeps its durable snapshot; on the next
 * connection it reloads and its clock driver catches the world up deterministically —
 * so hibernation is invisible to correctness.
 *
 * The 24/7 world keeps running for a fully-offline match too: on hibernation the registry
 * arms a WAKE timer at the match's next scheduled event; when it fires, the match is
 * reloaded, caught up (its due events processed + persisted), and re-hibernated — re-armed
 * for the following event. So a battle/economy/arrival resolves at its real time even with
 * nobody connected. The timer is injectable (the same seam a cross-process pg-boss "wake
 * match X at T" delayed job plugs into for a multi-process deployment — SV-4.1).
 */
/** setTimeout caps at ~24.8 days (2^31−1 ms); a farther wake is split — we fire early,
 *  the reload's catch-up is a no-op if nothing is due yet, and re-arm. */
const MAX_WAKE_DELAY = 2_147_483_647;

export class LazyRoomRegistry implements RoomRegistry {
  private readonly live = new Map<string, LoadedMatch>();
  private readonly loading = new Map<string, Promise<MatchRoom | undefined>>();
  /** Matches whose hibernation persist is in flight — a reconnect awaits this so it
   *  reloads the freshly-persisted state, not the pre-hibernation snapshot. */
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly idle = new Map<string, unknown>();
  /** Armed wake timers for hibernated matches (fire at the next scheduled event). */
  private readonly wakes = new Map<string, unknown>();
  private readonly idleMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: LazyRoomRegistryOptions) {
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get(matchId: string): MatchRoom | undefined {
    return this.live.get(matchId)?.room;
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  async resolve(matchId: string): Promise<MatchRoom | undefined> {
    const live = this.live.get(matchId);
    if (live) return live.room;
    // A reconnection landing WHILE this match is mid-hibernation must not read the
    // pre-hibernation snapshot: wait for the in-flight dispose (which persists the latest
    // state) to finish, then load the fresh snapshot.
    const disposing = this.disposing.get(matchId);
    if (disposing) {
      await disposing;
      const relive = this.live.get(matchId);
      if (relive) return relive.room; // a concurrent resolve already reloaded it
    }
    // De-dupe concurrent loads (two players joining an evicted match at once): the
    // second awaits the first's in-flight load instead of building a second room.
    const inflight = this.loading.get(matchId);
    if (inflight) return inflight;
    const load = this.doLoad(matchId);
    this.loading.set(matchId, load);
    try {
      return await load;
    } finally {
      this.loading.delete(matchId);
    }
  }

  private async doLoad(matchId: string): Promise<MatchRoom | undefined> {
    const loaded = await this.options.load(matchId);
    if (!loaded) return undefined;
    this.live.set(matchId, loaded);
    this.disarmWake(matchId); // now live — the loaded room's clock driver supersedes the wake
    return loaded.room;
  }

  retain(matchId: string): void {
    this.disarmIdle(matchId); // a fresh connection cancels any pending hibernation
  }

  release(matchId: string): void {
    const live = this.live.get(matchId);
    if (!live || live.room.peerCount > 0) return; // still watched by another socket
    if (this.idle.has(matchId)) return; // already counting down
    this.idle.set(
      matchId,
      this.schedule(() => void this.hibernate(matchId), this.idleMs),
    );
  }

  async shutdown(): Promise<void> {
    for (const h of this.idle.values()) this.cancel(h);
    this.idle.clear();
    for (const h of this.wakes.values()) this.cancel(h);
    this.wakes.clear();
    const all = [...this.live.values()];
    this.live.clear();
    // Persist + tear down every live match, plus any hibernation already in flight.
    // `allSettled` so one failing store write can't abort the rest or reject `shutdown`
    // (which the transport awaits before closing its sockets — a rejection would leak them).
    await Promise.allSettled([
      ...all.map((l) => Promise.resolve().then(() => l.dispose())),
      ...this.disposing.values(),
    ]);
  }

  private disarmIdle(matchId: string): void {
    const h = this.idle.get(matchId);
    if (h !== undefined) {
      this.cancel(h);
      this.idle.delete(matchId);
    }
  }

  private async hibernate(matchId: string, wakeProgressed = true): Promise<void> {
    this.idle.delete(matchId);
    const live = this.live.get(matchId);
    if (!live || live.room.peerCount > 0) return; // a socket reconnected during the window
    // Read the next scheduled event's wall-ms BEFORE teardown, to wake for it while asleep.
    const nextEventMs = live.room.msUntilNextEvent();
    this.live.delete(matchId);
    // `dispose` persists + tears down; it can REJECT on a store error. Contain it: a
    // failed idle-persist must never crash the process (this runs as `void hibernate`).
    // The match is still evicted; it reloads from its last durable snapshot on reconnect.
    // Publishing the (swallowed) promise in `disposing` also lets a reconnect landing
    // during the persist reload the freshly-saved state (see `resolve`).
    const persisted = Promise.resolve()
      .then(() => live.dispose())
      .then(
        () => {},
        () => {},
      );
    this.disposing.set(matchId, persisted);
    try {
      await persisted;
    } finally {
      this.disposing.delete(matchId);
    }
    // Keep the world running while asleep: fire the next scheduled event at its time.
    // BUT don't re-arm when a wake just made no progress while events are still overdue
    // (ms 0) — that's a stalled clock (a same-instant runaway), and an immediate 0ms
    // re-arm would spin load→tick→persist forever. Leave it asleep (the room already
    // alerted via advance_overflow); a real connection reloads it. Mirrors the clock
    // driver's stall guard.
    if (wakeProgressed || nextEventMs !== 0) this.armWake(matchId, nextEventMs);
  }

  private armWake(matchId: string, ms: number | null): void {
    this.disarmWake(matchId);
    if (ms === null) return; // nothing scheduled — nothing to wake for
    this.wakes.set(
      matchId,
      this.schedule(() => void this.wake(matchId), Math.max(0, Math.min(ms, MAX_WAKE_DELAY))),
    );
  }

  private disarmWake(matchId: string): void {
    const h = this.wakes.get(matchId);
    if (h !== undefined) {
      this.cancel(h);
      this.wakes.delete(matchId);
    }
  }

  /** A hibernated match's next event came due: reload it, catch the world up (processing
   *  the due events), and — if still unwatched — re-hibernate, which re-arms for the event
   *  after. A connection that arrived meanwhile leaves it live (its driver takes over). */
  private async wake(matchId: string): Promise<void> {
    this.wakes.delete(matchId);
    if (this.live.get(matchId)) return; // already live (someone connected) → driver handles it
    const room = await this.resolve(matchId);
    if (!room) return; // no longer in the store
    // tick() returns whether the clock advanced — a stalled runaway makes no progress, and
    // the re-hibernation uses that to avoid an infinite 0ms wake spin.
    const progressed = room.tick(); // process events due up to now; re-hibernation persists it
    if (room.peerCount === 0) await this.hibernate(matchId, progressed);
  }
}
