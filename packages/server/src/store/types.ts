import type { ArsenalItem, GameState, PlayerId } from '@void/shared-core';

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
    | 'ready'
    | 'medal'
    | 'rent'
    | 'rent_return';
  /** Subject account id, when the action has one. */
  target?: string;
  /** Extra context, e.g. the new role for `role`. */
  detail?: string;
}

/** Persistence for corporations (CORP-0). Deliberately dumb CRUD — the rights matrix
 *  lives in `CorpService`; the store guards only the STRUCTURAL invariants that need
 *  storage-level atomicity: unique corp name (case-insensitive) and one corp per
 *  account. */
/** Default page sizes for the bounded list reads — part of the store CONTRACT
 *  (both adapters import these), so memory and Postgres can't silently diverge. */
export const DEFAULT_AUDIT_LIMIT = 50;
export const DEFAULT_CHALLENGES_LIMIT = 50;
export const DEFAULT_LOCKED_MATCHUPS_LIMIT = 100;
export const DEFAULT_RESULTS_LIMIT = 50;
export const DEFAULT_FEED_LIMIT = 50;

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

/** AvA challenge statuses. AVA-4: `pending` → `accepted` (S2 matchup) / `declined` /
 *  `expired` — the pending→terminal transition happens exactly once (atomic close).
 *  AVA-6 extends the machine past S2: an `accepted` matchup runs its roster window and
 *  transitions exactly once to `locked` (roster frozen — the orchestrator's S4 input)
 *  or `cancelled` (a side came up short — challenge cost refunded). AVA-8 closes the
 *  lifecycle: a `locked` matchup whose war has ended transitions exactly once to
 *  `ended` (S7 archive — the outcome is recorded and influence awarded). */
export type AvaChallengeStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'locked'
  | 'cancelled'
  | 'ended';

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
  /** Roster window deadline (AVA-6), stamped when the challenge is ACCEPTED: both
   *  sides gather their roster until this instant, then the sweep locks or cancels.
   *  Absent on rows accepted before AVA-6 — treated as a closed window (fail-secure). */
  pauseEndsAt?: number;
}

/** Which party of a matchup an account fights for (AVA-6). */
export type AvaSide = 'challenger' | 'target';

/** One roster row (AVA-6): an account committed to a side of a matchup. `source`
 *  records HOW they got in — curated from the flagged pool (`flagged`, set by the
 *  head/officer) or self-enrolled during the pause window (`self`). */
export interface AvaRosterEntry {
  matchupId: string;
  accountId: string;
  side: AvaSide;
  source: 'flagged' | 'self';
  at: number;
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
  closeChallenge(id: string, status: 'accepted' | 'declined' | 'expired'): Promise<boolean>;
  /** Pending challenges whose expiry is due at `now` (for the sweep). */
  duePending(now: number): Promise<AvaChallenge[]>;
  /** AVA-6: stamp the roster window deadline on an ACCEPTED matchup (right after the
   *  accept wins its close race — S3 opens at S2). No-op on any other status. */
  openRosterWindow(id: string, pauseEndsAt: number): Promise<void>;
  /** AVA-6: atomic accepted→terminal transition of the roster phase (`locked` /
   *  `cancelled`). False = the row was NOT accepted and NOTHING changed — the same
   *  exactly-once contract as `closeChallenge` (the caller must not refund twice). */
  closeMatchup(id: string, status: 'locked' | 'cancelled'): Promise<boolean>;
  /** Accepted matchups whose roster window is due at `now` (for the roster sweep). */
  dueRosters(now: number): Promise<AvaChallenge[]>;
  /** AVA-7: every LOCKED matchup (roster frozen), newest first — the orchestrator sweep
   *  reads these and raises a session for each one that has none yet. */
  lockedMatchups(limit?: number): Promise<AvaChallenge[]>;
  /** AVA-8: atomic locked→ended transition (S7 archive). False = the row was NOT
   *  locked and NOTHING changed — the exactly-once gate for settlement, so a replayed
   *  `match.ended` can't award influence twice. */
  endMatchup(id: string): Promise<boolean>;
  close?(): Promise<void>;
}

