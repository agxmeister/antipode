import { randomUUID } from 'node:crypto';
import type { S } from '../ports/clock.ts';
export const id = (s: S): string => `${String(s)}-${randomUUID()}`;
