import { randomUUID } from 'node:crypto';
import type { ArsenalItem, PlayerId } from '@void/shared-core';
import type {
  AccountStore,
  ArsenalStore,
  AvaChallenge,
  AvaChallengeStore,
  AvaFeedEntry,
  AvaFeedStore,
  AvaResult,
  AvaResultStore,
  AvaRosterEntry,
  AvaRosterStore,
  AvaSession,
  AvaSessionStore,
  AvaSide,
  CommanderStore,
  CorpAuditEntry,
  CorpMembership,
  CorpRecord,
  CorpRent,
  CorpRentStore,
  CorpRole,
  CorpStore,
  CorpSummary,
  DropStore,
  MatchSnapshot,
  MatchStore,
  Medal,
  MedalStore,
  ReceiptStore,
  SeatAssignment,
  StoredReceipt,
  OwnedArsenalItem,
  UserRecord,
  UserStore,
} from './types';
import {
  DEFAULT_AUDIT_LIMIT,
  DEFAULT_FEED_LIMIT,
  DEFAULT_CHALLENGES_LIMIT,
  DEFAULT_LOCKED_MATCHUPS_LIMIT,
  DEFAULT_RESULTS_LIMIT,
} from './types';

/** In-memory match store — the default for dev/tests (a restart still loses the
 *  match; for durability use the Postgres adapter). Clones on save so the stored
 *  snapshot can't be mutated by the live room afterwards. */
export class MemoryMatchStore implements MatchStore {
  private readonly snaps = new Map<string, MatchSnapshot>();

  load(matchId: string): Promise<MatchSnapshot | null> {
    const snap = this.snaps.get(matchId);
    return Promise.resolve(snap ? clone(snap) : null);
  }

  save(snapshot: MatchSnapshot): Promise<void> {
    const prev = this.snaps.get(snapshot.matchId);
    if (!prev || snapshot.seq >= prev.seq) {
      this.snaps.set(snapshot.matchId, clone(snapshot)); // optimistic: keep the newest
    }
    return Promise.resolve();
  }

  ongoingMatchIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const snap of this.snaps.values()) if (snap.status !== 'ended') ids.push(snap.matchId);
    return Promise.resolve(ids);
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true); // no external dependency to be down
  }
}

/** In-memory seat map — `room → nick → side`. */
export class MemoryAccountStore implements AccountStore {
  private readonly rooms = new Map<string, Map<string, PlayerId>>();
  /** Seat-lock ticket hashes — `room → nick → sha256(ticket)` (REL-5). */
  private readonly tickets = new Map<string, Map<string, string>>();

  resolveSeat(
    room: string,
    nick: string,
    seats: readonly PlayerId[],
  ): Promise<SeatAssignment | null> {
    let byNick = this.rooms.get(room);
    if (!byNick) {
      byNick = new Map();
      this.rooms.set(room, byNick);
    }
    const existing = byNick.get(nick);
    if (existing) return Promise.resolve({ playerId: existing, isNew: false });
    const taken = new Set(byNick.values());
    const free = seats.find((s) => !taken.has(s));
    if (!free) return Promise.resolve(null); // room full
    byNick.set(nick, free);
    return Promise.resolve({ playerId: free, isNew: true });
  }

  seatOf(room: string, nick: string): Promise<PlayerId | null> {
    return Promise.resolve(this.rooms.get(room)?.get(nick) ?? null);
  }

  bindSeatTicket(room: string, nick: string, ticketHash: string): Promise<string | null> {
    if (!this.rooms.get(room)?.has(nick)) return Promise.resolve(null); // no seat → nothing to lock
    let byNick = this.tickets.get(room);
    if (!byNick) {
      byNick = new Map();
      this.tickets.set(room, byNick);
    }
    const existing = byNick.get(nick);
    if (existing !== undefined) return Promise.resolve(existing); // first bind wins
    byNick.set(nick, ticketHash);
    return Promise.resolve(ticketHash);
  }

  seatTicket(room: string, nick: string): Promise<string | null> {
    return Promise.resolve(this.tickets.get(room)?.get(nick) ?? null);
  }

