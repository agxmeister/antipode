import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RoleConfigResolver, RoleVars } from '../adapters/claude-cli/role-config.ts';
import type { Coordinator } from '../core/coordinator/coordinator.ts';
import type { EffectOf } from '../core/domain/effects.ts';
import type { Event } from '../core/domain/events.ts';
import { roleLimits, type RoleLimits } from '../core/domain/role.ts';
import type { Stage, StageUsage } from '../core/domain/stage.ts';
import { OUTPUT_SCHEMAS, type OutputSchemaName, type TriageOutput, type ValidatorOutput, type ImplementerOutput } from '../core/domain/stage-output/index.ts';
import type { Project, Task, TaskState } from '../core/domain/task.ts';
import type { AgentAuth, AgentRunner, AgentRunSpec } from '../core/ports/agent-runner.ts';
import { silentLog, type Log } from '../core/ports/log.ts';
import type { Repo } from '../core/ports/repo.ts';
import type { Store } from '../core/ports/store.ts';
import { readInstanceSecrets } from './secrets.ts';

/** `stage_failed` reason of an attempt that could not be launched (AD-4; deferred 1-2 item). */
export const LAUNCH = 'launch';
/** `stage_failed` reason of valid output no event and no output hook maps (Owner decision 2026-11-15). */
export const UNHANDLED_OUTPUT = 'unhandled_output';
/** The Role whose Stages run in the Project's read-only `_main` checkout (AD-4). */
export const INTAKE_ROLE = 'intake';
/** The daemon variables a Stage inherits; nothing else of the daemon's env reaches it. */
export const STAGE_ENV_PASSTHROUGH = ['HOME', 'LANG', 'TMPDIR'] as const;

/** What an output hook gets: the valid output of a finished Stage attempt. */
export interface StageOutputInput {
  task: Task;
  stage: Stage;
  output: unknown;
  usage: StageUsage | null;
}

/**
 * Maps a Role's valid output that has no fixed event to one (filled by 1-8, 1-9, 1-10). Returning
 * undefined fails the Stage `unhandled_output`.
 */
export type OutputHook = (input: StageOutputInput) => Event | undefined | Promise<Event | undefined>;

export interface StagesOptions {
  store: Store;
  coordinator: Pick<Coordinator, 'applyEvent' | 'setStageRetries'>;
  runner: AgentRunner;
  resolver: Pick<RoleConfigResolver, 'resolve' | 'materialize'>;
  /** Reads the repo layer at `tasks.config_sha` from the bare clone (AD-22). */
  repo: Pick<Repo, 'readFile'>;
  /** `$ANTIPOD_HOME`. */
  home: string;
  /** `$ANTIPOD_HOME/data`. */
  dataDir: string;
  /** `$ANTIPOD_HOME/secrets`. */
  secretsDir: string;
  /** `run/bin/`, first on every Stage's `PATH`. */
  runBin: string;
  /** Read at every launch so SIGHUP applies. */
  config: () => { roles: Readonly<Record<string, Partial<RoleLimits>>>; agent: { auth: AgentAuth } };
  /** Where `PATH`, `HOME`, `LANG` and `TMPDIR` come from; `process.env` by default. */
  baseEnv?: NodeJS.ProcessEnv;
  log?: Log;
}

interface Launch {
  spec: AgentRunSpec;
  schema: OutputSchemaName;
}

