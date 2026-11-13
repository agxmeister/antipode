import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityLease } from '../../core/domain/step.ts';
import type { Clock } from '../../core/ports/clock.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';
import type { StepResult, StepRunner, StepSpec } from '../../core/ports/step-runner.ts';
import type { Store } from '../../core/ports/store.ts';

/** SIGTERM to the step's process group, then SIGKILL after this long (AD-7 timeout). */
export const KILL_GRACE_MS = 10_000;
/** The file in `data/steps/<step_run_id>/` naming the step's process group, for boot recovery (AD-18). */
export const PID_FILE = 'pid';
/** The variable through which a host step reaches its capability command. */
export const CAPABILITY_ENV = 'ANTIPOD_CAPABILITY';
/** The only daemon variables a host step inherits besides the contract. */
export const HOST_ENV_PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export interface HostRunnerOptions {
  /** Leases are taken and released through the Store, in one transaction each (AD-7). */
  leases: Pick<Store, 'acquireLease' | 'releaseLease'>;
  /** `data/steps/`: the pid file goes to `<stepsDir>/<step_run_id>/pid`. */
  stepsDir: string;
  /** `config.capabilities`: capability name → command on this host (AD-19); read on every call so SIGHUP applies. */
  capabilities: () => Readonly<Record<string, string>>;
  /** `secrets/antipod.env`, for `$NAME` references in capability commands (AD-7, AD-14). */
  instanceSecrets: () => Readonly<Record<string, string>>;
  clock: Clock;
  /** Where `PATH`, `HOME`, `LANG` and `TMPDIR` come from; `process.env` by default. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Defaults to `KILL_GRACE_MS`; tests shorten it. */
  killGraceMs?: number;
  log?: Log;
}

type Resolution = { ok: true; command: string } | { ok: false; reason: string };

/** Signals a process group; never throws. False when it is gone (ESRCH) or cannot be signalled, which is logged. */
function killGroup(pid: number, signal: NodeJS.Signals, log: Log = silentLog): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      log.warn({ event: 'step_kill_failed', pid, signal, error: code ?? String(error) }, 'step_kill_failed');
    }
    return false;
  }
}

/**
 * The host `StepRunner` (AD-7, AD-19): runs `sh -c <cmd>` in the worktree as the leader of its own
 * process group, with only the contract env, the named secrets, `PATH`, `HOME`, `LANG`, `TMPDIR` and
 * `ANTIPOD_CAPABILITY`. The only module besides `app/` that reads the capability map.
 */
export class HostRunner implements StepRunner {
  readonly #options: HostRunnerOptions;
  readonly #graceMs: number;
  readonly #log: Log;

  constructor(options: HostRunnerOptions) {
    this.#options = options;
    this.#graceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.#log = options.log ?? silentLog;
  }