/** One recorded AvA outcome (AVA-8, MM-3.1 minimum: who fought whom, who won, when).
 *  The foundation the public feed (AVA-9), medal conditions (corporations.md §3) and
 *  rating read from. `winnerCorp` is null for a draw / no winner. */
export interface AvaResult {
  matchupId: string;
  challengerCorp: string;
  targetCorp: string;
  winnerCorp: string | null;
  at: number;
}

/** Persistence for AvA results (AVA-8). One row per matchup — the matchup's exactly-once
 *  locked→ended transition is the primary write gate, so `record` is a plain append;
 *  the PK makes it idempotent belt-and-braces. Newest-first reads feed history/rating. */
export interface AvaResultStore {
  record(result: AvaResult): Promise<void>;
  get(matchupId: string): Promise<AvaResult | null>;
  /** Recorded outcomes, newest first (bounded by `limit`). */
  recent(limit?: number): Promise<AvaResult[]>;
  /** AVA / medals (MED-1): a corp's aggregate AvA record — matches it fought (as either
   *  side) and matches it won. The objective source medal conditions (corporations.md §3)
   *  are checked against — server-side, never in the deterministic core. */
  statsForCorp(corpId: string): Promise<{ matches: number; wins: number }>;
  close?(): Promise<void>;
}

/** One earned medal/achievement (corporations.md §3, MED-1) — a PERMANENT account record.
 *  Corp medals snapshot the corp they were earned with (`corpId`) so a medal still reads
 *  "earned with X" after the player leaves. In MVP medals are never revoked, and a grant is
 *  idempotent (one row per (account, medal)). */
export interface Medal {
  accountId: string;
  medalId: string;
  corpId: string | null;
  at: number;
}

/** Persistence for earned medals (MED-1). The PK (account, medal) is the idempotency +
 *  permanence invariant: one row per (account, medal), never a duplicate, never removed. */
export interface MedalStore {
  /** Idempotent grant: false = the account already holds this medal (nothing changed). */
  grant(medal: Medal): Promise<boolean>;
  has(accountId: string, medalId: string): Promise<boolean>;
  /** Every medal an account has earned, newest first. */
  medalsOf(accountId: string): Promise<Medal[]>;
  close?(): Promise<void>;
}

/** One public AvA feed entry (AVA-9): a confirmed matchup (S2, on accept) or its result
 *  (S7, on settlement). PUBLIC facts only — corp names + winner, NEVER the private roster.
 *  Corp names are snapshotted at publish so the feed reads standalone (a later rename or
 *  disband doesn't rewrite history). `winnerCorp` is set on a `result` (null = draw). */
export type AvaFeedKind = 'matchup' | 'result';
export interface AvaFeedEntry {
  id: string;
  at: number;
  kind: AvaFeedKind;
  challengerCorp: string;
  challengerName: string;
  targetCorp: string;
  targetName: string;
  /** `result` only: winning corp id, or null for a draw. */
  winnerCorp?: string | null;
}

/** Persistence for the public AvA feed (AVA-9). Append-only; read newest-first with a
 *  simple `before`-`at` cursor for pagination. No private data ever enters it. */
export interface AvaFeedStore {
  append(entry: AvaFeedEntry): Promise<void>;
  /** Newest-first page (bounded by `limit`); `before` = an `at` cursor (exclusive). */
  recent(limit?: number, before?: number): Promise<AvaFeedEntry[]>;
  close?(): Promise<void>;
}

/** One raised AvA session (AVA-7) — the link a locked matchup gets once the orchestrator
 *  builds a live match from its roster: which match instance runs it (`matchId`), on which
 *  map, and the fixed seating (`seats`: accountId → the concrete `playerId`/slot the account
 *  plays). `seats` is what `resolveAvaSeat` reads to sit each account in THEIR slot (not a
 *  first-free seat); bot-filled empty slots are not in it. */
