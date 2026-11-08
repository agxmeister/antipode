---
title: 'Coordinator core'
type: 'feature'
created: '2026-11-08'
status: 'done'
baseline_commit: '2282b4446e4c6387fc4c4623027f0f1ba20b6405'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-antipod/config-defaults.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing can hold or move a Task yet. Every flow story (1-3 to 1-17) needs the deterministic Task state machine, the commit-first effects pipeline, crash-only recovery and sleep-aware deadlines that spine AD-3 and AD-18 fix (CAP-11).

**Approach:** Add the domain types, a table-driven `transitions.ts` over the AD-3 diagram and generic events, a serial event queue whose `applyEvent` writes Task state, `stage_events` and `effects` in one SQLite transaction, an effects executor with a handler registry, boot recovery, and a monotonic `Deadlines` module that survives Mac sleep. Migration 0002 adds `projects`, `tasks`, `stages`, `stage_events`, `effects`. The daemon runs recovery at boot and drains effects.

## Boundaries & Constraints

**Always:** AD-3 verbatim: one in-process serial queue; `applyEvent` synchronous, one transaction, no adapter call inside; effects run after commit in insertion order, idempotent by `effect_id`, marked `done` or `failed`; a `start_stage` effect inserts its `stages` row as `starting` inside the transition. Stage and step events are applied only when `stage_id = tasks.current_stage_id` and the row is `starting` or `running`; otherwise appended as `ignored(stale)`. Budget counting, undo windows, `resume_state`, `stuck_reason`, generic events and the `ACTIVE` set exactly as AD-3 lists them. Stage retries (AD-4) never count against budget; after `retries` failures the Coordinator applies `stage_retries_exhausted` in the same transaction. `review_round` increments only on entry to `in_review` (AD-16). Ids are ULIDs; timestamps ISO-8601 UTC; `src/core/` imports only `node:*` and `zod`.

**Decisions:** Effect handlers are registered by kind from `src/app/`; a kind with no handler is marked `failed(no_handler)` and logged, so later stories plug in Telegram, git, steps and `claude-cli` without touching the core. `testing` enters with effect `run_test_step`; a `test_passed` event is emitted by that handler (story 1-6). The scheduler tick, `undo_expired` scanning and gates are story 1-3; this story only accepts the events. Role `retries` come from a `roles` section with config-defaults values (role.yaml layering is 1-7). On a wall-clock jump over 60 s, running deadlines extend by the gap and one `back_online` effect is queued per Project with an `ACTIVE` Task; its Telegram notice is a later handler.

**Never:** No Telegram, git, Podman or `claude` code; no `contracts`, `criteria`, `evidence`, `outbox`, `capability_leases` tables (their stories add migrations). No LLM in the core. Never edit migration 0001. Never rebuild state from `stage_events`: `tasks` is the current state, events are history.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Transition | `queued` + `scheduler_start` | `implementing`, `budget_used` 1, `stages` row `starting`, `current_stage_id` set, one `stage_events` row and one `start_stage` effect in the same transaction | N/A |
| Undefined pair | `merged` + `correction` | No state change; event stored as `ignored(invalid)`; returns `{applied: false}` | Never throws |
| Stale Stage event | `implementer_done` with an old `stage_id` | `ignored(stale)`, no effect | N/A |
| Stage retry | `stage_failed(timeout)`, attempt 1 of `retries` 2 | Same state, new `stages` row attempt 2, `start_stage`; `budget_used` unchanged | N/A |
| Retries exhausted | `stage_failed`, attempt 3 | `stuck`, `stuck_reason` written by the Coordinator | N/A |
| Pause / resume | `implementing` + `pause`, then `resume` | `paused` with `resume_state = implementing`, Stage row `cancelled(pause)` and effect `cancel_stage`; `resume` returns to `implementing` with a fresh Stage, budget unchanged | N/A |
| Accept undo | `in_review` + `accepted` | `accept_pending`, `undo_expires_at = now + limits.undo_accept_ms`, no Integration effect; `undone` before expiry → `in_review`; after `undo_expired` → `integrating` (`released` for bootstrap) | N/A |
| Handler throws | effect executor runs a failing handler | Row `failed` with the message; the next effect still runs; applyEvent is unaffected | Logged at error level |
| Boot recovery | rows in `starting`/`running`; effects `pending` | Stages `failed(restart)` then retry policy; pending effects re-executed; `start_stage` whose Stage is no longer `starting` marked `done` without launching | N/A |
| Sleep | monotonic vs wall delta grows by > 60 s between ticks | Every running deadline extended by the gap; one `back_online` effect per affected Project; no deadline fires because of the gap | N/A |

</frozen-after-approval>

## Code Map

