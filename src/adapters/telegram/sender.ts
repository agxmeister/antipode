import { GrammyError, InputFile, type Api } from 'grammy';
import { isEditMethod, LOUD_KINDS, outboxFileSchema, REVIEW_SEQUENCE_KINDS, type OutboxRow } from '../../core/domain/telegram.ts';
import type { Clock } from '../../core/ports/clock.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';
import type { Store } from '../../core/ports/store.ts';
import { deliveryFailedCard, DELIVERY_FAILED } from './cards/delivery-failed.ts';

/** Backoff of a retried row: 1 s · 2ⁿ, capped at 60 s (story 1-4). */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export interface SenderOptions {
  api: Api;
  store: Store;
  clock: Clock;
  /** `outbox.retries`, read per failure so a SIGHUP reload applies. */
  retries: () => number;
  log?: Log;
  /** Schedules the next look at a waiting chat; tests pass a fake. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

/** How one attempt ended. */
type Outcome =
  | { kind: 'sent'; messageId: number | null }
  | { kind: 'retry'; error: string; retryAfterMs?: number }
  | { kind: 'failed'; error: string; notice: boolean };

const NOT_MODIFIED = 'message is not modified';
const TARGET_FAILED = 'target_failed';

function errorText(error: unknown): string {
  if (error instanceof GrammyError) return `${error.error_code}: ${error.description}`;
  return error instanceof Error ? error.message : String(error);
}

/** Maps a failed call to retry or give up (AD-10): 429, 5xx and network errors retry; other 4xx are permanent. */
function classify(error: unknown): Outcome {
  if (error instanceof GrammyError) {
    if (error.description.includes(NOT_MODIFIED)) {
      return { kind: 'sent', messageId: null };
    }
    if (error.error_code === 429) {
      const after = error.parameters.retry_after;
      return { kind: 'retry', error: errorText(error), ...(after === undefined ? {} : { retryAfterMs: after * 1_000 }) };
    }
    if (error.error_code >= 500) {
      return { kind: 'retry', error: errorText(error) };
    }
    return { kind: 'failed', error: errorText(error), notice: true };
  }
  return { kind: 'retry', error: errorText(error) };
}

/** `{file_path}` parameters become uploads; everything else passes through. */
function toApiParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const file = outboxFileSchema.safeParse(value);
    out[key] = file.success ? new InputFile(file.data.file_path) : value;
  }
  return out;
}

/**
 * Drains the `outbox` (AD-10): each chat strictly in `sequence` order, chats independently. A failing
 * row waits with backoff and blocks only its own chat; after `outbox.retries` retries, or at once on a
 * permanent error, it is marked `failed`, skipped, and a loud delivery-failure notice is queued.
 * Delivery is at-least-once: a crash between a send and `markOutboxSent` resends that row at boot.
 */
export class OutboxSender {
  readonly #api: Api;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #retries: () => number;
  readonly #log: Log;
  readonly #setTimer: (fn: () => void, ms: number) => { cancel(): void };
  readonly #workers = new Map<number, Promise<void>>();
  readonly #timers = new Map<number, { cancel(): void }>();
  #running = false;

