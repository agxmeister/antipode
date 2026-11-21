import { open } from 'node:fs/promises';
import type { Coordinator } from '../core/coordinator/coordinator.ts';
import { branchName, slugOf } from '../core/domain/contract.ts';
import type { EffectOf } from '../core/domain/effects.ts';
import type { Event } from '../core/domain/events.ts';
import type { TestOutput } from '../core/domain/loop.ts';
import { RECIPE_FILE } from '../core/domain/recipe.ts';
import { silentLog, type Log } from '../core/ports/log.ts';
import type { Repo } from '../core/ports/repo.ts';
import type { Store } from '../core/ports/store.ts';
import { validateRecipeText } from './recipe-file.ts';
import type { StepRequest, StepRunResult } from './steps.ts';

/** The reserved Recipe step the `testing` Stage runs (AD-7, AD-13). */
export const TEST_STEP = 'test';
/** Lines of the test log kept for the next Implementer brief, at most. */
export const LOG_TAIL_LINES = 40;
/** Bytes read from the end of the test log, at most. */
const LOG_TAIL_BYTES = 16 * 1024;

export interface TestStepOptions {
  store: Store;
  coordinator: Pick<Coordinator, 'applyEvent'>;
  repo: Pick<Repo, 'pushBranch' | 'readFile'>;
  steps: { run(request: StepRequest): Promise<StepRunResult> };
  log?: Log;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last `LOG_TAIL_LINES` lines of the file at `path`; empty when it cannot be read. */
export async function logTail(path: string, lines = LOG_TAIL_LINES): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const all = buffer.toString('utf8').replace(/\s+$/, '').split('\n');
    // A read that starts inside the file may start mid-line or mid-character: that first line goes.
    if (size > LOG_TAIL_BYTES) all.shift();
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

/**
 * The `run_test_step` handler: the `testing` Stage the Coordinator runs itself (AD-3, AD-5, AD-13).
 * It reports `stage_started`, pushes the Branch to `origin`, then runs the Recipe `test` step. Exit 0
 * (or a Recipe with no `test` step) is `test_passed`; a non-zero exit or a timeout is `test_failed`
 * with the log tail stored on the Stage row for the next brief; a failed push, a refused step or
 * `capability_busy` is `stage_failed`, retried without budget. The handler resolves once the Stage
 * runs; the push and the step go on in the background, like an agent Stage. Changes Task state only
 * through the Coordinator.
 */
export class TestStep {
  readonly #options: TestStepOptions;
  readonly #log: Log;
  readonly #live = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #stopped = false;

  constructor(options: TestStepOptions) {
    this.#options = options;
    this.#log = options.log ?? silentLog;
  }

  /** Ids of the `testing` Stages running in this process. */
  running(): string[] {
    return [...this.#live.keys()];
  }

  async run(effect: EffectOf<'run_test_step'>): Promise<void> {
    const { store, coordinator } = this.#options;
    const fields = { task_id: effect.task_id, stage_id: effect.stage_id, attempt: effect.attempt };
    const stage = store.getStage(effect.stage_id);
    if (this.#stopped || stage?.status !== 'starting') {
      // Shutting down leaves the row `starting` for boot recovery (AD-18); an ended Stage runs nothing.
      this.#log.info({ event: 'test_step_skipped', ...fields, status: this.#stopped ? 'shutdown' : (stage?.status ?? null) }, 'test_step_skipped');
      return;
    }
    const started = await coordinator.applyEvent(effect.task_id, { type: 'stage_started', stage_id: effect.stage_id });
    // Shutdown may have begun while `stage_started` was applied: boot recovery fails the row `restart` (AD-18).
    if (!started.applied || this.#stopped) return;
    const controller = new AbortController();
    const done = this.#test(effect, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) {
          this.#log.info({ event: 'test_step_stopped', ...fields }, 'test_step_stopped');
          return;
        }
        await coordinator.applyEvent(effect.task_id, result.event, result.output === undefined ? undefined : () => store.setStageOutput(effect.stage_id, result.output));
      })
      .catch(async (error: unknown) => {
        this.#log.error({ event: 'test_step_result_failed', ...fields, error: errorText(error) }, 'test_step_result_failed');
        if (controller.signal.aborted) return;
        // Never leave the Stage running: the failure is retried, then ends at the Stuck card (AD-4).
        await coordinator.applyEvent(effect.task_id, { type: 'stage_failed', stage_id: effect.stage_id, reason: errorText(error) }).catch((inner: unknown) => {
          this.#log.error({ event: 'test_step_fail_failed', ...fields, error: errorText(inner) }, 'test_step_fail_failed');
        });
      })
      .finally(() => this.#live.delete(effect.stage_id));
    this.#live.set(effect.stage_id, { controller, done });
  }

  /** The `cancel_stage` handler's part for a `testing` Stage: the row is already `cancelled`; stop the step. */
  cancel(effect: EffectOf<'cancel_stage'>): void {
    this.#live.get(effect.stage_id)?.controller.abort(effect.reason);
  }

  /** Stops every running test step without applying any event; boot recovery fails them `restart` (AD-18). */
  async stop(): Promise<void> {
    this.#stopped = true;
    const live = [...this.#live.values()];
    for (const entry of live) entry.controller.abort('shutdown');
    await Promise.allSettled(live.map((entry) => entry.done));
  }

  async #test(effect: EffectOf<'run_test_step'>, signal: AbortSignal): Promise<{ event: Event; output?: TestOutput }> {
    const { store, repo, steps } = this.#options;
    const stageId = effect.stage_id;
    const failed = (reason: string): { event: Event } => {
      this.#log.warn({ event: 'test_stage_failed', task_id: effect.task_id, stage_id: stageId, reason }, 'test_stage_failed');
      return { event: { type: 'stage_failed', stage_id: stageId, reason } };
    };
    const task = store.getTask(effect.task_id);
    const project = task === undefined ? undefined : store.getProject(task.project_id);
    if (task === undefined || project === undefined || task.task_no === null) return failed('the Task has no number or Project');

    // The Branch goes to `origin` after every Implementer Stage that reports `done` (AD-5, AD-13).
    const branch = branchName(task.task_no, task.slug ?? slugOf(task.title ?? 'task'));
    try {
      await repo.pushBranch(project.name, branch);
    } catch (error) {
      return failed(`push: ${errorText(error)}`);
    }
    this.#log.info({ event: 'branch_pushed', task_id: task.id, stage_id: stageId, branch }, 'branch_pushed');

    if (task.config_sha !== null) {
      const text = await repo.readFile(project.name, task.config_sha, RECIPE_FILE).catch(() => undefined);
      const recipe = text === undefined ? undefined : validateRecipeText(text);
      // A Recipe without a `test` step passes it at once (AD-3).
      if (recipe?.ok === true && !Object.hasOwn(recipe.recipe.steps, TEST_STEP)) {
        return { event: { type: 'test_passed', stage_id: stageId }, output: { step_run_id: null, outcome: null, exit_code: null, log_tail: null } };
      }
    }

    const result = await steps.run({ taskId: task.id, step: TEST_STEP, signal });
    if (!result.ok) return failed(`test step refused: ${result.refused}`);
    if (result.outcome === 'capability_busy') return failed('capability_busy');
    const output: TestOutput = { step_run_id: result.step_run_id, outcome: result.outcome, exit_code: result.exit_code, log_tail: null };
    if (result.outcome === 'exited' && result.exit_code === 0) {
      return { event: { type: 'test_passed', stage_id: stageId }, output };
    }
    output.log_tail = await logTail(result.log);
    return { event: { type: 'test_failed', stage_id: stageId }, output };
  }
}
