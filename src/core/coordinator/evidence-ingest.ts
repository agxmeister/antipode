import type { CriterionRow } from '../domain/contract.ts';
import {
  evidenceTaskDir,
  extensionOf,
  MAX_EVIDENCE_BYTES,
  MAX_VIDEO_SECONDS,
  UNPLAYABLE_VIDEO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type EvidenceRow,
} from '../domain/evidence.ts';
import type { EvidenceArtifact } from '../domain/stage-output/evidence.ts';

/** An artifact's file as found in the output of one of the Stage's step runs, and what was read of it. */
export interface IngestFile {
  /** Absolute path of the file in that step run's `ANTIPOD_OUT`. */
  path: string;
  bytes: number;
  /** Seconds from the `mvhd` box of an `.mp4`, `.mov` or `.m4v`; null when unreadable; absent otherwise. */
  durationS?: number | null;
}

export interface IngestInput {
  artifacts: readonly EvidenceArtifact[];
  /** The Task's active criteria. */
  criteria: readonly CriterionRow[];
  /** `evidence_id`s of `prior/index.json`: the previous round's current rows. */
  priorIds: readonly string[];
  /** Each resolvable `name` and its file; a name that resolves to no regular file is absent. */
  files: ReadonlyMap<string, IngestFile>;
  taskId: string;
  stageId: string;
  project: string;
  taskNo: number;
  /** `review_round + 1` (AD-16). */
  round: number;
  createdAt: string;
  newId: () => string;
}

/** A row to insert and the file to copy to its `path` first. */
export interface IngestedArtifact {
  row: EvidenceRow;
  source: string;
}

export type IngestResult = { ok: true; artifacts: IngestedArtifact[] } | { ok: false; reason: string };

/** Whether `name` is a relative path with no `..` segment (AD-8: relative to `ANTIPOD_OUT`). */
export function isRelativeName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0')) return false;
  return !name.split(/[\\/]/).includes('..');
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The Evidence ingest checks, in their fixed order (AD-8, CAP-21..23); the first that fails gives the
 * `evidence_missing` reason and nothing is copied. On success, one row per artifact under
 * `evidence/<project>/<task_no>/r<round>/<evidence_id>.<ext>`, a name-based `before_of` resolved to
 * the `evidence_id` of that screenshot. Pure: the caller resolves names and probes files.
 */
export function ingestEvidence(input: IngestInput): IngestResult {
  const { artifacts } = input;
  for (const artifact of artifacts) {
    if (!isRelativeName(artifact.name)) return { ok: false, reason: `${artifact.name} is not a path relative to ANTIPOD_OUT` };
    if (!input.files.has(artifact.name)) return { ok: false, reason: `${artifact.name} is not a file in the output of any step this Stage ran` };
  }
  const active = new Set(input.criteria.map((criterion) => `AC${criterion.ac_no}`));
  for (const artifact of artifacts) {
    if (!active.has(artifact.criterion_id)) return { ok: false, reason: `${artifact.name} names ${artifact.criterion_id}, which is not an active criterion` };
  }
  const covered = new Set(artifacts.map((artifact) => artifact.criterion_id));
  const uncovered = [...active].filter((id) => !covered.has(id));
  if (uncovered.length > 0) return { ok: false, reason: `no Evidence for ${uncovered.join(', ')}` };
  const prior = new Set(input.priorIds);
  const screenshots = new Set(artifacts.filter((artifact) => artifact.kind === 'screenshot').map((artifact) => artifact.name));
  for (const artifact of artifacts) {
    const before = artifact.before_of;
    if (before === undefined || prior.has(before) || (screenshots.has(before) && before !== artifact.name)) continue;
    return { ok: false, reason: `before_of of ${artifact.name} is neither an Evidence id of prior/index.json nor a screenshot of this output: ${before}` };
  }
  for (const artifact of artifacts) {
    const file = input.files.get(artifact.name)!;
    if (file.bytes > MAX_EVIDENCE_BYTES) return { ok: false, reason: `${artifact.name} is ${megabytes(file.bytes)}; the limit is 50 MB` };
  }
  for (const artifact of artifacts) {
    if (!VIDEO_EXTENSIONS.includes(extensionOf(artifact.name))) continue;
    const seconds = input.files.get(artifact.name)!.durationS;
    if (seconds === undefined || seconds === null) return { ok: false, reason: `the duration of ${artifact.name} cannot be read` };
    if (seconds > MAX_VIDEO_SECONDS) return { ok: false, reason: `${artifact.name} lasts ${seconds.toFixed(1)} s; the limit is ${MAX_VIDEO_SECONDS} s` };
  }
  for (const artifact of artifacts) {
    const ext = extensionOf(artifact.name);
    if (UNPLAYABLE_VIDEO_EXTENSIONS.includes(ext)) return { ok: false, reason: `${artifact.name} is a .${ext} video, which Telegram cannot play inline; use .mp4` };
  }

  const ids = artifacts.map(() => input.newId());
  const idOfName = new Map<string, string>();
  artifacts.forEach((artifact, i) => {
    if (artifact.kind === 'screenshot' && !idOfName.has(artifact.name)) idOfName.set(artifact.name, ids[i]!);
  });
  const dir = `${evidenceTaskDir(input.project, input.taskNo)}/r${input.round}`;
  return {
    ok: true,
    artifacts: artifacts.map((artifact, i) => {
      const id = ids[i]!;
      const file = input.files.get(artifact.name)!;
      const before = artifact.before_of;
      return {
        source: file.path,
        row: {
          id,
          task_id: input.taskId,
          round: input.round,
          criterion_id: artifact.criterion_id,
          kind: artifact.kind,
          path: `${dir}/${id}.${extensionOf(artifact.name)}`,
          bytes: file.bytes,
          degraded: artifact.degraded,
          before_of: before === undefined ? null : prior.has(before) ? before : idOfName.get(before)!,
          caption: artifact.caption,
          stage_id: input.stageId,
          superseded: false,
          created_at: input.createdAt,
        },
      };
    }),
  };
}
