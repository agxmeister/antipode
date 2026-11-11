import { USAGE_WINDOW_RESUMED } from '../../../core/coordinator/scheduler.ts';
import { textMessage, type Card } from './card.ts';

export interface UsageWindowResumedInput {
  task_id: string;
  task_no: number;
  reply_to?: number | undefined;
}

/** `#12 resumed`, silent, after a usage-window wait (Owner decision 2026-11-11). */
export const usageWindowResumedCard: Card<UsageWindowResumedInput> = {
  kind: USAGE_WINDOW_RESUMED,
  render(input) {
    return [textMessage(USAGE_WINDOW_RESUMED, `#${input.task_no} resumed`, { task_id: input.task_id, reply_to: input.reply_to })];
  },
};
