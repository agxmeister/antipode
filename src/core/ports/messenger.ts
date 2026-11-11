import type { EffectOf, EffectRow } from '../domain/effects.ts';

/**
 * The Owner surface (AD-10), implemented by `adapters/telegram`. The composition root registers
 * these as effect handlers; each renders through a `cards/` template into the outbox and resolves
 * once the rows are persisted, not when they are delivered.
 */
export interface Messenger {
  /** A `notify` effect: renders its `notice_kind` into the Project's chat. */
  notify(effect: EffectOf<'notify'>, row: EffectRow): Promise<void>;
  /** A `back_online` effect: one silent notice in the Project's chat (AD-18). */
  backOnline(effect: EffectOf<'back_online'>, row: EffectRow): Promise<void>;
  /** A `retire_card` effect: strips the keyboard of the Task's card of that round (AD-10). */
  retireCard(effect: EffectOf<'retire_card'>, row: EffectRow): Promise<void>;
  /** Replaces the `👀` on an Owner message with `❌` and replies `text` (AD-10, Intake failures). */
  failAck(chatId: number, messageId: number, text: string): Promise<void>;
}