interface Live {
  controller: AbortController;
  done: Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The fixed discriminator → event map (AD-4, Owner decision 2026-11-15). Undefined for output that
 * goes through an output hook: Implementer `blocked`, `EvidenceOutput`, `OwnerInstruction`.
 */
export function eventForOutput(schema: OutputSchemaName, state: TaskState, output: unknown, stageId: string, usage: StageUsage | null): Event | undefined {
  switch (schema) {
    case 'implementer':
      return (output as ImplementerOutput).status === 'done' ? { type: 'implementer_done', stage_id: stageId, usage } : undefined;
    case 'validator': {
      const value = output as ValidatorOutput;
      if (state === 'verifying') {
        // Evidence mode: verified only when the verdict passes and at least one verdict was given and every artifact shows its criterion.
        const verdicts = value.evidence_verdicts ?? [];
        const shown = value.verdict === 'pass' && verdicts.length > 0 && verdicts.every((verdict) => verdict.shows_criterion);
        return { type: shown ? 'evidence_verified' : 'evidence_rejected', stage_id: stageId, usage };
      }
      const type = value.verdict === 'pass' ? 'pass' : value.verdict === 'blocking' ? 'blocking_findings' : 'nonblocking_findings';
      return { type, stage_id: stageId, usage };
    }
    case 'triage': {
      const value = output as TriageOutput;
      if (value.decision === 'rerun') return { type: 'rerun', stage_id: stageId, usage };
      if (value.decision === 'park') return { type: 'parked', stage_id: stageId, usage };
      return { type: 'reason_written', stage_id: stageId, reason: value.reason, usage };
    }
    default:
      return undefined;
  }
}

/**
 * The `start_stage` and `cancel_stage` handlers (AD-3, AD-4, AD-6): resolve the Role Config, render
 * the brief, launch one `claude -p` through the `AgentRunner`, report `stage_started`, and map the
 * typed output to exactly one event. A launch that fails applies `stage_failed(launch)` itself.
 * Changes Task state only through the Coordinator.
 */
export class Stages {
  readonly #options: StagesOptions;
  readonly #log: Log;
  readonly #live = new Map<string, Live>();
  readonly #hooks = new Map<string, OutputHook>();
  #stopped = false;

  constructor(options: StagesOptions) {
    this.#options = options;
    this.#log = options.log ?? silentLog;
  }

  /** Registers the output hook of `role`, replacing an earlier one. */
  setOutputHook(role: string, hook: OutputHook): void {
    this.#hooks.set(role, hook);
  }

  /** Ids of the Stages running in this process. */
  running(): string[] {
    return [...this.#live.keys()];
  }

  /** `data/stages/<stage_id>.jsonl`. */
  transcriptPath(stageId: string): string {
    return join(this.#options.dataDir, 'stages', `${stageId}.jsonl`);
  }

  /** The `start_stage` handler: resolves once the attempt is running (or has failed to launch). */
  async startStage(effect: EffectOf<'start_stage'>): Promise<void> {
    const { store } = this.#options;
    const stage = store.getStage(effect.stage_id);
    const fields = { task_id: effect.task_id, stage_id: effect.stage_id, role: effect.role, attempt: effect.attempt };
    if (this.#stopped) {
      // Shutting down: the row stays `starting` and boot recovery relaunches it (AD-18).
      this.#log.info({ event: 'stage_launch_skipped', ...fields, status: 'shutdown' }, 'stage_launch_skipped');
      return;
    }
    if (stage?.status !== 'starting') {
      this.#log.info({ event: 'stage_launch_skipped', ...fields, status: stage?.status ?? null }, 'stage_launch_skipped');
      return;
    }
    const task = store.getTask(effect.task_id);
    if (task === undefined) {
      throw new Error(`task ${effect.task_id} does not exist`);
    }
    let launch: Launch;
    try {
      launch = await this.#prepare(task, stage);
    } catch (error) {
      await this.#fail(task.id, stage.id, LAUNCH, error);
      return;
    }
    // The Coordinator may have ended the Stage while the launch was prepared (pause, cancel).
    if (this.#stopped || store.getStage(stage.id)?.status !== 'starting') {
      const status = this.#stopped ? 'shutdown' : (store.getStage(stage.id)?.status ?? null);
      this.#log.info({ event: 'stage_launch_skipped', ...fields, status }, 'stage_launch_skipped');
      return;
    }

    const controller = new AbortController();
    let markLaunched!: () => void;
    const launched = new Promise<void>((resolveLaunched) => {
      markLaunched = resolveLaunched;
    });
    let started: Promise<unknown> = Promise.resolve();
    const run = this.#options.runner.run(
      {
        ...launch.spec,
        onStarted: () => {
          // Enqueued synchronously, so it is applied before any result of this attempt.
          started = this.#options.coordinator.applyEvent(task.id, { type: 'stage_started', stage_id: stage.id }).catch((error: unknown) => {
            this.#log.error({ event: 'stage_started_failed', ...fields, error: errorText(error) }, 'stage_started_failed');
          });
          markLaunched();
        },
      },
      controller.signal,
    );
    const done = run
      .then(
        async (result) => {
          await started;
          if (controller.signal.aborted) {
            this.#log.info({ event: 'stage_stopped', ...fields, outcome: result.outcome }, 'stage_stopped');
            return;
          }
          if (result.outcome === 'failed') {
            this.#log.warn({ event: 'stage_attempt_failed', ...fields, reason: result.reason, detail: result.detail }, 'stage_attempt_failed');
            await this.#options.coordinator.applyEvent(task.id, { type: 'stage_failed', stage_id: stage.id, reason: result.reason, usage: result.usage });
            return;
          }
          await this.#deliver(stage, launch.schema, result.output, result.usage, fields);
        },
        (error: unknown) => this.#fail(task.id, stage.id, LAUNCH, error),
      )
      .catch((error: unknown) => {
        this.#log.error({ event: 'stage_result_failed', ...fields, error: errorText(error) }, 'stage_result_failed');
      })
      .finally(() => {
        this.#live.delete(stage.id);
        markLaunched();
      });
    this.#live.set(stage.id, { controller, done });
    await launched;
    await started;
  }

