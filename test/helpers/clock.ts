import type { Clock } from '../../src/core/ports/clock.ts';

export interface FakeClock extends Clock {
  /** Advances both clocks, as awake time does. */
  advance(ms: number): void;
  /** Advances only the wall clock, as a sleeping Mac whose monotonic clock stops does. */
  jumpWall(ms: number): void;
}

export function fakeClock(start = Date.UTC(2026, 10, 8, 12, 0, 0)): FakeClock {
  let mono = 1_000;
  let wall = start;
  return {
    monotonicMs: () => mono,
    now: () => new Date(wall),
    advance(ms) {
      mono += ms;
      wall += ms;
    },
    jumpWall(ms) {
      wall += ms;
    },
  };
}

