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
  /** Seat lock (REL-5): bind `ticketHash` to (room, nick) — but only if no hash is
   *  bound yet — and return the hash that is durably bound AFTER the call (ours when
   *  we won, the pre-existing one when we lost a concurrent bind). Returns null when
   *  the nick holds no seat in the room (nothing to lock — fail-secure: refuse).
   *  Only the HASH ever reaches the store; the plaintext ticket lives on the client. */
  bindSeatTicket(room: string, nick: string, ticketHash: string): Promise<string | null>;
  /** The bound ticket hash for (room, nick), or null when none was ever bound
   *  (first join, or a seat claimed before the lock existed). */
  seatTicket(room: string, nick: string): Promise<string | null>;
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

/** Corporation roles — the fixed RBAC set from docs/corporations.md §2. A `recruit`
 *  row IS the pending application: accept promotes it to `member`, decline (or the
 *  player's cancel) removes it. Because membership is unique per account, this also
 *  caps a player at one application at a time. */
export type CorpRole = 'head' | 'officer' | 'member' | 'recruit';

export interface CorpRecord {
  corpId: string;
  name: string;
  /** AvA influence points (AVA-2) — the corp's inter-match currency: spent on a
   *  challenge, earned by a war victory. Never negative (spend is atomic+guarded). */
  influence: number;
}

/** One membership row. An account belongs to AT MOST one corporation (recruit rows
 *  included). `login` is denormalized for member lists — logins never change. */
export interface CorpMembership {
  corpId: string;
  accountId: string;
  login: string;
  role: CorpRole;
}

/** A corp as the browse list reports it — `members` counts accepted members only
 *  (recruits are pending applications, not headcount). */
export interface CorpSummary extends CorpRecord {
  members: number;
}

/** An audit-log entry for a sensitive corp action (A01): who did what to whom.
 *  `at` is the service clock in ms — injectable for deterministic tests. Audit rows
 *  outlive the corp (they survive a disband — the record is the point). */
export interface CorpAuditEntry {
  corpId: string;
  at: number;
  /** Acting account id. */
  actor: string;
  action:
    | 'create'
    | 'accept'
    | 'decline'
    | 'kick'
    | 'role'
    | 'transfer'
    | 'leave'
    | 'disband'
    | 'influence'
    | 'ready';
  /** Subject account id, when the action has one. */
  target?: string;
  /** Extra context, e.g. the new role for `role`. */
  detail?: string;
}

/** Persistence for corporations (CORP-0). Deliberately dumb CRUD — the rights matrix
 *  lives in `CorpService`; the store guards only the STRUCTURAL invariants that need
 *  storage-level atomicity: unique corp name (case-insensitive) and one corp per
 *  account. */
