---
title: 'Step runners'
type: 'feature'
created: '2026-11-13'
status: 'done'
baseline_commit: '99c651468288cc14cb799c95ca176ab63a4c7024'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Recipe step cannot run anywhere yet: there is no `StepRunner`, no lease for an exclusive host tool, and no way for a Stage to ask the daemon for a step, so build, test, Evidence, Demo and Release have nothing to execute on (CAP-2, CAP-5; AD-6, AD-7, AD-14, AD-19).

**Approach:** Add a `StepRunner` port with a `podman` and a `host` adapter honouring one step contract, `capability_leases` with fail-fast `capability_busy`, an app `Steps` service that resolves a step from the pinned Recipe and prepares its directories, Preview Data and named secrets, and the `$ANTIPOD_HOME/run/antipod.sock` server with the `antipod step <name>` client.

## Boundaries & Constraints

**Always:**
- The step definition comes from the Recipe at `tasks.config_sha` read from the bare clone (AD-22), validated with `validateRecipeText`.
- One contract for both Runners: `cwd` = Task worktree `data/worktrees/<project>/<task_no>`; env = only the step's named secrets plus `ANTIPOD_OUT` (`data/steps/<step_run_id>/out/`), `ANTIPOD_DATA` (`<worktree>/.antipod-data/`), `ANTIPOD_PRIOR`, `ANTIPOD_TASK`; stdout and stderr appended to `data/steps/<step_run_id>/log`; command run as `sh -c <cmd>`.
- Container: `podman run --rm`, bind-mounts at the same absolute paths of the worktree, `ANTIPOD_OUT` and `ANTIPOD_DATA` read-write and `ANTIPOD_PRIOR` read-only, nothing else; container named `antipod-<step_run_id>` and labelled with the instance.
- Host: env is the contract plus `PATH`, `HOME`, `LANG`, `TMPDIR` only; the process gets its own process group; the capability resolves through `config.capabilities` with `$NAME` references expanded from `secrets/antipod.env`; an unmapped capability fails the step before spawning.
- Secret values come from `secrets/<project>.env`; a named secret missing there fails the step before spawning; Stage agents never get values.
- Preview Data: before the first step of a Task, `ANTIPOD_DATA` is created and, when the Recipe has `fixtures`, seeded once from that directory of the worktree.
- Exclusive host steps acquire `capability_leases {capability, task_id, step_run_id, acquired_at}` in one transaction before spawning and release on exit; any existing lease → result `capability_busy` without spawning. Boot recovery kills the process group of every leased step (pid file in its step dir), removes labelled containers, then deletes all leases.
- Timeout from the step's `timeout`: host SIGTERM to the group, SIGKILL after 10 s; container `podman stop -t 10`; result `timeout`.
- The socket accepts a request only for a Stage that is live and `tasks.current_stage_id`; a dropped client connection stops its step.

**Never:**
- No Coordinator events or transitions for step results, no Stage launch or `ANTIPOD_STAGE_ID` export from Stages (1-7), no Coordinator-run `test`/`release` wiring (1-9, 1-12), no `ANTIPOD_PRIOR` population (1-10), no `antipod doctor`.
- No adapter imports another adapter; nothing outside `adapters/host/` and `app/` reads the capability map (AD-19).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Container step | `build: {runner: container, image: busybox, cmd: "echo hi > $ANTIPOD_OUT/a"}` | exit 0, `out/a` = `hi`, log has output | — |
| Host step | `runner: host, capability: echoer` mapped in config | exit code of `cmd`, env has only contract + named secrets | — |
| Non-zero exit | `cmd: exit 3` | `{outcome: exited, exit_code: 3}` | — |
| Timeout | `timeout: 1s`, `cmd: sleep 30` | `outcome: timeout` within ~11 s | process/container gone |
| Busy | `exclusive: true`, lease held by Task B | `outcome: capability_busy`, nothing spawned | — |
| Unknown step | `antipod step nope` | refused: `no step nope in the Recipe` | client exit 2 |
| Missing secret | step names `API_KEY`, not in `<project>.env` | refused: `secret API_KEY is not set` | client exit 2 |
| Unmapped capability | `capability: unity-editor`, not in config | refused: `capability unity-editor is not configured on this host` | client exit 2 |
| Stale Stage | `stage_id` not live or not current | refused: `stage is not running` | client exit 2 |
| Fixtures | `fixtures: seed`, second step of the Task | `ANTIPOD_DATA` holds `seed/*` once; edits by step 1 survive | — |
| Client | `antipod step build` inside a Stage | prints `log: <path>` and `out: <path>`; exits with the step's code; `capability_busy` exits 75; `timeout` exits 124 | daemon down: exit 2 `daemon not running` |

