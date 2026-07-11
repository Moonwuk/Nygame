import { randomUUID } from 'node:crypto';
import type { PlayerId } from '@void/shared-core';
import type {
  AccountStore,
  CorpAuditEntry,
  CorpMembership,
  CorpRecord,
  CorpRole,
  CorpStore,
  CorpSummary,
  MatchSnapshot,
  MatchStore,
  ReceiptStore,
  SeatAssignment,
  StoredReceipt,
  UserRecord,
  UserStore,
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
}

/** In-memory user store — accounts keyed by lower-cased login (case-insensitive). */
export class MemoryUserStore implements UserStore {
  private readonly byLogin = new Map<string, UserRecord>();

  createUser(
    login: string,
    passHash: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; code: 'E_LOGIN_TAKEN' }> {
    const key = login.toLowerCase();
    if (this.byLogin.has(key)) return Promise.resolve({ ok: false, code: 'E_LOGIN_TAKEN' });
    const userId = randomUUID();
    this.byLogin.set(key, { userId, login, passHash });
    return Promise.resolve({ ok: true, userId });
  }

  findUser(login: string): Promise<UserRecord | null> {
    return Promise.resolve(this.byLogin.get(login.toLowerCase()) ?? null);
  }
}

/** In-memory corp store — membership keyed by account (one corp per account). */
export class MemoryCorpStore implements CorpStore {
  private readonly corps = new Map<string, CorpRecord>();
  /** `accountId → membership` — the map key IS the one-corp-per-account invariant. */
  private readonly members = new Map<string, CorpMembership>();
  private readonly audit: CorpAuditEntry[] = [];

  createCorp(
    name: string,
    headAccountId: string,
    headLogin: string,
  ): Promise<{ ok: true; corpId: string } | { ok: false; code: 'E_NAME_TAKEN' | 'E_IN_CORP' }> {
    const key = name.toLowerCase();
    for (const corp of this.corps.values()) {
      if (corp.name.toLowerCase() === key) return Promise.resolve({ ok: false, code: 'E_NAME_TAKEN' });
    }
    if (this.members.has(headAccountId)) return Promise.resolve({ ok: false, code: 'E_IN_CORP' });
    const corpId = randomUUID();
    this.corps.set(corpId, { corpId, name });
    this.members.set(headAccountId, { corpId, accountId: headAccountId, login: headLogin, role: 'head' });
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
    if (row && row.corpId === corpId) this.members.delete(accountId);
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
    for (const [accountId, row] of this.members) {
      if (row.corpId === corpId) this.members.delete(accountId);
    }
    return Promise.resolve();
  }

  appendAudit(entry: CorpAuditEntry): Promise<void> {
    this.audit.push({ ...entry });
    return Promise.resolve();
  }

  auditOf(corpId: string, limit = 50): Promise<CorpAuditEntry[]> {
    const rows = this.audit.filter((e) => e.corpId === corpId);
    return Promise.resolve(rows.slice(-limit).reverse().map((e) => ({ ...e })));
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

// GameState is JSON-serializable by invariant, so a JSON round-trip is a safe clone.
function clone(snap: MatchSnapshot): MatchSnapshot {
  return JSON.parse(JSON.stringify(snap)) as MatchSnapshot;
}
