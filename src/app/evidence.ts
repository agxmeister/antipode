import { copyFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { sortedCriteria } from '../core/coordinator/drafts.ts';
import { ingestEvidence, isRelativeName, type IngestFile } from '../core/coordinator/evidence-ingest.ts';
import { activeCriteria } from '../core/domain/contract.ts';
import { currentRows, evidenceFileName, type EvidenceRow, type PriorIndexEntry } from '../core/domain/evidence.ts';
import type { Event } from '../core/domain/events.ts';
import { ulid } from '../core/domain/ids.ts';
import { evidenceOutputSchema } from '../core/domain/stage-output/index.ts';
import type { Task } from '../core/domain/task.ts';
import type { Clock } from '../core/ports/clock.ts';
import type { EvidenceStore } from '../core/ports/evidence-store.ts';
import { silentLog, type Log } from '../core/ports/log.ts';
import type { Store } from '../core/ports/store.ts';
import type { HookResult, OutputHook } from './stages.ts';

/** The Evidence Producer Role, whose output goes through the ingest hook (AD-8). */
export const EVIDENCE_PRODUCER_ROLE = 'evidence-producer';
/** The index of `ANTIPOD_PRIOR` (AD-7). */
export const PRIOR_INDEX = 'index.json';

export interface EvidenceOptions {
  store: Store;
  evidence: EvidenceStore;
  /** `$ANTIPOD_HOME/data`. */
  dataDir: string;
  clock: Clock;
  log?: Log;
  newId?: () => string;
}

/** `data/prior/<project>/<task_no>`: the Task's `ANTIPOD_PRIOR` (AD-7). */
export function priorDir(dataDir: string, project: string, taskNo: number | null): string {
  return join(dataDir, 'prior', project, String(taskNo ?? '_draft'));
}

/** The rows `ANTIPOD_PRIOR` holds: round `review_round`'s current rows; none in round 1. */
export function priorRows(evidence: EvidenceStore, task: Task): EvidenceRow[] {
  return task.review_round > 0 ? currentRows(evidence.evidenceOf(task.id, task.review_round)) : [];
}

/**
 * Rebuilds `ANTIPOD_PRIOR` before a Stage launch (AD-7): a derived copy of the previous Review round's
 * current Evidence, `<evidence_id>.<ext>` plus `index.json`; empty in round 1.
 */
export async function buildPrior(evidence: EvidenceStore, dir: string, task: Task): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const rows = priorRows(evidence, task);
  if (task.review_round === 0) return;
  for (const row of rows) await copyFile(evidence.fileOf(row.path), join(dir, evidenceFileName(row)));
  const index: PriorIndexEntry[] = rows.map((row) => ({ evidence_id: row.id, criterion_id: row.criterion_id, kind: row.kind }));
  await writeFile(join(dir, PRIOR_INDEX), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

/** `path` when it is a regular file inside `root` once symlinks are resolved; undefined otherwise. */
async function fileInside(root: string, path: string): Promise<string | undefined> {
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
    if (!real.startsWith(`${realRoot}${sep}`)) return undefined;
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Evidence ingest (AD-7, AD-8, CAP-21..23), in the composition root: the Evidence Producer's output
 * hook resolves each `name` in the `ANTIPOD_OUT` of the Stage's step runs (newest first), runs the
 * ingest checks, copies and fsyncs the files, and returns `evidence_produced` with the rows to write in
 * its transaction, or `evidence_missing` with the reason. Every Task change goes through the Coordinator.
 */
export class Evidence {
  readonly #store: Store;
  readonly #evidence: EvidenceStore;
  readonly #dataDir: string;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #newId: () => string;

  constructor(options: EvidenceOptions) {
    this.#store = options.store;
    this.#evidence = options.evidence;
    this.#dataDir = options.dataDir;
    this.#clock = options.clock;
    this.#log = options.log ?? silentLog;
    this.#newId = options.newId ?? ulid;
  }

  readonly outputHook: OutputHook = async ({ task, stage, output, usage }): Promise<Event | HookResult | undefined> => {
    const parsed = evidenceOutputSchema.safeParse(output);
    if (!parsed.success || task.state !== 'evidencing' || task.task_no === null) return undefined;
    const project = this.#store.getProject(task.project_id);
    if (project === undefined) return undefined;
    const { artifacts } = parsed.data;
    const round = task.review_round + 1;
    const files = await this.#resolve(stage.id, artifacts.map((artifact) => artifact.name));
    const result = ingestEvidence({
      artifacts,
      criteria: activeCriteria(sortedCriteria(this.#store.criteriaOf(task.id))),
      priorIds: priorRows(this.#evidence, task).map((row) => row.id),
      files,
      taskId: task.id,
      stageId: stage.id,
      project: project.name,
      taskNo: task.task_no,
      round,
      createdAt: this.#clock.now().toISOString(),
      newId: this.#newId,
    });
    const fields = { task_id: task.id, stage_id: stage.id, round };
    if (!result.ok) {
      this.#log.info({ event: 'evidence_missing', ...fields, reason: result.reason }, 'evidence_missing');
      return { type: 'evidence_missing', stage_id: stage.id, reason: result.reason, usage };
    }
    // Files first, each fsynced; the rows follow in the event's transaction (AD-8). A file whose row never
    // commits is swept at boot.
    for (const artifact of result.artifacts) await this.#evidence.put(artifact.source, artifact.row.path);
    this.#log.info({ event: 'evidence_ingested', ...fields, artifacts: result.artifacts.length }, 'evidence_ingested');
    return {
      event: { type: 'evidence_produced', stage_id: stage.id, usage },
      rows: (t) => {
        this.#evidence.supersedeRound(t.id, round);
        for (const artifact of result.artifacts) this.#evidence.insertEvidence(artifact.row);
      },
    };
  };

  /** Deletes Evidence files that have no row (AD-18). */
  sweepOrphans(): Promise<number> {
    return this.#evidence.sweepOrphans();
  }

  /** Each valid `name` that is a regular file in the `ANTIPOD_OUT` of one of the Stage's step runs, newest first. */
  async #resolve(stageId: string, names: readonly string[]): Promise<Map<string, IngestFile>> {
    const outs = this.#store.stepRunsOfStage(stageId).map((run) => join(this.#dataDir, 'steps', run.id, 'out'));
    const files = new Map<string, IngestFile>();
    for (const name of names) {
      if (files.has(name) || !isRelativeName(name)) continue;
      for (const out of outs) {
        const path = await fileInside(out, join(out, name));
        if (path === undefined) continue;
        const probe = await this.#evidence.probe(path);
        files.set(name, { path, bytes: probe.bytes, ...(probe.durationS === undefined ? {} : { durationS: probe.durationS }) });
        break;
      }
    }
    return files;
  }
}
