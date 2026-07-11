import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PlayerId } from '@void/shared-core';
import type {
  AccountStore,
  AvaChallenge,
  AvaChallengeStatus,
  AvaChallengeStore,
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
        await client.query(
          `UPDATE corp_members SET role = 'head' WHERE corp_id = $1 AND account_id = $2`,
          [corpId, toAccountId],
        );
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

  async auditOf(corpId: string, limit = 50): Promise<CorpAuditEntry[]> {
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
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at
       FROM ava_challenges WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? challengeOf(r.rows[0]) : null;
  }

  async challengesOf(corpId: string, limit = 50): Promise<AvaChallenge[]> {
    const r = await this.pool.query<ChallengeRow>(
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at
       FROM ava_challenges
       WHERE challenger_corp = $1 OR target_corp = $1
       ORDER BY created_at DESC, id LIMIT $2`,
      [corpId, limit],
    );
    return r.rows.map(challengeOf);
  }

  async closeChallenge(
    id: string,
    status: Exclude<AvaChallengeStatus, 'pending'>,
  ): Promise<boolean> {
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
      `SELECT id, challenger_corp, target_corp, cost, status, created_at, expires_at
       FROM ava_challenges
       WHERE status = 'pending' AND expires_at <= $1
       ORDER BY expires_at, id`,
      [now],
    );
    return r.rows.map(challengeOf);
  }
}
