import type { EvidenceRow } from '../domain/evidence.ts';

/** What ingest reads of an artifact file before it is copied (AD-8). */
export interface EvidenceProbe {
  bytes: number;
  /**
   * Seconds read from the MP4/QuickTime `mvhd` box for `.mp4`, `.mov` and `.m4v`; null when the box
   * cannot be read. Undefined for any other file.
   */
  durationS?: number | null;
}

/**
 * Evidence rows and files (AD-2, AD-8): rows in SQLite, files under `$ANTIPOD_HOME/data/evidence/`.
 * Rows and files are never updated or deleted, apart from the `superseded` flag and the boot sweep of
 * files that have no row. Row methods are synchronous so they run inside the Coordinator's transaction.
 */
export interface EvidenceStore {
  insertEvidence(row: EvidenceRow): void;
  /** Marks every row of the Task's round `superseded` (a repeat ingest before `in_review`). */
  supersedeRound(taskId: string, round: number): void;
  /** Every row of the Task's round, superseded ones included, oldest first. */
  evidenceOf(taskId: string, round: number): EvidenceRow[];
  /** The absolute path of a row's `path`. */
  fileOf(path: string): string;
  /** Copies `source` to the row path `path` (relative to the data dir) and fsyncs it. Never overwrites. */
  put(source: string, path: string): Promise<void>;
  probe(file: string): Promise<EvidenceProbe>;
  /** Deletes every file under `data/evidence/` that has no row (AD-18). Returns how many. */
  sweepOrphans(): Promise<number>;
}
