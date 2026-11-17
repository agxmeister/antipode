import { DRAFT_CARD } from '../../../core/coordinator/transitions.ts';
import { activeCriteria, openItems, openQuestions, type CriterionRow, type DraftQuestionRow } from '../../../core/domain/contract.ts';
import { ulid } from '../../../core/domain/ids.ts';
import type { Task } from '../../../core/domain/task.ts';
import type { OutboxDraft } from '../../../core/domain/telegram.ts';
import { clip, escapeHtml, keyboard, NO_KEYBOARD, textMessage, visibleLength, TEXT_LIMIT, type ButtonSpec, type CardEnv, type InlineKeyboard } from './card.ts';
import type { NoticeInput } from './index.ts';

export { DRAFT_CARD };

/** Callback commands of the Draft card (AD-9: Coordinator commands, never Intake). */
export const ANSWER = 'answer';
export const USE_PROPOSAL = 'use_proposal';
export const DROP = 'drop';
export const APPROVE = 'approve';
export const DISCARD = 'discard';
export const UNDO = 'undo';

/** Field budgets that keep the card within one phone screen (CAP-7). */
const TITLE_MAX = 80;
const GOAL_MAX = 240;
const CRITERION_MAX = 140;
const QUESTION_MAX = 140;
const ANSWER_MAX = 60;
const NOTE_MAX = 60;
const BUTTON_MAX = 32;
/** Criteria shown; the rest are summarised on one line. */
const CRITERIA_SHOWN = 10;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

/** The card as the Owner reads it: tags removed, entities decoded. */
function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, (_m, name: string) => ENTITIES[name] ?? '');
}

function field(text: string, max: number): string {
  return escapeHtml(clip(text.trim().replace(/\s+/g, ' '), max));
}

function criterionLine(criterion: CriterionRow): string {
  const label = `<b>AC${criterion.ac_no}</b>`;
  if (criterion.infeasible_wanted !== null) {
    const proposed = criterion.infeasible_proposal === null ? '' : ` · proposed: ${field(criterion.infeasible_proposal, NOTE_MAX)}`;
    return `${label} ⚠️ can't evidence ${field(criterion.infeasible_wanted, NOTE_MAX)}${proposed}`;
  }
  return `${label} ${field(criterion.text, CRITERION_MAX)} · ${criterion.required_evidence}`;
}

function questionLine(question: DraftQuestionRow): string {
  return question.answer === null
    ? `❓ Q${question.q_no} ${field(question.text, QUESTION_MAX)}`
    : `Q${question.q_no} ${field(question.text, QUESTION_MAX)} · ${field(question.answer, ANSWER_MAX)}`;
}

/** The keyboard of an open draft: quick answers, then `Use proposal` · `Drop ACn`, then `Approve` (when resolved) · `Discard`. */
function openKeyboard(task: Task, criteria: readonly CriterionRow[], questions: readonly DraftQuestionRow[], resolved: boolean, env: CardEnv): InlineKeyboard {
  const rows: ButtonSpec[][] = [];
  for (const question of openQuestions(questions)) {
    if (question.quick_answers.length === 0) continue;
    rows.push(question.quick_answers.map((answer) => ({ text: clip(answer, BUTTON_MAX), command: ANSWER, task_id: task.id, args: { q_no: question.q_no, answer } })));
  }
  for (const criterion of activeCriteria(criteria)) {
    if (criterion.infeasible_wanted === null) continue;
    const row: ButtonSpec[] = [];
    if (criterion.infeasible_proposal !== null) row.push({ text: 'Use proposal', command: USE_PROPOSAL, task_id: task.id, args: { ac_no: criterion.ac_no } });
    row.push({ text: `Drop AC${criterion.ac_no}`, command: DROP, task_id: task.id, args: { ac_no: criterion.ac_no } });
    rows.push(row);
  }
  const last: ButtonSpec[] = [];
  if (resolved) last.push({ text: 'Approve', command: APPROVE, task_id: task.id });
  last.push({ text: 'Discard', command: DISCARD, task_id: task.id });
  rows.push(last);
  return keyboard(env, rows);
}

