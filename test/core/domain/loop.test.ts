import { describe, expect, it } from 'vitest';
import type { StageEventRow } from '../../../src/core/domain/events.ts';
import { EVIDENCE_MISSING_REASON, lapsOf, lastLapOf, stuckCause, stuckExit, triageCause } from '../../../src/core/domain/loop.ts';
import type { Stage } from '../../../src/core/domain/stage.ts';

const AT = '2026-11-20T12:00:00.000Z';
let n = 0;
function stage(role: string, output?: unknown): Stage {
  n += 1;
  return { id: `s${String(n).padStart(3, '0')}`, task_id: 't', role, attempt: 1, status: output === undefined ? 'failed' : 'succeeded', reason: null, created_at: AT, started_at: AT, ended_at: AT, ...(output === undefined ? {} : { output }) };
}
function event(event_type: string, from_state: string | null, to_state: string | null, status: 'applied' | 'ignored' = 'applied'): StageEventRow {
  return { id: `e${event_type}${from_state}`, task_id: 't', stage_id: null, event_type, payload: '{}', status, ignore_reason: status === 'ignored' ? 'invalid' : null, from_state, to_state, created_at: AT } as StageEventRow;
}

describe('loop rows (AD-21)', () => {
  it('the last lap carries the evidence_missing reason and the Evidence-mode output that rejected the Evidence', () => {
    const applied = (stageId: string, event_type: string, payload: Record<string, unknown> = {}): StageEventRow =>
      ({ id: `e-${stageId}`, task_id: 't', stage_id: stageId, event_type, payload: JSON.stringify({ type: event_type, ...payload }), status: 'applied', ignore_reason: null, from_state: 'evidencing', to_state: 'verifying', created_at: AT }) as StageEventRow;
    const producer = stage('evidence-producer', { artifacts: [] });
    const missingLap = [stage('implementer', { status: 'done', summary: 'one' }), stage('validator', { verdict: 'pass', findings: [] }), producer];
    expect(lastLapOf(missingLap, undefined, [applied(producer.id, 'evidence_missing', { reason: 'no Evidence for AC2' })])?.evidenceMissing).toBe('no Evidence for AC2');
    expect(lastLapOf(missingLap, undefined, [applied(producer.id, 'evidence_missing')])?.evidenceMissing).toBe(EVIDENCE_MISSING_REASON);
    expect(lastLapOf(missingLap, undefined, [applied(producer.id, 'evidence_produced')])?.evidenceMissing).toBeUndefined();

    const rejecting = { verdict: 'nonblocking', findings: [{ criterion_id: 'AC1', blocking: false, note: 'blurry' }], evidence_verdicts: [{ evidence_id: 'E1', shows_criterion: false, note: 'cut off' }] };
    const verifier = stage('validator', rejecting);
    const lap = lastLapOf([...missingLap, verifier], undefined, [applied(producer.id, 'evidence_produced'), applied(verifier.id, 'evidence_rejected')]);
    expect(lap?.evidenceRejected).toEqual(rejecting);
    // The Evidence-mode findings are not the lap's Branch findings.
    expect(lap?.nonblocking).toEqual([]);
  });

  it('numbers Implementer laps from the Stages that returned output', () => {
    const stages = [stage('implementer'), stage('implementer', { status: 'done', summary: 'one' }), stage('validator', { verdict: 'pass', findings: [] }), stage('implementer', { status: 'blocked', summary: 'two' })];
    expect(lapsOf(stages)).toEqual([
      { n: 1, status: 'done', summary: 'one' },
      { n: 2, status: 'blocked', summary: 'two' },
    ]);
  });

  it('the last lap holds what came after the newest Implementer output, and ignores the Stage being briefed', () => {
    const blocking = { criterion_id: 'AC1', blocking: true, note: 'broken' };
    const minor = { criterion_id: 'AC2', blocking: false, note: 'minor' };
    const stages = [
      stage('implementer', { status: 'done', summary: 'one' }),
      stage('test', { step_run_id: 'r1', outcome: 'exited', exit_code: 1, log_tail: 'FAIL' }),
      stage('implementer', { status: 'done', summary: 'two' }),
      stage('test', { step_run_id: 'r2', outcome: 'exited', exit_code: 0, log_tail: null }),
      stage('validator', { verdict: 'blocking', findings: [blocking, minor] }),
      stage('triage', { decision: 'rerun', reason: 'try again' }),
    ];
    const current = stage('implementer');
    expect(lastLapOf([...stages, current], current.id)).toEqual({
      implementer: { status: 'done', summary: 'two' },
      blocking: [blocking],
      nonblocking: [minor],
      triageReason: 'try again',
    });
    expect(lastLapOf(stages.slice(0, 2))?.testFailure).toMatchObject({ exit_code: 1, log_tail: 'FAIL' });
    expect(lastLapOf([stage('implementer')])).toBeUndefined();
  });

  it('triageCause is the event that entered triage, skipping retries and a resume', () => {
    expect(triageCause([event('scheduler_start', 'queued', 'implementing'), event('budget_spent', 'implementing', 'triage'), event('stage_failed', 'triage', 'triage'), event('pause', 'triage', 'paused'), event('resume', 'paused', 'triage')])).toBe('budget_spent');
    expect(triageCause([event('budget_spent', 'implementing', 'triage'), event('rerun', 'triage', 'implementing'), event('nonblocking_findings', 'validating', 'triage')])).toBe('nonblocking_findings');
    expect(triageCause([event('implementer_blocked', 'implementing', 'triage', 'ignored')])).toBeUndefined();
  });

  it('stuckCause is the event that entered stuck, skipping a resume', () => {
    expect(stuckCause([event('deps_unsatisfiable', 'waiting_on_dependencies', 'stuck'), event('pause', 'stuck', 'paused'), event('resume', 'paused', 'stuck')])).toBe('deps_unsatisfiable');
    expect(stuckCause([event('deps_unsatisfiable', 'waiting_on_dependencies', 'stuck'), event('cancel', 'stuck', 'cancelled')])).toBe('deps_unsatisfiable');
    expect(stuckCause([event('stage_retries_exhausted', 'testing', 'stuck')])).toBe('stage_retries_exhausted');
    expect(stuckCause([])).toBeUndefined();
  });

  it('stuckExit is the event that ended the latest stuck visit, through a pause', () => {
    const into = event('reason_written', 'triage', 'stuck');
    const exit = (rows: StageEventRow[]) => stuckExit(rows)?.event_type;
    expect(exit([into, event('budget_raised', 'stuck', 'implementing')])).toBe('budget_raised');
    expect(exit([into, event('pause', 'stuck', 'paused')])).toBe('pause');
    expect(exit([into, event('pause', 'stuck', 'paused'), event('cancel', 'paused', 'cancelled')])).toBe('cancel');
    expect(exit([into, event('pause', 'stuck', 'paused'), event('amended', 'paused', 'implementing')])).toBe('amended');
    // A resumed visit ended later by a raise; ignored rows and a later pause elsewhere do not count.
    expect(
      exit([into, event('pause', 'stuck', 'paused'), event('resume', 'paused', 'stuck'), event('budget_raised', 'stuck', 'stuck', 'ignored'), event('budget_raised', 'stuck', 'implementing'), event('pause', 'implementing', 'paused'), event('cancel', 'paused', 'cancelled')]),
    ).toBe('budget_raised');
    // Two pauses in one visit: the second pause, then what ended it.
    const twice = [into, event('pause', 'stuck', 'paused'), event('resume', 'paused', 'stuck'), event('pause', 'stuck', 'paused')];
    expect(exit(twice)).toBe('pause');
    expect(exit([...twice, event('amended', 'paused', 'implementing')])).toBe('amended');
    expect(exit([into])).toBeUndefined();
  });
});