export interface CorpStore {
  /** Create a corp with `head` as its Глава — atomic, so a duplicate name or an
   *  already-membered founder can't slip in between check and insert. */
  createCorp(
    name: string,
    headAccountId: string,
    headLogin: string,
  ): Promise<{ ok: true; corpId: string } | { ok: false; code: 'E_NAME_TAKEN' | 'E_IN_CORP' }>;
  getCorp(corpId: string): Promise<CorpRecord | null>;
  /** Every corp with its accepted-member count, ordered by name (case-insensitive). */
  listCorps(): Promise<CorpSummary[]>;
  /** The one membership row for an account (any role, recruit included), or null. */
  membershipOf(accountId: string): Promise<CorpMembership | null>;
  membersOf(corpId: string): Promise<CorpMembership[]>;
  /** Atomic one-corp-per-account claim — the application insert. */
  addMember(
    corpId: string,
    accountId: string,
    login: string,
    role: CorpRole,
  ): Promise<{ ok: true } | { ok: false; code: 'E_IN_CORP' }>;
  setRole(corpId: string, accountId: string, role: CorpRole): Promise<void>;
  removeMember(corpId: string, accountId: string): Promise<void>;
  /** Transfer headship atomically: `from` (the head) → officer, `to` → head — never
   *  a window with zero or two heads. */
  swapHead(corpId: string, fromAccountId: string, toAccountId: string): Promise<void>;
  /** Disband: delete the corp and every membership row (audit history stays);
   *  AvA readiness flags of the corp and its players are cleared with it. */
  removeCorp(corpId: string): Promise<void>;
  /** Credit influence (AVA-2). `delta` must be positive — earning only; spending
   *  goes through the guarded `spendInfluence`. */
  addInfluence(corpId: string, delta: number): Promise<void>;
  /** Debit influence atomically (AVA-2): the check and the subtraction are one
   *  storage-level operation, so two racing spends can't overdraw the balance. */
  spendInfluence(
    corpId: string,
    cost: number,
  ): Promise<{ ok: true } | { ok: false; code: 'E_INSUFFICIENT' }>;
  /** AvA readiness (AVA-3): the head's corp-flag puts the corp into the ready pool. */
  setCorpReady(corpId: string, since: number): Promise<void>;
  clearCorpReady(corpId: string): Promise<void>;
  /** Ready-pool read-model: every corp-flagged corp (name + influence ride along). */
  listReadyCorps(): Promise<Array<CorpSummary & { readySince: number }>>;
  isCorpReady(corpId: string): Promise<boolean>;
  /** AvA readiness (AVA-3): a player's standing consent to offline deployment,
   *  bound to their CURRENT corp — leaving/kick/disband clears it. */
  setPlayerReady(accountId: string, corpId: string, since: number): Promise<void>;
  clearPlayerReady(accountId: string): Promise<void>;
  /** The corp's ready players (account ids), sorted for determinism. */
  readyPlayersOf(corpId: string): Promise<string[]>;
  appendAudit(entry: CorpAuditEntry): Promise<void>;
  /** Newest-first audit page. */
  auditOf(corpId: string, limit?: number): Promise<CorpAuditEntry[]>;
  close?(): Promise<void>;
}

/** AvA challenge statuses (AVA-4). `pending` is the only live state; every other
 *  status is terminal — transitions happen exactly once (atomic close). */
export type AvaChallengeStatus = 'pending' | 'accepted' | 'declined' | 'expired';

/** One S0→S2 challenge row (AVA-4). An ACCEPTED row IS the S2 matchup contract —
 *  the roster phase (AVA-6) builds on it. */
export interface AvaChallenge {
  id: string;
  challengerCorp: string;
  targetCorp: string;
  /** Influence spent by the challenger — refunded on decline/expiry. */
  cost: number;
  status: AvaChallengeStatus;
  createdAt: number;
  expiresAt: number;
}

/** Persistence for AvA challenges (AVA-4). Like CorpStore, deliberately dumb: the
 *  state machine lives in AvaService; the store guards the two invariants that need
 *  storage-level atomicity — ONE pending challenge per challenger→target pair, and
 *  exactly-once status transitions (the double-accept race). */
export interface AvaChallengeStore {
  /** Insert a pending challenge; fails atomically when the pair already has one. */
  createChallenge(
    challenge: AvaChallenge,
  ): Promise<{ ok: true } | { ok: false; code: 'E_ALREADY_CHALLENGED' }>;
  getChallenge(id: string): Promise<AvaChallenge | null>;
  /** Every challenge the corp is a party to (either side), newest first. */
  challengesOf(corpId: string, limit?: number): Promise<AvaChallenge[]>;
  /** Atomic pending→terminal transition. False = the row was NOT pending (already
   *  closed, or missing) and NOTHING changed — the caller must not refund twice. */
  closeChallenge(id: string, status: Exclude<AvaChallengeStatus, 'pending'>): Promise<boolean>;
  /** Pending challenges whose expiry is due at `now` (for the sweep). */
  duePending(now: number): Promise<AvaChallenge[]>;
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
