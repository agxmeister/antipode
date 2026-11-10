import type { Task, TaskState, WaitingReason } from '../domain/task.ts';
import { ACTIVE_STATES } from '../domain/task.ts';
import type { Clock } from '../ports/clock.ts';
import { silentLog, type Log } from '../ports/log.ts';
import type { Store } from '../ports/store.ts';
import { usageReadingSchema, type UsageReading, type WindowReader } from '../ports/window-reader.ts';
import type { Coordinator } from './coordinator.ts';
import type { EffectExecutor, EffectGuard } from './effects.ts';

/** The configurable part of the scheduler, read on every tick so a SIGHUP reload applies at once. */
export interface SchedulerPolicy {
  limits: { concurrency: number; open_reviews: number };
  usage: { pause_at_percent: number; poll_interval_ms: number };
}

export interface SchedulerOptions {
  store: Store;
  coordinator: Coordinator;
  executor: Pick<EffectExecutor, 'notify' | 'settle'>;
  windowReader: WindowReader;
  clock: Clock;
  policy: () => SchedulerPolicy;
  log?: Log;
}

/** States counted against `limits.concurrency` (AD-11). */
export const RUNNING_STATES: readonly TaskState[] = ['implementing', 'testing', 'validating', 'triage', 'evidencing', 'verifying', 'integrating'];

/** States counted against `limits.open_reviews`, across all Projects (AD-11). */
export const OPEN_REVIEW_STATES: readonly TaskState[] = ['in_review', 'accept_pending'];

/**
 * States in which a `feature` dependency counts as merged to `main`. `release_failed` counts because
 * the fast-forward to `main` already happened; only the Release step after it failed (AD-13).
 */
export const MERGED_STATES: readonly TaskState[] = ['merged', 'release_failed', 'released'];

/** States whose undo window the tick closes with `undo_expired` (AD-3). */
const UNDO_STATES: readonly TaskState[] = ['accept_pending', 'discard_pending'];

/** Owner notices this module queues; templates arrive with the Telegram stories. */
export const USAGE_WINDOW_WAIT = 'usage_window_wait';
export const USAGE_WINDOW_RESUMED = 'usage_window_resumed';

/** A failing AD-11 gate: a `waiting_reason`, or `dependencies`, which moves the Task to `waiting_on_dependencies`. */
export type Gate = WaitingReason | 'dependencies';

/** Everything the gates read for one `queued` Task, already taken from the database and the last reading. */
export interface GateInput {
  kind: Task['kind'];
  projectPaused: boolean;
  usageHeld: boolean;
  running: number;
  concurrency: number;
  openReviews: number;
  openReviewsLimit: number;
  dependenciesMerged: boolean;
  bootstrapReleased: boolean;
}

/**
 * The AD-11 gates in their fixed order; returns the first that fails, or null when the Task may
 * start. The exclusive-capability hint gate arrives with Recipes and leases (story 1-6).
 */
export function evaluateGates(input: GateInput): Gate | null {
  if (input.projectPaused) return 'paused';
  if (input.usageHeld) return 'usage_window';
  if (input.running >= input.concurrency) return 'concurrency';
  if (input.openReviews >= input.openReviewsLimit) return 'open_reviews';
  if (!input.dependenciesMerged) return 'dependencies';
  if (input.kind !== 'bootstrap' && !input.bootstrapReleased) return 'bootstrap';
  return null;
}

/**
 * Whether a dependency Task has reached `main`: a `feature` Task merged, release-failed or released.
 * A bootstrap Task never counts: it is never integrated or merged, `undo_expired` takes it straight
 * to `released` (AD-13).
 */
export function isMergedToMain(task: Task): boolean {
  return task.kind === 'feature' && MERGED_STATES.includes(task.state);
}

/**
 * The usage hold of a reading: held while either window's utilization is at or above
 * `pauseAtPercent`, until the latest `resets_at` of the full windows. A window whose `resets_at` is
 * not after `now` has already reset and does not hold. No reading leaves the gate open.
 */
