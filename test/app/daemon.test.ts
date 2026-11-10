import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { bootDaemon, runDaemon } from '../../src/app/daemon.ts';
import { AntipodError } from '../../src/core/domain/errors.ts';
import { migrations } from '../../src/adapters/sqlite/migrations/index.ts';
import { fakeClock } from '../helpers/clock.ts';
import { createTempHome, readLogLines, type TempHome } from '../helpers/home.ts';

function logOf(home: TempHome): Array<Record<string, unknown>> {
  return readLogLines(readFileSync(join(home.root, 'logs', 'antipod.log'), 'utf8'));
}

function events(home: TempHome): unknown[] {
  return logOf(home).map((line) => line['event']);
}

/** Starts `runDaemon` on a private signal emitter and resolves once `daemon_started` is logged. */
async function startRunning(home: TempHome) {
  const signals = new EventEmitter();
  const reports: string[] = [];
  const exit = runDaemon({ env: home.env, signals, report: (line) => reports.push(line) });
  for (let i = 0; i < 200 && signals.listenerCount('SIGTERM') === 0; i++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  expect(signals.listenerCount('SIGTERM')).toBe(1);
  return { signals, exit, reports };
}

describe('daemon', () => {
  it('boots a fresh home: dirs, mode-700 secrets, migrated database, daemon_started', async () => {
    const home = createTempHome();
    const daemon = await bootDaemon({ env: home.env });
    await daemon.stop('test');

    for (const dir of ['data', 'logs', 'run', 'secrets']) {
      expect(statSync(join(home.root, dir)).isDirectory()).toBe(true);
    }
    expect(statSync(join(home.root, 'secrets')).mode & 0o777).toBe(0o700);
    const db = new Database(join(home.root, 'data', 'antipod.db'), { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    db.close();
    const started = logOf(home).find((line) => line['event'] === 'daemon_started');
    expect(started).toMatchObject({
      level: 30,
      msg: 'daemon_started',
      schema_version: migrations.length,
      stages_restarted: 0,
      effects_orphaned: 0,
      effects_replayed: 0,
    });
  });

  it('wires the Coordinator core: a Task moves through the store and effects drain after commit', async () => {
    const home = createTempHome();
    const daemon = await bootDaemon({ env: home.env });
    const project = await daemon.coordinator.createProject('p');
    const task = await daemon.coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    expect(task.budget_limit).toBe(daemon.config().limits.iteration_budget);
    await daemon.coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    expect(daemon.store.getTask(task.id)).toMatchObject({ state: 'implementing', budget_used: 1 });
    // The commit hook drains without anyone calling drain(). No start_stage handler yet (story 1-4):
    // the effect fails no_handler and is logged, never left pending.
    await vi.waitFor(() => expect(daemon.store.effectsOfTask(task.id)[0]?.status).not.toBe('pending'));
    expect(daemon.store.effectsOfTask(task.id)).toMatchObject([{ kind: 'start_stage', status: 'failed', error: 'no_handler' }]);
    expect(daemon.executor.has('back_online')).toBe(true);
    await daemon.stop('test');
    expect(logOf(home).find((line) => line['event'] === 'effect_failed')).toMatchObject({ level: 50, error: 'no_handler' });
  });

  it('one tick starts a queued bootstrap Task: implementing with a start_stage effect (AD-11)', async () => {
    const home = createTempHome();
    const daemon = await bootDaemon({ env: home.env, clock: fakeClock() });
    const project = await daemon.coordinator.createProject('p');
    const task = await daemon.coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await daemon.tick();
    expect(daemon.store.getTask(task.id)).toMatchObject({ state: 'implementing', waiting_reason: null });
    expect(daemon.store.effectsOfTask(task.id).map((r) => r.kind)).toEqual(['start_stage']);
    await daemon.stop('test');
  });

  it('a full usage window from BootOptions.windowReader holds a queued Task and records one wait notice', async () => {
    const home = createTempHome();
    const resets_at = '2026-11-08T15:00:00.000Z';
    const windowReader = { read: async () => ({ five_hour: { utilization: 97, resets_at }, weekly: { utilization: 5, resets_at } }) };
    const daemon = await bootDaemon({ env: home.env, clock: fakeClock(), windowReader });
    const project = await daemon.coordinator.createProject('p');
    const task = await daemon.coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await daemon.tick();
    await daemon.tick();
    await daemon.coordinator.idle();
    await daemon.executor.drain();
    expect(daemon.store.getTask(task.id)).toMatchObject({ state: 'queued', waiting_reason: 'usage_window' });
    expect(daemon.store.effectsOfTask(task.id)).toMatchObject([{ kind: 'notify', status: 'done', effect: { notice_kind: 'usage_window_wait' } }]);
    await daemon.stop('test');
    expect(logOf(home).find((l) => l['event'] === 'notice')).toMatchObject({ notice_kind: 'usage_window_wait', task_id: task.id });
  });

  it('wires the launch guard: with a full window a start_stage stays pending instead of failing no_handler', async () => {
    const home = createTempHome();
    const resets_at = '2026-11-08T15:00:00.000Z';
    const windowReader = { read: async () => ({ five_hour: { utilization: 97, resets_at }, weekly: { utilization: 5, resets_at } }) };
    const daemon = await bootDaemon({ env: home.env, clock: fakeClock(), windowReader });
    const project = await daemon.coordinator.createProject('p');
    const task = await daemon.coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await daemon.tick();
    await daemon.coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    await daemon.coordinator.idle();
    await daemon.executor.drain();
    expect(daemon.store.getTask(task.id)).toMatchObject({ state: 'implementing', waiting_reason: 'usage_window' });
    expect(daemon.store.effectsOfTask(task.id).find((r) => r.kind === 'start_stage')).toMatchObject({ status: 'pending', error: null });
    await daemon.stop('test');
  });

  it('a full window holds a launch made before the first tick, and the relaunch recovery makes after a restart', async () => {
    const home = createTempHome();
    const resets_at = '2026-11-08T15:00:00.000Z';
    const windowReader = { read: async () => ({ five_hour: { utilization: 97, resets_at }, weekly: { utilization: 5, resets_at } }) };
    const daemon = await bootDaemon({ env: home.env, clock: fakeClock(), windowReader });
    const project = await daemon.coordinator.createProject('p');
    const task = await daemon.coordinator.createTask({ project_id: project.id, kind: 'bootstrap' });
    await daemon.coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    await daemon.coordinator.idle();
    await daemon.executor.drain();
    expect(daemon.store.effectsOfTask(task.id).find((r) => r.kind === 'start_stage')?.status).toBe('pending');
    await daemon.stop('test');

    const restarted = await bootDaemon({ env: home.env, clock: fakeClock(), windowReader });
    await restarted.coordinator.idle();
    await restarted.executor.drain();
    const launches = restarted.store.effectsOfTask(task.id).filter((r) => r.kind === 'start_stage');
    expect(launches.map((r) => [r.status, r.effect.kind === 'start_stage' ? r.effect.attempt : 0])).toEqual([
      ['done', 1],
      ['pending', 2],
    ]);
    expect(restarted.store.getTask(task.id)?.waiting_reason).toBe('usage_window');
    await restarted.stop('test');
  });

  it('stop() waits for a tick whose window read is in flight, and the tick finishes cleanly', async () => {
    const home = createTempHome();
    let answer!: (value: null) => void;
    const windowReader = { read: () => new Promise<null>((resolve) => (answer = resolve)) };
    const daemon = await bootDaemon({ env: home.env, clock: fakeClock(), windowReader });
    const order: string[] = [];
    const ticking = daemon.tick().then(() => order.push('tick'));
    const stopping = daemon.stop('test').then(() => order.push('stop'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(order).toEqual([]);
    answer(null);
    await Promise.all([ticking, stopping]);
    expect(order).toEqual(['tick', 'stop']);
    expect(logOf(home).filter((l) => l['event'] === 'scheduler_step_failed' || l['event'] === 'scheduler_tick_failed')).toEqual([]);
  });

  it('a sleep seen by the deadline tick queues back_online for every Project with an ACTIVE Task', async () => {
    const home = createTempHome();
    const clock = fakeClock();
    const daemon = await bootDaemon({ env: home.env, clock });
    const busy = await daemon.coordinator.createProject('busy');
    await daemon.coordinator.createTask({ project_id: busy.id, kind: 'bootstrap' });
    const idle = await daemon.coordinator.createProject('idle');
    await daemon.coordinator.createTask({ project_id: idle.id, kind: 'feature' });
    daemon.tick();
    clock.jumpWall(2 * 3_600_000);
    daemon.tick();
    await vi.waitFor(() => expect(daemon.store.pendingEffects().length + logOf(home).filter((l) => l['event'] === 'back_online').length).toBeGreaterThan(0));
    await daemon.coordinator.idle();
    await daemon.executor.settle();
    await daemon.stop('test');
    const lines = logOf(home);
    expect(lines.find((l) => l['event'] === 'sleep_detected')).toMatchObject({ gap_ms: 7_200_000 });
    expect(lines.filter((l) => l['event'] === 'back_online')).toMatchObject([{ project_id: busy.id, gap_ms: 7_200_000 }]);
  });

  it.each([
    ['missing owner id', { limits: { concurrency: 2 } }, 'owner.telegram_user_id'],
    ['concurrency out of range', { owner: { telegram_user_id: 1 }, limits: { concurrency: 4 } }, 'limits.concurrency'],
  ])('refuses to start on invalid config (%s), naming the key', async (_name, config, key) => {
    const home = createTempHome(config);
    const reports: string[] = [];
    const code = await runDaemon({ env: home.env, signals: new EventEmitter(), report: (l) => reports.push(l) });
    expect(code).toBe(1);
    expect(reports.join('\n')).toContain(key);
    expect(logOf(home).find((line) => line['event'] === 'daemon_boot_failed')).toMatchObject({
      level: 60,
      error_code: 'config_invalid',
    });
  });

  it('refuses to start when the database is newer than the code', async () => {
    const home = createTempHome();
    await (await bootDaemon({ env: home.env })).stop('test');
    const db = new Database(join(home.root, 'data', 'antipod.db'));
    db.pragma(`user_version = ${migrations.length + 1}`);
    db.close();

    const reports: string[] = [];
    const code = await runDaemon({ env: home.env, signals: new EventEmitter(), report: (l) => reports.push(l) });
    expect(code).toBe(1);
    expect(reports.join('\n')).toMatch(/newer than this code/);
    expect(logOf(home).at(-1)).toMatchObject({ event: 'daemon_boot_failed', error_code: 'database_newer_than_code' });
  });

  it('applies logging.level at boot', async () => {
    const home = createTempHome({ owner: { telegram_user_id: 1 }, logging: { level: 'debug' } });
    const daemon = await bootDaemon({ env: home.env });
    expect(daemon.logger.level).toBe('debug');
    await daemon.stop('test');
  });

  it('refuses a second daemon on the same home while the first runs, and releases on stop', async () => {
    const home = createTempHome();
    const pidFile = join(home.root, 'run', 'antipod.pid');
    const first = await bootDaemon({ env: home.env });
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(process.pid));

    const second = bootDaemon({ env: home.env });
    await expect(second).rejects.toThrow(AntipodError);
    await expect(second).rejects.toThrow(`pid ${process.pid}`);
    const reports: string[] = [];
    expect(await runDaemon({ env: home.env, signals: new EventEmitter(), report: (l) => reports.push(l) })).toBe(1);
    expect(reports.join('\n')).toContain('another daemon');
    expect(existsSync(pidFile)).toBe(true);

    await first.stop('test');
    expect(existsSync(pidFile)).toBe(false);
    expect(events(home)).toEqual(['daemon_started', 'daemon_stopped']);
  });

  it('replaces a stale pid file', async () => {
    const home = createTempHome();
    const pidFile = join(home.root, 'run', 'antipod.pid');
    await (await bootDaemon({ env: home.env })).stop('test');
    writeFileSync(pidFile, '999999\n');
    const daemon = await bootDaemon({ env: home.env });
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(process.pid));
    await daemon.stop('test');
  });

  it('applies an edited config on SIGHUP and logs config_reloaded; the scheduler reads the reloaded limits', async () => {
    const home = createTempHome({ owner: { telegram_user_id: 1 }, limits: { concurrency: 1 } });
    const daemon = await bootDaemon({ env: home.env, clock: fakeClock() });
    expect(daemon.config().limits.concurrency).toBe(1);
    const first = await daemon.coordinator.createTask({ project_id: (await daemon.coordinator.createProject('a')).id, kind: 'bootstrap' });
    const second = await daemon.coordinator.createTask({ project_id: (await daemon.coordinator.createProject('b')).id, kind: 'bootstrap' });
    await daemon.tick();
    expect(daemon.store.getTask(first.id)?.state).toBe('implementing');
    expect(daemon.store.getTask(second.id)).toMatchObject({ state: 'queued', waiting_reason: 'concurrency' });
    home.writeConfig({ owner: { telegram_user_id: 1 }, limits: { concurrency: 2 }, logging: { level: 'debug' } });
    expect(daemon.reload()).toBe(true);
    expect(daemon.config().limits.concurrency).toBe(2);
    expect(daemon.logger.level).toBe('debug');
    await daemon.tick();
    expect(daemon.store.getTask(second.id)?.state).toBe('implementing');
    await daemon.stop('test');
    expect(events(home)).toContain('config_reloaded');
  });

  it('keeps the previous config on an invalid SIGHUP and logs config_reload_failed at error level', async () => {
    const home = createTempHome();
    const { signals, exit } = await startRunning(home);
    home.writeConfigText('owner: [\n');
    signals.emit('SIGHUP');
    home.writeConfig({ owner: { telegram_user_id: 1 }, limits: { concurrency: 9 } });
    signals.emit('SIGHUP');
    signals.emit('SIGTERM');
    expect(await exit).toBe(0);

    const failures = logOf(home).filter((line) => line['event'] === 'config_reload_failed');
    expect(failures).toHaveLength(2);
    expect(failures.every((line) => line['level'] === 50)).toBe(true);
    expect(String(failures[1]?.['error'])).toContain('limits.concurrency');
    expect(events(home).at(-1)).toBe('daemon_stopped');
  });

  it('a valid SIGHUP through the signal source reloads', async () => {
    const home = createTempHome();
    const { signals, exit } = await startRunning(home);
    signals.emit('SIGHUP');
    signals.emit('SIGINT');
    expect(await exit).toBe(0);
    expect(events(home)).toEqual(['daemon_started', 'config_reloaded', 'daemon_stopped']);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
    expect(existsSync(join(home.root, 'data', 'antipod.db-wal'))).toBe(false);
  });
});
