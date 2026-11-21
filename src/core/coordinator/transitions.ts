import type { Effect } from '../domain/effects.ts';
import { isStageEvent, type Event, type EventOf, type EventType, type IgnoreReason } from '../domain/events.ts';
import { isLiveStage, LIVE_STAGE_STATUSES, type Stage, type StageStatus } from '../domain/stage.ts';
import { ACTIVE_STATES, TERMINAL_STATES, type Task, type TaskPatch, type TaskState } from '../domain/task.ts';

/** What `transition` needs from the outside world, so the function itself stays pure. */
export interface TransitionContext {
  now: Date;
  /** Mints the id of a Stage the transition starts. */
  newId(): string;
  /**
   * `retries` of `config.yaml` `roles.<role>` (AD-4); roles without a config entry get `DEFAULT_STAGE_RETRIES`.
   * A Stage whose launch stored its resolved Role Config `retries` uses that instead.
   */
  retriesFor(role: string): number;
  limits: { undo_accept_ms: number; undo_discard_ms: number };
  /** The next per-Project Task number, read when `approved` assigns it (AD-16). */
  nextTaskNo(): number;
  /**
   * Why `approved` must be refused (open question, infeasible criterion, bad dependency), or undefined
   * when it may be applied (CAP-8, CAP-9). Absent means nothing refuses.
   */
  approvalRefusal?(event: EventOf<'approved'>): string | undefined;
  /** Whether the draft has a contract version, i.e. its Intake run was a revision (AD-3). Absent means no. */
  hasContract?(): boolean;
  /**
   * The event that entered the current `triage` visit (`triageCause` of `domain/loop.ts`). A Triage
   * entered with `budget_spent` applies `rerun` and `parked` as `reason_written` (AD-3). Absent means unknown.
   */
  triageCause?(): string | undefined;
}

/** The Draft card, rendered from the rows; sent once, then edited in place. Payload `{refusal?, closed?}`. */
export const DRAFT_CARD = 'draft_card';
/** Intake gave up on a draft: `👀` becomes `❌` with `Couldn't process that — send it again.` (AD-10). */
export const INTAKE_FAILED = 'intake_failed';
/**
 * The loud Stuck card (DESIGN `stuck-card`), sent on every entry to `stuck` with payload `{reason}`.
 * Later renders edit that card: `{mode: 'confirm' | 'restore'}` swaps its buttons, `{closed: 'raised', amount}`
 * and `{closed: 'cancelled'}` replace them with a state line.
 */
export const STUCK_CARD = 'stuck_card';
/** `stuck_reason` of a spent budget whose Triage gave no reason. */
export const BUDGET_SPENT_REASON = 'Iteration Budget spent';

