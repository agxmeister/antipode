import { afterEach, describe, expect, it, vi } from 'vitest';
import { Coordinator, type CoordinatorPolicy } from '../../../src/core/coordinator/coordinator.ts';
import { EffectExecutor } from '../../../src/core/coordinator/effects.ts';
import {
  evaluateGates,
  Scheduler,
  usageHold,
  USAGE_WINDOW_RESUMED,
  USAGE_WINDOW_WAIT,
  type GateInput,
  type SchedulerPolicy,
} from '../../../src/core/coordinator/scheduler.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import { taskSchema, type Project, type Task } from '../../../src/core/domain/task.ts';
import type { Log } from '../../../src/core/ports/log.ts';
import type { UsageReading, WindowReader } from '../../../src/core/ports/window-reader.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

const COORDINATOR_POLICY: CoordinatorPolicy = {
  limits: { iteration_budget: 5, undo_accept_ms: 10_000, undo_discard_ms: 60_000 },
  roles: { implementer: { retries: 2 }, validator: { retries: 2 }, triage: { retries: 2 }, 'evidence-producer': { retries: 2 } },
};

const POLL_MS = 60_000;
const RESETS_AT = '2026-11-08T15:00:00.000Z';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

function reading(fiveHour: number, weekly = 10, resetsAt = RESETS_AT): UsageReading {
  return { five_hour: { utilization: fiveHour, resets_at: resetsAt }, weekly: { utilization: weekly, resets_at: '2026-11-12T00:00:00.000Z' } };
}

function setup(limits: Partial<SchedulerPolicy['limits']> = {}, usage: Partial<SchedulerPolicy['usage']> = {}) {
  const ts = openTestStore();
  open.push(ts);
  const clock = fakeClock();
  const warnings: Array<Record<string, unknown>> = [];
  const log: Log = { debug() {}, info() {}, warn: (fields) => warnings.push(fields), error() {} };
  const coordinator = new Coordinator({ store: ts.store, clock, policy: () => COORDINATOR_POLICY });
  const executor = new EffectExecutor(ts.store, clock);
  const launched: string[] = [];
  const notices: Array<{ notice_kind: string; task_id?: string; payload?: Record<string, unknown> }> = [];
  executor.register('start_stage', (effect) => {
    launched.push(effect.task_id);
  });
  executor.register('notify', (effect) => {
    notices.push({ notice_kind: effect.notice_kind, task_id: effect.task_id, payload: effect.payload });
  });
  for (const kind of ['run_test_step', 'cancel_stage', 'integrate', 'back_online'] as const) executor.register(kind, () => {});
  coordinator.onEffectsCommitted(() => executor.notify());

  const window: { value: UsageReading | null | Error | 'hang'; reads: number } = { value: null, reads: 0 };
  const windowReader: WindowReader = {
    read: async () => {
      window.reads++;
      if (window.value instanceof Error) throw window.value;
      if (window.value === 'hang') return new Promise<never>(() => {});
      return window.value;
    },
  };
  const policy: SchedulerPolicy = {
    limits: { concurrency: 2, open_reviews: 3, ...limits },
    usage: { pause_at_percent: 85, poll_interval_ms: POLL_MS, ...usage },
  };
  const scheduler = new Scheduler({ store: ts.store, coordinator, executor, windowReader, clock, policy: () => policy, log });
  executor.setGuard(['start_stage'], scheduler.launchGuard);

  /** One scheduler tick, then everything it caused has committed and drained. */
  const tick = async (): Promise<void> => {
    await scheduler.tick();
    await coordinator.idle();
    await executor.drain();
  };

  const project = (name: string, paused = false): Project => {
    const p: Project = { id: ulid(), name, paused_at: paused ? clock.now().toISOString() : null, telegram_chat_id: null, repo_url: null, created_at: clock.now().toISOString() };
    ts.store.insertProject(p);
    return p;
  };

  /** A Task row in any state, as earlier stories would have left it. */
  const task = (projectId: string, overrides: Partial<Task> = {}): Task => {
    const now = clock.now().toISOString();
    const t = taskSchema.parse({
      id: ulid(),
      project_id: projectId,
      kind: 'feature',
      task_no: ts.store.nextTaskNo(projectId),
      state: 'queued',
      current_stage_id: null,
      budget_used: 0,
      budget_limit: 5,
      review_round: 0,
      resume_state: null,
      stuck_reason: null,
      waiting_reason: null,
      undo_expires_at: null,
      config_sha: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    });
    ts.store.insertTask(t);
    return t;
  };

  /** A Project whose bootstrap is accepted, so feature Tasks pass the bootstrap gate. */
  const bootstrapped = (name: string): Project => {
    const p = project(name);
    task(p.id, { kind: 'bootstrap', state: 'released' });
    return p;
  };
  const bootstrapOf = (projectId: string): Task => ts.store.tasksInStates(['released']).find((t) => t.project_id === projectId && t.kind === 'bootstrap')!;

  const get = (id: string): Task => ts.store.getTask(id)!;
  const notifyRows = (taskId: string, kind: string) =>
    ts.store.effectsOfTask(taskId).filter((r) => r.effect.kind === 'notify' && r.effect.notice_kind === kind);

  return { ...ts, clock, coordinator, executor, scheduler, window, warnings, launched, notices, tick, project, task, bootstrapped, bootstrapOf, get, notifyRows };
}

