import type { Effect } from '../domain/effects.ts';
import { isStageEvent, type Event, type EventOf, type EventType, type IgnoreReason } from '../domain/events.ts';
import { isLiveStage, LIVE_STAGE_STATUSES, type Stage, type StageStatus } from '../domain/stage.ts';
import { ACTIVE_STATES, TERMINAL_STATES, type Task, type TaskPatch, type TaskState } from '../domain/task.ts';

/** What `transition` needs from the outside world, so the function itself stays pure. */
export interface TransitionContext {
  now: Date;
  /** Mints the id of a Stage the transition starts. */
  newId(): string;
  /** `retries` of the Role Config (AD-4); roles without a config entry get `DEFAULT_STAGE_RETRIES`. */
  retriesFor(role: string): number;
  limits: { undo_accept_ms: number; undo_discard_ms: number };
  /** The next per-Project Task number, read when `approved` assigns it (AD-16). */
  nextTaskNo(): number;
}

/** Retries for a Stage role with no `roles.<role>` entry, such as the `test` step. */
export const DEFAULT_STAGE_RETRIES = 2;

/** Change to the Task's current `stages` row. `running` records `started_at`; the others `ended_at`. */
export interface StageUpdate {
  status: Exclude<StageStatus, 'starting'>;
  reason: string | null;
}

/** A new `stages` row the Coordinator inserts as `starting` inside the transaction (AD-3). */
export interface StageStart {
  id: string;
  role: string;
  attempt: number;
}

export interface Applied {
  ignored?: undefined;
  next: TaskState;
  patch: TaskPatch;
  effects: Effect[];
  stageUpdate?: StageUpdate;
  startStage?: StageStart;
  /** Applied by the Coordinator in the same transaction, after this outcome is written. */
  derived: Event[];
}

export interface Ignored {
  ignored: IgnoreReason;
}

export type Outcome = Applied | Ignored;

/** States that run a Stage, and the Role of that Stage. `test` is the Coordinator-run Recipe step. */
export const STAGE_ROLES: Readonly<Partial<Record<TaskState, string>>> = {
  implementing: 'implementer',
  testing: 'test',
  validating: 'validator',
  triage: 'triage',
  evidencing: 'evidence-producer',
  verifying: 'validator',
};

/** Causes of entering `implementing` that consume one unit of Iteration Budget (AD-3). */
export const COUNTING_CAUSES: ReadonlySet<EventType> = new Set<EventType>([
  'scheduler_start',
  'blocking_findings',
  'rerun',
  'evidence_missing',
  'test_failed',
  'rebase_or_revalidation_failed',
]);

export function isStageState(state: TaskState): boolean {
  return STAGE_ROLES[state] !== undefined;
}

interface EnterOptions {
  cause: EventType;
  attempt?: number;
  patch?: TaskPatch;
  stageUpdate?: StageUpdate;
}

/**
 * Enters `next` from `task.state`: ends a live Stage the caller has not already settled, resets
 * the per-state columns, starts the Stage of a Stage state (checking the budget first when the
 * cause counts), bumps `review_round` on `in_review`, opens undo windows, schedules Integration
 * and Release effects.
 */
function enter(next: TaskState, task: Task, stage: Stage | undefined, ctx: TransitionContext, opts: EnterOptions): Applied {
  const patch: TaskPatch = { ...opts.patch };
  const effects: Effect[] = [];
  const derived: Event[] = [];
  let stageUpdate = opts.stageUpdate;
  if (stageUpdate === undefined && isLiveStage(stage) && stage.id === task.current_stage_id) {
    stageUpdate = { status: 'cancelled', reason: opts.cause };
    effects.push({ kind: 'cancel_stage', stage_id: stage.id, task_id: task.id, reason: opts.cause });
  }

  patch.current_stage_id = null;
  if (next !== 'paused') patch.resume_state = null;
  if (next !== 'accept_pending' && next !== 'discard_pending') patch.undo_expires_at = null;
  if (next !== 'stuck') patch.stuck_reason = null;
  if (next !== 'queued') patch.waiting_reason = null;

  const role = STAGE_ROLES[next];
  if (role !== undefined) {
    if (next === 'implementing' && COUNTING_CAUSES.has(opts.cause)) {
      const used = patch.budget_used ?? task.budget_used;
      const limit = patch.budget_limit ?? task.budget_limit;
      if (used >= limit) {
        derived.push({ type: 'budget_spent' });
        return { next, patch, effects, stageUpdate, derived };
      }
      patch.budget_used = used + 1;
    }
    const start: StageStart = { id: ctx.newId(), role, attempt: opts.attempt ?? 1 };
    patch.current_stage_id = start.id;
    effects.push(
      next === 'testing'
        ? { kind: 'run_test_step', stage_id: start.id, task_id: task.id, attempt: start.attempt }
        : { kind: 'start_stage', stage_id: start.id, task_id: task.id, role, attempt: start.attempt },
    );
    return { next, patch, effects, stageUpdate, startStage: start, derived };
  }

  switch (next) {
    case 'in_review':
      // One round per Review delivered (AD-16): only a fresh Review from `verifying` starts a round;
      // `undone` and `resume` return to the same Review and keep it.
      if (opts.cause === 'evidence_verified') patch.review_round = task.review_round + 1;
      break;
    case 'accept_pending':
      patch.undo_expires_at = new Date(ctx.now.getTime() + ctx.limits.undo_accept_ms).toISOString();
      break;
    case 'discard_pending':
      patch.undo_expires_at = new Date(ctx.now.getTime() + ctx.limits.undo_discard_ms).toISOString();
      break;
    case 'paused':
      patch.resume_state = task.state;
      break;
    case 'integrating':
      effects.push({ kind: 'integrate', task_id: task.id });
      break;
    case 'merged':
      effects.push({ kind: 'run_release', task_id: task.id });
      break;
    default:
      break;
  }
  return { next, patch, effects, stageUpdate, derived };
}

