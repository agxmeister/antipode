import { Api } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { OWNER_ID } from './home.ts';

/** A fake bot token; the transformer answers every call, so nothing reaches Telegram (AD-24). */
export const FAKE_TOKEN = '123456:fake-token-for-tests';

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** A Bot API error response, or a thrown error (a network failure). */
export type ScriptedFailure = { error_code: number; description: string; parameters?: { retry_after?: number } } | Error;

export interface FakeTelegram {
  /** The `Api` with the recording transformer installed. */
  api: Api;
  /** Every call in order, `getUpdates` included. */
  calls: ApiCall[];
  /** Payloads of every call of `method`. */
  callsOf(method: string): Array<Record<string, unknown>>;
  /** Calls other than `getUpdates`. */
  effective(): ApiCall[];
  /** Queues one batch for the next `getUpdates`. */
  pushUpdates(...updates: Update[]): void;
  /** Makes the next `times` calls of `method` fail with `failure`. */
  fail(method: string, failure: ScriptedFailure, times?: number): void;
  /** Overrides the result of `method`. */
  respond(method: string, result: (payload: Record<string, unknown>) => unknown): void;
  /** Batches handed out by `getUpdates` so far. */
  batchesServed(): number;
}

const SEND_METHODS = new Set(['sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument']);

/** A grammY transformer that records calls and scripts results, `getUpdates` batches and failures. */
export function fakeTelegram(): FakeTelegram {
  const api = new Api(FAKE_TOKEN);
  const calls: ApiCall[] = [];
  const batches: Update[][] = [];
  const failures = new Map<string, ScriptedFailure[]>();
  const results = new Map<string, (payload: Record<string, unknown>) => unknown>();
  let waiting: (() => void) | undefined;
  let nextMessageId = 1000;
  let served = 0;

  api.config.use(async (_prev, method, rawPayload, signal) => {
    const payload = rawPayload as Record<string, unknown>;
    calls.push({ method, payload });
    const scripted = failures.get(method)?.shift();
    if (scripted !== undefined) {
      if (scripted instanceof Error) throw scripted;
      return { ok: false, ...scripted } as never;
    }
    if (method === 'getUpdates') {
      while (batches.length === 0) {
        if (signal?.aborted) throw new Error('aborted');
        await new Promise<void>((resolve) => {
          waiting = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        waiting = undefined;
      }
      served += 1;
      return { ok: true, result: batches.shift() } as never;
    }
    const custom = results.get(method);
    if (custom !== undefined) return { ok: true, result: custom(payload) } as never;
    if (SEND_METHODS.has(method)) {
      const message = { message_id: nextMessageId++, date: 0, chat: { id: payload['chat_id'], type: 'supergroup', title: 'Antipode · Test' } };
      return { ok: true, result: message } as never;
    }
    return { ok: true, result: true } as never;
  });

  return {
    api,
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.payload),
    effective: () => calls.filter((call) => call.method !== 'getUpdates'),
    pushUpdates(...updates) {
      batches.push(updates);
      waiting?.();
    },
    fail(method, failure, times = 1) {
      const list = failures.get(method) ?? [];
      for (let i = 0; i < times; i++) list.push(failure);
      failures.set(method, list);
    },
    respond(method, result) {
      results.set(method, result);
    },
    batchesServed: () => served,
  };
}

export const CHAT_ID = -100_123;

export interface MessageOptions {
  chatId?: number;
  from?: number;
  /** Unix seconds. */
  date?: number;
  messageId?: number;
  replyTo?: number;
}

/** An update carrying a text message, from the Owner unless told otherwise. */
export function textUpdate(updateId: number, text: string, options: MessageOptions = {}): Update {
  const chatId = options.chatId ?? CHAT_ID;
  const message = {
    message_id: options.messageId ?? updateId,
    date: options.date ?? Math.floor(Date.UTC(2026, 10, 8, 12, 0, 0) / 1000),
    chat: { id: chatId, type: 'supergroup', title: 'Antipode · Test' },
    from: { id: options.from ?? OWNER_ID, is_bot: false, first_name: 'Owner' },
    text,
    ...(options.replyTo === undefined
      ? {}
      : { reply_to_message: { message_id: options.replyTo, date: 0, chat: { id: chatId, type: 'supergroup', title: 'Antipode · Test' } } }),
  } as unknown as Message;
  return { update_id: updateId, message } as Update;
}

/** An update carrying a button tap on message `messageId`. */
export function tapUpdate(updateId: number, data: string, options: MessageOptions = {}): Update {
  const chatId = options.chatId ?? CHAT_ID;
  return {
    update_id: updateId,
    callback_query: {
      id: `q${updateId}`,
      from: { id: options.from ?? OWNER_ID, is_bot: false, first_name: 'Owner' },
      chat_instance: 'ci',
      data,
      message: { message_id: options.messageId ?? 1, date: 0, chat: { id: chatId, type: 'supergroup', title: 'Antipode · Test' } },
    },
  } as unknown as Update;
}
