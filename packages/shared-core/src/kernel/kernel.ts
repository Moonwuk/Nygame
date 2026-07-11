import type { GameState, ScheduledEvent } from '../state/gameState';
import type {
  Action,
  AdvanceFailure,
  AdvanceResult,
  ApplyResult,
  Context,
  DomainEvent,
} from '../action/types';
import { Rejection } from '../action/types';
import { Rng } from '../rng/rng';
import { deepClone } from '../util/clone';
import type {
  ActionHandler,
  EventHandler,
  GameModule,
  HandlerContext,
  HookFn,
  ModuleManifest,
  ModuleSetupApi,
} from './module';

interface OrderedEntry {
  priority: number;
  index: number;
}

interface EventSub extends OrderedEntry {
  handler: EventHandler;
}

interface HookEntry extends OrderedEntry {
  fn: HookFn<unknown>;
}

type StepResult =
  | { ok: true; state: GameState; events: DomainEvent[] }
  | { ok: false; code: string };

/** Fail-secure guard against a runaway event chain within a single step (e.g. a
 *  trait that re-triggers itself). Hitting it rejects the step (OWASP A10). */
const MAX_EVENTS_PER_STEP = 10_000;

/** Fail-secure guard against a runaway timeline (e.g. a recurring event that
 *  reschedules itself at the same instant). Caps the number of timeline steps a
 *  single `advanceTo` will take. */
const MAX_ADVANCE_STEPS = 100_000;

/** The reserved event the kernel emits for each contiguous span of continuous
 *  time, so modules can accrue rate-based quantities (resources) by formula. */
const TIME_ADVANCED = 'time.advanced';

function byOrder(a: OrderedEntry, b: OrderedEntry): number {
  return a.priority - b.priority || a.index - b.index;
}

/** Earliest scheduled event with `at <= now`. The `scheduled` array is kept
 *  sorted by `(at, seq)`, so this is O(1) — just check the head. */
function earliestDue(scheduled: readonly ScheduledEvent[], now: number): ScheduledEvent | null {
  const first = scheduled[0];
  return first !== undefined && first.at <= now ? first : null;
}

