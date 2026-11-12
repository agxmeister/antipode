import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramMessenger } from '../../../src/adapters/telegram/messenger.ts';
import { parseCommand, Poller, STALE_TAP_TOAST, type CallbackCommand, type CommandInput, type InboundMessage } from '../../../src/adapters/telegram/poller.ts';
import { ulid } from '../../../src/core/domain/ids.ts';
import { LAST_UPDATE_ID_SETTING, type OutboxDraft } from '../../../src/core/domain/telegram.ts';
import { fakeClock, type FakeClock } from '../../helpers/clock.ts';
import { OWNER_ID } from '../../helpers/home.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';
import { CHAT_ID, fakeTelegram, tapUpdate, textUpdate, type FakeTelegram } from '../../helpers/telegram.ts';
import { insertProject, insertTask, NOW } from './fixtures.ts';

let open: TestStore[] = [];
let pollers: Poller[] = [];
afterEach(async () => {
  for (const p of pollers) await p.stop();
  for (const s of open) s.close();
  open = [];
  pollers = [];
});

interface Harness {
  ts: TestStore;
  tg: FakeTelegram;
  clock: FakeClock;
  poller: Poller;
  replies: Array<{ chatId: number; drafts: OutboxDraft[] }>;
  sleeps: number[];
}

function harness(options: { callbackAnswerMs?: number } = {}): Harness {
  const ts = openTestStore();
  open.push(ts);
  const tg = fakeTelegram();
  const clock = fakeClock();
  const replies: Harness['replies'] = [];
  const sleeps: number[] = [];
  const poller = new Poller({
    api: tg.api,
    store: ts.store,
    clock,
    config: () => ({ ownerId: OWNER_ID, staleAfterMs: 300_000 }),
    enqueue: (chatId, drafts) => replies.push({ chatId, drafts }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  pollers.push(poller);
  return { ts, tg, clock, poller, replies, sleeps };
}

function lastUpdateId(h: Harness): string | undefined {
  return h.ts.store.getSetting(LAST_UPDATE_ID_SETTING);
}

describe('parseCommand', () => {
  it('parses commands with a bot mention and arguments; plain text is not a command', () => {
    expect(parseCommand('/peek 12')).toEqual({ command: 'peek', args: '12' });
    expect(parseCommand('/Register@antipode_bot github.com/a/b ')).toEqual({ command: 'register', args: 'github.com/a/b' });
    expect(parseCommand('/status')).toEqual({ command: 'status', args: '' });
    expect(parseCommand('make it bigger')).toBeUndefined();
  });
});

describe('Poller: messages', () => {
  it('reacts 👀 first, then runs the command handler, and saves update_id after the handler', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    const seen: Array<{ input: CommandInput; savedDuring: string | undefined; callsBefore: string[] }> = [];
    h.poller.commands.set('peek', (input) => {
      seen.push({ input, savedDuring: lastUpdateId(h), callsBefore: h.tg.effective().map((c) => c.method) });
    });
    await h.poller.handleUpdate(textUpdate(10, '/peek 12', { messageId: 501 }));
    expect(h.tg.callsOf('setMessageReaction')).toEqual([{ chat_id: CHAT_ID, message_id: 501, reaction: [{ type: 'emoji', emoji: '👀' }] }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ savedDuring: undefined, callsBefore: ['setMessageReaction'], input: { command: 'peek', args: '12', chatId: CHAT_ID, stale: false } });
    expect(lastUpdateId(h)).toBe('10');
  });

  it('dispatches Owner free text to the text handler with the replied-to bot message', async () => {
    const h = harness();
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id);
    h.ts.store.insertTelegramMessage({ chat_id: CHAT_ID, message_id: 77, task_id: task.id, round: 1, kind: 'review_card' });
    const texts: InboundMessage[] = [];
    h.poller.onText((input) => {
      texts.push(input);
    });
    await h.poller.handleUpdate(textUpdate(11, 'timer should be bigger', { replyTo: 77 }));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: 'timer should be bigger', project: { id: project.id }, replyTo: { task_id: task.id, kind: 'review_card' } });
  });

  it('ignores a replayed update at or below the saved update_id with no API call', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    const handler = vi.fn();
    h.poller.onText(handler);
    h.ts.store.setSetting(LAST_UPDATE_ID_SETTING, '20', NOW);
    await h.poller.handleUpdate(textUpdate(20, 'again'));
    await h.poller.handleUpdate(textUpdate(19, 'older'));
    expect(h.tg.calls).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    expect(lastUpdateId(h)).toBe('20');
  });

  it('ignores anyone but the Owner silently and advances the offset', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    const handler = vi.fn();
    h.poller.onText(handler);
    h.poller.commands.set('status', handler);
    await h.poller.handleUpdate(textUpdate(30, 'hello', { from: 999 }));
    await h.poller.handleUpdate(textUpdate(31, '/status', { from: 999 }));
    await h.poller.handleUpdate(tapUpdate(32, `cb:${ulid()}`, { from: 999 }));
    expect(h.tg.calls).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    expect(lastUpdateId(h)).toBe('32');
  });

  it('in an unbound chat dispatches only /register', async () => {
    const h = harness();
    const register = vi.fn();
    const status = vi.fn();
    const text = vi.fn();
    h.poller.commands.set('register', register);
    h.poller.commands.set('status', status);
    h.poller.onText(text);
    await h.poller.handleUpdate(textUpdate(40, '/status'));
    await h.poller.handleUpdate(textUpdate(41, 'hello'));
    expect(h.tg.calls).toEqual([]);
    await h.poller.handleUpdate(textUpdate(42, '/register github.com/agxmeister/training'));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ args: 'github.com/agxmeister/training', project: undefined }));
    expect(h.tg.callsOf('setMessageReaction')).toHaveLength(1);
    expect(status).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(lastUpdateId(h)).toBe('42');
  });

  it('a failed 👀 is logged and the handler still runs', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    h.tg.fail('setMessageReaction', { error_code: 400, description: 'Bad Request: REACTION_INVALID' });
    const handler = vi.fn();
    h.poller.onText(handler);
    await h.poller.handleUpdate(textUpdate(50, 'hi'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('marks a message older than telegram.stale_after_ms as stale', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    const seen: CommandInput[] = [];
    h.poller.commands.set('peek', (input) => {
      seen.push(input);
    });
    const now = Math.floor(h.clock.now().getTime() / 1000);
    await h.poller.handleUpdate(textUpdate(60, '/peek', { date: now - 301 }));
    await h.poller.handleUpdate(textUpdate(61, '/peek', { date: now - 60 }));
    expect(seen.map((s) => s.stale)).toEqual([true, false]);
  });

  it('a throwing handler is logged; the offset still advances', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    h.poller.onText(() => {
      throw new Error('boom');
    });
    await h.poller.handleUpdate(textUpdate(70, 'hi'));
    expect(lastUpdateId(h)).toBe('70');
  });
});