const SUCCEEDED: StageUpdate = { status: 'succeeded', reason: null };

type Rule<T extends EventType = EventType> = (
  task: Task,
  stage: Stage | undefined,
  event: EventOf<T>,
  ctx: TransitionContext,
) => Applied;

/** `state --> next: event` for an arrow without a Stage result. */
function go<E extends EventType>(next: TaskState): Rule<E> {
  return (task, stage, event, ctx) => enter(next, task, stage, ctx, { cause: event.type });
}

/** `state --> next: event` for a Stage result: the current Stage row ends `succeeded`. */
function stageDone<E extends EventType>(next: TaskState): Rule<E> {
  return (task, stage, event, ctx) => enter(next, task, stage, ctx, { cause: event.type, stageUpdate: SUCCEEDED });
}

function undoStillOpen(task: Task, ctx: TransitionContext): boolean {
  return task.undo_expires_at !== null && new Date(task.undo_expires_at).getTime() > ctx.now.getTime();
}

type RuleTable = { [S in TaskState]?: { [E in EventType]?: Rule<E> } };

/** The AD-3 diagram, one entry per arrow. Generic events are handled in `transition` before this table. */
const TABLE: RuleTable = {
  draft: { draft_ready: go('awaiting_approval') },
  awaiting_approval: {
    draft_reply: go('draft'),
    approved: (task, stage, event, ctx) =>
      enter('queued', task, stage, ctx, { cause: event.type, patch: { task_no: task.task_no ?? ctx.nextTaskNo() } }),
    discarded: go('discard_pending'),
  },
  discard_pending: {
    undone: go('awaiting_approval'),
    undo_expired: go('cancelled'),
  },
  queued: {
    deps_unmerged: go('waiting_on_dependencies'),
    scheduler_start: go('implementing'),
  },
  waiting_on_dependencies: { deps_merged: go('queued') },
  implementing: {
    implementer_done: stageDone('testing'),
    budget_spent: go('triage'),
  },
  testing: {
    test_failed: stageDone('implementing'),
    test_passed: stageDone('validating'),
  },
  validating: {
    blocking_findings: stageDone('implementing'),
    nonblocking_findings: stageDone('triage'),
    pass: stageDone('evidencing'),
  },
  triage: {
    rerun: stageDone('implementing'),
    parked: stageDone('evidencing'),
    reason_written: (task, stage, event, ctx) =>
      enter('stuck', task, stage, ctx, { cause: event.type, stageUpdate: SUCCEEDED, patch: { stuck_reason: event.reason } }),
  },
  evidencing: {
    evidence_produced: stageDone('verifying'),
    evidence_missing: stageDone('implementing'),
  },
  verifying: {
    evidence_rejected: stageDone('implementing'),
    evidence_verified: stageDone('in_review'),
  },
  in_review: {
    correction: go('implementing'),
    accepted: go('accept_pending'),
  },
  accept_pending: {
    undone: go('in_review'),
    undo_expired: (task, stage, event, ctx) =>
      enter(task.kind === 'bootstrap' ? 'released' : 'integrating', task, stage, ctx, { cause: event.type }),
  },
  integrating: {
    rebase_or_revalidation_failed: go('implementing'),
    merged: go('merged'),
  },
  merged: {
    release_done: go('released'),
    no_release_step: go('released'),
    release_failed: go('release_failed'),
  },
  release_failed: {
    retry_release: go('merged'),
    leave_it: go('released'),
  },
  stuck: {
    budget_raised: (task, stage, event, ctx) =>
      enter('implementing', task, stage, ctx, { cause: event.type, patch: { budget_limit: task.budget_limit + event.amount } }),
  },
};

