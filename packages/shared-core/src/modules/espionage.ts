import { hoursToMs } from '../action/types';
import type { GameModule } from '../kernel/module';
import type { IntelGrant } from '../state/gameState';
import { canAfford, payCost } from '../util/treasury';

/**
 * Espionage (SPY-1, the foundation): steal a time-boxed WINDOW of intel through
 * the fog. `espionage.spy` pays a price, rolls the seeded RNG, and on success
 * grants the actor an `IntelGrant` — `visibleState` then lets THEM (and only
 * them) see the granted target live until the window closes:
 *
 *   - `treasury` — the target player's resource bag;
 *   - `planet`   — one world's contents (owner / garrison / buildings);
 *   - `fleets`   — the target player's fleets (position + composition).
 *
 * Price, success chance and window length are value pipelines with base
 * defaults (`espionage.cost` / `espionage.chance` / `espionage.duration`), so
 * tech, factions, buildings or counter-intelligence modules can bend them
 * without touching this module. Failure costs the fee too — spying is a
 * gamble; the failure event is addressed to the actor.
 *
 * Counter-intelligence (SPY-2): every paid attempt also rolls DETECTION for
 * the victim (`espionage.detect` pipeline; base 0.5 after a failed attempt —
 * the agent left tracks — vs 0.25 after a clean success). A detected attempt
 * emits `espionage.detected` addressed to the VICTIM; the thief's identity is
 * included only when the attempt FAILED (an agent caught red-handed) — a
 * successful theft that gets noticed reveals THAT intel leaked, not by whom.
 * The spy is never told they were spotted.
 */

const SPY_KINDS = new Set(['treasury', 'planet', 'fleets']);

/** Base price of one attempt — overridden per-match via the `espionage.cost` hook. */
const BASE_COST = { credits: 150 } as const;
/** Base success chance — the `espionage.chance` pipeline may bend it; the result
 *  is clamped so no stack of modifiers makes spying a certainty or an impossibility. */
const BASE_CHANCE = 0.6;
const CHANCE_MIN = 0.05;
const CHANCE_MAX = 0.95;
/** Base window length, in game-hours (timeScale-compressed like every duration). */
const BASE_DURATION_HOURS = 24;
/** Base odds the VICTIM notices the attempt (`espionage.detect` pipeline bends them;
 *  the result is clamped to [0,1] — hooks may legitimately push to never/always). */
const BASE_DETECT_FAILED = 0.5; // a blown attempt leaves tracks
const BASE_DETECT_SUCCESS = 0.25; // a clean theft is noticed rarer
/** A beneficiary holds at most this many live grants — the oldest one is evicted
 *  first (fail-secure bound: state must not grow without limit). */
const MAX_GRANTS = 8;

interface SpyPayload {
  target?: string;
  kind?: string;
  planetId?: string;
}

export const espionageModule: GameModule = {
  id: 'espionage',
  version: '1.0.0',
  setup(api) {
    api.onAction('espionage.spy', (action, h) => {
      const p = action.payload as SpyPayload;
      if (typeof p?.kind !== 'string' || !SPY_KINDS.has(p.kind)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const actor = h.state.players[action.playerId];
      if (!actor || actor.status !== 'active') {
        return h.reject('E_FORBIDDEN');
      }
      if (typeof p.target !== 'string' || p.target === action.playerId) {
        return h.reject('E_BAD_TARGET');
      }
      const victim = h.state.players[p.target];
      if (!victim || victim.status !== 'active') {
        return h.reject('E_NO_PLAYER');
      }
      // The `planet` kind steals one specific world's contents — it must exist and
      // belong to the target (you spy on a PLAYER's holdings, not on the map).
      let grantTarget = p.target;
      if (p.kind === 'planet') {
        if (typeof p.planetId !== 'string') {
          return h.reject('E_BAD_PAYLOAD');
        }
        const planet = h.state.planets[p.planetId];
        if (!planet) {
          return h.reject('E_NO_PLANET');
        }
        if (planet.owner !== p.target) {
          return h.reject('E_BAD_TARGET'); // not that player's world
        }
        grantTarget = p.planetId;
      }

      const fee = h.hook<Record<string, number>>('espionage.cost', { ...BASE_COST }, {
        playerId: action.playerId,
        target: p.target,
        kind: p.kind,
      });
      if (!canAfford(actor.resources, fee)) {
        return h.reject('E_INSUFFICIENT');
      }
      payCost(actor.resources, fee); // the fee burns on failure too — spying is a gamble

      const rawChance = h.hook<number>('espionage.chance', BASE_CHANCE, {
        playerId: action.playerId,
        target: p.target,
        kind: p.kind,
      });
      const chance = Number.isFinite(rawChance)
        ? Math.min(CHANCE_MAX, Math.max(CHANCE_MIN, rawChance))
        : BASE_CHANCE;
      const succeeded = h.rng.nextFloat() < chance;

      // Counter-intelligence (SPY-2): the detect roll is drawn for EVERY paid
      // attempt — success or failure — so the RNG stream shape does not depend on
      // the outcome (or on what hooks did to the odds).
      const rawDetect = h.hook<number>(
        'espionage.detect',
        succeeded ? BASE_DETECT_SUCCESS : BASE_DETECT_FAILED,
        { playerId: action.playerId, target: p.target, kind: p.kind, succeeded },
      );
      const detectChance = Number.isFinite(rawDetect) ? Math.min(1, Math.max(0, rawDetect)) : 0;
      const detected = h.rng.nextFloat() < detectChance;

      if (!succeeded) {
        // Addressed to the actor (`owner` routes the event through the fog filter).
        h.emit('espionage.failed', { owner: action.playerId, target: p.target, kind: p.kind });
        if (detected) {
          // Caught red-handed: the victim learns the kind AND who sent the agent.
          h.emit('espionage.detected', { owner: p.target, kind: p.kind, spy: action.playerId });
        }
        return;
      }

      const rawHours = h.hook<number>('espionage.duration', BASE_DURATION_HOURS, {
        playerId: action.playerId,
        target: p.target,
        kind: p.kind,
      });
      const hours =
        Number.isFinite(rawHours) && rawHours > 0 ? rawHours : BASE_DURATION_HOURS;
      const grant: IntelGrant = {
        kind: p.kind as IntelGrant['kind'],
        target: grantTarget,
        until: h.ctx.now + hoursToMs(h.ctx, hours),
      };
      const mine = ((h.state.intel ??= {})[action.playerId] ??= []);
      mine.push(grant);
      while (mine.length > MAX_GRANTS) mine.shift(); // oldest window evicted first
      h.emit('intel.stolen', {
        owner: action.playerId,
        target: p.target,
        kind: p.kind,
        until: grant.until,
        ...(p.kind === 'planet' ? { intelPlanet: grantTarget } : {}),
      });
      if (detected) {
        // A noticed CLEAN theft: the victim learns the leak's kind, not the thief.
        h.emit('espionage.detected', { owner: p.target, kind: p.kind });
      }
    });

    // Housekeeping: expired windows are dropped as time advances, so persisted
    // state stays small. The projection independently ignores expired grants —
    // this is cleanup, not the security check.
    api.on('time.advanced', (event, h) => {
      const intel = h.state.intel;
      if (!intel) return;
      const { to } = event.payload as { to: number };
      for (const playerId of Object.keys(intel)) {
        const live = intel[playerId]!.filter((g) => g.until > to);
        if (live.length === 0) delete intel[playerId];
        else if (live.length !== intel[playerId]!.length) intel[playerId] = live;
      }
      if (Object.keys(intel).length === 0) delete h.state.intel;
    });
  },
};
