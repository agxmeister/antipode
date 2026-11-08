import { join } from 'node:path';
import { openDatabase, type SqliteDatabase } from '../../src/adapters/sqlite/db.ts';
import { migrate } from '../../src/adapters/sqlite/migrate.ts';
import { SqliteStore } from '../../src/adapters/sqlite/store.ts';
import { createTempHome } from './home.ts';

export interface TestStore {
  db: SqliteDatabase;
  store: SqliteStore;
  file: string;
  close(): void;
}

/** A migrated, file-backed database under a scratch home (AD-24). */
export function openTestStore(): TestStore {
  const file = join(createTempHome().root, 'antipod.db');
  const db = openDatabase(file);
  migrate(db);
  return { db, store: new SqliteStore(db), file, close: () => db.close() };
}

/** Re-opens the same file, as a restarted daemon would. */
export function reopenTestStore(file: string): TestStore {
  const db = openDatabase(file);
  migrate(db);
  return { db, store: new SqliteStore(db), file, close: () => db.close() };
}