function generic(task: Task, stage: Stage | undefined, event: Event, ctx: TransitionContext): Outcome | undefined {
  const active = ACTIVE_STATES.includes(task.state);
  switch (event.type) {
    case 'cancel':
      return TERMINAL_STATES.includes(task.state) ? { ignored: 'invalid' } : enter('cancelled', task, stage, ctx, { cause: event.type });
    case 'pause':
      return active && task.state !== 'paused' ? enter('paused', task, stage, ctx, { cause: event.type }) : { ignored: 'invalid' };
    case 'resume':
      return task.state === 'paused' && task.resume_state !== null
        ? enter(task.resume_state, task, stage, ctx, { cause: event.type })
        : { ignored: 'invalid' };
    case 'amended':
      return active ? enter('implementing', task, stage, ctx, { cause: event.type, patch: { budget_used: 0 } }) : { ignored: 'invalid' };
    case 'deps_unsatisfiable':
      return task.state === 'waiting_on_dependencies'
        ? enter('stuck', task, stage, ctx, { cause: event.type, patch: { stuck_reason: event.reason } })
        : { ignored: 'invalid' };
    case 'stage_retries_exhausted': {
      // AD-3: from any state whose current Stage is running. The Stage may already be `failed` when this
      // is the derived event of its final `stage_failed`, applied after that row was settled.
      if (!isStageState(task.state) || stage === undefined || stage.id !== task.current_stage_id) return { ignored: 'invalid' };
      if (!LIVE_STAGE_STATUSES.includes(stage.status) && stage.status !== 'failed') return { ignored: 'invalid' };
      const reason = event.reason ?? `${stage.role} Stage exhausted its retries`;
      return enter('stuck', task, stage, ctx, { cause: event.type, patch: { stuck_reason: reason } });
    }
    case 'stage_started':
      return isStageState(task.state) && stage?.status === 'starting'
        ? { next: task.state, patch: {}, effects: [], stageUpdate: { status: 'running', reason: null }, derived: [] }
        : { ignored: 'invalid' };
    case 'stage_failed': {
      if (!isStageState(task.state) || stage === undefined) return { ignored: 'invalid' };
      const failed: StageUpdate = { status: 'failed', reason: event.reason };
      if (stage.attempt <= ctx.retriesFor(stage.role)) {
        return enter(task.state, task, stage, ctx, { cause: event.type, attempt: stage.attempt + 1, stageUpdate: failed });
      }
      const reason = `${stage.role} Stage failed ${stage.attempt} times; last failure: ${event.reason}`;
      return { next: task.state, patch: {}, effects: [], stageUpdate: failed, derived: [{ type: 'stage_retries_exhausted', reason }] };
    }
    default:
      return undefined;
  }
}

/**
 * The Task state machine (AD-3, AD-4, AD-16): pure and synchronous. Stage events are stale unless
 * they name the Task's current, live Stage; an undefined `(state, event)` pair is `ignored(invalid)`.
 * Never throws on input the schema accepts.
 */
export function transition(task: Task, stage: Stage | undefined, event: Event, ctx: TransitionContext): Outcome {
  if (isStageEvent(event)) {
    const current = stage !== undefined && stage.id === task.current_stage_id ? stage : undefined;
    if (event.stage_id !== task.current_stage_id || !isLiveStage(current)) {
      return { ignored: 'stale' };
    }
  }
  const handled = generic(task, stage, event, ctx);
  if (handled !== undefined) {
    return handled;
  }
  // Undo windows: `undone` only while the window is open, `undo_expired` only once it has closed.
  if (event.type === 'undone' && !undoStillOpen(task, ctx)) {
    return { ignored: 'invalid' };
  }
  if (event.type === 'undo_expired' && (task.undo_expires_at === null || undoStillOpen(task, ctx))) {
    return { ignored: 'invalid' };
  }
  const rule = (TABLE[task.state] as { [E in EventType]?: Rule<E> } | undefined)?.[event.type] as Rule | undefined;
  return rule === undefined ? { ignored: 'invalid' } : rule(task, stage, event, ctx);
}
