---
title: 'Sprint Change Proposal: a blocked Implementer goes to Triage'
date: '2026-11-20'
trigger_story: '1-9-implement-validate-and-triage-loop'
scope: 'minor'
status: 'approved'
approved: '2026-11-20'
mode: 'batch'
---

# Sprint Change Proposal: a blocked Implementer goes to Triage

## 1. Issue Summary

This came up while planning story 1-9 (2026-11-20): one Implementer outcome has no event.

**The gap.**
- AD-4 (ARCHITECTURE-SPINE.md:165) fixes `ImplementerOutput.status: done | blocked` and says "The Coordinator maps each discriminator to exactly one event".
- The AD-3 diagram (ARCHITECTURE-SPINE.md:113-152) has an arrow only for `done` (`implementing --> testing: implementer_done`). Nothing says where `blocked` goes.
- Story 1-7 left `blocked` to an output hook in 1-9. Until that hook exists, a blocked run is retried twice and then reaches `stuck` with the reason "implementer Stage exhausted its retries".

**Other docs it must agree with.**
- AD-3 says every entry to `stuck` other than `stage_retries_exhausted` and `deps_unsatisfiable` goes through Triage.
- EXPERIENCE.md:38 says the Stuck card is sent for "Iteration Budget spent or blocker".

**Owner decisions (2026-11-20).**
1. New event `implementer_blocked`: `implementing → triage`. Triage reads the blocker from the Implementer's summary and decides `rerun`, `park` or `stuck` as usual.
2. The push and the `test` step follow only an Implementer Stage that reports `done`. A blocked run goes straight to Triage without them. The next lap that finishes pushes any partial work.

**Evidence:**
- ARCHITECTURE-SPINE.md:105, 126, 165, 177, 241
- SPEC.md:78 (CAP-13), SPEC.md:106 (CAP-20)
- glossary.md:31
- SOLUTION-DESIGN.md:73
- stories.yaml:57
- spec-1-7 matrix row "Unmapped output"
- `src/app/stages.ts` `eventForOutput`, which returns `undefined` for `blocked`

## 2. Impact Analysis

**Epic impact.** Epic 1 continues as planned. No epic is added, removed or resequenced.

**Story impact.**
- **1-9 (`ready-for-dev`):** its spec already records both decisions (Owner decisions, matrix row "Blocked"). Nothing in it changes.
- **1-10 to 1-13:** they never see `blocked`. A run that follows Triage's `rerun` still counts one budget unit (`rerun` is already a counting cause).
- **1-15 (`/log`):** shows the new event like any other.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-3 diagram | Add `implementing --> triage: implementer_blocked` |
| ARCHITECTURE-SPINE.md | AD-4 output discriminators | Name the two Implementer events |
| ARCHITECTURE-SPINE.md | AD-5 push bullet | Push after an Implementer Stage that reports `done` |
| ARCHITECTURE-SPINE.md | AD-13 test-step bullet | Same wording for "CI on every push" |
| SOLUTION-DESIGN.md | "CI on every push" paragraph | Same wording |
| SPEC.md | CAP-13 success | A blocked Implementer also goes to Triage |
| SPEC.md | CAP-20 success | Push and test after an Implementer Stage that reports `done` |
| glossary.md | Role → Triage | Triage also decides on a blocked Implementer |
| stories.yaml | Story 9 description | "after every finished Implementer run" |
| epic-1-context.md | Git bullet | Same wording (cached context) |

**No change needed:**
- EXPERIENCE.md and DESIGN.md already cover a Stuck card for "blocker".
- The PRD states no per-run rule.
- config-defaults.md is untouched.
- The `.memlog.md` files are history and stay as written.

**Technical impact.** This is all already in the 1-9 scope:
- a new event type in `events.ts`
- one rule in `transitions.ts`, plus its row in the transitions table test
- `eventForOutput` mapping `blocked`
- the Triage brief carrying the blocker summary

There is no migration, config or deployment change.

