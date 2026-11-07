import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

/** Opens the system-of-record database with WAL journaling and foreign keys enforced (AD-2). */
export function openDatabase(file: string): SqliteDatabase {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Opens an existing database read-only, for copies taken while the daemon runs. */
export function openDatabaseReadOnly(file: string): SqliteDatabase {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** Writes a consistent, compacted copy of `db` to `target` (which must not exist). */
export function vacuumInto(db: SqliteDatabase, target: string): void {
  db.prepare('VACUUM INTO ?').run(target);
}
