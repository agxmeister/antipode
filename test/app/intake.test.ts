import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootDaemon, type Daemon } from '../../src/app/daemon.ts';
import { TOAST } from '../../src/app/intake.ts';
import { stateToast } from '../../src/adapters/telegram/poller.ts';
import { INTAKE_FAILED_REPLY } from '../../src/adapters/telegram/messenger.ts';
import { projectContract } from '../../src/core/domain/contract.ts';
import { ulid } from '../../src/core/domain/ids.ts';
import type { Task } from '../../src/core/domain/task.ts';
import { UNHANDLED_OUTPUT } from '../../src/app/stages.ts';
import { fakeCalls, fakeClaudeDir, pathWithFakeClaude, setFakeRuns, type FakeRun } from '../helpers/claude.ts';
import { fakeClock, type FakeClock } from '../helpers/clock.ts';
import { createTempRemote, git, validRecipe, type TempRemote } from '../helpers/git.ts';
import { createTempHome, OWNER_ID, type TempHome } from '../helpers/home.ts';
import { CHAT_ID, fakeTelegram, tapUpdate, textUpdate, type FakeTelegram } from '../helpers/telegram.ts';

const running: Daemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop('test');
});

const Q1 = { text: 'Can the default be changed per exercise?', quick_answers: ['Yes', 'Not yet'] };

function newDraft(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'new_draft',
    title: 'Rest timer after each set',
    goal: 'Add a rest timer after each set, 90 seconds by default.',
    criteria: [
      { text: 'timer starts after a set', required_evidence: 'screencast' },
      { text: 'default is 90 s', required_evidence: 'screenshot' },
    ],
    questions: [],
    ...overrides,
  };
}

function output(...instructions: unknown[]): FakeRun {
  return { structured_output: { instructions } };
}

/** A complete Task Contract file: every criterion names a kind of `validRecipe()`. */
const COMPLETE_CONTRACT = `title: Dark mode
goal: Offer a dark theme.
criteria:
  - text: settings has a dark mode switch
    required_evidence: screenshot
  - text: the home screen turns dark
    required_evidence: screenshot
`;

interface Harness {
  home: TempHome;
  daemon: Daemon;
  tg: FakeTelegram;
  clock: FakeClock;
  remote: TempRemote;
  fake: string;
  projectId: string;
  /** Pushes one update with the next update id. */
  push(update: (id: number) => Parameters<FakeTelegram['pushUpdates']>[0]): void;
  /** Draft-card sends (not edits). */
  cardSends(): Array<Record<string, unknown>>;
  edits(): Array<Record<string, unknown>>;
  /** The newest rendering of the card: the last edit, else the send. */
  card(): Record<string, unknown>;
  buttons(): Array<{ text: string; callback_data: string }>;
  tap(text: string): void;
  tasks(): Task[];
}

