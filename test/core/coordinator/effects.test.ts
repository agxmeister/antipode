import { afterEach, describe, expect, it } from 'vitest';
import { EffectExecutor, NO_HANDLER } from '../../../src/core/coordinator/effects.ts';
import type { Effect, EffectRow } from '../../../src/core/domain/effects.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import type { Log } from '../../../src/core/ports/log.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

function recordingLog() {
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const log: Log = {
    debug: (fields) => lines.push({ level: 'debug', fields }),
    info: (fields) => lines.push({ level: 'info', fields }),
    warn: (fields) => lines.push({ level: 'warn', fields }),
    error: (fields) => lines.push({ level: 'error', fields }),
  };
  return { log, lines };
}

function setup() {
  const ts = openTestStore();
  open.push(ts);
  const clock = fakeClock();
  const { log, lines } = recordingLog();
  const executor = new EffectExecutor(ts.store, clock, log);
  const insert = (effect: Effect): EffectRow => {
    const row: EffectRow = { effect_id: ulid(), task_id: null, kind: effect.kind, effect, status: 'pending', error: null, created_at: clock.now().toISOString(), finished_at: null };
    ts.store.insertEffect(row);
    return row;
  };
  return { ...ts, clock, executor, lines, insert };
}

const online = (projectId: string): Effect => ({ kind: 'back_online', project_id: projectId, gap_ms: 1000 });

describe('EffectExecutor (AD-3)', () => {
  it('runs pending effects in insertion order and marks them done', async () => {
    const e = setup();
    const seen: string[] = [];
    e.executor.register('back_online', (effect) => {
      seen.push(effect.project_id);
    });
    const rows = ['a', 'b', 'c'].map((p) => e.insert(online(p)));
    await e.executor.drain();
    expect(seen).toEqual(['a', 'b', 'c']);
    for (const row of rows) {
      expect(e.store.getEffect(row.effect_id)).toMatchObject({ status: 'done', error: null, finished_at: e.clock.now().toISOString() });
    }
    expect(e.store.pendingEffects()).toEqual([]);
  });

  it('a throwing handler marks its row failed with the message, logs at error level, and the next effect still runs', async () => {
    const e = setup();
    const seen: string[] = [];
    e.executor.register('back_online', (effect) => {
      if (effect.project_id === 'boom') throw new Error('handler exploded');
      seen.push(effect.project_id);
    });
    const [bad, good] = [e.insert(online('boom')), e.insert(online('fine'))];
    await e.executor.drain();
    expect(e.store.getEffect(bad.effect_id)).toMatchObject({ status: 'failed', error: 'handler exploded' });
    expect(e.store.getEffect(good.effect_id)).toMatchObject({ status: 'done' });
    expect(seen).toEqual(['fine']);
    expect(e.lines.filter((l) => l.level === 'error')).toMatchObject([{ fields: { event: 'effect_failed', effect_id: bad.effect_id, error: 'handler exploded' } }]);
  });

  it('a kind without a handler is marked failed(no_handler) and logged', async () => {
    const e = setup();
    const row = e.insert({ kind: 'integrate', task_id: 'task' });
    await e.executor.drain();
    expect(e.store.getEffect(row.effect_id)).toMatchObject({ status: 'failed', error: NO_HANDLER });
    expect(e.lines).toMatchObject([{ level: 'error', fields: { event: 'effect_failed', kind: 'integrate', error: NO_HANDLER } }]);
  });

  it('skips rows that were settled since the pending list was read (idempotent by effect_id)', async () => {
    const e = setup();
    const calls: string[] = [];
    const rows = ['a', 'b'].map((p) => e.insert(online(p)));
    e.executor.register('back_online', (effect) => {
      calls.push(effect.project_id);
      // Settle the next row out of band while this one runs, as recovery would.
      if (effect.project_id === 'a') e.store.markEffect(rows[1]!.effect_id, 'done', e.clock.now().toISOString());
    });
    await e.executor.drain();
    expect(calls).toEqual(['a']);
  });

  it('a notify during a drain schedules another pass that picks up new rows', async () => {
    const e = setup();
    const calls: string[] = [];
    let added = false;
    e.executor.register('back_online', async (effect) => {
      calls.push(effect.project_id);
      await Promise.resolve();
      if (!added) {
        added = true;
        e.insert(online('late'));
        e.executor.notify();
      }
    });
    e.insert(online('first'));
    await e.executor.drain();
    expect(calls).toEqual(['first', 'late']);
    expect(e.store.pendingEffects()).toEqual([]);
  });

  it('awaits async handlers and reports whether a kind is handled', async () => {
    const e = setup();
    let finished = false;
    e.executor.register('back_online', async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished = true;
    });
    e.insert(online('x'));
    await e.executor.drain();
    expect(finished).toBe(true);
    expect(e.executor.has('back_online')).toBe(true);
    expect(e.executor.has('start_stage')).toBe(false);
  });

  it('a guard returning held leaves the row pending for the drain while other effects still run; a later drain releases it', async () => {
    const e = setup();
    const seen: string[] = [];
    let open = false;
    let asked = 0;
    e.executor.register('back_online', (effect) => {
      seen.push(effect.project_id);
    });
    e.executor.setGuard(['back_online'], (row) => {
      if (row.effect.kind !== 'back_online' || row.effect.project_id !== 'gated') return 'run';
      asked++;
      return open ? 'run' : 'held';
    });
    const gated = e.insert(online('gated'));
    const other = e.insert(online('other'));
    await e.executor.drain();
    expect(seen).toEqual(['other']);
    expect(asked).toBe(1);
    expect(e.store.getEffect(gated.effect_id)).toMatchObject({ status: 'pending' });
    expect(e.store.getEffect(other.effect_id)).toMatchObject({ status: 'done' });

    open = true;
    await e.executor.drain();
    expect(seen).toEqual(['other', 'gated']);
    expect(e.store.pendingEffects()).toEqual([]);
  });

  it('a held row is not asked again within one drain even when a notify schedules another pass', async () => {
    const e = setup();
    let asked = 0;
    e.executor.register('back_online', () => {});
    e.executor.setGuard(['back_online'], async (row) => {
      if (row.effect.kind !== 'back_online' || row.effect.project_id !== 'gated') return 'run';
      asked++;
      e.insert(online(`late-${asked}`));
      e.executor.notify();
      return 'held';
    });
    const gated = e.insert(online('gated'));
    await e.executor.drain();
    expect(asked).toBe(1);
    expect(e.store.pendingEffects().map((r) => r.effect_id)).toEqual([gated.effect_id]);
  });

  it('a throwing guard lets the effect run and logs effect_guard_failed', async () => {
    const e = setup();
    const seen: string[] = [];
    e.executor.register('back_online', (effect) => {
      seen.push(effect.project_id);
    });
    e.executor.setGuard(['back_online'], () => {
      throw new Error('gate broke');
    });
    e.insert(online('x'));
    await e.executor.drain();
    expect(seen).toEqual(['x']);
    expect(e.lines.filter((l) => l.level === 'error')).toMatchObject([{ fields: { event: 'effect_guard_failed', error: 'gate broke' } }]);
  });
});