/** Binary-search insertion point in a `(at, seq)`-sorted scheduled array. */
function scheduledInsertPos(arr: readonly ScheduledEvent[], at: number, seq: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const m = arr[mid]!;
    if (m.at < at || (m.at === at && m.seq < seq)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The immutable microkernel: state container boundary, action dispatcher, world
 * clock, event bus, hook pipelines, capability registry and seeded RNG wiring
 * (docs/modulesystem.md). Compiled once from an ordered list of modules, it then
 * only ever reads its own tables — so `applyAction` and `advanceTo` stay pure
 * functions of their inputs.
 */
export class Kernel {
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly eventSubs = new Map<string, EventSub[]>();
  private readonly hooks = new Map<string, HookEntry[]>();
  private readonly capabilities = new Map<string, unknown>();
  readonly manifest: ModuleManifest;

  constructor(modules: readonly GameModule[]) {
    const manifest: ModuleManifest = { modules: [] };
    let registrationCounter = 0;

    modules.forEach((module, priority) => {
      const api: ModuleSetupApi = {
        onAction: (type, handler) => {
          if (this.actionHandlers.has(type)) {
            throw new Error(`Duplicate action handler for "${type}" (module "${module.id}")`);
          }
          this.actionHandlers.set(type, handler);
        },
        on: (eventType, handler) => {
          const list = this.eventSubs.get(eventType) ?? [];
          list.push({ priority, index: registrationCounter++, handler });
          this.eventSubs.set(eventType, list);
        },
        hook: (name, fn) => {
          const list = this.hooks.get(name) ?? [];
          list.push({ priority, index: registrationCounter++, fn: fn as HookFn<unknown> });
          this.hooks.set(name, list);
        },
        provideCapability: (name, impl) => {
          if (this.capabilities.has(name)) {
            throw new Error(`Duplicate capability "${name}" (module "${module.id}")`);
          }
          this.capabilities.set(name, impl);
        },
      };
      module.setup(api);
      manifest.modules.push({ id: module.id, version: module.version });
    });

    // Lock deterministic ordering: module priority first, then registration order.
    for (const list of this.eventSubs.values()) {
      list.sort(byOrder);
    }
    for (const list of this.hooks.values()) {
      list.sort(byOrder);
    }

    this.manifest = manifest;
  }

  /**
   * The pure reducer (docs/roadmap.md, first step): same (state, action,
   * context) always yields the same result. The input state is never mutated;
   * all work happens on a clone, committed only on success.
   *
   * In the real-time flow the server first calls `advanceTo(state, now)` to
   * bring the world to the present, then `applyAction` to apply the player's
   * intent at that instant.
   */
  applyAction(state: GameState, action: Action, ctx: Context): ApplyResult {
    const handler = this.actionHandlers.get(action.type);
    if (!handler) {
      // Fail-secure: an unknown action type is rejected, never silently ignored.
      return { ok: false, code: 'E_UNKNOWN_ACTION' };
    }
    // Terminal gate (BF-34): once the match is decided, the world is frozen — a
    // player intent must not keep mutating (and persisting) a finished game. A
    // future victory-lap grace window would relax THIS check; the fail-secure
    // default is to reject. Scheduled events (advanceTo) still settle any battle
    // that was already in flight — this bars only new player-driven change.
    if (state.match.status === 'ended') {
      return { ok: false, code: 'E_MATCH_ENDED' };
    }
    // Monotonic time guard: the server clock must not move backwards mid-match.
    if (ctx.now < state.time) {
      return { ok: false, code: 'E_TIME_BACKWARDS' };
    }
    // A due-but-unfired scheduled event must not be jumped over (bug-hunt MAJOR):
    // stamping the draft at ctx.now would strand a PAST event in the queue, and the
    // next advanceTo would fire it with a rewound clock and re-accrue an already-
    // lived span (resource inflation). The real-time flow advances first; a gap
    // here means the catch-up is lagging — reject transiently, caller advances.
    if (state.scheduled.some((e) => e.at < ctx.now)) {
      return { ok: false, code: 'E_TIME_GAP' };
    }

    const outcome = this.runStep(state, ctx, ctx.now, (h) => handler(action, h));
    if (!outcome.ok) {
      return { ok: false, code: outcome.code };
    }
    return { ok: true, state: outcome.state, events: outcome.events };
  }

  /**
   * Advances the world clock to `ctx.now`, firing every scheduled event due in
   * between, in chronological (`at`, then `seq`) order. This is what makes the
   * game real-time: durations are scheduled events, and the server "sleeps"
   * until the next one (docs/architecture.md §4.1).
   *
   * Between consecutive event instants the kernel emits a `time.advanced`
   * { from, to } event covering that exact span, so modules accrue continuous
   * quantities (resource production) by formula rather than by ticking. The
   * spans are contiguous and cover [state.time, now] exactly.
   *
   * A scheduled event whose handler throws is dropped into `failures` (dead-
   * lettered) and the timeline keeps moving — the world never gets stuck.
   */
  advanceTo(state: GameState, ctx: Context): AdvanceResult {
    if (ctx.now < state.time) {
      return { ok: false, code: 'E_TIME_BACKWARDS' };
    }

    // Normalize: ensure the scheduled array is (at, seq)-sorted so that
    // earliestDue is O(1).  After this initial sort the kernel's sorted
    // insert (binary-search splice) keeps the invariant for all new events.
    let committed: GameState =
      state.scheduled.length > 1
        ? {
            ...state,
            scheduled: [...state.scheduled].sort((a, b) => a.at - b.at || a.seq - b.seq),
          }
        : state;
    const events: DomainEvent[] = [];
    const failures: AdvanceFailure[] = [];
    let guard = 0;

    for (;;) {
      if (++guard > MAX_ADVANCE_STEPS) {
        // Hit the per-call work bound before reaching `now`. Rather than discard the
        // (fully deterministic) progress made so far and wedge the room on every
        // retry, YIELD it as a partial advance: `committed` holds exactly the first
        // MAX_ADVANCE_STEPS steps in (at, seq) order, and the caller continues from
        // `committed.time`. A genuine same-instant runaway leaves `committed.time`
        // unmoved, which the caller detects (no progress) and surfaces — the kernel
        // just refuses to hang or to lose work.
        return { ok: true, state: committed, events, failures, partial: true };
      }

      const next = earliestDue(committed.scheduled, ctx.now);
      if (next) {
        // Accrue continuous time up to the event FIRST, then loop to re-read the
        // head. `accrue` emits `time.advanced`, whose handlers may legitimately
        // schedule new (possibly earlier) events — so the captured `next` must NOT
        // be carried across the accrue boundary, or we'd drop the fresher head and
        // dispatch a stale one (events out of (at, seq) order). Once accrued, the
        // head is due at the current instant and handled by the branch below.
        if (next.at > committed.time) {
          committed = this.accrue(committed, ctx, next.at, events, failures);
          continue;
        }
        // Head is due now (at === committed.time): remove it (index 0 in sorted
        // order) before dispatch so a failing handler cannot wedge the timeline.
        // Clamp the step instant to the committed clock: an event stranded in the
        // PAST (a host that jumped the clock over it, or an old persisted state)
        // fires LATE, never rewinding time — a rewound step would re-accrue a span
        // the economy already settled.
        const stepTime = Math.max(next.at, committed.time);
        const base: GameState = {
          ...committed,
          scheduled: committed.scheduled.slice(1),
        };
        const step = this.runStep(base, ctx, stepTime, (h) => h.emit(next.type, next.payload));
        if (step.ok) {
          committed = step.state;
          events.push(...step.events);
        } else {
          failures.push({ at: stepTime, type: next.type, code: step.code });
          committed = { ...base, time: stepTime };
        }
        continue;
      }

      // No more due events — accrue the final span up to the target time.
      if (ctx.now > committed.time) {
        committed = this.accrue(committed, ctx, ctx.now, events, failures);
      }
      break;
    }

    return { ok: true, state: committed, events, failures };
  }

  /** Emits a `time.advanced` span [committed.time, to] as one atomic step. */
  private accrue(
    committed: GameState,
    ctx: Context,
    to: number,
    events: DomainEvent[],
    failures: AdvanceFailure[],
  ): GameState {
    const from = committed.time;
    const seg = this.runStep(committed, ctx, to, (h) => h.emit(TIME_ADVANCED, { from, to }));
    if (seg.ok) {
      events.push(...seg.events);
      return seg.state;
    }
    failures.push({ at: to, type: TIME_ADVANCED, code: seg.code });
    return { ...committed, time: to };
  }

  /**
   * Runs one atomic unit of work on a clone of `base`: build the handler
   * context, run `run`, drain emitted events in deterministic FIFO order, then
   * commit (persist RNG progress, stamp `stepTime`). On any error nothing is
   * committed and a code is returned (fail-secure, no detail leak). RNG consumed
   * by a failed step is discarded with the clone — so a step is all-or-nothing.
   */
  private runStep(
    base: GameState,
    ctx: Context,
    stepTime: number,
    run: (h: HandlerContext) => void,
  ): StepResult {
    const draft = deepClone(base);
    const rng = new Rng(draft.rng);
    const emitted: DomainEvent[] = [];
    let processed = 0;

    // Handlers see the time of THIS step (the event/segment instant), not the
    // final advance target — so `ctx.now` and `state.time` always agree.
    const stepCtx: Context = ctx.now === stepTime ? ctx : { ...ctx, now: stepTime };

    const h: HandlerContext = {
      state: draft,
      ctx: stepCtx,
      rng,
      emit: (type, payload) => {
        emitted.push({ type, payload: payload ?? null });
      },
      schedule: (at, type, payload) => {
        // Fail-secure (invariant #4): a non-finite instant would corrupt the (at,seq)
        // sort (NaN defeats every comparison → an immortal zombie event the dead-
        // letter never sees) and break GameState JSON round-trips (NaN/Infinity →
        // null in JSONB). Reject the whole step atomically instead.
        if (!Number.isFinite(at)) {
          throw new Rejection('E_BAD_SCHEDULE');
        }
        // Clamp against THIS step's instant, not draft.time (which is only stamped
        // to stepTime at the end of runStep — during the handler it's still the
        // previous committed time, which would let an event land in the past).
        const safeAt = at < stepTime ? stepTime : at;
        const seq = draft.scheduleSeq++;
        const event: ScheduledEvent = { id: `evt:${seq}`, at: safeAt, type, payload: payload ?? null, seq };
        // Sorted insert keeps the array in (at, seq) order so earliestDue is O(1).
        const pos = scheduledInsertPos(draft.scheduled, safeAt, seq);
        draft.scheduled.splice(pos, 0, event);
      },
      hook: <T>(name: string, baseValue: T, args?: unknown): T => {
        const entries = this.hooks.get(name);
        if (!entries) {
          return baseValue; // No contributor → base default. Never a crash.
        }
        let value: unknown = baseValue;
        for (const entry of entries) {
          value = entry.fn(value, args ?? null, h);
        }
        return value as T;
      },
      capability: <T>(name: string): T | undefined => {
        return this.capabilities.get(name) as T | undefined;
      },
      reject: (code: string): never => {
        throw new Rejection(code);
      },
    };

    try {
      run(h);
      // Drain emitted events in deterministic FIFO order: `emitted` doubles as the
      // work queue (handlers may append while we walk), consumed by a read index —
      // O(1) per event where `shift()` re-indexed the whole tail (O(n²) worst case).
      let head = 0;
      while (head < emitted.length) {
        if (++processed > MAX_EVENTS_PER_STEP) {
          return { ok: false, code: 'E_EVENT_OVERFLOW' };
        }
        const event = emitted[head++]!;
        const subs = this.eventSubs.get(event.type);
        if (!subs) {
          continue; // Nobody listening → event harmlessly fades.
        }
        for (const sub of subs) {
          sub.handler(event, h);
        }
      }
    } catch (err) {
      if (err instanceof Rejection) {
        return { ok: false, code: err.code };
      }
      // A10: any unexpected error becomes a safe rejection; no detail leaks out.
      return { ok: false, code: 'E_INTERNAL' };
    }

    draft.rng = rng.getState();
    draft.time = stepTime;
    return { ok: true, state: draft, events: emitted };
  }
}

/** Builds a kernel from an ordered list of modules (order = priority). */
export function createKernel(modules: readonly GameModule[]): Kernel {
  return new Kernel(modules);
}
