import { migrate } from '../adapters/sqlite/migrate.ts';
import { openDatabase, type SqliteDatabase } from '../adapters/sqlite/db.ts';
import { AntipodError } from '../core/domain/errors.ts';
import { loadConfig, type Config } from './config.ts';
import { ensureHome, resolveHome, type HomePaths } from './home.ts';
import { createLogger, type AppLogger, type Logger } from './logger.ts';

export type StopSignal = 'SIGTERM' | 'SIGINT';

/** The subset of `process` the daemon listens on; tests pass their own emitter. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface Daemon {
  readonly paths: HomePaths;
  readonly logger: Logger;
  readonly db: SqliteDatabase;
  config(): Config;
  /** Re-reads `config.yaml`; keeps the previous config when it is invalid. Returns whether it applied. */
  reload(): boolean;
  /** Closes the database and the log stream. Idempotent. */
  stop(reason: string): Promise<void>;
}

export interface BootOptions {
  env?: NodeJS.ProcessEnv;
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof AntipodError) {
    return { error_code: error.code, error: error.message };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * Boot sequence: resolve and create the home, start the logger, load config, open and migrate
 * the database, log `daemon_started`. Throws (after logging and closing) when any step fails.
 */
export async function bootDaemon(options: BootOptions = {}): Promise<Daemon> {
  const paths = ensureHome(resolveHome(options.env ?? process.env));
  const appLogger: AppLogger = await createLogger(paths.log);
  const { logger } = appLogger;

  let config: Config;
  let db: SqliteDatabase | undefined;
  try {
    config = loadConfig(paths.config);
    logger.level = config.logging.level;
    db = openDatabase(paths.database);
    const result = migrate(db);
    logger.info(
      {
        event: 'daemon_started',
        home: paths.root,
        schema_version: result.to,
        migrations_applied: result.applied,
      },
      'daemon_started',
    );
  } catch (error) {
    logger.fatal({ event: 'daemon_boot_failed', ...errorFields(error) }, 'daemon_boot_failed');
    db?.close();
    await appLogger.close();
    throw error;
  }

  const openDb = db;
  let stopped: Promise<void> | undefined;
  return {
    paths,
    logger,
    db: openDb,
    config: () => config,
    reload() {
      try {
        const next = loadConfig(paths.config);
        config = next;
        logger.level = next.logging.level;
        logger.info({ event: 'config_reloaded' }, 'config_reloaded');
        return true;
      } catch (error) {
        // Log-only in story 1-1; the Owner-visible outbox notice arrives with the outbox.
        logger.error({ event: 'config_reload_failed', ...errorFields(error) }, 'config_reload_failed');
        return false;
      }
    },
    stop(reason) {
      stopped ??= (async () => {
        logger.info({ event: 'daemon_stopped', reason }, 'daemon_stopped');
        openDb.close();
        await appLogger.close();
      })();
      return stopped;
    },
  };
}

export interface RunOptions extends BootOptions {
  signals?: SignalSource;
  /** Where boot failures are reported for a human; defaults to stderr. */
  report?: (line: string) => void;
}

/**
 * Runs the daemon until SIGTERM or SIGINT: reloads config on SIGHUP and resolves the exit code
 * (0 after a clean stop, 1 when boot fails).
 */
export async function runDaemon(options: RunOptions = {}): Promise<number> {
  const signals = options.signals ?? process;
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));

  let daemon: Daemon;
  try {
    daemon = await bootDaemon(options);
  } catch (error) {
    report(`antipod: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  return new Promise<number>((resolveExit) => {
    // Keeps the event loop alive while idle; later stories replace it with real work.
    const keepAlive = setInterval(() => {}, 1 << 30);
    const onHup = (): void => {
      daemon.reload();
    };
    const onStop = (signal: StopSignal) => (): void => {
      signals.off('SIGHUP', onHup);
      signals.off('SIGTERM', onTerm);
      signals.off('SIGINT', onInt);
      clearInterval(keepAlive);
      daemon.stop(signal).then(
        () => resolveExit(0),
        () => resolveExit(1),
      );
    };
    const onTerm = onStop('SIGTERM');
    const onInt = onStop('SIGINT');
    signals.on('SIGHUP', onHup);
    signals.on('SIGTERM', onTerm);
    signals.on('SIGINT', onInt);
  });
}
