---
title: 'Stuck card buttons by cause, and no park after a blocked Implementer'
type: 'feature'
created: '2026-11-22'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/sprint-change-proposal-2026-11-22.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1-9 shows `Raise budget +2` on a Task stuck by `deps_unsatisfiable`. Tapping it starts `implementing` while the dependency is still unsatisfiable. A Triage entered by `implementer_blocked` may also `park`, which sends a Branch that was never pushed or tested on to `evidencing` (deferred from the 1-9 review, #10 and #11).

**Approach:** Apply the approved Sprint Change Proposal of 2026-11-22.
- A Task that entered `stuck` by `deps_unsatisfiable` ignores `budget_raised` as `invalid`. Its Stuck card shows only `Cancel Task` and the footer, both when first sent and when `Keep` restores the buttons.
- A Triage entered by `implementer_blocked` applies `parked` as `reason_written`, with Triage's reason as `stuck_reason`. Nothing is parked, pushed or tested.
- The Triage prompt and brief say so.
- The two matching `deferred-work.md` entries are marked resolved.

</frozen-after-approval>

## Implementation Notes

- The cause of the current `stuck` visit is read from `stage_events` by a new `stuckCause` in `src/core/domain/loop.ts`, sharing one helper with `triageCause` (the newest applied entry, skipping a resume from `paused`). So a deps-stuck Task that is paused and resumed still gets no `Raise budget +2`.
- `budget_raised` is refused in `transition()` before the rule table, next to the undo-window checks, because table rules can only return an applied outcome. `TransitionContext` gains `stuckCause`, which the Coordinator supplies.
- `parked` in `triage` becomes `reason_written` when `triageCause` is `budget_spent` or `implementer_blocked`. `rerun` after a blocked Implementer is unchanged.
- `stuck-card.ts`'s `stuckKeyboard` drops `Raise budget +2` for a deps-stuck Task. One function covers the first send and `Keep`.
- The Triage brief gains a line for a blocked Implementer, and `roles/triage/prompt.md` adds the same guidance.
- Tests: transitions (blocked park becomes stuck, rerun stays drawn, deps raise refused), `stuckCause`, the deps Stuck card first send and restore, and the Triage brief line.

## Review Triage Log

Pass 1 (blind-hunter).

- low, patched: the deps guard sat between the undo-windows comment and the undo checks. It now sits before the CAP-8 refusal, with its own comment.
- low, patched: the `#deliver` comment on `park` now names the blocked-Implementer cause too.
- medium, patched: nothing checked that the Coordinator supplies `stuckCause`, and dropping it would let the guard fail open. Added a Coordinator test: `deps_unsatisfiable` → `raiseBudget` refused, also after pause and resume.
- low, patched: the Triage prompt's `park` bullet said "goes on to Evidence" unconditionally. It now names the two exceptions.
- low, patched: `LoopBrief.blocked` is now required, like `budgetSpent`.
- medium, deferred: a refused or stale tap on a Stuck card answers with `STALE_TAP_TOAST` ("This Review was replaced by a newer one."), which is Review wording. This predates this change (1-9 `stuck.ts`).
- low, rejected: cards sent before this change still show `Raise budget +2` on a deps-stuck Task. The tap is refused; no Owner instance has run 1-9 yet.
- low, rejected: no Stages-level "parks nothing" test. The `state === 'evidencing'` guard is already covered by the 1-9 spent-budget `park` loop test, and the transition test covers the blocked cause.
- false: "the guard fails open without `stuckCause`". Every `TransitionContext` hook is optional by design (`triageCause` too). The Coordinator wiring is now tested.
- false: "the Triage schema still accepts `park`". The approved intent keeps the schema and remaps the decision.
- false: "`stuckCause` after `amended` inherits `deps_unsatisfiable`". It returns the newest entry into `stuck`, so a later `reason_written` wins.
- low, rejected: the `resolved:` key in `deferred-work.md`. The approved proposal asks to mark the entries resolved, and the ledger has no other convention.
- false: "spec still `in-progress`, no verification section". Oneshot specs carry only Intent and Notes; the status is set to done at finalize.
