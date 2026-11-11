import { USAGE_WINDOW_WAIT } from '../../../core/coordinator/scheduler.ts';
import { localTime, textMessage, type Card } from './card.ts';

export interface UsageWindowWaitInput {
  task_id: string;
  task_no: number;
  resets_at: string;
  reply_to?: number | undefined;
}

/** `⏸ #12 waiting for usage window · resumes ~14:20`, silent, once per pause (EXPERIENCE.md). */
export const usageWindowWaitCard: Card<UsageWindowWaitInput> = {
  kind: USAGE_WINDOW_WAIT,
  render(input, env) {
    const html = `⏸ #${input.task_no} waiting for usage window · resumes ~${localTime(input.resets_at, env.timeZone)}`;
    return [textMessage(USAGE_WINDOW_WAIT, html, { task_id: input.task_id, reply_to: input.reply_to })];
  },
};
