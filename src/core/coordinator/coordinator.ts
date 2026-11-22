import type { Effect, EffectRow } from '../domain/effects.ts';
import { AntipodError } from '../domain/errors.ts';
import { stageIdOf, type CreationEventType, type Event, type IgnoreReason } from '../domain/events.ts';
import { stuckCause, triageCause } from '../domain/loop.ts';
import type { EvidenceKind } from '../domain/recipe.ts';
import { ulid } from '../domain/ids.ts';
import type { Clock } from '../ports/clock.ts';
import { silentLog, type Log } from '../ports/log.ts';
import type { Store } from '../ports/store.ts';
import { projectSchema, taskSchema, waitingReasonSchema, type Project, type Task, type TaskKind, type TaskState, type WaitingReason } from '../domain/task.ts';
import { approvalRefusal, bumpContract, resolveDependencies } from './drafts.ts';
import { DEFAULT_STAGE_RETRIES, DRAFT_CARD, transition, type TransitionContext } from './transitions.ts';

/** The Intake Role, whose Stage a draft runs in state `draft` (AD-9). */
export const INTAKE_ROLE = 'intake';

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
  /** What a `new_draft` came from, recorded in its creation event: `{text}` or `{path, blob_sha}`. */
  source?: Record<string, unknown>;
  /** Starts the Intake Stage of a `draft` Task in the same transaction (AD-9). */
  intake?: boolean;
  /** Applies `draft_ready` at once: a complete contract file needs no Stage (AD-5). */
  ready?: boolean;
  /** Rows written with the Task, inside its creation transaction (contract, source, Owner message). */
  rows?: (task: Task) => void;
}

/** Writes rows that belong to an event, inside its transaction, only when the event is applied. */
export type EventRows = (task: Task) => void;

