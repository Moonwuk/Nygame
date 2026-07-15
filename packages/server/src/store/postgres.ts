import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PlayerId } from '@void/shared-core';
import type {
  AccountStore,
  AvaChallenge,
  AvaChallengeStatus,
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
import {
  DEFAULT_AUDIT_LIMIT,
  DEFAULT_FEED_LIMIT,
  DEFAULT_CHALLENGES_LIMIT,
  DEFAULT_LOCKED_MATCHUPS_LIMIT,
  DEFAULT_RESULTS_LIMIT,
} from './types';

/** Create the tables (idempotent). JSONB discipline: the queryable fields (status,
 *  data_version, seq) are normalized COLUMNS; only the opaque match `state` is JSONB,
 *  so listing/filtering matches never full-scans the blob. See the roadmap PA-1.* */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id            text PRIMARY KEY,
      data_version  text NOT NULL,
      seq           integer NOT NULL,
      status        text NOT NULL,
      state         jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS matches_status_idx ON matches (status);

    CREATE TABLE IF NOT EXISTS seats (
      room       text NOT NULL,
      nick       text NOT NULL,
      player_id  text NOT NULL,
      joined_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room, nick)
    );
    -- a side is held by at most one nick per room (so two nicks can't take p1)
    CREATE UNIQUE INDEX IF NOT EXISTS seats_room_player_idx ON seats (room, player_id);
    -- seat lock (REL-5): sha256 of the seat ticket; NULL = seat claimed before the
    -- lock existed (adopted on the owner's next join). Plaintext never stored.
    ALTER TABLE seats ADD COLUMN IF NOT EXISTS ticket_hash text;

    CREATE TABLE IF NOT EXISTS receipts (
      match_id   text NOT NULL,
      action_id  text NOT NULL,
      player_id  text NOT NULL,
      seq        integer NOT NULL,
      ok         boolean NOT NULL,
      code       text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, action_id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id         text PRIMARY KEY,
      login      text NOT NULL,
      pass_hash  text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- logins are unique case-insensitively: Vasya and vasya are one account
    CREATE UNIQUE INDEX IF NOT EXISTS users_login_idx ON users (lower(login));

    CREATE TABLE IF NOT EXISTS corps (
      id         text PRIMARY KEY,
      name       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- corp names are unique case-insensitively (CORP-0)
    CREATE UNIQUE INDEX IF NOT EXISTS corps_name_idx ON corps (lower(name));
    -- AvA influence (AVA-2): inter-match corp currency; spend is atomic + guarded ≥0.
    -- ALTER … IF NOT EXISTS backfills pre-AVA-2 corps rows with the 0 default.
    ALTER TABLE corps ADD COLUMN IF NOT EXISTS influence bigint NOT NULL DEFAULT 0;

    -- account_id as the PRIMARY KEY is the one-corp-per-account invariant: a member
    -- (recruit rows included — a recruit row IS the pending application) can't join
    -- or apply to a second corp until the first row is gone.
    CREATE TABLE IF NOT EXISTS corp_members (
      account_id text PRIMARY KEY,
      corp_id    text NOT NULL,
      login      text NOT NULL,
      role       text NOT NULL,
      joined_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS corp_members_corp_idx ON corp_members (corp_id);

    -- audit rows are append-only and deliberately keep no FK to corps: they must
    -- survive a disband (the record is the point)
    CREATE TABLE IF NOT EXISTS corp_audit (
      id      bigserial PRIMARY KEY,
      corp_id text NOT NULL,
      at      bigint NOT NULL,
      actor   text NOT NULL,
      action  text NOT NULL,
      target  text,
      detail  text
    );
    CREATE INDEX IF NOT EXISTS corp_audit_corp_idx ON corp_audit (corp_id);

    -- AvA readiness (AVA-3). Corp-flag: the corp is in the ready pool (head-set).
    CREATE TABLE IF NOT EXISTS corp_ready (
      corp_id text PRIMARY KEY,
      since   bigint NOT NULL
    );
    -- Player-flag: a player's standing consent to offline deployment, bound to their
    -- CURRENT corp (account_id PK = one consent per account; leaving the corp clears it).
    CREATE TABLE IF NOT EXISTS player_ready (
      account_id text PRIMARY KEY,
      corp_id    text NOT NULL,
      since      bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS player_ready_corp_idx ON player_ready (corp_id);

    -- AvA challenges (AVA-4): the S0→S2 state machine. A partial unique index enforces
    -- ONE pending challenge per challenger→target pair (terminal rows don't collide).
    CREATE TABLE IF NOT EXISTS ava_challenges (
      id              text PRIMARY KEY,
      challenger_corp text NOT NULL,
      target_corp     text NOT NULL,
      cost            bigint NOT NULL,
      status          text NOT NULL,
      created_at      bigint NOT NULL,
      expires_at      bigint NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ava_challenges_pending_idx
      ON ava_challenges (challenger_corp, target_corp) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS ava_challenges_challenger_idx ON ava_challenges (challenger_corp);
    CREATE INDEX IF NOT EXISTS ava_challenges_target_idx ON ava_challenges (target_corp);
    -- AVA-6: the roster window deadline, stamped on accept (S3 opens at S2).
    -- ALTER … IF NOT EXISTS backfills pre-AVA-6 rows with NULL = window closed.
    ALTER TABLE ava_challenges ADD COLUMN IF NOT EXISTS pause_ends_at bigint;

    -- AvA rosters (AVA-6): one row per (matchup, account) — the PK is the
    -- one-entry-per-account invariant; the per-side cap is guarded inside the
    -- insert transaction (FOR UPDATE on the matchup row serializes racing joins).
    CREATE TABLE IF NOT EXISTS ava_roster (
      matchup_id text NOT NULL,
      account_id text NOT NULL,
      side       text NOT NULL,
      source     text NOT NULL,
      at         bigint NOT NULL,
      PRIMARY KEY (matchup_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS ava_roster_side_idx ON ava_roster (matchup_id, side);

    -- AvA results (AVA-8, MM-3.1 minimum): one recorded outcome per matchup. The PK is
    -- an idempotent record (belt-and-braces; the matchup's locked→ended transition is
    -- the primary exactly-once gate). winner_corp NULL = a draw. Foundation for the
    -- public feed (AVA-9), medal conditions and rating.
    CREATE TABLE IF NOT EXISTS ava_results (
      matchup_id      text PRIMARY KEY,
      challenger_corp text NOT NULL,
      target_corp     text NOT NULL,
      winner_corp     text,
      at              bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ava_results_at_idx ON ava_results (at DESC);

    -- AvA sessions (AVA-7): the live match a locked matchup was raised into. PK match_id +
    -- a UNIQUE matchup_id enforce one session per matchup and per instance (the orchestrator
    -- never double-builds). seats is the fixed accountId -> playerId map resolveAvaSeat reads.
    CREATE TABLE IF NOT EXISTS ava_sessions (
      match_id   text PRIMARY KEY,
      matchup_id text NOT NULL UNIQUE,
      map_id     text NOT NULL,
      seats      jsonb NOT NULL,
      at         bigint NOT NULL
    );
    -- AVA-8 (S6): the peace deadline + the exactly-once war stamp. ALTER … IF NOT
    -- EXISTS backfills pre-S6 rows with NULL = no scheduled war (never escalated).
    ALTER TABLE ava_sessions ADD COLUMN IF NOT EXISTS war_at bigint;
    ALTER TABLE ava_sessions ADD COLUMN IF NOT EXISTS war_declared_at bigint;

    -- AvA public feed (AVA-9): append-only, read newest-first. PUBLIC facts only (corp
    -- names + winner), snapshotted at publish — no private roster ever enters this table.
    CREATE TABLE IF NOT EXISTS ava_feed (
      id              text PRIMARY KEY,
      at              bigint NOT NULL,
      kind            text NOT NULL,
      challenger_corp text NOT NULL,
      challenger_name text NOT NULL,
      target_corp     text NOT NULL,
      target_name     text NOT NULL,
      winner_corp     text
    );
    CREATE INDEX IF NOT EXISTS ava_feed_at_idx ON ava_feed (at DESC, id DESC);
  `);
}

interface MatchRow {
  id: string;
  data_version: string;
  seq: number;
  status: string;
  state: MatchSnapshot['state'];
}

export class PostgresMatchStore implements MatchStore {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false; // pool exhausted / DB unreachable → not ready
    }
  }

  async load(matchId: string): Promise<MatchSnapshot | null> {
    const r = await this.pool.query<MatchRow>(
      `SELECT id, data_version, seq, status, state FROM matches WHERE id = $1`,
      [matchId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      matchId: row.id,
      dataVersion: row.data_version,
      seq: row.seq,
      status: row.status === 'ended' ? 'ended' : 'ongoing',
      state: row.state, // pg parses jsonb → JS object
    };
  }

  async save(snapshot: MatchSnapshot): Promise<void> {
    // Optimistic by seq: only overwrite when our snapshot is at least as new as the
    // stored one (the WHERE on the upsert path drops a stale late write).
    await this.pool.query(
      `INSERT INTO matches (id, data_version, seq, status, state, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         data_version = EXCLUDED.data_version,
         seq          = EXCLUDED.seq,
         status       = EXCLUDED.status,
         state        = EXCLUDED.state,
         updated_at   = now()
       WHERE matches.seq <= EXCLUDED.seq`,
      [snapshot.matchId, snapshot.dataVersion, snapshot.seq, snapshot.status, snapshot.state],
    );
  }

  async ongoingMatchIds(): Promise<string[]> {
    // Uses matches_status_idx — never touches the JSONB `state`.
    const r = await this.pool.query<{ id: string }>(
      `SELECT id FROM matches WHERE status = 'ongoing'`,
    );
    return r.rows.map((row) => row.id);
  }
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly pool: Pool) {}

  async resolveSeat(
    room: string,
    nick: string,
    seats: readonly PlayerId[],
  ): Promise<SeatAssignment | null> {
    const existing = await this.pool.query<{ player_id: string }>(
      `SELECT player_id FROM seats WHERE room = $1 AND nick = $2`,
      [room, nick],
    );
    const seat = existing.rows[0];
    if (seat) return { playerId: seat.player_id, isNew: false };

    // Assign a free seat. The unique (room, player_id) index makes the INSERT the
    // atomic claim — a concurrent claim of the same seat raises a unique violation,
    // and we fall through to the next free seat.
    const takenR = await this.pool.query<{ player_id: string }>(
      `SELECT player_id FROM seats WHERE room = $1`,
      [room],
    );
    const taken = new Set(takenR.rows.map((r) => r.player_id));
    for (const candidate of seats) {
      if (taken.has(candidate)) continue;
      try {
        await this.pool.query(`INSERT INTO seats (room, nick, player_id) VALUES ($1, $2, $3)`, [
          room,
          nick,
          candidate,
        ]);
        return { playerId: candidate, isNew: true };
      } catch {
        // (room, nick) or (room, player_id) was claimed concurrently — try the next.
        const reread = await this.pool.query<{ player_id: string }>(
          `SELECT player_id FROM seats WHERE room = $1 AND nick = $2`,
          [room, nick],
        );
        const now = reread.rows[0];
        if (now) return { playerId: now.player_id, isNew: false };
        taken.add(candidate);
      }
    }
    return null; // every seat taken
  }

  async seatOf(room: string, nick: string): Promise<PlayerId | null> {
    const r = await this.pool.query<{ player_id: string }>(
      `SELECT player_id FROM seats WHERE room = $1 AND nick = $2`,
      [room, nick],
    );
    return r.rows[0]?.player_id ?? null;
  }

  async bindSeatTicket(room: string, nick: string, ticketHash: string): Promise<string | null> {
    // First bind wins atomically: the UPDATE only lands on a NULL hash, then the
    // SELECT reads back whichever hash is durably bound (ours, or a concurrent
    // winner's). No row (nick holds no seat) → null → the caller refuses.
    await this.pool.query(
      `UPDATE seats SET ticket_hash = $3
       WHERE room = $1 AND nick = $2 AND ticket_hash IS NULL`,
      [room, nick, ticketHash],
    );
    const r = await this.pool.query<{ ticket_hash: string | null }>(
      `SELECT ticket_hash FROM seats WHERE room = $1 AND nick = $2`,
      [room, nick],
    );
    return r.rows[0]?.ticket_hash ?? null;
  }

  async seatTicket(room: string, nick: string): Promise<string | null> {
    const r = await this.pool.query<{ ticket_hash: string | null }>(
      `SELECT ticket_hash FROM seats WHERE room = $1 AND nick = $2`,
      [room, nick],
    );
    return r.rows[0]?.ticket_hash ?? null;
  }

  async occupiedSeats(room: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM seats WHERE room = $1`,
      [room],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}

export class PostgresUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async createUser(
    login: string,
    passHash: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; code: 'E_LOGIN_TAKEN' }> {
    const userId = randomUUID();
    try {
      await this.pool.query(`INSERT INTO users (id, login, pass_hash) VALUES ($1, $2, $3)`, [
        userId,
        login,
        passHash,
      ]);
      return { ok: true, userId };
    } catch {
      // The unique lower(login) index makes the INSERT the atomic claim; a violation
      // (concurrent or pre-existing registration) is the one expected failure here.
      return { ok: false, code: 'E_LOGIN_TAKEN' };
    }
  }

  async findUser(login: string): Promise<UserRecord | null> {
    const r = await this.pool.query<{ id: string; login: string; pass_hash: string }>(
      `SELECT id, login, pass_hash FROM users WHERE lower(login) = lower($1)`,
      [login],
    );
    const row = r.rows[0];
    return row ? { userId: row.id, login: row.login, passHash: row.pass_hash } : null;
  }
}

interface CorpMemberRow {
  corp_id: string;
  account_id: string;
  login: string;
  role: string;
}

function memberOf(row: CorpMemberRow): CorpMembership {
  return {
    corpId: row.corp_id,
    accountId: row.account_id,
    login: row.login,
    role: row.role as CorpRole, // the store only ever writes CorpRole values
  };
}

export class PostgresCorpStore implements CorpStore {
  constructor(private readonly pool: Pool) {}

  async createCorp(
    name: string,
    headAccountId: string,
    headLogin: string,
  ): Promise<{ ok: true; corpId: string } | { ok: false; code: 'E_NAME_TAKEN' | 'E_IN_CORP' }> {
    // One transaction, two atomic claims: the corp_members PK is the one-corp-per-
    // account claim, the lower(name) unique index is the name claim. ON CONFLICT
    // probes the first without an exception; the second reports through the catch.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const corpId = randomUUID();
      const claim = await client.query(
        `INSERT INTO corp_members (account_id, corp_id, login, role)
         VALUES ($1, $2, $3, 'head')
         ON CONFLICT (account_id) DO NOTHING`,
        [headAccountId, corpId, headLogin],
      );
      if ((claim.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'E_IN_CORP' };
      }
      try {
        await client.query(`INSERT INTO corps (id, name) VALUES ($1, $2)`, [corpId, name]);
      } catch {
        await client.query('ROLLBACK');
        return { ok: false, code: 'E_NAME_TAKEN' };
      }
      await client.query('COMMIT');
      return { ok: true, corpId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getCorp(corpId: string): Promise<CorpRecord | null> {
    const r = await this.pool.query<{ id: string; name: string; influence: string }>(
      `SELECT id, name, influence FROM corps WHERE id = $1`,
      [corpId],
    );
    const row = r.rows[0];
    return row ? { corpId: row.id, name: row.name, influence: Number(row.influence) } : null;
  }

  async listCorps(): Promise<CorpSummary[]> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      influence: string;
      members: string;
    }>(
      `SELECT c.id, c.name, c.influence,
              count(m.account_id) FILTER (WHERE m.role <> 'recruit') AS members
       FROM corps c
       LEFT JOIN corp_members m ON m.corp_id = c.id
       GROUP BY c.id, c.name, c.influence
       ORDER BY lower(c.name)`,
    );
    return r.rows.map((row) => ({
      corpId: row.id,
      name: row.name,
      influence: Number(row.influence),
      members: Number(row.members),
    }));
  }

  async membershipOf(accountId: string): Promise<CorpMembership | null> {
    const r = await this.pool.query<CorpMemberRow>(
      `SELECT corp_id, account_id, login, role FROM corp_members WHERE account_id = $1`,
      [accountId],
    );
    return r.rows[0] ? memberOf(r.rows[0]) : null;
  }

  async membersOf(corpId: string): Promise<CorpMembership[]> {
    const r = await this.pool.query<CorpMemberRow>(
      `SELECT corp_id, account_id, login, role FROM corp_members WHERE corp_id = $1`,
      [corpId],
    );
    return r.rows.map(memberOf);
  }

  async addMember(
    corpId: string,
    accountId: string,
    login: string,
    role: CorpRole,
  ): Promise<{ ok: true } | { ok: false; code: 'E_IN_CORP' }> {
    const r = await this.pool.query(
      `INSERT INTO corp_members (account_id, corp_id, login, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId, corpId, login, role],
    );
    return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, code: 'E_IN_CORP' };
  }

  async setRole(corpId: string, accountId: string, role: CorpRole): Promise<void> {
    await this.pool.query(
      `UPDATE corp_members SET role = $3 WHERE corp_id = $1 AND account_id = $2`,
      [corpId, accountId, role],
    );
  }

  async removeMember(corpId: string, accountId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM corp_members WHERE corp_id = $1 AND account_id = $2`, [
        corpId,
        accountId,
      ]);
      // Leaving the corp revokes the AvA player-ready consent (AVA-3).
      await client.query(`DELETE FROM player_ready WHERE account_id = $1`, [accountId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async swapHead(corpId: string, fromAccountId: string, toAccountId: string): Promise<void> {
    // One transaction so there is never a window with zero or two heads.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const demoted = await client.query(
        `UPDATE corp_members SET role = 'officer'
         WHERE corp_id = $1 AND account_id = $2 AND role = 'head'`,
        [corpId, fromAccountId],
      );
      if ((demoted.rowCount ?? 0) > 0) {
        const promoted = await client.query(
          `UPDATE corp_members SET role = 'head' WHERE corp_id = $1 AND account_id = $2`,
          [corpId, toAccountId],
        );
        if ((promoted.rowCount ?? 0) === 0) {
          // The target left (or was kicked) between the service's membership check
          // and this transaction — roll the demotion back rather than commit a
          // headless corp. Net effect: a no-op, same as the memory adapter.
          await client.query('ROLLBACK');
          return;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async removeCorp(corpId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Clear the corp's AvA readiness (its own flag + every member's consent) with it.
      await client.query(`DELETE FROM player_ready WHERE corp_id = $1`, [corpId]);
      await client.query(`DELETE FROM corp_ready WHERE corp_id = $1`, [corpId]);
      await client.query(`DELETE FROM corp_members WHERE corp_id = $1`, [corpId]);
      await client.query(`DELETE FROM corps WHERE id = $1`, [corpId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addInfluence(corpId: string, delta: number): Promise<void> {
    if (delta <= 0) return;
    await this.pool.query(`UPDATE corps SET influence = influence + $2 WHERE id = $1`, [
      corpId,
      delta,
    ]);
  }

  async spendInfluence(
    corpId: string,
    cost: number,
  ): Promise<{ ok: true } | { ok: false; code: 'E_INSUFFICIENT' }> {
    if (cost <= 0) return { ok: false, code: 'E_INSUFFICIENT' };
    // The `influence >= cost` guard rides IN the UPDATE, so the check and the debit are
    // one atomic statement — two racing spends can't both pass and overdraw the balance.
    const r = await this.pool.query(
      `UPDATE corps SET influence = influence - $2 WHERE id = $1 AND influence >= $2`,
      [corpId, cost],
    );
    return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, code: 'E_INSUFFICIENT' };
  }

  async setCorpReady(corpId: string, since: number): Promise<void> {
    // Only a real corp joins the pool; keep the earliest `since` (idempotent set).
    await this.pool.query(
      `INSERT INTO corp_ready (corp_id, since)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM corps WHERE id = $1)
       ON CONFLICT (corp_id) DO NOTHING`,
      [corpId, since],
    );
  }

  async clearCorpReady(corpId: string): Promise<void> {
    await this.pool.query(`DELETE FROM corp_ready WHERE corp_id = $1`, [corpId]);
  }

  async listReadyCorps(): Promise<Array<CorpSummary & { readySince: number }>> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      influence: string;
      members: string;
      since: string;
    }>(
      `SELECT c.id, c.name, c.influence, r.since,
              count(m.account_id) FILTER (WHERE m.role <> 'recruit') AS members
       FROM corp_ready r
       JOIN corps c ON c.id = r.corp_id
       LEFT JOIN corp_members m ON m.corp_id = c.id
       GROUP BY c.id, c.name, c.influence, r.since
       ORDER BY lower(c.name)`,
    );
    return r.rows.map((row) => ({
      corpId: row.id,
      name: row.name,
      influence: Number(row.influence),
      members: Number(row.members),
      readySince: Number(row.since),
    }));
  }

  async isCorpReady(corpId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM corp_ready WHERE corp_id = $1`, [corpId]);
    return (r.rowCount ?? 0) > 0;
  }

  async setPlayerReady(accountId: string, corpId: string, since: number): Promise<void> {
    // Rebind to the current corp if the account moved; keep `since` when already set here.
    await this.pool.query(
      `INSERT INTO player_ready (account_id, corp_id, since) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET corp_id = EXCLUDED.corp_id,
         since = CASE WHEN player_ready.corp_id = EXCLUDED.corp_id THEN player_ready.since
                      ELSE EXCLUDED.since END`,
      [accountId, corpId, since],
    );
  }

  async clearPlayerReady(accountId: string): Promise<void> {
    await this.pool.query(`DELETE FROM player_ready WHERE account_id = $1`, [accountId]);
  }

  async readyPlayersOf(corpId: string): Promise<string[]> {
    const r = await this.pool.query<{ account_id: string }>(
      `SELECT account_id FROM player_ready WHERE corp_id = $1 ORDER BY account_id`,
      [corpId],
    );
    return r.rows.map((row) => row.account_id);
  }

  async appendAudit(entry: CorpAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO corp_audit (corp_id, at, actor, action, target, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.corpId,
        entry.at,
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.detail ?? null,
      ],
    );
  }

  async auditOf(corpId: string, limit = DEFAULT_AUDIT_LIMIT): Promise<CorpAuditEntry[]> {
    const r = await this.pool.query<{
      corp_id: string;
      at: string;
      actor: string;
      action: string;
      target: string | null;
      detail: string | null;
    }>(
      `SELECT corp_id, at, actor, action, target, detail
       FROM corp_audit WHERE corp_id = $1
       ORDER BY id DESC LIMIT $2`,
      [corpId, limit],
    );
    return r.rows.map((row) => ({
      corpId: row.corp_id,
      at: Number(row.at), // bigint arrives as a string
      actor: row.actor,
      action: row.action as CorpAuditEntry['action'],
      ...(row.target !== null ? { target: row.target } : {}),
      ...(row.detail !== null ? { detail: row.detail } : {}),
    }));
  }
}

interface ReceiptRow {
  action_id: string;
  player_id: string;
  seq: number;
  ok: boolean;
  code: string | null;
}

export class PostgresReceiptStore implements ReceiptStore {
  constructor(private readonly pool: Pool) {}

  async loadAll(matchId: string): Promise<StoredReceipt[]> {
    const r = await this.pool.query<ReceiptRow>(
      `SELECT action_id, player_id, seq, ok, code FROM receipts WHERE match_id = $1`,
      [matchId],
    );
    return r.rows.map((row) => ({
      actionId: row.action_id,
      playerId: row.player_id,
      seq: row.seq,
      ok: row.ok,
      ...(row.code !== null ? { code: row.code } : {}),
    }));
  }

  async save(matchId: string, receipt: StoredReceipt): Promise<void> {
    // Receipts are immutable — first write wins; a re-save of the same action is a no-op.
    await this.pool.query(
      `INSERT INTO receipts (match_id, action_id, player_id, seq, ok, code)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (match_id, action_id) DO NOTHING`,
      [matchId, receipt.actionId, receipt.playerId, receipt.seq, receipt.ok, receipt.code ?? null],
    );
  }
}

interface ChallengeRow {
  id: string;
  challenger_corp: string;
  target_corp: string;
  cost: string;
  status: string;
  created_at: string;
  expires_at: string;
  pause_ends_at: string | null;
}

function challengeOf(row: ChallengeRow): AvaChallenge {
  return {
    id: row.id,
    challengerCorp: row.challenger_corp,
    targetCorp: row.target_corp,
    cost: Number(row.cost),
    status: row.status as AvaChallengeStatus,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    ...(row.pause_ends_at === null ? {} : { pauseEndsAt: Number(row.pause_ends_at) }),
  };
}

/** Postgres AvA challenge store (AVA-4). The partial unique index enforces one pending
 *  per pair; the conditional UPDATE makes pending→terminal an exactly-once transition. */
export class PostgresAvaChallengeStore implements AvaChallengeStore {
  constructor(private readonly pool: Pool) {}

  async createChallenge(
    challenge: AvaChallenge,
  ): Promise<{ ok: true } | { ok: false; code: 'E_ALREADY_CHALLENGED' }> {
    try {
      await this.pool.query(
        `INSERT INTO ava_challenges
           (id, challenger_corp, target_corp, cost, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          challenge.id,
          challenge.challengerCorp,
          challenge.targetCorp,
          challenge.cost,
          challenge.status,
          challenge.createdAt,
          challenge.expiresAt,
        ],
      );
      return { ok: true };
    } catch {
      // The partial unique index (challenger, target) WHERE pending rejected it.
      return { ok: false, code: 'E_ALREADY_CHALLENGED' };
    }
  }

  async getChallenge(id: string): Promise<AvaChallenge | null> {
    const r = await this.pool.query<ChallengeRow>(
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at, pause_ends_at
       FROM ava_challenges WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? challengeOf(r.rows[0]) : null;
  }

  async challengesOf(corpId: string, limit = DEFAULT_CHALLENGES_LIMIT): Promise<AvaChallenge[]> {
    const r = await this.pool.query<ChallengeRow>(
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at, pause_ends_at
       FROM ava_challenges
       WHERE challenger_corp = $1 OR target_corp = $1
       ORDER BY created_at DESC, id LIMIT $2`,
      [corpId, limit],
    );
    return r.rows.map(challengeOf);
  }

  async closeChallenge(id: string, status: 'accepted' | 'declined' | 'expired'): Promise<boolean> {
    // Only a still-pending row transitions — so a lost double-accept race changes
    // nothing and the caller (which keys the refund off this) can't double-refund.
    const r = await this.pool.query(
      `UPDATE ava_challenges SET status = $2 WHERE id = $1 AND status = 'pending'`,
      [id, status],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async duePending(now: number): Promise<AvaChallenge[]> {
    const r = await this.pool.query<ChallengeRow>(
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at, pause_ends_at
       FROM ava_challenges
       WHERE status = 'pending' AND expires_at <= $1
       ORDER BY expires_at, id`,
      [now],
    );
    return r.rows.map(challengeOf);
  }

  async openRosterWindow(id: string, pauseEndsAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE ava_challenges SET pause_ends_at = $2 WHERE id = $1 AND status = 'accepted'`,
      [id, pauseEndsAt],
    );
  }

  async closeMatchup(id: string, status: 'locked' | 'cancelled'): Promise<boolean> {
    // Same exactly-once contract as closeChallenge, over the accepted state: only a
    // still-accepted matchup transitions, so the sweep can't cancel-and-refund twice.
    const r = await this.pool.query(
      `UPDATE ava_challenges SET status = $2 WHERE id = $1 AND status = 'accepted'`,
      [id, status],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async dueRosters(now: number): Promise<AvaChallenge[]> {
    const r = await this.pool.query<ChallengeRow>(
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at, pause_ends_at
       FROM ava_challenges
       WHERE status = 'accepted' AND pause_ends_at IS NOT NULL AND pause_ends_at <= $1
       ORDER BY pause_ends_at, id`,
      [now],
    );
    return r.rows.map(challengeOf);
  }

  async lockedMatchups(limit = DEFAULT_LOCKED_MATCHUPS_LIMIT): Promise<AvaChallenge[]> {
    const r = await this.pool.query<ChallengeRow>(
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at, pause_ends_at
       FROM ava_challenges
       WHERE status = 'locked'
       ORDER BY created_at DESC, id LIMIT $1`,
      [limit],
    );
    return r.rows.map(challengeOf);
  }

  async endMatchup(id: string): Promise<boolean> {
    // Same exactly-once contract as closeMatchup, over the locked state: only a
    // still-locked matchup transitions, so settlement can't award influence twice.
    const r = await this.pool.query(
      `UPDATE ava_challenges SET status = 'ended' WHERE id = $1 AND status = 'locked'`,
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

interface RosterRow {
  matchup_id: string;
  account_id: string;
  side: string;
  source: string;
  at: string;
}

function rosterEntryOf(row: RosterRow): AvaRosterEntry {
  return {
    matchupId: row.matchup_id,
    accountId: row.account_id,
    side: row.side as AvaSide,
    source: row.source as AvaRosterEntry['source'],
    at: Number(row.at),
  };
}

/** Postgres AvA roster store (AVA-6). The PK is the one-entry-per-account invariant;
 *  the per-side cap is guarded by serializing racing inserts of one matchup — the
 *  transaction takes FOR UPDATE on the matchup row before counting, so two joins for
 *  the last slot cannot both pass the count. */
export class PostgresAvaRosterStore implements AvaRosterStore {
  constructor(private readonly pool: Pool) {}

  async addEntry(
    entry: AvaRosterEntry,
    capPerSide: number,
  ): Promise<{ ok: true } | { ok: false; code: 'E_ALREADY_ROSTERED' | 'E_ROSTER_FULL' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize concurrent roster writes of this matchup (the cap guard's atomicity).
      await client.query(`SELECT id FROM ava_challenges WHERE id = $1 FOR UPDATE`, [
        entry.matchupId,
      ]);
      const dup = await client.query(
        `SELECT 1 FROM ava_roster WHERE matchup_id = $1 AND account_id = $2`,
        [entry.matchupId, entry.accountId],
      );
      if ((dup.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'E_ALREADY_ROSTERED' };
      }
      const onSide = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ava_roster WHERE matchup_id = $1 AND side = $2`,
        [entry.matchupId, entry.side],
      );
      if (Number(onSide.rows[0]?.n ?? 0) >= capPerSide) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'E_ROSTER_FULL' };
      }
      await client.query(
        `INSERT INTO ava_roster (matchup_id, account_id, side, source, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [entry.matchupId, entry.accountId, entry.side, entry.source, entry.at],
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async replaceSide(matchupId: string, side: AvaSide, entries: AvaRosterEntry[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM ava_challenges WHERE id = $1 FOR UPDATE`, [matchupId]);
      await client.query(`DELETE FROM ava_roster WHERE matchup_id = $1 AND side = $2`, [
        matchupId,
        side,
      ]);
      for (const entry of entries) {
        await client.query(
          `INSERT INTO ava_roster (matchup_id, account_id, side, source, at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (matchup_id, account_id) DO NOTHING`,
          [entry.matchupId, entry.accountId, entry.side, entry.source, entry.at],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rosterOf(matchupId: string): Promise<AvaRosterEntry[]> {
    const r = await this.pool.query<RosterRow>(
      `SELECT matchup_id, account_id, side, source, at
       FROM ava_roster WHERE matchup_id = $1
       ORDER BY side, account_id`,
      [matchupId],
    );
    return r.rows.map(rosterEntryOf);
  }
}

interface ResultRow {
  matchup_id: string;
  challenger_corp: string;
  target_corp: string;
  winner_corp: string | null;
  at: string;
}

function resultOf(row: ResultRow): AvaResult {
  return {
    matchupId: row.matchup_id,
    challengerCorp: row.challenger_corp,
    targetCorp: row.target_corp,
    winnerCorp: row.winner_corp,
    at: Number(row.at),
  };
}

/** Postgres AvA result store (AVA-8). `record` is idempotent via the matchup_id PK
 *  (ON CONFLICT DO NOTHING) — belt-and-braces behind the locked→ended gate. */
export class PostgresAvaResultStore implements AvaResultStore {
  constructor(private readonly pool: Pool) {}

  async record(result: AvaResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO ava_results (matchup_id, challenger_corp, target_corp, winner_corp, at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (matchup_id) DO NOTHING`,
      [result.matchupId, result.challengerCorp, result.targetCorp, result.winnerCorp, result.at],
    );
  }

  async get(matchupId: string): Promise<AvaResult | null> {
    const r = await this.pool.query<ResultRow>(
      `SELECT matchup_id, challenger_corp, target_corp, winner_corp, at
       FROM ava_results WHERE matchup_id = $1`,
      [matchupId],
    );
    return r.rows[0] ? resultOf(r.rows[0]) : null;
  }

  async recent(limit = DEFAULT_RESULTS_LIMIT): Promise<AvaResult[]> {
    const r = await this.pool.query<ResultRow>(
      `SELECT matchup_id, challenger_corp, target_corp, winner_corp, at
       FROM ava_results ORDER BY at DESC, matchup_id LIMIT $1`,
      [limit],
    );
    return r.rows.map(resultOf);
  }
}

interface FeedRow {
  id: string;
  at: string;
  kind: string;
  challenger_corp: string;
  challenger_name: string;
  target_corp: string;
  target_name: string;
  winner_corp: string | null;
}

function feedEntryOf(row: FeedRow): AvaFeedEntry {
  return {
    id: row.id,
    at: Number(row.at),
    kind: row.kind as AvaFeedEntry['kind'],
    challengerCorp: row.challenger_corp,
    challengerName: row.challenger_name,
    targetCorp: row.target_corp,
    targetName: row.target_name,
    // A matchup entry has no winner concept; a result carries one (null = draw).
    ...(row.kind === 'result' ? { winnerCorp: row.winner_corp } : {}),
  };
}

/** Postgres AvA feed store (AVA-9) — append-only, newest-first with an `at` cursor. */
export class PostgresAvaFeedStore implements AvaFeedStore {
  constructor(private readonly pool: Pool) {}

  async append(entry: AvaFeedEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ava_feed
         (id, at, kind, challenger_corp, challenger_name, target_corp, target_name, winner_corp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        entry.id,
        entry.at,
        entry.kind,
        entry.challengerCorp,
        entry.challengerName,
        entry.targetCorp,
        entry.targetName,
        entry.winnerCorp ?? null,
      ],
    );
  }

  async recent(limit = DEFAULT_FEED_LIMIT, before?: number): Promise<AvaFeedEntry[]> {
    const r =
      before === undefined
        ? await this.pool.query<FeedRow>(
            `SELECT id, at, kind, challenger_corp, challenger_name, target_corp, target_name, winner_corp
             FROM ava_feed ORDER BY at DESC, id DESC LIMIT $1`,
            [limit],
          )
        : await this.pool.query<FeedRow>(
            `SELECT id, at, kind, challenger_corp, challenger_name, target_corp, target_name, winner_corp
             FROM ava_feed WHERE at < $2 ORDER BY at DESC, id DESC LIMIT $1`,
            [limit, before],
          );
    return r.rows.map(feedEntryOf);
  }
}

interface SessionRow {
  match_id: string;
  matchup_id: string;
  map_id: string;
  seats: Record<string, string>;
  at: string;
  war_at: string | null;
  war_declared_at: string | null;
}

function sessionOf(row: SessionRow): AvaSession {
  return {
    matchId: row.match_id,
    matchupId: row.matchup_id,
    mapId: row.map_id,
    seats: row.seats,
    at: Number(row.at),
    ...(row.war_at === null ? {} : { warAt: Number(row.war_at) }),
    ...(row.war_declared_at === null ? {} : { warDeclaredAt: Number(row.war_declared_at) }),
  };
}

/** The full session column list every SELECT shares (one place to extend). */
const SESSION_COLS = 'match_id, matchup_id, map_id, seats, at, war_at, war_declared_at';

/** Postgres AvA session store (AVA-7). The PK (match_id) + UNIQUE (matchup_id) make
 *  `create` atomically one-per-matchup and one-per-instance; a duplicate raises the
 *  insert conflict → `E_SESSION_EXISTS` (the orchestrator treats that as "already built"). */
export class PostgresAvaSessionStore implements AvaSessionStore {
  constructor(private readonly pool: Pool) {}

  async create(
    session: AvaSession,
  ): Promise<{ ok: true } | { ok: false; code: 'E_SESSION_EXISTS' }> {
    try {
      await this.pool.query(
        `INSERT INTO ava_sessions (match_id, matchup_id, map_id, seats, at, war_at, war_declared_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.matchId,
          session.matchupId,
          session.mapId,
          JSON.stringify(session.seats),
          session.at,
          session.warAt ?? null,
          session.warDeclaredAt ?? null,
        ],
      );
      return { ok: true };
    } catch {
      // PK (match_id) or UNIQUE (matchup_id) collision — a session already exists.
      return { ok: false, code: 'E_SESSION_EXISTS' };
    }
  }

  async byMatch(matchId: string): Promise<AvaSession | null> {
    const r = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM ava_sessions WHERE match_id = $1`,
      [matchId],
    );
    return r.rows[0] ? sessionOf(r.rows[0]) : null;
  }

  async byMatchup(matchupId: string): Promise<AvaSession | null> {
    const r = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM ava_sessions WHERE matchup_id = $1`,
      [matchupId],
    );
    return r.rows[0] ? sessionOf(r.rows[0]) : null;
  }

  async dueWar(now: number): Promise<AvaSession[]> {
    const r = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM ava_sessions
       WHERE war_at IS NOT NULL AND war_at <= $1 AND war_declared_at IS NULL
       ORDER BY war_at, match_id`,
      [now],
    );
    return r.rows.map(sessionOf);
  }

  async markWarDeclared(matchId: string, at: number): Promise<boolean> {
    // Exactly-once: only an undeclared, war-scheduled session takes the stamp — two
    // racing sweep passes cannot both "win" and neither re-declares a declared war.
    const r = await this.pool.query(
      `UPDATE ava_sessions SET war_declared_at = $2
       WHERE match_id = $1 AND war_at IS NOT NULL AND war_declared_at IS NULL`,
      [matchId, at],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
