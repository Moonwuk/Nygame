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

/** Earliest scheduled event with `at <= now`, ties broken by `seq`. */
function earliestDue(scheduled: readonly ScheduledEvent[], now: number): ScheduledEvent | null {
  let best: ScheduledEvent | null = null;
  for (const e of scheduled) {
    if (e.at > now) {
      continue;
    }
    if (best === null || e.at < best.at || (e.at === best.at && e.seq < best.seq)) {
      best = e;
    }
  }
  return best;
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
    // Monotonic time guard: the server clock must not move backwards mid-match.
    if (ctx.now < state.time) {
      return { ok: false, code: 'E_TIME_BACKWARDS' };
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

    let committed = state;
    const events: DomainEvent[] = [];
    const failures: AdvanceFailure[] = [];
    let guard = 0;

    for (;;) {
      if (++guard > MAX_ADVANCE_STEPS) {
        return { ok: false, code: 'E_ADVANCE_OVERFLOW' };
      }

      const next = earliestDue(committed.scheduled, ctx.now);
      if (next) {
        // Accrue continuous time from the current instant up to the event.
        if (next.at > committed.time) {
          committed = this.accrue(committed, ctx, next.at, events, failures);
        }
        // Remove the event before dispatch so a failing handler cannot get the
        // timeline stuck — it is dead-lettered instead.
        const base: GameState = {
          ...committed,
          scheduled: committed.scheduled.filter((e) => e.id !== next.id),
        };
        const step = this.runStep(base, ctx, next.at, (h) => h.emit(next.type, next.payload));
        if (step.ok) {
          committed = step.state;
          events.push(...step.events);
        } else {
          failures.push({ at: next.at, type: next.type, code: step.code });
          committed = { ...base, time: next.at };
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
    const queue: DomainEvent[] = [];
    let processed = 0;

    // Handlers see the time of THIS step (the event/segment instant), not the
    // final advance target — so `ctx.now` and `state.time` always agree.
    const stepCtx: Context = ctx.now === stepTime ? ctx : { ...ctx, now: stepTime };

    const h: HandlerContext = {
      state: draft,
      ctx: stepCtx,
      rng,
      emit: (type, payload) => {
        const event: DomainEvent = { type, payload: payload ?? null };
        emitted.push(event);
        queue.push(event);
      },
      schedule: (at, type, payload) => {
        const safeAt = at < draft.time ? draft.time : at;
        const seq = draft.scheduleSeq++;
        draft.scheduled.push({ id: `evt:${seq}`, at: safeAt, type, payload: payload ?? null, seq });
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
      // Drain emitted events in deterministic FIFO order.
      while (queue.length > 0) {
        if (++processed > MAX_EVENTS_PER_STEP) {
          return { ok: false, code: 'E_EVENT_OVERFLOW' };
        }
        const event = queue.shift() as DomainEvent;
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
