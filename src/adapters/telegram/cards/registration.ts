import { fit, textMessage, type Card } from './card.ts';

export const REGISTRATION_REPLY = 'registration_reply';
export const REGISTRATION_FAILED = 'registration_failed';

export interface RegistrationReplyInput {
  /** The Project's display name (`Training`). */
  name: string;
  /** The `/register` message this answers. */
  reply_to?: number | undefined;
}

export interface RegistrationFailedInput {
  reason: string;
  reply_to?: number | undefined;
}

/**
 * The Registration reply on success: `Training registered`, silent (Owner decision 2026-11-12; story
 * 1-13 adds the bootstrap Task and the ` · bootstrap running` suffix).
 */
export const registrationReplyCard: Card<RegistrationReplyInput> = {
  kind: REGISTRATION_REPLY,
  render(input) {
    return [textMessage(REGISTRATION_REPLY, fit((name) => `${name} registered`, input.name), { reply_to: input.reply_to })];
  },
};

/** The loud Registration failure (EXPERIENCE.md State Patterns): `❌ Can't register: ${reason}`. The group stays unbound. */
export const registrationFailedCard: Card<RegistrationFailedInput> = {
  kind: REGISTRATION_FAILED,
  render(input) {
    return [textMessage(REGISTRATION_FAILED, fit((reason) => `❌ Can't register: ${reason}`, input.reason), { reply_to: input.reply_to })];
  },
};
