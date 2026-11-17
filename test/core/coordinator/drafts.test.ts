import { afterEach, describe, expect, it } from 'vitest';
import { Coordinator, type CoordinatorPolicy } from '../../../src/core/coordinator/coordinator.ts';
import { DRAFT_CARD } from '../../../src/core/coordinator/transitions.ts';
import { recordAnswers, writeDraft, type DraftInput } from '../../../src/core/coordinator/drafts.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

const POLICY: CoordinatorPolicy = { limits: { iteration_budget: 5, undo_accept_ms: 10_000, undo_discard_ms: 60_000 }, roles: {} };
const KINDS = ['screenshot', 'screencast'] as const;

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

async function setup() {
  const ts = openTestStore();
  open.push(ts);
  const clock = fakeClock();
  const coordinator = new Coordinator({ store: ts.store, clock, policy: () => POLICY });
  const project = await coordinator.createProject('training', '/remote');
  const now = () => clock.now().toISOString();
  /** A draft in awaiting_approval with `input` written as its contract. */
  const ready = async (input: Partial<DraftInput> = {}) => {
    const task = await coordinator.createTask({
      project_id: project.id,
      kind: 'feature',
      ready: true,
      rows: (t) => writeDraft(ts.store, t.id, { goal: 'a goal', criteria: [{ text: 'it shows', required_evidence: 'screenshot' }], questions: [], ...input }, KINDS, now()),
    });
    expect(task.state).toBe('awaiting_approval');
    return task;
  };
  return { ...ts, clock, coordinator, project, ready, now };
}

describe('draft rows (AD-16, AD-21)', () => {
  it('writeDraft keeps named or repeated criteria, numbers new ones after the highest ever, drops the rest, and bumps the version', async () => {
    const c = await setup();
    const task = await c.ready({ criteria: [{ text: 'a', required_evidence: 'screenshot' }, { text: 'b', required_evidence: 'screenshot' }, { text: 'c', required_evidence: 'screenshot' }] });
    writeDraft(c.store, task.id, { goal: 'g2', criteria: [{ ac: 3, text: 'c, sharper', required_evidence: 'screencast' }, { text: 'a', required_evidence: 'screenshot' }, { text: 'd', required_evidence: 'screenshot' }], questions: [] }, KINDS, c.now());
    expect(c.store.criteriaOf(task.id).map((x) => [x.ac_no, x.text, x.status])).toEqual([
      [1, 'a', 'active'],
      [2, 'b', 'dropped'],
      [3, 'c, sharper', 'active'],
      [4, 'd', 'active'],
    ]);
    // A dropped number is never handed out again, even to the same text.
    writeDraft(c.store, task.id, { goal: 'g3', criteria: [{ ac: 2, text: 'b', required_evidence: 'screenshot' }], questions: [] }, KINDS, c.now());
    expect(c.store.criteriaOf(task.id).filter((x) => x.status === 'active').map((x) => x.ac_no)).toEqual([5]);
    expect(c.store.latestContract(task.id)).toMatchObject({ version: 3, goal: 'g3' });
  });

  it('a revision replaces open questions, keeps answered ones and caps open ones at two; answers fill open questions in order', async () => {
    const c = await setup();
    const task = await c.ready({ questions: [{ text: 'q1', quick_answers: ['Yes'] }, { text: 'q2', quick_answers: [] }] });
    expect(recordAnswers(c.store, task.id, ['Yes'])).toBe(1);
    writeDraft(c.store, task.id, { goal: 'g', criteria: [{ text: 'it shows', required_evidence: 'screenshot' }], questions: [{ text: 'q3', quick_answers: [] }, { text: 'q4', quick_answers: [] }, { text: 'q5', quick_answers: [] }] }, KINDS, c.now());
    expect(c.store.questionsOf(task.id).map((q) => [q.q_no, q.text, q.answer])).toEqual([
      [1, 'q1', 'Yes'],
      [2, 'q3', null],
      [3, 'q4', null],
    ]);
  });
});

