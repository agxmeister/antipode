import type { StepOutcome } from '../domain/step.ts';

/** A directory bind-mounted into a container step at the same absolute path (AD-7). */
export interface StepMount {
  path: string;
  readOnly: boolean;
}

/**
 * Everything a Runner needs to execute one step under the one step contract (AD-7). The app
 * resolves the Recipe step, prepares the directories and picks the env; a Runner only spawns.
 */
export interface StepSpec {
  /** The `step_runs` id; names `data/steps/<id>/` and the container `antipod-<id>`. */
  stepRunId: string;
  taskId: string;
  /** Run as `sh -c <cmd>`. */
  cmd: string;
  /** Container steps: the image. */
  image?: string;
  /** Host steps: the capability name, resolved by the host Runner through `config.capabilities` (AD-19). */
  capability?: string;
  /** Host steps: whether the capability is leased for the run (AD-7). */
  exclusive?: boolean;
  /** The Task worktree. */
  cwd: string;
  /** Exactly the step's named secrets plus `ANTIPOD_OUT`, `ANTIPOD_DATA`, `ANTIPOD_PRIOR`, `ANTIPOD_TASK`. */
  env: Readonly<Record<string, string>>;
  /** Container steps: the only bind mounts. */
  mounts: readonly StepMount[];
  /** stdout and stderr are appended here. */
  logPath: string;
  timeoutMs: number;
}

/**
 * `exit_code` is the command's exit status; null when it ended by a signal (a timeout, or the run
 * was aborted). `capability_busy` spawns nothing.
 */
export interface StepResult {
  outcome: StepOutcome;
  exit_code: number | null;
}

/** Runs one Recipe step (AD-7); implemented by `adapters/podman` and `adapters/host`. */
export interface StepRunner {
  /** Why this Runner cannot run a step naming `capability` on this host, or undefined when it can. Spawns nothing. */
  refusal(step: { capability?: string | undefined }): string | undefined;
  /**
   * Runs the step to its end. Aborting `signal` stops it the way a timeout does and resolves with
   * `exit_code` null. Rejects only when the step could not be started.
   */
  run(spec: StepSpec, signal?: AbortSignal): Promise<StepResult>;
}
