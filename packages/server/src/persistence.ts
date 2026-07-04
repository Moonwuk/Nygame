import type { MatchRoom } from './matchRoom';
import {
  MemoryAccountStore,
  MemoryMatchStore,
  MemoryReceiptStore,
  MemoryUserStore,
  PostgresAccountStore,
  PostgresMatchStore,
  PostgresReceiptStore,
  PostgresUserStore,
  migrate,
  type AccountStore,
  type MatchSnapshot,
  type MatchStore,
  type ReceiptStore,
  type UserStore,
} from './store';

/**
 * Durability wiring for the dev harness (F8): a `MatchStore` + `ReceiptStore` so a
 * server restart resumes the match instead of losing it, plus the snapshot helper
 * both the action path and the clock driver persist through.
 *
 * Memory stores are the default (a restart still loses the match — dev/test). Set
 * `DATABASE_URL` to swap in the Postgres adapters (durable across restart), which
 * also creates the tables on boot. See `docs/infra-sizing-roadmap.md`, blocker #1.
 */
export interface Stores {
  store: MatchStore;
  receiptStore: ReceiptStore;
  /** Nick→seat identity. Durable (Postgres) alongside the match itself, so a returning
   *  nick resumes its own side after a restart — not just the match state (review #6). */
  accountStore: AccountStore;
  /** Login+password accounts (SE-1.x) — the identity the /auth API authenticates. */
  userStore: UserStore;
  /** Which backend is active — for the boot log ('memory' loses state on restart). */
  kind: 'memory' | 'postgres';
  close(): Promise<void>;
}

export async function createStores(env: NodeJS.ProcessEnv = process.env): Promise<Stores> {
  const url = env.DATABASE_URL;
  if (!url) {
    return {
      store: new MemoryMatchStore(),
      receiptStore: new MemoryReceiptStore(),
      accountStore: new MemoryAccountStore(),
      userStore: new MemoryUserStore(),
      kind: 'memory',
      close: () => Promise.resolve(),
    };
  }
  // Dynamic import so the memory path never loads `pg` (also kept `external` in
  // dev.mjs so the bundler leaves it for Node to resolve at runtime).
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  await migrate(pool);
  return {
    store: new PostgresMatchStore(pool),
    receiptStore: new PostgresReceiptStore(pool),
    accountStore: new PostgresAccountStore(pool), // shares the pool; closed by pool.end()
    userStore: new PostgresUserStore(pool),
    kind: 'postgres',
    close: () => pool.end(),
  };
}

/** A durable snapshot of the room's current state. Safe to hand to an async `save`:
 *  the core never mutates a `GameState` in place (invariant #2 — the reducer returns
 *  a new object), so this captured reference won't change under a pending write. */
export function snapshotOf(room: MatchRoom): MatchSnapshot {
  const state = room.state;
  return {
    matchId: room.id,
    dataVersion: state.version.data,
    seq: room.sequence,
    status: state.match.status,
    state,
  };
}