**Owner decisions (2026-11-13):**
- Step runs are rows of a new `step_runs` table (`id` = step run id, `task_id`, `stage_id` nullable, `step`, `runner`, `status` `running|finished|failed`, `outcome`, `exit_code`, `reason`, `started_at`, `ended_at`); the log and `out/` live under `data/steps/<id>/`. Inserted before spawning, updated on exit; boot recovery marks `running` rows `failed` with reason `restart`. The spine's AD-2 table list is amended through `bmad-correct-course` before implementation.
- A host step reaches its capability through env `ANTIPOD_CAPABILITY`, the mapped command with `$NAME` references expanded from `secrets/antipod.env`.
- `ANTIPOD_TASK` is the Owner-facing Task number (`12`).
- The AD-11 exclusive-capability hint gate is in this story: registration stores the validated Recipe's exclusive capability names on `projects.exclusive_capabilities` (JSON array, refreshed on re-register); the scheduler's last gate holds a queued Task with new `waiting_reason` `capability` while one of those is leased by a Task of another Project.
- The full spec is kept despite its size (~2,900 tokens).

</frozen-after-approval>

## Code Map

- `src/core/ports/step-runner.ts` (new) -- `StepRunner.run(spec, signal) → StepResult {outcome: exited|timeout|capability_busy, exit_code}`; `StepSpec` = step run id, cmd, image or resolved capability, cwd, env, mounts, log path, timeout ms
- `src/adapters/podman/runner.ts` (new) -- `podman run` via `spawn`; `removeOrphans(instanceLabel)` for recovery
- `src/adapters/host/runner.ts` (new) -- detached spawn, pid file, leases through an injected `Pick<Store, 'acquireLease'|'releaseLease'>`; `killLeased(leases, stepsDir)` for recovery; capability map from config
- `src/adapters/sqlite/migrations/0006-steps.ts` (new; append to `index.ts`) -- `step_runs`, `capability_leases` (`capability` primary key, `step_run_id` references `step_runs`), `projects.exclusive_capabilities TEXT NOT NULL DEFAULT '[]'`; never edit 0001–0005
- `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts` -- `insertStepRun`, `finishStepRun`, `stepRunsInStatus`; `acquireLease(lease) → boolean` (one transaction), `releaseLease(stepRunId)`, `listLeases()`, `clearLeases()`, `capabilityLeasedByOtherProject(projectId, names)`; `Project.exclusive_capabilities`
- `src/core/domain/task.ts:49` -- add `capability` to `WAITING_REASONS`; `src/core/coordinator/scheduler.ts:64,283` -- `evaluateGates` last gate `capabilityBusy`
- `src/app/registration.ts` -- set `exclusive_capabilities` from the Recipe's `exclusive: true` host steps on register and re-register
- `src/core/domain/recipe.ts` -- reuse `RecipeStep`, `parseDuration` helper for `timeout`
- `src/app/recipe-file.ts` -- reuse `validateRecipeText`; `src/app/secrets.ts` -- reuse `parseEnvFile`, add `readProjectSecrets(dir, project)`
- `src/core/ports/repo.ts` -- reuse `readFile(name, sha, RECIPE_FILE)`; worktree path is `data/worktrees/<name>/<task_no>` (`adapters/git/repo.ts:102`)
- `src/app/steps.ts` (new) -- `Steps.run({stageId?, taskId, step, signal})`: resolve, prepare dirs, Preview Data, secrets, pick Runner, return result + paths
- `src/app/step-socket.ts` (new) -- `net` server on `run/antipod.sock` (mode 600), newline JSON `{stage_id, step}` → `{outcome, exit_code, log, out} | {refused}`
- `src/app/cli.ts` -- `step <name>` client reading `ANTIPOD_HOME`, `ANTIPOD_STAGE_ID`
- `src/app/daemon.ts:184-200` -- build runners and `Steps`, start the socket after recovery, lease recovery before `recover()`, close the socket first in `stop()` and abort running steps
- `test/helpers/home.ts`, `test/helpers/git.ts`, `test/helpers/store.ts` -- reuse temp home, temp remote, store fakes

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/sqlite/migrations/0006-steps.ts`, `index.ts`, `src/core/domain/task.ts`, `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts`, `src/core/coordinator/coordinator.ts` -- step runs, leases, Project capabilities -- AD-2, AD-7
- [x] `src/core/coordinator/scheduler.ts`, `src/app/registration.ts` -- hint gate and its data -- AD-11
- [x] `src/core/ports/step-runner.ts`, `src/core/domain/recipe.ts` -- port, duration parsing -- one contract
- [x] `src/adapters/podman/runner.ts`, `src/adapters/host/runner.ts` -- the two Runners and their recovery helpers -- CAP-2
- [x] `src/app/secrets.ts`, `src/app/steps.ts` -- resolution, Preview Data, secrets by name -- CAP-5
- [x] `src/app/step-socket.ts`, `src/app/cli.ts`, `src/app/daemon.ts` -- socket, client, wiring, recovery -- AD-6, AD-18
- [x] `test/adapters/podman/runner.test.ts` (busybox, skipped with a reason when `podman` is unavailable), `test/adapters/host/runner.test.ts`, `test/app/steps.test.ts`, `test/app/step-socket.test.ts`, `test/adapters/sqlite/store.test.ts`, `test/core/coordinator/scheduler.test.ts`, `test/app/registration.test.ts` -- one test per matrix row -- proof

**Acceptance Criteria:**
- Given two Tasks whose host steps name the same exclusive capability, when both run at once, then exactly one spawns and the other returns `capability_busy`; after the first exits the lease row is gone.
- Given a lease left by a killed daemon whose step process still runs, when the daemon boots, then that process group is killed and `capability_leases` is empty.
- Given a step naming `TOKEN_A` with `secrets/<project>.env` holding `TOKEN_A` and `TOKEN_B`, when it runs on either Runner, then its env has `TOKEN_A` and not `TOKEN_B`, and the daemon's own variables are absent.
- Given a queued Task of Project A whose Recipe has exclusive `unity-editor`, leased by a Task of Project B, when the scheduler ticks, then the Task stays queued with `waiting_reason` `capability`; after release it starts.
- Given a step run in `running` when the daemon is killed, when it boots, then the row is `failed` with reason `restart`.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- `ANTIPOD_PRIOR` is `data/prior/<project>/<task_no>/`, created empty and mounted read-only; 1-10 fills it.
- Refusals (unknown step, missing secret, unmapped capability, stale Stage, missing worktree) record no `step_runs` row. A run whose Runner cannot start is `failed` with the error; a run stopped by a dropped client or daemon stop is `failed(aborted)` and answered `step <name> was stopped` (exit 2). `capability_busy` is a `finished` row.
- `StepRunner.refusal()` lets `Steps` ask the host adapter whether a capability is mapped without reading the map itself; the host adapter expands `$NAME`/`${NAME}` from `antipod.env`, leaves `$PATH`, `$HOME`, `$LANG` and `$TMPDIR` for the step's shell when `antipod.env` does not set them, and refuses any other unset reference.
- After a timeout or abort the host Runner SIGKILLs whatever of the group outlived its leader; on a normal exit the group is left alone.
- `.antipod-data` gets a `.gitignore` of `*` when created, so Preview Data is never committed from the worktree.
- Boot recovery kills the process group of every leased step and every host step left `running` (pid file), then clears leases.
- Boot recovery calls `podman` only when a `step_runs` row was left `running` (a container exists only while its run does); a podman failure there is logged, not fatal.
- `outputs` is copied to `ANTIPOD_OUT/<outputs>` (relative path kept).

## Spec Change Log

## Review Triage Log

Pass 1 (2026-11-14). Layers: blind (B), edge-case (E), verification-gap (V).

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| V1 | Post-close group SIGKILL after timeout/abort is untested | medium | Pre-verified: no test has a TERM-ignoring child whose leader dies on TERM; deleting the block passes every test | patch |
| V2 | Concurrent first steps of one Task (seeding dedup) untested | medium | Pre-verified: the only `Promise.all` uses two Tasks; without the map, the second `rename` fails ENOTEMPTY | patch |
| V3 | SIGHUP-reloaded capability map reaching the host Runner untested | medium | Pre-verified: no test changes `capabilities` then resolves one | patch |
| B4+E5+V | `killGroup` rethrows non-ESRCH (EPERM) | medium | `killLeased` runs in `bootDaemon`; a reused pid owned by another user throws EPERM and fails boot; in a timer callback it is an uncaught exception | patch |
| B1+E7 | Failure after `insertStepRun` (e.g. `#copyOutputs`) leaves the row `running` | medium | `steps.ts` only wraps `runner.run`; a `cp` error escapes `run()`, the row stays `running` until restart and the exit code is lost | patch |
| B2+E6 | Recovery kills only leased host steps; non-exclusive host steps survive a crash | medium | Host steps are spawned `detached`; `recoverSteps` reads pid files only for `listLeases()`, so an orphan keeps writing into the worktree while its row is `failed(restart)` | patch |
| B10 | `.antipod-data` inside the worktree is not ignored by git | medium | No exclude handling in `src/`; an Implementer `git add -A` would commit Preview Data | patch |
| B12+E8 | A step that exited normally as the client dropped is recorded `failed(aborted)` | low | `steps.ts` checks `signal.aborted` regardless of the result; the fix is one condition (only when `exit_code` is null) | patch |
| E4 | Capability command referencing `$HOME`/`$PATH` is refused as a missing secret | medium | `resolveCapability` treats every `$NAME` as an `antipod.env` key; `$HOME/bin/unity` is refused | patch |
| B15 | `sprint-status.yaml` `last_updated` format changed | low | Was `DD-MM-YYYY HH:MM`, written as `2026-11-14`; direct correction | patch |
| V-o1+E19 | Projects registered before migration 6 have `[]` until re-registered | medium | Default `'[]'` with no backfill; the hint gate is inert for them, while the lease still enforces exclusivity | defer |
| B3+E5 | `killLeased` trusts a pid file that may name a reused pid after a reboot | medium | No start-time or boot-id check; fixing it needs process identity recorded with the pid | defer |
| B5+E3 | `ANTIPOD_CAPABILITY` carries expanded `antipod.env` values, unquoted | false | Owner decision 2026-11-13 specifies this variable with `$NAME` expanded; shell `$NAME` is also unquoted | reject |
| B6+E14 | Socket briefly has umask permissions before `chmod` | false | `run/` is created `0700` and chmodded in `home.ts:42-44`, so no other user can reach the socket | reject |
| B7+E18 | Containers not removed when no row was left `running`; a failed `rm -f` is swallowed | low | Needs both `podman stop` and `rm -f` to fail; a crash always leaves a `running` row | reject |
| B8 | Container user and file ownership unspecified | maybe-false | Podman machine on macOS maps bind mounts to the host user; no failure shown | reject |
| B9 | Container steps cannot run git (the bare clone is not mounted) | false | The frozen intent mounts "nothing else"; this is by design | reject |
| B11+E10 | The `taskId` path skips liveness checks | false | No caller in this story; Coordinator-run steps (1-9, 1-12) decide when to run | reject |
| B13 | Secret names can override `PATH`/`HOME` or podman's env | low | Requires a Recipe secret named like a system variable; unlikely, and the fix adds validation | reject |
| B14 | `db.prepare` on every call in two store methods | low | Cheap in better-sqlite3 with few queued Tasks; no harm shown | reject |
| B16 | No Owner copy for `capability` waiting reason; recovery is log-only | false | No `waiting_reason` copy map exists in `src/` yet (`/status` is a later story); step runs change no Task state here | reject |
| B17 | Assorted missing tests | low | The material ones are covered by the patches (copyOutputs failure, abort); the rest are unlikely paths | reject |
| B18 | `data/steps` and `data/prior` are never cleaned up | low | Slow disk growth; a retention policy is beyond this story's fix size | reject |
| E1 | A timeout above 2^31-1 ms clamps `setTimeout` to 1 ms | low | Needs a timeout of 597h or more; unlikely | reject |
| E2 | Pid-file write failure after spawn orphans the step | low | The directory was just created by the same process; unlikely | reject |
| E9 | A step keeps running after its Stage ends | maybe-false | The Stage's `antipod step` client dies with the Stage, dropping the connection, which aborts the step | reject |
| E11 | `fixtures: .` copies into its own subdirectory | low | Unlikely Recipe value | reject |
| E12 | A repo that tracks `.antipod-data` is never seeded | low | Unlikely | reject |
| E13 | An idle client that never sends a newline hangs `stop()` | low | Only the Owner's own processes can connect (0700 `run/`); `antipod step` writes at once | reject |
| E15 | A long `ANTIPOD_HOME` exceeds `sun_path` | low | The default path is short | reject |
| E16 | `:` or `,` in a mount path breaks `--volume` | low | Unlikely path | reject |
| E17 | Podman's own exit codes 125–127 are reported as the step's exit code | low | Visible in the log; the step still fails | reject |
| E20 | Main changes exclusive capabilities without a re-register | false | The Owner decision refreshes on re-register only; the lease enforces exclusivity | reject |

## Design Notes

Step requests from Stages and, later, Coordinator-run steps go through the same `Steps.run`; the socket is only a transport. A step changes no Task state in this story; how outcomes become events is the flow stories' job (1-9, 1-10, 1-12). Directory prep, Preview Data and secrets sit in `app/steps.ts` so both adapters stay spawn-only and never share code. `outputs`, when declared, is copied from the worktree into `ANTIPOD_OUT` after an exit 0. Stage identification uses `ANTIPOD_STAGE_ID`, which the claude-cli adapter (1-7) must export.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0

**Manual checks (if no CLI):**
- With a scratch `ANTIPOD_HOME`, a running daemon and a Task whose Stage is live, `ANTIPOD_STAGE_ID=<id> antipod step build` prints the log and out paths and exits with the step's code.
