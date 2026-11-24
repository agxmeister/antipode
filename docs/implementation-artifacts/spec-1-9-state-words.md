---
title: 'Owner-facing words for Task states in the stale-tap toast'
type: 'feature'
created: '2026-11-24'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/sprint-change-proposal-2026-11-24.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The stale-tap toast `#${id} is ${state} now.` prints the internal state name with `_` as spaces, e.g. `This draft is draft now.`

**Approach:** Apply the approved Sprint Change Proposal of 2026-11-24.
- `stateToast` writes the state with EXPERIENCE.md → Voice and Tone → State words, e.g. `This draft is being revised now.` and `#12 is being tested now.`
- The words come from one exhaustive map over every Task state, which `/peek` and `/status` can reuse later.
- The matching `deferred-work.md` entry is marked resolved.

</frozen-after-approval>

## Implementation Notes

- `STATE_WORDS` lives in `src/adapters/telegram/cards/card.ts`, the shared home of Owner-facing card copy. It is typed `Record<TaskState, string>`, so a new state without words fails the type check.
- `stateToast` in `poller.ts` uses it.
- Tests: the map lists exactly `TASK_STATES` and matches the EXPERIENCE.md table; toasts for a draft and a numbered Task.

## Review Triage Log

Pass 1 (blind-hunter).

- low, patched: the docs-table test matched two-column rows anywhere in EXPERIENCE.md. It now reads only the State words section and checks its row count.
- low, patched: the toast was checked for 4 of 20 states. It is now checked for every state, including the proposal's `accept_pending` example.
- low, patched: the `STATE_WORDS` comment said it is used wherever `${state}` reaches the Owner. It now names `stateToast` today and `/peek` and `/status` when built.
- low, patched: the poller test name now says what it checks.
- low, rejected: `#12 is merged, release failed now.` reads awkwardly. It is approved copy, the Owner accepted the same shape (`accepted · undo open now.`), and a stale tap on a merged Task is rare.
- low, rejected: `STATE_WORDS` belongs in its own module. `card.ts` already holds the shared Owner-facing copy helpers; 1-14 and 1-15 can import it from there.
- false: "the spec is still `in-progress` and has no triage log". Both are set at finalize.
