import { describe, expect, it } from 'vitest';
import { stuckRedrawPayload } from '../../src/app/stuck.ts';
import type { StageEventRow } from '../../src/core/domain/events.ts';
import type { Task } from '../../src/core/domain/task.ts';

const AT = '2026-11-23T12:00:00.000Z';
function event(event_type: string, from_state: string, to_state: string, payload: Record<string, unknown> = {}): StageEventRow {
  return { id: `e-${event_type}-${from_state}`, task_id: 't', stage_id: null, event_type, payload: JSON.stringify({ type: event_type, ...payload }), status: 'applied', ignore_reason: null, from_state, to_state, created_at: AT } as StageEventRow;
}
const task = (state: string) => ({ id: 't', state }) as Task;
const into = event('reason_written', 'triage', 'stuck');

describe('the Stuck card redraw on a tap that cannot act (EXPERIENCE.md → Stale button)', () => {
  it('restores the buttons while the Task is stuck', () => {
    expect(stuckRedrawPayload(task('stuck'), [into])).toEqual({ mode: 'restore' });
  });

  it('otherwise shows the state line of the event that ended the visit', () => {
    expect(stuckRedrawPayload(task('implementing'), [into, event('budget_raised', 'stuck', 'implementing', { amount: 2 })])).toEqual({ closed: 'raised', amount: 2 });
    expect(stuckRedrawPayload(task('paused'), [into, event('pause', 'stuck', 'paused')])).toEqual({ closed: 'paused' });
    expect(stuckRedrawPayload(task('cancelled'), [into, event('pause', 'stuck', 'paused'), event('cancel', 'paused', 'cancelled')])).toEqual({ closed: 'cancelled' });
    expect(stuckRedrawPayload(task('implementing'), [into, event('amended', 'stuck', 'implementing')])).toEqual({ closed: 'amended' });
  });

  it('never brings the buttons back to a Task that is not stuck: with no exit found there is nothing to redraw', () => {
    expect(stuckRedrawPayload(task('implementing'), [into])).toBeUndefined();
    expect(stuckRedrawPayload(task('implementing'), [into, event('budget_raised', 'stuck', 'implementing')])).toEqual({ closed: 'raised' });
  });
});