- `src/core/domain/errors.ts` -- `AntipodError` base; add `InvalidTransitionError` only if needed internally (public API never throws on bad pairs)
- `src/core/ports/clock.ts` -- `Clock` (`monotonicMs`, `now`); `src/app/clock.ts` implements it. Reuse, do not change
- `src/adapters/sqlite/{db,migrate}.ts`, `migrations/{index,0001-settings}.ts` -- `openDatabase`, `migrate`, `Migration {id,name,sql}`; append `0002` to `migrations` array
- `src/app/daemon.ts` -- `bootDaemon` opens db and migrates; add Coordinator construction, boot recovery and executor start after `migrate`, stop them in `stop()`
- `src/app/config.ts` -- strict zod config; add `roles.<role>.{timeout_ms,retries,max_turns}` with config-defaults values
- `.dependency-cruiser.cjs` -- layering rules already allow `core/coordinator → ports → domain`; no change
- `test/helpers/home.ts`, `test/setup.ts` -- `createTempHome`; tests open a file-backed db under it
- Spine AD-3 state diagram and Rule, AD-4 retry policy, AD-16 ids, AD-18 recovery -- the normative source for every pair in the transitions table

## Tasks & Acceptance

**Execution:**
- [x] `src/core/domain/ids.ts`, `src/core/domain/task.ts`, `src/core/domain/stage.ts`, `src/core/domain/events.ts`, `src/core/domain/effects.ts` -- ULID generator (`node:crypto`); zod schemas and types for `TaskState` (every state in AD-3), `Task` row, `Project` row (`id`, `name`, `paused_at`), `Stage` row (`status`: starting|running|succeeded|failed|cancelled, `reason`, `attempt`, `role`), the `Event` discriminated union (diagram + generic + `stage_started`, `stage_failed`, `budget_raised`, `undo_expired`) and the `Effect` union (`start_stage`, `cancel_stage`, `run_test_step`, `integrate`, `run_release`, `back_online`, plus `notify` with a `kind` string for later cards) -- domain vocabulary
- [x] `src/core/ports/store.ts` -- synchronous `Store` port: `transaction<T>(fn)`, project/task/stage CRUD, `appendStageEvent`, `insertEffect`, `pendingEffects`, `markEffect(id, status, error?)`, `stagesInStatus`, `activeProjects` -- the only data access the core uses
- [x] `src/core/coordinator/transitions.ts` -- pure `transition(task, stage, event, ctx) → Outcome` where `Outcome` is `{next, patch, effects, derived?}` or `{ignored: 'invalid'|'stale'}`; table keyed by `(state, event.type)`; budget causes, undo windows, `resume_state`, `stuck_reason`, `review_round`, bootstrap `released` shortcut -- the FSM
- [x] `src/core/coordinator/coordinator.ts` -- serial queue (promise chain), `applyEvent` in `store.transaction`: load Task, stale check, run `transition`, write patch, `stage_events`, `stages` row for `start_stage`, `effects` rows, apply derived events in the same transaction; notify executor after commit -- AD-3 commit first
- [x] `src/core/coordinator/effects.ts` -- `EffectExecutor` with `register(kind, handler)`, `drain()` in insertion order, skip rows already `done`, mark `done`/`failed`, `no_handler` failure -- act second
- [x] `src/core/coordinator/recovery.ts` -- `recover(store, coordinator)`: mark `starting`/`running` Stages `failed(restart)` by applying `stage_failed` events, mark orphaned `start_stage` effects `done`, then drain -- AD-18
- [x] `src/core/coordinator/deadlines.ts` -- `Deadlines(clock)`: `set(id, dueInMs, onFire)`, `clear(id)`, `tick()`; tracks `wall − monotonic` drift and on > 60 s shifts every deadline and reports `{gapMs}` so the Coordinator queues `back_online` -- sleep-aware clock
- [x] `src/adapters/sqlite/migrations/0002-coordinator.ts`, `src/adapters/sqlite/store.ts` -- STRICT tables `projects`, `tasks` (state, kind, task_no, project_id, current_stage_id, budget_used, budget_limit, review_round, resume_state, stuck_reason, waiting_reason, undo_expires_at, config_sha, timestamps), `stages`, `stage_events` (append-only, `applied|ignored`, `ignore_reason`), `effects` (effect_id PK, kind, payload JSON, status, error, timestamps); `SqliteStore implements Store` with prepared statements -- persistence
- [x] `src/app/config.ts`, `src/app/daemon.ts` -- `roles` config section; wire `SqliteStore`, `Coordinator`, `EffectExecutor` (handlers: `back_online` logs for now), `Deadlines` ticking every second; run `recover` at boot; stop ticking in `stop()` -- composition
- [x] `test/core/coordinator/transitions.test.ts` -- table-driven: for every `(state, event.type)` pair assert either the expected `next` or `ignored(invalid)`, with no pair left unlisted; budget and undo cases -- proof of the FSM
- [x] `test/core/coordinator/{coordinator,effects,recovery,deadlines}.test.ts`, `test/adapters/sqlite/store.test.ts` -- one test per matrix row against file-backed SQLite and a fake `Clock` -- proof of the pipeline

