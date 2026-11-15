import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { StageUsage } from '../../core/domain/stage.ts';
import type { AgentRunner, AgentRunSpec, StageObservation, StageRun } from '../../core/ports/agent-runner.ts';
import type { Clock } from '../../core/ports/clock.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';

/** SIGINT first, then SIGTERM after this long (AD-4). */
export const SIGTERM_GRACE_MS = 30_000;
/** How much of the agent's stderr is kept for the failure detail. */
const STDERR_TAIL = 4_000;

export interface ClaudeCliRunnerOptions {
  /** The `claude` executable, looked up on the Stage env's `PATH`; `claude` by default. */
  claude?: string;
  clock: Clock;
  /** Defaults to `SIGTERM_GRACE_MS`; tests shorten it. */
  killGraceMs?: number;
  log?: Log;
}

/**
 * The exact argv of one Stage launch (AD-4 as amended 2026-11-15). No other flag set exists; the
 * prompt body goes to stdin.
 */
export function claudeArgs(spec: AgentRunSpec): string[] {
  const schema = z.toJSONSchema(spec.outputSchema, { target: 'draft-7' });
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(schema),
    '--permission-prompts',
    'none',
    '--settings',
    spec.settingsPath,
    // An empty list: no user, project or local settings file loads; only --settings applies (AD-6).
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    spec.mcpConfigPath,
    '--permission-mode',
    spec.permissionMode,
    '--append-system-prompt-file',
    spec.systemPromptPath,
    '--max-turns',
    String(spec.maxTurns),
    ...(spec.auth === 'api-key' ? ['--bare'] : []),
  ];
}

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

/** Tokens, cost and duration of a `result` message (AD-4); fields it lacks are null. */
export function usageOf(result: Record<string, unknown>): StageUsage {
  const usage = (typeof result['usage'] === 'object' && result['usage'] !== null ? result['usage'] : {}) as Record<string, unknown>;
  const cost = result['total_cost_usd'];
  return {
    input_tokens: count(usage['input_tokens']),
    output_tokens: count(usage['output_tokens']),
    cache_read_input_tokens: count(usage['cache_read_input_tokens']),
    cache_creation_input_tokens: count(usage['cache_creation_input_tokens']),
    cost_usd: typeof cost === 'number' && cost >= 0 ? cost : null,
    duration_ms: count(result['duration_ms']),
  };
}

/** The newest assistant text in one stream-json message, if it carries any. */
function textOf(message: Record<string, unknown>): string | undefined {
  if (message['type'] !== 'assistant') return undefined;
  const content = (message['message'] as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  return texts.length === 0 ? undefined : texts.join('\n');
}

/** Signals a process group; never throws. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

interface Live {
  startedMs: number;
  lastText: string;
}

/**
 * Decides how a finished attempt ended (AD-4): a timeout first; then the `result` message (max
 * turns, an error, or output that must validate); a process that died without one is `exit`.
 */
export function outcomeOf(spec: Pick<AgentRunSpec, 'outputSchema'>, end: { timedOut: boolean; exitCode: number | null; signal: string | null; result: Record<string, unknown> | undefined; stderr: string }): StageRun {
  const usage = end.result === undefined ? null : usageOf(end.result);
  const result = end.result;
  // A result that arrived is judged even when the process lingered past the deadline.
  if (result === undefined && end.timedOut) {
    return { outcome: 'failed', reason: 'timeout', detail: 'the Stage ran past its timeout', usage };
  }
  if (result === undefined) {
    const how = end.exitCode === null ? `signal ${end.signal ?? 'unknown'}` : `exit code ${end.exitCode}`;
    const stderr = end.stderr.trim();
    return { outcome: 'failed', reason: 'exit', detail: `claude ended with ${how} and no result${stderr === '' ? '' : `: ${stderr.slice(-500)}`}`, usage };
  }
  const subtype = result['subtype'];
  if (subtype === 'error_max_turns') {
    return { outcome: 'failed', reason: 'max_turns', detail: 'the Stage used all its turns', usage };
  }
  if (subtype === 'error_max_structured_output_retries') {
    return { outcome: 'failed', reason: 'invalid_output', detail: 'claude could not produce output matching the schema', usage };
  }
  if (subtype !== 'success' || result['is_error'] === true) {
    return { outcome: 'failed', reason: 'exit', detail: `claude reported ${String(subtype)}`, usage };
  }
  if (!('structured_output' in result)) {
    return { outcome: 'failed', reason: 'invalid_output', detail: 'the result carries no structured_output', usage };
  }
  const parsed = spec.outputSchema.safeParse(result['structured_output']);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return { outcome: 'failed', reason: 'invalid_output', detail: `output does not validate: ${where}: ${issue?.message ?? 'invalid'}`, usage };
  }
  return { outcome: 'output', output: parsed.data, usage };
}

