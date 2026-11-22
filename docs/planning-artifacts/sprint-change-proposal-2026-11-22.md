---
title: 'Sprint Change Proposal: Stuck card buttons by cause, and no park after a blocked Implementer'
date: '2026-11-22'
trigger_story: '1-9-implement-validate-and-triage-loop'
scope: 'minor'
status: 'approved'
approved: '2026-11-22'
mode: 'batch'
---

# Sprint Change Proposal: Stuck card buttons by cause, and no park after a blocked Implementer

## 1. Issue Summary

Both issues came up in the story 1-9 review (2026-11-21, review pass 1, findings #10 and #11). They were deferred to the Owner in `deferred-work.md`.

**Issue A: `Raise budget +2` on a Task stuck on dependencies.**
- AD-3 sends `deps_unsatisfiable → stuck` when a dependency can never merge. It also draws `stuck --> implementing: budget_raised` with no condition.
- The 1-9 spec sends the Stuck card with both buttons on every entry to `stuck`, including `deps_unsatisfiable`.
- Tapping `Raise budget +2` on that card starts `implementing` while the dependency is still unsatisfiable. A larger budget cannot fix a dependency.

**Issue B: `park` after a blocked Implementer.**
- The 2026-11-20 decision lets the Triage entered by `implementer_blocked` return `rerun`, `park` or `stuck`.
- `triage --> evidencing: parked` then sends a Branch on to Evidence even though it was never pushed or tested, and its work is unfinished by the Implementer's own account.

**Also missing from the spine.** The 1-9 spec (frozen intent) applies a `rerun` or `park` from a Triage entered by `budget_spent` as `stuck`, with Triage's reason. AD-3 does not say this. It is recorded here together with Issue B, because both use the same rule.

**Owner decisions (2026-11-22).**
1. A Stuck card whose cause is `deps_unsatisfiable` shows only `Cancel Task` and the footer. `budget_raised` on such a Task is ignored as `invalid`.
2. In a Triage entered by `implementer_blocked`, a `park` decision is applied as `stuck` with Triage's reason. So that Triage effectively chooses between `rerun` and `stuck`.

**Evidence:**
- ARCHITECTURE-SPINE.md:105 (generic events), :108 (Iteration Budget), :132-135 and :151-152 (diagram)
- DESIGN.md:152-157 (Stuck card)
- EXPERIENCE.md:99 (Stuck card component)
- SPEC.md:78 (CAP-13), SPEC.md:138 (Stuck card buttons)
- epic-1-context.md:150
- `deferred-work.md` entries from spec 1-9 (#10, #11)
- `src/core/coordinator/transitions.ts`: the `triage.parked` and `stuck.budget_raised` rules

## 2. Impact Analysis

**Epic impact.** Epic 1 continues as planned. No epic is added, removed or resequenced.

**Story impact.**
- **1-9 (`review`, committed 6cd1390):** gets a small follow-up change (section 5). Its frozen spec is not edited; this proposal supersedes the line "It is sent on every entry to `stuck`, including … `deps_unsatisfiable`" only as to which buttons are shown.
- **1-14 (Owner messages and controls):** a free-text reply to a deps-stuck card still goes through Intake (amend, drop a criterion or cancel). Nothing changes there.
- No other story is affected.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-3 generic events (line 105) | `deps_unsatisfiable` stuck accepts no `budget_raised` |
| ARCHITECTURE-SPINE.md | AD-3 rule, new bullet after Iteration Budget | How Triage's decision applies after `budget_spent` and `implementer_blocked` |
| ARCHITECTURE-SPINE.md | AD-3 diagram note (line 157) | Point to the new bullet for the conditional arrows |
| DESIGN.md | Stuck card, item 4 | Only `Cancel Task` when stuck on dependencies |
| EXPERIENCE.md | Component Patterns → Stuck card | Same |
| SPEC.md | CAP-13 success (line 78) | A blocked Implementer's Triage reruns or writes the Stuck reason |
| SPEC.md | Stuck card buttons (line 138) | Only `Cancel Task` when stuck on dependencies |
| epic-1-context.md | Stuck card bullet (line 150) | Same (cached context) |

**No change needed:**
- The PRD states no rule at this level.
- glossary.md: "decides on a blocked Implementer" still holds.
- config-defaults.md is untouched.
- The `.memlog.md` files are history and stay as written.

**Technical impact.** It is a small code change and needs no migration, config or deployment change:
- `transitions.ts`: `parked` in a Triage entered by `implementer_blocked` becomes `reason_written`. `budget_raised` from `stuck` is ignored as `invalid` when the Task entered `stuck` by `deps_unsatisfiable`.
- `stuck-card.ts`: drops `Raise budget +2` for that cause, both on the first send and when `Keep` restores the buttons.
- `roles/triage/prompt.md` and the Triage brief: after a blocked Implementer, `park` ends at the Stuck card.
- Tests for each.

## 3. Recommended Approach

**Direct adjustment.** The doc edits below are applied now, and a follow-up change to story 1-9 implements them.
- **Effort:** small, about one short build.
- **Risk:** low. Both changes narrow what a Task can do; neither adds a state or an arrow.
- **Timeline:** none. It lands before 1-10.

## 4. Detailed Change Proposals

### Architecture

**ARCHITECTURE-SPINE.md, AD-3 generic events (line 105)**

OLD:
> `deps_unsatisfiable → stuck` from `waiting_on_dependencies`. For these two direct entries to `stuck` the Coordinator writes `tasks.stuck_reason` itself; every other entry goes through Triage.

NEW:
> `deps_unsatisfiable → stuck` from `waiting_on_dependencies`. For these two direct entries to `stuck` the Coordinator writes `tasks.stuck_reason` itself; every other entry goes through Triage. A Task that entered `stuck` by `deps_unsatisfiable` accepts no `budget_raised` (`ignored(invalid)`): a larger budget cannot satisfy a dependency.

Rationale: Owner decision 1.

**ARCHITECTURE-SPINE.md, AD-3 rule: new bullet after "Iteration Budget"**

NEW:
> - Triage decisions by cause: Triage's `rerun`, `park` and `stuck` map to `rerun`, `parked` and `reason_written`. A Triage entered by `budget_spent` applies `rerun` and `parked` as `reason_written`. A Triage entered by `implementer_blocked` applies `parked` as `reason_written`, because a blocked Branch was never pushed or tested. In both cases `stuck_reason` is Triage's `reason`.

Rationale: Owner decision 2. It also records the spent-budget rule of the 1-9 frozen intent, which the spine lacked.

**ARCHITECTURE-SPINE.md, note under the AD-3 diagram (line 157)**

OLD:
> The generic events (`cancel`, `pause`/`resume`, `amended`, `stage_retries_exhausted`, `deps_unsatisfiable`) are listed in the Rule and not drawn, except the two `draft` exits of `stage_retries_exhausted`.

NEW:
> The generic events (`cancel`, `pause`/`resume`, `amended`, `stage_retries_exhausted`, `deps_unsatisfiable`) are listed in the Rule and not drawn, except the two `draft` exits of `stage_retries_exhausted`. The conditions on `triage --> implementing`, `triage --> evidencing` and `stuck --> implementing` are in the Rule ("Triage decisions by cause", generic events).

### UX

**DESIGN.md, Stuck card, item 4 (line 156)**

OLD:
> 4. Buttons. Row 1: `Raise budget +2` · `Cancel Task`.

NEW:
> 4. Buttons. Row 1: `Raise budget +2` · `Cancel Task`. A Task stuck on unsatisfiable dependencies gets `Cancel Task` alone.

**EXPERIENCE.md, Component Patterns → Stuck card (line 99)**

OLD:
> Buttons: `Raise budget +2` · `Cancel Task`.

NEW:
> Buttons: `Raise budget +2` · `Cancel Task`; only `Cancel Task` when the Task is stuck on a dependency that can never merge, since more budget cannot help.

### SPEC

**SPEC.md, CAP-13 success (line 78)**

OLD:
> Blocking findings return the Task to the Implementer; non-blocking findings and a blocked Implementer go to Triage, which reruns, parks or writes the Stuck reason; a pass goes to evidencing.

NEW:
> Blocking findings return the Task to the Implementer; non-blocking findings and a blocked Implementer go to Triage, which reruns, parks or writes the Stuck reason (after a blocked Implementer, a park becomes the Stuck reason; on a spent budget, every decision does); a pass goes to evidencing.

**SPEC.md, Stuck card (line 138)**

OLD:
> A Stuck card offers `Raise budget +2` and `Cancel Task`, and free replies go through Intake.

NEW:
> A Stuck card offers `Raise budget +2` and `Cancel Task` (only `Cancel Task` when the Task is stuck on dependencies), and free replies go through Intake.

### Implementation artifacts

**epic-1-context.md (line 150)**

OLD:
> The Stuck card offers `Raise budget +2` / `Cancel Task`, and `Cancel Task` asks for confirmation in place.

NEW:
> The Stuck card offers `Raise budget +2` / `Cancel Task` (only `Cancel Task` when stuck on dependencies), and `Cancel Task` asks for confirmation in place. After a blocked Implementer, Triage's `park` ends at the Stuck card.

## 5. Implementation Handoff

**Scope: minor.** The Developer implements it directly, as a follow-up change to story 1-9 through `bmad-build`.

**Success criteria:**
- A Task stuck by `deps_unsatisfiable` gets a loud Stuck card with only `Cancel Task` and the footer. `Keep` restores only that button. A `budget_raised` event for it is `ignored(invalid)`.
- A Triage entered by `implementer_blocked` that answers `park` leaves the Task `stuck` with Triage's reason. It parks nothing, pushes nothing and runs no test. `rerun` and `stuck` behave as before.
- The two matching `deferred-work.md` entries are marked resolved by this proposal.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` all exit 0.
