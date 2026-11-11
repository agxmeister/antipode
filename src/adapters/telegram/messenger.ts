import type { Api } from 'grammy';
import type { EffectOf, EffectRow } from '../../core/domain/effects.ts';
import { ACTIVE_STATES } from '../../core/domain/task.ts';
import type { OutboxDraft } from '../../core/domain/telegram.ts';
import type { Clock } from '../../core/ports/clock.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';
import type { Messenger } from '../../core/ports/messenger.ts';
import type { Store } from '../../core/ports/store.ts';
import { backOnlineCard } from './cards/back-online.ts';
import { escapeHtml, NO_KEYBOARD, textMessage, type CardEnv } from './cards/card.ts';
import { defaultNotices, type NoticeRenderer } from './cards/index.ts';
import { Poller, type CallbackCommand, type CommandHandler, type TextHandler } from './poller.ts';
import { OutboxSender } from './sender.ts';

/** The `/` menu, in order (Owner decision 2026-11-11), registered with `setMyCommands` at boot. */
export const COMMAND_MENU: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'register', description: 'Bind this group to a repo' },
  { command: 'status', description: 'Tasks in this Project' },
  { command: 'peek', description: 'Latest progress of a Task' },
  { command: 'parked', description: 'Parking Lot findings' },
  { command: 'cost', description: 'Usage and cost' },
  { command: 'pause', description: 'Pause new work' },
  { command: 'resume', description: 'Resume work' },
  { command: 'cancel', description: 'Cancel a Task' },
  { command: 'evidence', description: "Resend a Task's Evidence" },
  { command: 'log', description: 'Stage history of a Task' },
];

/**
 * AD-10's failure reaction. The Bot API's reaction set does not list `❌`, so Telegram may refuse it;
 * the refusal is logged and the reply still goes out. Raised for correct-course (story 1-4 report).
 */
export const FAIL_REACTION = '❌';

export interface TelegramConfig {
  /** `owner.telegram_user_id`. */
  ownerId: number;
  /** `telegram.stale_after_ms`. */
  staleAfterMs: number;
  /** `outbox.retries`. */
  outboxRetries: number;
}

export interface TelegramMessengerOptions {
  /** The one grammY `Api` every call goes through; tests install a transformer on it (AD-24). */
  api: Api;
  store: Store;
  clock: Clock;
  /** Read on every use so a SIGHUP reload applies. */
  config: () => TelegramConfig;
  log?: Log;
  timeZone?: string;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `telegram` adapter (AD-10) behind the `Messenger` port: an outbox sender, a long-polling
 * receiver, the card templates, and the registries later stories fill with command, callback and
 * free-text handlers.
 */
export class TelegramMessenger implements Messenger {
  readonly #api: Api;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #env: CardEnv;
  readonly #notices = defaultNotices();
  readonly sender: OutboxSender;
  readonly poller: Poller;

