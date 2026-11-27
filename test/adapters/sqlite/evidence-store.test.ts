import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteEvidenceStore } from '../../../src/adapters/sqlite/evidence-store.ts';
import { mp4DurationSeconds } from '../../../src/adapters/sqlite/mp4.ts';
import type { EvidenceRow } from '../../../src/core/domain/evidence.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import { taskSchema } from '../../../src/core/domain/task.ts';
import { mp4Bytes } from '../../helpers/evidence.ts';
import { createTempHome } from '../../helpers/home.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

const NOW = '2026-11-27T12:00:00.000Z';
const open: TestStore[] = [];
afterEach(() => {
  for (const ts of open.splice(0)) ts.close();
});

function setup() {
  const ts = openTestStore();
  open.push(ts);
  const dataDir = join(createTempHome().root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const projectId = ulid();
  ts.store.insertProject({ id: projectId, name: 'training', paused_at: null, telegram_chat_id: null, repo_url: null, exclusive_capabilities: [], created_at: NOW });
  const task = taskSchema.parse({
    id: ulid(), project_id: projectId, kind: 'feature', task_no: 4, state: 'evidencing', current_stage_id: null, budget_used: 1, budget_limit: 5,
    review_round: 0, resume_state: null, stuck_reason: null, waiting_reason: null, undo_expires_at: null, config_sha: null, created_at: NOW, updated_at: NOW,
  });
  ts.store.insertTask(task);
  return { ts, dataDir, task, evidence: new SqliteEvidenceStore(ts.db, dataDir) };
}

function row(taskId: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  const id = overrides.id ?? ulid();
  return {
    id, task_id: taskId, round: 1, criterion_id: 'AC1', kind: 'screenshot', path: `evidence/training/4/r1/${id}.png`, bytes: 3,
    degraded: null, before_of: null, caption: 'the timer', stage_id: null, superseded: false, created_at: NOW, ...overrides,
  };
}

describe('SqliteEvidenceStore (AD-8)', () => {
  it('round-trips rows per round; a repeat ingest supersedes the round, and nothing else changes', () => {
    const { ts, task, evidence } = setup();
    const first = row(task.id, { degraded: 'emulator', before_of: 'X' });
    evidence.insertEvidence(first);
    evidence.insertEvidence(row(task.id, { round: 2 }));
    expect(evidence.evidenceOf(task.id, 1)).toEqual([first]);
    // Repeat: supersede, then the new rows, in one transaction.
    const second = row(task.id);
    ts.store.transaction(() => {
      evidence.supersedeRound(task.id, 1);
      evidence.insertEvidence(second);
    });
    expect(evidence.evidenceOf(task.id, 1)).toEqual([{ ...first, superseded: true }, second]);
    expect(evidence.evidenceOf(task.id, 2)[0]?.superseded).toBe(false);
  });

  it('rows are never updated (but for superseded) or deleted', () => {
    const { ts, task, evidence } = setup();
    const first = row(task.id);
    evidence.insertEvidence(first);
    expect(() => ts.db.prepare('DELETE FROM evidence').run()).toThrow(/never deleted/);
    expect(() => ts.db.prepare("UPDATE evidence SET caption = 'x'").run()).toThrow(/immutable/);
    evidence.supersedeRound(task.id, 1);
    expect(() => ts.db.prepare('UPDATE evidence SET superseded = 0').run()).toThrow(/immutable/);
  });

  it('put copies byte for byte and refuses to overwrite; fileOf names the copy', async () => {
    const { dataDir, evidence } = setup();
    const source = join(dataDir, 'src.bin');
    writeFileSync(source, Buffer.from([1, 2, 3, 250]));
    await evidence.put(source, 'evidence/training/4/r1/A.bin');
    expect(readFileSync(evidence.fileOf('evidence/training/4/r1/A.bin'))).toEqual(Buffer.from([1, 2, 3, 250]));
    await expect(evidence.put(source, 'evidence/training/4/r1/A.bin')).rejects.toThrow();
  });

  it('crash: a file with no row is swept; a file with a row stays', async () => {
    const { dataDir, task, evidence } = setup();
    const kept = row(task.id);
    evidence.insertEvidence(kept);
    mkdirSync(join(dataDir, 'evidence', 'training', '4', 'r1'), { recursive: true });
    writeFileSync(evidence.fileOf(kept.path), 'png');
    const orphan = join(dataDir, 'evidence', 'training', '4', 'r1', 'ORPHAN.png');
    writeFileSync(orphan, 'half');
    expect(await evidence.sweepOrphans()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(evidence.fileOf(kept.path))).toBe(true);
  });

  it('probe gives the size, and for videos the mvhd duration (v0, v1, moov last); null when unreadable', async () => {
    const { dataDir, evidence } = setup();
    const write = (name: string, data: Buffer | string): string => {
      const path = join(dataDir, name);
      writeFileSync(path, data);
      return path;
    };
    expect(await evidence.probe(write('a.png', 'abcd'))).toEqual({ bytes: 4 });
    const v0 = mp4Bytes(12.5);
    expect(await evidence.probe(write('a.mp4', v0))).toEqual({ bytes: v0.length, durationS: 12.5 });
    expect(await mp4DurationSeconds(write('b.mov', mp4Bytes(61, { version: 1, timescale: 600 })))).toBe(61);
    expect(await mp4DurationSeconds(write('c.m4v', mp4Bytes(30, { moovLast: true })))).toBe(30);
    expect((await evidence.probe(write('d.mp4', 'not a movie at all'))).durationS).toBeNull();
  });

  it('stepRunsOfStage lists a Stage’s step runs newest first', () => {
    const { ts, task } = setup();
    const stageId = ulid();
    ts.store.insertStage({ id: stageId, task_id: task.id, role: 'evidence-producer', attempt: 1, status: 'running', reason: null, created_at: NOW, started_at: NOW, ended_at: null });
    const ids = [ulid(), ulid(), ulid()];
    for (const [i, id] of ids.entries()) {
      ts.store.insertStepRun({ id, task_id: task.id, stage_id: i === 2 ? null : stageId, step: 'evidence', runner: 'container', status: 'finished', outcome: 'exited', exit_code: 0, reason: null, started_at: NOW, ended_at: NOW });
    }
    expect(ts.store.stepRunsOfStage(stageId).map((run) => run.id)).toEqual([ids[1], ids[0]]);
  });
});
