import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUCK_FOOTER } from '../../src/adapters/telegram/cards/stuck-card.ts';
import { bootDaemon, type Daemon } from '../../src/app/daemon.ts';
import { STUCK_TOAST } from '../../src/app/stuck.ts';
import type { Task } from '../../src/core/domain/task.ts';
import type { StepResult, StepRunner, StepSpec } from '../../src/core/ports/step-runner.ts';
import { fakeCalls, fakeClaudeDir, pathWithFakeClaude, setFakeRuns, type FakeRun } from '../helpers/claude.ts';
import { fakeClock } from '../helpers/clock.ts';
import { createTempRemote, git, validRecipe, type TempRemote } from '../helpers/git.ts';
import { createTempHome, OWNER_ID } from '../helpers/home.ts';
import { CHAT_ID, fakeTelegram, tapUpdate, type FakeTelegram } from '../helpers/telegram.ts';

const running: Daemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop('test');
});

const done = (summary: string): FakeRun => ({ structured_output: { status: 'done', summary } });
const verdict = (value: 'pass' | 'blocking' | 'nonblocking', findings: Array<{ criterion_id: string; blocking: boolean; note: string }> = []): FakeRun => ({
  structured_output: { verdict: value, findings },
});
const triage = (decision: 'rerun' | 'park' | 'stuck', reason: string): FakeRun => ({ structured_output: { decision, reason } });
/** A Stage that stays running, so the Task rests in the state that launched it. */
const HOLD: FakeRun = { structured_output: { status: 'done', summary: 'held' }, sleepMs: 60_000 };

/** A container step Runner that runs until its signal aborts, recording the abort. */
function hangingRunner(): { runner: StepRunner; specs: StepSpec[]; aborted: () => boolean } {
  const specs: StepSpec[] = [];
  let aborted = false;
  return {
    specs,
    aborted: () => aborted,
    runner: {
      refusal: () => undefined,
      run: (spec, signal) => {
        specs.push(spec);
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve({ outcome: 'timeout', exit_code: null });
          });
        });
      },
    },
  };
}

/** A container step Runner (AD-24 fake) that plays `results` in order, the last repeating, and writes each log. */
function scriptedRunner(results: Array<StepResult & { log?: string }>): { runner: StepRunner; specs: StepSpec[] } {
  const specs: StepSpec[] = [];
  return {
    specs,
    runner: {
      refusal: () => undefined,
      run: async (spec) => {
        const result = results[Math.min(specs.length, results.length - 1)]!;
        specs.push(spec);
        mkdirSync(dirname(spec.logPath), { recursive: true });
        appendFileSync(spec.logPath, result.log ?? 'ok\n');
        return { outcome: result.outcome, exit_code: result.exit_code };
      },
    },
  };
}

function contract(budget?: number): string {
  return `title: Rest timer
goal: Add a rest timer after each set.
criteria:
  - text: timer starts after a set
    required_evidence: screencast
  - text: default is 90 s
    required_evidence: screenshot
${budget === undefined ? '' : `iteration_budget: ${budget}\n`}`;
}

interface Harness {
  daemon: Daemon;
  tg: FakeTelegram;
  remote: TempRemote;
  fake: string;
  task: Task;
  specs: StepSpec[];
  worktree: string;
  /** Applies `scheduler_start` to the approved Task. */
  start(): Promise<void>;
  stateOf(): string | undefined;
  /** Sends of the Stuck card. */
  stuckSends(): Array<Record<string, unknown>>;
  /** The newest rendering of the newest Stuck card: its last edit, else its send. */
  stuckCard(): Record<string, unknown>;
  buttons(): string[];
  tap(text: string): void;
  toasts(): unknown[];
  briefs(): string[];
}

let updateId = 0;

