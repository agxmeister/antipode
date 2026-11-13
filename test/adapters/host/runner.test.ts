import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_ENV, HostRunner, killLeased, PID_FILE } from '../../../src/adapters/host/runner.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import { taskSchema } from '../../../src/core/domain/task.ts';
import type { StepSpec } from '../../../src/core/ports/step-runner.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

const NOW = '2026-11-08T12:00:00.000Z';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function setup(options: { capabilities?: Record<string, string>; secrets?: Record<string, string>; killGraceMs?: number } = {}) {
  const ts = openTestStore();
  open.push(ts);
  const root = mkdtempSync(join(tmpdir(), 'antipod-host-'));
  const stepsDir = join(root, 'steps');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const project = { id: ulid(), name: 'alpha', paused_at: null, telegram_chat_id: null, repo_url: null, exclusive_capabilities: [], created_at: NOW };
  ts.store.insertProject(project);
  const runner = new HostRunner({
    leases: ts.store,
    stepsDir,
    capabilities: () => options.capabilities ?? { echoer: '/bin/echo' },
    instanceSecrets: () => options.secrets ?? {},
    clock: fakeClock(),
    baseEnv: { PATH: process.env['PATH'], HOME: '/home/owner', LANG: 'C', TMPDIR: '/tmp', DAEMON_ONLY: 'leak', TELEGRAM_BOT_TOKEN: 'bot' },
    killGraceMs: options.killGraceMs ?? 10_000,
  });

  /** A Task with a `step_runs` row, and the spec of a step for it. */
  const spec = (cmd: string, overrides: Partial<StepSpec> = {}): StepSpec => {
    const task = taskSchema.parse({
      id: ulid(), project_id: project.id, kind: 'feature', task_no: ts.store.nextTaskNo(project.id), state: 'evidencing', current_stage_id: null, budget_used: 0,
      budget_limit: 5, review_round: 0, resume_state: null, stuck_reason: null, waiting_reason: null, undo_expires_at: null,
      config_sha: null, created_at: NOW, updated_at: NOW,
    });
    ts.store.insertTask(task);
    const id = ulid();
    ts.store.insertStepRun({ id, task_id: task.id, stage_id: null, step: 'evidence', runner: 'host', status: 'running', outcome: null, exit_code: null, reason: null, started_at: NOW, ended_at: null });
    const out = join(stepsDir, id, 'out');
    mkdirSync(out, { recursive: true });
    return {
      stepRunId: id,
      taskId: task.id,
      cmd,
      capability: 'echoer',
      exclusive: false,
      cwd: worktree,
      env: { ANTIPOD_OUT: out, ANTIPOD_DATA: join(worktree, '.antipod-data'), ANTIPOD_PRIOR: join(root, 'prior'), ANTIPOD_TASK: '1' },
      mounts: [],
      logPath: join(stepsDir, id, 'log'),
      timeoutMs: 30_000,
      ...overrides,
    };
  };
  return { ...ts, runner, spec, stepsDir, worktree };
}

