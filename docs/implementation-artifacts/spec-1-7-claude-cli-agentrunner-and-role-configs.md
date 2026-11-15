---
title: 'Claude CLI AgentRunner and Role Configs'
type: 'feature'
created: '2026-11-14'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No Stage can run: there is no `AgentRunner` port, no `claude-cli` adapter, no Role Config and no shipped Roles, so every `start_stage` effect fails `no_handler` and Tasks stop at their first Stage (CAP-12, CAP-18, CAP-20; AD-4, AD-6, AD-15).

**Approach:** Add an `AgentRunner` port and a `claude-cli` adapter that launches each Stage as one `claude -p` with typed output and per-Role timeout, a Role Config resolver layering package `roles/` ← `$ANTIPOD_HOME/roles/` ← repo `.antipod/roles/` at `tasks.config_sha` file by file, the five shipped Role directories with write-deny permissions, the `start_stage` and `cancel_stage` handlers, and a fake `claude` for tests.

## Boundaries & Constraints

**Always:**
- One launch path (AD-4): `claude -p` with `cwd` the Task worktree (`_main` for Intake), `--output-format stream-json --verbose` appended to `data/stages/<stage_id>.jsonl`, `--json-schema` from the Role's zod output schema (`z.toJSONSchema(s, {target: 'draft-7'})`), `--permission-prompts none`, `--settings` = the resolved `permissions.json`, `--setting-sources` loading no user, project or local settings, `--strict-mcp-config` with `--mcp-config` = the resolved `mcp.json`, and `--permission-mode`, `--append-system-prompt-file`, `--max-turns` from the resolved Role Config (spine AD-4 as amended 2026-11-15); api-key mode adds `--bare` and `ANTHROPIC_API_KEY` from `secrets/antipod.env`.
- Stage env is secret-free: `PATH` (with an `antipod` shim first), `HOME`, `LANG`, `TMPDIR`, `ANTIPOD_HOME`, `ANTIPOD_STAGE_ID`; nothing else of the daemon's env.
- A Stage fails with reason `timeout`, `exit`, `invalid_output` or `max_turns`; timeout sends SIGINT, then SIGTERM after 30 s, on monotonic time; a launch that throws applies `stage_failed(launch)` itself (deferred 1-2 item). Retries stay in `transitions.ts`; they never consume budget.
- Tokens, cost and duration are read from the final `result` message and carried in the Stage's result or `stage_failed` event payload (null when unknown, e.g. after SIGTERM).
- Role files resolve package ← home ← repo, file by file; the repo layer is read from the bare clone at `tasks.config_sha` only (AD-22). A new Role directory is usable by name; its `role.yaml` `output_schema` names one of the fixed schemas.
- `role.yaml` `timeout`, `retries`, `max_turns` override `config.yaml` `roles.<role>`, which holds the defaults; the resolved `retries` is stored on the Stage so the synchronous retry rule reads it.
- Shipped `permissions.json` are Claude Code settings files (`permissions.allow`/`deny`) that deny writes outside the worktree, under `.antipod/`, and under `$ANTIPOD_HOME`; deny reads under `$ANTIPOD_HOME` and other worktrees; allow `antipod step` and deny direct build/test/emulator tools.
- `AgentRunner.observe(stage_id)` returns `{last_text, elapsed_ms}` from the live stream.

**Never:**
- No Stage brief content beyond what rows exist today (contracts, criteria, Parking Lot are 1-8/1-9/1-10); no `run_test_step` handler (1-9); no Evidence ingest (1-10); no Intake event wiring (1-8); no Peek command (1-15); no usage sampling (1-16).
- Tests never use the Owner's Claude login: every adapter test runs the fake `claude` on PATH with a scratch `ANTIPOD_HOME`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Typed output | fake emits `result` with valid `structured_output` | result event for the Role's discriminator, usage in payload | — |
| Invalid output | output fails the zod schema | `stage_failed(invalid_output)` | retried per Role |
| Max turns | `result.subtype = error_max_turns` | `stage_failed(max_turns)` | retried |
| Crash | non-zero exit, no `result` | `stage_failed(exit)` | retried |
| Timeout | fake ignores SIGINT past the deadline | SIGINT, then SIGTERM after 30 s; `stage_failed(timeout)`, usage null | retried |
| Cancel | `cancel_stage` while running | row `cancelled` first, then SIGINT; no result event applied | — |
| Layering | home overrides `prompt.md`, repo overrides `permissions.json` at `config_sha` | those two files from those layers, rest from package | — |
| Repo layer on Branch | `.antipod/roles/` changed only on the Task Branch | ignored | — |
| Unknown Role | `start_stage` with a role no layer defines | `stage_failed(launch)` with the reason logged | — |
| Launch throws | `claude` missing from PATH | `stage_failed(launch)` | retried, then Stuck |
| Unmapped output | valid Implementer `blocked`, no hook registered | `stage_failed(unhandled_output)` | retried, then Stuck |

## Owner decisions (2026-11-15)

- **Launch flags.** Permissions travel as `--settings <resolved permissions.json>` with `--setting-sources` loading no user, project or local settings, and `--strict-mcp-config` limits MCP servers to the Role's `mcp.json` (spine AD-4, AD-6, AD-15 amended; `sprint-change-proposal-2026-11-15.md`).
- **Output to events.** 1-7 maps every discriminator that has an event today: Implementer `done`; Validator `pass|blocking|nonblocking`; Evidence-mode `evidence_verified|evidence_rejected`; Triage `rerun|park|stuck` → `reason_written`. Implementer `blocked`, `EvidenceOutput` and `OwnerInstruction` go through a per-Role output hook that 1-8, 1-9 and 1-10 fill; until a hook exists, such a Stage fails `stage_failed(unhandled_output)`.
- **Scope.** One spec; the Owner kept it whole over the 1600-token target.

