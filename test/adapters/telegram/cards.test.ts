import { afterEach, describe, expect, it } from 'vitest';
import { backOnlineCard } from '../../../src/adapters/telegram/cards/back-online.ts';
import {
  CAPTION_LIMIT,
  clip,
  escapeHtml,
  fit,
  keyboard,
  TEXT_LIMIT,
  visibleLength,
  type CardEnv,
} from '../../../src/adapters/telegram/cards/card.ts';
import { deliveryFailedCard } from '../../../src/adapters/telegram/cards/delivery-failed.ts';
import { renderStuckCard, STUCK_CARD, STUCK_FOOTER } from '../../../src/adapters/telegram/cards/stuck-card.ts';
import { taskSchema, type Task } from '../../../src/core/domain/task.ts';
import { usageWindowResumedCard } from '../../../src/adapters/telegram/cards/usage-window-resumed.ts';
import { usageWindowWaitCard } from '../../../src/adapters/telegram/cards/usage-window-wait.ts';
import { ULID_PATTERN } from '../../../src/core/domain/ids.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

function env(timeZone = 'UTC'): CardEnv & { ts: TestStore } {
  const ts = openTestStore();
  open.push(ts);
  return { ts, store: ts.store, clock: fakeClock(), timeZone };
}

function text(drafts: ReturnType<typeof deliveryFailedCard.render>): string {
  return String(drafts[0]?.payload.params['text']);
}

describe('card helpers', () => {
  it('escapes HTML and measures visible length with tags removed and entities decoded', () => {
    expect(escapeHtml('a < b && "c" > d')).toBe('a &lt; b &amp;&amp; &quot;c&quot; &gt; d');
    expect(visibleLength('<b>#3 · AC1</b> &lt;ok&gt;')).toBe('#3 · AC1 <ok>'.length);
  });

  it('clip leaves short text alone and ends clipped text with …, never splitting a surrogate pair', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdef', 4)).toBe('abc…');
    const emoji = `ab${'😀'.repeat(3)}`;
    const clipped = clip(emoji, 4);
    expect(clipped).toBe('ab…');
    expect(clipped.length).toBeLessThanOrEqual(4);
  });

  it('fit clips a free-text field so the whole visible text is exactly 4096, or 1024 for a caption', () => {
    const long = '<x>'.repeat(3000);
    const message = fit((field) => `<b>#12 · title</b> ${field}`, long);
    expect(visibleLength(message)).toBe(TEXT_LIMIT);
    expect(message.endsWith('…')).toBe(true);
    expect(message).not.toContain('<x>');
    const caption = fit((field) => `<b>#12 · AC1</b> ✅ ${field}`, 'y'.repeat(2000), CAPTION_LIMIT);
    expect(visibleLength(caption)).toBe(CAPTION_LIMIT);
    expect(caption.endsWith('…')).toBe(true);
  });

  it('keyboard inserts one callbacks row per button and uses cb:<ulid> within 64 bytes', () => {
    const e = env();
    const markup = keyboard(e, [[{ text: 'Accept', command: 'accept', round: 2 }, { text: 'Request changes', command: 'request_changes', round: 2 }]]);
    const buttons = markup.inline_keyboard[0] ?? [];
    expect(buttons.map((b) => b.text)).toEqual(['Accept', 'Request changes']);
    for (const button of buttons) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      const id = button.callback_data.slice(3);
      expect(button.callback_data.startsWith('cb:')).toBe(true);
      expect(id).toMatch(ULID_PATTERN);
      expect(e.store.getCallback(id)).toMatchObject({ round: 2, task_id: null, expires_at: null, args: {} });
    }
    expect(e.store.getCallback(buttons[0]!.callback_data.slice(3))?.command).toBe('accept');
  });
});

