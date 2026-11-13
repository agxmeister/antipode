import { existsSync } from 'node:fs';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '../core/domain/ids.ts';
import { parseDuration, RECIPE_FILE } from '../core/domain/recipe.ts';
import { isLiveStage } from '../core/domain/stage.ts';
import type { StepOutcome, StepRunEnd } from '../core/domain/step.ts';
import type { Clock } from '../core/ports/clock.ts';
import { silentLog, type Log } from '../core/ports/log.ts';
import type { Repo } from '../core/ports/repo.ts';
import type { StepRunner, StepSpec } from '../core/ports/step-runner.ts';
import type { Store } from '../core/ports/store.ts';
import { validateRecipeText } from './recipe-file.ts';
import { readProjectSecrets } from './secrets.ts';

/** `ANTIPOD_DATA`, inside the worktree, so it goes with it (AD-7). */
export const PREVIEW_DATA_DIR = '.antipod-data';
export const STAGE_NOT_RUNNING = 'stage is not running';
/** `step_runs.reason` of a run stopped because its caller went away or the daemon stopped. */
export const ABORTED = 'aborted';
export const RESTART = 'restart';

export interface StepsOptions {
  store: Store;
  /** Reads the Recipe at `tasks.config_sha` from the bare clone (AD-22). */
  repo: Pick<Repo, 'readFile'>;
  /** `$ANTIPOD_HOME/data`. */
  dataDir: string;
  /** `$ANTIPOD_HOME/secrets`. */
  secretsDir: string;
  runners: { container: StepRunner; host: StepRunner };
  clock: Clock;
  log?: Log;
  newId?: () => string;
}

/** A step asked for by a live Stage (`stageId`) or by the Coordinator for a Task (`taskId`). */
export interface StepRequest {
  stageId?: string;
  taskId?: string;
  step: string;
  /** Aborting stops the step (a dropped `antipod step` connection, daemon stop). */
  signal?: AbortSignal;
}

