import { describe, expect, it } from 'vitest';
import {
  COUNTING_CAUSES,
  DEFAULT_STAGE_RETRIES,
  STAGE_ROLES,
  transition,
  type Applied,
  type TransitionContext,
} from '../../../src/core/coordinator/transitions.ts';
import { EVENT_TYPES, STAGE_EVENT_TYPES, type Event, type EventType } from '../../../src/core/domain/events.ts';
import type { Stage } from '../../../src/core/domain/stage.ts';
import { ACTIVE_STATES, TASK_STATES, type Task, type TaskState } from '../../../src/core/domain/task.ts';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const CURRENT = 'stage-cur';
const LIMITS = { undo_accept_ms: 10_000, undo_discard_ms: 60_000 };

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  let n = 0;
  return {
    now: NOW,
    newId: () => `new-${++n}`,
    retriesFor: () => 2,
    limits: LIMITS,
    nextTaskNo: () => 7,
    ...overrides,
  };
}

function task(state: TaskState, overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    kind: 'feature',
    task_no: state === 'draft' || state === 'awaiting_approval' || state === 'discard_pending' ? null : 3,
    state,
    current_stage_id: CURRENT,
    budget_used: 1,
    budget_limit: 5,
    review_round: 0,
    resume_state: state === 'paused' ? 'implementing' : null,
    stuck_reason: null,
    waiting_reason: null,
    undo_expires_at:
      state === 'accept_pending' || state === 'discard_pending' ? new Date(NOW.getTime() + 5_000).toISOString() : null,
    config_sha: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function stage(state: TaskState, overrides: Partial<Stage> = {}): Stage {
  return {
    id: CURRENT,
    task_id: 'task-1',
    role: STAGE_ROLES[state] ?? 'implementer',
    attempt: 1,
    status: 'running',
    reason: null,
    created_at: NOW.toISOString(),
    started_at: NOW.toISOString(),
    ended_at: null,
    ...overrides,
  };
}

/** A well-formed sample of every event type, naming the current Stage. */
function sample(type: EventType, stageId = CURRENT): Event {
  switch (type) {
    case 'stage_failed':
      return { type, stage_id: stageId, reason: 'timeout' };
    case 'reason_written':
      return { type, stage_id: stageId, reason: 'cannot satisfy AC2' };
    case 'deps_unsatisfiable':
      return { type, reason: 'dependency cancelled' };
    case 'budget_raised':
      return { type, amount: 2 };
    case 'stage_retries_exhausted':
      return { type };
    default:
      return STAGE_EVENT_TYPES.includes(type) ? ({ type, stage_id: stageId } as Event) : ({ type } as Event);
  }
}

function applied(outcome: ReturnType<typeof transition>): Applied {
  if (outcome.ignored !== undefined) {
    throw new Error(`expected an applied outcome, got ignored(${outcome.ignored})`);
  }
  return outcome;
}

const STAGE_STATES = TASK_STATES.filter((s) => STAGE_ROLES[s] !== undefined);

/** Every applied `(state, event)` pair; everything else must be `ignored(invalid)`. */
const EXPECTED: Record<TaskState, Partial<Record<EventType, TaskState>>> = {
  draft: { draft_ready: 'awaiting_approval' },
  awaiting_approval: { draft_reply: 'draft', approved: 'queued', discarded: 'discard_pending' },
  discard_pending: { undone: 'awaiting_approval', undo_expired: 'cancelled' },
  queued: { deps_unmerged: 'waiting_on_dependencies', scheduler_start: 'implementing' },
  waiting_on_dependencies: { deps_merged: 'queued', deps_unsatisfiable: 'stuck' },
  implementing: { implementer_done: 'testing', budget_spent: 'triage' },
  testing: { test_failed: 'implementing', test_passed: 'validating' },
  validating: { blocking_findings: 'implementing', nonblocking_findings: 'triage', pass: 'evidencing' },
  triage: { rerun: 'implementing', parked: 'evidencing', reason_written: 'stuck' },
  evidencing: { evidence_produced: 'verifying', evidence_missing: 'implementing' },
  verifying: { evidence_rejected: 'implementing', evidence_verified: 'in_review' },
  in_review: { correction: 'implementing', accepted: 'accept_pending' },
  accept_pending: { undone: 'in_review', undo_expired: 'integrating' },
  integrating: { rebase_or_revalidation_failed: 'implementing', merged: 'merged' },
  merged: { release_done: 'released', no_release_step: 'released', release_failed: 'release_failed' },
  release_failed: { retry_release: 'merged', leave_it: 'released' },
  released: {},
  cancelled: {},
  stuck: { budget_raised: 'implementing' },
  paused: { resume: 'implementing' },
};
for (const state of TASK_STATES) {
  const row = EXPECTED[state];
  if (state !== 'released' && state !== 'cancelled') row.cancel = 'cancelled';
  if (ACTIVE_STATES.includes(state)) {
    row.amended = 'implementing';
    if (state !== 'paused') row.pause = 'paused';
  }
  if (STAGE_ROLES[state] !== undefined) {
    row.stage_started = state;
    row.stage_failed = state;
    row.stage_retries_exhausted = 'stuck';
  }
}

describe('transitions table (AD-3)', () => {
  const pairs = TASK_STATES.flatMap((state) => EVENT_TYPES.map((type) => [state, type] as const));

  it.each(pairs)('%s + %s', (state, type) => {
    const outcome = transition(task(state), stage(state), sample(type), ctx());
    const expected = EXPECTED[state][type];
    if (expected === undefined) {
      expect(outcome).toEqual({ ignored: 'invalid' });
    } else {
      expect(applied(outcome).next).toBe(expected);
    }
  });

  it('lists every pair exactly once', () => {
    expect(pairs).toHaveLength(TASK_STATES.length * EVENT_TYPES.length);
    expect(new Set(pairs.map(([s, e]) => `${s}+${e}`)).size).toBe(pairs.length);
  });
});

describe('stale Stage events', () => {
  it.each(STAGE_EVENT_TYPES)('%s with an old stage_id is ignored(stale) in every state', (type) => {
    for (const state of TASK_STATES) {
      expect(transition(task(state), stage(state), sample(type, 'stage-old'), ctx())).toEqual({ ignored: 'stale' });
    }
  });

  it('is stale when the current Stage row is no longer live', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(transition(task('implementing'), stage('implementing', { status }), sample('implementer_done'), ctx())).toEqual({
        ignored: 'stale',
      });
    }
    expect(transition(task('implementing', { current_stage_id: null }), undefined, sample('implementer_done'), ctx())).toEqual({
      ignored: 'stale',
    });
  });

  it('a starting Stage is live', () => {
    const outcome = applied(transition(task('implementing'), stage('implementing', { status: 'starting' }), sample('stage_started'), ctx()));
    expect(outcome.next).toBe('implementing');
    expect(outcome.stageUpdate).toEqual({ status: 'running', reason: null });
  });
});

