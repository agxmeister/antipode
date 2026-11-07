import { once } from 'node:events';
import { renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pino, type Logger, type LevelWithSilent } from 'pino';
import pinoRoll, { type RollStream } from 'pino-roll';

export type { Logger } from 'pino';

/** Size at which `logs/antipod.log` rolls to a new numbered file. */
export const LOG_ROTATE_SIZE = '10m';
/** Rolled files kept in addition to the current one. */
export const LOG_KEEP_FILES = 9;

export interface LogContext {
  project_id?: string | undefined;
  task_id?: string | undefined;
  stage_id?: string | undefined;
}

export interface AppLogger {
  logger: Logger;
  /** Flushes and closes the file stream. */
  close(): Promise<void>;
}

/**
 * Points `<logs>/antipod.log` at the file pino-roll is currently writing (`antipod.<n>.log`),
 * replacing the link atomically.
 */
function linkCurrent(linkPath: string, target: string): void {
  const temp = `${linkPath}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  symlinkSync(basename(target), temp);
  renameSync(temp, linkPath);
}

/**
 * pino writing through pino-roll, size-rotated (AD-23). pino-roll numbers its files
 * (`antipod.1.log`, `antipod.2.log`, …); `logPath` is kept as a symlink to the current one.
 */
export async function createLogger(
  logPath: string,
  level: LevelWithSilent = 'info',
  rotateSize: string | number = LOG_ROTATE_SIZE,
): Promise<AppLogger> {
  const base = join(dirname(logPath), basename(logPath, '.log'));
  const stream: RollStream = await pinoRoll({
    file: base,
    extension: '.log',
    size: rotateSize,
    limit: { count: LOG_KEEP_FILES },
    mkdir: true,
  });
  // SonicBoom opens the file asynchronously; `file` is set once it is open.
  if (stream.file === null) {
    await once(stream, 'ready');
  }
  const relink = (): void => {
    if (stream.file === null) {
      return;
    }
    try {
      linkCurrent(logPath, stream.file);
    } catch (error) {
      process.stderr.write(`antipod: cannot link ${logPath} to ${stream.file}: ${String(error)}\n`);
    }
  };
  // A write or rotation failure must never become an uncaught exception that kills the daemon.
  stream.on('error', (error: unknown) => {
    process.stderr.write(`antipod: log stream error: ${String(error)}\n`);
  });
  relink();
  stream.on('ready', relink);

  const logger = pino({ level, base: { pid: process.pid }, timestamp: pino.stdTimeFunctions.isoTime }, stream);

  let closed: Promise<void> | undefined;
  return {
    logger,
    close() {
      closed ??= new Promise<void>((resolveClose) => {
        stream.off('ready', relink);
        stream.once('close', () => resolveClose());
        stream.end();
      });
      return closed;
    },
  };
}

/** A child logger carrying `project_id`, `task_id` and `stage_id` when known (spine Logging convention). */
export function withContext(logger: Logger, context: LogContext): Logger {
  const bindings: Record<string, string> = {};
  for (const key of ['project_id', 'task_id', 'stage_id'] as const) {
    const value = context[key];
    if (value !== undefined) {
      bindings[key] = value;
    }
  }
  return logger.child(bindings);
}
