import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerName, INSTANCE_LABEL, PodmanRunner, podmanRunArgs, STEP_RUN_LABEL } from '../../../src/adapters/podman/runner.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import type { StepSpec } from '../../../src/core/ports/step-runner.ts';

const IMAGE = 'docker.io/library/busybox:1.37';

/**
 * Whether Podman can run busybox here with a bind mount of a temp directory (AD-24). Undefined when
 * it can; otherwise why not, so the skip says it.
 */
function podmanUnavailable(): string | undefined {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'antipod-podman-probe-')));
  try {
    execFileSync('podman', ['run', '--rm', '--volume', `${dir}:${dir}:rw`, IMAGE, 'sh', '-c', `echo ok > ${dir}/probe`], { stdio: 'ignore', timeout: 120_000 });
    return existsSync(join(dir, 'probe')) ? undefined : 'podman cannot bind-mount a temp directory into a container';
  } catch (error) {
    return `podman cannot run ${IMAGE} with a bind mount (${(error as Error).message.split('\n')[0]})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function spec(root: string, cmd: string, overrides: Partial<StepSpec> = {}): StepSpec {
  const id = ulid();
  const worktree = join(root, 'worktree');
  const out = join(root, 'steps', id, 'out');
  const data = join(worktree, '.antipod-data');
  const prior = join(root, 'prior');
  for (const dir of [worktree, out, data, prior]) mkdirSync(dir, { recursive: true });
  return {
    stepRunId: id,
    taskId: 'task',
    cmd,
    image: IMAGE,
    cwd: worktree,
    env: { ANTIPOD_OUT: out, ANTIPOD_DATA: data, ANTIPOD_PRIOR: prior, ANTIPOD_TASK: '7' },
    mounts: [
      { path: worktree, readOnly: false },
      { path: out, readOnly: false },
      { path: data, readOnly: false },
      { path: prior, readOnly: true },
    ],
    logPath: join(root, 'steps', id, 'log'),
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe('podmanRunArgs (AD-7)', () => {
  it('runs --rm, named and labelled, cwd the worktree, only the given mounts, env by name only', () => {
    const s = spec(mkdtempSync(join(tmpdir(), 'antipod-podman-')), 'echo hi', { env: { TOKEN_A: 'secret-value', ANTIPOD_OUT: '/o' } });
    const args = podmanRunArgs(s, '/home/instance');
    expect(args.slice(0, 9)).toEqual([
      'run', '--rm', '--name', containerName(s.stepRunId), '--label', `${INSTANCE_LABEL}=/home/instance`, '--label', `${STEP_RUN_LABEL}=${s.stepRunId}`, '--workdir',
    ]);
    expect(args[9]).toBe(s.cwd);
    expect(args.filter((_, i) => args[i - 1] === '--volume')).toEqual(s.mounts.map((m) => `${m.path}:${m.path}:${m.readOnly ? 'ro' : 'rw'}`));
    expect(args.filter((_, i) => args[i - 1] === '--env')).toEqual(['TOKEN_A', 'ANTIPOD_OUT']);
    expect(args.join(' ')).not.toContain('secret-value');
    expect(args.slice(-4)).toEqual([IMAGE, 'sh', '-c', 'echo hi']);
    expect(containerName(s.stepRunId)).toBe(`antipod-${s.stepRunId}`);
  });

  it('refuses a spec without an image', () => {
    const s = spec(mkdtempSync(join(tmpdir(), 'antipod-podman-')), 'true');
    delete s.image;
    expect(() => podmanRunArgs(s, 'x')).toThrow('a container step needs an image');
  });

  it('a missing podman binary rejects run and removeOrphans', async () => {
    const runner = new PodmanRunner({ instance: 'x', podman: '/nonexistent/podman' });
    const s = spec(mkdtempSync(join(tmpdir(), 'antipod-podman-')), 'true');
    await expect(runner.run(s)).rejects.toThrow(/ENOENT/);
    await expect(runner.removeOrphans()).rejects.toThrow();
    expect(runner.refusal()).toBeUndefined();
  });
});

const unavailable = podmanUnavailable();

describe.skipIf(unavailable !== undefined)(`PodmanRunner against busybox (AD-24)${unavailable === undefined ? '' : ` — skipped: ${unavailable}`}`, () => {
  const root = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'antipod-podman-')));
  const instance = `antipod-test-${ulid()}`;
  const runner = new PodmanRunner({ instance, baseEnv: { ...process.env, TOKEN_B: 'b-value', DAEMON_ONLY: 'leak' } });

  it('Container step: exit 0, out/a = hi, log has the output; env is the contract plus named secrets only', async () => {
    const s = spec(root(), 'echo hi > $ANTIPOD_OUT/a; echo logged; env > $ANTIPOD_OUT/env; pwd > $ANTIPOD_OUT/cwd', {});
    s.env = { ...s.env, TOKEN_A: 'a-value' };
    expect(await runner.run(s)).toEqual({ outcome: 'exited', exit_code: 0 });
    const out = s.env['ANTIPOD_OUT']!;
    expect(readFileSync(join(out, 'a'), 'utf8')).toBe('hi\n');
    expect(readFileSync(s.logPath, 'utf8')).toContain('logged');
    expect(readFileSync(join(out, 'cwd'), 'utf8').trim()).toBe(s.cwd);
    const env = readFileSync(join(out, 'env'), 'utf8');
    expect(env).toContain('TOKEN_A=a-value');
    expect(env).not.toContain('TOKEN_B');
    expect(env).not.toContain('DAEMON_ONLY');
  }, 120_000);

  it('ANTIPOD_PRIOR is read-only', async () => {
    const s = spec(root(), 'touch $ANTIPOD_PRIOR/x');
    const result = await runner.run(s);
    expect(result.outcome).toBe('exited');
    expect(result.exit_code).not.toBe(0);
  }, 120_000);

  it('Non-zero exit: exit 3 → exited 3', async () => {
    expect(await runner.run(spec(root(), 'exit 3'))).toEqual({ outcome: 'exited', exit_code: 3 });
  }, 120_000);

  it('Timeout: podman stop -t 10 ends it as timeout within ~11 s, the container gone', async () => {
    const s = spec(root(), 'sleep 30', { timeoutMs: 1000 });
    const started = Date.now();
    expect(await runner.run(s)).toEqual({ outcome: 'timeout', exit_code: null });
    expect(Date.now() - started).toBeLessThan(16_000);
    expect(execFileSync('podman', ['ps', '--all', '--quiet', '--filter', `name=${containerName(s.stepRunId)}`], { encoding: 'utf8' }).trim()).toBe('');
  }, 60_000);

  it('removeOrphans removes the instance’s labelled containers', async () => {
    const s = spec(root(), 'sleep 30');
    const controller = new AbortController();
    const run = runner.run(s, controller.signal);
    const end = Date.now() + 30_000;
    while (execFileSync('podman', ['ps', '--quiet', '--filter', `label=${INSTANCE_LABEL}=${instance}`], { encoding: 'utf8' }).trim() === '') {
      if (Date.now() > end) throw new Error('container never started');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await runner.removeOrphans()).toBe(1);
    expect((await run).outcome).toBe('exited');
    expect(await runner.removeOrphans()).toBe(0);
  }, 90_000);
});