export interface AvaSession {
  matchId: string;
  matchupId: string;
  mapId: string;
  seats: Record<string, string>;
  at: number;
  /** When the S5 peace period ends and the orchestrator declares the war (AVA-8, S6).
   *  Stamped at session creation (`at + peaceMs`); absent on pre-S6 rows — such a
   *  session never enters the war queue (fail-secure: no surprise escalation). */
  warAt?: number;
  /** When the war was actually declared — the exactly-once marker the war sweep sets
   *  (`markWarDeclared`); absent = still at peace. */
  warDeclaredAt?: number;
}

/** Persistence for AvA sessions (AVA-7). One row per matchup (unique `matchupId`) and per
 *  instance (PK `matchId`) — the orchestrator raises exactly one session per locked matchup;
 *  `create` fails atomically if either already exists so a re-run never double-builds. */
export interface AvaSessionStore {
  create(
    session: AvaSession,
  ): Promise<{ ok: true } | { ok: false; code: 'E_SESSION_EXISTS' }>;
  byMatch(matchId: string): Promise<AvaSession | null>;
  byMatchup(matchupId: string): Promise<AvaSession | null>;
  /** AVA-8 (S6): sessions whose peace period is over (`warAt` ≤ now) and whose war has
   *  not been declared yet — the war sweep's queue. Rows without `warAt` never appear. */
  dueWar(now: number): Promise<AvaSession[]>;
  /** AVA-8 (S6): stamp the war as declared — exactly once (false when already stamped
   *  or the session has no war schedule; nothing changes on a lost race). */
  markWarDeclared(matchId: string, at: number): Promise<boolean>;
  close?(): Promise<void>;
}

/** Persistence for AvA rosters (AVA-6). The store guards the two invariants that need
 *  storage-level atomicity: one roster row per (matchup, account), and the per-side
 *  cap — a guarded insert can never push a side past `capPerSide` (two racing joins
 *  must not overfill the last slot). The window/lock rules live in `AvaService`. */