async function harness(runs: FakeRun[], inbox: Record<string, string> = {}, config: Record<string, unknown> = {}): Promise<Harness> {
  const home = createTempHome({ owner: { telegram_user_id: OWNER_ID }, ...config });
  const fake = fakeClaudeDir(home.root);
  setFakeRuns(fake, runs);
  const remote = createTempRemote();
  remote.commit({ 'antipod.yaml': validRecipe(), ...inbox });
  const tg = fakeTelegram();
  tg.respond('getChat', (payload) => ({ id: payload['chat_id'], type: 'supergroup', title: 'Antipode · Training' }));
  tg.respond('getMe', () => ({ id: 1, is_bot: true, first_name: 'Antipode', username: 'antipode_bot', can_read_all_group_messages: true }));
  const clock = fakeClock();
  const daemon = await bootDaemon({ env: { ...home.env, PATH: pathWithFakeClaude() }, clock, telegramApi: tg.api, timeZone: 'UTC', stageKillGraceMs: 300 });
  running.push(daemon);
  const registered = await daemon.registration.register({ repo: remote.dir, chatId: CHAT_ID });
  if (!registered.ok) throw new Error(registered.reason);
  let updateId = 0;
  const isCard = (payload: Record<string, unknown>) => String(payload['text']).includes('Goal: ');
  const h: Harness = {
    home,
    daemon,
    tg,
    clock,
    remote,
    fake,
    projectId: registered.project.id,
    push(update) {
      updateId += 1;
      tg.pushUpdates(update(updateId));
    },
    cardSends: () => tg.callsOf('sendMessage').filter(isCard),
    edits: () => tg.callsOf('editMessageText'),
    card() {
      const edits = h.edits();
      return edits.at(-1) ?? h.cardSends().at(-1) ?? {};
    },
    buttons() {
      const markup = h.card()['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
      return markup?.inline_keyboard.flat() ?? [];
    },
    tap(text) {
      const button = h.buttons().find((b) => b.text === text);
      if (button === undefined) throw new Error(`no button ${text} on ${JSON.stringify(h.buttons())}`);
      h.push((id) => tapUpdate(id, button.callback_data, { messageId: cardMessageId(h) }));
    },
    tasks: () => daemon.store.tasksInStates(['draft', 'awaiting_approval', 'discard_pending', 'queued', 'cancelled', 'implementing']),
  };
  return h;
}

/** The message id the fake gave the card's send. */
function cardMessageId(h: Harness): number {
  const send = h.daemon.store.outboxOfChat(CHAT_ID).find((row) => row.kind === 'draft_card' && row.payload.method === 'sendMessage');
  if (send?.sent_message_id == null) throw new Error('the card was not sent');
  return send.sent_message_id;
}

function toasts(h: Harness): unknown[] {
  return h.tg.callsOf('answerCallbackQuery').map((call) => call['text']);
}

function rows(h: Harness): string[][] {
  const markup = h.card()['reply_markup'] as { inline_keyboard: Array<Array<{ text: string }>> };
  return markup.inline_keyboard.map((row) => row.map((button) => button.text));
}

async function textToDraftCard(h: Harness, text = 'add a rest timer after each set, 90 seconds default'): Promise<Task> {
  h.push((id) => textUpdate(id, text, { messageId: 50 }));
  await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1), { timeout: 10_000 });
  const [task] = h.tasks();
  return task!;
}