**Acceptance Criteria:**
- Given a `queued` Task, when `scheduler_start` is applied and the process is killed before the executor runs, then on next boot the `stages` row is `failed(restart)` and a new attempt's `start_stage` effect is pending with `budget_used` still 1.
- Given two `applyEvent` calls queued concurrently for one Task, when they resolve, then `stage_events` holds them in call order and the second saw the first's state.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- `transition(task, stage, event, ctx)` is pure; `ctx` supplies `now`, `newId`, `retriesFor`, `limits` and `nextTaskNo`. `Outcome` is `{next, patch, effects, stageUpdate?, startStage?, derived}` or `{ignored}`: `stageUpdate` settles the current `stages` row (`running` on `stage_started`, `succeeded` on a Stage result, `failed(<reason>)` on `stage_failed`, `cancelled(<cause>)` when a generic event leaves a Stage state, with a `cancel_stage` effect), `startStage` is the row the Coordinator inserts as `starting`.
- Creation (`new_draft`, `bootstrap_created`) is `Coordinator.createTask`, not an `Event`: there is no Task to apply it to. Both are logged as `stage_events` rows with `from_state = null`.
- `testing` is tracked as a `stages` row with role `test` so `test_passed`/`test_failed` carry a `stage_id` (AD-3 "every Stage and step event carries `stage_id`") and a crash during the test step recovers like a Stage. Roles without a `roles.<role>` config entry (`test`) use `DEFAULT_STAGE_RETRIES = 2`.
- Budget check happens before the increment: a counting entry with `budget_used >= budget_limit` enters `implementing` without a Stage and derives `budget_spent` → `triage` in the same transaction, so exactly `budget_limit` Implementer laps run.
- `undone` after `undo_expires_at` is `ignored(invalid)`; the `undo_expired` scan is story 1-3.
- Recovery marks the pending launch effects of a Stage `done` before failing it, and the daemon attaches the executor's commit hook only after `recover`, so an orphaned launch can never run.
- `Deadlines.tick` detects sleep as a wall-clock gap between ticks over 60 s and shifts deadlines by the monotonic advance during that gap (equal to the gap if the platform's monotonic clock runs through sleep, nil if it stops). Either way no deadline fires because of the sleep; drift-only detection would miss a platform whose monotonic clock keeps running.
- The `effects` queue is ordered by `effect_id`; `ulid()` is monotonic within the process so ids sort in minting order.
- Review pass 1 applied 11 patches (see Review Triage Log): `BootOptions.clock` and `Daemon.tick()` for testing the sleep wiring; `Coordinator.idle()` and `EffectExecutor.settle()` so `stop()` never starts a fresh drain; try/catch around deadline callbacks; `undo_expired` is `ignored(invalid)` while the window is open or unset; `stage_started` needs a `starting` Stage; `stage_retries_exhausted` needs the current Stage live or `failed` (the derived event arrives after its row is settled); creation inputs are parsed through the domain schemas before insert.

## Spec Change Log

## Review Triage Log

Pass 1 (blind hunter BH, edge-case hunter ECH, verification gap VG):

| # | Source | Finding | Verdict | Evidence | Route |
|---|--------|---------|---------|----------|-------|
| 1 | VG | Daemon post-commit drain hook is never observed; the daemon test drains by hand | medium | Deleting the `onEffectsCommitted` line in `daemon.ts` keeps every test green; in production effects would sit `pending` until stop or next boot | patch |
| 2 | VG | Sleep tick → `backOnline` wiring in the daemon has no test | medium | Only the two halves are unit-tested; inverting the `sleep` check stays green | patch |
| 3 | VG | Recovery's retirement of `run_test_step` launches is untested | medium | Dropping the `run_test_step` branch in `recovery.ts` passes all five recovery tests | patch |
| 4 | VG | `started_at` on `stage_started` is never asserted | low | Replacing the ternary with `ended_at` only still passes; direct one-line assertion | patch |
| 5 | VG/BH/ECH | `stop()` runs a full fresh drain (would launch Stages at SIGTERM once handlers exist) and never waits for the Coordinator queue, so a queued transaction can hit a closed database | medium | `drain()` starts a new pass when none is in flight; `#tail` is never awaited in `stop()` | patch |
| 6 | BH | Recovery replays only `pending` effects while AD-18 says every row not `done` | low | Frozen matrix row says `effects pending`; the spec narrowed the spine. Owner decision, settled through correct-course if the spine wording is meant literally | defer |
| 7 | BH/ECH | A throwing deadline `onFire` escapes `Deadlines.tick` and the bare `setInterval`, crashing the daemon | medium | No try/catch at either level; no callbacks exist yet but 1-3 and 1-7 add them | patch |
| 8 | BH/ECH | `undo_expired` has no window guard, so an early or duplicate event integrates or cancels while the Owner can still undo | medium | `undone` is guarded by `undoStillOpen`; the mirror check is absent | patch |
| 9 | BH/ECH | One unparseable `effects` payload makes `pendingEffects()` throw and wedges drain and recovery | low | Real, but reachable only by hand edits or running older code on a newer row; the fix adds a per-row failure branch | reject |
| 10 | BH | `intake.retries` and `roles.intake.retries` are two keys for one value | false | config-defaults.md defines both: Intake conversation retries (`👀` → `❌`) versus Stage retries | reject |
| 11 | BH/ECH | `resume` or `undone` into `in_review` increments `review_round` without a new Review | maybe-false | AD-16 says "exactly on each entry to `in_review`" and AD-10 retires the keyboard on each entry, so the literal spine agrees with the code; if the Owner means a round per Review delivery this is medium | defer |
| 12 | ECH | Pause, cancel or amendment during `integrating`/`merged` leaves the pending `integrate`/`run_release` running, and `resume` queues a second one | medium | `enter('integrating')` always pushes `integrate`; the spine has no cancel for Integration. The fix is the 1-12 handler re-checking Task state and effect idempotency, or a new effect; not a trivial patch | defer |
| 13 | BH | `back_online` goes to every Project with an ACTIVE Task, not only affected ones | false | Frozen Decisions say "one `back_online` effect per Project with an `ACTIVE` Task" | reject |
| 14 | BH | `tasks.state` and `resume_state` lack a CHECK constraint | low | zod validates on read; migration 0002 is committed (AD-23) so the fix is a new migration for no user-visible gain | reject |
| 15 | BH/ECH | `ulid()` stamps `Date.now()` rather than the Clock; a wall-clock step back can break id order | low | Ordering only matters within one process where the counter keeps ids monotonic; no everyday harm | reject |
| 16 | BH | `stage_retries_exhausted` is accepted from a Stage state whose Stage is no longer live | low | AD-3 says "whose current Stage is running"; one condition fixes it | patch |
| 17 | BH | Spec status `in-review` while sprint-status says `in-progress` | false | Sprint sync to `review`/`done` happens in step-05 by design | reject |
| 18 | BH | Dead exports: `GENERIC_EVENT_TYPES`, `EFFECT_KINDS`, `sequentialIds`, `advanceMonotonic` | low | No consumer in `src/` or `test/`; deletion is direct | patch |
| 19 | BH | Test gaps: `ProjectNotFoundError`, `notify()` error path, IMMEDIATE transaction, tick cleared on stop | low | `ProjectNotFoundError` test is direct and added; the other three need plumbing for rare paths | patch (first only) |
| 20 | BH | `#update` and `IN (...)` queries prepare a statement per call | low | Milliseconds at this scale; no user-visible effect | reject |
| 21 | ECH | `stage_started` for a Stage already `running` overwrites `started_at` | low | Duplicate event from an adapter bug; one status check fixes it | patch |
| 22 | ECH | A hung handler blocks the executor forever | low | Handlers arrive in later stories with their own timeouts (AD-4); executor-level bound is their call | reject |
| 23 | ECH | `createTask` with `budget_limit <= 0` or `createProject` with an empty name inserts a row that fails zod on every read | low | Inputs unchecked; parsing through the domain schema before insert is one line each | patch |
| 24 | ECH | Sleep shift includes the awake tick interval and wake latency | low | At most about one second on a sleep of a minute or more | reject |
| 25 | ECH | Sleep is detected by wall gap between ticks, not by wall−monotonic drift as the task text says; a 61 s event-loop stall counts as sleep | low | True. On Node 24 the monotonic clock runs through sleep (libuv uses continuous time), so drift never grows and the drift trigger would miss every real sleep; the matrix's expected behaviour holds under both. Surfaced to the Owner in the walkthrough | reject |

## Design Notes

`transition` is pure and synchronous so the table test needs no database. Derived events (`stage_retries_exhausted`, `budget_spent`) are produced by `transition` and applied by `applyEvent` inside the same transaction, so a Task never commits in an intermediate state. The effects executor is a core module driven by ports; adapters never see `effects` rows.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0
- `pnpm test test/core/coordinator/transitions.test.ts` -- expected: one assertion per `(state, event)` pair, all green
