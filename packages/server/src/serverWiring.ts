import type { ActionGate } from '@void/action-layer';
import type { DomainEvent, GameData, PlayerReward } from '@void/shared-core';
import { createDevMatch } from './scenario';
import { startClockDriver, type ClockDriverHandle } from './clockDriver';
import { snapshotOf, type Stores } from './persistence';
import type { LoadedMatch } from './roomRegistry';
import type { RoomObservation } from './matchRoom';
import type { MatchSnapshot, StoredReceipt } from './store';

/**
 * The match-loading wiring `main.ts` hands to the LazyRoomRegistry, extracted
 * so tests can run the REAL persist/observe/driver composition instead of
 * mirroring it by hand (f8-persistence used to re-implement these closures).
 * Pure assembly over injected deps — no env reads, no listening socket.
 */
export interface MatchLoaderDeps {
  stores: Pick<Stores, 'store' | 'receiptStore'>;
  data: GameData;
  /** Present ⇒ every loaded room is gated (validated action.v1 envelopes). */
  gateFactory?: () => ActionGate;
  /** Wall clock (injectable for tests). */
  now?: () => number;
  /** Stall reporter — a same-instant scheduling loop wedged the world clock. */
  onStall?: (matchId: string) => void;
  /** Optional per-match extras, resolved before the room is built. main.ts uses
   *  this for the AvA wiring (AVA-8): on an AvA session, PLAYER diplomacy is
   *  refused at the wire (the orchestrator owns the stances) and the match end
   *  is handed to the settlement. `null` ⇒ an ordinary match, no extras. */
  matchExtras?: (matchId: string) => Promise<MatchExtras | null>;
}

/** Per-match wiring extras (see {@link MatchLoaderDeps.matchExtras}). */
export interface MatchExtras {
  /** Wire-level deny rule for player-submitted action types (server drivers pass). */
  denyPlayerActions?: (type: string) => string | null;
  /** Called once per observed room `end` (the room fires it on the terminal commit).
   *  `rewards` is the core's session-end table (SES-2: place/xp per seated player) —
   *  the ARS-4 drop roller keys its per-place roll off it. */
  onEnd?: (winner: string | null, rewards?: Record<string, PlayerReward>) => void;
  /** Called per observed domain-event batch (the raw pre-fog server-side stream, M1)
   *  — the ARS-4 salvage counter reads `battle.resolved`/`unit.died` from it. */
  onEvents?: (events: DomainEvent[]) => void;
}

/**
 * Rebuild a LIVE, fully-wired room from its durable snapshot (persist + clock
 * driver), or null if no such match exists in the store. The registry calls
 * this on demand; `dispose` persists the final state and stops the driver when
 * the match hibernates or the server stops.
 */
export function createMatchLoader(deps: MatchLoaderDeps): (matchId: string) => Promise<LoadedMatch | null> {
  const { stores, data } = deps;
  const now = deps.now ?? ((): number => Date.now());
  return async (matchId: string): Promise<LoadedMatch | null> => {
    const snap = await stores.store.load(matchId);
    if (!snap) return null;
    const initialReceipts = await stores.receiptStore.loadAll(matchId);
    const extras = (await deps.matchExtras?.(matchId)) ?? null;

    let driver: ClockDriverHandle | null = null;
    // Strict commit-before-broadcast: the room awaits this durable write of the new
    // snapshot + receipt before committing state / broadcasting the delta.
    const persist = async (snapshot: MatchSnapshot, receipt: StoredReceipt): Promise<void> => {
      await stores.store.save(snapshot);
      await stores.receiptStore.save(matchId, receipt);
    };
    // The committed path already persists each action; `observe` re-arms the driver
    // (an action may have scheduled a new event the sleeping timer can't see) and
    // hands a terminal `end` to the extras hook (the AvA settlement path).
    const observe = (event: RoomObservation): void => {
      if (event.kind === 'action') driver?.reschedule();
      if (event.kind === 'end') extras?.onEnd?.(event.winner, event.rewards);
      if (event.kind === 'events') extras?.onEvents?.(event.events);
    };

    const room = createDevMatch(data, {
      id: matchId,
      now,
      observe,
      persist,
      initialState: snap.state,
      initialReceipts,
      initialSeq: snap.seq,
      gate: deps.gateFactory?.(),
      ...(extras?.denyPlayerActions ? { denyPlayerActions: extras.denyPlayerActions } : {}),
    });

    // The 24/7 heartbeat while this match is live: fire due scheduled events with no
    // player action, persisting each advance. (While hibernated, the registry's wake
    // timer does it.)
    driver = startClockDriver(room, {
      onTick: () => void stores.store.save(snapshotOf(room)),
      onStall: () => deps.onStall?.(matchId),
    });

    const dispose = async (): Promise<void> => {
      driver?.stop();
      await stores.store.save(snapshotOf(room));
    };
    return { room, dispose };
  };
}