  occupiedSeats(room: string): Promise<number> {
    return Promise.resolve(this.rooms.get(room)?.size ?? 0);
  }

  seatedNicks(room: string): Promise<Array<{ playerId: PlayerId; nick: string }>> {
    const byNick = this.rooms.get(room);
    if (!byNick) return Promise.resolve([]);
    return Promise.resolve([...byNick].map(([nick, playerId]) => ({ playerId, nick })));
  }
}

/** In-memory commander XP (EC-*): a lifetime-XP tally per account plus the set of
 *  already-credited matchIds for idempotency. Loses everything on restart — the
 *  Postgres store is the durable one; this serves tests and the no-DB dev run. */
export class MemoryCommanderStore implements CommanderStore {
  private readonly xp = new Map<string, number>();
  private readonly credited = new Set<string>();

  creditMatch(
    matchId: string,
    rows: ReadonlyArray<{ accountId: string; xp: number }>,
  ): Promise<boolean> {
    if (this.credited.has(matchId)) return Promise.resolve(false);
    this.credited.add(matchId);
    for (const { accountId, xp } of rows) {
      if (xp > 0) this.xp.set(accountId, (this.xp.get(accountId) ?? 0) + xp);
    }
    return Promise.resolve(true);
  }

  xpOf(accountId: string): Promise<number> {
    return Promise.resolve(this.xp.get(accountId) ?? 0);
  }
}

/** In-memory user store — accounts keyed by lower-cased login (case-insensitive). */
export class MemoryUserStore implements UserStore {
  private readonly byLogin = new Map<string, UserRecord>();

  createUser(
    login: string,
    passHash: string,
    email?: string,
  ): Promise<
    { ok: true; userId: string } | { ok: false; code: 'E_LOGIN_TAKEN' | 'E_EMAIL_TAKEN' }
  > {
    const key = login.toLowerCase();
    if (this.byLogin.has(key)) return Promise.resolve({ ok: false, code: 'E_LOGIN_TAKEN' });
    const mail = email?.toLowerCase();
    if (mail && this.byEmail(mail)) return Promise.resolve({ ok: false, code: 'E_EMAIL_TAKEN' });
    const userId = randomUUID();
    this.byLogin.set(key, { userId, login, passHash, ...(mail ? { email: mail } : {}) });
    return Promise.resolve({ ok: true, userId });
  }

  findUser(login: string): Promise<UserRecord | null> {
    return Promise.resolve(this.byLogin.get(login.toLowerCase()) ?? null);
  }

  findUserByEmail(email: string): Promise<UserRecord | null> {
    return Promise.resolve(this.byEmail(email.toLowerCase()));
  }

  findById(userId: string): Promise<UserRecord | null> {
    for (const rec of this.byLogin.values()) {
      if (rec.userId === userId) return Promise.resolve(rec);
    }
    return Promise.resolve(null);
  }

  setPassword(userId: string, passHash: string): Promise<void> {
    for (const rec of this.byLogin.values()) {
      if (rec.userId === userId) rec.passHash = passHash;
    }
    return Promise.resolve();
  }

  private byEmail(mail: string): UserRecord | null {
    for (const rec of this.byLogin.values()) if (rec.email === mail) return rec;
    return null;
  }
}

/** In-memory corp store — membership keyed by account (one corp per account). */
export class MemoryCorpStore implements CorpStore {
  private readonly corps = new Map<string, CorpRecord>();
  /** `accountId → membership` — the map key IS the one-corp-per-account invariant. */
  private readonly members = new Map<string, CorpMembership>();
  private readonly audit: CorpAuditEntry[] = [];
  /** AvA readiness (AVA-3): corp-flag `corpId → since`, player-flag `accountId → {corpId, since}`. */
  private readonly corpReady = new Map<string, number>();
  private readonly playerReady = new Map<string, { corpId: string; since: number }>();