/**
 * The Draft card (DESIGN `draft-card`), rendered from the rows: title, goal, numbered criteria with
 * their Evidence kind, questions, the `Approve after: …` line, buttons. Sent once, then edited in place
 * on every change (EXPERIENCE: never reposted). Unnumbered until approval, then `#n · title` with
 * `⏳ Queued · starts next`. Discard shows `Discarded · undo within 1 min` with `Undo`, then `Discarded`.
 * A card that was never sent and is now closed renders nothing.
 */
export function renderDraftCard(input: NoticeInput, env: CardEnv): OutboxDraft[] {
  const { task } = input;
  if (task === undefined) throw new Error(`notice ${DRAFT_CARD} needs a Task`);
  const { store } = env;
  const contract = store.latestContract(task.id);
  const previous = store.latestCardOutbox(task.id);
  const sent = previous !== undefined && previous.status !== 'failed' ? previous : undefined;
  const payload = input.effect.payload ?? {};
  const closed = typeof payload['closed'] === 'string' ? payload['closed'] : undefined;
  const refusal = typeof payload['refusal'] === 'string' ? payload['refusal'] : undefined;
  if (contract === undefined || task.state === 'draft') return [];
  const isOpen = task.state === 'awaiting_approval';
  const isPending = task.state === 'discard_pending';
  const isClosed = task.state === 'cancelled';
  if (isClosed && sent === undefined) return [];

  const criteria = store.criteriaOf(task.id);
  const active = activeCriteria(criteria);
  const questions = store.questionsOf(task.id);
  const title = field(task.title ?? 'Untitled', TITLE_MAX);
  const approved = !isOpen && !isPending && !isClosed && task.task_no !== null;

  const blocks: string[][] = [];
  blocks.push([approved ? `<b>#${task.task_no} · ${title}</b>` : `<b>${title}</b> · draft`, `Goal: ${field(contract.goal, GOAL_MAX)}`]);
  const criteriaBlock = active.slice(0, CRITERIA_SHOWN).map(criterionLine);
  if (active.length > CRITERIA_SHOWN) criteriaBlock.push(`… and ${active.length - CRITERIA_SHOWN} more`);
  if (criteriaBlock.length > 0) blocks.push(criteriaBlock);
  if (questions.length > 0 && !approved) blocks.push(questions.map(questionLine));

  let markup: InlineKeyboard = NO_KEYBOARD;
  const items = openItems(criteria, questions);
  if (isOpen) {
    const notes: string[] = [];
    if (items.length > 0) notes.push(`Approve after: ${items.join(' · ')}`);
    if (refusal !== undefined) notes.push(`❌ Can't approve: ${field(refusal, 200)}`);
    if (notes.length > 0) blocks.push(notes);
    markup = openKeyboard(task, criteria, questions, items.length === 0, env);
  } else if (isPending) {
    blocks.push(['Discarded · undo within 1 min']);
    markup = keyboard(env, [[{ text: 'Undo', command: UNDO, task_id: task.id, expires_at: task.undo_expires_at }]]);
  } else if (isClosed) {
    if (closed === 'discarded') blocks.push(['Discarded']);
  } else if (approved) {
    blocks.push(['⏳ Queued · starts next']);
  }

  let html = blocks.map((block) => block.join('\n')).join('\n\n');
  if (visibleLength(html) > TEXT_LIMIT) html = escapeHtml(clip(html.replace(/<[^>]*>/g, ''), TEXT_LIMIT));
  if (isOpen) {
    // Antipode's side of the conversation, for the next Intake brief (AD-4).
    // Once per distinct text: re-renders and replays must not crowd Owner messages out of the brief window.
    const plain = plainText(html);
    const lastBot = store.intakeMessagesOf(task.id).filter((m) => m.sender === 'bot').at(-1);
    if (lastBot?.text !== plain) {
      store.insertIntakeMessage({ id: ulid(), task_id: task.id, sender: 'bot', text: plain, message_id: null, at: env.clock.now().toISOString() });
    }
  }
  if (sent === undefined) {
    return [textMessage(DRAFT_CARD, html, { task_id: task.id, reply_markup: markup })];
  }
  return [
    {
      kind: DRAFT_CARD,
      task_id: task.id,
      target_outbox_id: sent.id,
      payload: { method: 'editMessageText', params: { text: html, reply_markup: markup } },
    },
  ];
}
