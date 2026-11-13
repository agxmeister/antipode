import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { silentLog, type Log } from '../../core/ports/log.ts';
import type { StepResult, StepRunner, StepSpec } from '../../core/ports/step-runner.ts';

/** The label every step container carries, valued with the instance (`ANTIPOD_HOME`), so recovery finds its own (AD-18). */
export const INSTANCE_LABEL = 'antipod.instance';
export const STEP_RUN_LABEL = 'antipod.step_run';
/** `podman stop -t` seconds on a timeout (AD-7). */
export const STOP_GRACE_S = 10;
/** How long a `podman stop`, `ps` or `rm` call may take before it is killed. */
const PODMAN_CALL_TIMEOUT_MS = 60_000;

export interface PodmanRunnerOptions {
  /** The instance this daemon is: the value of the `antipod.instance` label. */
  instance: string;
  /** The podman binary; `podman` on PATH by default. */
  podman?: string;
  /** The environment podman itself runs with (its connection settings); `process.env` by default. Never reaches the container. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Defaults to `STOP_GRACE_S`; tests shorten it. */
  stopGraceS?: number;
  log?: Log;
}

/** The container a step run executes in. */
export function containerName(stepRunId: string): string {
  return `antipod-${stepRunId}`;
}

/**
 * The `podman run` arguments of one step (AD-7): removed on exit, named and labelled, cwd the
 * worktree, the given mounts at the same absolute paths and nothing else, and the contract env
 * passed by name (`-e NAME`), so no value appears in an argument list.
 */
export function podmanRunArgs(spec: StepSpec, instance: string): string[] {
  if (spec.image === undefined) {
    throw new Error('a container step needs an image');
  }
  return [
    'run',
    '--rm',
    '--name',
    containerName(spec.stepRunId),
    '--label',
    `${INSTANCE_LABEL}=${instance}`,
    '--label',
    `${STEP_RUN_LABEL}=${spec.stepRunId}`,
    '--workdir',
    spec.cwd,
    ...spec.mounts.flatMap((mount) => ['--volume', `${mount.path}:${mount.path}:${mount.readOnly ? 'ro' : 'rw'}`]),
    ...Object.keys(spec.env).flatMap((name) => ['--env', name]),
    spec.image,
    'sh',
    '-c',
    spec.cmd,
  ];
}

/** The container `StepRunner` (AD-7): `podman run --rm` per step, against any image. */
export class PodmanRunner implements StepRunner {
  readonly #instance: string;
  readonly #podman: string;
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #graceS: number;
  readonly #log: Log;

  constructor(options: PodmanRunnerOptions) {
    this.#instance = options.instance;
    this.#podman = options.podman ?? 'podman';
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#graceS = options.stopGraceS ?? STOP_GRACE_S;
    this.#log = options.log ?? silentLog;
  }

  refusal(): string | undefined {
    return undefined;
  }

  run(spec: StepSpec, signal?: AbortSignal): Promise<StepResult> {
    const args = podmanRunArgs(spec, this.#instance);
    if (signal?.aborted === true) {
      return Promise.resolve({ outcome: 'exited', exit_code: null });
    }
    const fd = openSync(spec.logPath, 'a');
    let child;
    try {
      child = spawn(this.#podman, args, { env: { ...this.#baseEnv, ...spec.env }, stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    const name = containerName(spec.stepRunId);

    return new Promise<StepResult>((resolve, reject) => {
      let stopped: 'timeout' | 'aborted' | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (why: 'timeout' | 'aborted'): void => {
        if (stopped !== undefined) return;
        stopped = why;
        this.#log.info({ event: 'step_stopping', task_id: spec.taskId, step_run_id: spec.stepRunId, why }, 'step_stopping');
        void this.#call(['stop', '-t', String(this.#graceS), name]).catch((error: unknown) => {
          this.#log.warn({ event: 'podman_stop_failed', step_run_id: spec.stepRunId, error: String(error) }, 'podman_stop_failed');
        });
        // If podman never stops the container (it was not created yet, or podman hangs), end the client and remove it.
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          void this.#call(['rm', '-f', '-t', '0', name]).catch(() => undefined);
        }, (this.#graceS + 5) * 1000);
      };
      const timer = setTimeout(() => stop('timeout'), spec.timeoutMs);
      const onAbort = (): void => stop('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code) => {
        cleanup();
        if (stopped === 'timeout') resolve({ outcome: 'timeout', exit_code: null });
        else if (stopped === 'aborted') resolve({ outcome: 'exited', exit_code: null });
        else resolve({ outcome: 'exited', exit_code: code });
      });
    });
  }

  /** Boot recovery (AD-18): force-removes every container labelled with `instance`; returns how many. */
  async removeOrphans(instance: string = this.#instance): Promise<number> {
    const ids = (await this.#call(['ps', '--all', '--quiet', '--filter', `label=${INSTANCE_LABEL}=${instance}`]))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (ids.length > 0) {
      await this.#call(['rm', '--force', '--time', '0', ...ids]);
      this.#log.info({ event: 'step_containers_removed', count: ids.length }, 'step_containers_removed');
    }
    return ids.length;
  }

  #call(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.#podman, [...args], { env: this.#baseEnv, encoding: 'utf8', timeout: PODMAN_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`podman ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
