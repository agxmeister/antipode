---
title: 'Sprint Change Proposal: step runs and the capability hint gate'
date: '2026-11-13'
trigger_story: '1-6-step-runners'
scope: 'minor'
status: 'approved'
approved: '2026-11-14'
mode: 'batch'
---

# Sprint Change Proposal: step runs and the capability hint gate

## 1. Issue Summary

The story 1-6 spec (`docs/implementation-artifacts/spec-1-6-step-runners.md`) records four Owner decisions from 2026-11-13. Two of them add durable state that the spine doesn't describe yet:

- **Step runs are rows.** The spine refers to `step_run_id` (AD-7: `data/steps/<step_run_id>/`, `capability_leases.step_run_id`) and says step logs "are referenced by rows" (AD-2), but no table holds step runs. The Owner decided on a `step_runs` table: `id`, `task_id`, `stage_id` (nullable), `step`, `runner`, `status` `running|finished|failed`, `outcome`, `exit_code`, `reason`, `started_at` and `ended_at`. The table is inserted before spawning and updated on exit, and boot recovery marks `running` rows `failed` with reason `restart`. The spec requires this AD-2 amendment through Correct Course before implementation.
- **The AD-11 exclusive-capability hint gate needs its data in the database.** AD-11 evaluates every gate "all from the database", but the gate needs the Recipe's exclusive capability names, and the Recipe is a file in git. The Owner decided that registration stores them on `projects.exclusive_capabilities` (refreshed on re-register), and that a held Task shows the new `waiting_reason` `capability`.

**Evidence:** the spec's frozen "Owner decisions (2026-11-13)" block; ARCHITECTURE-SPINE.md:96 (AD-2 table list without `step_runs`), :191 (AD-7 `step_run_id`), :226 (AD-11 hint gate), :271 (AD-18 recovery).

## 2. Impact Analysis

**Epic impact.** Epic 1 continues as planned. No epic is added, removed or resequenced, and `sprint-status.yaml` needs no structural change.

**Story impact.**

- 1-6 (ready-for-dev): unblocked. Its spec already describes this design.
- 1-9, 1-10, 1-12 (Coordinator-run `test`, Evidence, Release): they read step outcomes from `step_runs` rows. They inherit this from the spine, so their story text doesn't change.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-2 Rule | add `step_runs` to the table list |
| ARCHITECTURE-SPINE.md | AD-7 Rule, lease bullet | define the step run row that `step_run_id` names |
| ARCHITECTURE-SPINE.md | AD-11 Rule | hint gate reads `projects.exclusive_capabilities`; `waiting_reason` `capability` |
| ARCHITECTURE-SPINE.md | AD-18 Rule | recovery fails `running` step runs and removes labelled step containers |
| epic-1-context.md | storage, gate and recovery lines | the same wording as the spine |

PRD, SPEC.md, `stories.yaml`, glossary, SOLUTION-DESIGN.md and the UX documents need no change. None of them names tables, waiting reasons or recovery steps at this level. The glossary's "Step" definition ("one Recipe step run") already fits. MVP scope is unaffected.

**Technical impact.** Migration `0006-steps` (new table and one column), which story 1-6 already plans. No config or deployment change.

## 3. Recommended Approach

**Direct adjustment.** Four spine sentences change and the cached epic context is updated to match. The spine already implied a step-run identity and database-only gates, and these edits make both explicit. Effort is small, risk is low, and there is no timeline impact.

## 4. Detailed Change Proposals

### 4.1 ARCHITECTURE-SPINE.md, AD-2 Rule

OLD:
> … `cost_samples`, `usage_samples`, `capability_leases`, `telegram_messages`, `outbox`, `callbacks`, `settings`. Files (Evidence artifacts, Stage transcripts, step logs) live under `data/` and are referenced by rows; …

NEW:
> … `cost_samples`, `usage_samples`, `step_runs`, `capability_leases`, `telegram_messages`, `outbox`, `callbacks`, `settings`. Files (Evidence artifacts, Stage transcripts, step logs) live under `data/` and are referenced by rows; …

Rationale: Owner decision. Step logs and `out/` directories need a row that references them.

### 4.2 ARCHITECTURE-SPINE.md, AD-7 Rule, lease bullet (prepended sentence)

OLD:
> - Exclusive capabilities are leased in `capability_leases {capability, task_id, step_run_id, acquired_at}`. …

NEW:
> - Every step execution is a `step_runs` row (`task_id`, `stage_id` when a Stage asked for it, `step`, `runner`, `status` `running|finished|failed`, `outcome`, `exit_code`, `reason`), inserted before spawning and updated on exit; its id is the `step_run_id` of `data/steps/<step_run_id>/`. Exclusive capabilities are leased in `capability_leases {capability, task_id, step_run_id, acquired_at}`. …

Rationale: the spine already uses `step_run_id`, and this sentence says what it identifies.

### 4.3 ARCHITECTURE-SPINE.md, AD-11 Rule

OLD:
> … → exclusive-capability hint (do not start a Task whose Recipe names an exclusive capability currently leased by another Project's Task; enforcement is the lease in AD-7). The failing gate is stored as `tasks.waiting_reason` for `/status`. …

NEW:
> … → exclusive-capability hint (do not start a Task whose Recipe names an exclusive capability currently leased by another Project's Task, read from `projects.exclusive_capabilities`, which registration sets from the validated Recipe; `waiting_reason` `capability`; enforcement is the lease in AD-7). The failing gate is stored as `tasks.waiting_reason` for `/status`. …

Rationale: keeps the rule that every gate reads the database (no git read per tick) and names the new waiting reason.

### 4.4 ARCHITECTURE-SPINE.md, AD-18 Rule

OLD:
> … resends unsent `outbox` rows, deletes all `capability_leases` after the host adapter has killed the processes they name, and deletes Evidence files without rows. …

NEW:
> … resends unsent `outbox` rows, marks every `running` `step_runs` row `failed(restart)`, deletes all `capability_leases` after the host adapter has killed the processes they name and the container adapter has removed the instance's step containers, and deletes Evidence files without rows. …

Rationale: Owner decision on recovery. Without this, an orphaned container keeps running after a restart.

### 4.5 epic-1-context.md

- Storage line: add `step_runs` to the table list.
- Gate line: "… exclusive-capability hint (from `projects.exclusive_capabilities`, set at registration; `waiting_reason` `capability`)."
- Recovery line: "… resend unsent outbox, fail `running` step runs with `restart`, kill leased step processes and remove step containers, clear leases, …"

Rationale: the cached context must say the same thing as the spine.

## 5. Implementation Handoff

**Scope: minor.** The Developer applies 4.1–4.5 now, commits them, and then resumes the 1-6 build from `docs/implementation-artifacts/spec-1-6-step-runners.md`.

**Success criteria:** the spine's AD-2, AD-7, AD-11 and AD-18 match the 1-6 Owner decisions; `epic-1-context.md` matches the spine; no other planning document changes.
