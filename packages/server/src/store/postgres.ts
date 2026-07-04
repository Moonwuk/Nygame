import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PlayerId } from '@void/shared-core';
import type {
  AccountStore,
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
        await this.pool.query(
          `INSERT INTO seats (room, nick, player_id) VALUES ($1, $2, $3)`,
          [room, nick, candidate],
        );
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
