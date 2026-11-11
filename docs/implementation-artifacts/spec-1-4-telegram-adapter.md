---
title: 'Telegram adapter'
type: 'feature'
created: '2026-11-10'
status: 'done'
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
- [x] `package.json` -- add `grammy@~1.46` -- AD-10 stack
- [x] `src/adapters/sqlite/migrations/0004-telegram.ts` -- `projects.telegram_chat_id INTEGER UNIQUE`; STRICT `outbox` (`id, chat_id, sequence, kind, payload, task_id, round, target_message_id, target_outbox_id, sent_message_id, attempts, next_attempt_at, status pending|sent|failed, error, effect_id, created_at, sent_at`, `UNIQUE(chat_id, sequence)`, `UNIQUE(effect_id, kind, sequence)`), `callbacks` (`id, command, task_id, round, args, expires_at, created_at`), `telegram_messages` (`chat_id, message_id, task_id, round, kind`, PK chat+message) -- AD-10 rows
- [x] `src/core/domain/telegram.ts` -- zod row schemas, `OutboxPayload` (`method` of sendMessage|editMessageText|editMessageReplyMarkup|sendPhoto|sendVideo|sendDocument, `params`, files as `{file_path}`) -- typed rows
- [x] `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts` -- methods in the Code Map; enqueue is idempotent by `effect_id` -- persistence
- [x] `src/core/ports/messenger.ts` -- `Messenger { notify(effect, row), backOnline(effect, row), retireCard(effect, row), failAck(chatId, messageId, text) }` -- port the app wires to effects
- [x] `src/adapters/telegram/cards/` -- `card.ts` (Card contract, `escapeHtml`, `clip`, keyboard builder that inserts `callbacks` rows), one module per kind: `usage-window-wait`, `usage-window-resumed`, `back-online`, `delivery-failed`; local `~HH:MM` times -- templates
- [x] `src/adapters/telegram/sender.ts` -- per-chat in-sequence drain, retry and backoff, `telegram_messages` on success, delivery-failure notice -- outbox
- [x] `src/adapters/telegram/poller.ts` -- `getUpdates` loop (`timeout` 30, abortable, backoff on error), Owner filter, `👀`, dispatch to `commands`/`callbacks`/`text` registries, callback validation, stale handling -- inbound
- [x] `src/adapters/telegram/messenger.ts` -- `TelegramMessenger` implementing the port; `setMyCommands` on `start()` -- composition of the adapter
- [x] `src/app/daemon.ts`, `src/app/secrets.ts` -- read the token, build the `Api` (`BootOptions.telegramApi` for tests), wire handlers and lifecycle -- composition root
- [x] `test/helpers/telegram.ts` -- transformer fake that records calls and scripts `getUpdates` and errors -- AD-24 fake
- [x] `test/adapters/telegram/{sender,poller,cards}.test.ts`, `test/adapters/sqlite/store.test.ts`, `test/app/daemon.test.ts` -- one test per matrix row, clipping at 4096/1024, `setMyCommands` at boot, outbox replay after restart -- proof

**Acceptance Criteria:**
- Given a daemon booted with a fake `Api`, when it starts, then `setMyCommands` is called once with the ten commands in menu order.
- Given two Tasks' notices enqueued in one chat, when the sender drains, then messages go out in `sequence` order and the second group starts only after the first group's last row is sent.
- Given a pending outbox row and a daemon restart, when the new daemon boots, then the row is sent exactly once and marked `sent`.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- `outbox.retries` counts retries after the first attempt, as Stage retries do: with the default 5, a row fails after 6 attempts.
- A pending row keeps its saved `next_attempt_at` across a restart, so it may wait up to 60 s before it is resent.
- An edit whose target row failed fails with `target_failed` and queues no notice of its own, since the target already queued one.
- A `notice_kind` without a template throws, so its effect is marked `failed`. Later stories add kinds with `TelegramMessenger.registerNotice`.
- `back_online` counts the Project's ACTIVE Tasks and uses the singular `1 Task resumed.` for one.
- Telegram's reaction set has no `❌`, so `failAck`'s reaction may be refused. The refusal is logged and the reply still goes out. Logged in `deferred-work.md` for correct-course.
- `cards/` imports the notice-kind constants from `core/coordinator/scheduler.ts`. Lint allows it.
- `projects.telegram_chat_id` is unique through an index, because SQLite cannot `ADD COLUMN ... UNIQUE`.
- The implementation commit is d0731e2.

## Spec Change Log

## Review Triage Log

Pass 1 (blind hunter BH, edge-case hunter ECH, verification gap VG):

