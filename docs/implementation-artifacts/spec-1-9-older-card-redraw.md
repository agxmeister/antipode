---
title: 'A stale tap on an older card redraws its text, not only its buttons'
type: 'bugfix'
created: '2026-11-26'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/implementation-artifacts/spec-1-9-stale-taps.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A stale tap on a card that is not the Task's newest only removes its buttons (`Poller.#staleAnswer`). If that card's own close edit failed, for example an older Stuck card, it keeps the reason and the footer `Or reply to amend or drop a criterion.`. EXPERIENCE.md → Stale button says the tapped card is edited to its current state, and DESIGN.md `stuck-card` item 6 says a closed card shows its state line (deferred from the stale-taps review).

**Approach:**
- On a stale tap on an older card, send the latest text intended for that message again with no keyboard. That text is the newest `sendMessage` or `editMessageText` aimed at it, such as the close edit with its state line.
- When no text render is found, keep today's keyboard-only retire.
- An older card never gets buttons back.
- The deferred-work entry is marked resolved.

</frozen-after-approval>

## Implementation Notes

- **Store.** A new `rendersOfMessage(chatId, messageId)` returns, in `sequence` order:
  - the `send*` row whose `sent_message_id` is that message;
  - every row in that chat aimed at the message by `target_message_id`, or at that send row by `target_outbox_id`.
- **Poller.** For an older card, the poller takes the newest of those rows with a string `params.text`. If one is found, it queues `stale_tap_retire` as `editMessageText` with that text and `NO_KEYBOARD`. Otherwise it queues today's `editMessageReplyMarkup`. A render that ran out of retries still counts, because it was the intended state. A render Telegram refused with a 400 is skipped, since the same text would be refused again (review). Media captions are not read: such a card only loses its buttons. The sender already treats `message is not modified` as success.
- **Tests.** `poller.test.ts`: an older card whose close edit failed, and a refused render that falls back to the text before it. `store.test.ts`: `rendersOfMessage`. `loop.test.ts`: the pause and resume test now expects the old card redrawn with `⏸ Paused by you`.

## Review Triage Log

Pass 1 (blind-hunter).

- medium, patched: a close edit Telegram refused with a 400 (bad HTML, too long) was replayed and refused again. That queued a loud delivery notice on every tap and left the buttons in place. Such renders are now skipped. Tested.
- low, patched: the `#staleAnswer` doc comment did not describe the text redraw.
- low, patched: `rendersOfMessage` had no store test (chat isolation, sent edits never counted as sends).
- done at finalize: the deferred-work entry is marked resolved and the spec status is set.
- low, rejected: no index serves `rendersOfMessage`. It runs once per stale tap, which is human-paced, and fixing it needs a migration.
- false: "an older card with no close edit is resent unchanged". Every exit from `stuck` queues a close edit aimed at the newest card. A card whose send failed was never delivered and cannot be tapped.
- low, rejected: media cards keep their caption. No media card has buttons today; the doc comment now states the choice.
- low, rejected: store checks inside a poller test. Cosmetic; the store now has its own test.
- low, rejected: a tap while the close edit is still pending queues an identical edit. The sender treats `message is not modified` as success.
- false: "a newest card whose redraw fails never tries the text redraw". A newest card's text is its live state, so falling back to removing the buttons is the stale-taps design.
- low, rejected: `.agents/` is untracked. It predates this change and is not committed with it.