describe('Poller: callbacks', () => {
  function setupTap(h: Harness, overrides: { state?: 'in_review' | 'implementing'; review_round?: number } = {}) {
    const project = insertProject(h.ts.store, CHAT_ID);
    const task = insertTask(h.ts.store, project.id, { state: overrides.state ?? 'in_review', review_round: overrides.review_round ?? 2 });
    const handled: string[] = [];
    const command: CallbackCommand = {
      states: ['in_review'],
      handle: ({ callback }) => {
        handled.push(callback.id);
        return { toast: 'Accepted. Integrating.' };
      },
    };
    h.poller.callbacks.set('accept', command);
    const callback = (round: number, expires_at: string | null = null) => {
      const id = ulid();
      h.ts.store.insertCallback({ id, command: 'accept', task_id: task.id, round, args: {}, expires_at, created_at: NOW });
      return `cb:${id}`;
    };
    return { task, handled, callback };
  }

  it('a valid tap runs the handler and answers with its toast', async () => {
    const h = harness();
    const { handled, callback } = setupTap(h);
    await h.poller.handleUpdate(tapUpdate(100, callback(2), { messageId: 88 }));
    expect(handled).toHaveLength(1);
    expect(h.tg.callsOf('answerCallbackQuery')).toEqual([{ callback_query_id: 'q100', text: 'Accepted. Integrating.' }]);
    expect(h.replies).toEqual([]);
    expect(lastUpdateId(h)).toBe('100');
  });

  it.each([
    ['unknown row', 'unknown'],
    ['wrong state', 'state'],
    ['wrong round', 'round'],
    ['expired', 'expired'],
  ] as const)('a stale tap (%s) gets the replaced toast and a reply to the latest card', async (_name, why) => {
    const h = harness();
    const { task, handled, callback } = setupTap(h, { state: why === 'state' ? 'implementing' : 'in_review' });
    h.ts.store.insertTelegramMessage({ chat_id: CHAT_ID, message_id: 300, task_id: task.id, round: 2, kind: 'review_card' });
    const data =
      why === 'unknown' ? `cb:${ulid()}` : why === 'round' ? callback(1) : why === 'expired' ? callback(2, '2026-11-08T11:59:59.000Z') : callback(2);
    await h.poller.handleUpdate(tapUpdate(110, data));
    expect(handled).toEqual([]);
    expect(h.tg.callsOf('answerCallbackQuery')).toEqual([{ callback_query_id: 'q110', text: STALE_TAP_TOAST }]);
    if (why === 'unknown') {
      // No row, so no Task and no card to point at: toast only.
      expect(h.replies).toEqual([]);
    } else {
      expect(h.replies).toEqual([
        {
          chatId: CHAT_ID,
          drafts: [expect.objectContaining({ kind: 'stale_tap', payload: { method: 'sendMessage', params: { text: STALE_TAP_TOAST, reply_parameters: { message_id: 300, allow_sending_without_reply: true } } } })],
        },
      ]);
    }
  });

  it('a stale tap of a Task without a card gets the toast only', async () => {
    const h = harness();
    const { callback } = setupTap(h);
    await h.poller.handleUpdate(tapUpdate(120, callback(1)));
    expect(h.tg.callsOf('answerCallbackQuery')).toEqual([{ callback_query_id: 'q120', text: STALE_TAP_TOAST }]);
    expect(h.replies).toEqual([]);
  });

  it('an offline tap whose answer is refused as too old gets its toast as a reply to the tapped message', async () => {
    const h = harness();
    const { callback } = setupTap(h);
    h.tg.fail('answerCallbackQuery', { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' });
    await h.poller.handleUpdate(tapUpdate(130, callback(2), { messageId: 88 }));
    expect(h.replies).toEqual([
      {
        chatId: CHAT_ID,
        drafts: [expect.objectContaining({ kind: 'toast_reply', payload: { method: 'sendMessage', params: { text: 'Accepted. Integrating.', reply_parameters: { message_id: 88, allow_sending_without_reply: true } } } })],
      },
    ]);
  });

  it('a handler slower than the answer window is answered without text; its toast follows as a reply', async () => {
    const h = harness({ callbackAnswerMs: 20 });
    const { task } = setupTap(h);
    let finish!: () => void;
    h.poller.callbacks.set('slow', {
      states: ['in_review'],
      handle: () => new Promise((resolve) => (finish = () => resolve({ toast: 'Queued.' }))),
    });
    const id = ulid();
    h.ts.store.insertCallback({ id, command: 'slow', task_id: task.id, round: 2, args: {}, expires_at: null, created_at: NOW });
    await h.poller.handleUpdate(tapUpdate(140, `cb:${id}`, { messageId: 89 }));
    expect(h.tg.callsOf('answerCallbackQuery')).toEqual([{ callback_query_id: 'q140' }]);
    expect(h.replies).toEqual([]);
    finish();
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(h.replies[0]?.drafts[0]?.payload.params).toMatchObject({ text: 'Queued.', reply_parameters: { message_id: 89 } });
  });

  it('a throwing handler still answers the tap, without text', async () => {
    const h = harness();
    const { task } = setupTap(h);
    h.poller.callbacks.set('boom', {
      handle: () => {
        throw new Error('boom');
      },
    });
    const id = ulid();
    h.ts.store.insertCallback({ id, command: 'boom', task_id: task.id, round: null, args: {}, expires_at: null, created_at: NOW });
    await h.poller.handleUpdate(tapUpdate(150, `cb:${id}`));
    expect(h.tg.callsOf('answerCallbackQuery')).toEqual([{ callback_query_id: 'q150' }]);
  });
});

describe('Poller: loop', () => {
  it('long-polls with timeout 30 and offset after the saved update_id, handling batches in order', async () => {
    const h = harness();
    insertProject(h.ts.store, CHAT_ID);
    h.ts.store.setSetting(LAST_UPDATE_ID_SETTING, '5', NOW);
    const texts: string[] = [];
    h.poller.onText((input) => {
      texts.push(input.text);
    });
    h.tg.pushUpdates(textUpdate(6, 'one'), textUpdate(7, 'two'));
    h.poller.start();
    await vi.waitFor(() => expect(lastUpdateId(h)).toBe('7'));
    h.tg.pushUpdates(textUpdate(8, 'three'));
    await vi.waitFor(() => expect(lastUpdateId(h)).toBe('8'));
    await h.poller.stop();
    expect(texts).toEqual(['one', 'two', 'three']);
    const polls = h.tg.callsOf('getUpdates');
    expect(polls[0]).toMatchObject({ timeout: 30, offset: 6, allowed_updates: ['message', 'callback_query'] });
    expect(polls[1]).toMatchObject({ offset: 8 });
  });

  it('backs off after a failed getUpdates and stops on abort', async () => {
    const h = harness();
    h.tg.fail('getUpdates', new Error('ENOTFOUND'), 2);
    h.poller.start();
    await vi.waitFor(() => expect(h.tg.callsOf('getUpdates').length).toBeGreaterThanOrEqual(3));
    await h.poller.stop();
    expect(h.sleeps).toEqual([1_000, 2_000]);
  });
});

describe('Poller: handler failures reach the Owner (Owner decision 2026-11-12)', () => {
  function withFailAck() {
    const ts = openTestStore();
    open.push(ts);
    const tg = fakeTelegram();
    const acks: Array<{ chatId: number; messageId: number; text: string }> = [];
    const poller = new Poller({
      api: tg.api,
      store: ts.store,
      clock: fakeClock(),
      config: () => ({ ownerId: OWNER_ID, staleAfterMs: 300_000 }),
      enqueue: () => {},
      failAck: async (chatId, messageId, text) => {
        acks.push({ chatId, messageId, text });
      },
    });
    pollers.push(poller);
    return { ts, tg, poller, acks };
  }

  it('a throwing command handler gets failAck with the reason, and the offset still advances', async () => {
    const h = withFailAck();
    insertProject(h.ts.store, CHAT_ID);
    h.poller.commands.set('status', () => {
      throw new Error('database is locked');
    });
    await h.poller.handleUpdate(textUpdate(20, '/status', { messageId: 600 }));
    expect(h.acks).toEqual([{ chatId: CHAT_ID, messageId: 600, text: "❌ Couldn't handle that: database is locked" }]);
    expect(h.ts.store.getSetting(LAST_UPDATE_ID_SETTING)).toBe('20');
  });

  it('a rejecting text handler gets failAck too', async () => {
    const h = withFailAck();
    insertProject(h.ts.store, CHAT_ID);
    h.poller.onText(async () => {
      throw new Error('intake unavailable');
    });
    await h.poller.handleUpdate(textUpdate(21, 'add a rest timer', { messageId: 601 }));
    expect(h.acks).toEqual([{ chatId: CHAT_ID, messageId: 601, text: "❌ Couldn't handle that: intake unavailable" }]);
  });

  it('through the messenger: ❌ reaction (a refusal is only logged) and the reply still goes out', async () => {
    const ts = openTestStore();
    open.push(ts);
    const tg = fakeTelegram();
    const messenger = new TelegramMessenger({
      api: tg.api,
      store: ts.store,
      clock: fakeClock(),
      config: () => ({ ownerId: OWNER_ID, staleAfterMs: 300_000, outboxRetries: 2 }),
      setTimer: () => ({ cancel() {} }),
    });
    messenger.sender.start();
    insertProject(ts.store, CHAT_ID);
    messenger.registerCommand('status', () => {
      throw new Error('boom <now>');
    });
    tg.fail('setMessageReaction', { error_code: 400, description: 'Bad Request: REACTION_INVALID' });
    tg.fail('setMessageReaction', { error_code: 400, description: 'Bad Request: REACTION_INVALID' });
    await messenger.poller.handleUpdate(textUpdate(22, '/status', { messageId: 602 }));
    await messenger.sender.idle();
    await messenger.stop();
    expect(tg.callsOf('setMessageReaction').map((call) => call['reaction'])).toEqual([[{ type: 'emoji', emoji: '👀' }], [{ type: 'emoji', emoji: '❌' }]]);
    expect(tg.callsOf('sendMessage')).toEqual([
      expect.objectContaining({ text: "❌ Couldn't handle that: boom &lt;now&gt;", reply_parameters: { message_id: 602, allow_sending_without_reply: true } }),
    ]);
  });
});