  createCorp(
    name: string,
    headAccountId: string,
    headLogin: string,
  ): Promise<{ ok: true; corpId: string } | { ok: false; code: 'E_NAME_TAKEN' | 'E_IN_CORP' }> {
    const key = name.toLowerCase();
    for (const corp of this.corps.values()) {
      if (corp.name.toLowerCase() === key)
        return Promise.resolve({ ok: false, code: 'E_NAME_TAKEN' });
    }
    if (this.members.has(headAccountId)) return Promise.resolve({ ok: false, code: 'E_IN_CORP' });
    const corpId = randomUUID();
    this.corps.set(corpId, { corpId, name, influence: 0 });
    this.members.set(headAccountId, {
      corpId,
      accountId: headAccountId,
      login: headLogin,
      role: 'head',
    });
    return Promise.resolve({ ok: true, corpId });
  }

  getCorp(corpId: string): Promise<CorpRecord | null> {
    const corp = this.corps.get(corpId);
    return Promise.resolve(corp ? { ...corp } : null);
  }

  listCorps(): Promise<CorpSummary[]> {
    const list = [...this.corps.values()].map((corp) => ({
      ...corp,
      members: [...this.members.values()].filter(
        (m) => m.corpId === corp.corpId && m.role !== 'recruit',
      ).length,
    }));
    list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return Promise.resolve(list);
  }

  membershipOf(accountId: string): Promise<CorpMembership | null> {
    const row = this.members.get(accountId);
    return Promise.resolve(row ? { ...row } : null);
  }

  membersOf(corpId: string): Promise<CorpMembership[]> {
    return Promise.resolve(
      [...this.members.values()].filter((m) => m.corpId === corpId).map((m) => ({ ...m })),
    );
  }

  addMember(
    corpId: string,
    accountId: string,
    login: string,
    role: CorpRole,
  ): Promise<{ ok: true } | { ok: false; code: 'E_IN_CORP' }> {
    if (this.members.has(accountId)) return Promise.resolve({ ok: false, code: 'E_IN_CORP' });
    this.members.set(accountId, { corpId, accountId, login, role });
    return Promise.resolve({ ok: true });
  }

  setRole(corpId: string, accountId: string, role: CorpRole): Promise<void> {
    const row = this.members.get(accountId);
    if (row && row.corpId === corpId) row.role = role;
    return Promise.resolve();
  }

  removeMember(corpId: string, accountId: string): Promise<void> {
    const row = this.members.get(accountId);
    if (row && row.corpId === corpId) {
      this.members.delete(accountId);
      this.playerReady.delete(accountId); // leaving the corp revokes the consent (AVA-3)
    }
    return Promise.resolve();
  }

  swapHead(corpId: string, fromAccountId: string, toAccountId: string): Promise<void> {
    const from = this.members.get(fromAccountId);
    const to = this.members.get(toAccountId);
    if (!from || !to || from.corpId !== corpId || to.corpId !== corpId) return Promise.resolve();
    if (from.role !== 'head') return Promise.resolve();
    from.role = 'officer';
    to.role = 'head';
    return Promise.resolve();
  }

  removeCorp(corpId: string): Promise<void> {
    this.corps.delete(corpId);
    this.corpReady.delete(corpId);
    for (const [accountId, row] of this.members) {
      if (row.corpId === corpId) {
        this.members.delete(accountId);
        this.playerReady.delete(accountId);
      }
    }
    return Promise.resolve();
  }

  addInfluence(corpId: string, delta: number): Promise<void> {
    const corp = this.corps.get(corpId);
    if (corp && delta > 0) corp.influence += delta;
    return Promise.resolve();
  }

  spendInfluence(
    corpId: string,
    cost: number,
  ): Promise<{ ok: true } | { ok: false; code: 'E_INSUFFICIENT' }> {
    const corp = this.corps.get(corpId);
    if (!corp || cost <= 0 || corp.influence < cost) {
      return Promise.resolve({ ok: false, code: 'E_INSUFFICIENT' });
    }
    corp.influence -= cost;
    return Promise.resolve({ ok: true });
  }

  setCorpReady(corpId: string, since: number): Promise<void> {
    if (this.corps.has(corpId) && !this.corpReady.has(corpId)) this.corpReady.set(corpId, since);
    return Promise.resolve();
  }

  clearCorpReady(corpId: string): Promise<void> {
    this.corpReady.delete(corpId);
    return Promise.resolve();
  }

