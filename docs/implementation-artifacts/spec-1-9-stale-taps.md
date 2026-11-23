---
title: 'Card buttons act only while they can, and a stale tap says where the Task is'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/sprint-change-proposal-2026-11-23.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:**
- The Stuck card closes only on `budget_raised` and `cancel`. After `pause` or `amended`, it keeps buttons that cannot act.
- Its commands are bound to the state `stuck` only, so after `resume` the old card's buttons act again.
- Every stale tap answers `This Review was replaced by a newer one.`, which is Review wording, also on Stuck and Draft cards.

**Approach:** Apply the approved Sprint Change Proposal of 2026-11-23.
- Every exit from `stuck` closes the Stuck card with a state line. Pause closes it with `⏸ Paused by you`; amend closes it with `⏳ Amended · resuming`. `resume` sends a new card.
- Stuck card commands act only on the Task's newest Stuck card.
- On Stuck and Draft cards, a tap that cannot act answers `#${id} is ${state} now.` (`This draft is ${state} now.` before approval), and the tapped card is redrawn. This covers both stale rows and Coordinator refusals.
- Review cards keep the "replaced" toast and the reply to the current card.
- The two matching `deferred-work.md` entries are marked resolved.

</frozen-after-approval>

## Implementation Notes

- **Closing the card (`transitions.ts` `enter`).** The close is emitted on every exit from `stuck`, keyed by cause: `budget_raised`→`raised`, `cancel`→`cancelled`, `pause`→`paused`, `amended`→`amended`. The same applies when leaving `paused` with `resume_state = stuck` by `cancel` or `amended`, because the card then still reads `⏸ Paused by you`. `stuck-card.ts` `stateLine` gains the two lines.
- **Newest card only.** `CallbackCommand` gains `newestCardOnly`. The poller's `#valid` rejects a tap whose message is not `latestCardOfTask(task)`. Stuck commands set it.
- **Stale answer.** `CallbackCommand` gains an optional `stale: { redraw(task) }`.
  - Without it, the poller keeps the Review behaviour.
  - With it, the toast is the Task's state: `state` with `_` shown as spaces. If the tapped message is the Task's newest card, `redraw` re-renders it through `Coordinator.refreshCard` at the current state. An older card has its keyboard stripped by an `editMessageReplyMarkup` aimed at that message.
  - A handler returns `{ stale: true }` when the Coordinator refuses. The poller then answers the same way, after re-reading the Task.
- **Redraw payloads.**
  - Stuck: `{mode:'restore'}` while stuck. Otherwise the closed line of the visit's exit, from the new `stuckExit` in `domain/loop.ts`: the newest applied event out of `stuck` or out of a paused stuck visit.
  - Draft: `{}`, or `{closed:'discarded'}` when the Task was cancelled from `discard_pending`.
- **Draft card guard.** `renderDraftCard` renders nothing when the Task's latest card is not a Draft card, so a redraw never overwrites a later card.
- **Redraw fallback (review).** `redraw` resolves whether it redrew. When a card cannot show the Task's state, the poller removes its buttons instead. That covers a Stuck card with no exit found and a Draft card cancelled other than by Discard. So a redraw never brings buttons back to a Task that left their state.

## Review Triage Log

Pass 1 (blind-hunter).

- medium, patched: `stuckRedrawPayload` fell back to `{mode:'restore'}` for a Task that is not stuck, which would bring the buttons back. It now redraws nothing, and the poller removes the buttons. Tested.
- low, patched: a Draft card of a Task cancelled other than by Discard was redrawn with the draft header and questions. It now only loses its buttons.
- low, rejected: a redrawn Draft card of an implementing Task reads `⏳ Queued · starts next`. That is the Draft card's normal end state after approval; it is never updated later either.
- low, rejected: a refused tap while still stuck resets a confirm keyboard to the default buttons. A still-stuck refusal happens only for `Raise budget +2` on a pre-2026-11-22 dependency card, which has no confirm.
- medium, deferred: `stateToast` prints raw state names (`This draft is draft now.`). The copy needs an Owner/UX decision.
- low, deferred: an older card only loses its buttons; its text is not redrawn. It needs a failed close edit.
- low, rejected: between `resume` and the new card's send, the old card is still the newest. A tap then acts on the current stuck visit, which is what the new card would do.
- low, rejected: `STUCK_CLOSES` typed as `Record<string, string>`. It is cosmetic; one map feeds both sides through `closed`.
- low, patched: tests for a redraw that cannot draw, for the stuck fallback, and for two pauses in one visit. Rejected the rest: the draft guard, a throwing redraw, a deleted Task and repeated older-card taps are one-line paths, or `message is not modified` covers them.
- false: "`stuckExit` is fragile with nested pauses". Both nested sequences return the right exit; now tested.
- false: "close on `amended` marked resolved too early". `enter()` now closes on `amended` whatever applies it; 1-14 only adds the Intake route.
- false: "spec status and sprint-status not updated". The status is set at finalize, and 1-9 is already `review`.