export type ApprovalResult = { ok: true; task_no: number } | { ok: false; reason: string };

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

  /**
   * Inserts a Project; `repoUrl` is the remote it was registered from (null outside registration),
   * `exclusiveCapabilities` the exclusive host capabilities its Recipe names (AD-11).
   */
  createProject(name: string, repoUrl: string | null = null, exclusiveCapabilities: readonly string[] = []): Promise<Project> {
    return this.#enqueue(() =>
      this.#store.transaction(() => {
        const project = projectSchema.parse({
          id: this.#newId(),
          name,
          paused_at: null,
          telegram_chat_id: null,
          repo_url: repoUrl,
          exclusive_capabilities: [...exclusiveCapabilities],
          created_at: this.#now(),
        });
        this.#store.insertProject(project);
        return project;
      }),
    );
  }

  /** `new_draft` (kind `feature`, state `draft`) or `bootstrap_created` (kind `bootstrap`, state `queued`). */
  createTask(input: CreateTaskInput): Promise<Task> {
    return this.#enqueue(() => {
      const created = this.#store.transaction(() => {
        if (this.#store.getProject(input.project_id) === undefined) {
          throw new ProjectNotFoundError(input.project_id);
        }
        const now = this.#now();
        const bootstrap = input.kind === 'bootstrap';
        const creation: CreationEventType = bootstrap ? 'bootstrap_created' : 'new_draft';
        if (bootstrap && (input.intake === true || input.ready === true)) {
          throw new Error('a bootstrap Task has no draft');
        }
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
        let stageId: string | null = null;
        if (input.intake === true && input.ready !== true) {
          // The `[*] --> draft` arrow starts Intake like any entry to a Stage state (AD-3, AD-9).
          stageId = this.#newId();
          this.#store.insertStage({ id: stageId, task_id: task.id, role: INTAKE_ROLE, attempt: 1, status: 'starting', reason: null, created_at: now, started_at: null, ended_at: null });
          this.#store.updateTask(task.id, { current_stage_id: stageId, updated_at: now });
        }
        this.#store.appendStageEvent({
          id: this.#newId(),
          task_id: task.id,
          stage_id: stageId,
          event_type: creation,
          payload: JSON.stringify(input.source === undefined ? { type: creation } : { type: creation, source: input.source }),
          status: 'applied',
          ignore_reason: null,
          from_state: null,
          to_state: task.state,
          created_at: now,
        });
        let effects = 0;
        if (stageId !== null) {
          this.#insertEffect(task.id, { kind: 'start_stage', stage_id: stageId, task_id: task.id, role: INTAKE_ROLE, attempt: 1 });
          effects++;
        }
        input.rows?.(task);
        if (input.ready === true) {
          const ready = this.#applyNow(task.id, { type: 'draft_ready' });
          if (ready.applied) effects += ready.effects;
        }
        return { task: this.#store.getTask(task.id) ?? task, effects };
      });
      if (created.effects > 0) {
        this.#onEffectsCommitted();
      }
      return created.task;
    });
  }

  /**
   * `approved` (CAP-9): refused with the reason while a question is open, a criterion is infeasible
   * against `evidence_kinds`, or a dependency is missing, a bootstrap Task or a cycle; the card then
   * shows the reason. Applied, it records the dependencies in the same transaction.
   */
  approveDraft(taskId: string, approval: { config_sha: string | null; evidence_kinds: readonly EvidenceKind[] }): Promise<ApprovalResult> {
    return this.#enqueue(() => {
      const result = this.#store.transaction((): ApprovalResult & { effects: number } => {
        const task = this.#requireTask(taskId);
        if (task.state !== 'awaiting_approval') {
          return { ok: false, reason: 'this draft is no longer open', effects: 0 };
        }
        const refusal = approvalRefusal(this.#store, task, approval.evidence_kinds);
        if (refusal !== undefined) {
          this.#insertEffect(task.id, { kind: 'notify', notice_kind: DRAFT_CARD, task_id: task.id, payload: { refusal } });
          return { ok: false, reason: refusal, effects: 1 };
        }
        const deps = resolveDependencies(this.#store, task);
        if ('refusal' in deps) {
          this.#insertEffect(task.id, { kind: 'notify', notice_kind: DRAFT_CARD, task_id: task.id, payload: { refusal: deps.refusal } });
          return { ok: false, reason: deps.refusal, effects: 1 };
        }
        const applied = this.#applyNow(task.id, { type: 'approved', config_sha: approval.config_sha, evidence_kinds: [...approval.evidence_kinds] });
        if (!applied.applied) {
          return { ok: false, reason: 'this draft is no longer open', effects: 0 };
        }
        for (const id of deps.ids) this.#store.insertDependency(task.id, id);
        const numbered = this.#requireTask(task.id);
        return { ok: true, task_no: numbered.task_no as number, effects: applied.effects };
      });
      if (result.effects > 0) this.#onEffectsCommitted();
      const { effects: _effects, ...outcome } = result;
      return outcome;
    });
  }

  /** A quick-answer tap (AD-9): records the answer on the draft row and re-renders the card; no Stage. */
  answerQuestion(taskId: string, qNo: number, answer: string): Promise<boolean> {
    return this.#draftCommand(taskId, () => this.#store.answerQuestion(taskId, qNo, answer));
  }

  /** `Use proposal`: the infeasible criterion takes Intake's substitute (CAP-8); the contract version is bumped. */
  useProposal(taskId: string, acNo: number): Promise<boolean> {
    return this.#draftCommand(taskId, (now) => {
      const criterion = this.#store.criteriaOf(taskId).find((row) => row.ac_no === acNo);
      if (criterion === undefined || criterion.status !== 'active' || criterion.infeasible_proposal === null) return false;
      this.#store.saveCriterion({ ...criterion, infeasible_wanted: null, infeasible_proposal: null });
      bumpContract(this.#store, taskId, now);
      return true;
    });
  }

  /** `Drop ACn`: the criterion keeps its number with `status = dropped` (AD-16); the contract version is bumped. */
  dropCriterion(taskId: string, acNo: number): Promise<boolean> {
    return this.#draftCommand(taskId, (now) => {
      const criterion = this.#store.criteriaOf(taskId).find((row) => row.ac_no === acNo);
      if (criterion === undefined || criterion.status !== 'active') return false;
      this.#store.saveCriterion({ ...criterion, status: 'dropped' });
      bumpContract(this.#store, taskId, now);
      return true;
    });
  }

  /** `Raise budget +2` on the Stuck card (CAP-13): `budget_raised(n)`, back to `implementing` with no budget unit (AD-3). */
  raiseBudget(taskId: string, amount: number): Promise<ApplyResult> {
    return this.applyEvent(taskId, { type: 'budget_raised', amount });
  }

  /** `Confirm cancel` (CAP-13): `cancel` from any non-terminal state; the current Stage is cancelled, the Branch kept (AD-3). */
  cancelTask(taskId: string): Promise<ApplyResult> {
    return this.applyEvent(taskId, { type: 'cancel' });
  }

  /**
   * Re-renders a Task's card without an event (a button that only changes the keyboard, such as
   * `Cancel Task` asking for confirmation): queues one `notify` of `noticeKind` with `payload` while the
   * Task is in `state`. Resolves whether it queued.
   */
  refreshCard(taskId: string, noticeKind: string, state: TaskState, payload: Record<string, unknown>): Promise<boolean> {
    return this.#enqueue(() => {
      const queued = this.#store.transaction(() => {
        if (this.#requireTask(taskId).state !== state) return false;
        this.#insertEffect(taskId, { kind: 'notify', notice_kind: noticeKind, task_id: taskId, payload });
        return true;
      });
      if (queued) this.#onEffectsCommitted();
      return queued;
    });
  }

  /** Queues one `scan_inbox` for the Project unless one is already pending (AD-5). Resolves whether it queued. */
  requestInboxScan(projectId: string): Promise<boolean> {
    return this.#enqueue(() => {
      const queued = this.#store.transaction(() => {
        if (this.#store.getProject(projectId) === undefined) throw new ProjectNotFoundError(projectId);
        const pending = this.#store.pendingEffects().some((row) => row.effect.kind === 'scan_inbox' && row.effect.project_id === projectId);
        if (pending) return false;
        this.#insertEffect(null, { kind: 'scan_inbox', project_id: projectId });
        return true;
      });
      if (queued) this.#onEffectsCommitted();
      return queued;
    });
  }

  /** A button command on a draft in `awaiting_approval`: `change` edits rows; when it did, the card is re-rendered. */
  #draftCommand(taskId: string, change: (now: string) => boolean): Promise<boolean> {
    return this.#enqueue(() => {
      const changed = this.#store.transaction(() => {
        const task = this.#requireTask(taskId);
        if (task.state !== 'awaiting_approval') return false;
        const now = this.#now();
        if (!change(now)) return false;
        this.#store.updateTask(taskId, { updated_at: now });
        this.#insertEffect(taskId, { kind: 'notify', notice_kind: DRAFT_CARD, task_id: taskId });
        return true;
      });
      if (changed) this.#onEffectsCommitted();
      return changed;
    });
  }

  #requireTask(taskId: string): Task {
    const task = this.#store.getTask(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    return task;
  }

  /**
   * Applies one event to one Task: state, `stage_events` and `effects` in one transaction, then notifies
   * the executor. `rows` writes the rows that belong to the event (a draft's contract) in the same
   * transaction, only when the event is applied.
   */
  applyEvent(taskId: string, event: Event, rows?: EventRows): Promise<ApplyResult> {
    return this.#enqueue(() => {
      const result = this.#store.transaction(() => this.#applyNow(taskId, event, rows));
      if (result.applied && result.effects > 0) {
        this.#onEffectsCommitted();
      }
      return result;
    });
  }

  /**
   * Stores the failing scheduler gate as `tasks.waiting_reason` (AD-11). Not an event: no
   * `stage_events` row, and nothing is written when the value is unchanged. Resolves whether it wrote.
   */
  setWaitingReason(taskId: string, reason: WaitingReason | null): Promise<boolean> {
    const value = reason === null ? null : waitingReasonSchema.parse(reason);
    return this.#enqueue(() =>
      this.#store.transaction(() => {
        const task = this.#store.getTask(taskId);
        if (task === undefined) {
          throw new TaskNotFoundError(taskId);
        }
        if (task.waiting_reason === value) {
          return false;
        }
        this.#store.updateTask(taskId, { waiting_reason: value, updated_at: this.#now() });
        this.#log.debug({ event: 'waiting_reason_set', task_id: taskId, waiting_reason: value }, 'waiting_reason_set');
        return true;
      }),
    );
  }

  /**
   * Stores the resolved Role Config `retries` on a Stage attempt when it launches (AD-4, AD-15), so
   * the retry rule of its `stage_failed` reads it. Not an event: no `stage_events` row.
   */
  setStageRetries(stageId: string, retries: number): Promise<void> {
    return this.#enqueue(() =>
      this.#store.transaction(() => {
        this.#store.updateStage(stageId, { retries });
      }),
    );
  }

  /**
   * Queues one `notify` effect of `noticeKind` for a Task unless one with the same `key` already
   * exists in any status; `key` is stored as `payload.key`. Resolves whether it inserted.
   */
  notifyOnce(taskId: string, noticeKind: string, key: string, payload: Record<string, unknown> = {}): Promise<boolean> {
    return this.#enqueue(() => {
      const inserted = this.#store.transaction(() => {
        if (this.#store.getTask(taskId) === undefined) {
          throw new TaskNotFoundError(taskId);
        }
        if (this.#store.latestNotify(taskId, noticeKind, key) !== undefined) {
          return false;
        }
        this.#insertEffect(taskId, { kind: 'notify', notice_kind: noticeKind, task_id: taskId, payload: { ...payload, key } });
        return true;
      });
      if (inserted) {
        this.#onEffectsCommitted();
      }
      return inserted;
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
      approvalRefusal: (event) => approvalRefusal(this.#store, task, event.evidence_kinds),
      hasContract: () => this.#store.latestContract(task.id) !== undefined,
      triageCause: () => triageCause(this.#store.stageEventsOfTask(task.id)),
      stuckCause: () => stuckCause(this.#store.stageEventsOfTask(task.id)),
    };
  }

  #applyNow(taskId: string, event: Event, rows?: EventRows): ApplyResult {
    const task = this.#store.getTask(taskId);
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const stage = task.current_stage_id === null ? undefined : this.#store.getStage(task.current_stage_id);
    const now = this.#now();
    const outcome = transition(task, stage, event, this.#context(task));
    const stageId = stageIdOf(event) ?? task.current_stage_id ?? null;

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
    rows?.(task);
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
