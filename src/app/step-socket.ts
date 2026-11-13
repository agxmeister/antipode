import { chmodSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { silentLog, type Log } from '../core/ports/log.ts';
import type { StepOutcome } from '../core/domain/step.ts';
import type { StepRequest, StepRunResult } from './steps.ts';

/** The socket file under `$ANTIPOD_HOME/run/` (AD-6). */
export const SOCKET_FILE = 'antipod.sock';
/** A request line longer than this is refused. */
const MAX_REQUEST_BYTES = 64 * 1024;

/** One request: newline-terminated JSON. */
export interface StepSocketRequest {
  stage_id: string;
  step: string;
}

/** One response: newline-terminated JSON. */
export type StepSocketResponse = { outcome: StepOutcome; exit_code: number | null; log: string; out: string } | { refused: string };

export interface StepSocketOptions {
  path: string;
  steps: { run(request: StepRequest): Promise<StepRunResult> };
  log?: Log;
}

export interface StepSocket {
  /** Stops accepting, aborts the steps in flight and waits for them, then removes the socket file. Idempotent. */
  close(): Promise<void>;
}

function parseRequest(line: string): StepSocketRequest | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (value === null || typeof value !== 'object') return undefined;
    const { stage_id: stageId, step } = value as Record<string, unknown>;
    if (typeof stageId !== 'string' || stageId === '' || typeof step !== 'string' || step === '') return undefined;
    return { stage_id: stageId, step };
  } catch {
    return undefined;
  }
}

/**
 * The daemon end of `antipod step` (AD-6): a Unix socket (mode 600) taking one request per
 * connection and answering when the step ends. A connection that drops before the answer stops its step.
 */
export async function startStepSocket(options: StepSocketOptions): Promise<StepSocket> {
  const log = options.log ?? silentLog;
  const inFlight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();

  const handle = (socket: Socket): void => {
    let buffer = '';
    let started = false;
    let answered = false;
    const controller = new AbortController();
    const reply = (response: StepSocketResponse): void => {
      answered = true;
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (started && !answered) controller.abort();
    });
    socket.on('data', (chunk: string) => {
      if (started) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        if (buffer.length > MAX_REQUEST_BYTES) {
          started = true;
          reply({ refused: 'request too long' });
        }
        return;
      }
      started = true;
      const request = parseRequest(buffer.slice(0, newline));
      if (request === undefined) {
        reply({ refused: 'bad request' });
        return;
      }
      controllers.add(controller);
      const job = options.steps
        .run({ stageId: request.stage_id, step: request.step, signal: controller.signal })
        .then(
          (result) => reply(result.ok ? { outcome: result.outcome, exit_code: result.exit_code, log: result.log, out: result.out } : { refused: result.refused }),
          (error: unknown) => {
            log.error({ event: 'step_request_failed', stage_id: request.stage_id, step: request.step, error: String(error) }, 'step_request_failed');
            reply({ refused: 'internal error' });
          },
        )
        .finally(() => {
          controllers.delete(controller);
          inFlight.delete(job);
        });
      inFlight.add(job);
    });
  };

  // A socket file left by a crashed daemon would make listen fail; only one daemon runs per home (pid lock).
  rmSync(options.path, { force: true });
  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(options.path, 0o600);
  log.debug({ event: 'step_socket_listening', path: options.path }, 'step_socket_listening');

  let closed: Promise<void> | undefined;
  return {
    close() {
      closed ??= (async () => {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const controller of controllers) controller.abort();
        await Promise.allSettled([...inFlight]);
        await stopped;
        rmSync(options.path, { force: true });
      })();
      return closed;
    },
  };
}

/** Exit codes of `antipod step` besides the step's own. */
export const EXIT_REFUSED = 2;
export const EXIT_CAPABILITY_BUSY = 75;
export const EXIT_TIMEOUT = 124;
export const DAEMON_NOT_RUNNING = 'daemon not running';

export interface StepClientResult {
  code: number;
  /** Lines for stdout. */
  out: string[];
  /** Lines for stderr. */
  err: string[];
}

/**
 * The `antipod step <name>` client (AD-6): sends `{stage_id, step}`, blocks until the daemon answers,
 * prints the log and out paths and exits with the step's code (`capability_busy` 75, `timeout` 124,
 * a refusal or no daemon 2).
 */
export function requestStep(path: string, request: StepSocketRequest): Promise<StepClientResult> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const done = (result: StepClientResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const down = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
      done({ code: EXIT_REFUSED, out: [], err: [down ? DAEMON_NOT_RUNNING : `cannot reach the daemon: ${error.message}`] });
    });
    socket.on('close', () => {
      const line = buffer.split('\n')[0] ?? '';
      let response: StepSocketResponse;
      try {
        response = JSON.parse(line) as StepSocketResponse;
      } catch {
        done({ code: EXIT_REFUSED, out: [], err: ['the daemon closed the connection without an answer'] });
        return;
      }
      if ('refused' in response) {
        done({ code: EXIT_REFUSED, out: [], err: [response.refused] });
        return;
      }
      const out = [`log: ${response.log}`, `out: ${response.out}`];
      if (response.outcome === 'capability_busy') {
        done({ code: EXIT_CAPABILITY_BUSY, out, err: ['capability busy'] });
      } else if (response.outcome === 'timeout') {
        done({ code: EXIT_TIMEOUT, out, err: ['step timed out'] });
      } else {
        done({ code: response.exit_code ?? 1, out, err: [] });
      }
    });
  });
}
