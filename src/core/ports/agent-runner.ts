import type { z } from 'zod';
import type { StageUsage } from '../domain/stage.ts';

/** Who the agent bills (`config.yaml` `agent.auth`): the Owner's login, or `ANTHROPIC_API_KEY` with `--bare` (AD-4). */
export type AgentAuth = 'subscription' | 'api-key';

/** How a Stage attempt failed (AD-4). */
export const STAGE_FAILURE_REASONS = ['timeout', 'exit', 'invalid_output', 'max_turns'] as const;
export type StageFailureReason = (typeof STAGE_FAILURE_REASONS)[number];

/**
 * Everything the `claude-cli` adapter needs to launch one Stage attempt as one `claude -p` (AD-4).
 * The app resolves the Role Config, materializes its files and picks the env; the adapter only spawns.
 */
export interface AgentRunSpec {
  stageId: string;
  /** The Task worktree, or the Project's `_main` checkout for Intake. */
  cwd: string;
  /** The Stage brief, the prompt body; written to the agent's stdin. */
  prompt: string;
  /** `data/stages/<stage_id>.jsonl`; the stream-json output is appended to it. */
  transcriptPath: string;
  /** The Role's output schema: exported as `--json-schema` and used to validate `structured_output`. */
  outputSchema: z.ZodType;
  /** The resolved `permissions.json` (`--settings`). */
  settingsPath: string;
  /** The resolved `mcp.json` (`--mcp-config`). */
  mcpConfigPath: string;
  /** The resolved `prompt.md` (`--append-system-prompt-file`). */
  systemPromptPath: string;
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  auth: AgentAuth;
  /** The whole environment of the agent process; nothing else is inherited. */
  env: Readonly<Record<string, string>>;
  /** Called once the process exists, before any output. */
  onStarted?: () => void;
}

/** How one Stage attempt ended. `usage` is null when no `result` message arrived. */
export type StageRun =
  | { outcome: 'output'; output: unknown; usage: StageUsage | null }
  | { outcome: 'failed'; reason: StageFailureReason; detail: string; usage: StageUsage | null };

/** What a Progress Peek shows of a running Stage (AD-8). */
export interface StageObservation {
  /** The newest assistant text of the live stream; empty before the first one. */
  last_text: string;
  elapsed_ms: number;
}

/** Runs Stages as agent processes (AD-4); implemented by `adapters/claude-cli`. */
export interface AgentRunner {
  /**
   * Runs one Stage attempt to its end. Aborting `signal` stops it the way a timeout does (SIGINT,
   * then SIGTERM after the grace). Rejects only when the process could not be started.
   */
  run(spec: AgentRunSpec, signal?: AbortSignal): Promise<StageRun>;
  /** The live Stage's newest text and elapsed time, or undefined when it is not running here. */
  observe(stageId: string): StageObservation | undefined;
}
