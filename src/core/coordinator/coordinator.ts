import type { Effect, EffectRow } from '../domain/effects.ts';
import { AntipodError } from '../domain/errors.ts';
import type { CreationEventType, Event, IgnoreReason } from '../domain/events.ts';
import { ulid } from '../domain/ids.ts';
import type { Clock } from '../ports/clock.ts';
import { silentLog, type Log } from '../ports/log.ts';
import type { Store } from '../ports/store.ts';
import { projectSchema, taskSchema, type Project, type Task, type TaskKind, type TaskState } from '../domain/task.ts';
import { DEFAULT_STAGE_RETRIES, transition, type TransitionContext } from './transitions.ts';

/** The configurable part of the FSM, read on every event so a SIGHUP reload applies at once. */
export interface CoordinatorPolicy {
  limits: { iteration_budget: number; undo_accept_ms: number; undo_discard_ms: number };
  roles: Readonly<Record<string, { retries: number }>>;
}

export interface CoordinatorOptions {
  store: Store;
  clock: Clock;
  policy: () => CoordinatorPolicy;
  log?: Log;
  newId?: () => string;
  /** Called after every committed transaction that inserted effects; the executor's `notify`. */
  onEffectsCommitted?: () => void;
}

export type ApplyResult =
  | { applied: true; state: TaskState; effects: number }
  | { applied: false; ignored: IgnoreReason };

export interface CreateTaskInput {
  project_id: string;
  kind: TaskKind;
  budget_limit?: number;
  config_sha?: string | null;
}

export class TaskNotFoundError extends AntipodError {
  constructor(taskId: string) {
    super('task_not_found', `task ${taskId} does not exist`);
  }
}

export class ProjectNotFoundError extends AntipodError {
  constructor(projectId: string) {
    super('project_not_found', `project ${projectId} does not exist`);
  }
}

/**
 * The only writer of Task state (AD-3). Every call enters one in-process serial queue; the work
 * itself is synchronous and runs in one `Store.transaction`. Nothing here calls an adapter.
 */
