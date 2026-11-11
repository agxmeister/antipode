---
title: 'Telegram adapter'
type: 'feature'
created: '2026-11-10'
status: 'in-progress'
baseline_commit: '97d7ac7367feb99b4c37d385faeb1c8babd69200'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/EXPERIENCE.md'
  - '{project-root}/docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Antipode has no Owner surface: `notify` and `back_online` effects are only logged, nothing reads Telegram, and there is nowhere to store outbound messages, callbacks or the last `update_id` (AD-10).

**Approach:** Add `adapters/telegram` (grammY `Api` only, with our own long-polling loop) behind a `Messenger` port. It persists `update_id`, honours only the Owner, acks every Owner action within 5 s, and sends every message and edit through a per-chat `outbox` with retries. It binds buttons to `callbacks` rows that are checked against Task state and `review_round`, renders the existing notices through `cards/` templates, adds the `retire_card` effect, and registers the command menu at boot. Later stories plug command, callback and free-text handlers into it.

## Boundaries & Constraints

**Always:**
- All Telegram calls go through one grammY `Api` instance, so tests swap in a transformer (AD-24). HTML parse mode on every text and caption.
- Every `sendX`/`editX` is an `outbox` row written by the Store port. Only acknowledgements (`setMessageReaction`, `answerCallbackQuery`) and `getUpdates`/`setMyCommands` call the API directly, because a queued ack could miss 5 s behind a Review sequence.
- `disable_notification: true` on every kind except `review_card`, `stuck_card`, `release_failed`, `onboarding_blocked`, `registration_failed`, `delivery_failed`.
- Templates clip free-text fields so the visible text is ≤ 4096 (caption ≤ 1024) and ends with `…`. The sender never truncates.
- The adapter reaches rows only through `core/ports/store.ts`, never by importing `adapters/sqlite` (AD-1).

**Never:**
- No `/register` (1-5), Intake (1-8), Review/Draft/Stuck cards or button commands (1-11, 1-14), or read-only commands (1-15). This story provides the registries those stories fill.
- No webhook, no grammY `bot.start()` (its offset is not persisted), no real bot token in tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner message | Owner text in a bound chat | `👀` reaction first, then the registered text/command handler; `telegram.last_update_id` saved after the handler | Reaction failure: warn, continue |
| Replayed update | `update_id` ≤ saved | Ignored, no API call | — |
| Non-Owner | Any update from another user id | Ignored silently, offset advances | — |
| Unbound chat | Owner message in a chat no Project is bound to | Only `/register` dispatches; anything else is ignored | — |
| Valid tap | `cb:<ulid>`, Task in an expected state, `round = review_round`, not expired | Handler runs; its toast is answered | Handler > 4 s: answer with no text, send the toast text as a reply |
| Stale tap | Unknown row, wrong state, wrong round or expired | Toast `This Review was replaced by a newer one.` plus a reply to the Task's latest card | No card: toast only |
| Offline tap | `answerCallbackQuery` refused as too old | The toast text goes out as a reply to the tapped message | — |
| Stale message | `message.date` older than `telegram.stale_after_ms` | The handler gets `stale: true` (1-15 drops stale `/peek`) | — |
| Send retry | 5xx, network error, or 429 (honour `retry_after`) | Retried with backoff 1 s·2ⁿ up to 60 s; the chat waits | After `outbox.retries`: row `failed`, skipped, delivery-failure notice queued |
| Permanent error | 4xx other than 429 | Row `failed` at once, notice queued | `message is not modified` counts as sent |
| Notice fails | A delivery-failure row itself fails | Marked `failed`, logged, no further notice | — |
| Edit before send | Edit whose target outbox row is still pending | Sent after its target, with the target's `sent_message_id` | Target `failed`: the edit fails too |
| No chat | `notify` for a Project without a chat | Effect `done`, warn `notice_unroutable` | — |

**Owner decisions (2026-11-11):**
- The delivery-failure notice (`delivery_failed`) is loud for now, though AD-10's `disable_notification` exception list leaves it out. The list fix is logged in `deferred-work.md` for `bmad-correct-course`.
- Delivery-failure copy: `❌ #${task_no} Review couldn't be delivered: ${reason}` for rows of a Review sequence, `❌ #${task_no} message couldn't be delivered: ${reason}` for other Task rows, `❌ Message couldn't be delivered: ${reason}` without a Task.
- `usage_window_resumed` copy: `#${task_no} resumed`, no glyph. `usage_window_wait`: `⏸ #${task_no} waiting for usage window · resumes ~HH:MM`. `back_online`: `Back online · ${n} Tasks resumed.`
- `setMyCommands`, in menu order: register `Bind this group to a repo`, status `Tasks in this Project`, peek `Latest progress of a Task`, parked `Parking Lot findings`, cost `Usage and cost`, pause `Pause new work`, resume `Resume work`, cancel `Cancel a Task`, evidence `Resend a Task's Evidence`, log `Stage history of a Task`.
- No `TELEGRAM_BOT_TOKEN` in `secrets/antipod.env`: the daemon runs without Telegram, logs a `telegram_disabled` warning, and keeps the log-only `notify`/`back_online` handlers.
- Stale-tap reply to the Task's latest card repeats `This Review was replaced by a newer one.`

</frozen-after-approval>

## Code Map