## 3. Recommended Approach

**Direct adjustment.** The doc edits below are applied now, and story 1-9 implements them.
- **Effort:** small.
- **Risk:** low. The new arrow only touches the loop states 1-9 builds, and no shipped code emits `blocked` events yet.

Two alternatives were considered and rejected:
- **`blocked → stuck` directly.** This skips Triage, against AD-3's rule that only two causes enter `stuck` directly, and it gives the Owner no chance of an automatic rerun.
- **Leave `blocked` unhandled.** Two runs are wasted, and the Stuck card's reason is useless.

## 4. Detailed Change Proposals

### 4.1 ARCHITECTURE-SPINE.md, AD-3 diagram

ADD after `implementing --> testing: implementer_done`:
```
  implementing --> triage: implementer_blocked
```

Rationale: every Implementer discriminator gets an arrow, and the entry to `stuck` keeps going through Triage.

### 4.2 ARCHITECTURE-SPINE.md, AD-4 output discriminators (line 165)

OLD:
> … `ImplementerOutput.status: done | blocked`; …

NEW:
> … `ImplementerOutput.status: done | blocked` (`implementer_done`, `implementer_blocked`); …

### 4.3 ARCHITECTURE-SPINE.md, AD-5 (line 177)

OLD:
> - The Branch is pushed to `origin` after every Implementer Stage. …

NEW:
> - The Branch is pushed to `origin` after every Implementer Stage that reports `done`. …

### 4.4 ARCHITECTURE-SPINE.md, AD-13 (line 241)

OLD:
> … "CI on every push" in the MVP is that step plus the push after every Implementer Stage; …

NEW:
> … "CI on every push" in the MVP is that step plus the push after every Implementer Stage that reports `done`; a blocked Implementer goes to Triage without either; …

### 4.5 SOLUTION-DESIGN.md (line 73)

OLD:
> … the Recipe's `test` step, run by the Runner after every Implementer Stage, is the CI. …

NEW:
> … the Recipe's `test` step, run by the Runner after every Implementer Stage that reports `done`, is the CI. …

### 4.6 SPEC.md, CAP-13 success (line 78)

OLD:
> … non-blocking findings go to Triage, which reruns or parks them; …

NEW:
> … non-blocking findings and a blocked Implementer go to Triage, which reruns, parks or writes the Stuck reason; …

### 4.7 SPEC.md, CAP-20 success (line 106)

OLD:
> … after every Implementer Stage the Branch is pushed and the Recipe `test` step runs.

NEW:
> … after every Implementer Stage that reports `done` the Branch is pushed and the Recipe `test` step runs.

### 4.8 glossary.md, Role → Triage (line 31)

OLD:
> **Triage** (reruns or parks non-blocking findings, writes the Stuck reason)

NEW:
> **Triage** (reruns or parks non-blocking findings, decides on a blocked Implementer, writes the Stuck reason)

### 4.9 stories.yaml, story 9 description (line 57)

OLD:
> Branch push and Recipe test after every Implementer run, …

NEW:
> Branch push and Recipe test after every finished Implementer run, …

### 4.10 epic-1-context.md, Git bullet (line 106)

OLD:
> - The Branch is pushed after every Implementer Stage, and then the Recipe `test` step runs.

NEW:
> - The Branch is pushed after every Implementer Stage that reports `done`, and then the Recipe `test` step runs. A blocked Implementer goes to Triage.

## 5. Implementation Handoff

**Scope: minor.** The doc edits above are applied directly, and story 1-9 (`ready-for-dev`) implements the change with no change to its spec:
- `implementer_blocked` in `events.ts` and `transitions.ts`
- `eventForOutput` maps `blocked`
- the Triage brief includes the blocker summary
- a transitions-table row and the matrix-row test "Blocked"

**Success criteria:**
- Every Implementer discriminator has exactly one arrow in AD-3.
- No planning doc pushes or tests after a blocked run.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` exits 0 after 1-9.
