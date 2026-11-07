import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabaseReadOnly, vacuumInto } from '../../adapters/sqlite/db.ts';
import { AntipodError } from '../../core/domain/errors.ts';
import type { Config } from '../config.ts';
import type { HomePaths } from '../home.ts';
import type { CommandRunner } from './command.ts';

export interface BackupOptions {
  paths: HomePaths;
  config: Config;
  run: CommandRunner;
}

export interface BackupResult {
  database: string;
  data: string;
}

/**
 * `antipod backup` (AD-23): a `VACUUM INTO` copy of the database written through a temp file and
 * a rename, then `rsync` of `data/` without the live database files.
 */
export async function backup({ paths, config, run }: BackupOptions): Promise<BackupResult> {
  const configured = config.backup.path;
  if (configured === undefined) {
    throw new AntipodError('backup_path_missing', `backup.path is not set in ${paths.config}`);
  }
  const target = resolve(configured);
  mkdirSync(target, { recursive: true });

  const database = join(target, 'antipod.db');
  const temp = join(target, `antipod.db.tmp-${process.pid}`);
  rmSync(temp, { force: true });
  const db = openDatabaseReadOnly(paths.database);
  try {
    vacuumInto(db, temp);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new AntipodError('backup_failed', `database copy failed: ${String(error)}`, { cause: error });
  } finally {
    db.close();
  }
  renameSync(temp, database);

  const data = join(target, 'data');
  mkdirSync(data, { recursive: true });
  const result = await run('rsync', ['-a', '--exclude', 'antipod.db*', `${paths.data}/`, `${data}/`]);
  if (result.code !== 0) {
    throw new AntipodError('backup_failed', `rsync of ${paths.data} to ${data} failed (exit ${result.code})`);
  }
  return { database, data };
}
