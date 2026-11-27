---
title: 'Sprint Change Proposal: rejected Evidence counts against the Iteration Budget'
date: '2026-11-27'
trigger_story: '1-10-evidence-production-ingest-and-rendering'
scope: 'minor'
status: 'approved'
approved: '2026-11-27'
mode: 'batch'
---

# Sprint Change Proposal: rejected Evidence counts against the Iteration Budget

## 1. Issue Summary

**Trigger.** Planning story 1-10 (2026-11-27) found that SPEC and the spine disagree on whether `evidence_rejected` costs a budget unit.
- SPEC.md:78 (CAP-13) says Implementer runs caused by "missing or rejected Evidence" each use one budget unit. PRD FR-13 and §10 agree: the budget "counts every Implementer run". `epic-1-context.md` says the same thing ("Evidence missing or rejected").
- Spine AD-3 (ARCHITECTURE-SPINE.md:108) lists the counting causes as `scheduler_start` (first lap), `blocking_findings`, `rerun`, `evidence_missing`, `test_failed` and `rebase_or_revalidation_failed`. `evidence_rejected` is not in the list. The code follows the spine (`COUNTING_CAUSES`, `src/core/coordinator/transitions.ts:102-109`).

**Owner decision (2026-11-27).** The SPEC wins. `verifying --evidence_rejected--> implementing` uses one budget unit. This is recorded in the frozen block of `spec-1-10-evidence-production-ingest-and-rendering.md`.

**Why it matters.** Without the unit, an Evidence Producer and Validator that keep disagreeing can send a Task back to the Implementer forever without spending the budget. The PRD calls the budget "the only brake" on loops (§10).

## 2. Impact Analysis

**Epic impact.** None. No story is added, removed or reordered.

**Story impact.** 1-10 adds `evidence_rejected` to `COUNTING_CAUSES` and updates the budget block of the transitions test (already in its Code Map). No done story changes.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-3 Rule, Iteration Budget (line 108) | Add `evidence_rejected` to the counting causes |

**No change needed:**
- SPEC.md, the PRD, glossary.md, the UX docs and epic-1-context.md already agree with the decision.
- The FSM diagram already draws `verifying --> implementing: evidence_rejected`.

**Technical impact.** There is one entry in `COUNTING_CAUSES`, built in 1-10. No migration and no config change.

## 3. Recommended Approach

**Direct adjustment.**
- **Effort:** trivial.
- **Risk:** low. A Task whose Evidence keeps being rejected reaches Stuck sooner, which is the intended brake.
- **Timeline:** none.

## 4. Detailed Change Proposals

### Architecture

**ARCHITECTURE-SPINE.md, AD-3 Rule (line 108)**

OLD:
> Iteration Budget: `budget_used` increments only when `implementing` is entered with cause `scheduler_start` (first lap), `blocking_findings`, `rerun`, `evidence_missing`, `test_failed` or `rebase_or_revalidation_failed`.

NEW:
> Iteration Budget: `budget_used` increments only when `implementing` is entered with cause `scheduler_start` (first lap), `blocking_findings`, `rerun`, `evidence_missing`, `evidence_rejected`, `test_failed` or `rebase_or_revalidation_failed`.

Rationale: this aligns AD-3 with SPEC CAP-13 and PRD FR-13, per the Owner decision.

### Implementation artifacts

**deferred-work.md**: mark the 1-10 entry on this rule `resolved` by this proposal. Fix its wording, and the Owner decision in the 1-10 spec: the rule is in AD-3, not AD-5.

## 5. Implementation Handoff

**Scope: minor.** The doc edit is applied with this proposal. The code change ships in story 1-10 through `bmad-build`.

**Success criteria:**
- AD-3 lists `evidence_rejected` among the counting causes.
- In 1-10, `COUNTING_CAUSES` includes `evidence_rejected`, and the transitions test asserts that `verifying --evidence_rejected--> implementing` increments `budget_used`.
