import { z } from 'zod';

/** Bot API methods an `outbox` row may call (AD-10). Acknowledgements never go through the outbox. */
export const OUTBOX_METHODS = ['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'sendPhoto', 'sendVideo', 'sendDocument'] as const;
export const outboxMethodSchema = z.enum(OUTBOX_METHODS);
export type OutboxMethod = z.infer<typeof outboxMethodSchema>;

/** Methods that edit an existing message: their `message_id` comes from the row's target. */
export const EDIT_METHODS: readonly OutboxMethod[] = ['editMessageText', 'editMessageReplyMarkup'];

export function isEditMethod(method: OutboxMethod): boolean {
  return EDIT_METHODS.includes(method);
}

/** A local file to upload, in place of a Bot API `InputFile` (rows are JSON). */
export const outboxFileSchema = z.strictObject({ file_path: z.string().min(1) });
export type OutboxFile = z.infer<typeof outboxFileSchema>;

/**
 * What the sender calls: `method` with `params`, minus `chat_id`, `message_id`, `parse_mode` and
 * `disable_notification`, which the sender sets from the row. A file parameter is `{file_path}`.
 */
export const outboxPayloadSchema = z.strictObject({
  method: outboxMethodSchema,
  params: z.record(z.string(), z.unknown()),
});
export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

export const outboxStatusSchema = z.enum(['pending', 'sent', 'failed']);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

const isoTimestamp = z.iso.datetime();
const chatId = z.int();
const messageId = z.int().positive();

/** One row of `outbox`: one send or edit, drained per chat in `sequence` order (AD-10). */
export const outboxRowSchema = z.object({
  id: z.string().min(1),
  chat_id: chatId,
  sequence: z.int().positive(),
  kind: z.string().min(1),
  payload: outboxPayloadSchema,
  task_id: z.string().min(1).nullable(),
  round: z.int().nonnegative().nullable(),
  /** The message an edit applies to, when it is already known. */
  target_message_id: messageId.nullable(),
  /** The row whose sent message an edit applies to, when that row may not be sent yet. */
  target_outbox_id: z.string().min(1).nullable(),
  sent_message_id: messageId.nullable(),
  attempts: z.int().nonnegative(),
  next_attempt_at: isoTimestamp.nullable(),
  status: outboxStatusSchema,
  error: z.string().nullable(),
  effect_id: z.string().min(1).nullable(),
  created_at: isoTimestamp,
  sent_at: isoTimestamp.nullable(),
});
export type OutboxRow = z.infer<typeof outboxRowSchema>;

/** A row to enqueue; the store assigns `sequence` and the bookkeeping columns. */
export interface OutboxDraft {
  /** Pre-minted so a later draft of the same group can name it as `target_outbox_id`. */
  id?: string;
  kind: string;
  payload: OutboxPayload;
  task_id?: string | null;
  round?: number | null;
  target_message_id?: number | null;
  target_outbox_id?: string | null;
}

/** One row of `callbacks`: what `cb:<id>` on a button means. Validity is checked in code (AD-10). */
export const callbackRowSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  task_id: z.string().min(1).nullable(),
  round: z.int().nonnegative().nullable(),
  args: z.record(z.string(), z.unknown()),
  /** Used only by undo commands (AD-10). */
  expires_at: isoTimestamp.nullable(),
  created_at: isoTimestamp,
});
export type CallbackRow = z.infer<typeof callbackRowSchema>;

export const CALLBACK_PREFIX = 'cb:';

/** One row of `telegram_messages`: a sent message and what it shows, for replies and edits (AD-10). */
export const telegramMessageRowSchema = z.object({
  chat_id: chatId,
  message_id: messageId,
  task_id: z.string().min(1).nullable(),
  round: z.int().nonnegative().nullable(),
  kind: z.string().min(1),
});
export type TelegramMessageRow = z.infer<typeof telegramMessageRowSchema>;

/** A message kind is a card (with buttons, edited in place) when it ends in `_card`. */
export function isCardKind(kind: string): boolean {
  return kind.endsWith('_card');
}

/**
 * Outbox kinds that make a sound; every other kind is sent with `disable_notification` (AD-10).
 * `delivery_failed` is loud by Owner decision (2026-11-11), pending a correct-course of AD-10's list.
 */
export const LOUD_KINDS: ReadonlySet<string> = new Set([
  'review_card',
  'stuck_card',
  'release_failed',
  'onboarding_blocked',
  'registration_failed',
  'delivery_failed',
]);

/** Kinds of a Review sequence: Evidence messages, the Demo and the Review card (EXPERIENCE.md). */
export const REVIEW_SEQUENCE_KINDS: ReadonlySet<string> = new Set(['evidence', 'demo', 'review_card']);

/** The `settings` key holding the last processed Telegram `update_id` (AD-10). */
export const LAST_UPDATE_ID_SETTING = 'telegram.last_update_id';
