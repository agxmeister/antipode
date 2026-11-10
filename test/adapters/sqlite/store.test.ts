import { afterEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../../../src/core/domain/effects.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import type { Stage } from '../../../src/core/domain/stage.ts';
import type { Project, Task } from '../../../src/core/domain/task.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

const NOW = '2026-11-08T12:00:00.000Z';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

function setup() {
  const ts = openTestStore();
  open.push(ts);
  return ts;
}

function project(name: string): Project {
  return { id: ulid(), name, paused_at: null, created_at: NOW };
}

function task(projectId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: ulid(),
    project_id: projectId,
    kind: 'feature',
    task_no: null,
    state: 'draft',
    current_stage_id: null,
    budget_used: 0,
    budget_limit: 5,
    review_round: 0,
    resume_state: null,
    stuck_reason: null,
    waiting_reason: null,
    undo_expires_at: null,
    config_sha: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function stage(taskId: string, overrides: Partial<Stage> = {}): Stage {
  return { id: ulid(), task_id: taskId, role: 'implementer', attempt: 1, status: 'starting', reason: null, created_at: NOW, started_at: null, ended_at: null, ...overrides };
}

function effect(taskId: string | null, kind: 'integrate' | 'run_release' = 'integrate'): EffectRow {
  const e = { kind, task_id: taskId ?? 'x' } as const;
  return { effect_id: ulid(), task_id: taskId, kind, effect: e, status: 'pending', error: null, created_at: NOW, finished_at: null };
}

describe('SqliteStore', () => {
  it('migrations 0002 and 0003 create the STRICT Coordinator tables', () => {
    const ts = setup();
    const tables = ts.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['effects', 'projects', 'settings', 'stage_events', 'stages', 'task_dependencies', 'tasks']);
    for (const table of ['tasks', 'task_dependencies']) {
      const sql = ts.db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string };
      expect(sql.sql).toContain('STRICT');
    }
  });

  it('round-trips projects and tasks, patches tasks, and numbers them per Project', () => {
    const ts = setup();
    const p = project('alpha');
    ts.store.insertProject(p);
    expect(ts.store.getProject(p.id)).toEqual(p);
    expect(ts.store.listProjects()).toEqual([p]);

    const t = task(p.id);
    ts.store.insertTask(t);
    expect(ts.store.getTask(t.id)).toEqual(t);
    expect(ts.store.nextTaskNo(p.id)).toBe(1);
    ts.store.updateTask(t.id, { state: 'queued', task_no: 1, budget_used: 2, updated_at: '2026-11-08T12:00:01.000Z' });
    expect(ts.store.getTask(t.id)).toMatchObject({ state: 'queued', task_no: 1, budget_used: 2, updated_at: '2026-11-08T12:00:01.000Z' });
    expect(ts.store.nextTaskNo(p.id)).toBe(2);
    expect(ts.store.tasksInStates(['queued'])).toHaveLength(1);
    expect(ts.store.tasksInStates(['draft'])).toEqual([]);
    expect(ts.store.tasksInStates([])).toEqual([]);
  });

  it('refuses a patch outside the patchable columns and a patch of a missing row', () => {
    const ts = setup();
    const p = project('alpha');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    expect(() => ts.store.updateTask(t.id, { kind: 'bootstrap', updated_at: NOW } as never)).toThrow(/not patchable/);
    expect(() => ts.store.updateTask('nope', { updated_at: NOW })).toThrow(/not found/);
  });

  it('activeProjects lists only Projects with an ACTIVE Task', () => {
    const ts = setup();
    const [a, b, c] = [project('a'), project('b'), project('c')];
    for (const p of [a, b, c]) ts.store.insertProject(p);
    ts.store.insertTask(task(a.id, { state: 'draft' }));
    ts.store.insertTask(task(b.id, { state: 'implementing' }));
    ts.store.insertTask(task(b.id, { state: 'released' }));
    ts.store.insertTask(task(c.id, { state: 'released' }));
    expect(ts.store.activeProjects().map((p) => p.id)).toEqual([b.id]);
  });

  it('stages: insert, patch, query by status and task', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    const s1 = stage(t.id);
    const s2 = stage(t.id, { attempt: 2, status: 'running', started_at: NOW });
    ts.store.insertStage(s1);
    ts.store.insertStage(s2);
    expect(ts.store.getStage(s1.id)).toEqual(s1);
    expect(ts.store.stagesInStatus(['starting', 'running']).map((s) => s.id)).toEqual([s1.id, s2.id]);
    ts.store.updateStage(s1.id, { status: 'failed', reason: 'restart', ended_at: NOW });
    expect(ts.store.stagesInStatus(['starting'])).toEqual([]);
    expect(ts.store.stagesOfTask(t.id).map((s) => s.status)).toEqual(['failed', 'running']);
    expect(() => ts.store.updateStage(s1.id, { role: 'x' } as never)).toThrow(/not patchable/);
  });

  it('stage_events append in order and read back with their payload', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    ts.store.appendStageEvent({ id: ulid(), task_id: t.id, stage_id: null, event_type: 'new_draft', payload: '{"type":"new_draft"}', status: 'applied', ignore_reason: null, from_state: null, to_state: 'draft', created_at: NOW });
    ts.store.appendStageEvent({ id: ulid(), task_id: t.id, stage_id: 'old', event_type: 'implementer_done', payload: '{}', status: 'ignored', ignore_reason: 'stale', from_state: 'draft', to_state: null, created_at: NOW });
    expect(ts.store.stageEventsOfTask(t.id).map((e) => [e.event_type, e.status, e.ignore_reason])).toEqual([
      ['new_draft', 'applied', null],
      ['implementer_done', 'ignored', 'stale'],
    ]);
  });

  it('effects: pending in insertion order, mark done/failed, payload round-trips', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    const rows = [effect(t.id), effect(null, 'run_release'), effect(t.id, 'run_release')];
    for (const r of rows) ts.store.insertEffect(r);
    expect(ts.store.pendingEffects()).toEqual(rows);
    ts.store.markEffect(rows[0]!.effect_id, 'done', NOW);
    ts.store.markEffect(rows[1]!.effect_id, 'failed', NOW, 'boom');
    expect(ts.store.pendingEffects().map((r) => r.effect_id)).toEqual([rows[2]!.effect_id]);
    expect(ts.store.getEffect(rows[1]!.effect_id)).toMatchObject({ status: 'failed', error: 'boom', finished_at: NOW });
    expect(ts.store.effectsOfTask(t.id).map((r) => r.status)).toEqual(['done', 'pending']);
  });

  it('transaction rolls back every write when the function throws, and nests', () => {
    const ts = setup();
    const p = project('a');
    expect(() =>
      ts.store.transaction(() => {
        ts.store.insertProject(p);
        ts.store.transaction(() => ts.store.insertTask(task(p.id)));
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(ts.store.getProject(p.id)).toBeUndefined();
    expect(ts.store.tasksInStates(['draft'])).toEqual([]);
    expect(ts.store.transaction(() => 42)).toBe(42);
  });

  it('enforces foreign keys and the kind/status checks', () => {
    const ts = setup();
    expect(() => ts.store.insertTask(task('no-such-project'))).toThrow(/FOREIGN KEY/);
    const p = project('a');
    ts.store.insertProject(p);
    expect(() => ts.store.insertTask(task(p.id, { kind: 'hotfix' as never }))).toThrow(/CHECK/);
  });

  it('scheduler reads: queued oldest first, counts by state, bootstrap released', () => {
    const ts = setup();
    const [a, b] = [project('a'), project('b')];
    for (const p of [a, b]) ts.store.insertProject(p);
    const late = task(a.id, { state: 'queued', created_at: '2026-11-08T12:00:02.000Z' });
    const early = task(a.id, { state: 'queued', created_at: '2026-11-08T12:00:01.000Z' });
    for (const t of [late, early]) ts.store.insertTask(t);
    ts.store.insertTask(task(a.id, { state: 'implementing' }));
    ts.store.insertTask(task(b.id, { state: 'in_review' }));
    ts.store.insertTask(task(b.id, { kind: 'bootstrap', state: 'released' }));
    ts.store.insertTask(task(a.id, { kind: 'bootstrap', state: 'in_review' }));
    expect(ts.store.queuedTasks().map((t) => t.id)).toEqual([early.id, late.id]);
    expect(ts.store.countTasksInStates(['implementing', 'in_review'])).toBe(3);
    expect(ts.store.countTasksInStates(['queued'])).toBe(2);
    expect(ts.store.countTasksInStates([])).toBe(0);
    expect(ts.store.bootstrapReleased(a.id)).toBe(false);
    expect(ts.store.bootstrapReleased(b.id)).toBe(true);
  });

  it('dependencies: insert is idempotent, dependenciesOf returns the Tasks, foreign keys hold', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const [t, d1, d2] = [task(p.id), task(p.id, { state: 'merged', created_at: '2026-11-08T11:00:00.000Z' }), task(p.id, { state: 'implementing' })];
    for (const x of [t, d1, d2]) ts.store.insertTask(x);
    expect(ts.store.dependenciesOf(t.id)).toEqual([]);
    ts.store.insertDependency(t.id, d2.id);
    ts.store.insertDependency(t.id, d1.id);
    ts.store.insertDependency(t.id, d1.id);
    expect(ts.store.dependenciesOf(t.id).map((x) => [x.id, x.state])).toEqual([
      [d1.id, 'merged'],
      [d2.id, 'implementing'],
    ]);
    expect(ts.store.dependenciesOf(d1.id)).toEqual([]);
    expect(() => ts.store.insertDependency(t.id, 'no-such-task')).toThrow(/FOREIGN KEY/);
    expect(() => ts.store.insertDependency(t.id, t.id)).toThrow(/CHECK/);
  });

  it('latestNotify finds notify effects by Task, notice kind and key in any status', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const [t, other] = [task(p.id), task(p.id)];
    for (const x of [t, other]) ts.store.insertTask(x);
    const notify = (taskId: string, noticeKind: string, key: string): EffectRow => {
      const e = { kind: 'notify', notice_kind: noticeKind, task_id: taskId, payload: { key } } as const;
      return { effect_id: ulid(), task_id: taskId, kind: 'notify', effect: e, status: 'pending', error: null, created_at: NOW, finished_at: null };
    };
    const first = notify(t.id, 'usage_window_wait', 'r1');
    const second = notify(t.id, 'usage_window_wait', 'r2');
    for (const r of [first, second, notify(other.id, 'usage_window_wait', 'r3'), notify(t.id, 'usage_window_resumed', 'r1')]) ts.store.insertEffect(r);
    ts.store.markEffect(first.effect_id, 'done', NOW);
    expect(ts.store.latestNotify(t.id, 'usage_window_wait', 'r1')?.effect_id).toBe(first.effect_id);
    expect(ts.store.latestNotify(t.id, 'usage_window_wait')?.effect_id).toBe(second.effect_id);
    expect(ts.store.latestNotify(t.id, 'usage_window_wait', 'r3')).toBeUndefined();
    expect(ts.store.latestNotify(t.id, 'other')).toBeUndefined();
  });
});