  async listReadyCorps(): Promise<Array<CorpSummary & { readySince: number }>> {
    const all = await this.listCorps();
    return all
      .filter((c) => this.corpReady.has(c.corpId))
      .map((c) => ({ ...c, readySince: this.corpReady.get(c.corpId)! }));
  }

  isCorpReady(corpId: string): Promise<boolean> {
    return Promise.resolve(this.corpReady.has(corpId));
  }

  setPlayerReady(accountId: string, corpId: string, since: number): Promise<void> {
    const existing = this.playerReady.get(accountId);
    this.playerReady.set(accountId, existing?.corpId === corpId ? existing : { corpId, since });
    return Promise.resolve();
  }

  clearPlayerReady(accountId: string): Promise<void> {
    this.playerReady.delete(accountId);
    return Promise.resolve();
  }

  readyPlayersOf(corpId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.playerReady.entries()]
        .filter(([, v]) => v.corpId === corpId)
        .map(([accountId]) => accountId)
        .sort(),
    );
  }

  appendAudit(entry: CorpAuditEntry): Promise<void> {
    this.audit.push({ ...entry });
    return Promise.resolve();
  }

  auditOf(corpId: string, limit = DEFAULT_AUDIT_LIMIT): Promise<CorpAuditEntry[]> {
    const rows = this.audit.filter((e) => e.corpId === corpId);
    return Promise.resolve(
      rows
        .slice(-limit)
        .reverse()
        .map((e) => ({ ...e })),
    );
  }
}

/** In-memory AvA challenge store (AVA-4) — a map plus the two structural
 *  invariants: one pending per challenger→target pair, exactly-once close. */
export class MemoryAvaChallengeStore implements AvaChallengeStore {
  private readonly rows = new Map<string, AvaChallenge>();

  createChallenge(
    challenge: AvaChallenge,
  ): Promise<{ ok: true } | { ok: false; code: 'E_ALREADY_CHALLENGED' }> {
    for (const row of this.rows.values()) {
      if (
        row.status === 'pending' &&
        row.challengerCorp === challenge.challengerCorp &&
        row.targetCorp === challenge.targetCorp
      ) {
        return Promise.resolve({ ok: false, code: 'E_ALREADY_CHALLENGED' });
      }
    }
    this.rows.set(challenge.id, { ...challenge });
    return Promise.resolve({ ok: true });
  }

  getChallenge(id: string): Promise<AvaChallenge | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  challengesOf(corpId: string, limit = DEFAULT_CHALLENGES_LIMIT): Promise<AvaChallenge[]> {
    const mine = [...this.rows.values()]
      .filter((r) => r.challengerCorp === corpId || r.targetCorp === corpId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
    return Promise.resolve(mine.slice(0, limit).map((r) => ({ ...r })));
  }

  closeChallenge(id: string, status: 'accepted' | 'declined' | 'expired'): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return Promise.resolve(false);
    row.status = status;
    return Promise.resolve(true);
  }

  duePending(now: number): Promise<AvaChallenge[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.status === 'pending' && r.expiresAt <= now)
        .sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : 1))
        .map((r) => ({ ...r })),
    );
  }

  openRosterWindow(id: string, pauseEndsAt: number): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.status === 'accepted') row.pauseEndsAt = pauseEndsAt;
    return Promise.resolve();
  }

  closeMatchup(id: string, status: 'locked' | 'cancelled'): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'accepted') return Promise.resolve(false);
    row.status = status;
    return Promise.resolve(true);
  }

  dueRosters(now: number): Promise<AvaChallenge[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.status === 'accepted' && r.pauseEndsAt !== undefined && r.pauseEndsAt <= now)
        .sort((a, b) => (a.pauseEndsAt ?? 0) - (b.pauseEndsAt ?? 0) || (a.id < b.id ? -1 : 1))
        .map((r) => ({ ...r })),
    );
  }

  lockedMatchups(limit = DEFAULT_LOCKED_MATCHUPS_LIMIT): Promise<AvaChallenge[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.status === 'locked')
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }

  endMatchup(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'locked') return Promise.resolve(false);
    row.status = 'ended';
    return Promise.resolve(true);
  }
}

