import { afterEach, describe, expect, it } from 'vitest';
import { TelegramMessenger } from '../../../src/adapters/telegram/messenger.ts';
import type { Effect, EffectRow } from '../../../src/core/domain/effects.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { OWNER_ID } from '../../helpers/home.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';
import { CHAT_ID, fakeTelegram, type FakeTelegram } from '../../helpers/telegram.ts';
import { insertProject, insertTask, NOW } from './fixtures.ts';

let open: TestStore[] = [];
let messengers: TelegramMessenger[] = [];
afterEach(async () => {
  for (const m of messengers) await m.stop();
  for (const s of open) s.close();
  open = [];
  messengers = [];
});

function harness(): { ts: TestStore; tg: FakeTelegram; messenger: TelegramMessenger; settle(): Promise<void> } {
  const ts = openTestStore();
  open.push(ts);
  const tg = fakeTelegram();
  const messenger = new TelegramMessenger({
    api: tg.api,
    store: ts.store,
    clock: fakeClock(),
    config: () => ({ ownerId: OWNER_ID, staleAfterMs: 300_000, outboxRetries: 2 }),
    timeZone: 'UTC',
    setTimer: () => ({ cancel() {} }),
  });
  messengers.push(messenger);
  messenger.sender.start();
  return { ts, tg, messenger, settle: () => messenger.sender.idle() };
}

function row<E extends Effect>(effect: E): EffectRow & { effect: E } {
  const taskId = 'task_id' in effect && typeof effect.task_id === 'string' ? effect.task_id : null;
  return { effect_id: ulid(), task_id: taskId, kind: effect.kind, effect, status: 'pending', error: null, created_at: NOW, finished_at: null };
}

function card(round: number, taskId: string) {
  return { kind: 'review_card', task_id: taskId, round, payload: { method: 'sendMessage' as const, params: { text: `card r${round}` } } };
}

describe('TelegramMessenger.retireCard', () => {
  it("strips the keyboard of round N's card by its message_id and leaves round N+1 alone", async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id, { review_round: 2 });
    h.messenger.enqueue(CHAT_ID, [card(1, task.id)], null);
    h.messenger.enqueue(CHAT_ID, [card(2, task.id)], null);
    await h.settle();
    const [r1, r2] = h.ts.store.outboxOfChat(CHAT_ID);
    expect([r1?.sent_message_id, r2?.sent_message_id]).toEqual([1000, 1001]);

    const effect = { kind: 'retire_card', task_id: task.id, round: 1 } as const;
    await h.messenger.retireCard(effect, row(effect));
    await h.settle();
    expect(h.tg.callsOf('editMessageReplyMarkup')).toEqual([{ chat_id: CHAT_ID, message_id: 1000, reply_markup: { inline_keyboard: [] } }]);
  });

  it('queues nothing when the round has no card, or its card row failed', async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id);
    const none = { kind: 'retire_card', task_id: task.id, round: 1 } as const;
    await h.messenger.retireCard(none, row(none));
    expect(h.ts.store.outboxOfChat(CHAT_ID)).toEqual([]);

    const [failed] = h.ts.store.enqueueOutbox(CHAT_ID, [card(3, task.id)], null, NOW);
    h.ts.store.markOutboxFailed(failed!.id, 3, '400: Bad Request');
    const effect = { kind: 'retire_card', task_id: task.id, round: 3 } as const;
    await h.messenger.retireCard(effect, row(effect));
    expect(h.ts.store.outboxOfChat(CHAT_ID)).toHaveLength(1);
  });
});

describe('TelegramMessenger.notify', () => {
  const wait = (taskId: string) => ({ kind: 'notify', notice_kind: 'usage_window_wait', task_id: taskId, payload: { resets_at: '2026-11-08T14:20:00.000Z', key: 'k' } }) as const;

  it("replies to the Task's latest card in the same chat", async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id, { task_no: 12 });
    h.ts.store.insertTelegramMessage({ chat_id: CHAT_ID, message_id: 300, task_id: task.id, round: 1, kind: 'review_card' });
    await h.messenger.notify(wait(task.id), row(wait(task.id)));
    await h.settle();
    expect(h.tg.callsOf('sendMessage')).toEqual([
      expect.objectContaining({ chat_id: CHAT_ID, text: '⏸ #12 waiting for usage window · resumes ~14:20', reply_parameters: { message_id: 300, allow_sending_without_reply: true } }),
    ]);
  });

  it('sets no reply when the latest card is in another chat', async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id, { task_no: 12 });
    h.ts.store.insertTelegramMessage({ chat_id: -999, message_id: 300, task_id: task.id, round: 1, kind: 'review_card' });
    await h.messenger.notify(wait(task.id), row(wait(task.id)));
    await h.settle();
    const [sent] = h.tg.callsOf('sendMessage');
    expect(sent).toMatchObject({ chat_id: CHAT_ID });
    expect(sent?.['reply_parameters']).toBeUndefined();
  });
});

describe('TelegramMessenger.failAck', () => {
  it('still tries the ❌ reaction when refused, then sends an escaped reply to the Owner message', async () => {
    const h = harness();
    h.tg.fail('setMessageReaction', { error_code: 400, description: 'Bad Request: REACTION_INVALID' });
    await h.messenger.failAck(CHAT_ID, 42, "Couldn't process <that> — send it again.");
    await h.settle();
    expect(h.tg.callsOf('setMessageReaction')).toEqual([{ chat_id: CHAT_ID, message_id: 42, reaction: [{ type: 'emoji', emoji: '❌' }] }]);
    expect(h.tg.callsOf('sendMessage')).toEqual([
      expect.objectContaining({
        chat_id: CHAT_ID,
        text: "Couldn't process &lt;that&gt; — send it again.",
        parse_mode: 'HTML',
        reply_parameters: { message_id: 42, allow_sending_without_reply: true },
      }),
    ]);
  });
});

describe('TelegramMessenger.backOnline', () => {
  it("counts only the Project's ACTIVE Tasks", async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const other = insertProject(h.ts.store, -2);
    insertTask(h.ts.store, project.id, { state: 'implementing', task_no: 1 });
    insertTask(h.ts.store, project.id, { state: 'in_review', task_no: 2 });
    insertTask(h.ts.store, project.id, { state: 'released', task_no: 3 });
    insertTask(h.ts.store, other.id, { state: 'implementing' });
    const effect = { kind: 'back_online', project_id: project.id, gap_ms: 7_200_000 } as const;
    await h.messenger.backOnline(effect, row(effect));
    await h.settle();
    expect(h.tg.callsOf('sendMessage')).toEqual([
      expect.objectContaining({ chat_id: CHAT_ID, text: 'Back online · 2 Tasks resumed.', disable_notification: true }),
    ]);
  });
});