  /** The capability's command with `$NAME` / `${NAME}` expanded from `secrets/antipod.env`. */
  resolveCapability(name: string): Resolution {
    const command = Object.hasOwn(this.#options.capabilities(), name) ? this.#options.capabilities()[name] : undefined;
    if (command === undefined) {
      return { ok: false, reason: `capability ${name} is not configured on this host` };
    }
    const secrets = this.#options.instanceSecrets();
    let missing: string | undefined;
    const expanded = command.replace(REFERENCE, (match, braced: string | undefined, bare: string | undefined) => {
      const key = braced ?? bare ?? '';
      if (Object.hasOwn(secrets, key)) return secrets[key]!;
      // The step's own PATH, HOME, LANG and TMPDIR: left for its shell to expand.
      if ((HOST_ENV_PASSTHROUGH as readonly string[]).includes(key)) return match;
      missing ??= key;
      return match;
    });
    if (missing !== undefined) {
      return { ok: false, reason: `capability ${name} references ${missing}, which is not set in secrets/antipod.env` };
    }
    return { ok: true, command: expanded };
  }

  refusal(step: { capability?: string | undefined }): string | undefined {
    if (step.capability === undefined) return 'a host step needs a capability';
    const resolution = this.resolveCapability(step.capability);
    return resolution.ok ? undefined : resolution.reason;
  }

  async run(spec: StepSpec, signal?: AbortSignal): Promise<StepResult> {
    if (spec.capability === undefined) {
      throw new Error('a host step needs a capability');
    }
    const resolution = this.resolveCapability(spec.capability);
    if (!resolution.ok) {
      throw new Error(resolution.reason);
    }
    if (spec.exclusive === true) {
      const lease: CapabilityLease = {
        capability: spec.capability,
        task_id: spec.taskId,
        step_run_id: spec.stepRunId,
        acquired_at: this.#options.clock.now().toISOString(),
      };
      if (!this.#options.leases.acquireLease(lease)) {
        this.#log.info({ event: 'capability_busy', task_id: spec.taskId, step_run_id: spec.stepRunId, capability: spec.capability }, 'capability_busy');
        return { outcome: 'capability_busy', exit_code: null };
      }
      try {
        return await this.#spawn(spec, resolution.command, signal);
      } finally {
        this.#options.leases.releaseLease(spec.stepRunId);
      }
    }
    return this.#spawn(spec, resolution.command, signal);
  }

  #env(spec: StepSpec, command: string): Record<string, string> {
    const base = this.#options.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const key of HOST_ENV_PASSTHROUGH) {
      const value = base[key];
      if (value !== undefined) env[key] = value;
    }
    return { ...env, ...spec.env, [CAPABILITY_ENV]: command };
  }

  #spawn(spec: StepSpec, command: string, signal: AbortSignal | undefined): Promise<StepResult> {
    if (signal?.aborted === true) {
      return Promise.resolve({ outcome: 'exited', exit_code: null });
    }
    const stepDir = join(this.#options.stepsDir, spec.stepRunId);
    const pidFile = join(stepDir, PID_FILE);
    mkdirSync(stepDir, { recursive: true, mode: 0o700 });
    const fd = openSync(spec.logPath, 'a');
    let child;
    try {
      child = spawn('sh', ['-c', spec.cmd], { cwd: spec.cwd, env: this.#env(spec, command), detached: true, stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    const pid = child.pid;
    if (pid !== undefined) {
      writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
    }

    return new Promise<StepResult>((resolve, reject) => {
      let stopped: 'timeout' | 'aborted' | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (why: 'timeout' | 'aborted'): void => {
        if (stopped !== undefined || pid === undefined) return;
        stopped = why;
        this.#log.info({ event: 'step_stopping', task_id: spec.taskId, step_run_id: spec.stepRunId, why }, 'step_stopping');
        killGroup(pid, 'SIGTERM', this.#log);
        killTimer = setTimeout(() => killGroup(pid, 'SIGKILL', this.#log), this.#graceMs);
      };
      const timer = setTimeout(() => stop('timeout'), spec.timeoutMs);
      const onAbort = (): void => stop('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        rmSync(pidFile, { force: true });
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code) => {
        if (stopped !== undefined && pid !== undefined) {
          // Whatever of the group outlived its leader goes with it.
          killGroup(pid, 'SIGKILL', this.#log);
        }
        cleanup();
        if (stopped === 'timeout') resolve({ outcome: 'timeout', exit_code: null });
        else if (stopped === 'aborted') resolve({ outcome: 'exited', exit_code: null });
        else resolve({ outcome: 'exited', exit_code: code });
      });
    });
  }
}

/**
 * Boot recovery (AD-18): SIGKILLs the process group of every leased step, read from its pid file
 * under `stepsDir`. Returns how many groups were still alive. Missing pid files are skipped.
 */
export function killLeased(leases: readonly CapabilityLease[], stepsDir: string, log: Log = silentLog): number {
  return killSteps(
    leases.map((lease) => lease.step_run_id),
    stepsDir,
    log,
  );
}

/**
 * SIGKILLs the process group named by the pid file of each step run (deduplicated) under `stepsDir`;
 * returns how many groups were still alive. Missing pid files are skipped; never throws.
 */
export function killSteps(stepRunIds: readonly string[], stepsDir: string, log: Log = silentLog): number {
  let killed = 0;
  for (const stepRunId of new Set(stepRunIds)) {
    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(join(stepsDir, stepRunId, PID_FILE), 'utf8').trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (killGroup(pid, 'SIGKILL', log)) {
      killed++;
      log.info({ event: 'host_step_killed', step_run_id: stepRunId, pid }, 'host_step_killed');
    }
  }
  return killed;
}