  constructor(options: TelegramMessengerOptions) {
    this.#api = options.api;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#log = options.log ?? silentLog;
    this.#env = { store: options.store, clock: options.clock, timeZone: options.timeZone };
    this.sender = new OutboxSender({
      api: options.api,
      store: options.store,
      clock: options.clock,
      retries: () => options.config().outboxRetries,
      log: this.#log,
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    });
    this.poller = new Poller({
      api: options.api,
      store: options.store,
      clock: options.clock,
      config: () => ({ ownerId: options.config().ownerId, staleAfterMs: options.config().staleAfterMs }),
      enqueue: (chatId, drafts) => this.enqueue(chatId, drafts, null),
      log: this.#log,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  /** The env templates render with: callbacks rows, clock and time zone. */
  get cardEnv(): CardEnv {
    return this.#env;
  }

  registerCommand(command: string, handler: CommandHandler): void {
    this.poller.commands.set(command, handler);
  }

  registerCallback(command: string, definition: CallbackCommand): void {
    this.poller.callbacks.set(command, definition);
  }

  onText(handler: TextHandler): void {
    this.poller.onText(handler);
  }

  registerNotice(noticeKind: string, renderer: NoticeRenderer): void {
    this.#notices.set(noticeKind, renderer);
  }

  /** Registers the command menu, then starts the sender (resending rows left pending) and the long poll. */
  async start(): Promise<void> {
    try {
      await this.#api.setMyCommands(COMMAND_MENU);
    } catch (error) {
      this.#log.warn({ event: 'telegram_commands_failed', error: errorText(error) }, 'telegram_commands_failed');
    }
    this.sender.start();
    this.poller.start();
    this.#log.info({ event: 'telegram_started' }, 'telegram_started');
  }

  /** Stops the long poll, then the sender; pending rows are resent at the next boot. */
  async stop(): Promise<void> {
    await this.poller.stop();
    await this.sender.stop();
  }

  /** Persists one group of rows in a chat and wakes the sender. Idempotent by `effectId`. */
  enqueue(chatId: number, drafts: readonly OutboxDraft[], effectId: string | null): void {
    this.#store.enqueueOutbox(chatId, drafts, effectId, this.#clock.now().toISOString());
    this.sender.wake();
  }

  /** The chat of a Project, or undefined (logged `notice_unroutable`) when it has none. */
  #chatOf(projectId: string | undefined, fields: Record<string, unknown>): number | undefined {
    const chat = projectId === undefined ? undefined : this.#store.getProject(projectId)?.telegram_chat_id;
    if (chat === undefined || chat === null) {
      this.#log.warn({ event: 'notice_unroutable', project_id: projectId, ...fields }, 'notice_unroutable');
      return undefined;
    }
    return chat;
  }

  async notify(effect: EffectOf<'notify'>, row: EffectRow): Promise<void> {
    const task = effect.task_id === undefined ? undefined : this.#store.getTask(effect.task_id);
    const chatId = this.#chatOf(effect.project_id ?? task?.project_id, { task_id: effect.task_id, notice_kind: effect.notice_kind });
    if (chatId === undefined) {
      return;
    }
    const render = this.#notices.get(effect.notice_kind);
    if (render === undefined) {
      throw new Error(`no template for notice ${effect.notice_kind}`);
    }
    const card = task === undefined ? undefined : this.#store.latestCardOfTask(task.id);
    this.#store.transaction(() => {
      const drafts = render({ effect, task, replyTo: card?.chat_id === chatId ? card.message_id : undefined }, this.#env);
      this.#store.enqueueOutbox(chatId, drafts, row.effect_id, this.#clock.now().toISOString());
    });
    this.sender.wake();
  }

  async backOnline(effect: EffectOf<'back_online'>, row: EffectRow): Promise<void> {
    const chatId = this.#chatOf(effect.project_id, { notice_kind: 'back_online' });
    if (chatId === undefined) {
      return;
    }
    const tasks = this.#store.tasksInStates(ACTIVE_STATES).filter((task) => task.project_id === effect.project_id).length;
    this.enqueue(chatId, backOnlineCard.render({ tasks }, this.#env), row.effect_id);
  }

  async retireCard(effect: EffectOf<'retire_card'>, row: EffectRow): Promise<void> {
    const card = this.#store.latestCardOutbox(effect.task_id, effect.round);
    if (card === undefined || card.status === 'failed') {
      this.#log.debug({ event: 'retire_card_none', task_id: effect.task_id, round: effect.round }, 'retire_card_none');
      return;
    }
    const edit: OutboxDraft = {
      kind: 'retire_card',
      task_id: effect.task_id,
      round: effect.round,
      target_outbox_id: card.id,
      payload: { method: 'editMessageReplyMarkup', params: { reply_markup: NO_KEYBOARD } },
    };
    this.enqueue(card.chat_id, [edit], row.effect_id);
  }

  async failAck(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.#api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: FAIL_REACTION as '👎' }]);
    } catch (error) {
      this.#log.warn({ event: 'telegram_ack_failed', chat_id: chatId, message_id: messageId, error: errorText(error) }, 'telegram_ack_failed');
    }
    const replied = this.#store.getTelegramMessage(chatId, messageId);
    this.enqueue(chatId, [textMessage('fail_ack', escapeHtml(text), { task_id: replied?.task_id ?? null, reply_to: messageId })], null);
  }
}
