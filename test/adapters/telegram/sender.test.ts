import { InputFile } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { backoffMs, OutboxSender } from '../../../src/adapters/telegram/sender.ts';
import type { OutboxDraft } from '../../../src/core/domain/telegram.ts';
import { fakeClock, type FakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';
import { CHAT_ID, fakeTelegram, type FakeTelegram } from '../../helpers/telegram.ts';
import { insertProject, insertTask } from './fixtures.ts';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

interface Harness {
  ts: TestStore;
  tg: FakeTelegram;
  clock: FakeClock;
  sender: OutboxSender;
  timers: Array<{ ms: number; fn: () => void; cancelled: boolean }>;
  enqueue(drafts: OutboxDraft[], chatId?: number): string[];
  /** Runs everything due, then waits until no chat is busy. */
  settle(): Promise<void>;
  /** Advances the clock by `ms` and fires the timers that came due. */
  advance(ms: number): Promise<void>;
  texts(): unknown[];
}

function harness(retries = 2): Harness {
  const ts = openTestStore();
  open.push(ts);
  const tg = fakeTelegram();
  const clock = fakeClock();
  const timers: Harness['timers'] = [];
  const sender = new OutboxSender({
    api: tg.api,
    store: ts.store,
    clock,
    retries: () => retries,
    setTimer: (fn, ms) => {
      const timer = { ms: clock.monotonicMs() + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  });
  sender.start();
  const h: Harness = {
    ts,
    tg,
    clock,
    sender,
    timers,
    enqueue(drafts, chatId = CHAT_ID) {
      const rows = ts.store.enqueueOutbox(chatId, drafts, null, clock.now().toISOString());
      return rows.map((r) => r.id);
    },
    async settle() {
      sender.wake();
      await sender.idle();
    },
    async advance(ms) {
      clock.advance(ms);
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.ms <= clock.monotonicMs()) timer.fn();
        else timers.push(timer);
      }
      await sender.idle();
    },
    texts: () => tg.callsOf('sendMessage').map((p) => p['text']),
  };
  return h;
}

function msg(text: string, kind = 'notice', extra: Partial<OutboxDraft> = {}): OutboxDraft {
  return { kind, payload: { method: 'sendMessage', params: { text } }, ...extra };
}

const serverError = { error_code: 502, description: 'Bad Gateway' };

describe('OutboxSender', () => {
  it('sends in sequence order and starts the second group only after the first group is fully sent', async () => {
    const h = harness();
    h.enqueue([msg('a1'), msg('a2'), msg('a3')]);
    h.enqueue([msg('b1'), msg('b2')]);
    h.tg.fail('sendMessage', serverError, 2);
    await h.settle();
    // a1 failed: the chat waits, nothing behind it goes out.
    expect(h.texts()).toEqual(['a1']);
    await h.advance(backoffMs(1));
    expect(h.texts()).toEqual(['a1', 'a1']);
    await h.advance(backoffMs(2));
    expect(h.texts()).toEqual(['a1', 'a1', 'a1', 'a2', 'a3', 'b1', 'b2']);
    expect(h.ts.store.outboxOfChat(CHAT_ID).map((r) => [r.sequence, r.status])).toEqual([
      [1, 'sent'],
      [2, 'sent'],
      [3, 'sent'],
      [4, 'sent'],
      [5, 'sent'],
    ]);
  });

  it('sets HTML parse mode and disable_notification on every kind except the loud ones; records sent messages', async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id);
    h.enqueue([
      msg('evidence', 'evidence', { task_id: task.id, round: 1 }),
      msg('card', 'review_card', { task_id: task.id, round: 1 }),
      msg('stuck', 'stuck_card'),
      msg('rf', 'release_failed'),
      msg('ob', 'onboarding_blocked'),
      msg('reg', 'registration_failed'),
      msg('df', 'delivery_failed'),
      msg('wait', 'usage_window_wait'),
    ]);
    await h.settle();
    const sent = h.tg.callsOf('sendMessage');
    expect(sent.map((p) => [p['text'], p['disable_notification'], p['parse_mode'], p['chat_id']])).toEqual([
      ['evidence', true, 'HTML', CHAT_ID],
      ['card', false, 'HTML', CHAT_ID],
      ['stuck', false, 'HTML', CHAT_ID],
      ['rf', false, 'HTML', CHAT_ID],
      ['ob', false, 'HTML', CHAT_ID],
      ['reg', false, 'HTML', CHAT_ID],
      ['df', false, 'HTML', CHAT_ID],
      ['wait', true, 'HTML', CHAT_ID],
    ]);
    expect(h.ts.store.latestCardOfTask(task.id)).toEqual({ chat_id: CHAT_ID, message_id: 1001, task_id: task.id, round: 1, kind: 'review_card' });
    expect(h.ts.store.getTelegramMessage(CHAT_ID, 1000)?.kind).toBe('evidence');
  });

  it('uploads {file_path} parameters as InputFile with an HTML caption', async () => {
    const h = harness();
    h.enqueue([{ kind: 'evidence', payload: { method: 'sendPhoto', params: { photo: { file_path: '/tmp/a.png' }, caption: '<b>#1 · AC1</b>' } } }]);
    await h.settle();
    const [photo] = h.tg.callsOf('sendPhoto');
    expect(photo?.['photo']).toBeInstanceOf(InputFile);
    expect(photo).toMatchObject({ caption: '<b>#1 · AC1</b>', parse_mode: 'HTML', disable_notification: true });
  });

  it.each([
    ['5xx', serverError, backoffMs(1)],
    ['network error', new Error('ECONNRESET'), backoffMs(1)],
    ['429 with retry_after', { error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }, 7_000],
  ] as const)('retries a %s with backoff and keeps the row pending', async (_name, failure, delay) => {
    const h = harness();
    const [id] = h.enqueue([msg('x')]);
    h.tg.fail('sendMessage', failure);
    await h.settle();
    expect(h.ts.store.getOutbox(id!)).toMatchObject({
      status: 'pending',
      attempts: 1,
      next_attempt_at: new Date(h.clock.now().getTime() + delay).toISOString(),
    });
    await h.advance(delay - 1);
    expect(h.texts()).toHaveLength(1);
    await h.advance(1);
    expect(h.ts.store.getOutbox(id!)).toMatchObject({ status: 'sent', attempts: 2, sent_message_id: 1000 });
  });

  it('backs off 1 s · 2ⁿ up to 60 s', () => {
    expect([1, 2, 3, 6, 7, 20].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
  });

  it('after outbox.retries retries marks the row failed, skips it and queues a loud Review delivery-failure notice', async () => {
    const h = harness(2);
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id, { task_no: 12 });
    const [evidence] = h.enqueue([msg('ev', 'evidence', { task_id: task.id, round: 1 }), msg('card', 'review_card', { task_id: task.id, round: 1 })]);
    h.tg.fail('sendMessage', serverError, 3);
    await h.settle();
    await h.advance(backoffMs(1));
    await h.advance(backoffMs(2));
    expect(h.ts.store.getOutbox(evidence!)).toMatchObject({ status: 'failed', attempts: 3, error: '502: Bad Gateway' });
    const rows = h.ts.store.outboxOfChat(CHAT_ID);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['evidence', 'failed'],
      ['review_card', 'sent'],
      ['delivery_failed', 'sent'],
    ]);
    const notice = h.tg.callsOf('sendMessage').at(-1);
    expect(notice).toMatchObject({ text: "❌ #12 Review couldn't be delivered: 502: Bad Gateway", disable_notification: false });
  });

  it('fails a permanent 4xx at once with a notice; a row without a Task gets the plain copy', async () => {
    const h = harness();
    const [id] = h.enqueue([msg('x')]);
    h.tg.fail('sendMessage', { error_code: 400, description: 'Bad Request: chat not found' });
    await h.settle();
    expect(h.ts.store.getOutbox(id!)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(h.texts().at(-1)).toBe("❌ Message couldn't be delivered: 400: Bad Request: chat not found");
  });

  it('a failed row of another Task kind gets the message copy', async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id, { task_no: 4 });
    h.enqueue([msg('x', 'usage_window_wait', { task_id: task.id })]);
    h.tg.fail('sendMessage', { error_code: 403, description: 'Forbidden: bot was kicked' });
    await h.settle();
    expect(h.texts().at(-1)).toBe("❌ #4 message couldn't be delivered: 403: Forbidden: bot was kicked");
  });

  it('counts "message is not modified" as sent', async () => {
    const h = harness();
    const [id] = h.enqueue([{ kind: 'retire_card', target_message_id: 77, payload: { method: 'editMessageReplyMarkup', params: { reply_markup: { inline_keyboard: [] } } } }]);
    h.tg.fail('editMessageReplyMarkup', { error_code: 400, description: 'Bad Request: message is not modified' });
    await h.settle();
    expect(h.ts.store.getOutbox(id!)).toMatchObject({ status: 'sent' });
    expect(h.ts.store.outboxOfChat(CHAT_ID)).toHaveLength(1);
    expect(h.tg.callsOf('editMessageReplyMarkup')[0]).toMatchObject({ chat_id: CHAT_ID, message_id: 77 });
    expect(h.tg.callsOf('editMessageReplyMarkup')[0]?.['parse_mode']).toBeUndefined();
  });

  it('a failing delivery-failure notice is marked failed and queues no further notice', async () => {
    const h = harness(0);
    const [id] = h.enqueue([msg('x')]);
    h.tg.fail('sendMessage', serverError, 2);
    await h.settle();
    const rows = h.ts.store.outboxOfChat(CHAT_ID);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['notice', 'failed'],
      ['delivery_failed', 'failed'],
    ]);
    expect(h.ts.store.getOutbox(id!)?.status).toBe('failed');
  });

  it('sends an edit after its pending target, with the target sent_message_id; a failed target fails the edit too', async () => {
    const h = harness();
    const cardId = 'CARD0000000000000000000001';
    h.enqueue([
      { id: cardId, ...msg('card', 'review_card') },
      { kind: 'review_card', target_outbox_id: cardId, payload: { method: 'editMessageText', params: { text: 'card ✅ Accepted' } } },
    ]);
    await h.settle();
    expect(h.tg.callsOf('editMessageText')).toEqual([expect.objectContaining({ chat_id: CHAT_ID, message_id: 1000, parse_mode: 'HTML', text: 'card ✅ Accepted' })]);

    const failedCard = 'CARD0000000000000000000002';
    h.tg.fail('sendMessage', { error_code: 400, description: 'Bad Request: bad markup' });
    const [, edit] = h.enqueue([
      { id: failedCard, ...msg('card2', 'review_card') },
      { kind: 'retire_card', target_outbox_id: failedCard, payload: { method: 'editMessageReplyMarkup', params: {} } },
    ]);
    await h.settle();
    expect(h.ts.store.getOutbox(edit!)).toMatchObject({ status: 'failed', error: 'target_failed' });
    expect(h.tg.callsOf('editMessageReplyMarkup')).toEqual([]);
    expect(h.ts.store.outboxOfChat(CHAT_ID).filter((r) => r.kind === 'delivery_failed')).toHaveLength(1);
  });

  it.each(['Bad Request: message to edit not found', "Bad Request: message can't be edited"])(
    'an edit refused with "%s" fails without a delivery-failure notice',
    async (description) => {
      const h = harness();
      const [id] = h.enqueue([{ kind: 'retire_card', target_message_id: 77, payload: { method: 'editMessageReplyMarkup', params: { reply_markup: { inline_keyboard: [] } } } }]);
      h.tg.fail('editMessageReplyMarkup', { error_code: 400, description });
      await h.settle();
      expect(h.ts.store.getOutbox(id!)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(h.ts.store.outboxOfChat(CHAT_ID)).toHaveLength(1);
      expect(h.tg.callsOf('sendMessage')).toEqual([]);
    },
  );

  it('a row enqueued after the drain last looked but before its worker ended is still sent', async () => {
    const h = harness();
    const original = h.ts.store.outboxHeads.bind(h.ts.store);
    let injected = false;
    let injecting = false;
    h.ts.store.outboxHeads = () => {
      const heads = original();
      if (!injected && !injecting && h.texts().length === 1 && !heads.some((r) => r.chat_id === CHAT_ID)) {
        // The drain just found the chat empty: enqueue and wake while its worker is still registered.
        injected = true;
        injecting = true;
        h.enqueue([msg('second')]);
        h.sender.wake();
        injecting = false;
      }
      return heads;
    };
    h.enqueue([msg('first')]);
    await h.settle();
    await h.sender.idle();
    expect(injected).toBe(true);
    expect(h.texts()).toEqual(['first', 'second']);
    expect(h.ts.store.outboxOfChat(CHAT_ID).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('a waiting row blocks only its own chat', async () => {
    const h = harness();
    h.tg.fail('sendMessage', serverError);
    h.enqueue([msg('a1'), msg('a2')], -1);
    await h.settle();
    h.enqueue([msg('b1')], -2);
    await h.settle();
    expect(h.texts()).toEqual(['a1', 'b1']);
    await h.advance(backoffMs(1));
    expect(h.texts()).toEqual(['a1', 'b1', 'a1', 'a2']);
  });

  it('stop() leaves pending rows for the next start', async () => {
    const h = harness();
    await h.sender.stop();
    h.enqueue([msg('later')]);
    h.sender.wake();
    await h.sender.idle();
    expect(h.texts()).toEqual([]);
    h.sender.start();
    await h.sender.idle();
    expect(h.texts()).toEqual(['later']);
  });
});
