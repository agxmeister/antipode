---
title: 'Scheduler gates'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: '29846c74b8728ee079994da699fb1b92f61a6d24'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-antipod/config-defaults.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing starts a `queued` Task or closes an undo window yet. Story 1-2 accepts `scheduler_start`, `deps_*` and `undo_expired` but nobody emits them, so CAP-15 (dependencies, concurrency), CAP-16 (Review backpressure) and CAP-17 (usage hold) have no enforcement.

**Approach:** Add `core/coordinator/scheduler.ts`: a tick that reads only the database and the latest `WindowReader` reading, runs the AD-11 gates in fixed order over `queued` Tasks, stores the failing gate as `tasks.waiting_reason` or emits `scheduler_start`, moves Tasks between `queued` and `waiting_on_dependencies`, and emits `undo_expired`. A launch gate re-checks the usage window before each `start_stage` effect and holds it pending while the window is full. Migration 0003 adds `task_dependencies`.

## Boundaries & Constraints

**Always:** Gate order exactly AD-11: Project pause → usage window → concurrency (`limits.concurrency`, counting `implementing, testing, validating, triage, evidencing, verifying, integrating`) → backpressure (`limits.open_reviews`, counting `in_review, accept_pending` across all Projects) → dependencies → bootstrap accepted (skipped for `kind = bootstrap`). Queued Tasks are evaluated oldest first (`created_at`, `id`), one at a time through the Coordinator queue, so a start counts against the next Task's concurrency check. Every state change is a Coordinator event; `waiting_reason` is written only through a Coordinator method that adds no `stage_events` row and changes nothing when the value is unchanged. `waiting_reason` values: `paused`, `usage_window`, `concurrency`, `open_reviews`, `bootstrap`. Usage is held when either window's `utilization >= usage.pause_at_percent`; running Stages are never cancelled. `src/core/` imports only `node:*` and `zod`.

**Decisions:** Dependency "merged to `main`" means the dependency Task is `merged`, `release_failed` or `released` with kind `feature`; a `cancelled` dependency emits `deps_unsatisfiable` (reason names the Task number). The bootstrap gate passes when the Project has a `bootstrap` Task in `released`. The `WindowReader` port returns AD-12's shape or `null`; the scheduler polls it every `usage.poll_interval_ms` and keeps only the last reading in memory; `null` (or no reading yet) leaves the gate open, since the estimator fallback is story 1-16. The launch gate applies to `start_stage` only (the `test` step uses no Claude usage): a held effect stays `pending`, is skipped by the current drain, and the Task gets `waiting_reason = usage_window`; the tick clears it and notifies the executor when the window reopens. Notices are `notify` effects: `usage_window_wait` with `resets_at` once per `(task_id, resets_at)`, and `usage_window_resumed` once after a hold ends; templates come with Telegram. The daemon ticks the scheduler on the existing 1 s interval.

**Never:** No exclusive-capability hint gate (needs Recipe and `capability_leases`, story 1-6). No `anthropic-usage` adapter or estimator (1-16). No Telegram copy. No writer of `task_dependencies` beyond a Store method (Intake records them in 1-8). Never edit migrations 0001–0002. Never cancel or kill a running Stage for any gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Start | one `queued` feature Task, bootstrap `released`, all gates open | `scheduler_start` applied, Task `implementing` | N/A |
| Concurrency | cap 2, one running, three `queued` | oldest starts; other two `waiting_reason = concurrency` | N/A |
| Backpressure | 3 Tasks in `in_review`/`accept_pending` | no start; `waiting_reason = open_reviews`; no notice | N/A |
| Gate order | Project paused and window full | `waiting_reason = paused` | N/A |
| Dependency | dep `implementing` | `deps_unmerged` → `waiting_on_dependencies`; dep reaches `merged` → `deps_merged` → `queued`; dep `cancelled` → `deps_unsatisfiable` → `stuck` | N/A |
| Bootstrap | feature Task, bootstrap `in_review` | `waiting_reason = bootstrap`; a `queued` bootstrap Task starts | N/A |
| Usage hold at start | five-hour 90%, threshold 85 | `waiting_reason = usage_window`, one `usage_window_wait` notify per `resets_at` across ticks | N/A |
| Launch hold | Task enters `testing → validating` while window full | `start_stage` stays `pending`, Stage `starting`, other effects still drain; window drops → launched, one `usage_window_resumed` | N/A |
| Unreadable window | `WindowReader` returns `null` or throws | gate open; a throw is logged at warn | Never fails the tick |
| Undo expiry | `accept_pending`, `undo_expires_at` passed | `undo_expired` applied once | Duplicate is `ignored(invalid)` |

</frozen-after-approval>

## Code Map