export interface AvaRosterStore {
  /** Guarded insert: fails when the account is already rostered in this matchup or
   *  the side is at `capPerSide`. Atomic — the count check and the insert are one
   *  storage-level operation. */
  addEntry(
    entry: AvaRosterEntry,
    capPerSide: number,
  ): Promise<{ ok: true } | { ok: false; code: 'E_ALREADY_ROSTERED' | 'E_ROSTER_FULL' }>;
  /** Replace one side's roster wholesale (the head/officer's curated list). The new
   *  list must already be validated by the service (flagged + within the cap). */
  replaceSide(matchupId: string, side: AvaSide, entries: AvaRosterEntry[]): Promise<void>;
  /** Every roster row of a matchup, sorted (side, then account) for determinism. */
  rosterOf(matchupId: string): Promise<AvaRosterEntry[]>;
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

/** One owned arsenal row (ARS-2): the shared `ArsenalItem` contract (ARS-1,
 *  `shared-core/data/arsenalSchema.ts`) plus its owner. */
export interface OwnedArsenalItem extends ArsenalItem {
  accountId: string;
}

/** Persistence for the personal arsenal (ARS-2, `arsenal-roadmap.md`) — what an
 *  account owns BETWEEN sessions. Deliberately dumb like the other stores: policy
 *  (starter set, trade rules, snapshots) lives above; the store guards only the
 *  invariants that need storage-level atomicity:
 *   - `grant` is idempotent by `itemId` (first write wins — a replayed grant, e.g.
 *     a re-registration or a retried drop batch, can never duplicate an item);
 *   - `transfer`/`consume` are owner-guarded conditional writes — two racing buyers
 *     of one instance cannot both win (double-sell impossible), and a SOULBOUND
 *     item never transfers (anti-RMT, GDD §4.4 — enforced structurally, not just
 *     by the trade service). */
export interface ArsenalStore {
  /** Insert the item unless its `itemId` already exists (idempotent, first wins). */
  grant(item: OwnedArsenalItem): Promise<void>;
  get(itemId: string): Promise<OwnedArsenalItem | null>;
  /** The account's items, sorted (kind, defId, itemId) for determinism. */
  listOf(accountId: string): Promise<ArsenalItem[]>;
  /** Atomic ownership move: succeeds only while `from` CURRENTLY owns the item and
   *  it is not soulbound. A lost race / wrong owner / soulbound changes nothing. */
  transfer(
    itemId: string,
    from: string,
    to: string,
  ): Promise<{ ok: true } | { ok: false; code: 'E_NOT_OWNER' | 'E_SOULBOUND' }>;
  /** Atomic removal (craft input / burn): only the current owner's item goes;
   *  false = not owned (nothing changed). */
  consume(itemId: string, accountId: string): Promise<boolean>;
  /** Atomic wear: decrements an INSTANCE's `durability` by `by` (clamped at 0). A
   *  no-op returning the item's current (unchanged) durability for a blueprint (no
   *  durability field — ARS-0.1) or an item with none set. `null` only if the item
   *  doesn't exist. The corp-rental return sink (ARS-6) is the first caller; any
   *  future repair/wear mechanic shares this one guarded write. */
  wear(itemId: string, by: number): Promise<{ durability?: number } | null>;
  close?(): Promise<void>;
}

/** One active corp-warehouse rental (ARS-6): a corp-owned item (`corp_arsenal` —
 *  literally the same `ArsenalStore`, keyed by `corpId` as the "owner") lent to a
 *  ROSTERED fighter for exactly one war. Ownership never moves (no `transfer`) —
 *  this row is the only record that it's currently in someone's hands; the item
 *  reverts to the corp automatically once the row closes (war end). */
export interface CorpRent {
  itemId: string;
  corpId: string;
  matchupId: string;
  accountId: string;
  rentedAt: number;
}

/** Persistence for corp-arsenal rentals (ARS-6). Deliberately dumb like the other
 *  stores: RBAC (head/officer), roster membership and the ARS-3 snapshot merge live
 *  in the service; the store guards the two invariants that need storage-level
 *  atomicity — an item is on rent to AT MOST ONE war at a time, and a war's return
 *  sweep closes each rental EXACTLY ONCE (the same exactly-once contract as
 *  `AvaChallengeStore.endMatchup` — the caller must not apply the durability sink
 *  twice on a replayed match-end). */
export interface CorpRentStore {
  /** Atomic: creates the row only if this item has no currently-active rental
   *  anywhere (including other matchups) — false = already on rent, nothing
   *  changed. */
  rent(entry: CorpRent): Promise<boolean>;
  /** Every still-active rental for a matchup (war-end return-all sweep reads this). */
  activeForMatchup(matchupId: string): Promise<CorpRent[]>;
  /** This account's active rentals for a matchup (the ARS-3 snapshot merge point). */
  activeForAccount(matchupId: string, accountId: string): Promise<CorpRent[]>;
  /** Atomic active→closed transition for one (matchupId, itemId). False = it was NOT
   *  active (already closed, or never rented) — nothing changed, so the caller must
   *  not apply the durability sink. */
  closeRent(matchupId: string, itemId: string): Promise<boolean>;
  close?(): Promise<void>;
}

/** Persistence for the F2P drop loop (ARS-4): the per-account pity counter (drop
 *  guaranteed within K dry matches — no black streaks) and the salvage-shard balance
 *  (the EC-2.2 craft input). Like the other stores, policy (roll chances, tables)
 *  lives above; the store guards the invariants that need storage-level atomicity:
 *   - `claim` is the exactly-once gate per (match, account) — a replayed match end
 *     can never roll (or bump pity for) the same account twice;
 *   - `addShards` is an atomic increment (concurrent battle credits both land). */
export interface DropStore {
  /** First-writer-wins marker for one account's roll in one match: true = this call
   *  claimed it (proceed to roll), false = already claimed (a replay — do nothing). */
  claim(matchId: string, accountId: string): Promise<boolean>;
  /** The account's current dry streak (matches since the last drop). 0 when unknown. */
  pityOf(accountId: string): Promise<number>;
  setPity(accountId: string, value: number): Promise<void>;
  /** Credit salvage shards — `delta` must be positive (earning only). */
  addShards(accountId: string, delta: number): Promise<void>;
  shardsOf(accountId: string): Promise<number>;
  close?(): Promise<void>;
}