/** In-memory AvA result store (AVA-8) — `matchupId → result`, keyed idempotently. */
export class MemoryAvaResultStore implements AvaResultStore {
  private readonly rows = new Map<string, AvaResult>();

  record(result: AvaResult): Promise<void> {
    // The locked→ended transition guarantees one call per matchup; keep the first
    // write should it ever be called twice (idempotent by matchupId).
    if (!this.rows.has(result.matchupId)) this.rows.set(result.matchupId, { ...result });
    return Promise.resolve();
  }

  get(matchupId: string): Promise<AvaResult | null> {
    const row = this.rows.get(matchupId);
    return Promise.resolve(row ? { ...row } : null);
  }

  recent(limit = DEFAULT_RESULTS_LIMIT): Promise<AvaResult[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .sort((a, b) => b.at - a.at || (a.matchupId < b.matchupId ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }

  statsForCorp(corpId: string): Promise<{ matches: number; wins: number }> {
    let matches = 0;
    let wins = 0;
    for (const r of this.rows.values()) {
      if (r.challengerCorp === corpId || r.targetCorp === corpId) matches += 1;
      if (r.winnerCorp === corpId) wins += 1;
    }
    return Promise.resolve({ matches, wins });
  }
}

/** In-memory medal store (MED-1) — `accountId → medalId → medal`; the nested key is the
 *  one-per-(account,medal) idempotency invariant. */
export class MemoryMedalStore implements MedalStore {
  private readonly byAccount = new Map<string, Map<string, Medal>>();

  grant(medal: Medal): Promise<boolean> {
    let mine = this.byAccount.get(medal.accountId);
    if (!mine) {
      mine = new Map();
      this.byAccount.set(medal.accountId, mine);
    }
    if (mine.has(medal.medalId)) return Promise.resolve(false); // already earned — no dup
    mine.set(medal.medalId, { ...medal });
    return Promise.resolve(true);
  }

  has(accountId: string, medalId: string): Promise<boolean> {
    return Promise.resolve(this.byAccount.get(accountId)?.has(medalId) ?? false);
  }

  medalsOf(accountId: string): Promise<Medal[]> {
    return Promise.resolve(
      [...(this.byAccount.get(accountId)?.values() ?? [])]
        .sort((a, b) => b.at - a.at || (a.medalId < b.medalId ? -1 : 1))
        .map((m) => ({ ...m })),
    );
  }
}

/** In-memory AvA feed store (AVA-9) — an append-only list, read newest-first. */
export class MemoryAvaFeedStore implements AvaFeedStore {
  private readonly rows: AvaFeedEntry[] = [];

  append(entry: AvaFeedEntry): Promise<void> {
    this.rows.push({ ...entry });
    return Promise.resolve();
  }

  recent(limit = DEFAULT_FEED_LIMIT, before?: number): Promise<AvaFeedEntry[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => before === undefined || r.at < before)
        .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }
}

/** In-memory AvA session store (AVA-7) — `matchId → session`, with a secondary index by
 *  matchup so `create` can enforce one session per matchup as well as per match. */
export class MemoryAvaSessionStore implements AvaSessionStore {
  private readonly byMatchId = new Map<string, AvaSession>();
  private readonly byMatchupId = new Map<string, AvaSession>();

  create(session: AvaSession): Promise<{ ok: true } | { ok: false; code: 'E_SESSION_EXISTS' }> {
    if (this.byMatchId.has(session.matchId) || this.byMatchupId.has(session.matchupId)) {
      return Promise.resolve({ ok: false, code: 'E_SESSION_EXISTS' });
    }
    const row: AvaSession = { ...session, seats: { ...session.seats } };
    this.byMatchId.set(session.matchId, row);
    this.byMatchupId.set(session.matchupId, row);
    return Promise.resolve({ ok: true });
  }

  byMatch(matchId: string): Promise<AvaSession | null> {
    const row = this.byMatchId.get(matchId);
    return Promise.resolve(row ? { ...row, seats: { ...row.seats } } : null);
  }

  byMatchup(matchupId: string): Promise<AvaSession | null> {
    const row = this.byMatchupId.get(matchupId);
    return Promise.resolve(row ? { ...row, seats: { ...row.seats } } : null);
  }