- `src/core/domain/effects.ts` -- add `retire_card {task_id, round}`; `notify` already carries `notice_kind`, `task_id?`, `project_id?`, `payload?`
- `src/core/coordinator/transitions.ts:126` -- `enter('in_review')` bumps the round only on `evidence_verified`; push `retire_card` for the previous round there when `review_round > 0`. Nothing else changes; extend `test/core/coordinator/transitions.test.ts` expectations
- `src/core/coordinator/scheduler.ts:42` -- `USAGE_WINDOW_WAIT`/`RESUMED` notice kinds, payload `{resets_at, key}`; reuse the constants in the card registry
- `src/core/domain/task.ts:59`, `src/adapters/sqlite/store.ts:99` -- `Project` gains `telegram_chat_id: number | null`; insert/map it
- `src/core/ports/store.ts` -- add settings get/set, `bindProjectChat`, `projectByChat`, outbox (enqueue group with per-chat `sequence` in one transaction, next due per chat, mark sent/attempt/failed), callbacks (insert, get), `telegram_messages` (insert, latest card of a Task)
- `src/adapters/sqlite/migrations/index.ts` -- append `migration0004`; never edit 0001–0003
- `src/app/daemon.ts:104-112` -- replace the log-only `back_online`/`notify` handlers; start polling and the sender after `recover()`; stop them in `stop()` before `executor.settle()`
- `src/app/home.ts` -- `secrets` path exists; read `secrets/antipod.env` (`KEY=VALUE` lines) in app
- `src/app/config.ts` -- `owner.telegram_user_id`, `outbox.retries`, `telegram.stale_after_ms` already exist; no change
- `test/helpers/home.ts` -- `createTempHome`, `OWNER_ID`; reuse

## Tasks & Acceptance

**Execution:**
- [ ] `package.json` -- add `grammy@~1.46` -- AD-10 stack
- [ ] `src/adapters/sqlite/migrations/0004-telegram.ts` -- `projects.telegram_chat_id INTEGER UNIQUE`; STRICT `outbox` (`id, chat_id, sequence, kind, payload, task_id, round, target_message_id, target_outbox_id, sent_message_id, attempts, next_attempt_at, status pending|sent|failed, error, effect_id, created_at, sent_at`, `UNIQUE(chat_id, sequence)`, `UNIQUE(effect_id, kind, sequence)`), `callbacks` (`id, command, task_id, round, args, expires_at, created_at`), `telegram_messages` (`chat_id, message_id, task_id, round, kind`, PK chat+message) -- AD-10 rows
- [ ] `src/core/domain/telegram.ts` -- zod row schemas, `OutboxPayload` (`method` of sendMessage|editMessageText|editMessageReplyMarkup|sendPhoto|sendVideo|sendDocument, `params`, files as `{file_path}`) -- typed rows
- [ ] `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts` -- methods in the Code Map; enqueue is idempotent by `effect_id` -- persistence
- [ ] `src/core/ports/messenger.ts` -- `Messenger { notify(effect, row), backOnline(effect, row), retireCard(effect, row), failAck(chatId, messageId, text) }` -- port the app wires to effects
- [ ] `src/adapters/telegram/cards/` -- `card.ts` (Card contract, `escapeHtml`, `clip`, keyboard builder that inserts `callbacks` rows), one module per kind: `usage-window-wait`, `usage-window-resumed`, `back-online`, `delivery-failed`; local `~HH:MM` times -- templates
- [ ] `src/adapters/telegram/sender.ts` -- per-chat in-sequence drain, retry and backoff, `telegram_messages` on success, delivery-failure notice -- outbox
- [ ] `src/adapters/telegram/poller.ts` -- `getUpdates` loop (`timeout` 30, abortable, backoff on error), Owner filter, `👀`, dispatch to `commands`/`callbacks`/`text` registries, callback validation, stale handling -- inbound
- [ ] `src/adapters/telegram/messenger.ts` -- `TelegramMessenger` implementing the port; `setMyCommands` on `start()` -- composition of the adapter
- [ ] `src/app/daemon.ts`, `src/app/secrets.ts` -- read the token, build the `Api` (`BootOptions.telegramApi` for tests), wire handlers and lifecycle -- composition root
- [ ] `test/helpers/telegram.ts` -- transformer fake that records calls and scripts `getUpdates` and errors -- AD-24 fake
- [ ] `test/adapters/telegram/{sender,poller,cards}.test.ts`, `test/adapters/sqlite/store.test.ts`, `test/app/daemon.test.ts` -- one test per matrix row, clipping at 4096/1024, `setMyCommands` at boot, outbox replay after restart -- proof

**Acceptance Criteria:**
- Given a daemon booted with a fake `Api`, when it starts, then `setMyCommands` is called once with the ten commands in menu order.
- Given two Tasks' notices enqueued in one chat, when the sender drains, then messages go out in `sequence` order and the second group starts only after the first group's last row is sent.
- Given a pending outbox row and a daemon restart, when the new daemon boots, then the row is sent exactly once and marked `sent`.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Delivery is at-least-once: a crash between a successful send and `markSent` resends that row on the next boot. That is acceptable because Telegram offers no idempotency key. A Review sequence never interleaves because a card group is enqueued in one transaction with consecutive `sequence` numbers, and each chat drains strictly in order. A row blocks only its own chat, and only until its retries run out. Callback validity is code, not data: each registered command declares the Task states it expects, and the row stores only `command, task_id, round, args, expires_at`.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0

**Manual checks (if no CLI):**
- Against a second bot with a scratch `ANTIPOD_HOME`: the `/` menu shows the ten commands; an Owner message gets `👀`; a message from another account gets nothing.
