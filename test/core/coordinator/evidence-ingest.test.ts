import { describe, expect, it } from 'vitest';
import { ingestEvidence, isRelativeName, type IngestFile, type IngestInput } from '../../../src/core/coordinator/evidence-ingest.ts';
import type { CriterionRow } from '../../../src/core/domain/contract.ts';
import type { EvidenceArtifact } from '../../../src/core/domain/stage-output/evidence.ts';

const MB = 1024 * 1024;

function criterion(acNo: number): CriterionRow {
  return { task_id: 't', ac_no: acNo, text: `criterion ${acNo}`, required_evidence: 'screenshot', infeasible_wanted: null, infeasible_proposal: null, status: 'active' };
}

function artifact(name: string, criterionId: string, extra: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return { name, criterion_id: criterionId, kind: 'screenshot', degraded: null, caption: `shows ${criterionId}`, ...extra };
}

function input(artifacts: EvidenceArtifact[], files: Record<string, Partial<IngestFile>> = {}, extra: Partial<IngestInput> = {}): IngestInput {
  let n = 0;
  const map = new Map<string, IngestFile>();
  for (const a of artifacts) map.set(a.name, { path: `/out/${a.name}`, bytes: 1000, ...(a.name.endsWith('.mp4') ? { durationS: 5 } : {}) });
  for (const [name, file] of Object.entries(files)) map.set(name, { path: `/out/${name}`, bytes: 1000, ...map.get(name), ...file });
  return {
    artifacts,
    criteria: [criterion(1), criterion(2)],
    priorIds: [],
    files: map,
    taskId: 't',
    stageId: 's',
    project: 'training',
    taskNo: 4,
    round: 1,
    createdAt: '2026-11-27T12:00:00.000Z',
    newId: () => `E${++n}`,
    ...extra,
  };
}

function reason(result: ReturnType<typeof ingestEvidence>): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
}

describe('ingestEvidence (AD-8 checks in order)', () => {
  it('happy: one row per artifact under r<round>, superseded false, the source path kept for the copy', () => {
    const result = ingestEvidence(input([artifact('timer.mp4', 'AC1', { kind: 'screencast' }), artifact('shots/default.PNG', 'AC2', { degraded: 'emulator only' })]));
    expect(result).toEqual({
      ok: true,
      artifacts: [
        { source: '/out/timer.mp4', row: expect.objectContaining({ id: 'E1', path: 'evidence/training/4/r1/E1.mp4', criterion_id: 'AC1', kind: 'screencast', round: 1, superseded: false, before_of: null, stage_id: 's' }) },
        { source: '/out/shots/default.PNG', row: expect.objectContaining({ id: 'E2', path: 'evidence/training/4/r1/E2.png', degraded: 'emulator only', bytes: 1000 }) },
      ],
    });
  });

  it('missing AC: no Evidence for AC2', () => {
    expect(reason(ingestEvidence(input([artifact('a.png', 'AC1')])))).toBe('no Evidence for AC2');
  });

  it('a name outside ANTIPOD_OUT or not found in any step output is refused first', () => {
    expect(reason(ingestEvidence(input([artifact('../x.png', 'AC1'), artifact('b.png', 'AC2')])))).toContain('not a path relative to ANTIPOD_OUT');
    expect(reason(ingestEvidence(input([artifact('/etc/passwd', 'AC1'), artifact('b.png', 'AC2')])))).toContain('not a path relative');
    const missing = input([artifact('a.png', 'AC1'), artifact('gone.png', 'AC2')]);
    (missing.files as Map<string, IngestFile>).delete('gone.png');
    expect(reason(ingestEvidence(missing))).toBe('gone.png is not a file in the output of any step this Stage ran');
    expect(isRelativeName('shots/a.png')).toBe(true);
    expect(isRelativeName('a/../b.png')).toBe(false);
  });

  it('an unknown or dropped criterion is refused', () => {
    expect(reason(ingestEvidence(input([artifact('a.png', 'AC1'), artifact('b.png', 'AC2'), artifact('c.png', 'AC3')])))).toBe('c.png names AC3, which is not an active criterion');
  });

  it('too big: a 51 MB file is refused with its size', () => {
    expect(reason(ingestEvidence(input([artifact('a.png', 'AC1'), artifact('b.png', 'AC2')], { 'b.png': { bytes: 51 * MB } })))).toBe('b.png is 51.0 MB; the limit is 50 MB');
    expect(ingestEvidence(input([artifact('a.png', 'AC1'), artifact('b.png', 'AC2')], { 'b.png': { bytes: 50 * MB } })).ok).toBe(true);
  });

  it('too long: a 61 s mp4 is refused with its duration; an unreadable one too', () => {
    const artifacts = [artifact('a.mp4', 'AC1', { kind: 'screencast' }), artifact('b.png', 'AC2')];
    expect(reason(ingestEvidence(input(artifacts, { 'a.mp4': { durationS: 61 } })))).toBe('a.mp4 lasts 61.0 s; the limit is 60 s');
    expect(reason(ingestEvidence(input(artifacts, { 'a.mp4': { durationS: null } })))).toBe('the duration of a.mp4 cannot be read');
    expect(ingestEvidence(input(artifacts, { 'a.mp4': { durationS: 60 } })).ok).toBe(true);
  });

  it('a .webm, .mkv or .avi is refused as not playable inline', () => {
    expect(reason(ingestEvidence(input([artifact('a.webm', 'AC1', { kind: 'screencast' }), artifact('b.png', 'AC2')])))).toContain('.webm video, which Telegram cannot play inline');
  });

  it('bad before_of: an unknown id is refused; a prior id or a screenshot name is accepted, the name stored as its id', () => {
    expect(reason(ingestEvidence(input([artifact('a.png', 'AC1', { before_of: 'NOPE' }), artifact('b.png', 'AC2')])))).toContain('before_of of a.png');
    // A name of a non-screenshot is no before image.
    expect(ingestEvidence(input([artifact('a.png', 'AC1', { before_of: 'v.mp4' }), artifact('v.mp4', 'AC2', { kind: 'screencast' })])).ok).toBe(false);
    const result = ingestEvidence(
      input([artifact('before.png', 'AC1'), artifact('after.png', 'AC1', { before_of: 'before.png' }), artifact('b.png', 'AC2', { before_of: 'PRIOR1' })], {}, { priorIds: ['PRIOR1'] }),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.artifacts.map((a) => a.row.before_of)).toEqual([null, 'E1', 'PRIOR1']);
  });

  it('the checks run in their fixed order: a size failure is not reported while a criterion is uncovered', () => {
    expect(reason(ingestEvidence(input([artifact('a.png', 'AC1')], { 'a.png': { bytes: 60 * MB } })))).toBe('no Evidence for AC2');
  });
});
