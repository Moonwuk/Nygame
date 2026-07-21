import type { MatchRoom } from './matchRoom';
import {
  MemoryAccountStore,
  MemoryArsenalStore,
  MemoryAvaChallengeStore,
  MemoryAvaFeedStore,
  MemoryAvaResultStore,
  MemoryAvaRosterStore,
  MemoryAvaSessionStore,
  MemoryCorpRentStore,
  MemoryCorpStore,
  MemoryDropStore,
  MemoryMatchStore,
  MemoryMedalStore,
  MemoryReceiptStore,
  MemoryUserStore,
  PostgresAccountStore,
  PostgresArsenalStore,
  PostgresAvaChallengeStore,
  PostgresAvaFeedStore,
  PostgresAvaResultStore,
  PostgresAvaRosterStore,
  PostgresAvaSessionStore,
  PostgresCorpRentStore,
  PostgresCorpStore,
  PostgresDropStore,
  PostgresMatchStore,
  PostgresMedalStore,
  PostgresReceiptStore,
  PostgresUserStore,
  migrate,
  type AccountStore,
  type ArsenalStore,
  type AvaChallengeStore,
  type AvaFeedStore,
  type AvaResultStore,
  type AvaRosterStore,
  type AvaSessionStore,
  type CorpRentStore,
  type CorpStore,
  type DropStore,
  type MatchSnapshot,
  type MatchStore,
  type MedalStore,
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
  /** Corporations (CORP-0) — membership/roles between matches, the AvA org layer. */
  corpStore: CorpStore;
  /** AvA challenges (AVA-4) — the S0→S2 challenge state machine, durable. */
  challengeStore: AvaChallengeStore;
  /** AvA rosters (AVA-6) — the pause-window roster of an accepted matchup. */
  rosterStore: AvaRosterStore;
  /** AvA results (AVA-8) — recorded outcomes (MM-3.1 match history), durable. */
  resultStore: AvaResultStore;
  /** AvA public feed (AVA-9) — confirmed matchups + results, no private data. */
  feedStore: AvaFeedStore;
  /** AvA sessions (AVA-7) — the live match a locked matchup was raised into + its seating. */
  sessionStore: AvaSessionStore;
  /** Earned medals (MED-1) — permanent per-account achievement record. */
  medalStore: MedalStore;
  /** Personal arsenal (ARS-2) — hulls/modules/fittings an account owns between
   *  sessions; snapshots (ARS-3) and the live build gate (LARS-1) read it. */
  arsenalStore: ArsenalStore;
  /** Corp-arsenal rentals (ARS-6) — which corp-owned item is on loan to whom, for
   *  which war; ownership itself never leaves `arsenalStore` (a corp-owned item is
   *  just a row keyed by the corp's id). */
  corpRentStore: CorpRentStore;
  /** Drop loop (ARS-4) — per-account pity + salvage shards + exactly-once roll claims. */
  dropStore: DropStore;
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
      corpStore: new MemoryCorpStore(),
      challengeStore: new MemoryAvaChallengeStore(),
      rosterStore: new MemoryAvaRosterStore(),
      resultStore: new MemoryAvaResultStore(),
      feedStore: new MemoryAvaFeedStore(),
      sessionStore: new MemoryAvaSessionStore(),
      medalStore: new MemoryMedalStore(),
      arsenalStore: new MemoryArsenalStore(),
      corpRentStore: new MemoryCorpRentStore(),
      dropStore: new MemoryDropStore(),
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
    corpStore: new PostgresCorpStore(pool),
    challengeStore: new PostgresAvaChallengeStore(pool),
    rosterStore: new PostgresAvaRosterStore(pool),
    resultStore: new PostgresAvaResultStore(pool),
    feedStore: new PostgresAvaFeedStore(pool),
    sessionStore: new PostgresAvaSessionStore(pool),
    medalStore: new PostgresMedalStore(pool),
    arsenalStore: new PostgresArsenalStore(pool),
    corpRentStore: new PostgresCorpRentStore(pool),
    dropStore: new PostgresDropStore(pool),
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