describe('entering a Stage state', () => {
  it('queued + scheduler_start starts the implementer, counts one budget unit and sets current_stage_id', () => {
    const outcome = applied(transition(task('queued', { current_stage_id: null, budget_used: 0 }), undefined, sample('scheduler_start'), ctx()));
    expect(outcome.next).toBe('implementing');
    expect(outcome.patch.budget_used).toBe(1);
    expect(outcome.patch.current_stage_id).toBe('new-1');
    expect(outcome.startStage).toEqual({ id: 'new-1', role: 'implementer', attempt: 1 });
    expect(outcome.effects).toEqual([{ kind: 'start_stage', stage_id: 'new-1', task_id: 'task-1', role: 'implementer', attempt: 1 }]);
    expect(outcome.derived).toEqual([]);
  });

  it('testing runs the test step instead of a claude Stage', () => {
    const outcome = applied(transition(task('implementing'), stage('implementing'), sample('implementer_done'), ctx()));
    expect(outcome.next).toBe('testing');
    expect(outcome.stageUpdate).toEqual({ status: 'succeeded', reason: null });
    expect(outcome.startStage).toEqual({ id: 'new-1', role: 'test', attempt: 1 });
    expect(outcome.effects).toEqual([{ kind: 'run_test_step', stage_id: 'new-1', task_id: 'task-1', attempt: 1 }]);
  });

  it.each(STAGE_STATES)('%s is entered with a Stage of its Role', (state) => {
    const from = Object.entries(EXPECTED).find(([, row]) => Object.values(row).includes(state) && row.cancel !== undefined);
    expect(from).toBeDefined();
    const [fromState, row] = from as [TaskState, Partial<Record<EventType, TaskState>>];
    const type = (Object.keys(row) as EventType[]).find((t) => row[t] === state) as EventType;
    const outcome = applied(transition(task(fromState), stage(fromState), sample(type), ctx()));
    expect(outcome.startStage?.role).toBe(STAGE_ROLES[state]);
  });
});

