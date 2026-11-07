import { migration0001 } from './0001-settings.ts';

/** One forward-only schema step. `id` is the `PRAGMA user_version` after it runs. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Every migration in order. Append only; never edit a committed entry (AD-23). */
export const migrations: readonly Migration[] = [migration0001];
