import type { Clock } from '../ports/clock.ts';
import { silentLog, type Log } from '../ports/log.ts';

export interface TickResult {
  /** Deadline ids fired by this tick, in due order. */
  fired: string[];
  /** Set when the wall clock jumped by more than the sleep threshold since the previous tick (AD-18). */
  sleep?: { gapMs: number };
}

/** A wall-clock gap between ticks above this is a sleep, not a slow tick. */
export const SLEEP_THRESHOLD_MS = 60_000;

interface Entry {
  dueMono: number;
  onFire: (id: string) => void;
}

/**
 * Monotonic deadlines that survive Mac sleep (AD-18). Deadlines are kept in monotonic time. Each
 * tick compares the wall clock with the previous tick: a jump over the threshold means the process
 * was asleep, and every deadline is pushed back by however much the monotonic clock advanced during
 * that gap. If the platform's monotonic clock stops during sleep the shift is nil and the deadlines
 * already exclude the sleep; if it keeps running the shift equals the gap. Either way no deadline
 * fires because of the sleep, and the tick reports the gap so the Coordinator can queue `back_online`.
 */
export class Deadlines {
  readonly #clock: Clock;
  readonly #threshold: number;
  readonly #log: Log;
  readonly #entries = new Map<string, Entry>();
  #last: { mono: number; wall: number } | undefined;

  constructor(clock: Clock, sleepThresholdMs: number = SLEEP_THRESHOLD_MS, log: Log = silentLog) {
    this.#clock = clock;
    this.#threshold = sleepThresholdMs;
    this.#log = log;
  }

  /** Arms (or re-arms) deadline `id` to fire `dueInMs` from now. */
  set(id: string, dueInMs: number, onFire: (id: string) => void): void {
    this.#entries.set(id, { dueMono: this.#clock.monotonicMs() + dueInMs, onFire });
  }

  clear(id: string): boolean {
    return this.#entries.delete(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Milliseconds until `id` fires, or undefined when not armed. */
  remaining(id: string): number | undefined {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : Math.max(0, entry.dueMono - this.#clock.monotonicMs());
  }

  /** Detects a sleep since the previous tick, then fires every due deadline. */
  tick(): TickResult {
    const mono = this.#clock.monotonicMs();
    const wall = this.#clock.now().getTime();
    const result: TickResult = { fired: [] };
    if (this.#last !== undefined) {
      const wallGap = wall - this.#last.wall;
      if (wallGap > this.#threshold) {
        const shift = Math.max(0, mono - this.#last.mono);
        for (const entry of this.#entries.values()) {
          entry.dueMono += shift;
        }
        result.sleep = { gapMs: wallGap };
      }
    }
    this.#last = { mono, wall };

    const due = [...this.#entries.entries()]
      .filter(([, entry]) => entry.dueMono <= mono)
      .sort(([, a], [, b]) => a.dueMono - b.dueMono);
    for (const [id, entry] of due) {
      this.#entries.delete(id);
      result.fired.push(id);
      try {
        entry.onFire(id);
      } catch (error) {
        // One bad callback never stops the other deadlines or the tick.
        const message = error instanceof Error ? error.message : String(error);
        this.#log.error({ event: 'deadline_callback_failed', deadline_id: id, error: message }, 'deadline_callback_failed');
      }
    }
    return result;
  }
}
