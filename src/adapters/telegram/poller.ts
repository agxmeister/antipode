import { GrammyError, type Api } from 'grammy';
import type { CallbackQuery, Message, Update } from 'grammy/types';
import { CALLBACK_PREFIX, LAST_UPDATE_ID_SETTING, type CallbackRow, type TelegramMessageRow } from '../../core/domain/telegram.ts';
import type { Project, Task, TaskState } from '../../core/domain/task.ts';
import type { Clock } from '../../core/ports/clock.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';
import type { Store } from '../../core/ports/store.ts';
import { backoffMs } from './sender.ts';
import { clip, escapeHtml, textMessage } from './cards/card.ts';

/** `getUpdates` long-poll timeout in seconds. */
export const POLL_TIMEOUT_S = 30;
/** A callback handler that runs longer than this is answered without text; its toast follows as a reply. */
export const CALLBACK_ANSWER_MS = 4_000;
export const STALE_TAP_TOAST = 'This Review was replaced by a newer one.';
export const ACK_REACTION = '👀';
/** The only command an unbound chat dispatches (AD-10). */
export const REGISTER_COMMAND = 'register';
/** Prefix of the reply when a command or text handler throws (Owner decision 2026-11-12). */
export const HANDLER_FAILED = "❌ Couldn't handle that: ";
/** A failure reason is clipped to this many characters so the reply stays inside Telegram's limit. */
const REASON_LIMIT = 1_000;

/** An Owner message as handlers see it. */
export interface InboundMessage {
  message: Message;
  chatId: number;
  messageId: number;
  /** Text or caption; empty for media without one. */
  text: string;
  /** The Project bound to the chat; undefined only for `/register` in an unbound chat. */
  project: Project | undefined;
  /** The bot message this one replies to, when Antipode sent it. */
  replyTo: TelegramMessageRow | undefined;
  /** `message.date` is older than `telegram.stale_after_ms` (sent while Antipode was offline). */
  stale: boolean;
}

export interface CommandInput extends InboundMessage {
  command: string;
  /** Text after the command, trimmed. */
  args: string;
}

/**
 * Handles one Owner command.
 *
 * Updates are handled one at a time, and `telegram.last_update_id` is saved only after the handler
 * returns. A handler must therefore return quickly (commit a Coordinator event and let effects do the
 * work), so the acks of later updates stay within 5 s (NFR-6), and must be idempotent: an update is
 * handled again if the daemon dies mid-handler.
 */
export type CommandHandler = (input: CommandInput) => Promise<void> | void;
/**
 * Handles Owner text that is not a command.
 *
 * Updates are handled one at a time, and `telegram.last_update_id` is saved only after the handler
 * returns. A handler must therefore return quickly (commit a Coordinator event and let effects do the
 * work), so the acks of later updates stay within 5 s (NFR-6), and must be idempotent: an update is
 * handled again if the daemon dies mid-handler.
 */
export type TextHandler = (input: InboundMessage) => Promise<void> | void;

export interface CallbackInput {
  query: CallbackQuery;
  callback: CallbackRow;
  task: Task | undefined;
  chatId: number | undefined;
  messageId: number | undefined;
}

/**
 * A button command: the Task states its rows are valid in, and the handler that returns the toast.
 *
 * Updates are handled one at a time, and `telegram.last_update_id` is saved only after the handler
 * returns. A handler must therefore return quickly (commit a Coordinator event and let effects do the
 * work), so the acks of later updates stay within 5 s (NFR-6), and must be idempotent: an update is
 * handled again if the daemon dies mid-handler.
 * A handler slower than 4 s gets its tap answered without text and its toast sent as a reply.
 */
export interface CallbackCommand {
  /** States the Task must be in; omit for a command without a Task. */
  states?: readonly TaskState[];
  handle(input: CallbackInput): Promise<{ toast?: string } | void> | { toast?: string } | void;
}

export interface PollerOptions {
  api: Api;
  store: Store;
  clock: Clock;
  config: () => { ownerId: number; staleAfterMs: number };
  /** Persists an outbox reply and wakes the sender. */
  enqueue: (chatId: number, drafts: ReturnType<typeof textMessage>[]) => void;
  /** Replaces `👀` with `❌` on the Owner message and replies `text`; called when a handler throws. */
  failAck?: (chatId: number, messageId: number, text: string) => Promise<void>;
  log?: Log;
  /** Waits `ms` or until `signal` aborts; tests pass a fake. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Defaults to `CALLBACK_ANSWER_MS`; tests shorten it. */
  callbackAnswerMs?: number;
}

