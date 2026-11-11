import { fit, textMessage, type Card } from './card.ts';

export const DELIVERY_FAILED = 'delivery_failed';

export interface DeliveryFailedInput {
  /** The Task of the failed row, when it has one with a number. */
  task_id?: string | null;
  task_no?: number | null;
  /** Whether the failed row belongs to a Review sequence. */
  review: boolean;
  reason: string;
}

/**
 * The loud notice for a row the sender gave up on (AD-10; copy per Owner decision 2026-11-11):
 * `❌ #12 Review couldn't be delivered: …`, `❌ #12 message couldn't be delivered: …`, or
 * `❌ Message couldn't be delivered: …` without a Task.
 */
export const deliveryFailedCard: Card<DeliveryFailedInput> = {
  kind: DELIVERY_FAILED,
  render(input) {
    const prefix =
      input.task_no === undefined || input.task_no === null
        ? `❌ Message couldn't be delivered: `
        : `❌ #${input.task_no} ${input.review ? 'Review' : 'message'} couldn't be delivered: `;
    const html = fit((reason) => `${prefix}${reason}`, input.reason);
    return [textMessage(DELIVERY_FAILED, html, { task_id: input.task_id ?? null })];
  },
};
