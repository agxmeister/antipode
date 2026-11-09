import { afterEach, describe, expect, it } from 'vitest';
import { Coordinator, ProjectNotFoundError, TaskNotFoundError, type CoordinatorPolicy } from '../../../src/core/coordinator/coordinator.ts';
import { ULID_PATTERN } from '../../../src/core/domain/ids.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

const POLICY: CoordinatorPolicy = {
  limits: { iteration_budget: 5, undo_accept_ms: 10_000, undo_discard_ms: 60_000 },
  roles: { implementer: { retries: 2 }, validator: { retries: 2 }, triage: { retries: 2 }, 'evidence-producer': { retries: 2 } },
};

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

async function setup(policy: CoordinatorPolicy = POLICY) {
  const ts = openTestStore();
  open.push(ts);
  const clock = fakeClock();
  const committed: number[] = [];
  const coordinator = new Coordinator({ store: ts.store, clock, policy: () => policy, onEffectsCommitted: () => committed.push(1) });
  const project = await coordinator.createProject('training');
  const task = await coordinator.createTask({ project_id: project.id, kind: 'feature' });
  return { ...ts, clock, coordinator, project, task, committed };
}

/** Walks a fresh draft Task to `implementing` with its first Stage running. */
async function toImplementing(c: Awaited<ReturnType<typeof setup>>) {
  await c.coordinator.applyEvent(c.task.id, { type: 'draft_ready' });
  await c.coordinator.applyEvent(c.task.id, { type: 'approved' });
  await c.coordinator.applyEvent(c.task.id, { type: 'scheduler_start' });
  const task = c.store.getTask(c.task.id)!;
  await c.coordinator.applyEvent(task.id, { type: 'stage_started', stage_id: task.current_stage_id! });
  expect(c.store.getStage(task.current_stage_id!)).toMatchObject({ status: 'running', started_at: c.clock.now().toISOString(), ended_at: null });
  return c.store.getTask(task.id)!;
}