function errorText(error: unknown): string {
  if (error instanceof GrammyError) return `${error.error_code}: ${error.description}`;
  return error instanceof Error ? error.message : String(error);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** `/cmd@bot args` → `{command, args}`; undefined for text that is not a command. */
export function parseCommand(text: string): { command: string; args: string } | undefined {
  const match = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (match === null) return undefined;
  return { command: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Whether `answerCallbackQuery` was refused because the tap is too old to answer (an offline tap). */
function isTooOld(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400 && /too old|query id is invalid|timeout expired/i.test(error.description);
}

/**
 * The inbound side of AD-10: our own `getUpdates` loop, so the offset is persisted in `settings`
 * (`telegram.last_update_id`, saved after each update's handler). Honours only the Owner, reacts
 * `👀` before any processing, dispatches to the command, callback and text registries later stories
 * fill, and checks every tap against its `callbacks` row, Task state and `review_round`.
 */
export class Poller {
  readonly #api: Api;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #config: PollerOptions['config'];
  readonly #enqueue: PollerOptions['enqueue'];
  readonly #failAck: NonNullable<PollerOptions['failAck']> | undefined;
  readonly #log: Log;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #callbackAnswerMs: number;
  readonly commands = new Map<string, CommandHandler>();
  readonly callbacks = new Map<string, CallbackCommand>();
  #text: TextHandler | undefined;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  /** Late toasts of slow callback handlers still running. */
  readonly #late = new Set<Promise<void>>();

  constructor(options: PollerOptions) {
    this.#api = options.api;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#config = options.config;
    this.#enqueue = options.enqueue;
    this.#failAck = options.failAck;
    this.#log = options.log ?? silentLog;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#callbackAnswerMs = options.callbackAnswerMs ?? CALLBACK_ANSWER_MS;
  }

  /** The handler for Owner text that is not a command (Intake, story 1-8). */
  onText(handler: TextHandler): void {
    this.#text = handler;
  }

  start(): void {
    if (this.#loop !== undefined) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#run(abort.signal);
  }

  /** Aborts the long poll and waits for the update being handled, if any. */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
    await Promise.allSettled([...this.#late]);
    this.#loop = undefined;
    this.#abort = undefined;
  }

  lastUpdateId(): number | undefined {
    const value = this.#store.getSetting(LAST_UPDATE_ID_SETTING);
    return value === undefined ? undefined : Number(value);
  }

  async #run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        const last = this.lastUpdateId();
        updates = await this.#api.getUpdates(
          { timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'], ...(last === undefined ? {} : { offset: last + 1 }) },
          // grammY's Node typings use the `abort-controller` polyfill type; the runtime signal is the platform one.
          signal as unknown as Parameters<Api['getUpdates']>[1],
        );
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        const delay = backoffMs(failures);
        this.#log.warn({ event: 'telegram_poll_failed', error: errorText(error), delay_ms: delay }, 'telegram_poll_failed');
        await this.#sleep(delay, signal);
        continue;
      }
      for (const update of updates) {
        await this.handleUpdate(update);
      }
    }
  }

  /** Handles one update and saves its `update_id`; an update at or below the saved id is ignored. */
  async handleUpdate(update: Update): Promise<void> {
    const last = this.lastUpdateId();
    if (last !== undefined && update.update_id <= last) {
      return;
    }
    try {
      if (update.message !== undefined) {
        await this.#onMessage(update.message);
      } else if (update.callback_query !== undefined) {
        await this.#onCallback(update.callback_query);
      }
    } catch (error) {
      // A poison update must not stall the loop; the offset still advances.
      this.#log.error({ event: 'telegram_update_failed', update_id: update.update_id, error: errorText(error) }, 'telegram_update_failed');
    }
    this.#store.setSetting(LAST_UPDATE_ID_SETTING, String(update.update_id), this.#clock.now().toISOString());
  }

  #isOwner(userId: number | undefined): boolean {
    return userId !== undefined && userId === this.#config().ownerId;
  }

  async #onMessage(message: Message): Promise<void> {
    if (!this.#isOwner(message.from?.id)) {
      return;
    }
    const chatId = message.chat.id;
    const project = this.#store.projectByChat(chatId);
    const text = message.text ?? message.caption ?? '';
    const parsed = parseCommand(text);
    if (project === undefined && parsed?.command !== REGISTER_COMMAND) {
      return;
    }
    await this.#react(chatId, message.message_id);
    const reply = message.reply_to_message;
    const input: InboundMessage = {
      message,
      chatId,
      messageId: message.message_id,
      text,
      project,
      replyTo: reply === undefined ? undefined : this.#store.getTelegramMessage(chatId, reply.message_id),
      stale: message.date * 1_000 < this.#clock.now().getTime() - this.#config().staleAfterMs,
    };
    try {
      if (parsed !== undefined) {
        const handler = this.commands.get(parsed.command);
        if (handler === undefined) {
          this.#log.info({ event: 'telegram_command_unknown', command: parsed.command, project_id: project?.id }, 'telegram_command_unknown');
          return;
        }
        await handler({ ...input, ...parsed });
        return;
      }
      await this.#text?.(input);
    } catch (error) {
      // One central catch (Owner decision 2026-11-12): a failed handler reaches the Owner, not only the log.
      const reason = errorText(error);
      this.#log.error(
        { event: 'telegram_handler_failed', command: parsed?.command, project_id: project?.id, chat_id: chatId, error: reason },
        'telegram_handler_failed',
      );
      await this.#failAck?.(chatId, message.message_id, `${HANDLER_FAILED}${clip(reason, REASON_LIMIT)}`);
    }
  }

  /** `👀` before any processing (NFR-6); a failure is logged and processing continues. */
  async #react(chatId: number, messageId: number): Promise<void> {
    try {
      await this.#api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: ACK_REACTION }]);
    } catch (error) {
      this.#log.warn({ event: 'telegram_ack_failed', chat_id: chatId, message_id: messageId, error: errorText(error) }, 'telegram_ack_failed');
    }
  }

  async #onCallback(query: CallbackQuery): Promise<void> {
    if (!this.#isOwner(query.from.id)) {
      return;
    }
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const data = query.data ?? '';
    const callback = data.startsWith(CALLBACK_PREFIX) ? this.#store.getCallback(data.slice(CALLBACK_PREFIX.length)) : undefined;
    const command = callback === undefined ? undefined : this.callbacks.get(callback.command);
    const task = callback?.task_id == null ? undefined : this.#store.getTask(callback.task_id);
    if (callback === undefined || command === undefined || !this.#valid(callback, command, task)) {
      await this.#staleTap(query, callback, task);
      return;
    }
    const input: CallbackInput = { query, callback, task, chatId, messageId };
    const run = Promise.resolve().then(() => command.handle(input));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), this.#callbackAnswerMs);
    });
    const settled = run.then(
      (result) => ({ result: result ?? {} }),
      (error: unknown) => {
        // The tap is still answered (without text) so the Owner's spinner stops.
        this.#log.error({ event: 'telegram_callback_failed', command: callback.command, error: errorText(error) }, 'telegram_callback_failed');
        return { result: {} as { toast?: string } };
      },
    );
    const first = await Promise.race([settled, slow]).finally(() => clearTimeout(timer));
    if (first !== 'slow') {
      await this.#answer(query, first.result.toast);
      return;
    }
    // Answer inside Telegram's window without text; the toast follows as a reply once the handler is done.
    await this.#answer(query, undefined);
    const late: Promise<void> = settled
      .then(({ result }) => {
        if (result.toast !== undefined && chatId !== undefined) this.#reply(chatId, messageId, result.toast);
      })
      .finally(() => this.#late.delete(late));
    this.#late.add(late);
  }

  /** A row is valid iff its Task is in a state the command expects, `round = review_round`, and it has not expired. */
  #valid(callback: CallbackRow, command: CallbackCommand, task: Task | undefined): boolean {
    if (callback.expires_at !== null && Date.parse(callback.expires_at) <= this.#clock.now().getTime()) return false;
    if (callback.task_id === null) return true;
    if (task === undefined) return false;
    if (command.states !== undefined && !command.states.includes(task.state)) return false;
    if (callback.round !== null && callback.round !== task.review_round) return false;
    return true;
  }

  /** The "replaced" toast, plus a reply to the Task's latest card when there is one. */
  async #staleTap(query: CallbackQuery, callback: CallbackRow | undefined, task: Task | undefined): Promise<void> {
    this.#log.info({ event: 'telegram_stale_tap', callback_id: callback?.id, command: callback?.command, task_id: task?.id }, 'telegram_stale_tap');
    const card = task === undefined ? undefined : this.#store.latestCardOfTask(task.id);
    // With a card to point at, the reply to it also covers an offline tap whose toast is refused.
    await this.#answer(query, STALE_TAP_TOAST, card === undefined);
    if (card !== undefined) {
      this.#enqueue(card.chat_id, [textMessage('stale_tap', escapeHtml(STALE_TAP_TOAST), { task_id: card.task_id, reply_to: card.message_id })]);
    }
  }

  /**
   * Answers the tap directly (never queued). An offline tap is refused as too old: its toast then goes
   * out as a reply to the tapped message, unless `replyWhenOld` is false.
   */
  async #answer(query: CallbackQuery, toast: string | undefined, replyWhenOld = true): Promise<void> {
    try {
      await this.#api.answerCallbackQuery(query.id, toast === undefined ? {} : { text: toast });
    } catch (error) {
      const chatId = query.message?.chat.id;
      if (isTooOld(error) && toast !== undefined && chatId !== undefined && replyWhenOld) {
        this.#reply(chatId, query.message?.message_id, toast);
        return;
      }
      this.#log.warn({ event: 'telegram_answer_failed', error: errorText(error) }, 'telegram_answer_failed');
    }
  }

  #reply(chatId: number, messageId: number | undefined, text: string): void {
    const row = messageId === undefined ? undefined : this.#store.getTelegramMessage(chatId, messageId);
    this.#enqueue(chatId, [textMessage('toast_reply', escapeHtml(text), { task_id: row?.task_id ?? null, reply_to: messageId })]);
  }
}
