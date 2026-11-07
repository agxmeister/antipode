import { readFileSync } from 'node:fs';
import type { S } from '../ports/clock.ts';
export const read = (s: S): string => readFileSync(String(s), 'utf8');