describe('Coordinator (AD-3)', () => {
  it('creates a draft Task with a creation event in the log and ULID ids', async () => {
    const c = await setup();
    expect(c.task).toMatchObject({ state: 'draft', kind: 'feature', task_no: null, budget_used: 0, budget_limit: 5, review_round: 0 });
    expect(c.task.id).toMatch(ULID_PATTERN);
    expect(c.store.stageEventsOfTask(c.task.id)).toMatchObject([{ event_type: 'new_draft', status: 'applied', from_state: null, to_state: 'draft' }]);
    const bootstrap = await c.coordinator.createTask({ project_id: c.project.id, kind: 'bootstrap', budget_limit: 3 });
    expect(bootstrap).toMatchObject({ state: 'queued', task_no: 1, budget_limit: 3 });
  });

  it('createTask rejects an unknown Project and an invalid budget without inserting', async () => {
    const c = await setup();
    await expect(c.coordinator.createTask({ project_id: 'nope', kind: 'feature' })).rejects.toThrow(ProjectNotFoundError);
    await expect(c.coordinator.createTask({ project_id: c.project.id, kind: 'feature', budget_limit: 0 })).rejects.toThrow();
    await expect(c.coordinator.createProject('')).rejects.toThrow();
    expect(c.store.tasksInStates(['draft'])).toHaveLength(1);
    expect(c.store.listProjects()).toHaveLength(1);
  });

  it('queued + scheduler_start: state, budget, Stage row, event row and start_stage effect in one transaction', async () => {
    const c = await setup();
    await c.coordinator.applyEvent(c.task.id, { type: 'draft_ready' });
    await c.coordinator.applyEvent(c.task.id, { type: 'approved' });
    expect(c.store.getTask(c.task.id)).toMatchObject({ state: 'queued', task_no: 1 });

    const result = await c.coordinator.applyEvent(c.task.id, { type: 'scheduler_start' });
    expect(result).toEqual({ applied: true, state: 'implementing', effects: 1 });
    const task = c.store.getTask(c.task.id)!;
    expect(task).toMatchObject({ state: 'implementing', budget_used: 1 });
    const stages = c.store.stagesOfTask(task.id);
    expect(stages).toMatchObject([{ id: task.current_stage_id, role: 'implementer', attempt: 1, status: 'starting' }]);
    const events = c.store.stageEventsOfTask(task.id).filter((e) => e.event_type === 'scheduler_start');
    // A non-Stage event logs the Stage it found current (none here); the new Stage is on the effect.
    expect(events).toMatchObject([{ status: 'applied', from_state: 'queued', to_state: 'implementing', stage_id: null }]);
    const effects = c.store.effectsOfTask(task.id);
    expect(effects).toMatchObject([{ kind: 'start_stage', status: 'pending', effect: { stage_id: task.current_stage_id, role: 'implementer', attempt: 1 } }]);
    expect(c.committed).toHaveLength(1);
  });

  it('an undefined pair changes nothing, is stored as ignored(invalid) and never throws', async () => {
    const c = await setup();
    const result = await c.coordinator.applyEvent(c.task.id, { type: 'correction' });
    expect(result).toEqual({ applied: false, ignored: 'invalid' });
    expect(c.store.getTask(c.task.id)!.state).toBe('draft');
    expect(c.store.stageEventsOfTask(c.task.id).at(-1)).toMatchObject({ event_type: 'correction', status: 'ignored', ignore_reason: 'invalid', from_state: 'draft', to_state: null });
    expect(c.store.effectsOfTask(c.task.id)).toEqual([]);
    expect(c.committed).toHaveLength(0);
  });

  it('a Stage event with an old stage_id is ignored(stale) and produces no effect', async () => {
    const c = await setup();
    const task = await toImplementing(c);
    const before = c.store.effectsOfTask(task.id).length;
    const result = await c.coordinator.applyEvent(task.id, { type: 'implementer_done', stage_id: 'old-stage' });
    expect(result).toEqual({ applied: false, ignored: 'stale' });
    expect(c.store.getTask(task.id)!.state).toBe('implementing');
    expect(c.store.stageEventsOfTask(task.id).at(-1)).toMatchObject({ event_type: 'implementer_done', status: 'ignored', ignore_reason: 'stale', stage_id: 'old-stage' });
    expect(c.store.effectsOfTask(task.id)).toHaveLength(before);
  });

  it('stage_failed(timeout) on attempt 1 of 2 retries: same state, attempt 2 row, start_stage, budget unchanged', async () => {
    const c = await setup();
    const task = await toImplementing(c);
    const first = task.current_stage_id!;
    await c.coordinator.applyEvent(task.id, { type: 'stage_failed', stage_id: first, reason: 'timeout' });
    const after = c.store.getTask(task.id)!;
    expect(after).toMatchObject({ state: 'implementing', budget_used: 1 });
    expect(after.current_stage_id).not.toBe(first);
    expect(c.store.getStage(first)).toMatchObject({ status: 'failed', reason: 'timeout', ended_at: expect.any(String) });
    expect(c.store.getStage(after.current_stage_id!)).toMatchObject({ attempt: 2, status: 'starting', role: 'implementer' });
    expect(c.store.effectsOfTask(task.id).map((e) => e.effect)).toMatchObject([
      { kind: 'start_stage', attempt: 1 },
      { kind: 'start_stage', attempt: 2 },
    ]);
  });

  it('stage_failed on attempt 3 ends in stuck with a Coordinator-written stuck_reason, in one transaction', async () => {
    const c = await setup();
    let task = await toImplementing(c);
    for (let attempt = 1; attempt <= 3; attempt++) {
      task = c.store.getTask(task.id)!;
      expect(c.store.getStage(task.current_stage_id!)!.attempt).toBe(attempt);
      await c.coordinator.applyEvent(task.id, { type: 'stage_failed', stage_id: task.current_stage_id!, reason: `crash ${attempt}` });
    }
    const stuck = c.store.getTask(task.id)!;
    expect(stuck).toMatchObject({ state: 'stuck', current_stage_id: null, budget_used: 1 });
    expect(stuck.stuck_reason).toBe('implementer Stage failed 3 times; last failure: crash 3');
    const types = c.store.stageEventsOfTask(task.id).map((e) => `${e.event_type}:${e.status}`);
    expect(types.slice(-2)).toEqual(['stage_failed:applied', 'stage_retries_exhausted:applied']);
    expect(c.store.stagesOfTask(task.id).map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('pause stores resume_state and cancels the Stage; resume returns with a fresh Stage and the same budget', async () => {
    const c = await setup();
    const task = await toImplementing(c);
    const running = task.current_stage_id!;
    await c.coordinator.applyEvent(task.id, { type: 'pause' });
    const paused = c.store.getTask(task.id)!;
    expect(paused).toMatchObject({ state: 'paused', resume_state: 'implementing', current_stage_id: null, budget_used: 1 });
    expect(c.store.getStage(running)).toMatchObject({ status: 'cancelled', reason: 'pause' });
    expect(c.store.effectsOfTask(task.id).at(-1)).toMatchObject({ kind: 'cancel_stage', effect: { stage_id: running, reason: 'pause' } });

    await c.coordinator.applyEvent(task.id, { type: 'resume' });
    const resumed = c.store.getTask(task.id)!;
    expect(resumed).toMatchObject({ state: 'implementing', resume_state: null, budget_used: 1 });
    expect(resumed.current_stage_id).not.toBe(running);
    expect(c.store.getStage(resumed.current_stage_id!)).toMatchObject({ status: 'starting', attempt: 1, role: 'implementer' });
  });

  it('accepted opens the undo window with no Integration effect; undone returns; undo_expired integrates (bootstrap: released)', async () => {
    const c = await setup();
    const task = await toImplementing(c);
    // Walk to in_review through the Stage results.
    for (const type of ['implementer_done', 'test_passed', 'pass', 'evidence_produced', 'evidence_verified'] as const) {
      const current = c.store.getTask(task.id)!.current_stage_id!;
      await c.coordinator.applyEvent(task.id, { type, stage_id: current });
    }
    expect(c.store.getTask(task.id)).toMatchObject({ state: 'in_review', review_round: 1, current_stage_id: null });

    const effectsBefore = c.store.effectsOfTask(task.id).length;
    await c.coordinator.applyEvent(task.id, { type: 'accepted' });
    expect(c.store.getTask(task.id)).toMatchObject({ state: 'accept_pending', undo_expires_at: new Date(c.clock.now().getTime() + 10_000).toISOString() });
    expect(c.store.effectsOfTask(task.id)).toHaveLength(effectsBefore);

    c.clock.advance(5_000);
    await c.coordinator.applyEvent(task.id, { type: 'undone' });
    expect(c.store.getTask(task.id)).toMatchObject({ state: 'in_review', review_round: 1, undo_expires_at: null });

    await c.coordinator.applyEvent(task.id, { type: 'accepted' });
    c.clock.advance(10_001);
    expect(await c.coordinator.applyEvent(task.id, { type: 'undone' })).toEqual({ applied: false, ignored: 'invalid' });
    await c.coordinator.applyEvent(task.id, { type: 'undo_expired' });
    expect(c.store.getTask(task.id)).toMatchObject({ state: 'integrating', undo_expires_at: null });
    expect(c.store.effectsOfTask(task.id).at(-1)).toMatchObject({ kind: 'integrate' });

    const bootstrap = await c.coordinator.createTask({ project_id: c.project.id, kind: 'bootstrap' });
    c.store.updateTask(bootstrap.id, { state: 'in_review', updated_at: c.clock.now().toISOString() });
    await c.coordinator.applyEvent(bootstrap.id, { type: 'accepted' });
    expect(await c.coordinator.applyEvent(bootstrap.id, { type: 'undo_expired' })).toEqual({ applied: false, ignored: 'invalid' }); // window still open
    c.clock.advance(10_001);
    await c.coordinator.applyEvent(bootstrap.id, { type: 'undo_expired' });
    expect(c.store.getTask(bootstrap.id)!.state).toBe('released');
  });

  it('a counting entry past the budget commits straight to triage with budget_spent in the log', async () => {
    const c = await setup({ ...POLICY, limits: { ...POLICY.limits, iteration_budget: 1 } });
    const task = await toImplementing(c);
    expect(c.store.getTask(task.id)!.budget_used).toBe(1);
    await c.coordinator.applyEvent(task.id, { type: 'implementer_done', stage_id: task.current_stage_id! });
    const testing = c.store.getTask(task.id)!;
    const result = await c.coordinator.applyEvent(task.id, { type: 'test_failed', stage_id: testing.current_stage_id! });
    expect(result).toEqual({ applied: true, state: 'triage', effects: 1 });
    const triage = c.store.getTask(task.id)!;
    expect(triage).toMatchObject({ state: 'triage', budget_used: 1 });
    expect(c.store.getStage(triage.current_stage_id!)).toMatchObject({ role: 'triage', status: 'starting' });
    expect(c.store.stageEventsOfTask(task.id).slice(-2).map((e) => [e.event_type, e.from_state, e.to_state])).toEqual([
      ['test_failed', 'testing', 'implementing'],
      ['budget_spent', 'implementing', 'triage'],
    ]);
  });

  it('two concurrent applyEvent calls are serialized: the log holds them in call order and the second saw the first state', async () => {
    const c = await setup();
    const first = c.coordinator.applyEvent(c.task.id, { type: 'draft_ready' });
    const second = c.coordinator.applyEvent(c.task.id, { type: 'approved' });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ applied: true, state: 'awaiting_approval', effects: 0 });
    expect(r2).toEqual({ applied: true, state: 'queued', effects: 0 });
    const log = c.store.stageEventsOfTask(c.task.id).map((e) => [e.event_type, e.from_state, e.to_state]);
    expect(log).toEqual([
      ['new_draft', null, 'draft'],
      ['draft_ready', 'draft', 'awaiting_approval'],
      ['approved', 'awaiting_approval', 'queued'],
    ]);
  });

  it('a failing call does not stall the queue', async () => {
    const c = await setup();
    const failing = c.coordinator.applyEvent('missing', { type: 'draft_ready' });
    const next = c.coordinator.applyEvent(c.task.id, { type: 'draft_ready' });
    await expect(failing).rejects.toThrow(TaskNotFoundError);
    expect(await next).toMatchObject({ applied: true, state: 'awaiting_approval' });
  });

  it('backOnline queues one effect per Project with an ACTIVE Task', async () => {
    const c = await setup();
    const idle = await c.coordinator.createProject('idle');
    await c.coordinator.createTask({ project_id: idle.id, kind: 'feature' }); // draft is not ACTIVE
    const busy = await c.coordinator.createProject('busy');
    await c.coordinator.createTask({ project_id: busy.id, kind: 'bootstrap' }); // queued is ACTIVE
    await c.coordinator.createTask({ project_id: busy.id, kind: 'bootstrap' });
    expect(await c.coordinator.backOnline(7_200_000)).toBe(1);
    expect(c.store.pendingEffects().map((e) => e.effect)).toEqual([{ kind: 'back_online', project_id: busy.id, gap_ms: 7_200_000 }]);
  });
});