describe('Iteration Budget (AD-3)', () => {
  const entries: Array<[TaskState, EventType]> = [
    ['queued', 'scheduler_start'],
    ['testing', 'test_failed'],
    ['validating', 'blocking_findings'],
    ['triage', 'rerun'],
    ['evidencing', 'evidence_missing'],
    ['integrating', 'rebase_or_revalidation_failed'],
    ['verifying', 'evidence_rejected'],
    ['in_review', 'correction'],
    ['paused', 'resume'],
    ['stuck', 'budget_raised'],
    ['implementing', 'amended'],
  ];

  it.each(entries)('%s + %s counts iff the cause is a counting cause', (state, type) => {
    const outcome = applied(transition(task(state, { budget_used: 2 }), stage(state), sample(type), ctx()));
    expect(outcome.next).toBe('implementing');
    if (COUNTING_CAUSES.has(type)) {
      expect(outcome.patch.budget_used).toBe(3);
    } else if (type === 'amended') {
      expect(outcome.patch.budget_used).toBe(0);
    } else {
      expect(outcome.patch.budget_used).toBeUndefined();
    }
    expect(outcome.startStage).toBeDefined();
  });

  it('a counting entry with the budget used up derives budget_spent and starts no Stage', () => {
    const outcome = applied(transition(task('testing', { budget_used: 5, budget_limit: 5 }), stage('testing'), sample('test_failed'), ctx()));
    expect(outcome.next).toBe('implementing');
    expect(outcome.startStage).toBeUndefined();
    expect(outcome.effects).toEqual([]);
    expect(outcome.patch.budget_used).toBeUndefined();
    expect(outcome.derived).toEqual([{ type: 'budget_spent' }]);
  });

  it('budget_spent from implementing cancels a live Stage and starts Triage', () => {
    const outcome = applied(transition(task('implementing'), stage('implementing'), sample('budget_spent'), ctx()));
    expect(outcome.next).toBe('triage');
    expect(outcome.stageUpdate).toEqual({ status: 'cancelled', reason: 'budget_spent' });
    expect(outcome.effects.map((e) => e.kind)).toEqual(['cancel_stage', 'start_stage']);
  });

  it('budget_raised adds to the limit and re-enters implementing without counting', () => {
    const outcome = applied(transition(task('stuck', { budget_used: 5, budget_limit: 5, stuck_reason: 'x' }), undefined, { type: 'budget_raised', amount: 2 }, ctx()));
    expect(outcome.next).toBe('implementing');
    expect(outcome.patch).toMatchObject({ budget_limit: 7, stuck_reason: null, current_stage_id: 'new-1' });
    expect(outcome.patch.budget_used).toBeUndefined();
  });
});