</frozen-after-approval>

## Code Map

- `src/core/ports/agent-runner.ts` (new) -- `AgentRunner.run(spec, signal) → StageRun {outcome: output|failed, output?, reason?, usage}`; `observe(stageId)`
- `src/core/domain/stage-output/` (new) -- zod schemas: `implementer`, `validator` (incl. Evidence mode), `triage`, `evidence`, `owner-instruction` (AD-4, AD-9 discriminators); `OUTPUT_SCHEMAS` by name
- `src/core/domain/role.ts` (new) -- `roleConfigSchema` (`role.yaml`), `permissionsSchema`; `parseDuration` from `recipe.ts`
- `src/core/domain/events.ts:35-51` -- optional `usage` on `stage_failed` and Stage result events (strict schemas)
- `src/core/coordinator/coordinator.ts:239` -- `retriesFor` reads `stages.retries` before `policy.roles`
- `src/adapters/sqlite/migrations/0007-stage-retries.ts` (new) -- `stages.retries INTEGER` (nullable); never edit 0001–0006
- `src/adapters/claude-cli/runner.ts` (new) -- spawn, stream-json tee to `data/stages/<id>.jsonl`, `result` parsing, timeout SIGINT/SIGTERM, `observe`
- `src/adapters/claude-cli/role-config.ts` (new) -- resolve four files across three layers; repo layer through an injected `readFile(sha, path)` (adapters never import each other; app wires `GitRepo.readFile`); materialize to `data/stages/<id>/role/`
- `roles/{intake,implementer,validator,evidence-producer,triage}/` (new, package root) -- `prompt.md`, `mcp.json`, `permissions.json`, `role.yaml`
- `src/app/config.ts:70-78` -- `roles` becomes a record keyed by Role name with the five defaults (new Roles allowed)
- `src/app/stages.ts` (new) -- `start_stage` handler: resolve, brief, launch, `stage_started`, map output to event; `cancel_stage` handler; launch failure → `stage_failed(launch)`
- `src/app/home.ts` -- `roles` path; `run/bin/antipod` shim written at boot
- `src/app/daemon.ts:206` -- register handlers next to the existing `setGuard`
- `src/core/coordinator/recovery.ts` -- unchanged; restart path already applies `stage_failed(restart)`
- `test/fixtures/fake-claude/claude` (new) -- node script: records argv and env to a file, plays a scenario (stream lines, `result`, exit code, ignore SIGINT, sleep)
- `test/helpers/` -- reuse `createTempHome`, `createTempRemote`, `openTestStore`, `fakeClock`

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/domain/stage-output/`, `src/core/domain/role.ts`, `src/core/ports/agent-runner.ts`, `src/core/domain/events.ts` -- schemas, port, usage in events -- AD-4
- [ ] `src/adapters/sqlite/migrations/0007-stage-retries.ts`, `index.ts`, `src/core/coordinator/coordinator.ts`, Store -- resolved retries on the Stage -- AD-4, AD-15
- [ ] `roles/*/` -- five shipped Roles with config-defaults values left to `config.yaml` -- AD-15, CAP-20
- [ ] `src/adapters/claude-cli/role-config.ts`, `src/adapters/claude-cli/runner.ts` -- resolver and launcher -- AD-4, AD-15, AD-22
- [ ] `src/app/config.ts`, `src/app/home.ts`, `src/app/stages.ts`, `src/app/daemon.ts` -- handlers and wiring -- AD-3, AD-6
- [ ] `test/fixtures/fake-claude/claude`, `test/adapters/claude-cli/*.test.ts`, `test/app/stages.test.ts`, `test/core/coordinator/transitions.test.ts` -- one test per matrix row, argv/env assertions -- AD-24

**Acceptance Criteria:**
- Given a queued Task that the scheduler starts, when the daemon drains effects with the fake `claude` returning Implementer `done`, then the Stage row goes `starting → running → succeeded`, the transcript file exists, and the Task advances with usage recorded in the `stage_events` payload.
- Given a fake `claude` that always crashes, when the Stage runs, then it is launched `retries + 1` times and the Task ends `stuck` with no budget unit used.
- Given a run with the fake `claude`, when argv and env are inspected, then the flag set is exactly AD-4's (as amended on 2026-11-15) and the env holds no daemon variable or secret value.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- Decided: Stage usage travels in event payloads (AD-4 "returned inside the typed Stage result event"), no `stages` usage columns; 1-16 reads `stage_events`.
- Decided: shipped `role.yaml` leaves `timeout`/`retries`/`max_turns` unset so `config.yaml` `roles` (already holding the config-defaults values) stays the default; home and repo `role.yaml` override.
- Decided: the brief is rendered from the Task row only (number, Role, attempt, how to call `antipod step`); flow stories extend it.
- Decided: the `antipod` shim is `run/bin/antipod`, written at boot, running this package's CLI with the daemon's Node.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0

**Manual checks (if no CLI):**
- With a scratch `ANTIPOD_HOME` and the fake `claude` first on PATH, a started Task's `data/stages/<id>.jsonl` holds the canned stream and `/log`-ready events are in `stage_events`.
- Once, with real `claude` and a scratch `ANTIPOD_HOME` (Owner-run): a Stage launched with the shipped Implementer Role cannot edit `.antipod/tasks/x.yaml`, ignores an `allow: ["Bash(*)"]` planted in the worktree's `.claude/settings.local.json`, and lists no MCP server beyond the Role's `mcp.json`; this also confirms the `--setting-sources` value that loads no source.
