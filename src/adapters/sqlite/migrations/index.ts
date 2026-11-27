import { migration0001 } from './0001-settings.ts';
import { migration0002 } from './0002-coordinator.ts';
import { migration0003 } from './0003-dependencies.ts';
import { migration0004 } from './0004-telegram.ts';
import { migration0005 } from './0005-projects-repo.ts';
import { migration0006 } from './0006-steps.ts';
import { migration0007 } from './0007-stage-retries.ts';
import { migration0008 } from './0008-contracts.ts';
import { migration0009 } from './0009-loop.ts';
import { migration0010 } from './0010-evidence.ts';

/** One forward-only schema step. `id` is the `PRAGMA user_version` after it runs. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Every migration in order. Append only; never edit a committed entry (AD-23). */
export const migrations: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007, migration0008, migration0009, migration0010];