describe('Stage retries (AD-4)', () => {
  it('stage_failed on attempt 1 of 2 retries relaunches the same Stage as attempt 2, budget unchanged', () => {
    const outcome = applied(transition(task('implementing'), stage('implementing'), { type: 'stage_failed', stage_id: CURRENT, reason: 'timeout' }, ctx()));
    expect(outcome.next).toBe('implementing');
    expect(outcome.stageUpdate).toEqual({ status: 'failed', reason: 'timeout' });
    expect(outcome.startStage).toEqual({ id: 'new-1', role: 'implementer', attempt: 2 });
    expect(outcome.effects).toEqual([{ kind: 'start_stage', stage_id: 'new-1', task_id: 'task-1', role: 'implementer', attempt: 2 }]);
    expect(outcome.patch.budget_used).toBeUndefined();
  });

  it('stage_failed on attempt 3 derives stage_retries_exhausted with a reason', () => {
    const outcome = applied(transition(task('validating'), stage('validating', { attempt: 3 }), { type: 'stage_failed', stage_id: CURRENT, reason: 'exit 1' }, ctx()));
    expect(outcome.next).toBe('validating');
    expect(outcome.startStage).toBeUndefined();
    expect(outcome.effects).toEqual([]);
    expect(outcome.derived).toEqual([{ type: 'stage_retries_exhausted', reason: 'validator Stage failed 3 times; last failure: exit 1' }]);
  });

  it('stage_retries_exhausted writes stuck_reason and cancels a still-live Stage', () => {
    const outcome = applied(transition(task('triage'), stage('triage'), { type: 'stage_retries_exhausted', reason: 'why' }, ctx()));
    expect(outcome.next).toBe('stuck');
    expect(outcome.patch.stuck_reason).toBe('why');
    expect(outcome.stageUpdate).toEqual({ status: 'cancelled', reason: 'stage_retries_exhausted' });
  });

  it('a role without a config entry gets the default retries', () => {
    const retries = ctx({ retriesFor: (role) => (role === 'test' ? DEFAULT_STAGE_RETRIES : 0) });
    const outcome = applied(transition(task('testing'), stage('testing', { attempt: 2 }), { type: 'stage_failed', stage_id: CURRENT, reason: 'capability_busy' }, retries));
    expect(outcome.startStage?.attempt).toBe(3);
  });
});

describe('pause and resume', () => {
  it('pause stores resume_state, cancels the Stage and queues cancel_stage', () => {
    const outcome = applied(transition(task('implementing'), stage('implementing'), sample('pause'), ctx()));
    expect(outcome.next).toBe('paused');
    expect(outcome.patch).toMatchObject({ resume_state: 'implementing', current_stage_id: null });
    expect(outcome.stageUpdate).toEqual({ status: 'cancelled', reason: 'pause' });
    expect(outcome.effects).toEqual([{ kind: 'cancel_stage', stage_id: CURRENT, task_id: 'task-1', reason: 'pause' }]);
  });

  it('resume returns to resume_state with a fresh Stage and the budget untouched', () => {
    const outcome = applied(transition(task('paused', { current_stage_id: null, resume_state: 'validating' }), undefined, sample('resume'), ctx()));
    expect(outcome.next).toBe('validating');
    expect(outcome.patch).toMatchObject({ resume_state: null, current_stage_id: 'new-1' });
    expect(outcome.startStage).toEqual({ id: 'new-1', role: 'validator', attempt: 1 });
    expect(outcome.patch.budget_used).toBeUndefined();
  });

  it('resume to a non-Stage state starts nothing', () => {
    const outcome = applied(transition(task('paused', { current_stage_id: null, resume_state: 'queued' }), undefined, sample('resume'), ctx()));
    expect(outcome.next).toBe('queued');
    expect(outcome.startStage).toBeUndefined();
    expect(outcome.effects).toEqual([]);
  });

  it('resume without a stored resume_state is invalid', () => {
    expect(transition(task('paused', { resume_state: null }), undefined, sample('resume'), ctx())).toEqual({ ignored: 'invalid' });
  });
});