  /** The `cancel_stage` handler: the row is already `cancelled`; signal the process, apply nothing. */
  cancelStage(effect: EffectOf<'cancel_stage'>): void {
    const live = this.#live.get(effect.stage_id);
    this.#log.info({ event: 'stage_cancel', task_id: effect.task_id, stage_id: effect.stage_id, reason: effect.reason, running: live !== undefined }, 'stage_cancel');
    live?.controller.abort(effect.reason);
  }

  /** Stops every running Stage without applying any event; boot recovery fails them `restart` (AD-18). */
  async stop(): Promise<void> {
    this.#stopped = true;
    const live = [...this.#live.values()];
    for (const entry of live) entry.controller.abort('shutdown');
    await Promise.allSettled(live.map((entry) => entry.done));
  }

  async #deliver(stage: Stage, schema: OutputSchemaName, output: unknown, usage: StageUsage | null, fields: Record<string, unknown>): Promise<void> {
    const task = this.#options.store.getTask(stage.task_id);
    if (task === undefined) return;
    let event = eventForOutput(schema, task.state, output, stage.id, usage);
    if (event === undefined) {
      const hook = this.#hooks.get(stage.role);
      try {
        event = hook === undefined ? undefined : await hook({ task, stage, output, usage });
      } catch (error) {
        this.#log.error({ event: 'stage_output_hook_failed', ...fields, error: errorText(error) }, 'stage_output_hook_failed');
        event = undefined;
      }
    }
    if (event === undefined) {
      this.#log.warn({ event: 'stage_output_unhandled', ...fields, output_schema: schema }, 'stage_output_unhandled');
      event = { type: 'stage_failed', stage_id: stage.id, reason: UNHANDLED_OUTPUT, usage };
    }
    await this.#options.coordinator.applyEvent(task.id, event);
  }

