import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logTail, TestStep, LOG_TAIL_LINES } from '../../src/app/test-step.ts';
import type { StepRequest, StepRunResult } from '../../src/app/steps.ts';
import type { EventRows } from '../../src/core/coordinator/coordinator.ts';
import type { Event } from '../../src/core/domain/events.ts';
import { taskSchema, type Task } from '../../src/core/domain/task.ts';
import { recipeWith } from '../helpers/steps.ts';
import { openTestStore, type TestStore } from '../helpers/store.ts';

const NOW = '2026-11-20T12:00:00.000Z';
const SHA = 'c0ffee0000000000000000000000000000000000';
const TEST_RECIPE = recipeWith('  test: { runner: container, image: busybox, cmd: "true", timeout: 1m }');

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

interface Harness extends TestStore {
  task: Task;
  stageId: string;
  applied: Array<{ event: Event; rows?: EventRows }>;
  pushes: Array<[string, string]>;
  requests: StepRequest[];
  testStep: TestStep;
}

function harness(options: { recipe?: string; push?: () => Promise<void>; run?: (request: StepRequest) => Promise<StepRunResult>; onStarted?: () => void } = {}): Harness {
  const ts = openTestStore();
  open.push(ts);
  ts.store.insertProject({ id: 'p1', name: 'training', paused_at: null, telegram_chat_id: null, repo_url: null, exclusive_capabilities: [], created_at: NOW });
  const task = taskSchema.parse({
    id: 't1', project_id: 'p1', kind: 'feature', task_no: 4, state: 'testing', current_stage_id: 's1', budget_used: 1, budget_limit: 3, review_round: 0,
    resume_state: null, stuck_reason: null, waiting_reason: null, undo_expires_at: null, config_sha: SHA, title: 'Rest timer', slug: 'rest-timer', created_at: NOW, updated_at: NOW,
  });
  ts.store.insertTask(task);
  ts.store.insertStage({ id: 's1', task_id: 't1', role: 'test', attempt: 1, status: 'starting', reason: null, created_at: NOW, started_at: null, ended_at: null });
  const applied: Harness['applied'] = [];
  const pushes: Harness['pushes'] = [];
  const requests: StepRequest[] = [];
  const testStep = new TestStep({
    store: ts.store,
    coordinator: {
      applyEvent: async (_taskId, event, rows) => {
        applied.push({ event, ...(rows === undefined ? {} : { rows }) });
        if (event.type === 'stage_started') {
          ts.store.updateStage('s1', { status: 'running' });
          options.onStarted?.();
        }
        return { applied: true, state: 'testing', effects: 0 };
      },
    },
    repo: {
      pushBranch: async (name, branch) => {
        pushes.push([name, branch]);
        await options.push?.();
      },
      readFile: async (_name, sha, path) => (sha === SHA && path === 'antipod.yaml' ? (options.recipe ?? TEST_RECIPE) : undefined),
    },
    steps: {
      run: async (request) => {
        requests.push(request);
        return options.run === undefined ? { ok: true, step_run_id: 'r1', outcome: 'exited', exit_code: 0, log: '/nowhere', out: '/nowhere' } : options.run(request);
      },
    },
  });
  return { ...ts, task, stageId: 's1', applied, pushes, requests, testStep };
}

async function result(h: Harness): Promise<{ event: Event; rows?: EventRows }> {
  await h.testStep.run({ kind: 'run_test_step', stage_id: 's1', task_id: 't1', attempt: 1 });
  await vi.waitFor(() => expect(h.applied).toHaveLength(2));
  return h.applied[1]!;
}

function logFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'antipod-test-log-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log'), text);
  return join(dir, 'log');
}

