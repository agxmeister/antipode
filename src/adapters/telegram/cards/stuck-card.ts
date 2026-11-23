import { STUCK_CARD } from '../../../core/coordinator/transitions.ts';
import { lapsOf, stuckCause } from '../../../core/domain/loop.ts';
import type { Task } from '../../../core/domain/task.ts';
import type { OutboxDraft } from '../../../core/domain/telegram.ts';
import { clip, escapeHtml, keyboard, NO_KEYBOARD, textMessage, visibleLength, TEXT_LIMIT, type CardEnv, type InlineKeyboard } from './card.ts';
import type { NoticeInput } from './index.ts';

export { STUCK_CARD };

/** Callback commands of the Stuck card (AD-9: Coordinator commands, never Intake). */
export const RAISE_BUDGET = 'raise_budget';
export const CANCEL_TASK = 'cancel_task';
export const CONFIRM_CANCEL = 'confirm_cancel';
export const KEEP = 'keep';

/** What `Raise budget +2` adds (DESIGN `stuck-card`). */
export const RAISE_AMOUNT = 2;
export const STUCK_FOOTER = 'Or reply to amend or drop a criterion.';
/** Lap lines shown, newest last (DESIGN: up to 3). */
const LAPS_SHOWN = 3;
const TITLE_MAX = 80;
const REASON_MAX = 300;
const LAP_MAX = 140;

function line(text: string, max: number): string {
  return escapeHtml(clip(text.trim().replace(/\s+/g, ' '), max));
}

function title(task: Task): string {
  return line(task.title ?? (task.kind === 'bootstrap' ? 'Bootstrap' : 'Untitled'), TITLE_MAX);
}

/** Row 1: `Raise budget +2` · `Cancel Task`; `Cancel Task` alone when stuck on dependencies, which no budget helps (AD-3). */
function stuckKeyboard(task: Task, env: CardEnv): InlineKeyboard {
  const cancel = { text: 'Cancel Task', command: CANCEL_TASK, task_id: task.id };
  if (stuckCause(env.store.stageEventsOfTask(task.id)) === 'deps_unsatisfiable') return keyboard(env, [[cancel]]);
  return keyboard(env, [[{ text: `Raise budget +${RAISE_AMOUNT}`, command: RAISE_BUDGET, task_id: task.id, args: { amount: RAISE_AMOUNT } }, cancel]]);
}

/** After `Cancel Task`: `Confirm cancel #n` · `Keep`. */
function confirmKeyboard(task: Task, env: CardEnv): InlineKeyboard {
  return keyboard(env, [
    [
      { text: `Confirm cancel #${task.task_no}`, command: CONFIRM_CANCEL, task_id: task.id },
      { text: 'Keep', command: KEEP, task_id: task.id },
    ],
  ]);
}

/** The state line that replaces the buttons and the footer once the card is closed. */
function stateLine(payload: Record<string, unknown>): string | undefined {
  if (payload['closed'] === 'raised') return `⏳ Budget +${typeof payload['amount'] === 'number' ? payload['amount'] : RAISE_AMOUNT} · resuming`;
  if (payload['closed'] === 'cancelled') return 'Cancelled';
  if (payload['closed'] === 'paused') return '⏸ Paused by you';
  if (payload['closed'] === 'amended') return '⏳ Amended · resuming';
  return undefined;
}

/**
 * The Stuck card (DESIGN `stuck-card`), loud (AD-10): title, the stuck reason on one line, up to three
 * `Lap n: what` lines from the latest Implementer summaries, `Raise budget +2` · `Cancel Task`, and the
 * footer. Sent on every entry to `stuck`; the payload of a later render edits that card in place:
 * `mode: confirm` asks `Confirm cancel #n` · `Keep`, `mode: restore` brings the buttons back, `closed`
 * replaces buttons and footer with a state line. Nothing is rendered for an edit with no card sent.
 */
export function renderStuckCard(input: NoticeInput, env: CardEnv): OutboxDraft[] {
  const { task } = input;
  if (task === undefined || task.task_no === null) throw new Error(`notice ${STUCK_CARD} needs a numbered Task`);
  const payload = input.effect.payload ?? {};
  const fresh = payload['mode'] === undefined && payload['closed'] === undefined;
  if (fresh) {
    const reason = typeof payload['reason'] === 'string' && payload['reason'] !== '' ? payload['reason'] : (task.stuck_reason ?? '');
    const blocks: string[][] = [[`🧱 <b>#${task.task_no} · ${title(task)}</b> · Stuck`, line(reason === '' ? 'Stuck' : reason, REASON_MAX)]];
    const laps = lapsOf(env.store.stagesOfTask(task.id, 'implementer')).slice(-LAPS_SHOWN);
    if (laps.length > 0) blocks.push(laps.map((lap) => `Lap ${lap.n}: ${line(lap.summary, LAP_MAX)}`));
    blocks.push([STUCK_FOOTER]);
    let html = blocks.map((block) => block.join('\n')).join('\n\n');
    if (visibleLength(html) > TEXT_LIMIT) html = escapeHtml(clip(html.replace(/<[^>]*>/g, ''), TEXT_LIMIT));
    return [textMessage(STUCK_CARD, html, { task_id: task.id, reply_markup: stuckKeyboard(task, env) })];
  }

  const sent = env.store.latestCardOutbox(task.id);
  if (sent === undefined || sent.kind !== STUCK_CARD || sent.status === 'failed') return [];
  const text = String(sent.payload.params['text'] ?? '');
  const state = stateLine(payload);
  let html = text;
  let markup: InlineKeyboard;
  if (state !== undefined) {
    const body = text.endsWith(STUCK_FOOTER) ? text.slice(0, -STUCK_FOOTER.length).replace(/\n+$/, '') : text;
    html = `${body}\n\n${state}`;
    markup = NO_KEYBOARD;
  } else if (payload['mode'] === 'confirm') {
    markup = confirmKeyboard(task, env);
  } else {
    markup = stuckKeyboard(task, env);
  }
  return [{ kind: STUCK_CARD, task_id: task.id, target_outbox_id: sent.id, payload: { method: 'editMessageText', params: { text: html, reply_markup: markup } } }];
}
