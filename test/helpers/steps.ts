import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostRunner } from '../../src/adapters/host/runner.ts';
import { ensureHome, type HomePaths } from '../../src/app/home.ts';
import { Steps } from '../../src/app/steps.ts';
import { ulid } from '../../src/core/domain/ids.ts';
import type { Stage } from '../../src/core/domain/stage.ts';
import { taskSchema, type Project, type Task } from '../../src/core/domain/task.ts';
import type { StepResult, StepRunner, StepSpec } from '../../src/core/ports/step-runner.ts';
import { fakeClock } from './clock.ts';
import { createTempHome } from './home.ts';
import { openTestStore, type TestStore } from './store.ts';

const NOW = '2026-11-08T12:00:00.000Z';
export const CONFIG_SHA = 'c0ffee0000000000000000000000000000000000';

/** A container Runner that records specs and answers with `result` (Podman itself is tested in its adapter test). */
export function fakeContainerRunner(result: StepResult = { outcome: 'exited', exit_code: 0 }) {
  const specs: StepSpec[] = [];
  const runner: StepRunner = {
    refusal: () => undefined,
    run: async (spec) => {
      specs.push(spec);
      return result;
    },
  };
  return { runner, specs };
}

export interface StepsHarnessOptions {
  recipe: string;
  /** `secrets/<project>.env` text. */
  projectEnv?: string;
  capabilities?: Record<string, string>;
  container?: StepRunner;
}

export interface StepsHarness extends TestStore {
  paths: HomePaths;
  project: Project;
  task: Task;
  stage: Stage;
  worktree: string;
  steps: Steps;
  /** Reads of the Recipe: `[project, sha]`. */
  reads: Array<[string, string]>;
  /** Adds another Task of the Project, with a worktree and a live current Stage. */
  addTask(): { task: Task; stage: Stage; worktree: string };
}

/**
 * A scratch home with one registered Project, a Task pinned to `CONFIG_SHA` whose worktree exists and
 * whose current Stage is live, and `Steps` over a real `HostRunner` (AD-24: no Owner instance touched).
 */
export function stepsHarness(options: StepsHarnessOptions): StepsHarness {
  const home = createTempHome();
  const paths = ensureHome(home.root);
  const ts = openTestStore();
  const project: Project = { id: ulid(), name: 'training', paused_at: null, telegram_chat_id: null, repo_url: null, exclusive_capabilities: [], created_at: NOW };
  ts.store.insertProject(project);
  writeFileSync(join(paths.secrets, 'training.env'), options.projectEnv ?? '', { mode: 0o600 });
  const reads: Array<[string, string]> = [];
  const clock = fakeClock();
  const host = new HostRunner({
    leases: ts.store,
    stepsDir: join(paths.data, 'steps'),
    capabilities: () => options.capabilities ?? { echoer: '/bin/echo' },
    instanceSecrets: () => ({}),
    clock,
    baseEnv: { PATH: process.env['PATH'], HOME: home.root, DAEMON_ONLY: 'leak' },
  });
  const steps = new Steps({
    store: ts.store,
    repo: {
      readFile: async (name, sha, path) => {
        reads.push([name, sha]);
        return sha === CONFIG_SHA && path === 'antipod.yaml' ? options.recipe : undefined;
      },
    },
    dataDir: paths.data,
    secretsDir: paths.secrets,
    runners: { container: options.container ?? fakeContainerRunner().runner, host },
    clock,
  });

  const addTask = () => {
    const task = taskSchema.parse({
      id: ulid(), project_id: project.id, kind: 'feature', task_no: ts.store.nextTaskNo(project.id), state: 'implementing',
      current_stage_id: null, budget_used: 1, budget_limit: 5, review_round: 0, resume_state: null, stuck_reason: null,
      waiting_reason: null, undo_expires_at: null, config_sha: CONFIG_SHA, created_at: NOW, updated_at: NOW,
    });
    ts.store.insertTask(task);
    const stage: Stage = { id: ulid(), task_id: task.id, role: 'implementer', attempt: 1, status: 'running', reason: null, created_at: NOW, started_at: NOW, ended_at: null };
    ts.store.insertStage(stage);
    ts.store.updateTask(task.id, { current_stage_id: stage.id, updated_at: NOW });
    const worktree = join(paths.data, 'worktrees', 'training', String(task.task_no));
    mkdirSync(worktree, { recursive: true });
    return { task: { ...task, current_stage_id: stage.id }, stage, worktree };
  };
  const first = addTask();
  return { ...ts, paths, project, ...first, steps, reads, addTask };
}

/** A Recipe with the given `steps:` lines (YAML flow mappings, two-space indented). */
export function recipeWith(steps: string, extra = ''): string {
  return `name: training
evidence_kinds: [screenshot]
${extra}steps:
${steps}
`;
}
