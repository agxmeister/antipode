import { migrate } from '../adapters/sqlite/migrate.ts';
import { openDatabase, type SqliteDatabase } from '../adapters/sqlite/db.ts';
import { SqliteStore } from '../adapters/sqlite/store.ts';
import { Coordinator } from '../core/coordinator/coordinator.ts';
import { Deadlines } from '../core/coordinator/deadlines.ts';
import { EffectExecutor } from '../core/coordinator/effects.ts';
import { recover } from '../core/coordinator/recovery.ts';
import { Scheduler } from '../core/coordinator/scheduler.ts';
import { AntipodError } from '../core/domain/errors.ts';
import type { Clock } from '../core/ports/clock.ts';
import type { WindowReader } from '../core/ports/window-reader.ts';
import { systemClock } from './clock.ts';
import { loadConfig, type Config } from './config.ts';
import { ensureHome, resolveHome, type HomePaths } from './home.ts';
import { createLogger, type AppLogger, type Logger } from './logger.ts';
import { acquirePidLock } from './pid-lock.ts';

export type StopSignal = 'SIGTERM' | 'SIGINT';

/** The subset of `process` the daemon listens on; tests pass their own emitter. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** How often deadlines are checked, sleep is detected (AD-18) and the scheduler ticks (AD-11). */
export const DEADLINE_TICK_MS = 1000;

export interface Daemon {
  readonly paths: HomePaths;
  readonly logger: Logger;
  readonly db: SqliteDatabase;
  readonly store: SqliteStore;
  readonly coordinator: Coordinator;
  readonly executor: EffectExecutor;
  readonly deadlines: Deadlines;
  readonly scheduler: Scheduler;
  config(): Config;
  /** Re-reads `config.yaml`; keeps the previous config when it is invalid. Returns whether it applied. */
  reload(): boolean;
  /** Stops the deadline tick, waits for in-flight work, closes the database and the log stream. Idempotent. */
  stop(reason: string): Promise<void>;
  /** One tick as the interval runs it: deadlines, then the scheduler. Resolves when the scheduler tick ends; never rejects. */
  tick(): Promise<void>;
}

export interface BootOptions {
  env?: NodeJS.ProcessEnv;
  /** Time source for the Coordinator, executor and deadlines; tests pass a fake. */
  clock?: Clock;
  /** Usage-window reader; defaults to one that has no reading (the `anthropic-usage` adapter is story 1-16). */
  windowReader?: WindowReader;
}

/** No reading: the usage gate stays open (AD-12 fallback arrives with the estimator). */
const noWindowReader: WindowReader = { read: async () => null };

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
  // Taken before the logger so a refused second daemon writes nothing into the live log.
  const releaseLock = acquirePidLock(paths.pidFile);
  let appLogger: AppLogger;
  try {
    appLogger = await createLogger(paths.log);
  } catch (error) {
    releaseLock();
    throw error;
  }
  const { logger } = appLogger;

  const clock = options.clock ?? systemClock;
  let config: Config;
  let db: SqliteDatabase | undefined;
  let store: SqliteStore;
  let coordinator: Coordinator;
  let executor: EffectExecutor;
  let deadlines: Deadlines;
  let scheduler: Scheduler;
  try {
    config = loadConfig(paths.config);
    logger.level = config.logging.level;
    db = openDatabase(paths.database);
    const result = migrate(db);

    // Composition (AD-1): the core sees only ports; handlers for later stories plug in here.
    store = new SqliteStore(db);
    coordinator = new Coordinator({
      store,
      clock,
      log: logger,
      policy: () => ({ limits: config.limits, roles: config.roles }),
    });
    executor = new EffectExecutor(store, clock, logger);
    executor.register('back_online', (effect) => {
      // The silent Telegram notice is a later handler; for now the gap is on record.
      logger.info({ event: 'back_online', project_id: effect.project_id, gap_ms: effect.gap_ms }, 'back_online');
    });
    executor.register('notify', (effect) => {
      // Telegram templates are later stories; for now the notice is on record.
      logger.info({ event: 'notice', notice_kind: effect.notice_kind, task_id: effect.task_id, project_id: effect.project_id, payload: effect.payload }, 'notice');
    });
    deadlines = new Deadlines(clock, undefined, logger);
    scheduler = new Scheduler({
      store,
      coordinator,
      executor,
      windowReader: options.windowReader ?? noWindowReader,
      clock,
      log: logger,
      policy: () => ({ limits: config.limits, usage: config.usage }),
    });
    // The usage-window launch gate (AD-11); start_stage itself is registered with the claude-cli adapter (story 1-7).
    executor.setGuard(['start_stage'], scheduler.launchGuard);
    const recovery = await recover({ store, coordinator, executor, clock, log: logger });
    // Attached after recovery so nothing drains until recovery has settled the orphaned launches.
    coordinator.onEffectsCommitted(() => executor.notify());

    logger.info(
      {
        event: 'daemon_started',
        home: paths.root,
        schema_version: result.to,
        migrations_applied: result.applied,
        ...recovery,
      },
      'daemon_started',
    );
  } catch (error) {
    logger.fatal({ event: 'daemon_boot_failed', ...errorFields(error) }, 'daemon_boot_failed');
    try {
      db?.close();
    } finally {
      await appLogger.close();
      releaseLock();
    }
    throw error;
  }

  const openDb = db;
  const onTick = (): Promise<void> => {
    try {
      const result = deadlines.tick();
      if (result.sleep !== undefined) {
        const { gapMs } = result.sleep;
        logger.info({ event: 'sleep_detected', gap_ms: gapMs }, 'sleep_detected');
        coordinator.backOnline(gapMs).catch((error: unknown) => {
          logger.error({ event: 'back_online_failed', ...errorFields(error) }, 'back_online_failed');
        });
      }
    } catch (error) {
      logger.error({ event: 'deadline_tick_failed', ...errorFields(error) }, 'deadline_tick_failed');
    }
    if (stopped !== undefined) {
      return Promise.resolve();
    }
    // Never rejects; failures are logged inside the scheduler.
    return scheduler.tick();
  };
  let stopped: Promise<void> | undefined;
  const tick = setInterval(() => void onTick(), DEADLINE_TICK_MS);
  return {
    paths,
    logger,
    db: openDb,
    store,
    coordinator,
    executor,
    deadlines,
    scheduler,
    tick: onTick,
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
        clearInterval(tick);
        await scheduler.idle();
        // Let queued transactions and the drain in flight finish before the database closes; nothing new
        // starts, and pending effects replay at next boot (AD-18).
        await coordinator.idle();
        await executor.settle();
        logger.info({ event: 'daemon_stopped', reason }, 'daemon_stopped');
        try {
          openDb.close();
        } finally {
          await appLogger.close();
          releaseLock();
        }
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
