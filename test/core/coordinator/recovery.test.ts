import { afterEach, describe, expect, it } from 'vitest';
import { Coordinator, type CoordinatorPolicy } from '../../../src/core/coordinator/coordinator.ts';
import { EffectExecutor } from '../../../src/core/coordinator/effects.ts';
import { recover, RESTART } from '../../../src/core/coordinator/recovery.ts';
import type { Effect } from '../../../src/core/domain/effects.ts';
import { fakeClock, type FakeClock } from '../../helpers/clock.ts';
import { openTestStore, reopenTestStore, type TestStore } from '../../helpers/store.ts';

const POLICY: CoordinatorPolicy = {
  limits: { iteration_budget: 5, undo_accept_ms: 10_000, undo_discard_ms: 60_000 },
  roles: { implementer: { retries: 2 } },
};

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

/**
 * A daemon's core over `ts`, with a `start_stage` handler that records launches instead of spawning.
 * No commit hook: like the daemon at boot, nothing drains until `recover` does.
 */
function boot(ts: TestStore, clock: FakeClock) {
  const launched: Effect[] = [];
  const coordinator = new Coordinator({ store: ts.store, clock, policy: () => POLICY });
  const executor = new EffectExecutor(ts.store, clock);
  executor.register('start_stage', (effect) => {
    launched.push(effect);
  });
  return { coordinator, executor, launched };
}

describe('boot recovery (AD-18)', () => {
  it('acceptance: killed before the executor ran, the next boot fails the Stage (restart) and launches attempt 2 with budget_used still 1', async () => {
    const first = openTestStore();
    open.push(first);
    const clock = fakeClock();
    // No executor attached: the daemon dies between commit and drain.
    const coordinator = new Coordinator({ store: first.store, clock, policy: () => POLICY });
    const project = await coordinator.createProject('p');
    const task = await coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    const stage1 = first.store.getTask(task.id)!.current_stage_id!;
    expect(first.store.getStage(stage1)!.status).toBe('starting');
    expect(first.store.pendingEffects()).toHaveLength(1);
    first.close();

    const second = reopenTestStore(first.file);
    open.push(second);
    const { coordinator: c2, executor, launched } = boot(second, clock);
    // Drain is part of recover; inspect the pending queue through the recording handler.
    const report = await recover({ store: second.store, coordinator: c2, executor, clock });

    const after = second.store.getTask(task.id)!;
    expect(after).toMatchObject({ state: 'implementing', budget_used: 1 });
    expect(second.store.getStage(stage1)).toMatchObject({ status: 'failed', reason: RESTART });
    const stage2 = after.current_stage_id!;
    expect(second.store.getStage(stage2)).toMatchObject({ attempt: 2, status: 'starting' });
    // The orphaned attempt-1 launch was marked done without launching; attempt 2 was pending and ran.
    expect(launched).toEqual([{ kind: 'start_stage', stage_id: stage2, task_id: task.id, role: 'implementer', attempt: 2 }]);
    const effects = second.store.effectsOfTask(task.id);
    expect(effects.map((e) => [e.effect.kind === 'start_stage' ? e.effect.attempt : 0, e.status])).toEqual([
      [1, 'done'],
      [2, 'done'],
    ]);
    expect(report).toEqual({ stages_restarted: 1, effects_orphaned: 1, effects_replayed: 1 });
  });

  it('a running Stage is failed(restart) too, and pending effects of other kinds are re-executed', async () => {
    const ts = openTestStore();
    open.push(ts);
    const clock = fakeClock();
    const { coordinator, executor, launched } = boot(ts, clock);
    const project = await coordinator.createProject('p');
    const task = await coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    await executor.drain();
    const stage1 = ts.store.getTask(task.id)!.current_stage_id!;
    await coordinator.applyEvent(task.id, { type: 'stage_started', stage_id: stage1 });
    expect(ts.store.getStage(stage1)!.status).toBe('running');
    // A back_online effect left pending by the crash.
    ts.store.insertEffect({ effect_id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ', task_id: null, kind: 'back_online', effect: { kind: 'back_online', project_id: project.id, gap_ms: 1 }, status: 'pending', error: null, created_at: clock.now().toISOString(), finished_at: null });
    const seen: string[] = [];
    executor.register('back_online', (effect) => {
      seen.push(effect.project_id);
    });

    const report = await recover({ store: ts.store, coordinator, executor, clock });
    expect(ts.store.getStage(stage1)).toMatchObject({ status: 'failed', reason: RESTART });
    expect(ts.store.getStage(ts.store.getTask(task.id)!.current_stage_id!)).toMatchObject({ attempt: 2 });
    expect(launched.map((e) => (e.kind === 'start_stage' ? e.attempt : 0))).toEqual([1, 2]);
    expect(seen).toEqual([project.id]);
    expect(report).toEqual({ stages_restarted: 1, effects_orphaned: 0, effects_replayed: 2 });
  });

  it('a third restart exhausts the retries and the Task is stuck', async () => {
    const ts = openTestStore();
    open.push(ts);
    const clock = fakeClock();
    const { coordinator, executor } = boot(ts, clock);
    const project = await coordinator.createProject('p');
    const task = await coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    for (let i = 0; i < 3; i++) {
      await recover({ store: ts.store, coordinator, executor, clock });
    }
    expect(ts.store.getTask(task.id)).toMatchObject({ state: 'stuck', budget_used: 1, stuck_reason: `implementer Stage failed 3 times; last failure: ${RESTART}` });
    expect(ts.store.stagesInStatus(['starting', 'running'])).toEqual([]);
  });

  it('a pending launch whose Stage was cancelled before the executor reached it is retired without launching', async () => {
    const ts = openTestStore();
    open.push(ts);
    const clock = fakeClock();
    const { coordinator, executor, launched } = boot(ts, clock);
    const project = await coordinator.createProject('p');
    const task = await coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    await coordinator.applyEvent(task.id, { type: 'pause' });
    expect(ts.store.pendingEffects().map((e) => e.kind)).toEqual(['start_stage', 'cancel_stage']);
    executor.register('cancel_stage', () => {});
    const report = await recover({ store: ts.store, coordinator, executor, clock });
    expect(launched).toEqual([]);
    expect(report).toEqual({ stages_restarted: 0, effects_orphaned: 1, effects_replayed: 1 });
    expect(ts.store.pendingEffects()).toEqual([]);
  });

  it('a live Stage row the Task no longer points at is closed directly', async () => {
    const ts = openTestStore();
    open.push(ts);
    const clock = fakeClock();
    const { coordinator, executor } = boot(ts, clock);
    const project = await coordinator.createProject('p');
    const task = await coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    ts.store.insertStage({ id: 'orphan', task_id: task.id, role: 'validator', attempt: 1, status: 'running', reason: null, created_at: clock.now().toISOString(), started_at: null, ended_at: null });
    await recover({ store: ts.store, coordinator, executor, clock });
    expect(ts.store.getStage('orphan')).toMatchObject({ status: 'failed', reason: RESTART });
    expect(ts.store.getTask(task.id)!.state).toBe('queued');
    expect(ts.store.stageEventsOfTask(task.id).at(-1)).toMatchObject({ event_type: 'stage_failed', status: 'ignored', ignore_reason: 'stale' });
  });
});
