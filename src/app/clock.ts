import { performance } from 'node:perf_hooks';
import type { Clock } from '../core/ports/clock.ts';

export const systemClock: Clock = {
  monotonicMs: () => performance.now(),
  now: () => new Date(),
};