- `src/core/coordinator/coordinator.ts` -- `applyEvent`, `#enqueue`; add `setWaitingReason(taskId, reason | null)` and a `notifyOnce` helper (or equivalent) that inserts a `notify` effect in one transaction; reuse `#insertEffect`
- `src/core/coordinator/transitions.ts` -- `enter()` already clears `waiting_reason` on leaving `queued`; table already has `deps_unmerged`, `deps_merged`, `scheduler_start`, `undo_expired`, generic `deps_unsatisfiable`. Do not change
- `src/core/coordinator/effects.ts` -- `EffectExecutor.#runOne`; add an optional launch guard so a guarded kind can return "held" and stay `pending` for this drain
- `src/core/coordinator/recovery.ts` -- treats `starting` Stages as crashed at boot; a held launch across a restart retries as `restart` (acceptable, see Design Notes). Do not change
- `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts` -- add `insertDependency`, `dependenciesOf(taskId) → Task[]`, `countTasksInStates`, `queuedTasks()` ordered, `bootstrapReleased(projectId)`, `pendingNotify(taskId, notice_kind, key)` lookup; prepared statements, zod-validated rows
- `src/adapters/sqlite/migrations/index.ts` -- append `migration0003`
- `src/app/daemon.ts` -- `onTick` runs `deadlines.tick()`; add scheduler tick there and register the launch guard; nothing registers `start_stage` yet (1-7)
- `src/app/config.ts` -- `limits.concurrency`, `limits.open_reviews`, `usage.pause_at_percent`, `usage.poll_interval_ms` already exist; no change
- `test/helpers/{store,clock}.ts` -- `openTestStore`, `fakeClock`; reuse

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports/window-reader.ts` -- `WindowReader { read(): Promise<UsageReading | null> }` and zod `usageReadingSchema` (`five_hour`, `weekly`: `{utilization, resets_at}`) -- AD-12 seam
- [x] `src/adapters/sqlite/migrations/0003-dependencies.ts` -- STRICT `task_dependencies (task_id, depends_on_task_id, PK both, FKs to tasks)` -- CAP-15 record
- [x] `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts` -- methods listed in the Code Map -- data the gates read
- [x] `src/core/coordinator/coordinator.ts` -- `setWaitingReason`, deduplicated `notify` insertion -- only writer of Task columns
- [x] `src/core/coordinator/scheduler.ts` -- `Scheduler({store, coordinator, executor, windowReader, clock, policy, log})` with `tick()`: refresh reading when due, emit `undo_expired`, resolve `waiting_on_dependencies` Tasks, run gates over queued Tasks, release launch holds; exported pure `evaluateGates(...)` returning the first failing gate; `launchGuard` for the executor -- AD-11
- [x] `src/core/coordinator/effects.ts` -- `setGuard(kinds, guard)`: a guard returning `held` leaves the row `pending` and skips it for the rest of the drain -- launch hold
- [x] `src/app/daemon.ts` -- construct `Scheduler` with a `WindowReader` that returns `null` (`BootOptions.windowReader` for tests), tick it after `deadlines.tick()`, await it in `stop()` -- composition
- [x] `test/core/coordinator/scheduler.test.ts` -- one test per matrix row against file-backed SQLite, fake clock and fake `WindowReader`; a table test of gate order -- proof
- [x] `test/adapters/sqlite/store.test.ts`, `test/core/coordinator/effects.test.ts`, `test/app/daemon.test.ts` -- new Store methods, guard hold/release, daemon tick starts a queued bootstrap Task -- proof

**Acceptance Criteria:**
- Given a registered Project with a `queued` bootstrap Task, when the daemon ticks once, then the Task is `implementing` with a `start_stage` effect.
- Given ten ticks with an unchanged held Task, when `stage_events` is read, then no rows were added by the ticks.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- Store lookup for once-only notices is `latestNotify(taskId, notice_kind, key?)` (any effect status, not only `pending`), so a notice already sent still deduplicates; the Code Map called it `pendingNotify`. `notifyOnce` stores the key as `payload.key`.
- `usage_window_resumed` is keyed by the `resets_at` of the latest `usage_window_wait` of the Task and is sent only when a wait was sent; it fires for a queued Task whose gate moves off `usage_window` as well as for a released launch hold.
- With both windows full the hold's `resets_at` is the later reset. A reading that fails `usageReadingSchema` is treated like a throw (warn, gate open).
- `EffectExecutor.drain` now yields once before running, so a guard or handler that synchronously calls `notify()` joins the drain instead of starting a nested one (found by the guard test). A guard that throws lets the effect run and logs `effect_guard_failed`.
- The launch guard returns `run` when the effect's Stage is no longer the Task's `starting` Stage, so a cancelled launch reaches its handler instead of being held.
- The daemon registers a log-only `notify` handler (like `back_online`) until Telegram templates exist; `Daemon.tick()` now returns the scheduler tick promise, and `stop()` awaits the tick in flight.
- Review pass 1 patches (see Review Triage Log): held launches are released by waiting for the in-flight drain and starting a fresh one; the launch guard polls the reader when it never has, so boot recovery's drain is gated; reads time out after `usage.poll_interval_ms`; `usageHold` ignores windows whose `resets_at` has passed; `usage_window_resumed` goes out only when no hold remains, for any Task with an unanswered wait notice (also covers a Task paused during the hold); `task_dependencies` has `CHECK (task_id <> depends_on_task_id)` and `insertDependency` uses `ON CONFLICT DO NOTHING`, since `INSERT OR IGNORE` would silently drop CHECK violations.

## Spec Change Log

## Review Triage Log

Pass 1 (blind hunter BH, edge-case hunter ECH, verification gap VG):

| # | Source | Finding | Verdict | Evidence | Route |
|---|--------|---------|---------|----------|-------|
| 1 | BH/ECH | Launch-hold release can miss its wake-up and strand a held `start_stage` | medium | `notify()` during a drain only sets `#again`; the next pass reuses `held`, and `waiting_reason` is already cleared so no later tick notifies | patch |
| 2 | BH/ECH | Boot recovery's drain runs launches before the first usage reading | medium | `recover()` drains before the first tick; `#reading` is null so `launchGuard` returns `run` | patch |
| 3 | BH/ECH | A hung `WindowReader.read()` stalls every tick and hangs `stop()` | medium | No timeout; `tick()` joins the in-flight run and `stop()` awaits `scheduler.idle()` | patch |
| 4 | BH/ECH | A window whose `resets_at` has passed still holds until the next poll | low | `usageHold` ignores `resets_at`; one-line fix | patch |
| 5 | BH/ECH/VG | `usage_window_resumed` sent while the Task still waits on another gate with the window full | medium | Condition is `gate !== 'usage_window'`, true for `paused`/`concurrency`/`open_reviews`/`bootstrap` | patch |
| 6 | BH/ECH | Self-dependency waits forever | low | No CHECK in uncommitted migration 0003; one-line constraint | patch |
| 7 | BH/ECH | Dependency cycles and dependencies on a bootstrap Task are never satisfiable | medium | Real, but no writer exists until Intake records dependencies | defer |
| 8 | BH | Missing rationale on `MERGED_STATES`/`isMergedToMain` | low | Direct doc fix | patch |
| 9 | VG | Daemon's `setGuard` wiring is untested | medium | Deleting the line keeps every test green | patch |
| 10 | VG | SIGHUP reload never shown to reach the scheduler policy | low | Reload test reads `daemon.config()` only | patch |
| 11 | VG | `stop()` with a tick in flight is untested | low | Removing `await scheduler.idle()` keeps tests green | patch |
| 12 | ECH | One throwing Task aborts the whole step every tick | low | Needs a DB error on one row; per-Task try/catch adds branches for an unlikely case | reject |
| 13 | ECH | Guard race: Task cancelled between check and `setWaitingReason` keeps `usage_window` | low | Narrow await window; cancelled Tasks are not shown with waiting reasons | reject |
| 14 | BH | Wait notice without a resumed notice when the held Task is paused or cancelled | low | No resumed is the right copy for a cancelled Task; paused-then-resumed re-enters the hold | reject |
| 15 | BH | Restart during a hold costs a Stage retry | low | Accepted in Design Notes before implementation | reject |
| 16 | BH | Held `start_stage` breaks per-Task effect order | false | Frozen Decisions require other effects to keep draining | reject |
| 17 | BH | Log-only `notify` handler consumes notices before Telegram exists | false | Without it rows fail `no_handler`, which is terminal too; neither replays | reject |
| 18 | BH | Production daemon has no usage gate and does not say so | false | Frozen Decisions: no reading leaves the gate open until story 1-16 | reject |
| 19 | BH | `countTasksInStates` prepares per call; `latestNotify` scans `effects` | low | Milliseconds at this scale; same pattern rejected in 1-2 (#20) | reject |
| 20 | BH | `setWaitingReason`/`notifyOnce` lack direct Coordinator tests | low | Covered through scheduler tests; no named harm | reject |
| 21 | ECH | A stuck dependency leaves the dependent silent | false | `/status` shows `Queued · after #n` (EXPERIENCE.md); the dependency's own Stuck card is the notice | reject |
| 22 | ECH | Launch-gate claim fails before the first poll | medium | Same defect as #2 | patch (with #2) |

## Design Notes

The tick is async only for the `WindowReader` call; gate evaluation is synchronous over a fresh read of the database per Task, so it is a pure function of stored state plus one reading. A held `start_stage` keeps its Stage `starting`; if the daemon restarts during a hold, recovery fails it `restart` and the retry launches a new attempt, costing one AD-4 retry but never budget.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0
- `pnpm test test/core/coordinator/scheduler.test.ts` -- expected: one green test per matrix row
