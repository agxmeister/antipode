---
title: 'Sprint Change Proposal: Intake giving up in draft'
date: '2026-11-19'
trigger_story: '1-8-intake-drafts-from-text-and-the-inbox'
scope: 'minor'
status: 'approved'
approved: '2026-11-19'
mode: 'batch'
---

# Sprint Change Proposal: Intake giving up in draft

## 1. Issue Summary

In the story 1-8 walkthrough (2026-11-18), finding #11 from review pass 1 turned out to be a conflict in the docs.

**The spine rule.** ARCHITECTURE-SPINE.md:105 (AD-3, generic events) says:

> `stage_retries_exhausted → stuck` from any state whose current Stage is running.

`draft` runs a Stage (Intake), so taken literally a draft whose Intake gives up goes to `stuck`. That cannot work:
- `stuck` is for numbered Branch work. Its only way out is `budget_raised → implementing`.
- A draft has no number, no Branch and no contract projection.

**What story 1-8 did instead.** The 1-8 spec sends a draft to `cancelled` on `stage_retries_exhausted`, and the code does the same. The spine was never corrected to match. So the current code already contradicts the spine.

**What the Owner wants.** Cancelling is also wrong when the failed run is a revision. The Owner replies to a good Draft card, Intake fails three times, and the whole draft is lost.

**Owner decision (2026-11-18), option 1:**
- When the draft already has a contract (the failed run was a revision), it returns to `awaiting_approval` on its previous version.
- When it has no contract yet (the first run), it is `cancelled`.
- Either way, the Owner's latest message gets `❌` and `Couldn't process that — send it again.`

**Evidence:**
- ARCHITECTURE-SPINE.md:105 (generic rule) and :113-152 (diagram).
- ARCHITECTURE-SPINE.md:217 (AD-10 `❌` after `intake.retries`).
- EXPERIENCE.md:130 (failure copy).
- spec-1-8 Boundaries line 32.
- `src/core/coordinator/transitions.ts` (`stage_retries_exhausted` in `draft`).
- The 1-8 review triage log, row 11.

## 2. Impact Analysis

**Epic impact.** Epic 1 continues as planned. No epic is added, removed or resequenced.

**Story impact.**
- **1-8 (`review`):** one transition branch, its tests, and one Boundaries line in the spec.
- **1-14 and 1-17:** they also create or revise drafts and inherit the rule. Their story text is unchanged.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-3 Rule, generic events bullet | Add the `draft` exception to `stage_retries_exhausted → stuck` |
| ARCHITECTURE-SPINE.md | AD-3 diagram | Draw the two `draft` arrows |
| ARCHITECTURE-SPINE.md | Note under the diagram | Say the `draft` arrows are drawn as exceptions |
| spec-1-8 | Boundaries, Intake failure bullet | Revision returns to its card; only a first run cancels |

EXPERIENCE.md needs no change: row 130 already puts `❌` and the reply on the Owner's message, whatever happens to the draft. The PRD, SPEC.md, DESIGN.md, config-defaults.md and epic-1-context.md don't state this rule. MVP scope is unaffected.

**Technical impact.**
- `transitions.ts`: the `draft` branch of `stage_retries_exhausted` chooses `awaiting_approval` or `cancelled`. The choice comes from a new `TransitionContext.hasContract()`, because `transition` stays pure.
- In both branches, the `intake_failed` notice marks the Owner's latest message.
- The card's `closed: 'cancelled'` path goes away. A first run has no card, so nothing is left to close.
- Tests: the transitions table, plus an Intake integration test for a failed revision.
- No migration, config or deployment change.

## 3. Recommended Approach

**Direct adjustment.** This is a spine wording and diagram edit, plus a small code change in 1-8 before the story is marked done.
- **Effort:** small.
- **Risk:** low. The change only touches `draft`, which has no Branch and no budget.
- **Timeline:** no impact.

Two alternatives were considered and rejected:
- **Keep cancelling everywhere (option 3).** It loses a good draft to a transient failure.
- **Trigger `draft_ready` instead of drawing a new arrow (option 2).** The event log would show a `draft_ready` that produced no draft.

## 4. Detailed Change Proposals

### 4.1 ARCHITECTURE-SPINE.md, AD-3 Rule, generic events (line 105)

OLD:
> … `stage_retries_exhausted → stuck` from any state whose current Stage is running. `deps_unsatisfiable → stuck` from `waiting_on_dependencies`. …

NEW:
> … `stage_retries_exhausted → stuck` from any state whose current Stage is running, except `draft`. In `draft` (Intake gave up after `intake.retries`), it goes to `awaiting_approval` on the previous contract version when the draft already has one (a revision). It goes to `cancelled` when the draft has none (the first run). Either way the Owner's latest message of the draft gets `❌` and a reply (AD-10). `deps_unsatisfiable → stuck` from `waiting_on_dependencies`. …

Rationale: `stuck` has no exit that fits an unnumbered draft, and a failed revision must not lose an approved-ready draft.

### 4.2 ARCHITECTURE-SPINE.md, AD-3 diagram

ADD after `discard_pending --> cancelled: undo_expired`:
```
  draft --> awaiting_approval: stage_retries_exhausted [revision]
  draft --> cancelled: stage_retries_exhausted [first run]
```

### 4.3 ARCHITECTURE-SPINE.md, note under the diagram (line 154)

OLD:
> The generic events (`cancel`, `pause`/`resume`, `amended`, `stage_retries_exhausted`, `deps_unsatisfiable`) are listed in the Rule and not drawn.

NEW:
> The generic events (`cancel`, `pause`/`resume`, `amended`, `stage_retries_exhausted`, `deps_unsatisfiable`) are listed in the Rule and not drawn, except the two `draft` exits of `stage_retries_exhausted`.

### 4.4 spec-1-8, Boundaries & Constraints (line 32)

OLD:
> - `not_actionable` cancels the scratch draft silently, leaving only the `👀`. After `intake.retries`, `stage_retries_exhausted` in `draft` cancels it, replaces `👀` with `❌` and replies `Couldn't process that — send it again.`

NEW:
> - `not_actionable` cancels the scratch draft silently, leaving only the `👀`. After `intake.retries`, `stage_retries_exhausted` in `draft` cancels a first run, and returns a revision to `awaiting_approval` on its previous version with the card unchanged. Either way the Owner's latest message of the draft gets `❌` and the reply `Couldn't process that — send it again.` (spine AD-3, correct-course 2026-11-19).

## 5. Implementation Handoff

**Scope: minor.** The doc edits above are applied directly. The Developer then patches story 1-8:
- In `transitions.ts`, the `draft` branch uses `ctx.hasContract`. The Coordinator supplies it from `latestContract`.
- The transitions table test splits the `draft` row by `hasContract`.
- A new Intake integration test: a reply whose Intake fails on every attempt leaves the Task in `awaiting_approval` on version 1, with the card untouched, `❌` on the reply and one reply message.
- The deferred-work entry for #11 is removed.

**Success criteria:**
- No planning doc sends a draft to `stuck`.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` exits 0.
- A failed revision keeps the draft open on its previous version.