describe('undo windows (AD-3)', () => {
  it('accepted opens a 10 s window with no Integration effect', () => {
    const outcome = applied(transition(task('in_review', { current_stage_id: null }), undefined, sample('accepted'), ctx()));
    expect(outcome.next).toBe('accept_pending');
    expect(outcome.patch.undo_expires_at).toBe('2026-11-08T12:00:10.000Z');
    expect(outcome.effects).toEqual([]);
  });

  it('discarded opens a 60 s window', () => {
    const outcome = applied(transition(task('awaiting_approval', { current_stage_id: null }), undefined, sample('discarded'), ctx()));
    expect(outcome.patch.undo_expires_at).toBe('2026-11-08T12:01:00.000Z');
  });

  it('undone before expiry returns to in_review (new round); after expiry it is invalid', () => {
    const before = applied(transition(task('accept_pending', { current_stage_id: null, review_round: 2 }), undefined, sample('undone'), ctx()));
    expect(before.next).toBe('in_review');
    expect(before.patch).toMatchObject({ undo_expires_at: null, review_round: 3 });

    const expired = task('accept_pending', { current_stage_id: null, undo_expires_at: new Date(NOW.getTime() - 1).toISOString() });
    expect(transition(expired, undefined, sample('undone'), ctx())).toEqual({ ignored: 'invalid' });
    expect(applied(transition(expired, undefined, sample('undo_expired'), ctx())).next).toBe('integrating');
  });

  it('undo_expired integrates a feature Task and releases a bootstrap Task', () => {
    const feature = applied(transition(task('accept_pending', { current_stage_id: null }), undefined, sample('undo_expired'), ctx()));
    expect(feature.next).toBe('integrating');
    expect(feature.effects).toEqual([{ kind: 'integrate', task_id: 'task-1' }]);

    const bootstrap = applied(transition(task('accept_pending', { current_stage_id: null, kind: 'bootstrap' }), undefined, sample('undo_expired'), ctx()));
    expect(bootstrap.next).toBe('released');
    expect(bootstrap.effects).toEqual([]);
  });
});

describe('other columns', () => {
  it('review_round increments only on entry to in_review (AD-16)', () => {
    const verified = applied(transition(task('verifying', { review_round: 1 }), stage('verifying'), sample('evidence_verified'), ctx()));
    expect(verified.patch.review_round).toBe(2);
    const correction = applied(transition(task('in_review', { current_stage_id: null, review_round: 2 }), undefined, sample('correction'), ctx()));
    expect(correction.patch.review_round).toBeUndefined();
  });

  it('approved assigns the per-Project Task number once', () => {
    const first = applied(transition(task('awaiting_approval', { current_stage_id: null, task_no: null }), undefined, sample('approved'), ctx()));
    expect(first.patch.task_no).toBe(7);
    const again = applied(transition(task('awaiting_approval', { current_stage_id: null, task_no: 4 }), undefined, sample('approved'), ctx()));
    expect(again.patch.task_no).toBe(4);
  });

  it('merged schedules run_release; retry_release schedules it again', () => {
    expect(applied(transition(task('integrating', { current_stage_id: null }), undefined, sample('merged'), ctx())).effects).toEqual([{ kind: 'run_release', task_id: 'task-1' }]);
    expect(applied(transition(task('release_failed', { current_stage_id: null }), undefined, sample('retry_release'), ctx())).effects).toEqual([{ kind: 'run_release', task_id: 'task-1' }]);
  });

  it('deps_unsatisfiable and reason_written write stuck_reason; leaving stuck clears it', () => {
    expect(applied(transition(task('waiting_on_dependencies', { current_stage_id: null }), undefined, { type: 'deps_unsatisfiable', reason: 'dep cancelled' }, ctx())).patch.stuck_reason).toBe('dep cancelled');
    const written = applied(transition(task('triage'), stage('triage'), { type: 'reason_written', stage_id: CURRENT, reason: 'needs design' }, ctx()));
    expect(written.patch.stuck_reason).toBe('needs design');
    expect(written.stageUpdate).toEqual({ status: 'succeeded', reason: null });
    expect(applied(transition(task('stuck', { current_stage_id: null, stuck_reason: 'x' }), undefined, sample('cancel'), ctx())).patch.stuck_reason).toBeNull();
  });

  it('cancel keeps a non-live Stage row untouched', () => {
    const outcome = applied(transition(task('implementing'), stage('implementing', { status: 'failed' }), sample('cancel'), ctx()));
    expect(outcome.stageUpdate).toBeUndefined();
    expect(outcome.effects).toEqual([]);
  });
});
