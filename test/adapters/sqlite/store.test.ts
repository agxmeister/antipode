import { afterEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../../../src/core/domain/effects.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import type { Stage } from '../../../src/core/domain/stage.ts';
import type { StepRun } from '../../../src/core/domain/step.ts';
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
  return { id: ulid(), name, paused_at: null, telegram_chat_id: null, repo_url: null, exclusive_capabilities: [], created_at: NOW };
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
  it('migrations 0002 to 0006 create the STRICT Coordinator, Telegram and step tables', () => {
    const ts = setup();
    const tables = ts.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'callbacks',
      'capability_leases',
      'effects',
      'outbox',
      'projects',
      'settings',
      'stage_events',
      'stages',
      'step_runs',
      'task_dependencies',
      'tasks',
      'telegram_messages',
    ]);
    for (const table of ['tasks', 'task_dependencies', 'outbox', 'callbacks', 'telegram_messages', 'step_runs', 'capability_leases']) {
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

  it('finds Projects by repo_url and by name; repo_url is unique, NULLs allowed', () => {
    const ts = setup();
    const a = { ...project('alpha'), repo_url: 'git@github.com:a/alpha.git' };
    ts.store.insertProject(a);
    ts.store.insertProject(project('beta'));
    ts.store.insertProject(project('gamma'));
    expect(ts.store.projectByRepo('git@github.com:a/alpha.git')).toEqual(a);
    expect(ts.store.projectByRepo('git@github.com:a/other.git')).toBeUndefined();
    expect(ts.store.projectByName('beta')?.repo_url).toBeNull();
    expect(ts.store.projectByName('delta')).toBeUndefined();
    expect(() => ts.store.insertProject({ ...project('epsilon'), repo_url: a.repo_url })).toThrow(/UNIQUE/);
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

  it('settings get and set, overwriting the value', () => {
    const ts = setup();
    expect(ts.store.getSetting('telegram.last_update_id')).toBeUndefined();
    ts.store.setSetting('telegram.last_update_id', '10', NOW);
    ts.store.setSetting('telegram.last_update_id', '11', NOW);
    expect(ts.store.getSetting('telegram.last_update_id')).toBe('11');
  });

  it('binds a Project to one chat; a chat binds at most one Project', () => {
    const ts = setup();
    const [a, b] = [project('a'), project('b')];
    for (const p of [a, b]) ts.store.insertProject(p);
    expect(ts.store.projectByChat(-100)).toBeUndefined();
    ts.store.bindProjectChat(a.id, -100);
    expect(ts.store.projectByChat(-100)).toMatchObject({ id: a.id, telegram_chat_id: -100 });
    expect(() => ts.store.bindProjectChat(b.id, -100)).toThrow(/UNIQUE/);
    ts.store.bindProjectChat(a.id, null);
    expect(ts.store.projectByChat(-100)).toBeUndefined();
    expect(() => ts.store.bindProjectChat('nope', -1)).toThrow(/not found/);
  });

  it('enqueues an outbox group with consecutive per-chat sequences, idempotent by effect_id', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    const msg = (text: string) => ({ kind: 'notice', payload: { method: 'sendMessage' as const, params: { text } }, task_id: t.id });
    const first = ts.store.enqueueOutbox(-1, [msg('a'), msg('b')], 'eff-1', NOW);
    expect(first.map((r) => [r.sequence, r.status, r.attempts])).toEqual([
      [1, 'pending', 0],
      [2, 'pending', 0],
    ]);
    expect(ts.store.enqueueOutbox(-1, [msg('again')], 'eff-1', NOW).map((r) => r.id)).toEqual(first.map((r) => r.id));
    ts.store.enqueueOutbox(-2, [msg('other chat')], 'eff-2', NOW);
    const third = ts.store.enqueueOutbox(-1, [msg('c')], null, NOW);
    expect(third[0]?.sequence).toBe(3);
    expect(ts.store.outboxOfChat(-1).map((r) => r.payload.params['text'])).toEqual(['a', 'b', 'c']);
    expect(ts.store.outboxHeads().map((r) => [r.chat_id, r.sequence])).toEqual([
      [-2, 1],
      [-1, 1],
    ]);

    const head = first[0]!;
    ts.store.markOutboxAttempt(head.id, 1, '2026-11-08T12:00:01.000Z', 'boom');
    expect(ts.store.getOutbox(head.id)).toMatchObject({ status: 'pending', attempts: 1, error: 'boom', next_attempt_at: '2026-11-08T12:00:01.000Z' });
    ts.store.markOutboxSent(head.id, 77, NOW);
    expect(ts.store.getOutbox(head.id)).toMatchObject({ status: 'sent', sent_message_id: 77, attempts: 2, error: null, sent_at: NOW });
    ts.store.markOutboxFailed(first[1]!.id, 6, 'gone');
    expect(ts.store.getOutbox(first[1]!.id)).toMatchObject({ status: 'failed', attempts: 6, error: 'gone' });
    expect(ts.store.outboxHeads().map((r) => [r.chat_id, r.sequence])).toEqual([
      [-2, 1],
      [-1, 3],
    ]);
  });

  it('finds the latest card send of a Task and round in the outbox and among sent messages', () => {
    const ts = setup();
    const p = project('a');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    const card = (round: number) => ({ kind: 'review_card', round, task_id: t.id, payload: { method: 'sendMessage' as const, params: { text: `r${round}` } } });
    const [r1] = ts.store.enqueueOutbox(-1, [card(1)], null, NOW);
    const [r2] = ts.store.enqueueOutbox(-1, [card(2)], null, '2026-11-08T12:00:05.000Z');
    ts.store.enqueueOutbox(-1, [{ kind: 'review_card', task_id: t.id, round: 2, payload: { method: 'editMessageReplyMarkup', params: {} } }], null, '2026-11-08T12:00:09.000Z');
    expect(ts.store.latestCardOutbox(t.id)?.id).toBe(r2?.id);
    expect(ts.store.latestCardOutbox(t.id, 1)?.id).toBe(r1?.id);
    expect(ts.store.latestCardOutbox(t.id, 3)).toBeUndefined();

    expect(ts.store.latestCardOfTask(t.id)).toBeUndefined();
    ts.store.insertTelegramMessage({ chat_id: -1, message_id: 5, task_id: t.id, round: 1, kind: 'review_card' });
    ts.store.insertTelegramMessage({ chat_id: -1, message_id: 6, task_id: t.id, round: 1, kind: 'evidence' });
    expect(ts.store.latestCardOfTask(t.id)).toEqual({ chat_id: -1, message_id: 5, task_id: t.id, round: 1, kind: 'review_card' });
    ts.store.insertTelegramMessage({ chat_id: -1, message_id: 5, task_id: t.id, round: 2, kind: 'review_card' });
    expect(ts.store.getTelegramMessage(-1, 5)?.round).toBe(2);
  });

  it('round-trips callbacks', () => {
    const ts = setup();
    const row = { id: ulid(), command: 'accept', task_id: null, round: 1, args: { finding: 'P1' }, expires_at: null, created_at: NOW };
    ts.store.insertCallback(row);
    expect(ts.store.getCallback(row.id)).toEqual(row);
    expect(ts.store.getCallback('missing')).toBeUndefined();
  });
});

describe('SqliteStore: step runs, leases and exclusive capabilities (AD-7, AD-11)', () => {
  function stepRun(taskId: string, overrides: Partial<StepRun> = {}): StepRun {
    return {
      id: ulid(),
      task_id: taskId,
      stage_id: null,
      step: 'build',
      runner: 'host',
      status: 'running',
      outcome: null,
      exit_code: null,
      reason: null,
      started_at: NOW,
      ended_at: null,
      ...overrides,
    };
  }

  it('round-trips Project exclusive capabilities and replaces them', () => {
    const ts = setup();
    const p = { ...project('alpha'), exclusive_capabilities: ['unity-editor'] };
    ts.store.insertProject(p);
    expect(ts.store.getProject(p.id)?.exclusive_capabilities).toEqual(['unity-editor']);
    ts.store.setProjectExclusiveCapabilities(p.id, ['a', 'b']);
    expect(ts.store.projectByName('alpha')?.exclusive_capabilities).toEqual(['a', 'b']);
    expect(() => ts.store.setProjectExclusiveCapabilities('missing', [])).toThrow(/not found/);
  });

  it('inserts a step run, finishes it and lists by status', () => {
    const ts = setup();
    const p = project('alpha');
    ts.store.insertProject(p);
    const t = task(p.id);
    ts.store.insertTask(t);
    const s = stage(t.id);
    ts.store.insertStage(s);
    const run = stepRun(t.id, { stage_id: s.id });
    ts.store.insertStepRun(run);
    expect(ts.store.getStepRun(run.id)).toEqual(run);
    expect(ts.store.stepRunsInStatus(['running']).map((r) => r.id)).toEqual([run.id]);
    ts.store.finishStepRun(run.id, { status: 'finished', outcome: 'exited', exit_code: 3, reason: null, ended_at: NOW });
    expect(ts.store.getStepRun(run.id)).toMatchObject({ status: 'finished', outcome: 'exited', exit_code: 3, ended_at: NOW });
    expect(ts.store.stepRunsInStatus(['running'])).toEqual([]);
    expect(() => ts.store.finishStepRun('missing', { status: 'failed', outcome: null, exit_code: null, reason: 'x', ended_at: NOW })).toThrow(/not found/);
  });

  it('a capability has at most one lease; release frees it; clear empties the table', () => {
    const ts = setup();
    const p = project('alpha');
    ts.store.insertProject(p);
    const a = task(p.id);
    const b = task(p.id);
    ts.store.insertTask(a);
    ts.store.insertTask(b);
    const runA = stepRun(a.id);
    const runB = stepRun(b.id);
    ts.store.insertStepRun(runA);
    ts.store.insertStepRun(runB);
    expect(ts.store.acquireLease({ capability: 'emu', task_id: a.id, step_run_id: runA.id, acquired_at: NOW })).toBe(true);
    expect(ts.store.acquireLease({ capability: 'emu', task_id: b.id, step_run_id: runB.id, acquired_at: NOW })).toBe(false);
    expect(ts.store.listLeases()).toEqual([{ capability: 'emu', task_id: a.id, step_run_id: runA.id, acquired_at: NOW }]);
    ts.store.releaseLease(runA.id);
    expect(ts.store.listLeases()).toEqual([]);
    expect(ts.store.acquireLease({ capability: 'emu', task_id: b.id, step_run_id: runB.id, acquired_at: NOW })).toBe(true);
    ts.store.clearLeases();
    expect(ts.store.listLeases()).toEqual([]);
  });

  it('capabilityLeasedByOtherProject sees only other Projects’ leases of the named capabilities', () => {
    const ts = setup();
    const alpha = project('alpha');
    const beta = project('beta');
    ts.store.insertProject(alpha);
    ts.store.insertProject(beta);
    const t = task(beta.id);
    ts.store.insertTask(t);
    const run = stepRun(t.id);
    ts.store.insertStepRun(run);
    ts.store.acquireLease({ capability: 'unity-editor', task_id: t.id, step_run_id: run.id, acquired_at: NOW });
    expect(ts.store.capabilityLeasedByOtherProject(alpha.id, ['unity-editor'])).toBe(true);
    expect(ts.store.capabilityLeasedByOtherProject(alpha.id, ['android-emulator'])).toBe(false);
    expect(ts.store.capabilityLeasedByOtherProject(alpha.id, [])).toBe(false);
    expect(ts.store.capabilityLeasedByOtherProject(beta.id, ['unity-editor'])).toBe(false);
  });
});
