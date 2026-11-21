---
title: 'Implement, validate and triage loop'
type: 'feature'
created: '2026-11-20'
status: 'done'
baseline_commit: '7f27251dbb88731a856883d01baa99633668554b'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** An approved Task enters `implementing`, but the loop cannot run. The Implementer brief has no criteria or findings, `run_test_step` has no handler, nothing pushes the Branch, Implementer `blocked` is unhandled, Triage `park` stores nothing, and entering `stuck` tells the Owner nothing. A Triage `rerun` after `budget_spent` re-derives `budget_spent` forever (CAP-13, CAP-19, CAP-20; AD-3, AD-4, AD-5, AD-21).

**Approach:** Stage outputs are stored on their `stages` rows, and briefs are rendered from those rows and the contract rows. The `testing` Stage pushes the Branch and runs the Recipe `test` step. Triage `park` writes `parking_lot` rows. Every entry to `stuck` sends a loud Stuck card with `Raise budget +2` and `Cancel Task`, and `Cancel Task` confirms in place.

## Boundaries & Constraints

**Always:**
- Briefs are rendered from rows (AD-21). Implementer: goal, active criteria (`AC<n>`, text, Required Evidence), the last lap's blocking findings, Triage reason or test-failure log tail, and parked findings so it does not chase them. Validator: criteria and the Branch, never the Implementer's summary as a verdict (CAP-19). Triage: criteria, the Validator's non-blocking findings, laps so far, `budget_used/budget_limit`.
- `testing` is one Coordinator-run Stage. First `Repo.pushBranch` to `origin`, then `Steps.run({taskId, step: 'test'})`. A Recipe with no `test` step gives `test_passed` after the push. Exit 0 → `test_passed`. Non-zero exit or `timeout` → `test_failed` with the log tail stored for the next brief. A push failure, a refused step or `capability_busy` → `stage_failed`, retried without budget, then `stage_retries_exhausted` → `stuck` with the cause as `stuck_reason`.
- Triage `park` writes one `parking_lot` row per non-blocking finding of the preceding Validator Stage: `P<n>` per Task, `status = open`, criterion id and note.
- `budget_spent` → Triage. In that Triage the brief says the budget is spent, and a `rerun` or `park` decision is applied as `stuck` with Triage's `reason`. The loop always ends at the Stuck card.
- Stuck card (DESIGN `stuck-card`, loud `stuck_card`): title, `stuck_reason` on one line, up to 3 `Lap ${n}: ${what}` lines from the latest Implementer summaries, buttons `Raise budget +2` · `Cancel Task`, footer `Or reply to amend or drop a criterion.` It is sent on every entry to `stuck`, including `stage_retries_exhausted` and `deps_unsatisfiable`.
- `Raise budget +2` → `budget_raised{2}`. The toast is `Budget +2. Resuming.` and the card loses its buttons with state line `⏳ Budget +2 · resuming`. `Cancel Task` edits the buttons to `Confirm cancel #n` · `Keep`. `Confirm` → `cancel`, with toast `Cancelled.` and state line `Cancelled`. `Keep` restores the buttons. Taps are bound to `stuck`, and a tap on a card that is no longer stuck gets the stale toast.

**Never:**
- No Evidence Producer, Evidence mode or before/after (1-10). A Task reaching `evidencing` follows the existing unhandled-output path until 1-10. The Stuck card's "last Evidence resent as media" waits for 1-10.
- No Review card or Parking Lot promotion or dismissal (1-11, 1-17). No free-text reply handling on the Stuck card (1-14). No `/cancel` command (1-14).
- Never edit committed migrations 0001–0008.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy lap | `done` → test exit 0 → `pass` | Branch pushed; `testing` → `validating` → `evidencing`; `budget_used` 1 | — |
| Test fails | test exit 1 | `implementing`, budget +1, brief has log tail | — |
| Blocking | Validator `blocking` | `implementing`, budget +1, brief lists findings | — |
| Non-blocking, park | `nonblocking` → Triage `park` | `parking_lot` P1..Pn, `evidencing` | — |
| Blocked | Implementer `blocked` | `triage`, brief has the blocker summary | — |
| Rerun | Triage `rerun` | `implementing`, budget +1 | spent → Stuck |
| Budget spent | `budget_used = limit` and a counting cause | Triage, then Stuck card with reason and laps | — |
| Raise | tap `Raise budget +2` | `implementing`, `budget_limit` +2, no unit | stale → toast |
| Cancel | `Cancel Task` → `Confirm cancel` | `cancelled`, Branch kept | `Keep` restores |
| Push fails | remote rejects | `stage_failed`, retried, then Stuck with reason | — |
| No test step | Recipe without `test` | push, then `test_passed` | — |

## Owner decisions (2026-11-20)

