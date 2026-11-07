import { DatabaseNewerThanCodeError } from '../../core/domain/errors.ts';
import type { SqliteDatabase } from './db.ts';
import { migrations as allMigrations, type Migration } from './migrations/index.ts';

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new Error(`migration ${migration.name} has id ${migration.id}, expected ${index + 1}`);
    }
  });
}

export function schemaVersion(db: SqliteDatabase): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies every migration above the database's `user_version`, each in its own transaction
 * together with the version bump. Refuses a database newer than the code (AD-23).
 */
export function migrate(db: SqliteDatabase, migrations: readonly Migration[] = allMigrations): MigrationResult {
  assertOrdered(migrations);
  const latest = migrations.length;
  const from = schemaVersion(db);
  if (from > latest) {
    throw new DatabaseNewerThanCodeError(from, latest);
  }
  const applied: number[] = [];
  for (const migration of migrations.slice(from)) {
    // IMMEDIATE takes the write lock up front; re-reading the version inside it skips a step
    // another process applied in the meantime.
    const ran = db
      .transaction(() => {
        if (schemaVersion(db) >= migration.id) {
          return false;
        }
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.id}`);
        return true;
      })
      .immediate();
    if (ran) {
      applied.push(migration.id);
    }
  }
  return { from, to: schemaVersion(db), applied };
}