  dueWar(now: number): Promise<AvaSession[]> {
    return Promise.resolve(
      [...this.byMatchId.values()]
        .filter((r) => r.warAt !== undefined && r.warAt <= now && r.warDeclaredAt === undefined)
        .sort((a, b) => (a.warAt ?? 0) - (b.warAt ?? 0) || (a.matchId < b.matchId ? -1 : 1))
        .map((r) => ({ ...r, seats: { ...r.seats } })),
    );
  }

  markWarDeclared(matchId: string, at: number): Promise<boolean> {
    const row = this.byMatchId.get(matchId);
    if (!row || row.warAt === undefined || row.warDeclaredAt !== undefined) {
      return Promise.resolve(false);
    }
    row.warDeclaredAt = at;
    return Promise.resolve(true);
  }
}

/** In-memory AvA roster store (AVA-6) — `matchupId → accountId → entry`, plus the
 *  two structural invariants: one row per (matchup, account), guarded per-side cap. */
export class MemoryAvaRosterStore implements AvaRosterStore {
  private readonly byMatchup = new Map<string, Map<string, AvaRosterEntry>>();

  addEntry(
    entry: AvaRosterEntry,
    capPerSide: number,
  ): Promise<{ ok: true } | { ok: false; code: 'E_ALREADY_ROSTERED' | 'E_ROSTER_FULL' }> {
    let rows = this.byMatchup.get(entry.matchupId);
    if (!rows) {
      rows = new Map();
      this.byMatchup.set(entry.matchupId, rows);
    }
    if (rows.has(entry.accountId)) {
      return Promise.resolve({ ok: false, code: 'E_ALREADY_ROSTERED' });
    }
    const onSide = [...rows.values()].filter((r) => r.side === entry.side).length;
    if (onSide >= capPerSide) return Promise.resolve({ ok: false, code: 'E_ROSTER_FULL' });
    rows.set(entry.accountId, { ...entry });
    return Promise.resolve({ ok: true });
  }

  replaceSide(matchupId: string, side: AvaSide, entries: AvaRosterEntry[]): Promise<void> {
    let rows = this.byMatchup.get(matchupId);
    if (!rows) {
      rows = new Map();
      this.byMatchup.set(matchupId, rows);
    }
    for (const [accountId, row] of rows) {
      if (row.side === side) rows.delete(accountId);
    }
    for (const entry of entries) rows.set(entry.accountId, { ...entry });
    return Promise.resolve();
  }

  rosterOf(matchupId: string): Promise<AvaRosterEntry[]> {
    return Promise.resolve(
      [...(this.byMatchup.get(matchupId)?.values() ?? [])]
        .sort((a, b) => (a.side < b.side ? -1 : a.side > b.side ? 1 : a.accountId < b.accountId ? -1 : 1))
        .map((r) => ({ ...r })),
    );
  }
}

/** In-memory receipt store — `matchId → actionId → receipt`. */
export class MemoryReceiptStore implements ReceiptStore {
  private readonly byMatch = new Map<string, Map<string, StoredReceipt>>();

  loadAll(matchId: string): Promise<StoredReceipt[]> {
    return Promise.resolve([...(this.byMatch.get(matchId)?.values() ?? [])]);
  }

  save(matchId: string, receipt: StoredReceipt): Promise<void> {
    let m = this.byMatch.get(matchId);
    if (!m) {
      m = new Map();
      this.byMatch.set(matchId, m);
    }
    if (!m.has(receipt.actionId)) m.set(receipt.actionId, receipt); // receipts are immutable
    return Promise.resolve();
  }
}

/** In-memory arsenal store (ARS-2) — `itemId → owned item`, plus the structural
 *  invariants: idempotent grant (first write wins), owner-guarded transfer/consume,
 *  soulbound never transfers. */
export class MemoryArsenalStore implements ArsenalStore {
  private readonly items = new Map<string, OwnedArsenalItem>();

  grant(item: OwnedArsenalItem): Promise<void> {
    if (!this.items.has(item.itemId)) this.items.set(item.itemId, { ...item });
    return Promise.resolve();
  }

  get(itemId: string): Promise<OwnedArsenalItem | null> {
    const row = this.items.get(itemId);
    return Promise.resolve(row ? { ...row } : null);
  }