describe('evaluateGates (AD-11)', () => {
  const open: GateInput = {
    kind: 'feature',
    projectPaused: false,
    usageHeld: false,
    running: 0,
    concurrency: 2,
    openReviews: 0,
    openReviewsLimit: 3,
    dependenciesMerged: true,
    bootstrapReleased: true,
  };
  const allFailing: GateInput = {
    kind: 'feature',
    projectPaused: true,
    usageHeld: true,
    running: 2,
    concurrency: 2,
    openReviews: 3,
    openReviewsLimit: 3,
    dependenciesMerged: false,
    bootstrapReleased: false,
  };

  it('passes when every gate is open', () => {
    expect(evaluateGates(open)).toBeNull();
  });

  // Each row clears the gates before it: the first failing gate in AD-11 order is reported.
  it.each([
    ['paused', {}],
    ['usage_window', { projectPaused: false }],
    ['concurrency', { projectPaused: false, usageHeld: false }],
    ['open_reviews', { projectPaused: false, usageHeld: false, running: 1 }],
    ['dependencies', { projectPaused: false, usageHeld: false, running: 1, openReviews: 2 }],
    ['bootstrap', { projectPaused: false, usageHeld: false, running: 1, openReviews: 2, dependenciesMerged: true }],
  ] as const)('reports %s first', (gate, cleared) => {
    expect(evaluateGates({ ...allFailing, ...cleared })).toBe(gate);
  });

  it('skips the bootstrap gate for a bootstrap Task', () => {
    expect(evaluateGates({ ...open, kind: 'bootstrap', bootstrapReleased: false })).toBeNull();
    expect(evaluateGates({ ...open, kind: 'feature', bootstrapReleased: false })).toBe('bootstrap');
  });

  it('usageHold holds at or above the threshold until the latest reset of the full windows', () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    expect(usageHold(null, 85, now)).toBeNull();
    expect(usageHold(reading(84.9), 85, now)).toBeNull();
    expect(usageHold(reading(85), 85, now)).toEqual({ resets_at: RESETS_AT });
    expect(usageHold(reading(10, 90), 85, now)).toEqual({ resets_at: '2026-11-12T00:00:00.000Z' });
    expect(usageHold(reading(95, 90), 85, now)).toEqual({ resets_at: '2026-11-12T00:00:00.000Z' });
  });

  it('usageHold ignores a full window whose resets_at is not after now', () => {
    expect(usageHold(reading(95), 85, new Date(RESETS_AT))).toBeNull();
    expect(usageHold(reading(95), 85, new Date('2026-11-08T16:00:00.000Z'))).toBeNull();
    // Five-hour window already reset, weekly still full: the weekly hold remains.
    expect(usageHold(reading(95, 90), 85, new Date('2026-11-08T16:00:00.000Z'))).toEqual({ resets_at: '2026-11-12T00:00:00.000Z' });
  });
});