  async #fail(taskId: string, stageId: string, reason: string, error: unknown): Promise<void> {
    this.#log.error({ event: 'stage_launch_failed', task_id: taskId, stage_id: stageId, reason, error: errorText(error) }, 'stage_launch_failed');
    await this.#options.coordinator.applyEvent(taskId, { type: 'stage_failed', stage_id: stageId, reason });
  }

  /** Resolves the Role Config, stores its `retries`, materializes its files and builds the launch. */
  async #prepare(task: Task, stage: Stage): Promise<Launch> {
    const options = this.#options;
    const project = options.store.getProject(task.project_id);
    if (project === undefined) {
      throw new Error(`project ${task.project_id} does not exist`);
    }
    const configSha = task.config_sha;
    const resolved = await options.resolver.resolve(
      stage.role,
      configSha === null ? undefined : (path) => options.repo.readFile(project.name, configSha, path),
    );
    const config = options.config();
    const limits = roleLimits(stage.role, resolved.config, Object.hasOwn(config.roles, stage.role) ? config.roles[stage.role] : undefined);
    await options.coordinator.setStageRetries(stage.id, limits.retries);

    const cwd = this.#cwd(project, task, stage.role);
    if (!existsSync(cwd)) {
      throw new Error(`the working directory ${cwd} does not exist`);
    }
    const prior = join(options.dataDir, 'prior', project.name, String(task.task_no ?? '_draft'));
    // Real paths, as claude sees them: rules on a symlinked home (macOS /var → /private/var) would never match.
    const realCwd = realPath(cwd);
    const vars: RoleVars = {
      ANTIPOD_HOME: realPath(options.home),
      WORKTREE: realCwd,
      ANTIPOD_PRIOR: realPath(prior),
      OTHER_WORKTREES: this.#otherWorktrees(realCwd),
    };
    const files = await options.resolver.materialize(resolved, join(options.dataDir, 'stages', stage.id, 'role'), vars);
    const schema = resolved.config.output_schema;
    return {
      schema,
      spec: {
        stageId: stage.id,
        cwd,
        prompt: renderBrief(task, stage, limits),
        transcriptPath: this.transcriptPath(stage.id),
        outputSchema: OUTPUT_SCHEMAS[schema],
        settingsPath: files.settingsPath,
        mcpConfigPath: files.mcpConfigPath,
        systemPromptPath: files.systemPromptPath,
        permissionMode: resolved.config.permission_mode,
        maxTurns: limits.max_turns,
        timeoutMs: limits.timeout_ms,
        auth: config.agent.auth,
        env: this.#env(stage, task, prior, config.agent.auth),
      },
    };
  }

  /** The Task worktree, or the Project's `_main` checkout for Intake (AD-4, AD-5). */
  #cwd(project: Project, task: Task, role: string): string {
    const base = join(this.#options.dataDir, 'worktrees', project.name);
    if (role === INTAKE_ROLE) return join(base, '_main');
    if (task.task_no === null) {
      throw new Error(`a ${role} Stage needs a Task number and a worktree`);
    }
    return join(base, String(task.task_no));
  }

  /** Every worktree directory of every Project but `own`. */
  #otherWorktrees(own: string): string[] {
    const root = join(this.#options.dataDir, 'worktrees');
    const dirs: string[] = [];
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    };
    for (const project of list(root)) {
      for (const tree of list(join(root, project))) {
        const dir = realPath(join(root, project, tree));
        if (dir !== own) dirs.push(dir);
      }
    }
    return dirs;
  }

  /**
   * The whole Stage env (AD-6, AD-14): `PATH` with `run/bin` first, `HOME`, `LANG`, `TMPDIR`,
   * `ANTIPOD_HOME`, `ANTIPOD_STAGE_ID`, the step contract's `ANTIPOD_TASK` and `ANTIPOD_PRIOR` (AD-7),
   * and in api-key mode `ANTHROPIC_API_KEY`. No other daemon variable and no secret.
   */
  #env(stage: Stage, task: Task, prior: string, auth: AgentAuth): Record<string, string> {
    const base = this.#options.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    const path = base['PATH'];
    env['PATH'] = path === undefined || path === '' ? this.#options.runBin : `${this.#options.runBin}:${path}`;
    for (const key of STAGE_ENV_PASSTHROUGH) {
      const value = base[key];
      if (value !== undefined) env[key] = value;
    }
    env['ANTIPOD_HOME'] = this.#options.home;
    env['ANTIPOD_STAGE_ID'] = stage.id;
    if (task.task_no !== null) {
      env['ANTIPOD_TASK'] = String(task.task_no);
      env['ANTIPOD_PRIOR'] = prior;
    }
    if (auth === 'api-key') {
      const key = readInstanceSecrets(this.#options.secretsDir)['ANTHROPIC_API_KEY'];
      if (key === undefined || key === '') {
        throw new Error('agent.auth is api-key but ANTHROPIC_API_KEY is not set in secrets/antipod.env');
      }
      env['ANTHROPIC_API_KEY'] = key;
    }
    return env;
  }
}

/** `path` with symlinks resolved; a path that does not exist yet keeps its missing tail on its real parent. */
export function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

/**
 * The Stage brief, rendered from the Task row only (AD-21): number, Role, attempt and how to run
 * Recipe steps. Contract, criteria, Correction note and Parking Lot join it in 1-8, 1-9 and 1-10.
 */
export function renderBrief(task: Task, stage: Stage, limits: RoleLimits): string {
  const name = task.task_no === null ? 'a draft Task (no number yet)' : `Task #${task.task_no}`;
  return [
    `# Antipode Stage brief`,
    '',
    `You are running the ${stage.role} Role for ${name}, attempt ${stage.attempt} of ${limits.retries + 1}.`,
    '',
    'Run Recipe steps only with `antipod step <name>`, for example `antipod step build`. It blocks until the step ends,',
    'exits with the step\'s exit code and prints the path of its log and of its output directory (`ANTIPOD_OUT`).',
    '',
    'Your final answer is the structured output the schema asks for.',
    '',
  ].join('\n');
}