describe('draft commands (AD-9, CAP-8, CAP-9)', () => {
  it('createTask with intake starts the Intake Stage in the creation transaction and records the source', async () => {
    const c = await setup();
    const task = await c.coordinator.createTask({ project_id: c.project.id, kind: 'feature', intake: true, source: { text: 'add a timer' } });
    expect(task).toMatchObject({ state: 'draft', task_no: null });
    const [stage] = c.store.stagesOfTask(task.id);
    expect(stage).toMatchObject({ role: 'intake', attempt: 1, status: 'starting' });
    expect(task.current_stage_id).toBe(stage!.id);
    expect(c.store.effectsOfTask(task.id)).toMatchObject([{ kind: 'start_stage', effect: { stage_id: stage!.id, role: 'intake' } }]);
    expect(JSON.parse(c.store.stageEventsOfTask(task.id)[0]!.payload)).toEqual({ type: 'new_draft', source: { text: 'add a timer' } });
    await expect(c.coordinator.createTask({ project_id: c.project.id, kind: 'bootstrap', intake: true })).rejects.toThrow(/no draft/);
  });

  it('a quick answer edits the row and queues a card render; outside awaiting_approval or twice it does nothing', async () => {
    const c = await setup();
    const task = await c.ready({ questions: [{ text: 'q1', quick_answers: ['Yes', 'No'] }] });
    const renders = () => c.store.effectsOfTask(task.id).filter((row) => row.effect.kind === 'notify' && row.effect.notice_kind === DRAFT_CARD).length;
    expect(renders()).toBe(1);
    expect(await c.coordinator.answerQuestion(task.id, 1, 'No')).toBe(true);
    expect(await c.coordinator.answerQuestion(task.id, 1, 'Yes')).toBe(false);
    expect(await c.coordinator.answerQuestion(task.id, 9, 'Yes')).toBe(false);
    expect(renders()).toBe(2);
    expect(c.store.latestContract(task.id)?.version).toBe(1);
    await c.coordinator.applyEvent(task.id, { type: 'discarded' });
    expect(await c.coordinator.useProposal(task.id, 1)).toBe(false);
    expect(await c.coordinator.dropCriterion(task.id, 1)).toBe(false);
  });

  it('approval is refused with the reason on the card while a question is open or a criterion infeasible', async () => {
    const c = await setup();
    const task = await c.ready({ questions: [{ text: 'q1', quick_answers: [] }] });
    expect(await c.coordinator.approveDraft(task.id, { config_sha: 'sha', evidence_kinds: ['screenshot'] })).toEqual({ ok: false, reason: 'answer Q1 first' });
    expect(c.store.effectsOfTask(task.id).at(-1)?.effect).toEqual({ kind: 'notify', notice_kind: DRAFT_CARD, task_id: task.id, payload: { refusal: 'answer Q1 first' } });
    await c.coordinator.answerQuestion(task.id, 1, 'yes');
    // The Recipe at main no longer declares screenshot.
    expect(await c.coordinator.approveDraft(task.id, { config_sha: 'sha', evidence_kinds: ['file'] })).toEqual({ ok: false, reason: 'resolve AC1 first' });
    // A stale Approve that reaches the Coordinator as a raw event is refused too.
    expect(await c.coordinator.applyEvent(task.id, { type: 'approved', config_sha: 'sha', evidence_kinds: ['file'] })).toEqual({ applied: false, ignored: 'invalid' });
    expect(await c.coordinator.approveDraft(task.id, { config_sha: 'sha', evidence_kinds: ['screenshot'] })).toEqual({ ok: true, task_no: 1 });
    expect(c.store.getTask(task.id)).toMatchObject({ state: 'queued', task_no: 1, config_sha: 'sha', budget_used: 0 });
    expect(await c.coordinator.approveDraft(task.id, { config_sha: 'sha', evidence_kinds: ['screenshot'] })).toEqual({ ok: false, reason: 'this draft is no longer open' });
  });

  it('dependencies from the contract: recorded on approval; a missing Task, a bootstrap Task or itself refuses', async () => {
    const c = await setup();
    const bootstrap = await c.coordinator.createTask({ project_id: c.project.id, kind: 'bootstrap' });
    expect(bootstrap.task_no).toBe(1);
    const first = await c.ready();
    expect(await c.coordinator.approveDraft(first.id, { config_sha: null, evidence_kinds: ['screenshot'] })).toEqual({ ok: true, task_no: 2 });

    const onBootstrap = await c.ready({ depends_on: [1] });
    expect(await c.coordinator.approveDraft(onBootstrap.id, { config_sha: null, evidence_kinds: ['screenshot'] })).toEqual({ ok: false, reason: '#1 is a bootstrap Task' });
    const onMissing = await c.ready({ depends_on: [9] });
    expect(await c.coordinator.approveDraft(onMissing.id, { config_sha: null, evidence_kinds: ['screenshot'] })).toEqual({ ok: false, reason: '#9 does not exist' });
    const onItself = await c.ready({ depends_on: [3] });
    expect(await c.coordinator.approveDraft(onItself.id, { config_sha: null, evidence_kinds: ['screenshot'] })).toEqual({ ok: false, reason: 'a Task cannot depend on itself' });
    expect(c.store.getTask(onItself.id)?.state).toBe('awaiting_approval');

    const onFirst = await c.ready({ depends_on: [2] });
    expect(await c.coordinator.approveDraft(onFirst.id, { config_sha: null, evidence_kinds: ['screenshot'] })).toEqual({ ok: true, task_no: 3 });
    expect(c.store.dependenciesOf(onFirst.id).map((t) => t.id)).toEqual([first.id]);
  });

  it('a dependency cycle through recorded dependencies refuses approval', async () => {
    const c = await setup();
    const a = await c.ready();
    await c.coordinator.approveDraft(a.id, { config_sha: null, evidence_kinds: ['screenshot'] });
    const b = await c.ready({ depends_on: [1] });
    // Plant the impossible edge #1 → b to prove the walk finds it.
    c.store.insertDependency(a.id, b.id);
    expect(await c.coordinator.approveDraft(b.id, { config_sha: null, evidence_kinds: ['screenshot'] })).toEqual({ ok: false, reason: 'depending on #1 makes a cycle' });
  });

  it('requestInboxScan queues one scan_inbox per Project while one is pending', async () => {
    const c = await setup();
    expect(await c.coordinator.requestInboxScan(c.project.id)).toBe(true);
    expect(await c.coordinator.requestInboxScan(c.project.id)).toBe(false);
    const [row] = c.store.pendingEffects();
    expect(row?.effect).toEqual({ kind: 'scan_inbox', project_id: c.project.id });
    c.store.markEffect(row!.effect_id, 'done', c.now());
    expect(await c.coordinator.requestInboxScan(c.project.id)).toBe(true);
    await expect(c.coordinator.requestInboxScan('nope')).rejects.toThrow();
  });
});