describe('notice templates', () => {
  it('usage_window_wait: ⏸ line with the local reset time, replying to the card', () => {
    const e = env('UTC');
    const [draft] = usageWindowWaitCard.render({ task_id: 't1', task_no: 12, resets_at: '2026-11-08T14:20:00.000Z', reply_to: 55 }, e);
    expect(draft).toMatchObject({
      kind: 'usage_window_wait',
      task_id: 't1',
      payload: { method: 'sendMessage', params: { text: '⏸ #12 waiting for usage window · resumes ~14:20', reply_parameters: { message_id: 55 } } },
    });
    const [berlin] = usageWindowWaitCard.render({ task_id: 't1', task_no: 12, resets_at: '2026-11-08T14:20:00.000Z' }, env('Europe/Berlin'));
    expect(berlin?.payload.params['text']).toBe('⏸ #12 waiting for usage window · resumes ~15:20');
    expect(berlin?.payload.params['reply_parameters']).toBeUndefined();
  });

  it('usage_window_resumed and back_online copy', () => {
    const e = env();
    expect(usageWindowResumedCard.render({ task_id: 't1', task_no: 12 }, e)[0]?.payload.params['text']).toBe('#12 resumed');
    expect(backOnlineCard.render({ tasks: 2 }, e)[0]?.payload.params['text']).toBe('Back online · 2 Tasks resumed.');
    expect(backOnlineCard.render({ tasks: 1 }, e)[0]?.payload.params['text']).toBe('Back online · 1 Task resumed.');
  });

  it('delivery_failed copy for a Review row, another Task row and no Task; the reason is escaped and clipped', () => {
    const e = env();
    expect(text(deliveryFailedCard.render({ task_no: 12, review: true, reason: '400: Bad <file>' }, e))).toBe(
      "❌ #12 Review couldn't be delivered: 400: Bad &lt;file&gt;",
    );
    expect(text(deliveryFailedCard.render({ task_no: 12, review: false, reason: 'x' }, e))).toBe("❌ #12 message couldn't be delivered: x");
    expect(text(deliveryFailedCard.render({ task_no: null, review: false, reason: 'x' }, e))).toBe("❌ Message couldn't be delivered: x");
    const long = text(deliveryFailedCard.render({ task_no: 12, review: true, reason: 'r'.repeat(10_000) }, e));
    expect(visibleLength(long)).toBe(TEXT_LIMIT);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('Stuck card (DESIGN stuck-card)', () => {
  const NOW = '2026-11-08T12:00:00.000Z';

  function stuckTask(e: ReturnType<typeof env>): Task {
    e.store.insertProject({ id: 'p1', name: 'training', paused_at: null, telegram_chat_id: -1, repo_url: null, exclusive_capabilities: [], created_at: NOW });
    const task = taskSchema.parse({
      id: 't1', project_id: 'p1', kind: 'feature', task_no: 12, state: 'stuck', current_stage_id: null, budget_used: 3, budget_limit: 3, review_round: 0,
      resume_state: null, stuck_reason: 'stored reason', waiting_reason: null, undo_expires_at: null, config_sha: null, title: 'Rest <timer>', slug: 'rest-timer', created_at: NOW, updated_at: NOW,
    });
    e.store.insertTask(task);
    for (const [i, summary] of ['first try', 'second try', 'third try', 'fourth try'].entries()) {
      const id = `s${i}`;
      e.store.insertStage({ id, task_id: 't1', role: 'implementer', attempt: 1, status: 'succeeded', reason: null, created_at: NOW, started_at: NOW, ended_at: NOW });
      e.store.setStageOutput(id, { status: 'done', summary });
    }
    return task;
  }

  function notice(task: Task, payload: Record<string, unknown>) {
    return { effect: { kind: 'notify' as const, notice_kind: STUCK_CARD, task_id: task.id, payload }, task, replyTo: undefined };
  }

  it('renders title, reason, the last three laps, the buttons and the footer', () => {
    const e = env();
    const task = stuckTask(e);
    const [draft] = renderStuckCard(notice(task, { reason: 'AC2 & AC3 conflict' }), e);
    expect(draft!.kind).toBe('stuck_card');
    expect(draft!.payload.params['text']).toBe(
      ['🧱 <b>#12 · Rest &lt;timer&gt;</b> · Stuck', 'AC2 &amp; AC3 conflict', '', 'Lap 2: second try', 'Lap 3: third try', 'Lap 4: fourth try', '', STUCK_FOOTER].join('\n'),
    );
    const markup = draft!.payload.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(markup.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([['Raise budget +2', 'Cancel Task']]);
    const raise = e.store.getCallback(markup.inline_keyboard[0]![0]!.callback_data.slice(3));
    expect(raise).toMatchObject({ command: 'raise_budget', task_id: 't1', round: null, args: { amount: 2 } });
  });

  it('edits the sent card: confirm swaps the buttons, closed replaces buttons and footer with a state line; nothing without a sent card', () => {
    const e = env();
    const task = stuckTask(e);
    expect(renderStuckCard(notice(task, { mode: 'confirm' }), e)).toEqual([]);
    const [sent] = e.store.enqueueOutbox(-1, renderStuckCard(notice(task, { reason: 'why' }), e), null, NOW);
    const [confirm] = renderStuckCard(notice(task, { mode: 'confirm' }), e);
    expect(confirm).toMatchObject({ kind: 'stuck_card', target_outbox_id: sent!.id, payload: { method: 'editMessageText', params: { text: sent!.payload.params['text'] } } });
    const buttons = (confirm!.payload.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard;
    expect(buttons.map((row) => row.map((b) => b.text))).toEqual([['Confirm cancel #12', 'Keep']]);
    const [raised] = renderStuckCard(notice(task, { closed: 'raised', amount: 2 }), e);
    expect(raised!.payload.params['text']).toBe(['🧱 <b>#12 · Rest &lt;timer&gt;</b> · Stuck', 'why', '', 'Lap 2: second try', 'Lap 3: third try', 'Lap 4: fourth try', '', '⏳ Budget +2 · resuming'].join('\n'));
    expect(raised!.payload.params['reply_markup']).toEqual({ inline_keyboard: [] });
    const [cancelled] = renderStuckCard(notice(task, { closed: 'cancelled' }), e);
    expect(String(cancelled!.payload.params['text']).endsWith('Lap 4: fourth try\n\nCancelled')).toBe(true);
    const [paused] = renderStuckCard(notice(task, { closed: 'paused' }), e);
    expect(String(paused!.payload.params['text']).endsWith('Lap 4: fourth try\n\n⏸ Paused by you')).toBe(true);
    expect(paused!.payload.params['reply_markup']).toEqual({ inline_keyboard: [] });
    const [amended] = renderStuckCard(notice(task, { closed: 'amended' }), e);
    expect(String(amended!.payload.params['text']).endsWith('Lap 4: fourth try\n\n⏳ Amended · resuming')).toBe(true);
  });

  it('stuck on unsatisfiable dependencies: Cancel Task alone, also when Keep restores the buttons (2026-11-22)', () => {
    const e = env();
    const task = stuckTask(e);
    e.store.appendStageEvent({
      id: 'ev1', task_id: 't1', stage_id: null, event_type: 'deps_unsatisfiable', payload: '{}', status: 'applied', ignore_reason: null,
      from_state: 'waiting_on_dependencies', to_state: 'stuck', created_at: NOW,
    });
    const texts = (draft: { payload: { params: Record<string, unknown> } }) =>
      (draft.payload.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard.map((row) => row.map((b) => b.text));
    const [first] = renderStuckCard(notice(task, { reason: 'depends on cancelled #3' }), e);
    expect(texts(first!)).toEqual([['Cancel Task']]);
    expect(String(first!.payload.params['text']).endsWith(STUCK_FOOTER)).toBe(true);
    e.store.enqueueOutbox(-1, [first!], null, NOW);
    const [restored] = renderStuckCard(notice(task, { mode: 'restore' }), e);
    expect(texts(restored!)).toEqual([['Cancel Task']]);
  });
});