export class Coordinator {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #policy: () => CoordinatorPolicy;
  readonly #log: Log;
  readonly #newId: () => string;
  #onEffectsCommitted: () => void;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: CoordinatorOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#policy = options.policy;
    this.#log = options.log ?? silentLog;
    this.#newId = options.newId ?? ulid;
    this.#onEffectsCommitted = options.onEffectsCommitted ?? (() => {});
  }

  /** Replaces the post-commit hook; used by the composition root once the executor exists. */
  onEffectsCommitted(hook: () => void): void {
    this.#onEffectsCommitted = hook;
  }

  /** Resolves once every call queued so far has settled; nothing is left to run against the store. */
  idle(): Promise<void> {
    return this.#tail.then(() => undefined);
  }

  /** Runs `fn` after everything queued before it; the queue never stalls on a failure. */
  #enqueue<T>(fn: () => T): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  createProject(name: string): Promise<Project> {
    return this.#enqueue(() =>
      this.#store.transaction(() => {
        const project = projectSchema.parse({ id: this.#newId(), name, paused_at: null, created_at: this.#now() });
        this.#store.insertProject(project);
        return project;
      }),
    );
  }

  /** `new_draft` (kind `feature`, state `draft`) or `bootstrap_created` (kind `bootstrap`, state `queued`). */
  createTask(input: CreateTaskInput): Promise<Task> {
    return this.#enqueue(() =>
      this.#store.transaction(() => {
        if (this.#store.getProject(input.project_id) === undefined) {
          throw new ProjectNotFoundError(input.project_id);
        }
        const now = this.#now();
        const bootstrap = input.kind === 'bootstrap';
        const creation: CreationEventType = bootstrap ? 'bootstrap_created' : 'new_draft';
        const task: Task = taskSchema.parse({
          id: this.#newId(),
          project_id: input.project_id,
          kind: input.kind,
          task_no: bootstrap ? this.#store.nextTaskNo(input.project_id) : null,
          state: bootstrap ? 'queued' : 'draft',
          current_stage_id: null,
          budget_used: 0,
          budget_limit: input.budget_limit ?? this.#policy().limits.iteration_budget,
          review_round: 0,
          resume_state: null,
          stuck_reason: null,
          waiting_reason: null,
          undo_expires_at: null,
          config_sha: input.config_sha ?? null,
          created_at: now,
          updated_at: now,
        });
        this.#store.insertTask(task);
        this.#store.appendStageEvent({
          id: this.#newId(),
          task_id: task.id,
          stage_id: null,
          event_type: creation,
          payload: JSON.stringify({ type: creation }),
          status: 'applied',
          ignore_reason: null,
          from_state: null,
          to_state: task.state,
          created_at: now,
        });
        return task;
      }),
    );
  }

  /** Applies one event to one Task: state, `stage_events` and `effects` in one transaction, then notifies the executor. */
  applyEvent(taskId: string, event: Event): Promise<ApplyResult> {
    return this.#enqueue(() => {
      const result = this.#store.transaction(() => this.#applyNow(taskId, event));
      if (result.applied && result.effects > 0) {
        this.#onEffectsCommitted();
      }
      return result;
    });
  }

  /** One `back_online` effect per Project with an ACTIVE Task (AD-18). */
  backOnline(gapMs: number): Promise<number> {
    return this.#enqueue(() => {
      const count = this.#store.transaction(() => {
        const projects = this.#store.activeProjects();
        for (const project of projects) {
          this.#insertEffect(null, { kind: 'back_online', project_id: project.id, gap_ms: Math.round(gapMs) });
        }
        return projects.length;
      });
      if (count > 0) {
        this.#onEffectsCommitted();
      }
      return count;
    });
  }

  #context(task: Task): TransitionContext {
    const policy = this.#policy();
    return {
      now: this.#clock.now(),
      newId: this.#newId,
      retriesFor: (role) => policy.roles[role]?.retries ?? DEFAULT_STAGE_RETRIES,
      limits: policy.limits,
      nextTaskNo: () => this.#store.nextTaskNo(task.project_id),
    };
  }

  #applyNow(taskId: string, event: Event): ApplyResult {
    const task = this.#store.getTask(taskId);
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const stage = task.current_stage_id === null ? undefined : this.#store.getStage(task.current_stage_id);
    const now = this.#now();
    const outcome = transition(task, stage, event, this.#context(task));
    const stageId = 'stage_id' in event ? event.stage_id : (task.current_stage_id ?? null);

    if (outcome.ignored !== undefined) {
      this.#store.appendStageEvent({
        id: this.#newId(),
        task_id: task.id,
        stage_id: stageId,
        event_type: event.type,
        payload: JSON.stringify(event),
        status: 'ignored',
        ignore_reason: outcome.ignored,
        from_state: task.state,
        to_state: null,
        created_at: now,
      });
      this.#log.debug(
        { event: 'event_ignored', task_id: task.id, stage_id: stageId, event_type: event.type, reason: outcome.ignored, state: task.state },
        'event_ignored',
      );
      return { applied: false, ignored: outcome.ignored };
    }

    if (outcome.stageUpdate !== undefined && stage !== undefined) {
      const update = outcome.stageUpdate;
      this.#store.updateStage(stage.id, {
        status: update.status,
        reason: update.reason,
        ...(update.status === 'running' ? { started_at: now } : { ended_at: now }),
      });
    }
    if (outcome.startStage !== undefined) {
      this.#store.insertStage({
        id: outcome.startStage.id,
        task_id: task.id,
        role: outcome.startStage.role,
        attempt: outcome.startStage.attempt,
        status: 'starting',
        reason: null,
        created_at: now,
        started_at: null,
        ended_at: null,
      });
    }
    this.#store.updateTask(task.id, { ...outcome.patch, state: outcome.next, updated_at: now });
    this.#store.appendStageEvent({
      id: this.#newId(),
      task_id: task.id,
      stage_id: stageId,
      event_type: event.type,
      payload: JSON.stringify(event),
      status: 'applied',
      ignore_reason: null,
      from_state: task.state,
      to_state: outcome.next,
      created_at: now,
    });
    let effects = 0;
    for (const effect of outcome.effects) {
      this.#insertEffect(task.id, effect);
      effects++;
    }
    this.#log.debug(
      { event: 'event_applied', task_id: task.id, stage_id: stageId, event_type: event.type, from: task.state, to: outcome.next },
      'event_applied',
    );
    let state = outcome.next;
    for (const derived of outcome.derived) {
      const inner = this.#applyNow(task.id, derived);
      if (inner.applied) {
        state = inner.state;
        effects += inner.effects;
      }
    }
    return { applied: true, state, effects };
  }

  #insertEffect(taskId: string | null, effect: Effect): void {
    const row: EffectRow = {
      effect_id: this.#newId(),
      task_id: taskId,
      kind: effect.kind,
      effect,
      status: 'pending',
      error: null,
      created_at: this.#now(),
      finished_at: null,
    };
    this.#store.insertEffect(row);
  }
}