| # | Source | Finding | Verdict | Evidence | Route |
|---|--------|---------|---------|----------|-------|
| 1 | BH/ECH | Sender loses a wake-up between the worker finding no head and `.finally` deleting it | medium | `wake()` skips a chat whose worker is still registered; a row enqueued in that microtask gap waits for an unrelated wake | patch |
| 2 | BH/ECH | A failed edit of a deleted card queues a loud delivery-failure notice | medium | Every 4xx except 429 fails with `notice: true`; `retire_card` on a card the Owner deleted gives `400 message to edit not found` and a sound | patch |
| 3 | BH/ECH | Command and text handlers run serially without a time limit, so a slow one delays later acks past 5 s; handlers also run twice after a mid-handler crash | medium | `handleUpdate` awaits each handler; the registry docs require neither speed nor idempotency, and stories 1-5 to 1-15 write these handlers | patch (doc contract) |
| 4 | VG/BH | `retireCard` is never run by a test | medium | Only `executor.has('retire_card')` and the transition are checked | patch |
| 5 | VG | `notify` replying to the Task's latest card is untested | medium | No test passes a card through `notify` or asserts `reply_parameters` | patch |
| 6 | VG/BH | `failAck` is untested, including the expected `❌` refusal | medium | Grep finds no `failAck` in `test/` | patch |
| 7 | VG | `back_online` per-Project count is not pinned | low | The only daemon test has one Project and one Task; the fix is one test | patch |
| 8 | VG/BH | A notice kind without a template is not shown to fail its effect, and the Owner sees nothing | low | Only templated kinds are emitted today | defer |
| 9 | BH/ECH | 401 or 409 from `getUpdates` is retried forever with warn logs only | medium | Real for a revoked token or a second poller on the same token; Telegram is the broken channel, so where to surface it is a design choice | defer |
| 10 | ECH | `#attempt` throwing leaves the chat without a timer | low | Needs a SQLite write failure; a retry timer adds a branch | reject |
| 11 | ECH | Edit target `sent` with null `sent_message_id` retries to exhaustion | false | Only edits are marked sent with a null id (`not modified`); edits target sends, which always return a `message_id` | reject |
| 12 | BH/ECH | Missing `{file_path}` is retried as a network error | low | Evidence files are immutable and exist before rows reference them; no media is sent until 1-10/1-11 | reject |
| 13 | ECH | Backward wall-clock jump stretches a backoff wait | low | Needs a clock jump during a retry; capping adds a branch | reject |
| 14 | ECH | `setSetting` throwing outside the try ends the poll loop | low | Needs a SQLite write failure | reject |
| 15 | ECH | Corrupt `telegram.last_update_id` gives `NaN` | false | Only `handleUpdate` writes it, always `String(update_id)` | reject |
| 16 | BH/ECH | `/cmd@otherbot` dispatched as our command | low | One private group per Project with only Owner and bot (EXPERIENCE.md); the fix needs `getMe` and new state | reject |
| 17 | ECH | Tap in a chat whose Project was unbound still runs | low | No unbind flow exists | reject |
| 18 | ECH | Registered row whose command has no handler gets the replaced toast | low | Unknown command is treated as stale by design; later stories register their commands | reject |
| 19 | ECH | `👀` with no follow-up for unknown command or no text handler | false | EXPERIENCE.md: a non-actionable message keeps `👀` and nothing else is sent; Intake is 1-8 | reject |
| 20 | BH/ECH | Latest-card queries order by per-chat counters across chats; `UNIQUE (effect_id, kind, sequence)` adds no constraint | low | No rebind flow exists; migration 0004 is committed (AD-23) | reject |
| 21 | BH/ECH | `notify` replay renders before the idempotency check, leaving orphan `callbacks` rows | low | Pending effects replay only after a crash, and no current template has buttons | reject |
| 22 | ECH | Invalid `resets_at` string throws `RangeError` | false | The scheduler copies `resets_at` from a zod-validated reading | reject |
| 23 | ECH | `fit` with fixed text over the limit goes negative | false | Every template's fixed text is under 80 characters | reject |
| 24 | ECH | Inline `# comment` after an unquoted secret value is kept | low | Unusual in a hand-written env file; adds parser rules | reject |
| 25 | BH | 429 counts against `outbox.retries`, so a long Review can fail mid-sequence | low | Each retry honours `retry_after`; MVP Reviews are a few messages | reject |
| 26 | BH | `callbacks` never pruned; non-Review stale taps get Review copy | low | Growth is a few rows per card; the stale copy is the Owner's decision | reject |
| 27 | BH | `back_online` counts at run time, not emit time | low | Effects run right after commit; only a crash replay shifts the count | reject |
| 28 | BH | `retire_card` strips only the newest card of the round | false | A round has one Review card, edited in place; `/evidence` copies have no buttons | reject |
| 29 | BH | `secrets/antipod.env` mode not checked | low | `secrets/` is created mode 700 by `ensureHome` | reject |

## Design Notes

Delivery is at-least-once: a crash between a successful send and `markSent` resends that row on the next boot. That is acceptable because Telegram offers no idempotency key. A Review sequence never interleaves because a card group is enqueued in one transaction with consecutive `sequence` numbers, and each chat drains strictly in order. A row blocks only its own chat, and only until its retries run out. Callback validity is code, not data: each registered command declares the Task states it expects, and the row stores only `command, task_id, round, args, expires_at`.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0

**Manual checks (if no CLI):**
- Against a second bot with a scratch `ANTIPOD_HOME`: the `/` menu shows the ten commands; an Owner message gets `👀`; a message from another account gets nothing.
