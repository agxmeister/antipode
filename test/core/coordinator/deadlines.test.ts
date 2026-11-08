import { describe, expect, it } from 'vitest';
import { Deadlines, SLEEP_THRESHOLD_MS } from '../../../src/core/coordinator/deadlines.ts';
import { fakeClock } from '../../helpers/clock.ts';

const HOUR = 3_600_000;

function setup() {
  const clock = fakeClock();
  const deadlines = new Deadlines(clock);
  const fired: string[] = [];
  const arm = (id: string, dueInMs: number) => deadlines.set(id, dueInMs, (x) => fired.push(x));
  return { clock, deadlines, fired, arm };
}

describe('Deadlines (AD-18)', () => {
  it('fires a deadline once it is due, in due order, exactly once', () => {
    const d = setup();
    d.arm('late', 5_000);
    d.arm('early', 2_000);
    expect(d.deadlines.tick()).toEqual({ fired: [] });
    d.clock.advance(1_000);
    expect(d.deadlines.tick().fired).toEqual([]);
    d.clock.advance(5_000);
    expect(d.deadlines.tick().fired).toEqual(['early', 'late']);
    expect(d.fired).toEqual(['early', 'late']);
    expect(d.deadlines.tick().fired).toEqual([]);
    expect(d.deadlines.size).toBe(0);
  });

  it('clear disarms; set re-arms', () => {
    const d = setup();
    d.arm('a', 1_000);
    expect(d.deadlines.clear('a')).toBe(true);
    expect(d.deadlines.clear('a')).toBe(false);
    d.clock.advance(2_000);
    expect(d.deadlines.tick().fired).toEqual([]);
    d.arm('b', 1_000);
    d.arm('b', 10_000);
    d.clock.advance(5_000);
    expect(d.deadlines.tick().fired).toEqual([]);
    expect(d.deadlines.remaining('b')).toBe(5_000);
  });

  it('a sleep where the monotonic clock keeps running extends every deadline by the gap; nothing fires because of it', () => {
    const d = setup();
    d.deadlines.tick();
    d.arm('stage', 45 * 60_000);
    d.arm('undo', 10_000);
    d.clock.advance(1_000);
    d.deadlines.tick();
    const remainingBefore = d.deadlines.remaining('stage');

    d.clock.advance(2 * HOUR); // asleep: both clocks advanced
    const result = d.deadlines.tick();
    expect(result.sleep).toEqual({ gapMs: 2 * HOUR });
    expect(result.fired).toEqual([]);
    expect(d.deadlines.remaining('stage')).toBe(remainingBefore);
    expect(d.deadlines.remaining('undo')).toBe(9_000);
    d.clock.advance(9_000);
    expect(d.deadlines.tick().fired).toEqual(['undo']);
  });

  it('a sleep where the monotonic clock stopped reports the gap and leaves the deadlines alone', () => {
    const d = setup();
    d.deadlines.tick();
    d.arm('stage', 10_000);
    d.clock.jumpWall(2 * HOUR);
    const result = d.deadlines.tick();
    expect(result.sleep).toEqual({ gapMs: 2 * HOUR });
    expect(result.fired).toEqual([]);
    expect(d.deadlines.remaining('stage')).toBe(10_000);
  });

  it('a wall gap at or below the threshold is not a sleep', () => {
    const d = setup();
    d.deadlines.tick();
    d.arm('a', SLEEP_THRESHOLD_MS + 1);
    d.clock.advance(SLEEP_THRESHOLD_MS);
    const result = d.deadlines.tick();
    expect(result.sleep).toBeUndefined();
    expect(result.fired).toEqual([]);
    d.clock.advance(1);
    expect(d.deadlines.tick()).toEqual({ fired: ['a'] });
  });

  it('a throwing callback is logged and does not stop the next due deadline from firing', () => {
    const clock = fakeClock();
    const errors: Record<string, unknown>[] = [];
    const deadlines = new Deadlines(clock, SLEEP_THRESHOLD_MS, { debug() {}, info() {}, warn() {}, error: (fields) => errors.push(fields) });
    const fired: string[] = [];
    deadlines.set('bad', 1_000, () => {
      throw new Error('callback exploded');
    });
    deadlines.set('good', 2_000, (id) => fired.push(id));
    clock.advance(3_000);
    expect(deadlines.tick().fired).toEqual(['bad', 'good']);
    expect(fired).toEqual(['good']);
    expect(errors).toEqual([{ event: 'deadline_callback_failed', deadline_id: 'bad', error: 'callback exploded' }]);
    expect(deadlines.size).toBe(0);
  });

  it('the first tick never reports a sleep', () => {
    const clock = fakeClock();
    const deadlines = new Deadlines(clock);
    clock.advance(5 * HOUR);
    expect(deadlines.tick()).toEqual({ fired: [] });
  });
});