describe('HostRunner (AD-7, AD-19)', () => {
  it('Host step: runs sh -c in the worktree with only the contract, named secrets, PATH/HOME/LANG/TMPDIR and ANTIPOD_CAPABILITY', async () => {
    const h = setup();
    const s = h.spec('pwd > "$ANTIPOD_OUT/cwd"; env > "$ANTIPOD_OUT/env"; echo to-log; echo err >&2; "$ANTIPOD_CAPABILITY" via-capability', {
      env: { ...h.spec('true').env, TOKEN_A: 'a-value' },
    });
    const result = await h.runner.run(s);
    expect(result).toEqual({ outcome: 'exited', exit_code: 0 });
    const out = s.env['ANTIPOD_OUT']!;
    expect(realpathSync(readFileSync(join(out, 'cwd'), 'utf8').trim())).toBe(realpathSync(h.worktree));
    const env = Object.fromEntries(
      readFileSync(join(out, 'env'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    // sh itself may add PWD, SHLVL and _; nothing else of the daemon's environment reaches the step.
    const keys = Object.keys(env).filter((key) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(key)).sort();
    expect(keys).toEqual(['ANTIPOD_CAPABILITY', 'ANTIPOD_DATA', 'ANTIPOD_OUT', 'ANTIPOD_PRIOR', 'ANTIPOD_TASK', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TOKEN_A']);
    expect(env[CAPABILITY_ENV]).toBe('/bin/echo');
    expect(env['TOKEN_A']).toBe('a-value');
    expect(readFileSync(s.logPath, 'utf8')).toBe('to-log\nerr\nvia-capability\n');
    expect(existsSync(join(h.stepsDir, s.stepRunId, PID_FILE))).toBe(false);
  });

  it('Non-zero exit: exit 3 → exited 3', async () => {
    const h = setup();
    expect(await h.runner.run(h.spec('exit 3'))).toEqual({ outcome: 'exited', exit_code: 3 });
  });

  it('Timeout: SIGTERM to the group ends it with outcome timeout and the processes gone', async () => {
    const h = setup();
    const s = h.spec('echo $$ > "$ANTIPOD_OUT/pid"; sleep 30', { timeoutMs: 300 });
    const started = Date.now();
    expect(await h.runner.run(s)).toEqual({ outcome: 'timeout', exit_code: null });
    expect(Date.now() - started).toBeLessThan(11_000);
    const pid = Number(readFileSync(join(s.env['ANTIPOD_OUT']!, 'pid'), 'utf8'));
    expect(alive(pid)).toBe(false);
  });

  it('Timeout: a group that ignores SIGTERM is SIGKILLed after the grace', async () => {
    const h = setup({ killGraceMs: 300 });
    const s = h.spec("trap '' TERM; echo $$ > \"$ANTIPOD_OUT/pid\"; while :; do sleep 0.1; done", { timeoutMs: 300 });
    expect(await h.runner.run(s)).toEqual({ outcome: 'timeout', exit_code: null });
    expect(alive(Number(readFileSync(join(s.env['ANTIPOD_OUT']!, 'pid'), 'utf8')))).toBe(false);
  });

  it('Timeout: a background child that ignores TERM is SIGKILLed with the group as soon as the leader exits', async () => {
    const h = setup({ killGraceMs: 60_000 });
    const s = h.spec(`(trap '' TERM; sh -c 'echo $$ > "$ANTIPOD_OUT/child"; exec sleep 30') & sleep 30`, { timeoutMs: 500 });
    expect(await h.runner.run(s)).toEqual({ outcome: 'timeout', exit_code: null });
    const child = Number(readFileSync(join(s.env['ANTIPOD_OUT']!, 'child'), 'utf8'));
    await until(() => !alive(child), 2000);
  });

  it('an aborted signal stops the step and resolves with exit_code null', async () => {
    const h = setup();
    const controller = new AbortController();
    const run = h.runner.run(h.spec('sleep 30'), controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await run).toEqual({ outcome: 'exited', exit_code: null });
  });

  it('Busy: a capability leased by another Task returns capability_busy without spawning', async () => {
    const h = setup();
    const holder = h.spec('true', { exclusive: true });
    h.store.acquireLease({ capability: 'echoer', task_id: holder.taskId, step_run_id: holder.stepRunId, acquired_at: NOW });
    const s = h.spec('echo ran > "$ANTIPOD_OUT/ran"', { exclusive: true });
    expect(await h.runner.run(s)).toEqual({ outcome: 'capability_busy', exit_code: null });
    expect(existsSync(join(s.env['ANTIPOD_OUT']!, 'ran'))).toBe(false);
    expect(existsSync(s.logPath)).toBe(false);
  });

  it('two Tasks naming the same exclusive capability at once: one spawns, the other is busy; the lease is gone after', async () => {
    const h = setup();
    const a = h.spec('sleep 0.3; echo a > "$ANTIPOD_OUT/ran"', { exclusive: true });
    const b = h.spec('sleep 0.3; echo b > "$ANTIPOD_OUT/ran"', { exclusive: true });
    const results = await Promise.all([h.runner.run(a), h.runner.run(b)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['capability_busy', 'exited']);
    const ran = [a, b].filter((s) => existsSync(join(s.env['ANTIPOD_OUT']!, 'ran')));
    expect(ran).toHaveLength(1);
    expect(h.store.listLeases()).toEqual([]);
  });

  it('holds the lease while running and releases it on a non-zero exit', async () => {
    const h = setup();
    const s = h.spec('sleep 0.3; exit 4', { exclusive: true });
    const run = h.runner.run(s);
    await until(() => h.store.listLeases().length === 1);
    expect(h.store.listLeases()[0]).toMatchObject({ capability: 'echoer', task_id: s.taskId, step_run_id: s.stepRunId });
    expect(await run).toEqual({ outcome: 'exited', exit_code: 4 });
    expect(h.store.listLeases()).toEqual([]);
  });

  it('Unmapped capability: refused before spawning; run rejects', async () => {
    const h = setup();
    expect(h.runner.refusal({ capability: 'unity-editor' })).toBe('capability unity-editor is not configured on this host');
    expect(h.runner.refusal({ capability: 'echoer' })).toBeUndefined();
    await expect(h.runner.run(h.spec('true', { capability: 'unity-editor' }))).rejects.toThrow('capability unity-editor is not configured on this host');
  });

  it('expands $NAME and ${NAME} in the capability command from secrets/antipod.env; an unset reference is refused', async () => {
    const h = setup({ capabilities: { unity: '/opt/unity --license $UNITY_SERIAL --user ${UNITY_USER}', bad: 'x $NOPE' }, secrets: { UNITY_SERIAL: 'S-1', UNITY_USER: 'me' } });
    expect(h.runner.resolveCapability('unity')).toEqual({ ok: true, command: '/opt/unity --license S-1 --user me' });
    expect(h.runner.refusal({ capability: 'bad' })).toBe('capability bad references NOPE, which is not set in secrets/antipod.env');
    const s = h.spec('printf %s "$ANTIPOD_CAPABILITY" > "$ANTIPOD_OUT/cap"', { capability: 'unity' });
    await h.runner.run(s);
    expect(readFileSync(join(s.env['ANTIPOD_OUT']!, 'cap'), 'utf8')).toBe('/opt/unity --license S-1 --user me');
  });

  it('leaves $PATH, $HOME, $LANG and $TMPDIR for the step’s shell when antipod.env does not set them; antipod.env wins when it does', async () => {
    const h = setup({ capabilities: { tool: '$HOME/bin/tool --tmp ${TMPDIR} --lang $LANG --path $PATH', mine: '$HOME/x' }, secrets: {} });
    expect(h.runner.resolveCapability('tool')).toEqual({ ok: true, command: '$HOME/bin/tool --tmp ${TMPDIR} --lang $LANG --path $PATH' });
    expect(h.runner.refusal({ capability: 'tool' })).toBeUndefined();
    const s = h.spec('eval "printf %s \\"$ANTIPOD_CAPABILITY\\"" > "$ANTIPOD_OUT/cap"', { capability: 'tool' });
    expect(await h.runner.run(s)).toEqual({ outcome: 'exited', exit_code: 0 });
    expect(readFileSync(join(s.env['ANTIPOD_OUT']!, 'cap'), 'utf8')).toBe(`/home/owner/bin/tool --tmp /tmp --lang C --path ${process.env['PATH']}`);
    const overridden = setup({ capabilities: { mine: '$HOME/x' }, secrets: { HOME: '/srv' } });
    expect(overridden.runner.resolveCapability('mine')).toEqual({ ok: true, command: '/srv/x' });
  });

  it('killLeased SIGKILLs the process group named by each leased step’s pid file', async () => {
    const h = setup();
    const s = h.spec('true');
    const child = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    mkdirSync(join(h.stepsDir, s.stepRunId), { recursive: true });
    writeFileSync(join(h.stepsDir, s.stepRunId, PID_FILE), `${pid}\n`);
    const lease = { capability: 'echoer', task_id: s.taskId, step_run_id: s.stepRunId, acquired_at: NOW };
    const orphan = { capability: 'other', task_id: s.taskId, step_run_id: 'NO-PID-FILE', acquired_at: NOW };
    expect(killLeased([lease, orphan], h.stepsDir)).toBe(1);
    await until(() => !alive(pid));
    expect(killLeased([lease], h.stepsDir)).toBe(0);
  });
});
