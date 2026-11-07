import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/adapters/sqlite/db.ts';
import { migrate, schemaVersion } from '../../../src/adapters/sqlite/migrate.ts';
import { migrations, type Migration } from '../../../src/adapters/sqlite/migrations/index.ts';
import { DatabaseNewerThanCodeError } from '../../../src/core/domain/errors.ts';
import { createTempHome } from '../../helpers/home.ts';

function freshDb() {
  return openDatabase(join(createTempHome().root, 'antipod.db'));
}

describe('sqlite migrations', () => {
  it('opens with WAL and foreign keys on', () => {
    const db = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('migrates a fresh database to the latest version and creates settings', () => {
    const db = freshDb();
    const result = migrate(db);
    expect(result).toEqual({ from: 0, to: migrations.length, applied: migrations.map((m) => m.id) });
    const columns = db.prepare("SELECT name FROM pragma_table_info('settings')").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(['key', 'value', 'updated_at']);
    expect(migrate(db).applied).toEqual([]);
    db.close();
  });

  it('refuses a database newer than the code', () => {
    const db = freshDb();
    db.pragma(`user_version = ${migrations.length + 1}`);
    expect(() => migrate(db)).toThrow(DatabaseNewerThanCodeError);
    db.close();
  });

  it('runs each migration in its own transaction', () => {
    const db = freshDb();
    const broken: Migration[] = [
      { id: 1, name: 'one', sql: 'CREATE TABLE one (id INTEGER PRIMARY KEY);' },
      { id: 2, name: 'two', sql: 'CREATE TABLE two (id INTEGER PRIMARY KEY); INSERT INTO missing VALUES (1);' },
    ];
    expect(() => migrate(db, broken)).toThrow(/missing/);
    expect(schemaVersion(db)).toBe(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['one']);
    db.close();
  });

  it('rejects migrations that are not numbered 1..n in order', () => {
    const db = freshDb();
    expect(() => migrate(db, [{ id: 2, name: 'gap', sql: '' }])).toThrow(/expected 1/);
    db.close();
  });
});
