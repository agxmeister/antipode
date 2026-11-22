import { describe, expect, it } from 'vitest';
import type { StageEventRow } from '../../../src/core/domain/events.ts';
import { lapsOf, lastLapOf, stuckCause, triageCause } from '../../../src/core/domain/loop.ts';
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
});