export type StepRunResult =
  | { ok: true; step_run_id: string; outcome: StepOutcome; exit_code: number | null; log: string; out: string }
  | { ok: false; refused: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs Recipe steps for Tasks (AD-6, AD-7, CAP-2, CAP-5): resolves the step from the Recipe pinned at
 * `tasks.config_sha`, refuses what cannot run (unknown step, missing secret, unmapped capability,
 * stale Stage) before anything is spawned, prepares `data/steps/<id>/` and Preview Data, records the
 * `step_runs` row, and hands the Runner exactly the contract env. Changes no Task state.
 */
export class Steps {
  readonly #store: Store;
  readonly #repo: Pick<Repo, 'readFile'>;
  readonly #dataDir: string;
  readonly #secretsDir: string;
  readonly #runners: StepsOptions['runners'];
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #newId: () => string;
  /** Preview Data seeding in flight per worktree, so two first steps of a Task seed once. */
  readonly #seeding = new Map<string, Promise<void>>();

  constructor(options: StepsOptions) {
    this.#store = options.store;
    this.#repo = options.repo;
    this.#dataDir = options.dataDir;
    this.#secretsDir = options.secretsDir;
    this.#runners = options.runners;
    this.#clock = options.clock;
    this.#log = options.log ?? silentLog;
    this.#newId = options.newId ?? ulid;
  }

  /** `data/steps/`. */
  get stepsDir(): string {
    return join(this.#dataDir, 'steps');
  }

  /** `data/worktrees/<project>/<task_no>/` (AD-5). */
  worktree(project: string, taskNo: number): string {
    return join(this.#dataDir, 'worktrees', project, String(taskNo));
  }

  async run(request: StepRequest): Promise<StepRunResult> {
    let taskId = request.taskId;
    if (request.stageId !== undefined) {
      const stage = this.#store.getStage(request.stageId);
      const task = stage === undefined ? undefined : this.#store.getTask(stage.task_id);
      if (!isLiveStage(stage) || task === undefined || task.current_stage_id !== stage.id) {
        return { ok: false, refused: STAGE_NOT_RUNNING };
      }
      taskId = task.id;
    }
    const task = taskId === undefined ? undefined : this.#store.getTask(taskId);
    if (task === undefined) {
      return { ok: false, refused: 'no such Task' };
    }
    const project = this.#store.getProject(task.project_id);
    if (project === undefined || task.task_no === null || task.config_sha === null) {
      return { ok: false, refused: 'the Task has no pinned Recipe' };
    }
    const text = await this.#repo.readFile(project.name, task.config_sha, RECIPE_FILE);
    if (text === undefined) {
      return { ok: false, refused: 'no Recipe at the pinned commit' };
    }
    const validation = validateRecipeText(text);
    if (!validation.ok) {
      return { ok: false, refused: validation.reason };
    }
    const recipe = validation.recipe;
    const definition = Object.hasOwn(recipe.steps, request.step) ? recipe.steps[request.step] : undefined;
    if (definition === undefined) {
      return { ok: false, refused: `no step ${request.step} in the Recipe` };
    }
    const values = readProjectSecrets(this.#secretsDir, project.name);
    const secrets: Record<string, string> = {};
    for (const name of definition.secrets) {
      if (!Object.hasOwn(values, name)) {
        return { ok: false, refused: `secret ${name} is not set` };
      }
      secrets[name] = values[name]!;
    }
    const runner = this.#runners[definition.runner];
    const refusal = runner.refusal({ capability: definition.capability });
    if (refusal !== undefined) {
      return { ok: false, refused: refusal };
    }
    const worktree = this.worktree(project.name, task.task_no);
    if (!existsSync(worktree)) {
      return { ok: false, refused: `the worktree of #${task.task_no} does not exist` };
    }

    const dataDir = join(worktree, PREVIEW_DATA_DIR);
    await this.#ensurePreviewData(worktree, dataDir, recipe.fixtures);
    const id = this.#newId();
    const stepDir = join(this.stepsDir, id);
    const out = join(stepDir, 'out');
    const log = join(stepDir, 'log');
    // Populated with the previous round's Evidence by story 1-10; an empty directory until then.
    const prior = join(this.#dataDir, 'prior', project.name, String(task.task_no));
    await mkdir(out, { recursive: true, mode: 0o700 });
    await mkdir(prior, { recursive: true, mode: 0o700 });

    const spec: StepSpec = {
      stepRunId: id,
      taskId: task.id,
      cmd: definition.cmd,
      ...(definition.image === undefined ? {} : { image: definition.image }),
      ...(definition.capability === undefined ? {} : { capability: definition.capability }),
      exclusive: definition.exclusive,
      cwd: worktree,
      env: { ...secrets, ANTIPOD_OUT: out, ANTIPOD_DATA: dataDir, ANTIPOD_PRIOR: prior, ANTIPOD_TASK: String(task.task_no) },
      mounts: [
        { path: worktree, readOnly: false },
        { path: out, readOnly: false },
        { path: dataDir, readOnly: false },
        { path: prior, readOnly: true },
      ],
      logPath: log,
      timeoutMs: parseDuration(definition.timeout),
    };
    this.#store.insertStepRun({
      id,
      task_id: task.id,
      stage_id: request.stageId ?? null,
      step: request.step,
      runner: definition.runner,
      status: 'running',
      outcome: null,
      exit_code: null,
      reason: null,
      started_at: this.#now(),
      ended_at: null,
    });
    const fields = { task_id: task.id, stage_id: request.stageId ?? null, step_run_id: id, step: request.step, runner: definition.runner };
    this.#log.info({ event: 'step_started', ...fields }, 'step_started');

    let result;
    try {
      result = await runner.run(spec, request.signal);
    } catch (error) {
      this.#finish(id, { status: 'failed', outcome: null, exit_code: null, reason: errorText(error) });
      this.#log.error({ event: 'step_failed', ...fields, error: errorText(error) }, 'step_failed');
      return { ok: false, refused: `step ${request.step} could not start: ${errorText(error)}` };
    }
    // Stopped by the abort only when it did not exit on its own (a stopped run has no exit code).
    if (request.signal?.aborted === true && result.exit_code === null) {
      this.#finish(id, { status: 'failed', outcome: result.outcome, exit_code: result.exit_code, reason: ABORTED });
      this.#log.info({ event: 'step_aborted', ...fields }, 'step_aborted');
      return { ok: false, refused: `step ${request.step} was stopped` };
    }
    if (result.outcome === 'exited' && result.exit_code === 0 && definition.outputs !== undefined) {
      try {
        await this.#copyOutputs(worktree, definition.outputs, out, fields);
      } catch (error) {
        this.#finish(id, { status: 'failed', outcome: result.outcome, exit_code: result.exit_code, reason: errorText(error) });
        this.#log.error({ event: 'step_failed', ...fields, error: errorText(error) }, 'step_failed');
        return { ok: false, refused: `step ${request.step} outputs could not be copied: ${errorText(error)}` };
      }
    }
    this.#finish(id, { status: 'finished', outcome: result.outcome, exit_code: result.exit_code, reason: null });
    this.#log.info({ event: 'step_finished', ...fields, outcome: result.outcome, exit_code: result.exit_code }, 'step_finished');
    return { ok: true, step_run_id: id, ...result, log, out };
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #finish(id: string, end: Omit<StepRunEnd, 'ended_at'>): void {
    this.#store.finishStepRun(id, { ...end, ended_at: this.#now() });
  }

  /**
   * Preview Data (AD-7): before the first step of a Task, `ANTIPOD_DATA` is created and seeded once
   * from the Recipe's `fixtures` directory of the worktree. Seeded in a sibling directory and renamed,
   * so a crash never leaves a half-seeded one that later steps would take as done.
   */
  #ensurePreviewData(worktree: string, dataDir: string, fixtures: string | null): Promise<void> {
    const inFlight = this.#seeding.get(dataDir);
    if (inFlight !== undefined) return inFlight;
    if (existsSync(dataDir)) return Promise.resolve();
    const seeding = (async () => {
      const staging = `${dataDir}.seeding-${this.#newId()}`;
      try {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const source = fixtures === null ? undefined : join(worktree, fixtures);
        if (source !== undefined && existsSync(source)) {
          await cp(source, staging, { recursive: true });
        }
        // Inside the worktree: never committed by a Stage's `git add -A`.
        await writeFile(join(staging, '.gitignore'), '*\n');
        await rename(staging, dataDir);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    })().finally(() => this.#seeding.delete(dataDir));
    this.#seeding.set(dataDir, seeding);
    return seeding;
  }

  /** `outputs` of an exit-0 step, copied from the worktree to `ANTIPOD_OUT/<outputs>`. */
  async #copyOutputs(worktree: string, outputs: string, out: string, fields: Record<string, unknown>): Promise<void> {
    const source = join(worktree, outputs);
    if (!existsSync(source)) {
      this.#log.warn({ event: 'step_outputs_missing', ...fields, outputs }, 'step_outputs_missing');
      return;
    }
    await cp(source, join(out, outputs), { recursive: true });
  }
}

/** What boot recovery needs of the two Runners (AD-18). */
export interface StepRecoveryDeps {
  store: Store;
  clock: Clock;
  /** Kills the process groups named by these step runs' pid files; the host adapter's `killSteps`. */
  killHostSteps: (stepRunIds: readonly string[]) => number;
  /** Removes this instance's step containers; the podman adapter's `removeOrphans`. */
  removeOrphans: () => Promise<number>;
  log?: Log;
}

export interface StepRecoveryReport {
  step_runs_failed: number;
  host_steps_killed: number;
  step_containers_removed: number;
  leases_cleared: number;
}

/**
 * Crash-only recovery of steps (AD-18), before the Coordinator's: every `running` step run is marked
 * `failed(restart)`, the process group of every leased or left-running host step is killed, the instance's step containers
 * are removed (only when a run was left `running`: a container exists only while its run does), and
 * then every lease is deleted.
 */
export async function recoverSteps(deps: StepRecoveryDeps): Promise<StepRecoveryReport> {
  const log = deps.log ?? silentLog;
  const now = deps.clock.now().toISOString();
  const running = deps.store.stepRunsInStatus(['running']);
  for (const run of running) {
    deps.store.finishStepRun(run.id, { status: 'failed', outcome: null, exit_code: null, reason: RESTART, ended_at: now });
  }
  const leases = deps.store.listLeases();
  // Every leased step and every host step left running, exclusive or not.
  const killed = deps.killHostSteps([...leases.map((lease) => lease.step_run_id), ...running.filter((run) => run.runner === 'host').map((run) => run.id)]);
  let removed = 0;
  if (running.length > 0) {
    try {
      removed = await deps.removeOrphans();
    } catch (error) {
      log.warn({ event: 'step_containers_remove_failed', error: errorText(error) }, 'step_containers_remove_failed');
    }
  }
  deps.store.clearLeases();
  return { step_runs_failed: running.length, host_steps_killed: killed, step_containers_removed: removed, leases_cleared: leases.length };
}