  constructor(options: SenderOptions) {
    this.#api = options.api;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#retries = options.retries;
    this.#log = options.log ?? silentLog;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(handle) };
      });
  }

  /** Starts draining, including rows left pending by an earlier run (AD-18). */
  start(): void {
    this.#running = true;
    this.wake();
  }

  /** Stops scheduling new sends and waits for the sends in flight; pending rows stay for the next boot. */
  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of this.#timers.values()) timer.cancel();
    this.#timers.clear();
    await Promise.allSettled([...this.#workers.values()]);
  }

  /** Looks at every chat's head row and starts a worker for each chat that has a due row. */
  wake(): void {
    if (!this.#running) {
      return;
    }
    for (const head of this.#store.outboxHeads()) {
      if (!this.#workers.has(head.chat_id)) {
        this.#startWorker(head.chat_id);
      }
    }
  }

  /** Resolves once no chat has a send in flight. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#workers.size > 0) {
      await Promise.allSettled([...this.#workers.values()]);
    }
  }

  #startWorker(chatId: number): void {
    this.#timers.get(chatId)?.cancel();
    this.#timers.delete(chatId);
    const worker = this.#drainChat(chatId)
      .catch((error: unknown) => {
        this.#log.error({ event: 'outbox_drain_failed', chat_id: chatId, error: errorText(error) }, 'outbox_drain_failed');
      })
      .finally(() => {
        this.#workers.delete(chatId);
      });
    this.#workers.set(chatId, worker);
  }

  async #drainChat(chatId: number): Promise<void> {
    while (this.#running) {
      const head = this.#store.outboxHeads().find((row) => row.chat_id === chatId);
      if (head === undefined) {
        return;
      }
      const waitMs = head.next_attempt_at === null ? 0 : Date.parse(head.next_attempt_at) - this.#clock.now().getTime();
      if (waitMs > 0) {
        // The chat waits; nothing behind its head goes out first.
        this.#timers.set(
          chatId,
          this.#setTimer(() => {
            this.#timers.delete(chatId);
            if (this.#running && !this.#workers.has(chatId)) this.#startWorker(chatId);
          }, waitMs),
        );
        return;
      }
      await this.#attempt(head);
    }
  }

  async #attempt(row: OutboxRow): Promise<void> {
    const outcome = await this.#send(row);
    const now = this.#clock.now();
    const attempts = row.attempts + 1;
    const fields = { chat_id: row.chat_id, outbox_id: row.id, kind: row.kind, task_id: row.task_id, attempts };
    switch (outcome.kind) {
      case 'sent':
        this.#store.transaction(() => {
          this.#store.markOutboxSent(row.id, outcome.messageId, now.toISOString());
          if (outcome.messageId !== null && !isEditMethod(row.payload.method)) {
            this.#store.insertTelegramMessage({ chat_id: row.chat_id, message_id: outcome.messageId, task_id: row.task_id, round: row.round, kind: row.kind });
          }
        });
        this.#log.debug({ event: 'outbox_sent', ...fields, message_id: outcome.messageId }, 'outbox_sent');
        return;
      case 'retry':
        if (attempts <= this.#retries()) {
          const delay = outcome.retryAfterMs ?? backoffMs(attempts);
          this.#store.markOutboxAttempt(row.id, attempts, new Date(now.getTime() + delay).toISOString(), outcome.error);
          this.#log.warn({ event: 'outbox_retry', ...fields, delay_ms: delay, error: outcome.error }, 'outbox_retry');
          return;
        }
        this.#fail(row, attempts, outcome.error, true);
        return;
      case 'failed':
        this.#fail(row, attempts, outcome.error, outcome.notice);
        return;
    }
  }

  async #send(row: OutboxRow): Promise<Outcome> {
    const { method } = row.payload;
    const params: Record<string, unknown> = { ...toApiParams(row.payload.params), chat_id: row.chat_id };
    if (isEditMethod(method)) {
      const target = this.#targetMessageId(row);
      if (typeof target !== 'number') {
        return target;
      }
      params['message_id'] = target;
    } else {
      params['disable_notification'] = !LOUD_KINDS.has(row.kind);
    }
    if (method !== 'editMessageReplyMarkup') {
      params['parse_mode'] = 'HTML';
    }
    try {
      const raw = this.#api.raw as unknown as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
      const result = await raw[method]!(params);
      const messageId =
        typeof result === 'object' && result !== null && typeof (result as { message_id?: unknown }).message_id === 'number'
          ? (result as { message_id: number }).message_id
          : isEditMethod(method)
            ? (params['message_id'] as number)
            : null;
      return { kind: 'sent', messageId };
    } catch (error) {
      return classify(error);
    }
  }

  /** The message an edit applies to; its target row must have been sent first. */
  #targetMessageId(row: OutboxRow): number | Outcome {
    if (row.target_message_id !== null) {
      return row.target_message_id;
    }
    const target = row.target_outbox_id === null ? undefined : this.#store.getOutbox(row.target_outbox_id);
    if (target === undefined) {
      return { kind: 'failed', error: 'edit has no target', notice: false };
    }
    if (target.status === 'failed') {
      // The Owner already got a notice for the target.
      return { kind: 'failed', error: TARGET_FAILED, notice: false };
    }
    if (target.status === 'pending' || target.sent_message_id === null) {
      // Cannot happen in one chat drained in order; wait for the target rather than fail.
      return { kind: 'retry', error: 'target not sent yet' };
    }
    return target.sent_message_id;
  }

  #fail(row: OutboxRow, attempts: number, error: string, notice: boolean): void {
    const fields = { chat_id: row.chat_id, outbox_id: row.id, kind: row.kind, task_id: row.task_id, attempts, error };
    this.#store.transaction(() => {
      this.#store.markOutboxFailed(row.id, attempts, error);
      if (notice && row.kind !== DELIVERY_FAILED) {
        const task = row.task_id === null ? undefined : this.#store.getTask(row.task_id);
        const drafts = deliveryFailedCard.render(
          { task_id: task?.id ?? null, task_no: task?.task_no ?? null, review: REVIEW_SEQUENCE_KINDS.has(row.kind), reason: error },
          { store: this.#store, clock: this.#clock },
        );
        this.#store.enqueueOutbox(row.chat_id, drafts, null, this.#clock.now().toISOString());
      }
    });
    this.#log.error({ event: 'outbox_failed', ...fields }, 'outbox_failed');
  }
}
