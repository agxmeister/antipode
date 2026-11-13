import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killSteps, PID_FILE } from '../../src/adapters/host/runner.ts';
import { PREVIEW_DATA_DIR, recoverSteps, STAGE_NOT_RUNNING } from '../../src/app/steps.ts';
import { ulid } from '../../src/core/domain/ids.ts';
import { fakeClock } from '../helpers/clock.ts';
import { git } from '../helpers/git.ts';
import { CONFIG_SHA, fakeContainerRunner, recipeWith, stepsHarness, type StepsHarness } from '../helpers/steps.ts';

let open: StepsHarness[] = [];
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

function harness(options: Parameters<typeof stepsHarness>[0]): StepsHarness {
  const h = stepsHarness(options);
  open.push(h);
  return h;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HOST_BUILD = '  build: { runner: host, capability: echoer, cmd: "echo hi > $ANTIPOD_OUT/a; echo logged", timeout: 1m }';

describe('Steps (AD-7, CAP-2, CAP-5)', () => {
  it('Container step: hands the container Runner the one contract — cwd, env, mounts, image, log, timeout', async () => {
    const container = fakeContainerRunner();
    const h = harness({
      recipe: recipeWith('  build: { runner: container, image: busybox, cmd: "echo hi > $ANTIPOD_OUT/a", timeout: 90s, secrets: [TOKEN_A] }'),
      projectEnv: 'TOKEN_A=a-value\nTOKEN_B=b-value\n',
      container: container.runner,
    });
    const result = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    expect(result).toMatchObject({ ok: true, outcome: 'exited', exit_code: 0 });
    expect(h.reads).toEqual([['training', CONFIG_SHA]]);
    const [spec] = container.specs;
    const runDir = join(h.paths.data, 'steps', spec!.stepRunId);
    const data = join(h.worktree, PREVIEW_DATA_DIR);
    const prior = join(h.paths.data, 'prior', 'training', String(h.task.task_no));
    expect(spec).toMatchObject({
      taskId: h.task.id,
      cmd: 'echo hi > $ANTIPOD_OUT/a',
      image: 'busybox',
      cwd: h.worktree,
      logPath: join(runDir, 'log'),
      timeoutMs: 90_000,
      env: { TOKEN_A: 'a-value', ANTIPOD_OUT: join(runDir, 'out'), ANTIPOD_DATA: data, ANTIPOD_PRIOR: prior, ANTIPOD_TASK: String(h.task.task_no) },
      mounts: [
        { path: h.worktree, readOnly: false },
        { path: join(runDir, 'out'), readOnly: false },
        { path: data, readOnly: false },
        { path: prior, readOnly: true },
      ],
    });
    expect(Object.keys(spec!.env).sort()).toEqual(['ANTIPOD_DATA', 'ANTIPOD_OUT', 'ANTIPOD_PRIOR', 'ANTIPOD_TASK', 'TOKEN_A']);
    expect(result).toMatchObject({ log: join(runDir, 'log'), out: join(runDir, 'out') });
    expect(existsSync(join(runDir, 'out'))).toBe(true);
    expect(existsSync(prior)).toBe(true);
  });

  it('Host step: records the step run, writes out/ and the log; env has TOKEN_A, not TOKEN_B, nor the daemon’s variables', async () => {
    const h = harness({
      recipe: recipeWith('  build: { runner: host, capability: echoer, cmd: "env > $ANTIPOD_OUT/env; echo logged; exit 0", timeout: 1m, secrets: [TOKEN_A] }'),
      projectEnv: 'TOKEN_A=a-value\nTOKEN_B=b-value\n',
    });
    const result = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    if (!result.ok) throw new Error(result.refused);
    expect(result).toMatchObject({ outcome: 'exited', exit_code: 0 });
    const env = readFileSync(join(result.out, 'env'), 'utf8');
    expect(env).toContain('TOKEN_A=a-value');
    expect(env).not.toContain('TOKEN_B');
    expect(env).not.toContain('DAEMON_ONLY');
    expect(env).toContain(`ANTIPOD_TASK=${h.task.task_no}`);
    expect(readFileSync(result.log, 'utf8')).toBe('logged\n');
    expect(h.store.getStepRun(result.step_run_id)).toMatchObject({
      task_id: h.task.id, stage_id: h.stage.id, step: 'build', runner: 'host', status: 'finished', outcome: 'exited', exit_code: 0, reason: null,
    });
    expect(h.store.getStepRun(result.step_run_id)?.ended_at).not.toBeNull();
  });

  it('Non-zero exit: exited 3, row finished with exit code 3', async () => {
    const h = harness({ recipe: recipeWith('  build: { runner: host, capability: echoer, cmd: "exit 3", timeout: 1m }') });
    const result = await h.steps.run({ taskId: h.task.id, step: 'build' });
    expect(result).toMatchObject({ ok: true, outcome: 'exited', exit_code: 3 });
    expect(h.store.stepRunsInStatus(['finished'])).toMatchObject([{ stage_id: null, exit_code: 3 }]);
  });

  it('Timeout: a 1s timeout on sleep 30 ends as timeout well within 11 s', async () => {
    const h = harness({ recipe: recipeWith('  build: { runner: host, capability: echoer, cmd: "sleep 30", timeout: 1s }') });
    const started = Date.now();
    const result = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    expect(result).toMatchObject({ ok: true, outcome: 'timeout', exit_code: null });
    expect(Date.now() - started).toBeLessThan(11_000);
  });

  it('Busy: an exclusive capability leased by another Task → capability_busy, nothing spawned', async () => {
    const h = harness({ recipe: recipeWith('  evidence: { runner: host, capability: echoer, exclusive: true, cmd: "echo ran > $ANTIPOD_OUT/ran", timeout: 1m }') });
    const other = h.addTask();
    const holder = ulid();
    h.store.insertStepRun({ id: holder, task_id: other.task.id, stage_id: null, step: 'evidence', runner: 'host', status: 'running', outcome: null, exit_code: null, reason: null, started_at: '2026-11-08T12:00:00.000Z', ended_at: null });
    h.store.acquireLease({ capability: 'echoer', task_id: other.task.id, step_run_id: holder, acquired_at: '2026-11-08T12:00:00.000Z' });
    const result = await h.steps.run({ stageId: h.stage.id, step: 'evidence' });
    if (!result.ok) throw new Error(result.refused);
    expect(result).toMatchObject({ outcome: 'capability_busy', exit_code: null });
    expect(existsSync(join(result.out, 'ran'))).toBe(false);
    expect(h.store.getStepRun(result.step_run_id)).toMatchObject({ status: 'finished', outcome: 'capability_busy' });
  });

  it('two Tasks running the same exclusive host step at once: exactly one spawns; the lease is gone after', async () => {
    const h = harness({ recipe: recipeWith('  evidence: { runner: host, capability: echoer, exclusive: true, cmd: "sleep 0.3; echo ran > $ANTIPOD_OUT/ran", timeout: 1m }') });
    const other = h.addTask();
    const results = await Promise.all([h.steps.run({ stageId: h.stage.id, step: 'evidence' }), h.steps.run({ stageId: other.stage.id, step: 'evidence' })]);
    const outcomes = results.map((r) => (r.ok ? r.outcome : r.refused)).sort();
    expect(outcomes).toEqual(['capability_busy', 'exited']);
    expect(results.filter((r) => r.ok && existsSync(join(r.out, 'ran')))).toHaveLength(1);
    expect(h.store.listLeases()).toEqual([]);
  });

  it.each([
    ['Unknown step', recipeWith(HOST_BUILD), 'nope', '', 'no step nope in the Recipe'],
    ['Missing secret', recipeWith('  build: { runner: host, capability: echoer, cmd: "true", timeout: 1m, secrets: [API_KEY] }'), 'build', 'OTHER=1\n', 'secret API_KEY is not set'],
    ['Unmapped capability', recipeWith('  build: { runner: host, capability: unity-editor, cmd: "true", timeout: 1m }'), 'build', '', 'capability unity-editor is not configured on this host'],
  ])('%s: refused before anything is spawned or recorded', async (_name, recipe, step, env, reason) => {
    const h = harness({ recipe, projectEnv: env });
    expect(await h.steps.run({ stageId: h.stage.id, step })).toEqual({ ok: false, refused: reason });
    expect(h.store.stepRunsInStatus(['running', 'finished', 'failed'])).toEqual([]);
    expect(existsSync(join(h.paths.data, 'steps'))).toBe(false);
  });

  it('Stale Stage: a Stage not live, not current, or unknown is refused with stage is not running', async () => {
    const h = harness({ recipe: recipeWith(HOST_BUILD) });
    expect(await h.steps.run({ stageId: 'missing', step: 'build' })).toEqual({ ok: false, refused: STAGE_NOT_RUNNING });
    const second = h.addTask();
    // Not current: the Task points at another Stage.
    h.store.updateTask(second.task.id, { current_stage_id: h.stage.id, updated_at: '2026-11-08T12:00:00.000Z' });
    expect(await h.steps.run({ stageId: second.stage.id, step: 'build' })).toEqual({ ok: false, refused: STAGE_NOT_RUNNING });
    // Not live.
    h.store.updateStage(h.stage.id, { status: 'cancelled', reason: 'pause' });
    expect(await h.steps.run({ stageId: h.stage.id, step: 'build' })).toEqual({ ok: false, refused: STAGE_NOT_RUNNING });
  });

  it('Fixtures: ANTIPOD_DATA is seeded once from the fixtures dir before the first step; step 1’s edits survive into step 2', async () => {
    const h = harness({
      recipe: recipeWith(
        '  build: { runner: host, capability: echoer, cmd: "echo edited >> $ANTIPOD_DATA/users.csv; cat $ANTIPOD_DATA/users.csv > $ANTIPOD_OUT/seen", timeout: 1m }',
        'fixtures: seed\n',
      ),
    });
    mkdirSync(join(h.worktree, 'seed', 'nested'), { recursive: true });
    writeFileSync(join(h.worktree, 'seed', 'users.csv'), 'alice\n');
    writeFileSync(join(h.worktree, 'seed', 'nested', 'x.txt'), 'x');
    git(h.worktree, 'init', '--quiet');
    const first = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    const second = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    if (!first.ok || !second.ok) throw new Error('refused');
    expect(readFileSync(join(first.out, 'seen'), 'utf8')).toBe('alice\nedited\n');
    expect(readFileSync(join(second.out, 'seen'), 'utf8')).toBe('alice\nedited\nedited\n');
    const data = join(h.worktree, PREVIEW_DATA_DIR);
    expect(readdirSync(data).sort()).toEqual(['.gitignore', 'nested', 'users.csv']);
    expect(readFileSync(join(data, 'nested', 'x.txt'), 'utf8')).toBe('x');
    // Preview Data is never picked up by git in the worktree.
    expect(readFileSync(join(data, '.gitignore'), 'utf8')).toBe('*\n');
    expect(git(h.worktree, 'status', '--porcelain', '--untracked-files=all')).not.toContain(PREVIEW_DATA_DIR);
    expect(readdirSync(h.worktree).filter((e) => e.startsWith(`${PREVIEW_DATA_DIR}.`))).toEqual([]);
  });

  it('without fixtures, ANTIPOD_DATA is created empty', async () => {
    const h = harness({ recipe: recipeWith(HOST_BUILD) });
    await h.steps.run({ stageId: h.stage.id, step: 'build' });
    expect(readdirSync(join(h.worktree, PREVIEW_DATA_DIR))).toEqual(['.gitignore']);
  });

  it('Fixtures: two first steps of a Task started together both run; fixtures are seeded once, no staging siblings remain', async () => {
    const h = harness({
      recipe: recipeWith('  build: { runner: host, capability: echoer, cmd: "ls $ANTIPOD_DATA > $ANTIPOD_OUT/seen", timeout: 1m }', 'fixtures: seed\n'),
    });
    mkdirSync(join(h.worktree, 'seed'), { recursive: true });
    writeFileSync(join(h.worktree, 'seed', 'users.csv'), 'alice\n');
    const results = await Promise.all([h.steps.run({ stageId: h.stage.id, step: 'build' }), h.steps.run({ stageId: h.stage.id, step: 'build' })]);
    for (const result of results) {
      if (!result.ok) throw new Error(result.refused);
      expect(result).toMatchObject({ outcome: 'exited', exit_code: 0 });
      expect(readFileSync(join(result.out, 'seen'), 'utf8')).toBe('users.csv\n');
    }
    expect(readdirSync(join(h.worktree, PREVIEW_DATA_DIR)).sort()).toEqual(['.gitignore', 'users.csv']);
    expect(readdirSync(h.worktree).filter((e) => e.startsWith(`${PREVIEW_DATA_DIR}.`))).toEqual([]);
  });

  it('a failure copying outputs marks the row failed with the error and refuses', async () => {
    const h = harness({
      recipe: recipeWith(
        '  build: { runner: host, capability: echoer, cmd: "mkdir -p build/outputs && echo apk > build/outputs/a && echo x > $ANTIPOD_OUT/build", timeout: 1m, outputs: build/outputs }',
      ),
    });
    const result = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    expect(result).toMatchObject({ ok: false, refused: expect.stringMatching(/^step build outputs could not be copied: /) });
    const [run] = h.store.stepRunsInStatus(['failed']);
    expect(run).toMatchObject({ outcome: 'exited', exit_code: 0 });
    expect(run?.reason).not.toBeNull();
    expect(h.store.stepRunsInStatus(['running'])).toEqual([]);
  });

  it('a step that exited on its own as the signal aborted keeps its exit code and finishes', async () => {
    const controller = new AbortController();
    const h = harness({
      recipe: recipeWith('  build: { runner: container, image: busybox, cmd: "true", timeout: 1m }'),
      container: {
        refusal: () => undefined,
        run: async () => {
          controller.abort();
          return { outcome: 'exited', exit_code: 0 };
        },
      },
    });
    const result = await h.steps.run({ stageId: h.stage.id, step: 'build', signal: controller.signal });
    expect(result).toMatchObject({ ok: true, outcome: 'exited', exit_code: 0 });
    expect(h.store.stepRunsInStatus(['finished'])).toMatchObject([{ exit_code: 0, reason: null }]);
  });

  it('copies declared outputs from the worktree into ANTIPOD_OUT after exit 0 only', async () => {
    const h = harness({
      recipe: recipeWith(
        '  build: { runner: host, capability: echoer, cmd: "mkdir -p build/outputs && echo apk > build/outputs/app.apk", timeout: 1m, outputs: build/outputs }\n' +
          '  broken: { runner: host, capability: echoer, cmd: "mkdir -p dist && echo x > dist/x; exit 1", timeout: 1m, outputs: dist }',
      ),
    });
    const ok = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    if (!ok.ok) throw new Error(ok.refused);
    expect(readFileSync(join(ok.out, 'build', 'outputs', 'app.apk'), 'utf8')).toBe('apk\n');
    const failed = await h.steps.run({ stageId: h.stage.id, step: 'broken' });
    if (!failed.ok) throw new Error(failed.refused);
    expect(existsSync(join(failed.out, 'dist'))).toBe(false);
  });

  it('an aborted request stops the step and marks the row failed(aborted)', async () => {
    const h = harness({ recipe: recipeWith('  build: { runner: host, capability: echoer, cmd: "sleep 30", timeout: 1m }') });
    const controller = new AbortController();
    const run = h.steps.run({ stageId: h.stage.id, step: 'build', signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    expect(await run).toEqual({ ok: false, refused: 'step build was stopped' });
    expect(h.store.stepRunsInStatus(['failed'])).toMatchObject([{ status: 'failed', reason: 'aborted' }]);
  });

  it('a Runner that cannot start marks the row failed with the error', async () => {
    const h = harness({
      recipe: recipeWith('  build: { runner: container, image: busybox, cmd: "true", timeout: 1m }'),
      container: { refusal: () => undefined, run: async () => Promise.reject(new Error('spawn podman ENOENT')) },
    });
    const result = await h.steps.run({ stageId: h.stage.id, step: 'build' });
    expect(result).toEqual({ ok: false, refused: 'step build could not start: spawn podman ENOENT' });
    expect(h.store.stepRunsInStatus(['failed'])).toMatchObject([{ reason: 'spawn podman ENOENT' }]);
  });
});

describe('recoverSteps (AD-18)', () => {
  it('fails running step runs with restart, kills leased and left-running host process groups, removes containers, clears leases', async () => {
    const h = harness({ recipe: recipeWith(HOST_BUILD) });
    const stepsDir = join(h.paths.data, 'steps');
    const id = ulid();
    h.store.insertStepRun({ id, task_id: h.task.id, stage_id: h.stage.id, step: 'evidence', runner: 'host', status: 'running', outcome: null, exit_code: null, reason: null, started_at: '2026-11-08T12:00:00.000Z', ended_at: null });
    h.store.acquireLease({ capability: 'echoer', task_id: h.task.id, step_run_id: id, acquired_at: '2026-11-08T12:00:00.000Z' });
    const child = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    child.unref();
    mkdirSync(join(stepsDir, id), { recursive: true });
    writeFileSync(join(stepsDir, id, PID_FILE), `${child.pid}\n`);
    // A non-exclusive host step left running: no lease, only its row and pid file.
    const plain = ulid();
    h.store.insertStepRun({ id: plain, task_id: h.task.id, stage_id: h.stage.id, step: 'build', runner: 'host', status: 'running', outcome: null, exit_code: null, reason: null, started_at: '2026-11-08T12:00:00.000Z', ended_at: null });
    const plainChild = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    plainChild.unref();
    mkdirSync(join(stepsDir, plain), { recursive: true });
    writeFileSync(join(stepsDir, plain, PID_FILE), `${plainChild.pid}\n`);
    let removals = 0;
    const report = await recoverSteps({
      store: h.store,
      clock: fakeClock(),
      killHostSteps: (ids) => killSteps(ids, stepsDir),
      removeOrphans: async () => {
        removals++;
        return 2;
      },
    });
    // The leased run is also a running host row: killed once, not twice.
    expect(report).toEqual({ step_runs_failed: 2, host_steps_killed: 2, step_containers_removed: 2, leases_cleared: 1 });
    expect(h.store.getStepRun(id)).toMatchObject({ status: 'failed', reason: 'restart' });
    expect(h.store.getStepRun(plain)).toMatchObject({ status: 'failed', reason: 'restart' });
    expect(h.store.listLeases()).toEqual([]);
    const end = Date.now() + 5000;
    while ((alive(child.pid!) || alive(plainChild.pid!)) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(child.pid!)).toBe(false);
    expect(alive(plainChild.pid!)).toBe(false);
    expect(removals).toBe(1);
  });

  it('skips podman when no run was left running, and survives a removal failure', async () => {
    const h = harness({ recipe: recipeWith(HOST_BUILD) });
    let removals = 0;
    const deps = {
      store: h.store,
      clock: fakeClock(),
      killHostSteps: () => 0,
      removeOrphans: async () => {
        removals++;
        throw new Error('podman down');
      },
    };
    expect(await recoverSteps(deps)).toMatchObject({ step_runs_failed: 0, step_containers_removed: 0 });
    expect(removals).toBe(0);
    h.store.insertStepRun({ id: ulid(), task_id: h.task.id, stage_id: null, step: 'build', runner: 'container', status: 'running', outcome: null, exit_code: null, reason: null, started_at: '2026-11-08T12:00:00.000Z', ended_at: null });
    expect(await recoverSteps(deps)).toMatchObject({ step_runs_failed: 1, step_containers_removed: 0 });
    expect(removals).toBe(1);
  });
});