- **Implementer `blocked`.** New event `implementer_blocked`: `implementing → triage`. Triage reads the blocker from the Implementer summary and returns rerun, park or stuck. Adding the arrow to the AD-3 diagram goes through `bmad-correct-course`, not this story.
- **Scope.** One spec. The Owner kept it whole over the 1600-token target.

</frozen-after-approval>

## Code Map

- `src/adapters/sqlite/migrations/0009-loop.ts` (new) -- `stages.output TEXT` (JSON: Implementer summary/status, Validator findings, Triage reason, test `{step_run_id, exit_code, log_tail}`); `parking_lot(id, task_id, p_no, criterion_id, note, status CHECK open|promoted|dismissed, source_stage_id, created_at)`, unique `(task_id, p_no)`
- `src/core/ports/store.ts` + SQLite store -- `setStageOutput`, `stagesOfTask(taskId, role?)`, `insertParkedFindings`, `parkedFindings(taskId)`; reuse `latestContract`, `criteriaOf`, `sortedCriteria`
- `src/core/coordinator/transitions.ts:118-133,242-294` -- `implementer_blocked` arm; Triage entered with cause `budget_spent` maps `rerun`/`parked` to `reason_written`; `enter('stuck')` emits `notify` `stuck_card`; keep `COUNTING_CAUSES`
- `src/core/domain/events.ts:56-86` -- `implementer_blocked` event
- `src/app/stages.ts:92-116,246-272,494-518` -- `eventForOutput` maps `blocked`; `#deliver` stores output through `EventRows`; `renderBrief` per Role from rows (doc at :492)
- `src/core/ports/repo.ts`, `src/adapters/git/repo.ts` -- `pushBranch(project, branch)` from the worktree through the bare clone to `origin`; test it against `createTempRemote`
- `src/app/test-step.ts` (new) -- `run_test_step` handler: push, `Steps.run`, apply `test_passed`/`test_failed`/`stage_failed` with the `stage_id`; register in `src/app/daemon.ts:265`. Boot recovery already treats `run_test_step` like `start_stage` (`recovery.ts:39,58`)
- `src/adapters/telegram/cards/stuck-card.ts` (new) -- DESIGN `stuck-card`, registered through `registerNotice`; callbacks `raise_budget`, `cancel_task`, `confirm_cancel`, `keep` following `draftIntake.callbacks()` (`src/app/intake.ts:340`)
- `src/core/coordinator/coordinator.ts` -- `raiseBudget(taskId, n)` and `cancelTask(taskId)` commands that go through `applyEvent`
- Tests: `test/core/coordinator/transitions.test.ts:112-153,238-290` (table and budget block); `test/helpers/claude.ts` runs play in launch order, so script the Roles in sequence; `test/helpers/steps.ts` `fakeContainerRunner`; `test/helpers/git.ts` `createTempRemote`

## Tasks & Acceptance

**Execution:**
- [x] `migrations/0009-loop.ts`, `ports/store.ts`, SQLite store -- output and Parking Lot rows -- AD-2, AD-16
- [x] `transitions.ts`, `events.ts`, `coordinator.ts` -- blocked arm, spent Triage, Stuck notify, raise and cancel commands -- AD-3
- [x] `src/app/stages.ts` -- output storage, blocked mapping, per-Role briefs -- AD-4, AD-21
- [x] `ports/repo.ts`, `adapters/git/repo.ts`, `src/app/test-step.ts`, `daemon.ts` -- push and test Stage -- AD-5, AD-7
- [x] `cards/stuck-card.ts`, `messenger.ts` -- Stuck card and buttons -- AD-10, DESIGN
- [x] `test/**` -- one test per matrix row, plus updates to the transitions table and the budget block -- AD-24

**Acceptance Criteria:**
- Given a scripted fake `claude` (Implementer `done`, Validator `blocking`, Implementer `done`, Validator `pass`) and a passing fake test runner, when the Task is approved and runs, then it reaches `evidencing` with `budget_used` 2, the temporary remote's Branch head equals the worktree head, and the second Implementer brief contains the blocking finding's note.
- Given `budget_limit` 1 and a Validator `blocking` verdict, when Triage returns `rerun`, then the Task is `stuck`, exactly one loud Stuck card is queued with Triage's reason, and tapping `Raise budget +2` returns it to `implementing` with `budget_limit` 3.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

## Spec Change Log

## Review Triage Log