describe('Scheduler (AD-11)', () => {
  it('Start: a queued feature Task with its bootstrap released starts', async () => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const t = s.task(p.id);
    await s.tick();
    expect(s.get(t.id)).toMatchObject({ state: 'implementing', waiting_reason: null, budget_used: 1 });
    expect(s.store.stageEventsOfTask(t.id)).toMatchObject([{ event_type: 'scheduler_start', status: 'applied', to_state: 'implementing' }]);
    expect(s.launched).toEqual([t.id]);
  });

  it('Concurrency: cap 2 with one running starts only the oldest of three queued', async () => {
    const s = setup({ concurrency: 2 });
    const p = s.bootstrapped('alpha');
    s.task(p.id, { state: 'validating' });
    const queued = [s.task(p.id), s.task(p.id), s.task(p.id)];
    await s.tick();
    expect(queued.map((t) => [s.get(t.id).state, s.get(t.id).waiting_reason])).toEqual([
      ['implementing', null],
      ['queued', 'concurrency'],
      ['queued', 'concurrency'],
    ]);
  });

  it('Backpressure: three open Reviews across Projects hold a start without a notice', async () => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const other = s.bootstrapped('beta');
    s.task(p.id, { state: 'in_review' });
    s.task(other.id, { state: 'in_review' });
    s.task(other.id, { state: 'accept_pending', undo_expires_at: '2026-11-09T00:00:00.000Z' });
    const t = s.task(p.id);
    await s.tick();
    expect(s.get(t.id)).toMatchObject({ state: 'queued', waiting_reason: 'open_reviews' });
    expect(s.store.stageEventsOfTask(t.id)).toEqual([]);
    expect(s.store.effectsOfTask(t.id)).toEqual([]);
  });

  it('Gate order: a paused Project with a full window waits on paused, with no usage notice', async () => {
    const s = setup();
    const p = s.project('alpha', true);
    s.task(p.id, { kind: 'bootstrap', state: 'released' });
    const t = s.task(p.id);
    s.window.value = reading(99);
    await s.tick();
    expect(s.get(t.id)).toMatchObject({ state: 'queued', waiting_reason: 'paused' });
    expect(s.notices).toEqual([]);
  });

  it('Dependency: unmerged → waiting_on_dependencies; merged → queued (and started); cancelled → stuck naming the Task', async () => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const dep = s.task(p.id, { state: 'implementing' });
    const t = s.task(p.id);
    s.store.insertDependency(t.id, dep.id);

    await s.tick();
    expect(s.get(t.id).state).toBe('waiting_on_dependencies');
    await s.tick();
    expect(s.get(t.id).state).toBe('waiting_on_dependencies');

    s.store.updateTask(dep.id, { state: 'merged', updated_at: s.clock.now().toISOString() });
    await s.tick();
    expect(s.store.stageEventsOfTask(t.id).map((e) => [e.event_type, e.to_state])).toEqual([
      ['deps_unmerged', 'waiting_on_dependencies'],
      ['deps_merged', 'queued'],
      ['scheduler_start', 'implementing'],
    ]);

    // Not a running state: with t now implementing, a second running Task would fill concurrency first.
    const dep2 = s.task(p.id, { state: 'in_review' });
    const t2 = s.task(p.id);
    s.store.insertDependency(t2.id, dep2.id);
    await s.tick();
    expect(s.get(t2.id).state).toBe('waiting_on_dependencies');
    s.store.updateTask(dep2.id, { state: 'cancelled', updated_at: s.clock.now().toISOString() });
    await s.tick();
    expect(s.get(t2.id)).toMatchObject({ state: 'stuck', stuck_reason: `dependency #${dep2.task_no} was cancelled` });
  });

  it('Dependency: a released bootstrap is not a merged dependency; release_failed and released features are', async () => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const t = s.task(p.id);
    s.store.insertDependency(t.id, s.bootstrapOf(p.id).id);
    await s.tick();
    expect(s.get(t.id).state).toBe('waiting_on_dependencies');

    const t2 = s.task(p.id);
    s.store.insertDependency(t2.id, s.task(p.id, { state: 'release_failed' }).id);
    s.store.insertDependency(t2.id, s.task(p.id, { state: 'released' }).id);
    await s.tick();
    expect(s.get(t2.id).state).toBe('implementing');
  });

  it('Bootstrap: a feature Task waits while the bootstrap is in review; a queued bootstrap Task starts', async () => {
    const s = setup();
    const p = s.project('alpha');
    s.task(p.id, { kind: 'bootstrap', state: 'in_review' });
    const feature = s.task(p.id);
    const fresh = s.project('beta');
    const boot = await s.coordinator.createTask({ project_id: fresh.id, kind: 'bootstrap' });
    await s.tick();
    expect(s.get(feature.id)).toMatchObject({ state: 'queued', waiting_reason: 'bootstrap' });
    expect(s.get(boot.id)).toMatchObject({ state: 'implementing' });
  });

  it('Usage hold at start: usage_window, one wait notice per resets_at across ticks, no stage_events from held ticks', async () => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const t = s.task(p.id);
    s.window.value = reading(90);
    await s.tick();
    expect(s.get(t.id)).toMatchObject({ state: 'queued', waiting_reason: 'usage_window' });
    const updatedAt = s.get(t.id).updated_at;

    for (let i = 0; i < 10; i++) {
      s.clock.advance(POLL_MS);
      await s.tick();
    }
    expect(s.window.reads).toBe(11);
    expect(s.store.stageEventsOfTask(t.id)).toEqual([]);
    expect(s.get(t.id).updated_at).toBe(updatedAt);
    expect(s.notices).toEqual([{ notice_kind: USAGE_WINDOW_WAIT, task_id: t.id, payload: { resets_at: RESETS_AT, key: RESETS_AT } }]);

    // A new window period is a new hold: one more notice.
    s.window.value = reading(90, 10, '2026-11-08T20:00:00.000Z');
    s.clock.advance(POLL_MS);
    await s.tick();
    expect(s.notifyRows(t.id, USAGE_WINDOW_WAIT)).toHaveLength(2);

    // Window reopens: the Task starts and one resumed notice follows.
    s.window.value = reading(20);
    s.clock.advance(POLL_MS);
    await s.tick();
    await s.tick();
    expect(s.get(t.id).state).toBe('implementing');
    expect(s.notifyRows(t.id, USAGE_WINDOW_RESUMED)).toHaveLength(1);
  });

  it('polls the reader only every usage.poll_interval_ms and keeps the last reading', async () => {
    const s = setup();
    s.window.value = reading(90);
    await s.tick();
    await s.tick();
    s.clock.advance(POLL_MS - 1);
    await s.tick();
    expect(s.window.reads).toBe(1);
    s.clock.advance(1);
    await s.tick();
    expect(s.window.reads).toBe(2);
    expect(s.scheduler.reading()).toEqual(reading(90));
  });

  it('Launch hold: start_stage stays pending while the window is full, other effects drain; reopening launches it with one resumed notice', async () => {
    const s = setup();
    const p = s.project('alpha');
    const boot = await s.coordinator.createTask({ project_id: p.id, kind: 'bootstrap' });
    await s.tick();
    let task = s.get(boot.id);
    await s.coordinator.applyEvent(task.id, { type: 'stage_started', stage_id: task.current_stage_id! });
    await s.coordinator.applyEvent(task.id, { type: 'implementer_done', stage_id: task.current_stage_id! });
    task = s.get(boot.id);
    expect(task.state).toBe('testing');

    s.window.value = reading(95);
    s.clock.advance(POLL_MS);
    await s.tick();
    // The test step uses no Claude usage and was never gated.
    expect(s.store.effectsOfTask(task.id).filter((r) => r.kind === 'run_test_step').every((r) => r.status === 'done')).toBe(true);

    await s.coordinator.applyEvent(task.id, { type: 'test_passed', stage_id: task.current_stage_id! });
    await s.coordinator.backOnline(5_000);
    await s.coordinator.idle();
    await s.executor.drain();
    task = s.get(boot.id);
    expect(task).toMatchObject({ state: 'validating', waiting_reason: 'usage_window' });
    expect(s.store.getStage(task.current_stage_id!)).toMatchObject({ status: 'starting', role: 'validator' });
    const launch = s.store.effectsOfTask(task.id).filter((r) => r.kind === 'start_stage').at(-1)!;
    expect(launch.status).toBe('pending');
    expect(s.store.pendingEffects().map((r) => r.effect_id)).toEqual([launch.effect_id]);
    expect(s.launched).toEqual([task.id]);
    expect(s.notifyRows(task.id, USAGE_WINDOW_WAIT)).toHaveLength(1);

    // Still full: further ticks and drains change nothing.
    s.clock.advance(POLL_MS);
    await s.tick();
    await s.executor.drain();
    expect(s.store.getEffect(launch.effect_id)?.status).toBe('pending');
    expect(s.notifyRows(task.id, USAGE_WINDOW_WAIT)).toHaveLength(1);

    s.window.value = reading(40);
    s.clock.advance(POLL_MS);
    await s.tick();
    await s.executor.drain();
    expect(s.store.getEffect(launch.effect_id)?.status).toBe('done');
    expect(s.launched).toEqual([task.id, task.id]);
    expect(s.get(task.id).waiting_reason).toBeNull();
    await s.tick();
    expect(s.notifyRows(task.id, USAGE_WINDOW_RESUMED)).toHaveLength(1);
  });

  it('Launch hold: never holds a launch whose Stage is no longer starting', async () => {
    const s = setup();
    const p = s.project('alpha');
    const boot = await s.coordinator.createTask({ project_id: p.id, kind: 'bootstrap' });
    s.window.value = reading(95);
    await s.tick();
    await s.coordinator.applyEvent(boot.id, { type: 'scheduler_start' });
    await s.coordinator.idle();
    await s.executor.drain();
    const launch = s.store.effectsOfTask(boot.id).find((r) => r.kind === 'start_stage')!;
    expect(launch.status).toBe('pending');
    await s.coordinator.applyEvent(boot.id, { type: 'cancel' });
    await s.coordinator.idle();
    await s.executor.drain();
    expect(s.store.getEffect(launch.effect_id)?.status).toBe('done');
  });

  it.each([
    ['returns null', null],
    ['throws', new Error('usage endpoint down')],
  ])('Unreadable window: a reader that %s leaves the gate open', async (_name, value) => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const t = s.task(p.id);
    s.window.value = reading(99);
    await s.tick();
    expect(s.get(t.id).waiting_reason).toBe('usage_window');
    s.window.value = value;
    s.clock.advance(POLL_MS);
    await expect(s.scheduler.tick()).resolves.toBeUndefined();
    await s.tick();
    expect(s.get(t.id).state).toBe('implementing');
    expect(s.scheduler.reading()).toBeNull();
    if (value instanceof Error) {
      expect(s.warnings).toMatchObject([{ event: 'usage_window_unreadable', error: 'usage endpoint down' }]);
    } else {
      expect(s.warnings).toEqual([]);
    }
  });

  it('Undo expiry: undo_expired is applied once after the window passes; a duplicate is ignored(invalid)', async () => {
    const s = setup();
    const p = s.project('alpha');
    const expiresAt = new Date(s.clock.now().getTime() + 10_000).toISOString();
    const accept = s.task(p.id, { kind: 'bootstrap', state: 'accept_pending', undo_expires_at: expiresAt });
    const discard = s.task(p.id, { state: 'discard_pending', undo_expires_at: expiresAt });
    await s.tick();
    expect(s.get(accept.id).state).toBe('accept_pending');
    s.clock.advance(10_000);
    await s.tick();
    await s.tick();
    expect(s.get(accept.id).state).toBe('released');
    expect(s.get(discard.id).state).toBe('cancelled');
    expect(s.store.stageEventsOfTask(accept.id).map((e) => [e.event_type, e.status])).toEqual([['undo_expired', 'applied']]);
    expect(await s.coordinator.applyEvent(accept.id, { type: 'undo_expired' })).toEqual({ applied: false, ignored: 'invalid' });
  });

  it('a start counts against the next Task: concurrency 1 starts exactly one of several queued across Projects', async () => {
    const s = setup({ concurrency: 1 });
    const a = s.project('a');
    const b = s.project('b');
    const ta = await s.coordinator.createTask({ project_id: a.id, kind: 'bootstrap' });
    const tb = await s.coordinator.createTask({ project_id: b.id, kind: 'bootstrap' });
    await s.tick();
    expect([s.get(ta.id).state, s.get(tb.id)]).toMatchObject(['implementing', { state: 'queued', waiting_reason: 'concurrency' }]);
  });

  it('concurrent tick calls join one tick', async () => {
    const s = setup();
    const first = s.scheduler.tick();
    const second = s.scheduler.tick();
    expect(second).toBe(first);
    await first;
    expect(s.window.reads).toBe(1);
  });

  it('Launch hold released while a drain is in flight: the held launch still runs', async () => {
    const s = setup();
    const p = s.project('alpha');
    const boot = await s.coordinator.createTask({ project_id: p.id, kind: 'bootstrap' });
    s.window.value = reading(95);
    await s.tick();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    s.executor.register('back_online', () => blocked);
    // The launch is held by this drain, which then blocks on a slow effect queued after it.
    await s.coordinator.applyEvent(boot.id, { type: 'scheduler_start' });
    await s.coordinator.backOnline(5_000);
    await s.coordinator.idle();
    await vi.waitFor(() => expect(s.get(boot.id).waiting_reason).toBe('usage_window'));
    const launch = s.store.effectsOfTask(boot.id).find((r) => r.kind === 'start_stage')!;

    s.window.value = reading(20);
    s.clock.advance(POLL_MS);
    const ticking = s.scheduler.tick();
    await vi.waitFor(() => expect(s.get(boot.id).waiting_reason).toBeNull());
    unblock();
    await ticking;
    await s.executor.drain();
    expect(s.store.getEffect(launch.effect_id)?.status).toBe('done');
    expect(s.launched).toEqual([boot.id]);
  });

  it('the launch guard polls the reader before the first tick, so a full window holds an early launch', async () => {
    const s = setup();
    const p = s.project('alpha');
    const boot = await s.coordinator.createTask({ project_id: p.id, kind: 'bootstrap' });
    s.window.value = reading(95);
    await s.coordinator.applyEvent(boot.id, { type: 'scheduler_start' });
    await s.coordinator.idle();
    await s.executor.drain();
    expect(s.window.reads).toBe(1);
    expect(s.store.effectsOfTask(boot.id).find((r) => r.kind === 'start_stage')?.status).toBe('pending');
    expect(s.get(boot.id).waiting_reason).toBe('usage_window');
    expect(s.launched).toEqual([]);
  });

  it('a reader that never answers times out after usage.poll_interval_ms: warn, gate open, the tick ends', async () => {
    const s = setup({}, { poll_interval_ms: 20 });
    const p = s.bootstrapped('alpha');
    const t = s.task(p.id);
    s.window.value = reading(95);
    await s.tick();
    expect(s.get(t.id).waiting_reason).toBe('usage_window');
    s.window.value = 'hang';
    s.clock.advance(20);
    await s.tick();
    expect(s.window.reads).toBe(2);
    expect(s.warnings).toMatchObject([{ event: 'usage_window_unreadable', error: 'usage window read timed out after 20 ms' }]);
    expect(s.scheduler.reading()).toBeNull();
    expect(s.get(t.id).state).toBe('implementing');
  });

  it('Usage hold: a held Task that moves to an earlier gate while the window is still full gets no resumed notice', async () => {
    const s = setup();
    const p = s.bootstrapped('alpha');
    const t = s.task(p.id);
    s.window.value = reading(90);
    await s.tick();
    expect(s.get(t.id).waiting_reason).toBe('usage_window');
    s.db.prepare('UPDATE projects SET paused_at = ? WHERE id = ?').run(s.clock.now().toISOString(), p.id);
    await s.tick();
    expect(s.get(t.id).waiting_reason).toBe('paused');
    expect(s.notifyRows(t.id, USAGE_WINDOW_RESUMED)).toEqual([]);
    s.window.value = reading(20);
    s.clock.advance(POLL_MS);
    await s.tick();
    expect(s.notifyRows(t.id, USAGE_WINDOW_RESUMED)).toHaveLength(1);
  });
});
