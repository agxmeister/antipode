import { z } from 'zod';
import { evidenceKindSchema } from './recipe.ts';

/** Ingest rejects an artifact over this size (AD-8, CAP-23). */
export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
/** Ingest rejects a video longer than this (AD-8, CAP-23). */
export const MAX_VIDEO_SECONDS = 60;
/** Videos Telegram plays inline; their duration is read from the `mvhd` box. */
export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'm4v'];
/** Videos Telegram cannot play inline: ingest rejects them. */
export const UNPLAYABLE_VIDEO_EXTENSIONS: readonly string[] = ['webm', 'mkv', 'avi'];

/**
 * One row of `evidence` (AD-2, AD-8): an immutable, criterion-linked artifact of one Review round.
 * `path` is relative to `$ANTIPOD_HOME/data` (`evidence/<project>/<task_no>/r<round>/<id>.<ext>`).
 * Only `superseded` ever changes, from false to true.
 */
export const evidenceRowSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  /** `review_round + 1` when it was produced (AD-16). */
  round: z.int().positive(),
  /** `AC<n>` of an active criterion. */
  criterion_id: z.string().min(1),
  kind: evidenceKindSchema,
  path: z.string().min(1),
  bytes: z.int().nonnegative(),
  degraded: z.string().nullable(),
  /** The `evidence_id` of the before image this artifact is the after of. */
  before_of: z.string().nullable(),
  caption: z.string(),
  stage_id: z.string().min(1).nullable(),
  superseded: z.boolean(),
  created_at: z.iso.datetime(),
});
export type EvidenceRow = z.infer<typeof evidenceRowSchema>;

/** One entry of `prior/index.json` (AD-7). */
export interface PriorIndexEntry {
  evidence_id: string;
  criterion_id: string;
  kind: EvidenceRow['kind'];
}

/** `evidence/<project>/<task_no>`, relative to the data dir: the Task's Evidence directory. */
export function evidenceTaskDir(project: string, taskNo: number): string {
  return `evidence/${project}/${taskNo}`;
}

/** The lower-case extension of `name` without its dot; `bin` when it has none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 || dot === base.length - 1 ? 'bin' : base.slice(dot + 1).toLowerCase();
}

/** The file name of a row's file: `<evidence_id>.<ext>`. */
export function evidenceFileName(row: Pick<EvidenceRow, 'id' | 'path'>): string {
  return `${row.id}.${extensionOf(row.path)}`;
}

/** The rows that count in a round: those not superseded by a later ingest. */
export function currentRows(rows: readonly EvidenceRow[]): EvidenceRow[] {
  return rows.filter((row) => !row.superseded);
}
