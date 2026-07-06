import type { GameState, PlayerId } from '@void/shared-core';

/** A durable snapshot of a match — enough to resume it byte-for-byte after a
 *  server restart. `state` is the JSON-serializable `GameState` (the core invariant
 *  that makes JSONB storage trivial); `seq` is the room's action counter, used for
 *  optimistic concurrency (never overwrite a newer snapshot with an older one). */
export interface MatchSnapshot {
  matchId: string;
  dataVersion: string;
  seq: number;
  status: 'ongoing' | 'ended';
  state: GameState;
}

/** Persistence for match state. Adapters: in-memory (dev/test) and Postgres (prod).
 *  All methods are async so the same interface fits a real database. */
export interface MatchStore {
  load(matchId: string): Promise<MatchSnapshot | null>;
  /** Upsert the snapshot. Optimistic by `seq`: a save with an older `seq` than the
   *  stored one is a no-op, so a late write can't clobber fresher state. */
  save(snapshot: MatchSnapshot): Promise<void>;
  /** Ids of every match still `ongoing` (not ended). Cheap — reads the normalized
   *  `status` column (never the JSONB blob), so the match factory and the open-matches
   *  feed can enumerate joinable matches without loading each snapshot. Restart-safe:
   *  it reflects what is durably in the store, not just the rooms live in memory. */
  ongoingMatchIds(): Promise<string[]>;
  /** Cheap reachability check for the `/ready` probe (SV-0.1): true if the backing
   *  store is reachable (a `SELECT 1` for Postgres). Absent ⇒ assumed reachable
   *  (in-memory has no dependency to be down). */
  ping?(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface SeatAssignment {
  playerId: PlayerId;
  /** True if this nick was just assigned the seat (first join), false on return. */
  isNew: boolean;
}

/** Identity for the lightweight nick-login: maps a (room, nick) to a fixed side, so
 *  a returning player resumes their own seat. The full account model (email/JWT) is
 *  in docs/persistence-accounts-roadmap.md; this is the prototype-grade first step. */
export interface AccountStore {
  /** Resolve a nick to a seat in a room: the SAME seat on return, a free seat from
   *  `seats` on first join, or null when every seat is taken by another nick. */
  resolveSeat(
    room: string,
    nick: string,
    seats: readonly PlayerId[],
  ): Promise<SeatAssignment | null>;
  /** Read-only: the seat this nick already holds in a room, or null if it holds none.
   *  Unlike `resolveSeat` this never assigns — it answers "is this nick a participant
   *  of this match?" for the match-browser read-model and archive authorization. */
  seatOf(room: string, nick: string): Promise<PlayerId | null>;
  /** Read-only: how many seats are currently claimed in a room (occupied count), for
   *  the browser's "players X/Y" status line. */
  occupiedSeats(room: string): Promise<number>;
  close?(): Promise<void>;
}

/** A stored account: identity for the login+password authentication (SE-1.x). */
export interface UserRecord {
  userId: string;
  /** The login as the user typed it at registration (display form). Uniqueness is
   *  CASE-INSENSITIVE — `Vasya` and `vasya` are the same account. */
  login: string;
  /** Password hash in the self-describing `scrypt$…` format (see password.ts). */
  passHash: string;
}

/** Accounts for login+password auth. Lookup is case-insensitive on `login`. */
export interface UserStore {
  /** Create an account; fail-secure duplicate handling: an existing login (any case)
   *  → `E_LOGIN_TAKEN`, never an overwrite. */
  createUser(
    login: string,
    passHash: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; code: 'E_LOGIN_TAKEN' }>;
  findUser(login: string): Promise<UserRecord | null>;
  close?(): Promise<void>;
}

/** An action receipt as stored for idempotency — structurally an `ActionReceipt`. */
export interface StoredReceipt {
  actionId: string;
  playerId: PlayerId;
  seq: number;
  ok: boolean;
  code?: string;
}

/** Durable idempotency: action receipts persisted so a retried action isn't applied
 *  twice across a restart. The room keeps an in-memory map for the synchronous dedup
 *  check; this store rehydrates it on boot and records each new receipt. */
export interface ReceiptStore {
  loadAll(matchId: string): Promise<StoredReceipt[]>;
  save(matchId: string, receipt: StoredReceipt): Promise<void>;
  close?(): Promise<void>;
}
