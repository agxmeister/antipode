import { ulid } from '../../../core/domain/ids.ts';
import { CALLBACK_PREFIX, type OutboxDraft } from '../../../core/domain/telegram.ts';
import type { Clock } from '../../../core/ports/clock.ts';
import type { Store } from '../../../core/ports/store.ts';

/** Telegram's limits on visible text: a message, and a media caption (spine Messages convention). */
export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
export const ELLIPSIS = '…';

/** What a template may read and write while rendering: callbacks rows, the clock, the local time zone. */
export interface CardEnv {
  store: Store;
  clock: Clock;
  /** IANA zone for `~HH:MM`; the host's local zone when undefined (AD-16: local time in messages). */
  timeZone?: string | undefined;
}

/**
 * One template module per card kind (spine Messages convention): `render` turns typed input into the
 * outbox rows that show it. Templates escape every free-text field, clip it so the visible text fits,
 * and never set `parse_mode` or `disable_notification` (the sender does, from the row's kind).
 */
export interface Card<Input> {
  kind: string;
  render(input: Input, env: CardEnv): OutboxDraft[];
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escapes text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ENTITIES[char] ?? char);
}

const DECODED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

/** The length Telegram counts for an HTML text: tags removed, entities decoded, UTF-16 units. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi, (_match, name: string) => DECODED[name.toLowerCase()] ?? 'x').length;
}

/**
 * Clips `text` to at most `max` UTF-16 units, ending with `…` when it was cut; never splits a
 * surrogate pair. A budget below one unit leaves just `…`.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let cut = Math.max(0, max - ELLIPSIS.length);
  const last = text.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return text.slice(0, cut) + ELLIPSIS;
}

/**
 * Renders `template` around one free-text field, clipped so the whole visible text is at most
 * `limit`. `template` receives the field already escaped.
 */
export function fit(template: (field: string) => string, field: string, limit: number = TEXT_LIMIT): string {
  const fixed = visibleLength(template(''));
  return template(escapeHtml(clip(field, limit - fixed)));
}

/** `HH:MM` in local time (24-hour), for `~HH:MM` estimates. */
export function localTime(iso: string, timeZone?: string): string {
  const format = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone === undefined ? {} : { timeZone }) });
  return format.format(new Date(iso));
}

/** One inline button bound to a `callbacks` row. */
export interface ButtonSpec {
  text: string;
  command: string;
  task_id?: string | null;
  round?: number | null;
  args?: Record<string, unknown>;
  expires_at?: string | null;
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/**
 * Builds an inline keyboard, inserting one `callbacks` row per button; `callback_data` is
 * `cb:<ulid>`, 29 bytes, inside Telegram's 64 (AD-10).
 */
export function keyboard(env: CardEnv, rows: readonly (readonly ButtonSpec[])[]): InlineKeyboard {
  const created_at = env.clock.now().toISOString();
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => {
        const id = ulid();
        env.store.insertCallback({
          id,
          command: button.command,
          task_id: button.task_id ?? null,
          round: button.round ?? null,
          args: button.args ?? {},
          expires_at: button.expires_at ?? null,
          created_at,
        });
        return { text: button.text, callback_data: `${CALLBACK_PREFIX}${id}` };
      }),
    ),
  };
}

/** The empty keyboard an edit uses to strip a card's buttons. */
export const NO_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };

/** `reply_parameters` for a reply that still goes out if the target was deleted. */
export function replyTo(messageId: number): { message_id: number; allow_sending_without_reply: true } {
  return { message_id: messageId, allow_sending_without_reply: true };
}

export interface TextMessageOptions {
  task_id?: string | null;
  round?: number | null;
  /** Message to reply to, in the same chat. */
  reply_to?: number | undefined;
  reply_markup?: InlineKeyboard;
}

/** A `sendMessage` draft of `kind` with already-rendered HTML. */
export function textMessage(kind: string, html: string, options: TextMessageOptions = {}): OutboxDraft {
  const params: Record<string, unknown> = { text: html };
  if (options.reply_to !== undefined) params['reply_parameters'] = replyTo(options.reply_to);
  if (options.reply_markup !== undefined) params['reply_markup'] = options.reply_markup;
  return { kind, task_id: options.task_id ?? null, round: options.round ?? null, payload: { method: 'sendMessage', params } };
}
