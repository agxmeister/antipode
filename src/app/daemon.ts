import { join } from 'node:path';
import { Api } from 'grammy';
import { migrate } from '../adapters/sqlite/migrate.ts';
import { openDatabase, type SqliteDatabase } from '../adapters/sqlite/db.ts';
import { SqliteStore } from '../adapters/sqlite/store.ts';
import { ClaudeCliRunner } from '../adapters/claude-cli/runner.ts';
import { RoleConfigResolver } from '../adapters/claude-cli/role-config.ts';
import { GitRepo } from '../adapters/git/repo.ts';
import { HostRunner, killSteps } from '../adapters/host/runner.ts';
import { PodmanRunner } from '../adapters/podman/runner.ts';
import { REGISTER_COMMAND } from '../adapters/telegram/poller.ts';
import { TelegramMessenger } from '../adapters/telegram/messenger.ts';
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
import { ensureHome, PACKAGE_ROLES, resolveHome, writeAntipodShim, type HomePaths } from './home.ts';
import { createLogger, type AppLogger, type Logger } from './logger.ts';
import { acquirePidLock } from './pid-lock.ts';
import { Registration, REGISTER_USAGE } from './registration.ts';
import { readInstanceSecrets } from './secrets.ts';
import { SOCKET_FILE, startStepSocket, type StepSocket } from './step-socket.ts';
import { Intake } from './intake.ts';
import { INTAKE_ROLE, Stages } from './stages.ts';
import { recoverSteps, Steps } from './steps.ts';

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
  /** The Telegram surface; undefined when `secrets/antipod.env` has no `TELEGRAM_BOT_TOKEN` and no `telegramApi` was given. */
  readonly messenger: TelegramMessenger | undefined;
  /** The one registration path (AD-10); `/register` jobs run through it. */
  readonly registration: Registration;
  /** Runs Recipe steps (AD-7); `antipod step` reaches it through the socket. */
  readonly steps: Steps;
  /** Launches and cancels Stages (AD-4); the `start_stage` and `cancel_stage` handlers. */
  readonly stages: Stages;
  /** Drafts from Owner text and the inbox, the Draft card's commands and the Branch effects (CAP-6..9). */
  readonly intake: Intake;
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
  /** The grammY `Api` to use instead of one built from `TELEGRAM_BOT_TOKEN`; tests pass one with a transformer (AD-24). */
  telegramApi?: Api;
  /** IANA zone for times in messages; the host's local zone by default. */
  timeZone?: string;
  /** The podman binary for container steps; `podman` on PATH by default. */
  podman?: string;
  /** The `claude` binary for Stages, looked up on the Stage's `PATH`; `claude` by default. */
  claude?: string;
  /** SIGINT-to-SIGTERM grace of a stopped Stage; 30 s by default (AD-4). Tests shorten it. */
  stageKillGraceMs?: number;
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
  let messenger: TelegramMessenger | undefined;
  let registration: Registration;
  let steps: Steps;
  let stages: Stages;
  let intake: Intake;
  let stepSocket: StepSocket | undefined;
  /** `/register` jobs in flight; `stop()` waits for them before the database closes. */
  const jobs = new Set<Promise<void>>();
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
    const gitRepo = new GitRepo({ dataDir: paths.data, secretsDir: paths.secrets, log: logger });
    intake = new Intake({ store, coordinator, repo: gitRepo, clock, config: () => config, log: logger });
    const draftIntake = intake;
    executor.register('scan_inbox', (effect) => draftIntake.scanInbox(effect));
    executor.register('prepare_branch', async (effect) => {
      await draftIntake.prepareBranch(effect);
    });
    executor.register('commit_contract', (effect) => draftIntake.commitContract(effect));
    const api = options.telegramApi ?? telegramApiFromSecrets(paths.secrets);
    if (api === undefined) {
      // No bot token: the daemon runs without Telegram and keeps notices on record in the log.
      logger.warn({ event: 'telegram_disabled', reason: 'no TELEGRAM_BOT_TOKEN in secrets/antipod.env' }, 'telegram_disabled');
      executor.register('back_online', (effect) => {
        logger.info({ event: 'back_online', project_id: effect.project_id, gap_ms: effect.gap_ms }, 'back_online');
      });
      executor.register('notify', (effect) => {
        logger.info({ event: 'notice', notice_kind: effect.notice_kind, task_id: effect.task_id, project_id: effect.project_id, payload: effect.payload }, 'notice');
      });
      executor.register('retire_card', (effect) => {
        logger.info({ event: 'retire_card', task_id: effect.task_id, round: effect.round }, 'retire_card');
      });
    } else {
      const telegram = new TelegramMessenger({
        api,
        store,
        clock,
        log: logger,
        config: () => ({
          ownerId: config.owner.telegram_user_id,
          staleAfterMs: config.telegram.stale_after_ms,
          outboxRetries: config.outbox.retries,
        }),
        ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      });
      messenger = telegram;
      const telegramRegistration = new Registration({
        store,
        coordinator,
        repo: gitRepo,
        checkChat: (chatId) => telegram.checkChat(chatId),
        log: logger,
      });
      registration = telegramRegistration;
      // The handler only checks the argument and returns (handler contract); the job ends with one reply.
      telegram.registerCommand(REGISTER_COMMAND, (input) => {
        if (input.args === '') {
          telegram.replyRegistration(input.chatId, input.messageId, { ok: false, reason: REGISTER_USAGE });
          return;
        }
        const job: Promise<void> = telegramRegistration
          .register({ repo: input.args, chatId: input.chatId })
          .then((result) => telegram.replyRegistration(input.chatId, input.messageId, result))
          .catch((error: unknown) => {
            logger.error({ event: 'registration_reply_failed', chat_id: input.chatId, ...errorFields(error) }, 'registration_reply_failed');
          })
          .finally(() => jobs.delete(job));
        jobs.add(job);
      });
      // Untargeted Owner text and replies to a Draft card go to Intake; its buttons are Coordinator commands (AD-9).
      telegram.onText((input) => draftIntake.onText(input));
      for (const [command, definition] of draftIntake.callbacks()) telegram.registerCallback(command, definition);
      executor.register('notify', (effect, row) => telegram.notify(effect, row));
      executor.register('back_online', (effect, row) => telegram.backOnline(effect, row));
      executor.register('retire_card', (effect, row) => telegram.retireCard(effect, row));
    }
    registration ??= new Registration({
      store,
      coordinator,
      repo: gitRepo,
      checkChat: async () => 'Telegram is not configured',
      log: logger,
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
    // The usage-window launch gate (AD-11), in front of every Stage launch.
    executor.setGuard(['start_stage'], scheduler.launchGuard);
    // Step runners (AD-7, AD-19): the capability map and instance secrets are read per step, so SIGHUP applies.
    const stepsDir = join(paths.data, 'steps');
    const podman = new PodmanRunner({ instance: paths.root, log: logger, ...(options.podman === undefined ? {} : { podman: options.podman }) });
    const host = new HostRunner({
      leases: store,
      stepsDir,
      capabilities: () => config.capabilities,
      instanceSecrets: () => readInstanceSecrets(paths.secrets),
      clock,
      log: logger,
    });
    steps = new Steps({ store, repo: gitRepo, dataDir: paths.data, secretsDir: paths.secrets, runners: { container: podman, host }, clock, log: logger });
    // Stages (AD-4, AD-6, AD-15): `antipod` on every Stage's PATH, Role Config layered package ← home ← repo.
    writeAntipodShim(paths);
    stages = new Stages({
      store,
      coordinator,
      runner: new ClaudeCliRunner({
        clock,
        log: logger,
        ...(options.claude === undefined ? {} : { claude: options.claude }),
        ...(options.stageKillGraceMs === undefined ? {} : { killGraceMs: options.stageKillGraceMs }),
      }),
      resolver: new RoleConfigResolver({ packageDir: PACKAGE_ROLES, homeDir: paths.roles }),
      repo: gitRepo,
      home: paths.root,
      dataDir: paths.data,
      secretsDir: paths.secrets,
      runBin: paths.runBin,
      config: () => ({ roles: config.roles, agent: config.agent, intake: config.intake }),
      baseEnv: options.env ?? process.env,
      log: logger,
    });
    stages.setOutputHook(INTAKE_ROLE, draftIntake.outputHook);
    executor.register('start_stage', (effect) => stages.startStage(effect));
    executor.register('cancel_stage', (effect) => stages.cancelStage(effect));
    // Steps first (AD-18): leased processes and step containers are gone before anything relaunches.
    const stepRecovery = await recoverSteps({
      store,
      clock,
      killHostSteps: (ids) => killSteps(ids, stepsDir, logger),
      removeOrphans: () => podman.removeOrphans(),
      log: logger,
    });
    const recovery = await recover({ store, coordinator, executor, clock, log: logger });
    // Attached after recovery so nothing drains until recovery has settled the orphaned launches.
    coordinator.onEffectsCommitted(() => executor.notify());
    // After recovery: the replayed effects have queued their rows, and the sender resends every unsent one (AD-18).
    await messenger?.start();
    stepSocket = await startStepSocket({ path: join(paths.run, SOCKET_FILE), steps, log: logger });

    logger.info(
      {
        event: 'daemon_started',
        home: paths.root,
        schema_version: result.to,
        migrations_applied: result.applied,
        ...stepRecovery,
        ...recovery,
      },
      'daemon_started',
    );
  } catch (error) {
    logger.fatal({ event: 'daemon_boot_failed', ...errorFields(error) }, 'daemon_boot_failed');
    try {
      await stepSocket?.close();
      await messenger?.stop();
      db?.close();
    } finally {
      await appLogger.close();
      releaseLock();
    }
    throw error;
  }

  const openDb = db;
  const openSocket = stepSocket;
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
    // Fetch and inbox scan per Project at boot and every git.fetch_interval_ms (AD-5).
    const scans = intake.tick().catch((error: unknown) => {
      logger.error({ event: 'inbox_scan_request_failed', ...errorFields(error) }, 'inbox_scan_request_failed');
    });
    // Never rejects; failures are logged inside the scheduler.
    return Promise.all([scans, scheduler.tick()]).then(() => undefined);
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
    messenger,
    registration,
    steps,
    stages,
    intake,
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
        // No new step requests; running steps are stopped and their rows finished before the database closes.
        await openSocket.close();
        // No new Owner input; running registrations finish and queue their replies; then no sends in
        // flight. Unsent rows are resent at next boot (AD-18).
        await messenger?.poller.stop();
        await Promise.allSettled([...jobs]);
        await registration.idle();
        await messenger?.stop();
        await scheduler.idle();
        // Running Stages are stopped and apply nothing; boot recovery fails them `restart` (AD-18).
        await stages.stop();
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

/** A grammY `Api` for `TELEGRAM_BOT_TOKEN` from `secrets/antipod.env`, or undefined without one. */
function telegramApiFromSecrets(secretsDir: string): Api | undefined {
  const token = readInstanceSecrets(secretsDir)['TELEGRAM_BOT_TOKEN'];
  return token === undefined || token === '' ? undefined : new Api(token);
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