describe('Intake drafts from Owner text (CAP-7, CAP-8, CAP-9)', () => {
  it('text, quick answer, Approve: #1 with Branch and worktree, the card edited in place, no budget unit (AC 1)', async () => {
    const h = await harness([output(newDraft({ questions: [Q1] }))]);
    const task = await textToDraftCard(h);

    // 👀 first, then a silent, unnumbered Draft card with the open question and no Approve.
    expect(h.tg.callsOf('setMessageReaction')).toEqual([{ chat_id: CHAT_ID, message_id: 50, reaction: [{ type: 'emoji', emoji: '👀' }] }]);
    const sent = h.cardSends()[0]!;
    expect(sent['disable_notification']).toBe(true);
    expect(sent['text']).toBe(
      [
        '<b>Rest timer after each set</b> · draft',
        'Goal: Add a rest timer after each set, 90 seconds by default.',
        '',
        '<b>AC1</b> timer starts after a set · screencast',
        '<b>AC2</b> default is 90 s · screenshot',
        '',
        '❓ Q1 Can the default be changed per exercise?',
        '',
        'Approve after: answer Q1',
      ].join('\n'),
    );
    expect(rows(h)).toEqual([['Yes', 'Not yet'], ['Discard']]);
    expect(h.daemon.store.getTask(task.id)).toMatchObject({ state: 'awaiting_approval', task_no: null, title: 'Rest timer after each set', slug: 'rest-timer-after-each-set' });
    expect(fakeCalls(h.fake)).toHaveLength(1);
    expect(fakeCalls(h.fake)[0]!.stdin).toContain('add a rest timer after each set, 90 seconds default');

    // Quick answer: stored on the draft row, the card edited, Approve appears; no Stage.
    h.tap('Not yet');
    await vi.waitFor(() => expect(h.edits()).toHaveLength(1));
    expect(toasts(h)).toEqual([TOAST.answered]);
    expect(h.daemon.store.questionsOf(task.id)).toMatchObject([{ q_no: 1, answer: 'Not yet' }]);
    expect(h.card()['text']).toContain('Q1 Can the default be changed per exercise? · Not yet');
    expect(h.card()['text']).not.toContain('Approve after');
    expect(rows(h)).toEqual([['Approve', 'Discard']]);

    // A stale quick answer (Q1 is answered) is refused with the draft's state and changes nothing.
    const yes = h.daemon.store.outboxOfChat(CHAT_ID).find((row) => row.payload.method === 'sendMessage' && row.kind === 'draft_card');
    const staleData = (yes!.payload.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
    h.push((id) => tapUpdate(id, staleData, { messageId: cardMessageId(h) }));
    await vi.waitFor(() => expect(toasts(h)).toHaveLength(2));
    expect(toasts(h)[1]).toBe(stateToast(h.daemon.store.getTask(task.id)!));
    expect(toasts(h)[1]).toBe('This draft is waiting for your approval now.');
    expect(h.daemon.store.questionsOf(task.id)[0]!.answer).toBe('Not yet');
    // The tapped card is redrawn from the rows: the same text and buttons.
    await vi.waitFor(() => expect(h.edits()).toHaveLength(2));
    expect(h.card()['text']).toContain('Q1 Can the default be changed per exercise? · Not yet');
    expect(rows(h)).toEqual([['Approve', 'Discard']]);

    h.tap('Approve');
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('queued'));
    await vi.waitFor(() => expect(h.edits()).toHaveLength(3));
    expect(toasts(h)[2]).toBe(TOAST.queued);
    const approved = h.daemon.store.getTask(task.id)!;
    expect(approved).toMatchObject({ task_no: 1, budget_used: 0, config_sha: h.remote.sha('main') });
    expect(h.card()['text']).toBe(
      ['<b>#1 · Rest timer after each set</b>', 'Goal: Add a rest timer after each set, 90 seconds by default.', '', '<b>AC1</b> timer starts after a set · screencast', '<b>AC2</b> default is 90 s · screenshot', '', '⏳ Queued · starts next'].join('\n'),
    );
    expect(rows(h)).toEqual([]);
    expect(h.cardSends()).toHaveLength(1);
    const worktree = join(h.daemon.paths.data, 'worktrees', 'training', '1');
    await vi.waitFor(() => expect(existsSync(join(worktree, 'antipod.yaml'))).toBe(true));
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('antipod/1-rest-timer-after-each-set');
    expect(fakeCalls(h.fake)).toHaveLength(1);
  });

  it('an infeasible criterion shows ⚠️ with Use proposal / Drop; approval is refused until it is resolved (CAP-8)', async () => {
    const criteria = [
      { text: 'timer starts after a set', required_evidence: 'screencast' },
      { text: 'phone vibrates at the end', required_evidence: 'file', infeasible: { wanted: 'haptics', proposal: 'vibration call log (degraded)' } },
      { text: 'a 3D preview renders', required_evidence: 'render' },
    ];
    const h = await harness([output(newDraft({ criteria }))]);
    const task = await textToDraftCard(h);
    const text = String(h.card()['text']);
    expect(text).toContain("<b>AC2</b> ⚠️ can't evidence haptics · proposed: vibration call log (degraded)");
    // A kind the Recipe lacks, not flagged by Intake, is infeasible with nothing proposed.
    expect(text).toContain("<b>AC3</b> ⚠️ can't evidence render");
    expect(text).toContain('Approve after: resolve AC2 · resolve AC3');
    expect(rows(h)).toEqual([['Use proposal', 'Drop AC2'], ['Drop AC3'], ['Discard']]);

    const refused = await h.daemon.coordinator.approveDraft(task.id, { config_sha: null, evidence_kinds: ['screenshot', 'screencast', 'file'] });
    expect(refused).toEqual({ ok: false, reason: 'resolve AC2 · resolve AC3 first' });
    expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval');

    h.tap('Use proposal');
    await vi.waitFor(() => expect(toasts(h)).toEqual([TOAST.proposal]));
    h.tap('Drop AC3');
    await vi.waitFor(() => expect(toasts(h)).toEqual([TOAST.proposal, TOAST.dropped(3)]));
    await vi.waitFor(() => expect(rows(h)).toEqual([['Approve', 'Discard']]));
    expect(h.daemon.store.latestContract(task.id)?.version).toBe(3);
    expect(h.daemon.store.criteriaOf(task.id).map((c) => [c.ac_no, c.status, c.infeasible_wanted])).toEqual([
      [1, 'active', null],
      [2, 'active', null],
      [3, 'dropped', 'render'],
    ]);
    expect(String(h.card()['text'])).not.toContain('AC3');
  });

  it('a reply to the card is draft_reply: Intake reruns with it, the contract becomes v2 and the card is edited, never reposted', async () => {
    const revised = newDraft({
      criteria: [
        { ac: 2, text: 'default is 90 s', required_evidence: 'screenshot' },
        { text: 'timer is big and centred', required_evidence: 'screenshot' },
      ],
    });
    const h = await harness([output(newDraft()), output(revised)]);
    const task = await textToDraftCard(h);
    h.push((id) => textUpdate(id, 'drop the start criterion, and the timer must be big', { messageId: 51, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(h.daemon.store.latestContract(task.id)?.version).toBe(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.edits()).toHaveLength(1));
    expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval');
    expect(h.cardSends()).toHaveLength(1);
    // AC numbers are never reused: AC1 is dropped, AC2 kept, the new criterion is AC3.
    expect(h.daemon.store.criteriaOf(task.id).map((c) => [c.ac_no, c.status])).toEqual([
      [1, 'dropped'],
      [2, 'active'],
      [3, 'active'],
    ]);
    expect(String(h.card()['text'])).toContain('<b>AC3</b> timer is big and centred · screenshot');
    const brief = fakeCalls(h.fake)[1]!.stdin;
    expect(brief).toContain('drop the start criterion, and the timer must be big');
    expect(brief).toContain('Current draft (version 1)');
    expect(brief).toContain(`draft_id\` \`${task.id}\``);
    expect(h.daemon.store.tasksInStates(['draft', 'awaiting_approval'])).toHaveLength(1);
  });

  it('a draft_reply naming this draft records the answers and edits the card', async () => {
    const h = await harness([output(newDraft({ questions: ['Which screen?'] }))]);
    const task = await textToDraftCard(h);
    expect(rows(h)).toEqual([['Discard']]);
    setFakeRuns(h.fake, [output(newDraft()), output({ kind: 'draft_reply', draft_id: task.id, answers: ['the workout screen'], changes: '' })]);
    h.push((id) => textUpdate(id, 'the workout screen', { messageId: 52, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(h.edits()).toHaveLength(1), { timeout: 10_000 });
    expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval');
    expect(h.daemon.store.questionsOf(task.id)).toMatchObject([{ q_no: 1, answer: 'the workout screen' }]);
    expect(h.daemon.store.latestContract(task.id)?.version).toBe(1);
    expect(rows(h)).toEqual([['Approve', 'Discard']]);
    expect(h.cardSends()).toHaveLength(1);
  });

  it('a revision whose Intake fails every attempt returns to its card on the previous version, ❌ on the reply', async () => {
    const h = await harness([output(newDraft())]);
    const task = await textToDraftCard(h);
    // A draft_reply naming another draft is unhandled until targeting exists (1-14), so every attempt fails.
    setFakeRuns(h.fake, [output(newDraft()), output({ kind: 'draft_reply', draft_id: 'some-other-draft', answers: ['x'], changes: '' })]);
    h.push((id) => textUpdate(id, 'yes', { messageId: 53, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(h.daemon.store.stagesOfTask(task.id)).toHaveLength(4), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval'));
    const reruns = h.daemon.store.stagesOfTask(task.id).slice(1);
    expect(reruns.map((stage) => [stage.status, stage.reason])).toEqual([
      ['failed', UNHANDLED_OUTPUT],
      ['failed', UNHANDLED_OUTPUT],
      ['failed', UNHANDLED_OUTPUT],
    ]);
    expect(h.daemon.store.latestContract(task.id)?.version).toBe(1);
    await vi.waitFor(() => expect(h.tg.callsOf('sendMessage').filter((call) => call['text'] === INTAKE_FAILED_REPLY)).toHaveLength(1));
    expect(h.tg.callsOf('sendMessage').find((call) => call['text'] === INTAKE_FAILED_REPLY)).toMatchObject({ reply_parameters: { message_id: 53 } });
    const reactions = h.tg.callsOf('setMessageReaction').filter((call) => call['message_id'] === 53).map((call) => (call['reaction'] as Array<{ emoji: string }>)[0]!.emoji);
    expect(reactions).toEqual(['👀', '❌']);
    // The card still shows version 1 with its buttons; it is neither edited nor reposted, and they work again.
    expect(h.edits()).toEqual([]);
    expect(h.cardSends()).toHaveLength(1);
    h.tap('Approve');
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('queued'));
  });

  it('not_actionable on a revision returns the draft to its card, unchanged and not cancelled', async () => {
    const h = await harness([output(newDraft())]);
    const task = await textToDraftCard(h);
    setFakeRuns(h.fake, [output(newDraft()), output({ kind: 'not_actionable', reason: 'just a thank-you' })]);
    h.push((id) => textUpdate(id, 'thanks', { messageId: 54, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(fakeCalls(h.fake)).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval'));
    expect(h.daemon.store.stagesOfTask(task.id).map((stage) => stage.status)).toEqual(['succeeded', 'succeeded']);
    expect(h.daemon.store.latestContract(task.id)?.version).toBe(1);
    expect(h.cardSends()).toHaveLength(1);
  });

  it('the Intake brief keeps the source and only the newest intake.context_messages messages after it', async () => {
    const h = await harness([output(newDraft()), output(newDraft())], {}, { intake: { context_messages: 2 } });
    const task = await textToDraftCard(h, 'the original request');
    for (const text of ['older-one', 'older-two', 'older-three']) {
      h.daemon.store.insertIntakeMessage({ id: ulid(), task_id: task.id, sender: 'owner', text, message_id: null, at: h.clock.now().toISOString() });
    }
    h.push((id) => textUpdate(id, 'the newest reply', { messageId: 55, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(fakeCalls(h.fake)).toHaveLength(2), { timeout: 10_000 });
    const brief = fakeCalls(h.fake)[1]!.stdin;
    expect(brief).toContain('the original request');
    expect(brief).toContain('Owner: older-three');
    expect(brief).toContain('Owner: the newest reply');
    expect(brief).not.toContain('older-two');
    expect(brief).not.toContain('older-one');
  });

  it('not_actionable cancels the scratch draft silently: only the 👀 is left', async () => {
    const h = await harness([output({ kind: 'not_actionable', reason: 'small talk' })]);
    h.push((id) => textUpdate(id, 'thanks!', { messageId: 60 }));
    await vi.waitFor(() => expect(h.daemon.store.tasksInStates(['cancelled'])).toHaveLength(1), { timeout: 10_000 });
    const [task] = h.daemon.store.tasksInStates(['cancelled']);
    expect(h.daemon.store.stagesOfTask(task!.id).map((s) => [s.role, s.status])).toEqual([['intake', 'succeeded']]);
    await h.daemon.executor.drain();
    await h.daemon.messenger!.sender.idle();
    expect(h.tg.callsOf('sendMessage')).toEqual([]);
    expect(h.tg.callsOf('setMessageReaction')).toHaveLength(1);
  });

  it('Intake failing every attempt cancels the draft, replaces 👀 with ❌ and replies once', async () => {
    const h = await harness([{ exit: 1 }]);
    h.push((id) => textUpdate(id, 'add a timer', { messageId: 70 }));
    await vi.waitFor(() => expect(h.daemon.store.tasksInStates(['cancelled'])).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.tg.callsOf('sendMessage')).toHaveLength(1));
    expect(fakeCalls(h.fake)).toHaveLength(3);
    expect(h.tg.callsOf('setMessageReaction').map((call) => (call['reaction'] as Array<{ emoji: string }>)[0]!.emoji)).toEqual(['👀', '❌']);
    expect(h.tg.callsOf('sendMessage')[0]).toMatchObject({ text: INTAKE_FAILED_REPLY, reply_parameters: { message_id: 70 } });
  });

  it('a reply while Intake is revising the draft is not a new draft: Intake reruns with it once that run ends', async () => {
    const h = await harness([output(newDraft())]);
    const task = await textToDraftCard(h);
    setFakeRuns(h.fake, [output(newDraft()), { ...output(newDraft({ goal: 'Revision one.' })), sleepMs: 1_500 }, output(newDraft({ goal: 'Revision two.' }))]);
    h.push((id) => textUpdate(id, 'make the timer big', { messageId: 55, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(h.daemon.store.stagesOfTask(task.id).at(-1)?.status).toBe('running'), { timeout: 10_000 });
    h.clock.advance(1_000);
    h.push((id) => textUpdate(id, 'and make it red', { messageId: 56, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(h.daemon.store.latestContract(task.id)?.goal).toBe('Revision two.'), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval'));
    expect(h.daemon.store.tasksInStates(['draft', 'awaiting_approval', 'cancelled'])).toHaveLength(1);
    const briefs = fakeCalls(h.fake).map((call) => call.stdin);
    expect(briefs).toHaveLength(3);
    expect(briefs[1]).not.toContain('and make it red');
    expect(briefs[2]).toContain('and make it red');
    expect(h.cardSends()).toHaveLength(1);
  });

  it('a reply while the discard is pending undoes it and revises the draft', async () => {
    const h = await harness([output(newDraft())]);
    const task = await textToDraftCard(h);
    h.tap('Discard');
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('discard_pending'));
    setFakeRuns(h.fake, [output(newDraft()), output(newDraft({ goal: 'Revised after all.' }))]);
    h.push((id) => textUpdate(id, 'wait, keep it but 60 seconds', { messageId: 57, replyTo: cardMessageId(h) }));
    await vi.waitFor(() => expect(h.daemon.store.latestContract(task.id)?.goal).toBe('Revised after all.'), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)).toMatchObject({ state: 'awaiting_approval', undo_expires_at: null }));
    await vi.waitFor(() => expect(rows(h)).toEqual([['Approve', 'Discard']]));
    expect(h.daemon.store.tasksInStates(['draft', 'awaiting_approval', 'cancelled'])).toHaveLength(1);
    expect(h.cardSends()).toHaveLength(1);
  });

  it('Discard, Undo within the minute, Discard again; after 60 s the draft is cancelled and the card reads Discarded', async () => {
    const h = await harness([output(newDraft({ goal: 'Timer & sets <fast>' }))]);
    const task = await textToDraftCard(h);
    const botTexts = () => h.daemon.store.intakeMessagesOf(task.id).filter((m) => m.sender === 'bot').map((m) => m.text);
    expect(botTexts()).toHaveLength(1);
    expect(botTexts()[0]).toContain('Goal: Timer & sets <fast>');
    h.tap('Discard');
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('discard_pending'));
    await vi.waitFor(() => expect(h.edits()).toHaveLength(1));
    expect(String(h.card()['text']).endsWith('\n\nDiscarded · undo within 1 min')).toBe(true);
    expect(rows(h)).toEqual([['Undo']]);

    h.clock.advance(30_000);
    h.tap('Undo');
    await vi.waitFor(() => expect(h.daemon.store.getTask(task.id)?.state).toBe('awaiting_approval'));
    await vi.waitFor(() => expect(h.edits()).toHaveLength(2));
    expect(rows(h)).toEqual([['Approve', 'Discard']]);
    expect(toasts(h)).toEqual([TOAST.discarded, TOAST.restored]);
    // The same open card rendered again adds no second bot message to the Intake brief.
    expect(botTexts()).toHaveLength(1);

    h.tap('Discard');
    await vi.waitFor(() => expect(h.edits()).toHaveLength(3));
    h.clock.advance(60_001);
    await h.daemon.tick();
    await vi.waitFor(() => expect(h.edits()).toHaveLength(4));
    expect(h.daemon.store.getTask(task.id)?.state).toBe('cancelled');
    expect(String(h.card()['text']).endsWith('\n\nDiscarded')).toBe(true);
    expect(rows(h)).toEqual([]);
  });
});

describe('Intake drafts from the inbox (CAP-6, AD-5)', () => {
  async function scanned(h: Harness): Promise<void> {
    await h.daemon.tick();
    await vi.waitFor(() => expect(h.daemon.store.pendingEffects().filter((row) => row.kind === 'scan_inbox')).toEqual([]));
    await h.daemon.executor.drain();
  }

  it('a complete contract YAML becomes one Draft card with no Stage; the same (path, blob) is never offered again', async () => {
    const h = await harness([output(newDraft())], { '.antipod/inbox/a.yaml': COMPLETE_CONTRACT });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1));
    expect(h.cardSends()[0]!['text']).toContain('<b>Dark mode</b> · draft');
    expect(rows(h)).toEqual([['Approve', 'Discard']]);
    expect(fakeCalls(h.fake)).toEqual([]);
    const [task] = h.tasks();
    expect(h.daemon.store.contractSourceOfTask(task!.id)).toMatchObject({ path: '.antipod/inbox/a.yaml' });

    h.clock.advance(60_000);
    await scanned(h);
    expect(h.tasks()).toHaveLength(1);
    expect(h.cardSends()).toHaveLength(1);
  });

  it('a story .md and an invalid YAML go through Intake from the file; .antipod/tasks is never scanned', async () => {
    const h = await harness([output(newDraft())], {
      '.antipod/inbox/b.md': '# Story: rest timer\n\nAs a lifter I want a rest timer.\n',
      '.antipod/inbox/c.yaml': 'goal: [unclosed\n',
      '.antipod/tasks/9.yaml': COMPLETE_CONTRACT,
      '.antipod/inbox/notes.txt': 'ignored',
    });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(2), { timeout: 10_000 });
    const briefs = fakeCalls(h.fake).map((call) => call.stdin);
    expect(briefs).toHaveLength(2);
    expect(briefs.some((brief) => brief.includes('As a lifter I want a rest timer.'))).toBe(true);
    expect(briefs.some((brief) => brief.includes('goal: [unclosed'))).toBe(true);
    expect(h.tasks()).toHaveLength(2);
  });

  it('a changed blob at an imported path waits while its draft is open, and becomes a new draft once that Task is terminal', async () => {
    const h = await harness([output(newDraft())], { '.antipod/inbox/a.yaml': COMPLETE_CONTRACT });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1));
    const [first] = h.tasks();
    h.remote.commit({ '.antipod/inbox/a.yaml': COMPLETE_CONTRACT.replace('Dark mode', 'Dark mode v2') });
    h.clock.advance(60_000);
    await scanned(h);
    expect(h.tasks()).toHaveLength(1);

    h.tap('Discard');
    await vi.waitFor(() => expect(h.daemon.store.getTask(first!.id)?.state).toBe('discard_pending'));
    h.clock.advance(60_001);
    await h.daemon.tick();
    await vi.waitFor(() => expect(h.daemon.store.getTask(first!.id)?.state).toBe('cancelled'));
    h.clock.advance(60_000);
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(2));
    const second = h.tasks().find((task) => task.id !== first!.id)!;
    expect(second).toMatchObject({ state: 'awaiting_approval', title: 'Dark mode v2' });
    expect(h.daemon.store.contractSourceOfTask(second.id)?.blob_sha).toBe(git(h.remote.dir, 'rev-parse', 'main:.antipod/inbox/a.yaml'));
  });

  it('Intake failing every attempt on an inbox story sends one notice naming the file, replying to nothing', async () => {
    const h = await harness([{ exit: 1 }], { '.antipod/inbox/b.md': '# Story\n' });
    await scanned(h);
    await vi.waitFor(() => expect(h.daemon.store.tasksInStates(['cancelled'])).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.tg.callsOf('sendMessage')).toHaveLength(1));
    const [notice] = h.tg.callsOf('sendMessage');
    expect(notice!['text']).toContain('<code>.antipod/inbox/b.md</code>');
    expect(notice).not.toHaveProperty('reply_parameters');
    expect(h.tg.callsOf('setMessageReaction')).toEqual([]);
  });

  it('rescans only once git.fetch_interval_ms has passed since the last scan', async () => {
    const h = await harness([output(newDraft())], { '.antipod/inbox/a.yaml': COMPLETE_CONTRACT });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1));
    h.remote.commit({ '.antipod/inbox/b.yaml': COMPLETE_CONTRACT.replace('Dark mode', 'Light mode') });
    h.clock.advance(59_999);
    await scanned(h);
    expect(h.tasks()).toHaveLength(1);
    h.clock.advance(1);
    await scanned(h);
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(2));
  });

  it('Approve fetches first: config_sha is the main pushed since the last scan', async () => {
    const h = await harness([output(newDraft())], { '.antipod/inbox/a.yaml': COMPLETE_CONTRACT });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1));
    const [draft] = h.tasks();
    const pushed = h.remote.commit({ 'README.md': 'pushed after the scan\n' });
    h.tap('Approve');
    await vi.waitFor(() => expect(h.daemon.store.getTask(draft!.id)?.state).toBe('queued'));
    expect(h.daemon.store.getTask(draft!.id)?.config_sha).toBe(pushed);
  });

  it('a refused Approve tap shows the reason in the toast and on the edited card', async () => {
    const h = await harness([output(newDraft())], { '.antipod/inbox/a.yaml': `${COMPLETE_CONTRACT}depends_on: [9]\n` });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1));
    const [task] = h.tasks();
    h.tap('Approve');
    await vi.waitFor(() => expect(toasts(h)).toEqual(["Can't approve: #9 does not exist"]));
    await vi.waitFor(() => expect(h.edits()).toHaveLength(1));
    expect(String(h.card()['text'])).toContain("❌ Can't approve: #9 does not exist");
    expect(h.daemon.store.getTask(task!.id)).toMatchObject({ state: 'awaiting_approval', task_no: null });
    expect(h.daemon.store.dependenciesOf(task!.id)).toEqual([]);
  });

  it('entering implementing commits the contract projection before the Stage and removes the inbox file on the Branch (AC 2)', async () => {
    const h = await harness([{ structured_output: { status: 'done', summary: 'did it' }, sleepMs: 2_000 }], { '.antipod/inbox/a.yaml': COMPLETE_CONTRACT });
    await scanned(h);
    await vi.waitFor(() => expect(h.cardSends()).toHaveLength(1));
    const [draft] = h.tasks();
    h.tap('Approve');
    await vi.waitFor(() => expect(h.daemon.store.getTask(draft!.id)?.state).toBe('queued'));
    await h.daemon.coordinator.applyEvent(draft!.id, { type: 'scheduler_start' });
    await vi.waitFor(() => expect(fakeCalls(h.fake)).toHaveLength(1), { timeout: 10_000 });

    const kinds = h.daemon.store.effectsOfTask(draft!.id).map((row) => [row.kind, row.status]);
    const commit = kinds.findIndex(([kind]) => kind === 'commit_contract');
    expect(commit).toBeGreaterThan(-1);
    expect(kinds[commit]).toEqual(['commit_contract', 'done']);
    expect(kinds[commit + 1]?.[0]).toBe('start_stage');

    const task = h.daemon.store.getTask(draft!.id)!;
    const worktree = join(h.daemon.paths.data, 'worktrees', 'training', String(task.task_no));
    expect(git(worktree, 'log', '-1', '--format=%s')).toBe('antipod: contract v1');
    const contract = h.daemon.store.latestContract(task.id)!;
    const projection = projectContract({ task_no: task.task_no!, version: contract.version, title: task.title!, goal: contract.goal, depends_on: contract.depends_on, criteria: h.daemon.store.criteriaOf(task.id) });
    expect(readFileSync(join(worktree, '.antipod', 'tasks', `${task.task_no}.yaml`), 'utf8')).toBe(projection);
    expect(git(worktree, 'show', `HEAD:.antipod/tasks/${task.task_no}.yaml`)).toBe(projection.trimEnd());
    expect(existsSync(join(worktree, '.antipod', 'inbox', 'a.yaml'))).toBe(false);
    expect(git(worktree, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.antipod/inbox/a.yaml');
    // The removal reaches main only at merge (AD-5).
    expect(git(h.remote.dir, 'ls-tree', '-r', '--name-only', 'main')).toContain('.antipod/inbox/a.yaml');
    // The Implementer launched on the committed tree.
    expect(fakeCalls(h.fake)[0]!.cwd).toBe(git(worktree, 'rev-parse', '--show-toplevel'));
  });
});
