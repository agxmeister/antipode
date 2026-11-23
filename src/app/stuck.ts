import { CANCEL_TASK, CONFIRM_CANCEL, KEEP, RAISE_AMOUNT, RAISE_BUDGET, STUCK_CARD } from '../adapters/telegram/cards/stuck-card.ts';
import type { CallbackCommand } from '../adapters/telegram/poller.ts';
import type { Coordinator } from '../core/coordinator/coordinator.ts';
import { STUCK_CLOSES } from '../core/coordinator/transitions.ts';
import type { StageEventRow } from '../core/domain/events.ts';
import { stuckExit } from '../core/domain/loop.ts';
import type { Task } from '../core/domain/task.ts';
import type { Store } from '../core/ports/store.ts';

/** Toasts of the Stuck card buttons, in the Draft card's style (spec 1-9 Design Notes). */
export const STUCK_TOAST = {
  raised: (amount: number) => `Budget +${amount}. Resuming.`,
  cancelled: 'Cancelled.',
} as const;

/**
 * The card's redraw on a tap that cannot act (EXPERIENCE.md → Stale button): its buttons while the Task is
 * stuck, otherwise the state line of the event that ended the visit. Undefined when no exit is found: the
 * card then only loses its buttons, never gets them back.
 */
export function stuckRedrawPayload(task: Task, events: readonly StageEventRow[]): Record<string, unknown> | undefined {
  if (task.state === 'stuck') return { mode: 'restore' };
  const exit = stuckExit(events);
  const closed = exit === undefined ? undefined : STUCK_CLOSES[exit.event_type];
  if (closed === undefined) return undefined;
  if (closed !== 'raised') return { closed };
  const amount = (JSON.parse(exit!.payload) as { amount?: unknown }).amount;
  return { closed, ...(typeof amount === 'number' ? { amount } : {}) };
}

/**
 * The Stuck card's buttons (AD-9, AD-10): Coordinator commands bound to `stuck` and to the Task's newest
 * card, so a tap on an older card or on a Task no longer stuck gets the stale answer. `Cancel Task` and
 * `Keep` only swap the keyboard; `Raise budget +2` and `Confirm cancel` apply `budget_raised` and `cancel`,
 * whose transitions close the card.
 */
export function stuckCallbacks(
  coordinator: Pick<Coordinator, 'raiseBudget' | 'cancelTask' | 'refreshCard'>,
  store: Pick<Store, 'stageEventsOfTask'>,
): Array<[string, CallbackCommand]> {
  const base = {
    states: ['stuck'] as const,
    newestCardOnly: true,
    stale: {
      redraw: async (task: Task) => {
        const payload = stuckRedrawPayload(task, store.stageEventsOfTask(task.id));
        return payload !== undefined && (await coordinator.refreshCard(task.id, STUCK_CARD, task.state, payload));
      },
    },
  };
  const stale = { stale: true };
  return [
    [
      RAISE_BUDGET,
      {
        ...base,
        handle: async ({ callback, task }) => {
          const amount = Number(callback.args['amount'] ?? RAISE_AMOUNT);
          return (await coordinator.raiseBudget(task!.id, amount)).applied ? { toast: STUCK_TOAST.raised(amount) } : stale;
        },
      },
    ],
    [
      CANCEL_TASK,
      {
        ...base,
        handle: async ({ task }) => ((await coordinator.refreshCard(task!.id, STUCK_CARD, 'stuck', { mode: 'confirm' })) ? {} : stale),
      },
    ],
    [
      CONFIRM_CANCEL,
      {
        ...base,
        handle: async ({ task }) => ((await coordinator.cancelTask(task!.id)).applied ? { toast: STUCK_TOAST.cancelled } : stale),
      },
    ],
    [
      KEEP,
      {
        ...base,
        handle: async ({ task }) => ((await coordinator.refreshCard(task!.id, STUCK_CARD, 'stuck', { mode: 'restore' })) ? {} : stale),
      },
    ],
  ];
}
