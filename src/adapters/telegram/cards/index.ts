import { USAGE_WINDOW_RESUMED, USAGE_WINDOW_WAIT } from '../../../core/coordinator/scheduler.ts';
import type { EffectOf } from '../../../core/domain/effects.ts';
import type { Task } from '../../../core/domain/task.ts';
import type { OutboxDraft } from '../../../core/domain/telegram.ts';
import type { CardEnv } from './card.ts';
import { usageWindowResumedCard } from './usage-window-resumed.ts';
import { usageWindowWaitCard } from './usage-window-wait.ts';

/** What a `notify` effect renders from: the effect, its Task, and the Task's latest card to reply to. */
export interface NoticeInput {
  effect: EffectOf<'notify'>;
  task: Task | undefined;
  /** `message_id` of the Task's latest card in this chat; lifecycle notices reply to it (EXPERIENCE.md). */
  replyTo: number | undefined;
}

export type NoticeRenderer = (input: NoticeInput, env: CardEnv) => OutboxDraft[];

function numbered(input: NoticeInput): { task: Task; task_no: number } {
  const { task } = input;
  if (task === undefined || task.task_no === null) {
    throw new Error(`notice ${input.effect.notice_kind} needs a numbered Task`);
  }
  return { task, task_no: task.task_no };
}

/** `notice_kind` → template; later stories add their kinds through `TelegramMessenger.registerNotice`. */
export function defaultNotices(): Map<string, NoticeRenderer> {
  return new Map<string, NoticeRenderer>([
    [
      USAGE_WINDOW_WAIT,
      (input, env) => {
        const { task, task_no } = numbered(input);
        const resetsAt = input.effect.payload?.['resets_at'];
        if (typeof resetsAt !== 'string') {
          throw new Error(`notice ${USAGE_WINDOW_WAIT} has no payload.resets_at`);
        }
        return usageWindowWaitCard.render({ task_id: task.id, task_no, resets_at: resetsAt, reply_to: input.replyTo }, env);
      },
    ],
    [
      USAGE_WINDOW_RESUMED,
      (input, env) => {
        const { task, task_no } = numbered(input);
        return usageWindowResumedCard.render({ task_id: task.id, task_no, reply_to: input.replyTo }, env);
      },
    ],
  ]);
}