  listOf(accountId: string): Promise<ArsenalItem[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter((r) => r.accountId === accountId)
        .sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            a.defId.localeCompare(b.defId) ||
            a.itemId.localeCompare(b.itemId),
        )
        .map(({ accountId: _owner, ...item }) => ({ ...item })),
    );
  }

  transfer(
    itemId: string,
    from: string,
    to: string,
  ): Promise<{ ok: true } | { ok: false; code: 'E_NOT_OWNER' | 'E_SOULBOUND' }> {
    const row = this.items.get(itemId);
    if (!row || row.accountId !== from) return Promise.resolve({ ok: false, code: 'E_NOT_OWNER' });
    if (row.soulbound) return Promise.resolve({ ok: false, code: 'E_SOULBOUND' });
    row.accountId = to;
    return Promise.resolve({ ok: true });
  }

  consume(itemId: string, accountId: string): Promise<boolean> {
    const row = this.items.get(itemId);
    if (!row || row.accountId !== accountId) return Promise.resolve(false);
    this.items.delete(itemId);
    return Promise.resolve(true);
  }

  wear(itemId: string, by: number): Promise<{ durability?: number } | null> {
    const row = this.items.get(itemId);
    if (!row) return Promise.resolve(null);
    if (row.durability === undefined) return Promise.resolve({ durability: undefined });
    row.durability = Math.max(0, row.durability - by);
    return Promise.resolve({ durability: row.durability });
  }
}

/** In-memory corp-arsenal rental store (ARS-6): one item on rent to at most one war
 *  at a time, an exactly-once close per (matchup, item). */
export class MemoryCorpRentStore implements CorpRentStore {
  private readonly active = new Map<string, CorpRent>(); // itemId -> row

  rent(entry: CorpRent): Promise<boolean> {
    if (this.active.has(entry.itemId)) return Promise.resolve(false);
    this.active.set(entry.itemId, { ...entry });
    return Promise.resolve(true);
  }

  activeForMatchup(matchupId: string): Promise<CorpRent[]> {
    return Promise.resolve(
      [...this.active.values()].filter((r) => r.matchupId === matchupId).map((r) => ({ ...r })),
    );
  }

  activeForAccount(matchupId: string, accountId: string): Promise<CorpRent[]> {
    return Promise.resolve(
      [...this.active.values()]
        .filter((r) => r.matchupId === matchupId && r.accountId === accountId)
        .map((r) => ({ ...r })),
    );
  }

  closeRent(matchupId: string, itemId: string): Promise<boolean> {
    const row = this.active.get(itemId);
    if (!row || row.matchupId !== matchupId) return Promise.resolve(false);
    this.active.delete(itemId);
    return Promise.resolve(true);
  }
}

/** In-memory drop-loop store (ARS-4): exactly-once per-(match, account) roll claims,
 *  the pity counter and the salvage-shard balance. */
export class MemoryDropStore implements DropStore {
  private readonly claims = new Set<string>();
  private readonly pity = new Map<string, number>();
  private readonly shards = new Map<string, number>();

  claim(matchId: string, accountId: string): Promise<boolean> {
    const key = `${matchId} ${accountId}`;
    if (this.claims.has(key)) return Promise.resolve(false);
    this.claims.add(key);
    return Promise.resolve(true);
  }

  pityOf(accountId: string): Promise<number> {
    return Promise.resolve(this.pity.get(accountId) ?? 0);
  }

  setPity(accountId: string, value: number): Promise<void> {
    this.pity.set(accountId, value);
    return Promise.resolve();
  }

  addShards(accountId: string, delta: number): Promise<void> {
    this.shards.set(accountId, (this.shards.get(accountId) ?? 0) + delta);
    return Promise.resolve();
  }

  shardsOf(accountId: string): Promise<number> {
    return Promise.resolve(this.shards.get(accountId) ?? 0);
  }
}

// GameState is JSON-serializable by invariant, so a JSON round-trip is a safe clone.
function clone(snap: MatchSnapshot): MatchSnapshot {
  return JSON.parse(JSON.stringify(snap)) as MatchSnapshot;
}