async function harness(runs: FakeRun[], options: { budget?: number; tests?: Array<StepResult & { log?: string }>; recipe?: string; runner?: StepRunner } = {}): Promise<Harness> {
  const home = createTempHome({ owner: { telegram_user_id: OWNER_ID } });
  const fake = fakeClaudeDir(home.root);
  setFakeRuns(fake, runs);
  const remote = createTempRemote();
  remote.commit({ 'antipod.yaml': options.recipe ?? validRecipe(), '.antipod/inbox/timer.yaml': contract(options.budget) });
  const tg = fakeTelegram();
  tg.respond('getChat', (payload) => ({ id: payload['chat_id'], type: 'supergroup', title: 'Antipode · Training' }));
  tg.respond('getMe', () => ({ id: 1, is_bot: true, first_name: 'Antipode', username: 'antipode_bot', can_read_all_group_messages: true }));
  const { runner, specs } = scriptedRunner(options.tests ?? [{ outcome: 'exited', exit_code: 0 }]);
  const daemon = await bootDaemon({
    env: { ...home.env, PATH: pathWithFakeClaude() },
    clock: fakeClock(),
    telegramApi: tg.api,
    timeZone: 'UTC',
    stageKillGraceMs: 300,
    containerRunner: options.runner ?? runner,
  });
  running.push(daemon);
  const registered = await daemon.registration.register({ repo: remote.dir, chatId: CHAT_ID });
  if (!registered.ok) throw new Error(registered.reason);
  await daemon.tick();
  await vi.waitFor(() => expect(daemon.store.tasksInStates(['awaiting_approval'])).toHaveLength(1), { timeout: 10_000 });
  const draft = daemon.store.tasksInStates(['awaiting_approval'])[0]!;
  const approved = await daemon.coordinator.approveDraft(draft.id, { config_sha: remote.sha('main'), evidence_kinds: ['screenshot', 'screencast', 'file'] });
  if (!approved.ok) throw new Error(approved.reason);
  await vi.waitFor(() => expect(daemon.store.effectsOfTask(draft.id).find((row) => row.kind === 'prepare_branch')?.status).toBe('done'));
  const task = daemon.store.getTask(draft.id)!;
  const sends = () => daemon.store.outboxOfChat(CHAT_ID).filter((row) => row.kind === 'stuck_card' && row.payload.method === 'sendMessage');
  const h: Harness = {
    daemon,
    tg,
    remote,
    fake,
    task,
    specs,
    worktree: join(daemon.paths.data, 'worktrees', 'training', String(task.task_no)),
    async start() {
      await daemon.coordinator.applyEvent(task.id, { type: 'scheduler_start' });
    },
    stateOf: () => daemon.store.getTask(task.id)?.state,
    stuckSends: () => tg.callsOf('sendMessage').filter((call) => String(call['text']).includes('· Stuck')),
    stuckCard() {
      const latest = sends().at(-1);
      const edits = daemon.store
        .outboxOfChat(CHAT_ID)
        .filter((row) => row.kind === 'stuck_card' && row.payload.method === 'editMessageText' && row.target_outbox_id === latest?.id && row.status === 'sent');
      return (edits.at(-1)?.payload.params ?? latest?.payload.params ?? {}) as Record<string, unknown>;
    },
    buttons() {
      const markup = h.stuckCard()['reply_markup'] as { inline_keyboard: Array<Array<{ text: string }>> } | undefined;
      return markup?.inline_keyboard.flat().map((button) => button.text) ?? [];
    },
    tap(text) {
      const markup = h.stuckCard()['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      const button = markup.inline_keyboard.flat().find((b) => b.text === text);
      if (button === undefined) throw new Error(`no button ${text}`);
      updateId += 1;
      tg.pushUpdates(tapUpdate(updateId, button.callback_data, { messageId: sends().at(-1)!.sent_message_id! }));
    },
    toasts: () => tg.callsOf('answerCallbackQuery').map((call) => call['text']),
    briefs: () => fakeCalls(fake).map((call) => call.stdin),
  };
  return h;
}

function appliedTypes(h: Harness): string[] {
  return h.daemon.store
    .stageEventsOfTask(h.task.id)
    .filter((row) => row.status === 'applied')
    .map((row) => row.event_type);
}

describe('the implement, validate and triage loop (CAP-13, CAP-19, CAP-20)', () => {
  it('blocking then pass: evidencing with budget_used 2, the Branch pushed to origin, the blocking note in the second brief (AC 1)', async () => {
    const note = 'the timer never starts after the last set';
    const h = await harness([done('added the timer'), verdict('blocking', [{ criterion_id: 'AC1', blocking: true, note }]), done('started it after the last set too'), verdict('pass'), HOLD]);
    await h.start();
    await vi.waitFor(() => expect(h.stateOf()).toBe('evidencing'), { timeout: 15_000 });
    expect(h.daemon.store.getTask(h.task.id)).toMatchObject({ budget_used: 2 });
    expect(appliedTypes(h)).toEqual(expect.arrayContaining(['implementer_done', 'test_passed', 'blocking_findings', 'pass']));
    // Pushed after every done Implementer: origin's Branch head is the worktree head.
    const branch = `antipod/${h.task.task_no}-rest-timer`;
    expect(git(h.remote.dir, 'rev-parse', `refs/heads/${branch}`)).toBe(git(h.worktree, 'rev-parse', 'HEAD'));
    expect(h.specs).toHaveLength(2);
    const [first, , second, validator] = h.briefs();
    expect(first).toContain('AC1 [screencast]: timer starts after a set');
    expect(first).not.toContain('What the last lap left');
    expect(second).toContain('Blocking findings of the Validator:');
    expect(second).toContain(`- AC1: ${note}`);
    // The Validator judges the Branch, never the Implementer's summary (CAP-19).
    expect(validator).toContain(`Branch: \`${branch}\``);
    expect(validator).not.toContain('started it after the last set too');
    // The outputs are on the Stage rows the briefs were rendered from (AD-21).
    expect(h.daemon.store.stagesOfTask(h.task.id, 'test').map((stage) => stage.output)).toEqual([
      expect.objectContaining({ exit_code: 0, outcome: 'exited' }),
      expect.objectContaining({ exit_code: 0, outcome: 'exited' }),
    ]);
  });

  it('a failing test sends the Task back with a budget unit and the log tail in the brief', async () => {
    const h = await harness([done('added the timer'), done('fixed the test'), HOLD], {
      tests: [{ outcome: 'exited', exit_code: 1, log: 'compiling\nFAILED TimerTest > startsAfterSet\n' }, { outcome: 'exited', exit_code: 0 }],
    });
    await h.start();
    await vi.waitFor(() => expect(appliedTypes(h)).toContain('test_passed'), { timeout: 15_000 });
    expect(appliedTypes(h)).toContain('test_failed');
    expect(h.daemon.store.getTask(h.task.id)?.budget_used).toBe(2);
    const second = h.briefs()[1]!;
    expect(second).toContain('The Recipe `test` step exited 1');
    expect(second).toContain('FAILED TimerTest > startsAfterSet');
  });

  it('a Recipe without a test step passes testing right after the push', async () => {
    const recipe = 'name: training\nevidence_kinds: [screenshot, screencast, file]\nsteps:\n  build: { runner: container, image: busybox, cmd: "true", timeout: 1m }\n';
    const h = await harness([done('added the timer'), HOLD], { recipe });
    await h.start();
    await vi.waitFor(() => expect(h.stateOf()).toBe('validating'), { timeout: 15_000 });
    expect(h.specs).toEqual([]);
    expect(git(h.remote.dir, 'rev-parse', `refs/heads/antipod/${h.task.task_no}-rest-timer`)).toBe(git(h.worktree, 'rev-parse', 'HEAD'));
  });

  it('non-blocking findings parked by Triage become P1..Pn and the Task goes on to evidencing', async () => {
    const findings = [
      { criterion_id: 'AC1', blocking: false, note: 'the beep is quiet' },
      { criterion_id: 'AC2', blocking: false, note: 'the label says secs' },
    ];
    const h = await harness([done('added the timer'), verdict('nonblocking', findings), triage('park', 'cosmetic only'), HOLD]);
    await h.start();
    await vi.waitFor(() => expect(h.stateOf()).toBe('evidencing'), { timeout: 15_000 });
    const triageStage = h.daemon.store.stagesOfTask(h.task.id, 'triage')[0]!;
    expect(h.daemon.store.parkedFindings(h.task.id)).toEqual([
      expect.objectContaining({ p_no: 1, criterion_id: 'AC1', note: 'the beep is quiet', status: 'open', source_stage_id: triageStage.id }),
      expect.objectContaining({ p_no: 2, criterion_id: 'AC2', note: 'the label says secs', status: 'open', source_stage_id: triageStage.id }),
    ]);
    expect(h.briefs()[2]).toContain("### The Validator's non-blocking findings");
    expect(h.briefs()[2]).toContain('- AC2: the label says secs');
    expect(h.daemon.store.getTask(h.task.id)?.budget_used).toBe(1);
  });

  it('budget 1, blocking, Triage rerun: one loud Stuck card with the reason; Raise budget +2 resumes with limit 3 (AC 2)', async () => {
    const h = await harness(
      [done('added the timer'), verdict('blocking', [{ criterion_id: 'AC1', blocking: true, note: 'never starts' }]), triage('rerun', 'AC1 needs a different approach'), HOLD],
      { budget: 1 },
    );
    await h.start();
    await vi.waitFor(() => expect(h.stuckSends()).toHaveLength(1), { timeout: 15_000 });
    expect(h.daemon.store.getTask(h.task.id)).toMatchObject({ state: 'stuck', stuck_reason: 'AC1 needs a different approach', budget_used: 1, budget_limit: 1 });
    expect(appliedTypes(h)).toEqual(expect.arrayContaining(['blocking_findings', 'budget_spent', 'rerun']));
    // The Triage was told the budget is spent.
    expect(h.briefs()[2]).toContain('The Iteration Budget is spent');
    expect(h.briefs()[2]).toContain('Iteration Budget: 1/1 used.');
    const [card] = h.stuckSends();
    expect(card!['disable_notification']).toBe(false);
    expect(card!['text']).toBe(
      [`🧱 <b>#${h.task.task_no} · Rest timer</b> · Stuck`, 'AC1 needs a different approach', '', 'Lap 1: added the timer', '', STUCK_FOOTER].join('\n'),
    );
    expect(h.buttons()).toEqual(['Raise budget +2', 'Cancel Task']);

    h.tap('Raise budget +2');
    await vi.waitFor(() => expect(h.daemon.store.getTask(h.task.id)?.state).toBe('implementing'));
    expect(h.daemon.store.getTask(h.task.id)).toMatchObject({ budget_limit: 3, budget_used: 1, stuck_reason: null });
    await vi.waitFor(() => expect(h.toasts()).toEqual([STUCK_TOAST.raised(2)]));
    await vi.waitFor(() => expect(h.buttons()).toEqual([]));
    expect(String(h.stuckCard()['text']).endsWith('Lap 1: added the timer\n\n⏳ Budget +2 · resuming')).toBe(true);
    expect(h.stuckSends()).toHaveLength(1);
  });

  it('a park that a spent budget turns into stuck parks nothing', async () => {
    const findings = [
      { criterion_id: 'AC1', blocking: true, note: 'never starts' },
      { criterion_id: 'AC2', blocking: false, note: 'label says secs' },
    ];
    const h = await harness([done('added the timer'), verdict('blocking', findings), triage('park', 'cosmetic left, AC1 open'), HOLD], { budget: 1 });
    await h.start();
    await vi.waitFor(() => expect(h.stuckSends()).toHaveLength(1), { timeout: 15_000 });
    expect(h.daemon.store.getTask(h.task.id)).toMatchObject({ state: 'stuck', stuck_reason: 'cosmetic left, AC1 open' });
    expect(h.daemon.store.parkedFindings(h.task.id)).toEqual([]);
  });

  it('pausing during testing aborts the test step through cancel_stage and applies no test result', async () => {
    const hanging = hangingRunner();
    const h = await harness([done('added the timer')], { runner: hanging.runner });
    await h.start();
    await vi.waitFor(() => expect(hanging.specs).toHaveLength(1), { timeout: 15_000 });
    expect(h.stateOf()).toBe('testing');
    await h.daemon.coordinator.applyEvent(h.task.id, { type: 'pause' });
    await vi.waitFor(() => expect(hanging.aborted()).toBe(true));
    await vi.waitFor(() => expect(h.daemon.testStep.running()).toEqual([]));
    expect(h.stateOf()).toBe('paused');
    expect(appliedTypes(h)).not.toContain('test_passed');
    expect(appliedTypes(h)).not.toContain('test_failed');
    expect(h.daemon.store.stagesOfTask(h.task.id, 'test')[0]).toMatchObject({ status: 'cancelled', reason: 'pause' });
  });

  it('Cancel Task asks to confirm; Keep restores; Confirm cancels with the Branch kept; a later tap is stale', async () => {
    const h = await harness([done('added the timer'), verdict('nonblocking', [{ criterion_id: 'AC2', blocking: false, note: 'shows 60 s' }]), triage('stuck', 'the Owner must pick the default')]);
    await h.start();
    await vi.waitFor(() => expect(h.stuckSends()).toHaveLength(1), { timeout: 15_000 });
    expect(h.daemon.store.getTask(h.task.id)?.stuck_reason).toBe('the Owner must pick the default');

    h.tap('Cancel Task');
    await vi.waitFor(() => expect(h.buttons()).toEqual([`Confirm cancel #${h.task.task_no}`, 'Keep']));
    h.tap('Keep');
    await vi.waitFor(() => expect(h.buttons()).toEqual(['Raise budget +2', 'Cancel Task']));
    expect(h.stateOf()).toBe('stuck');
    h.tap('Cancel Task');
    await vi.waitFor(() => expect(h.buttons()).toEqual([`Confirm cancel #${h.task.task_no}`, 'Keep']));
    const keep = (h.stuckCard()['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0]![1]!;
    h.tap(`Confirm cancel #${h.task.task_no}`);
    await vi.waitFor(() => expect(h.stateOf()).toBe('cancelled'));
    await vi.waitFor(() => expect(h.buttons()).toEqual([]));
    expect(String(h.stuckCard()['text']).endsWith('\n\nCancelled')).toBe(true);
    expect(String(h.stuckCard()['text'])).not.toContain(STUCK_FOOTER);
    expect(git(h.remote.dir, 'branch', '--list', `antipod/${h.task.task_no}-rest-timer`)).not.toBe('');

    updateId += 1;
    h.tg.pushUpdates(tapUpdate(updateId, keep.callback_data, { messageId: 1 }));
    await vi.waitFor(() => expect(h.toasts().at(-1)).toBe(`#${h.task.task_no} is cancelled now.`));
    expect(h.toasts().filter((toast) => toast === STUCK_TOAST.cancelled)).toHaveLength(1);
  });

  it('pause closes the Stuck card; resume sends a new one, and the old card no longer acts', async () => {
    const h = await harness([done('added the timer'), verdict('nonblocking', [{ criterion_id: 'AC2', blocking: false, note: 'shows 60 s' }]), triage('stuck', 'the Owner must pick the default')]);
    await h.start();
    await vi.waitFor(() => expect(h.stuckSends()).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.buttons()).toEqual(['Raise budget +2', 'Cancel Task']));
    const raise = (h.stuckCard()['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0]![0]!;
    const oldCard = h.daemon.store.outboxOfChat(CHAT_ID).filter((row) => row.kind === 'stuck_card' && row.payload.method === 'sendMessage')[0]!;

    await h.daemon.coordinator.applyEvent(h.task.id, { type: 'pause' });
    await vi.waitFor(() => expect(h.buttons()).toEqual([]));
    expect(String(h.stuckCard()['text']).endsWith('\n\n⏸ Paused by you')).toBe(true);
    expect(String(h.stuckCard()['text'])).not.toContain(STUCK_FOOTER);

    await h.daemon.coordinator.applyEvent(h.task.id, { type: 'resume' });
    await vi.waitFor(() => expect(h.stuckSends()).toHaveLength(2));
    await vi.waitFor(() => expect(h.buttons()).toEqual(['Raise budget +2', 'Cancel Task']));
    const budget = h.daemon.store.getTask(h.task.id)!.budget_limit;

    // The old card's button (as if its close never reached Telegram) acts on nothing; the card is redrawn closed.
    updateId += 1;
    h.tg.pushUpdates(tapUpdate(updateId, raise.callback_data, { messageId: oldCard.sent_message_id! }));
    await vi.waitFor(() => expect(h.toasts().at(-1)).toBe(`#${h.task.task_no} is stuck now.`));
    expect(h.stateOf()).toBe('stuck');
    expect(h.daemon.store.getTask(h.task.id)!.budget_limit).toBe(budget);
    await vi.waitFor(() =>
      expect(h.daemon.store.outboxOfChat(CHAT_ID).filter((row) => row.kind === 'stale_tap_retire')).toEqual([
        expect.objectContaining({
          target_message_id: oldCard.sent_message_id,
          payload: { method: 'editMessageText', params: { text: expect.stringMatching(/\n\n⏸ Paused by you$/), reply_markup: { inline_keyboard: [] } } },
        }),
      ]),
    );
    expect(h.buttons()).toEqual(['Raise budget +2', 'Cancel Task']);
  });

  it('a push the remote rejects fails testing without budget, is retried, then the Stuck card names the cause', async () => {
    const h = await harness([done('added the timer')]);
    // The remote refuses every push.
    const hook = join(h.remote.dir, '.git', 'hooks', 'pre-receive');
    mkdirSync(dirname(hook), { recursive: true });
    appendFileSync(hook, '#!/bin/sh\necho "pushes are closed" >&2\nexit 1\n', { mode: 0o755 });
    await h.start();
    await vi.waitFor(() => expect(h.stuckSends()).toHaveLength(1), { timeout: 15_000 });
    const testStages = h.daemon.store.stagesOfTask(h.task.id, 'test');
    expect(testStages.map((stage) => stage.status)).toEqual(['failed', 'failed', 'failed']);
    expect(testStages[0]!.reason).toMatch(/^push: /);
    expect(h.daemon.store.getTask(h.task.id)).toMatchObject({ state: 'stuck', budget_used: 1 });
    expect(h.daemon.store.getTask(h.task.id)?.stuck_reason).toMatch(/^test Stage failed 3 times; last failure: push: /);
    expect(String(h.stuckSends()[0]!['text'])).toContain('test Stage failed 3 times; last failure: push: ');
    expect(h.specs).toEqual([]);
  });
});
