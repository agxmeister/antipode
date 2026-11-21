import { CANCEL_TASK, CONFIRM_CANCEL, KEEP, RAISE_AMOUNT, RAISE_BUDGET, STUCK_CARD } from '../adapters/telegram/cards/stuck-card.ts';
import { STALE_TAP_TOAST, type CallbackCommand } from '../adapters/telegram/poller.ts';
import type { Coordinator } from '../core/coordinator/coordinator.ts';

/** Toasts of the Stuck card buttons, in the Draft card's style (spec 1-9 Design Notes). */
export const STUCK_TOAST = {
  raised: (amount: number) => `Budget +${amount}. Resuming.`,
  cancelled: 'Cancelled.',
} as const;

/**
 * The Stuck card's buttons (AD-9, AD-10): Coordinator commands bound to `stuck`, so a tap on a card
 * that is no longer stuck gets the stale toast. `Cancel Task` and `Keep` only swap the keyboard;
 * `Raise budget +2` and `Confirm cancel` apply `budget_raised` and `cancel`, whose transitions close the card.
 */
export function stuckCallbacks(coordinator: Pick<Coordinator, 'raiseBudget' | 'cancelTask' | 'refreshCard'>): Array<[string, CallbackCommand]> {
  const stuck = ['stuck'] as const;
  const stale = { toast: STALE_TAP_TOAST };
  return [
    [
      RAISE_BUDGET,
      {
        states: stuck,
        handle: async ({ callback, task }) => {
          const amount = Number(callback.args['amount'] ?? RAISE_AMOUNT);
          return (await coordinator.raiseBudget(task!.id, amount)).applied ? { toast: STUCK_TOAST.raised(amount) } : stale;
        },
      },
    ],
    [
      CANCEL_TASK,
      {
        states: stuck,
        handle: async ({ task }) => ((await coordinator.refreshCard(task!.id, STUCK_CARD, 'stuck', { mode: 'confirm' })) ? {} : stale),
      },
    ],
    [
      CONFIRM_CANCEL,
      {
        states: stuck,
        handle: async ({ task }) => ((await coordinator.cancelTask(task!.id)).applied ? { toast: STUCK_TOAST.cancelled } : stale),
      },
    ],
    [
      KEEP,
      {
        states: stuck,
        handle: async ({ task }) => ((await coordinator.refreshCard(task!.id, STUCK_CARD, 'stuck', { mode: 'restore' })) ? {} : stale),
      },
    ],
  ];
}
