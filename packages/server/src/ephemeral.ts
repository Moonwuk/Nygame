/**
 * EphemeralStore — the seam where Redis drops in later (one impl swap).
 *
 * It holds the in-memory parts of a live match that belong neither in the
 * deterministic `GameState` (they'd trip hashState / replay / the schedule) nor in
 * the durable Postgres store (they're high-churn and expire): today the ally pings;
 * later presence and cross-node rate limits. See docs/tech-stack.md (the Redis
 * trigger): at a SINGLE process the in-memory impl is authoritative and adds no
 * dependency; the moment a second server process exists, a Redis-backed impl makes
 * the same data shared + restart-surviving without touching the room logic.
 *
 * The interface is **async by design**: a Redis impl is a network call, so a
 * synchronous interface could never honestly be Redis-backed (it would be a fake
 * seam). The in-memory impl simply resolves immediately. Values are JSON-shaped (a
 * Redis impl serializes); TTL is the natural Redis primitive (`SET … PX`).
 */
export interface EphemeralStore {
  /** Store `value` under `key`, auto-expiring after `ttlMs` (Redis `SET key v PX ttl`). */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  /** Live value, or undefined if missing/expired (Redis `GET`). */
  get<T>(key: string): Promise<T | undefined>;
  /** Remove a key (Redis `DEL`). */
  delete(key: string): Promise<void>;
  /** All live (unexpired) entries whose key starts with `prefix` (Redis `SCAN MATCH`). */
  entries<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * Single-process in-memory implementation. Expiry is lazy (checked on read/scan),
 * exactly like Redis's own key expiry semantics, so swapping to Redis changes no
 * caller behaviour. `now` is injectable so a room can align store expiry with its
 * own (lobby-adjusted) clock and tests can control time.
 */
export class InMemoryEphemeralStore implements EphemeralStore {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async entries<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const now = this.now();
    const out: Array<{ key: string; value: T }> = [];
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key); // lazy expiry, like Redis
        continue;
      }
      if (key.startsWith(prefix)) out.push({ key, value: entry.value as T });
    }
    return out;
  }
}