/**
 * The `AgentRunner` (AD-4): one `claude -p` per Stage attempt, in its own process group, with only
 * the env it is given. The stream-json output is appended to the transcript and read line by line
 * for `observe` and the final `result`. Timeout and abort send SIGINT, then SIGTERM after the grace.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly #claude: string;
  readonly #clock: Clock;
  readonly #graceMs: number;
  readonly #log: Log;
  readonly #live = new Map<string, Live>();

  constructor(options: ClaudeCliRunnerOptions) {
    this.#claude = options.claude ?? 'claude';
    this.#clock = options.clock;
    this.#graceMs = options.killGraceMs ?? SIGTERM_GRACE_MS;
    this.#log = options.log ?? silentLog;
  }

  observe(stageId: string): StageObservation | undefined {
    const live = this.#live.get(stageId);
    return live === undefined ? undefined : { last_text: live.lastText, elapsed_ms: this.#clock.monotonicMs() - live.startedMs };
  }

  run(spec: AgentRunSpec, signal?: AbortSignal): Promise<StageRun> {
    try {
      return this.#run(spec, signal);
    } catch (error) {
      // A synchronous throw (mkdir, spawn, schema export) is a launch failure like any other.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #run(spec: AgentRunSpec, signal?: AbortSignal): Promise<StageRun> {
    const args = claudeArgs(spec);
    mkdirSync(dirname(spec.transcriptPath), { recursive: true, mode: 0o700 });
    return new Promise<StageRun>((resolve, reject) => {
      const child = spawn(this.#claude, args, { cwd: spec.cwd, env: { ...spec.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const transcript = createWriteStream(spec.transcriptPath, { flags: 'a', mode: 0o600 });
      const fields = { stage_id: spec.stageId };
      // A full or unwritable disk loses the transcript, never the daemon or the Stage.
      transcript.on('error', (error) => {
        this.#log.error({ event: 'stage_transcript_error', ...fields, error: error.message }, 'stage_transcript_error');
      });
      const decoder = new StringDecoder('utf8');
      let spawned = false;
      let timedOut = false;
      let result: Record<string, unknown> | undefined;
      let stderr = '';
      let pending = '';
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let stopping = false;

      const stop = (why: 'timeout' | 'aborted'): void => {
        if (stopping || child.pid === undefined) return;
        stopping = true;
        if (why === 'timeout') timedOut = true;
        this.#log.info({ event: 'stage_stopping', ...fields, why }, 'stage_stopping');
        const pid = child.pid;
        killGroup(pid, 'SIGINT');
        graceTimer = setTimeout(() => {
          this.#log.warn({ event: 'stage_sigterm', ...fields }, 'stage_sigterm');
          killGroup(pid, 'SIGTERM');
        }, this.#graceMs);
      };
      const timer = setTimeout(() => stop('timeout'), spec.timeoutMs);
      const onAbort = (): void => stop('aborted');

      const line = (text: string): void => {
        if (text.trim() === '') return;
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof message !== 'object' || message === null) return;
        const record = message as Record<string, unknown>;
        if (record['type'] === 'result') {
          result = record;
          return;
        }
        const said = textOf(record);
        const live = this.#live.get(spec.stageId);
        if (said !== undefined && live !== undefined) live.lastText = said;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (!transcript.destroyed) transcript.write(chunk);
        // A multi-byte character split across chunks is held back until its last byte arrives.
        pending += decoder.write(chunk);
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          line(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      // A process that exits before reading its prompt closes stdin under us; that is not a launch error.
      child.stdin.on('error', () => {});

      const cleanup = (): void => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        signal?.removeEventListener('abort', onAbort);
        this.#live.delete(spec.stageId);
      };

      child.once('spawn', () => {
        spawned = true;
        this.#live.set(spec.stageId, { startedMs: this.#clock.monotonicMs(), lastText: '' });
        this.#log.info({ event: 'stage_spawned', ...fields, pid: child.pid }, 'stage_spawned');
        child.stdin.end(spec.prompt);
        if (signal?.aborted === true) stop('aborted');
        else signal?.addEventListener('abort', onAbort, { once: true });
        spec.onStarted?.();
      });
      child.once('error', (error) => {
        if (spawned) {
          this.#log.warn({ event: 'stage_process_error', ...fields, error: error.message }, 'stage_process_error');
          return;
        }
        cleanup();
        transcript.end();
        reject(error);
      });
      child.once('close', (exitCode, exitSignal) => {
        if (!spawned) return;
        pending += decoder.end();
        if (pending !== '') line(pending);
        if (stopping && child.pid !== undefined) {
          // Whatever of the group outlived its leader goes with it.
          killGroup(child.pid, 'SIGTERM');
        }
        cleanup();
        const settle = (): void => resolve(outcomeOf(spec, { timedOut, exitCode, signal: exitSignal, result, stderr }));
        // A failed transcript never holds the result back.
        if (transcript.destroyed) settle();
        else transcript.end(settle);
      });
    });
  }
}
