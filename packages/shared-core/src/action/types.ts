import type { GameState, PlayerId } from '../state/gameState';
import type { GameData } from '../data/schemas';

/**
 * The action contract: the client sends an *intention*, never state
 * (docs/architecture.md §5). Authorization, input validation and deduplication
 * live in the action layer (Stage 2); the core reducer assumes an action has
 * already cleared those gates and focuses on applying the rules.
 */
export interface Action {
  /**
   * Idempotency key, formatted `session:player:sequence` (e.g. `kepler:alice:47`).
   * Uniqueness is local to a session+player; dedup is short-lived (minutes).
   * See docs/architecture.md §5 (Idempotency).
   */
  id: string;
  /** Action type, routed to a single module handler (e.g. `fleet.move`). */
  type: string;
  /** The requesting player. */
  playerId: PlayerId;
  /** Type-specific payload, validated by the action layer before it gets here. */
  payload: unknown;
  /** Client-claimed timestamp — recorded, never trusted for logic. */
  issuedAt: number;
}

/** Match-pinned configuration, versioned with the match (GDD §3.1 / §5.2). */
export interface MatchConfig {
  /** Global multiplier on all real-time durations (×1 / ×2 / ×4). */
  timeScale: number;
}

/**
 * Everything the reducer is allowed to read besides the state itself. Time is
 * passed in (never Date.now() — docs/architecture.md §4.2), and game data is
 * the validated, data-driven content.
 */
export interface Context {
  /** Authoritative current time (ms). */
  now: number;
  /** Validated, immutable game data. */
  data: GameData;
  /** Match config (timeScale, …). Absent ⇒ defaults (timeScale 1). */
  config?: MatchConfig;
}

/** Reads the match time-scale from a context, defaulting to ×1. */
export function timeScaleOf(ctx: Context): number {
  const scale = ctx.config?.timeScale;
  return scale && scale > 0 ? scale : 1;
}

/** A fact the simulation announces; modules may react, or it harmlessly fades
 *  if nobody listens (docs/modulesystem.md — graceful degradation). */
export interface DomainEvent {
  type: string;
  payload: unknown;
}

/**
 * Result of applying an action. Fail-secure (OWASP A10): on any failure the
 * caller gets an error code only — never partial state, never error details.
 */
export type ApplyResult =
  | { ok: true; state: GameState; events: DomainEvent[] }
  | { ok: false; code: string };

/** A scheduled event whose handler failed while the world was advanced. The
 *  event is dropped (dead-lettered) so the timeline never gets stuck; details
 *  stay server-side (docs/architecture.md §7). */
export interface AdvanceFailure {
  at: number;
  type: string;
  code: string;
}

/**
 * Result of advancing the world clock. Advancing itself only fails when asked
 * to move backwards (`E_TIME_BACKWARDS`) or on a runaway schedule
 * (`E_ADVANCE_OVERFLOW`); individual misbehaving events are dead-lettered into
 * `failures` and do not abort the advance.
 */
export type AdvanceResult =
  | { ok: true; state: GameState; events: DomainEvent[]; failures: AdvanceFailure[] }
  | { ok: false; code: string };

/**
 * Thrown by a handler to abort the current action safely. Carries a stable
 * error code; details stay server-side (docs/architecture.md §6, A10).
 */
export class Rejection extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'Rejection';
    this.code = code;
  }
}

export interface ActionIdParts {
  session: string;
  player: string;
  sequence: number;
}

/** Parses and validates an action id of the form `session:player:sequence`. */
export function parseActionId(id: string): ActionIdParts | null {
  const parts = id.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [session, player, seqRaw] = parts;
  if (!session || !player || !seqRaw || !/^\d+$/.test(seqRaw)) {
    return null;
  }
  const sequence = Number(seqRaw);
  if (!Number.isSafeInteger(sequence)) {
    return null;
  }
  return { session, player, sequence };
}