export function usageHold(reading: UsageReading | null, pauseAtPercent: number, now: Date): { resets_at: string } | null {
  if (reading === null) {
    return null;
  }
  const full = [reading.five_hour, reading.weekly].filter(
    (window) => window.utilization >= pauseAtPercent && Date.parse(window.resets_at) > now.getTime(),
  );
  if (full.length === 0) {
    return null;
  }
  const latest = Math.max(...full.map((window) => Date.parse(window.resets_at)));
  return { resets_at: new Date(latest).toISOString() };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The AD-11 scheduler. Each tick refreshes the usage reading when due, closes expired undo windows,
 * resolves `waiting_on_dependencies` Tasks, runs the gates over `queued` Tasks oldest first and
 * releases launch holds. Gates read only the database and the last reading; every state change is a
 * Coordinator event, awaited one Task at a time so a start counts against the next Task's check.
 */
export class Scheduler {
  readonly #store: Store;
  readonly #coordinator: Coordinator;
  readonly #executor: Pick<EffectExecutor, 'notify' | 'settle'>;
  readonly #windowReader: WindowReader;
  readonly #clock: Clock;
  readonly #policy: () => SchedulerPolicy;
  readonly #log: Log;
  #reading: UsageReading | null = null;
  #lastPollMono: number | undefined;
  #polling: Promise<void> | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#executor = options.executor;
    this.#windowReader = options.windowReader;
    this.#clock = options.clock;
    this.#policy = options.policy;
    this.#log = options.log ?? silentLog;
  }

  /** The last usage reading, or null when there is none or it was unreadable. */
  reading(): UsageReading | null {
    return this.#reading;
  }

  /** One tick; joins the tick in flight instead of starting a second. Never rejects. */
  tick(): Promise<void> {
    this.#inFlight ??= this.#run().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  /** Resolves once the tick in flight, if any, has finished; never starts one. */
  idle(): Promise<void> {
    return this.#inFlight ?? Promise.resolve();
  }

  /**
   * The launch gate (AD-3, AD-11), registered on the executor for `start_stage`: while the window is
   * full a launch whose Stage is still `starting` stays pending, its Task shows `usage_window` and the
   * wait notice is queued once per `resets_at`. Running Stages are never touched.
   */
  readonly launchGuard: EffectGuard = async (row) => {
    const effect = row.effect;
    if (effect.kind !== 'start_stage') {
      return 'run';
    }
    if (this.#lastPollMono === undefined || this.#polling !== undefined) {
      // Never polled yet (boot recovery, the first second) or a poll is in flight: gate on a real reading.
      await this.#refreshReading();
    }
    const hold = this.#hold();
    if (hold === null) {
      return 'run';
    }
    const task = this.#store.getTask(effect.task_id);
    if (task === undefined || task.current_stage_id !== effect.stage_id || this.#store.getStage(effect.stage_id)?.status !== 'starting') {
      // Not a live launch any more; the handler settles it.
      return 'run';
    }
    await this.#coordinator.setWaitingReason(task.id, 'usage_window');
    await this.#notifyWait(task.id, hold.resets_at);
    return 'held';
  };

  async #run(): Promise<void> {
    try {
      await this.#refreshReading();
      const steps: Array<[string, () => Promise<void>]> = [
        ['undo_expiry', () => this.#expireUndo()],
        ['dependencies', () => this.#resolveDependencies()],
        ['queued', () => this.#startQueued()],
        ['launch_holds', () => this.#releaseLaunchHolds()],
      ];
      for (const [step, run] of steps) {
        try {
          await run();
        } catch (error) {
          this.#log.error({ event: 'scheduler_step_failed', step, error: message(error) }, 'scheduler_step_failed');
        }
      }
    } catch (error) {
      this.#log.error({ event: 'scheduler_tick_failed', error: message(error) }, 'scheduler_tick_failed');
    }
  }

  #hold(): { resets_at: string } | null {
    return usageHold(this.#reading, this.#policy().usage.pause_at_percent, this.#clock.now());
  }

  /**
   * Polls the reader every `usage.poll_interval_ms`; joins a poll in flight. A throw, an invalid reading
   * or no answer within `usage.poll_interval_ms` leaves the gate open.
   */
  #refreshReading(): Promise<void> {
    if (this.#polling !== undefined) {
      return this.#polling;
    }
    const mono = this.#clock.monotonicMs();
    if (this.#lastPollMono !== undefined && mono - this.#lastPollMono < this.#policy().usage.poll_interval_ms) {
      return Promise.resolve();
    }
    this.#lastPollMono = mono;
    this.#polling = this.#poll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  async #poll(): Promise<void> {
    const timeoutMs = this.#policy().usage.poll_interval_ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`usage window read timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const reading = await Promise.race([this.#windowReader.read(), timeout]);
      this.#reading = reading === null ? null : usageReadingSchema.parse(reading);
    } catch (error) {
      this.#reading = null;
      this.#log.warn({ event: 'usage_window_unreadable', error: message(error) }, 'usage_window_unreadable');
    } finally {
      clearTimeout(timer);
    }
  }

  async #expireUndo(): Promise<void> {
    const now = this.#clock.now().getTime();
    for (const task of this.#store.tasksInStates(UNDO_STATES)) {
      if (task.undo_expires_at !== null && Date.parse(task.undo_expires_at) <= now) {
        await this.#coordinator.applyEvent(task.id, { type: 'undo_expired' });
      }
    }
  }

  async #resolveDependencies(): Promise<void> {
    for (const task of this.#store.tasksInStates(['waiting_on_dependencies'])) {
      const deps = this.#store.dependenciesOf(task.id);
      const cancelled = deps.find((dep) => dep.state === 'cancelled');
      if (cancelled !== undefined) {
        const label = cancelled.task_no === null ? cancelled.id : `#${cancelled.task_no}`;
        await this.#coordinator.applyEvent(task.id, { type: 'deps_unsatisfiable', reason: `dependency ${label} was cancelled` });
      } else if (deps.every(isMergedToMain)) {
        await this.#coordinator.applyEvent(task.id, { type: 'deps_merged' });
      }
    }
  }

  async #startQueued(): Promise<void> {
    for (const { id } of this.#store.queuedTasks()) {
      // Fresh read per Task: the previous Task's start or any event since the list was taken counts.
      const task = this.#store.getTask(id);
      if (task === undefined || task.state !== 'queued') {
        continue;
      }
      const policy = this.#policy();
      const hold = this.#hold();
      const gate = evaluateGates({
        kind: task.kind,
        projectPaused: this.#store.getProject(task.project_id)?.paused_at != null,
        usageHeld: hold !== null,
        running: this.#store.countTasksInStates(RUNNING_STATES),
        concurrency: policy.limits.concurrency,
        openReviews: this.#store.countTasksInStates(OPEN_REVIEW_STATES),
        openReviewsLimit: policy.limits.open_reviews,
        dependenciesMerged: this.#store.dependenciesOf(task.id).every(isMergedToMain),
        bootstrapReleased: this.#store.bootstrapReleased(task.project_id),
      });
      if (gate === null) {
        await this.#coordinator.applyEvent(task.id, { type: 'scheduler_start' });
      } else if (gate === 'dependencies') {
        await this.#coordinator.applyEvent(task.id, { type: 'deps_unmerged' });
      } else {
        await this.#coordinator.setWaitingReason(task.id, gate);
        if (gate === 'usage_window' && hold !== null) {
          await this.#notifyWait(task.id, hold.resets_at);
        }
      }
      // Resumed only once the hold is over, not when a held Task moves to an earlier gate (e.g. paused)
      // while the window is still full; a wait announced then is answered when the window reopens.
      if (hold === null) {
        await this.#notifyResumed(task.id);
      }
    }
  }

  /** Window open again: clear every launch hold and wake the executor to run the held launches. */
  async #releaseLaunchHolds(): Promise<void> {
    if (this.#hold() !== null) {
      return;
    }
    const held = this.#store
      .tasksInStates(ACTIVE_STATES.filter((state) => state !== 'queued'))
      .filter((task) => task.waiting_reason === 'usage_window');
    for (const task of held) {
      await this.#coordinator.setWaitingReason(task.id, null);
      await this.#notifyResumed(task.id);
    }
    if (held.length > 0) {
      // A notify during a drain in flight would join it, and that drain skips the rows it already held:
      // let it settle, then start a fresh drain that asks the guard again.
      await this.#executor.settle();
      this.#executor.notify();
    }
  }

  #notifyWait(taskId: string, resetsAt: string): Promise<boolean> {
    return this.#coordinator.notifyOnce(taskId, USAGE_WINDOW_WAIT, resetsAt, { resets_at: resetsAt });
  }

  /** One resumed notice per announced hold, keyed like the wait notice it answers; none if no wait was sent. */
  async #notifyResumed(taskId: string): Promise<void> {
    const wait = this.#store.latestNotify(taskId, USAGE_WINDOW_WAIT);
    const key = wait?.effect.kind === 'notify' ? wait.effect.payload?.['key'] : undefined;
    if (typeof key === 'string' && this.#store.latestNotify(taskId, USAGE_WINDOW_RESUMED, key) === undefined) {
      await this.#coordinator.notifyOnce(taskId, USAGE_WINDOW_RESUMED, key, { resets_at: key });
    }
  }
}
