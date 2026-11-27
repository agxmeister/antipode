import { constants } from 'node:fs';
import { copyFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Statement } from 'better-sqlite3';
import { evidenceRowSchema, extensionOf, VIDEO_EXTENSIONS, type EvidenceRow } from '../../core/domain/evidence.ts';
import type { EvidenceProbe, EvidenceStore } from '../../core/ports/evidence-store.ts';
import type { SqliteDatabase } from './db.ts';
import { mp4DurationSeconds } from './mp4.ts';

const COLUMNS = ['id', 'task_id', 'round', 'criterion_id', 'kind', 'path', 'bytes', 'degraded', 'before_of', 'caption', 'stage_id', 'superseded', 'created_at'] as const;

function toRow(row: unknown): EvidenceRow {
  const raw = row as Record<string, unknown>;
  return evidenceRowSchema.parse({ ...raw, superseded: raw['superseded'] === 1 });
}

/** fsyncs a file or directory; a directory that cannot be opened for sync is skipped. */
async function fsyncPath(path: string, directory = false): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (directory) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!directory) throw error;
  } finally {
    await handle.close();
  }
}

/** Every regular file under `dir`, recursively; none when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

/**
 * `EvidenceStore` (AD-1, AD-8): rows in the instance database, files under `<dataDir>/evidence/`.
 * Shares the connection of `SqliteStore`, so row writes join the Coordinator's transaction.
 */
export class SqliteEvidenceStore implements EvidenceStore {
  readonly #dataDir: string;
  readonly #stmt: { insert: Statement; supersede: Statement; ofRound: Statement; paths: Statement };

  constructor(db: SqliteDatabase, dataDir: string) {
    this.#dataDir = dataDir;
    this.#stmt = {
      insert: db.prepare(`INSERT INTO evidence (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`),
      supersede: db.prepare('UPDATE evidence SET superseded = 1 WHERE task_id = ? AND round = ? AND superseded = 0'),
      ofRound: db.prepare('SELECT * FROM evidence WHERE task_id = ? AND round = ? ORDER BY created_at, id'),
      paths: db.prepare('SELECT path FROM evidence'),
    };
  }

  insertEvidence(row: EvidenceRow): void {
    const valid = evidenceRowSchema.parse(row);
    this.#stmt.insert.run({ ...valid, superseded: valid.superseded ? 1 : 0 });
  }

  supersedeRound(taskId: string, round: number): void {
    this.#stmt.supersede.run(taskId, round);
  }

  evidenceOf(taskId: string, round: number): EvidenceRow[] {
    return this.#stmt.ofRound.all(taskId, round).map(toRow);
  }

  fileOf(path: string): string {
    return join(this.#dataDir, path);
  }

  async put(source: string, path: string): Promise<void> {
    const target = this.fileOf(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await fsyncPath(target);
    await fsyncPath(dirname(target), true);
  }

  async probe(file: string): Promise<EvidenceProbe> {
    const { size } = await stat(file);
    if (!VIDEO_EXTENSIONS.includes(extensionOf(file))) return { bytes: size };
    let durationS: number | null;
    try {
      durationS = await mp4DurationSeconds(file);
    } catch {
      durationS = null;
    }
    return { bytes: size, durationS };
  }

  async sweepOrphans(): Promise<number> {
    const known = new Set((this.#stmt.paths.all() as Array<{ path: string }>).map((row) => row.path));
    let deleted = 0;
    for (const file of await filesUnder(join(this.#dataDir, 'evidence'))) {
      const path = relative(this.#dataDir, file).split(sep).join('/');
      if (known.has(path)) continue;
      await unlink(file);
      deleted += 1;
    }
    return deleted;
  }
}
