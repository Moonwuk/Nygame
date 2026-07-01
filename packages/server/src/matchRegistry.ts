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
export interface MatchRegistry {
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
export class InMemoryMatchRegistry implements MatchRegistry {
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

export interface LazyMatchRegistryOptions {
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
 * Note: an evicted match's due scheduled events do NOT fire while it sleeps (nobody is
 * watching); they resolve on reload's catch-up. Waking a hibernated match for an event
 * with all players offline (push notifications / offline victory) is a cross-process
 * scheduler concern (pg-boss, SV-4.1) — out of scope here.
 */
export class LazyMatchRegistry implements MatchRegistry {
  private readonly live = new Map<string, LoadedMatch>();
  private readonly loading = new Map<string, Promise<MatchRoom | undefined>>();
  /** Matches whose hibernation persist is in flight — a reconnect awaits this so it
   *  reloads the freshly-persisted state, not the pre-hibernation snapshot. */
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly idle = new Map<string, unknown>();
  private readonly idleMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: LazyMatchRegistryOptions) {
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
    const all = [...this.live.values()];
    for (const id of this.idle.keys()) this.cancel(this.idle.get(id));
    this.idle.clear();
    this.live.clear();
    // Persist + tear down every live match (best-effort, in parallel).
    await Promise.all(all.map((l) => Promise.resolve(l.dispose())));
  }

  private disarmIdle(matchId: string): void {
    const h = this.idle.get(matchId);
    if (h !== undefined) {
      this.cancel(h);
      this.idle.delete(matchId);
    }
  }

  private async hibernate(matchId: string): Promise<void> {
    this.idle.delete(matchId);
    const live = this.live.get(matchId);
    if (!live || live.room.peerCount > 0) return; // a socket reconnected during the window
    this.live.delete(matchId);
    // Publish the in-flight dispose so a reconnect landing during the persist reloads the
    // freshly-saved state (see `resolve`), and always clear it when done.
    const p = Promise.resolve(live.dispose());
    this.disposing.set(
      matchId,
      p.then(
        () => {},
        () => {},
      ),
    );
    try {
      await p;
    } finally {
      this.disposing.delete(matchId);
    }
  }
}