Pass 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG).

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | BH/EC/VG: `TestStep.run` only logs when `#test` or the result `applyEvent` rejects | medium | `Steps.run` can throw from its `mkdir` calls before its try; the Stage then stays `running` with no event or notice until restart | patch |
| 2 | EC: `stop()` racing `applyEvent(stage_started)` still starts push and step | low | `run()` checks `#stopped` only before the await; the fix is one guard | patch |
| 3 | EC: pause then resume from `stuck` sends a second card reading "Stuck" | medium | `stuck` is in `ACTIVE_STATES`; `enter('paused')` nulls `stuck_reason`, `resume` re-enters `stuck` and the card falls back to "Stuck" | patch |
| 4 | BH/EC: Triage on a spent budget does not see the blocking findings or the test log tail | medium | `renderLoopBrief` `triage` case renders only blocked summary and non-blocking findings, though `lastLapOf` holds both | patch |
| 5 | BH: the Implementer brief after blocked → `rerun` drops the blocker summary | low | `implementer` case renders blocking, test failure and Triage reason, never `lap.implementer.summary` | patch |
| 6 | BH: "Triage sent the Task back" is wrong after a spent-budget Triage and `Raise budget` | low | that Triage ended at `stuck`; one-line wording fix | patch |
| 7 | BH: `logTail` can start mid-line or mid-UTF-8 character | low | reads the last 16 KiB at a byte offset; dropping the first line is a direct correction | patch |
| 8 | VG/BH: no test that a spent-budget `park` parks nothing | low | only parking test uses the default budget; guard in `#deliver` untested | patch |
| 9 | VG: no test that the daemon routes `cancel_stage` and shutdown to `TestStep` | low | `daemon.test.ts` only checks registration; `test-step.test.ts` calls `cancel` directly | patch |
| 10 | EC: `Raise budget +2` on a Stuck card from `deps_unsatisfiable` starts `implementing` | medium | the frozen intent puts the button on that card and `stuck --budget_raised--> implementing` predates this story (AD-3) | defer |
| 11 | EC: Triage entered by `implementer_blocked` may `park`, sending an unpushed, untested Branch to `evidencing` | medium | follows the Owner decision of 2026-11-20 (Triage returns rerun, park or stuck); needs an Owner call | defer |
| 12 | BH/EC: leaving `stuck` by `amended` never closes the card | low | `amended` from the Stuck card arrives with replies in 1-14 | defer |
| 13 | BH: the same non-blocking finding can be parked again every lap | low | no dedupe and the Validator brief does not list the Parking Lot; fix adds new logic | defer |
| 14 | BH: `parking_lot.criterion_id` is the Validator's free-text label | low | not checked against `criteria`; matters for promotion in 1-17 | defer |
| 15 | BH: a spent-budget `park` loses its non-blocking findings | false | the frozen intent applies that `park` as `stuck`; nothing is parked by design | reject |
| 16 | BH: test outcomes other than timeout or non-zero exit vanish from the brief | false | `STEP_OUTCOMES` is `exited`, `timeout`, `capability_busy`; `capability_busy` is `stage_failed` | reject |
| 17 | BH: uncommitted work can pass `test` while a stale Branch is pushed | false | `roles/implementer/prompt.md:7` tells the Implementer to commit; the Validator judges the Branch | reject |
| 18 | BH: over-limit fallback in `renderStuckCard` double-escapes | low | unreachable: title 80, reason 300 and three 140-char laps stay far below `TEXT_LIMIT` | reject |
| 19 | BH: an edit to the Stuck card is dropped if another card was sent after it | low | in `stuck` no other `*_card` is sent; the latest Stuck card is the one edited | reject |
| 20 | BH: `'draftId' in context` duck typing in `renderBrief` | false | no named harm; tsc checks both shapes | reject |
| 21 | BH: `raise_budget` reads `amount` unchecked | false | `args` are written by the card renderer only; no path writes a malformed amount | reject |
| 22 | EC: a cancel during `pushBranch` still pushes the Branch | low | the Branch is kept on cancel anyway; fix adds signal plumbing | reject |
| 23 | EC: no toast when the Stuck card send failed and the Owner taps | false | a card that was never delivered has no buttons to tap | reject |
| 24 | BH: footer reply and "last Evidence resent" ordering not implemented | false | the frozen Never section defers both to 1-14 and 1-10 | reject |
| 25 | BH: no tests for `TestStep.stop`, empty `insertParkedFindings`, over-limit card | low | covered in part by #9; the rest guard no demonstrated defect | reject |

## Design Notes

- Decided: the push sits inside the `testing` Stage, not in a separate effect. A failed push is then a retried Stage failure that ends at a Stuck card. As a standalone effect it would leave only a `failed` row, the gap deferred from 1-8 #8.
- Decided: a failed infrastructure step (push, refused step, `capability_busy`) never costs budget. Only a test that ran and failed does.
- Decided: button copy not in EXPERIENCE (`Budget +2. Resuming.`, `⏳ Budget +2 · resuming`, `Cancelled.`) follows the Draft card's toast and state-line style.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0
