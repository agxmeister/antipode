import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityLease } from '../../core/domain/step.ts';
import type { Clock } from '../../core/ports/clock.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';
import type { StepResult, StepRunner, StepSpec } from '../../core/ports/step-runner.ts';
import type { Store } from '../../core/ports/store.ts';

/** SIGTERM to the step's process group, then SIGKILL after this long (AD-7 timeout). */
export const KILL_GRACE_MS = 10_000;
/**
 * The file in `data/steps/<step_run_id>/` naming the step's process group for boot recovery (AD-18):
 * `<pid> <start>`, the leader's pid and its start time in epoch seconds, so a reused pid is never killed.
 */
export const PID_FILE = 'pid';
/** `ps -o etime` has one-second resolution; start times this close are the same process. */
const START_TOLERANCE_S = 2;
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
      writePidFile(pidFile, pid, this.#log);
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
 * Boot recovery (AD-18): `killSteps` for the step run of every lease. Returns how many groups were
 * killed; groups that are no longer the step's (see `killSteps`) are spared.
 */
export function killLeased(leases: readonly CapabilityLease[], stepsDir: string, log: Log = silentLog): number {
  return killSteps(
    leases.map((lease) => lease.step_run_id),
    stepsDir,
    log,
  );
}

/** One row of the process table: pid, process group and start time in epoch seconds. */
export interface ProcessEntry {
  pid: number;
  pgid: number;
  start: number;
}

/** How long one `ps` call may take before it is killed. */
const PS_TIMEOUT_MS = 10_000;

/** `[[dd-]hh:]mm:ss` (`ps -o etime`) in seconds; NaN when malformed. */
export function parseElapsed(text: string): number {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) return Number.NaN;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * The host's processes (`ps -A`), or only `pid` when given, with start times derived from their
 * elapsed time. Pid 1 starts at boot, so its entry also dates the boot.
 */
export function readProcessTable(pid?: number, nowMs: number = Date.now()): ProcessEntry[] {
  const select = pid === undefined ? ['-A'] : ['-p', String(pid)];
  let text: string;
  try {
    text = execFileSync('ps', [...select, '-o', 'pid=,pgid=,etime='], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/bin:/usr/bin', LC_ALL: 'C' },
      timeout: PS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    // `ps -p` exits 1 when the pid is gone: an empty table, not a failure.
    if (pid !== undefined && (error as { status?: number }).status === 1) return [];
    throw error;
  }
  const now = Math.floor(nowMs / 1000);
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const [pidText, pgidText, etime] = line.trim().split(/\s+/);
    if (pidText === undefined || pgidText === undefined || etime === undefined) continue;
    const elapsed = parseElapsed(etime);
    if (Number.isNaN(elapsed)) continue;
    entries.push({ pid: Number(pidText), pgid: Number(pgidText), start: now - elapsed });
  }
  return entries;
}

/**
 * Writes `<pid> <start>` for a just-spawned step leader. Without a readable start time only the pid
 * is written, and recovery will not kill that group (no identity, no kill).
 */
export function writePidFile(file: string, pid: number, log: Log = silentLog, table: (pid: number) => ProcessEntry[] = readProcessTable): void {
  let start: number | undefined;
  try {
    start = table(pid).find((entry) => entry.pid === pid)?.start;
  } catch (error) {
    log.warn({ event: 'step_start_time_unknown', pid, error: String(error) }, 'step_start_time_unknown');
  }
  writeFileSync(file, start === undefined ? `${pid}\n` : `${pid} ${start}\n`, { mode: 0o600 });
}

/**
 * Why process group `pid` is no longer the step recorded with leader start `start`, or undefined
 * when it is: its leader is alive with that start time, or the leader is gone and every surviving
 * member started no earlier (a pid is not reused while a process group with that id exists). A step
 * recorded before the host booted (pid 1's start) is never alive. `gone` means nothing is left to kill.
 */
export function stepGroupMismatch(pid: number, start: number, table: readonly ProcessEntry[]): 'gone' | 'host restarted' | 'pid reused' | undefined {
  const leader = table.find((entry) => entry.pid === pid);
  const members = table.filter((entry) => entry.pgid === pid);
  if (leader === undefined && members.length === 0) return 'gone';
  const init = table.find((entry) => entry.pid === 1);
  if (init !== undefined && start < init.start - START_TOLERANCE_S) return 'host restarted';
  if (leader !== undefined) return Math.abs(leader.start - start) <= START_TOLERANCE_S ? undefined : 'pid reused';
  return members.every((entry) => entry.start >= start - START_TOLERANCE_S) ? undefined : 'pid reused';
}

/**
 * SIGKILLs the process group named by the pid file of each step run (deduplicated) under `stepsDir`,
 * only when that group is still the step's (`stepGroupMismatch`); returns how many groups were killed.
 * Missing pid files and groups already gone are skipped; a pid file without a start time, a group that
 * is no longer the step's, or a failed `ps` is skipped and logged. Never throws.
 */
export function killSteps(
  stepRunIds: readonly string[],
  stepsDir: string,
  log: Log = silentLog,
  table: () => ProcessEntry[] = () => readProcessTable(),
): number {
  const recorded: Array<{ stepRunId: string; pid: number; start: number }> = [];
  for (const stepRunId of new Set(stepRunIds)) {
    let text: string;
    try {
      text = readFileSync(join(stepsDir, stepRunId, PID_FILE), 'utf8');
    } catch {
      continue;
    }
    const [pidText, startText] = text.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const start = startText === undefined ? Number.NaN : Number(startText);
    if (!Number.isFinite(start)) {
      log.warn({ event: 'host_step_kill_skipped', step_run_id: stepRunId, pid, why: 'no start time' }, 'host_step_kill_skipped');
      continue;
    }
    recorded.push({ stepRunId, pid, start });
  }
  if (recorded.length === 0) return 0;
  let processes: ProcessEntry[];
  try {
    processes = table();
  } catch (error) {
    for (const { stepRunId, pid } of recorded) {
      log.warn({ event: 'host_step_kill_skipped', step_run_id: stepRunId, pid, why: `ps failed: ${String(error)}` }, 'host_step_kill_skipped');
    }
    return 0;
  }
  let killed = 0;
  for (const { stepRunId, pid, start } of recorded) {
    const mismatch = stepGroupMismatch(pid, start, processes);
    if (mismatch === 'gone') continue;
    if (mismatch !== undefined) {
      const observed = processes.filter((entry) => entry.pid === pid || entry.pgid === pid).map((entry) => entry.start);
      log.warn({ event: 'host_step_kill_skipped', step_run_id: stepRunId, pid, why: mismatch, recorded_start: start, observed_starts: observed }, 'host_step_kill_skipped');
      continue;
    }
    if (killGroup(pid, 'SIGKILL', log)) {
      killed++;
      log.info({ event: 'host_step_killed', step_run_id: stepRunId, pid }, 'host_step_killed');
    }
  }
  return killed;
}