function draftCard(taskId: string, payload?: Record<string, unknown>): Effect {
  return { kind: 'notify', notice_kind: DRAFT_CARD, task_id: taskId, ...(payload === undefined ? {} : { payload }) };
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
  draft: 'intake',
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
  // A paused Stuck Task keeps its reason, so `resume` re-sends the card with it.
  if (next !== 'stuck' && !(next === 'paused' && task.state === 'stuck')) patch.stuck_reason = null;
  if (next !== 'queued') patch.waiting_reason = null;
  // Leaving `stuck` by the card's buttons closes the card with a state line (DESIGN `stuck-card`).
  if (task.state === 'stuck' && opts.cause === 'budget_raised') {
    effects.push({ kind: 'notify', notice_kind: STUCK_CARD, task_id: task.id, payload: { closed: 'raised', amount: (patch.budget_limit ?? task.budget_limit) - task.budget_limit } });
  } else if (task.state === 'stuck' && opts.cause === 'cancel') {
    effects.push({ kind: 'notify', notice_kind: STUCK_CARD, task_id: task.id, payload: { closed: 'cancelled' } });
  }

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
    // The contract projection lands on the Branch before any Stage edits it (AD-21); a retry is no new entry.
    if (next === 'implementing' && task.state !== 'implementing' && task.kind === 'feature') effects.push({ kind: 'commit_contract', task_id: task.id });
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
      if (opts.cause === 'evidence_verified') {
        patch.review_round = task.review_round + 1;
        // The previous round's card keeps no live buttons once a new Review begins (AD-10).
        if (task.review_round > 0) effects.push({ kind: 'retire_card', task_id: task.id, round: task.review_round });
      }
      break;
    case 'awaiting_approval':
      effects.push(draftCard(task.id));
      break;
    case 'queued':
      if (opts.cause === 'approved') effects.push({ kind: 'prepare_branch', task_id: task.id }, draftCard(task.id));
      break;
    case 'accept_pending':
      patch.undo_expires_at = new Date(ctx.now.getTime() + ctx.limits.undo_accept_ms).toISOString();
      break;
    case 'discard_pending':
      patch.undo_expires_at = new Date(ctx.now.getTime() + ctx.limits.undo_discard_ms).toISOString();
      effects.push(draftCard(task.id));
      break;
    case 'cancelled':
      if (task.state === 'discard_pending') effects.push(draftCard(task.id, { closed: 'discarded' }));
      break;
    case 'paused':
      patch.resume_state = task.state;
      break;
    case 'stuck':
      // Every entry to `stuck` tells the Owner, whichever arrow it came by (CAP-13).
      effects.push({ kind: 'notify', notice_kind: STUCK_CARD, task_id: task.id, payload: { reason: patch.stuck_reason ?? task.stuck_reason ?? '' } });
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

/** Whether the current Triage decides on a spent budget: then the loop ends at the Stuck card (AD-3). */
function spent(ctx: TransitionContext): boolean {
  return ctx.triageCause?.() === 'budget_spent';
}

/** `triage --> stuck: reason_written`, with Triage's reason as `stuck_reason`. */
function reasonWritten(task: Task, stage: Stage | undefined, reason: string | undefined, ctx: TransitionContext): Applied {
  return enter('stuck', task, stage, ctx, { cause: 'reason_written', stageUpdate: SUCCEEDED, patch: { stuck_reason: reason ?? BUDGET_SPENT_REASON } });
}

type RuleTable = { [S in TaskState]?: { [E in EventType]?: Rule<E> } };

/** The AD-3 diagram, one entry per arrow. Generic events are handled in `transition` before this table. */
const TABLE: RuleTable = {
  draft: {
    // From the Intake Stage that wrote the draft (it succeeded), or from a complete contract file with no Stage.
    draft_ready: (task, stage, event, ctx) => {
      const ready = enter('awaiting_approval', task, stage, ctx, { cause: event.type, ...(event.stage_id === undefined ? {} : { stageUpdate: SUCCEEDED }) });
      // A reply that arrived during the run revises the draft at once (`awaiting_approval --> draft`).
      if (event.reply !== undefined) ready.derived.push({ type: 'draft_reply', text: event.reply });
      return ready;
    },
  },
  awaiting_approval: {
    draft_reply: go('draft'),
    approved: (task, stage, event, ctx) =>
      enter('queued', task, stage, ctx, {
        cause: event.type,
        patch: { task_no: task.task_no ?? ctx.nextTaskNo(), config_sha: event.config_sha ?? task.config_sha },
      }),
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
    // A blocked Implementer goes to Triage without a push or a test (Owner decision 2026-11-20; AD-13).
    implementer_blocked: stageDone('triage'),
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
    rerun: (task, stage, event, ctx) =>
      spent(ctx) ? reasonWritten(task, stage, event.reason, ctx) : enter('implementing', task, stage, ctx, { cause: event.type, stageUpdate: SUCCEEDED }),
    parked: (task, stage, event, ctx) =>
      spent(ctx) ? reasonWritten(task, stage, event.reason, ctx) : enter('evidencing', task, stage, ctx, { cause: event.type, stageUpdate: SUCCEEDED }),
    reason_written: (task, stage, event, ctx) => reasonWritten(task, stage, event.reason, ctx),
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
      if (TERMINAL_STATES.includes(task.state)) return { ignored: 'invalid' };
      // Naming the current Stage: that Stage concluded the Task is not actionable (AD-9), so it succeeded.
      return enter('cancelled', task, stage, ctx, { cause: event.type, ...(event.stage_id === undefined ? {} : { stageUpdate: SUCCEEDED }) });
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
      if (task.state === 'draft') {
        // Intake gave up (AD-3): a revision returns to its card on the previous version, which still shows
        // it, so the card is not re-rendered; a first run has no card and is cancelled. Either way the
        // Owner's latest message gets `❌` and a reply (AD-10).
        const failed: Effect = { kind: 'notify', notice_kind: INTAKE_FAILED, task_id: task.id, payload: { reason } };
        if (ctx.hasContract?.() === true) {
          const back = enter('awaiting_approval', task, stage, ctx, { cause: event.type });
          back.effects = back.effects.filter((effect) => !(effect.kind === 'notify' && effect.notice_kind === DRAFT_CARD));
          back.effects.push(failed);
          return back;
        }
        const cancelled = enter('cancelled', task, stage, ctx, { cause: event.type });
        cancelled.effects.push(failed);
        return cancelled;
      }
      return enter('stuck', task, stage, ctx, { cause: event.type, patch: { stuck_reason: reason } });
    }
    case 'stage_started':
      return isStageState(task.state) && stage?.status === 'starting'
        ? { next: task.state, patch: {}, effects: [], stageUpdate: { status: 'running', reason: null }, derived: [] }
        : { ignored: 'invalid' };
    case 'stage_failed': {
      if (!isStageState(task.state) || stage === undefined) return { ignored: 'invalid' };
      const failed: StageUpdate = { status: 'failed', reason: event.reason };
      // The Role Config resolved at launch wins (AD-15); a Stage that never got that far uses the config default.
      const retries = stage.retries ?? ctx.retriesFor(stage.role);
      if (stage.attempt <= retries) {
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
  // Refused while a question is open or a criterion infeasible, even from a stale button (CAP-8).
  if (event.type === 'approved' && task.state === 'awaiting_approval' && ctx.approvalRefusal?.(event) !== undefined) {
    return { ignored: 'invalid' };
  }
  const rule = (TABLE[task.state] as { [E in EventType]?: Rule<E> } | undefined)?.[event.type] as Rule | undefined;
  return rule === undefined ? { ignored: 'invalid' } : rule(task, stage, event, ctx);
}