describe('the testing Stage (AD-5, AD-13)', () => {
  it('reports stage_started, pushes the Branch, runs the test step for the Task; exit 0 is test_passed with its output stored', async () => {
    const h = harness();
    const { event, rows } = await result(h);
    expect(h.applied[0]!.event).toEqual({ type: 'stage_started', stage_id: 's1' });
    expect(h.pushes).toEqual([['training', 'antipod/4-rest-timer']]);
    expect(h.requests).toMatchObject([{ taskId: 't1', step: 'test' }]);
    expect(event).toEqual({ type: 'test_passed', stage_id: 's1' });
    rows!(h.task);
    expect(h.store.getStage('s1')?.output).toEqual({ step_run_id: 'r1', outcome: 'exited', exit_code: 0, log_tail: null });
  });

  it('a Recipe without a test step passes after the push and runs nothing', async () => {
    const h = harness({ recipe: recipeWith('  build: { runner: container, image: busybox, cmd: "true", timeout: 1m }') });
    expect((await result(h)).event).toEqual({ type: 'test_passed', stage_id: 's1' });
    expect(h.pushes).toHaveLength(1);
    expect(h.requests).toEqual([]);
  });

  it('a non-zero exit or a timeout is test_failed with the log tail stored', async () => {
    const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    const failing = harness({ run: async () => ({ ok: true, step_run_id: 'r2', outcome: 'exited', exit_code: 2, log: logFile(`${lines}\n`), out: '' }) });
    const failed = await result(failing);
    expect(failed.event).toEqual({ type: 'test_failed', stage_id: 's1' });
    failed.rows!(failing.task);
    const output = failing.store.getStage('s1')?.output as { exit_code: number; log_tail: string };
    expect(output.exit_code).toBe(2);
    expect(output.log_tail.split('\n')).toHaveLength(LOG_TAIL_LINES);
    expect(output.log_tail.endsWith(`line ${LOG_TAIL_LINES + 4}`)).toBe(true);

    const slow = harness({ run: async () => ({ ok: true, step_run_id: 'r3', outcome: 'timeout', exit_code: null, log: logFile('hung\n'), out: '' }) });
    expect((await result(slow)).event).toEqual({ type: 'test_failed', stage_id: 's1' });
  });

  it('a failed push, a refused step and capability_busy are stage_failed, never a budget unit', async () => {
    const push = harness({ push: async () => Promise.reject(new Error('git push origin failed: remote rejected')) });
    expect((await result(push)).event).toEqual({ type: 'stage_failed', stage_id: 's1', reason: 'push: git push origin failed: remote rejected' });
    expect(push.requests).toEqual([]);
    const refused = harness({ run: async () => ({ ok: false, refused: 'secret X is not set' }) });
    expect((await result(refused)).event).toEqual({ type: 'stage_failed', stage_id: 's1', reason: 'test step refused: secret X is not set' });
    const busy = harness({ run: async () => ({ ok: true, step_run_id: 'r4', outcome: 'capability_busy', exit_code: null, log: '', out: '' }) });
    expect((await result(busy)).event).toEqual({ type: 'stage_failed', stage_id: 's1', reason: 'capability_busy' });
  });

  it('a step that throws fails the Stage with the error instead of leaving it running', async () => {
    const h = harness({ run: async () => Promise.reject(new Error('EACCES: mkdir data/steps')) });
    expect((await result(h)).event).toEqual({ type: 'stage_failed', stage_id: 's1', reason: 'EACCES: mkdir data/steps' });
  });

  it('a stop while stage_started is applied pushes and runs nothing', async () => {
    let stopped: Promise<void> | undefined;
    const h: Harness = harness({ onStarted: () => (stopped = h.testStep.stop()) });
    await h.testStep.run({ kind: 'run_test_step', stage_id: 's1', task_id: 't1', attempt: 1 });
    await stopped;
    expect(h.applied.map((call) => call.event.type)).toEqual(['stage_started']);
    expect(h.pushes).toEqual([]);
    expect(h.testStep.running()).toEqual([]);
  });

  it('a Stage no longer starting runs nothing; a cancelled one applies nothing', async () => {
    const ended = harness();
    ended.store.updateStage('s1', { status: 'cancelled', reason: 'pause' });
    await ended.testStep.run({ kind: 'run_test_step', stage_id: 's1', task_id: 't1', attempt: 1 });
    expect(ended.applied).toEqual([]);
    expect(ended.pushes).toEqual([]);

    let release!: () => void;
    const h = harness({ run: (request) => new Promise((resolve) => { release = () => resolve({ ok: false, refused: 'stopped' }); request.signal?.addEventListener('abort', () => release()); }) });
    await h.testStep.run({ kind: 'run_test_step', stage_id: 's1', task_id: 't1', attempt: 1 });
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.testStep.running()).toEqual(['s1']);
    h.testStep.cancel({ kind: 'cancel_stage', stage_id: 's1', task_id: 't1', reason: 'pause' });
    await vi.waitFor(() => expect(h.testStep.running()).toEqual([]));
    expect(h.applied.map((call) => call.event.type)).toEqual(['stage_started']);
  });

  it('logTail keeps the last lines, drops a partial first line of a large file, and reads nothing from a missing file', async () => {
    expect(await logTail(logFile('a\nb\nc\n'), 2)).toBe('b\nc');
    const big = `${'é'.repeat(20_000)}\nlast\n`;
    expect(await logTail(logFile(big), 5)).toBe('last');
    expect(await logTail('/nonexistent/log')).toBe('');
  });
});
