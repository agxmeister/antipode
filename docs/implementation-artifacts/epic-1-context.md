# Epic 1 Context: Coordinator lifecycle and the Telegram Review, Accept and Correction loop

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the whole Antipode MVP loop end to end on the Owner's Mac. One daemon registers a Project from a Telegram group and turns Owner requests and repo-inbox files into approved Task Contracts. A deterministic, persisted Coordinator runs each Stage as a `claude -p` subprocess, the Stages produce criterion-linked Evidence, and the Owner gets a Review they can judge on the phone and then Accept (followed by Integration and Release) or correct. This is cut-line step 1, the part that must ship even if Android, voice, Unity and OpenSCAD are cut. Later epics only add Project types and voice on top of it.

## Stories

- Story 1.1: Scaffold and operations envelope
- Story 1.2: Coordinator core
- Story 1.3: Scheduler gates
- Story 1.4: Telegram adapter
- Story 1.5: Git adapter, Recipe validation and registration
- Story 1.6: Step runners
- Story 1.7: Claude CLI AgentRunner and Role Configs
- Story 1.8: Intake drafts from text and the inbox
- Story 1.9: Implement, validate and triage loop
- Story 1.10: Evidence production, ingest and rendering
- Story 1.11: Review sequence, Accept and Correction
- Story 1.12: Integration and Release
- Story 1.13: Bootstrap gate and end-to-end smoke test
- Story 1.14: Owner Messages and controls
- Story 1.15: Read-only commands
- Story 1.16: Usage window and cost
- Story 1.17: Parking Lot promotion

## Requirements & Constraints

- Telegram is the only Owner surface. It uses long polling with no public URL and honours only the configured Owner user id. Every Owner action is acknowledged within 5 s (`👀` reaction or toast).
- The Coordinator is deterministic, contains no LLM, and is the only thing that changes Task state. LLM judgment enters only as typed Stage output. Free text that changes criteria, budget or cancellation takes effect only after `Confirm` on an Interpretation card. Button taps never go through Intake.
- Task state, Stage history, Evidence and the Parking Lot survive a daemon kill or reboot. An interrupted Stage is retried and never counted as a failure, and Mac sleep pauses work without failing it.
- A Stage fails on timeout, crash, invalid output or `max_turns`. Failures are retried up to the Role limit without using Iteration Budget, and the Task goes Stuck when retries run out. No agent session runs while a Task waits for the Owner.
- Each Task has one Iteration Budget (default 5). It counts Implementer runs and excludes Corrections, retries, restarts, resumes and amendments. `Raise budget +2` adds 2 to it.
- Concurrency is 1–3 (default 2). New starts are held while 3 Reviews are open across all Projects. Dependencies must be merged to `main` first. New Stages are held when the Usage Window reaches 85%, and running ones are never killed.
- A Contract cannot be approved while any criterion's Required Evidence is outside the Recipe's `evidence_kinds`. The Validator runs in its own session and checks the Branch and every Evidence artifact. Nothing passes on the Implementer's word.
- Evidence limits: video up to 60 s and artifacts up to 50 MB. A larger artifact is rejected back to the Implementer. A Demo over 50 MB is reported as `file too large, not sent`.
- Isolation: a Stage writes only its own worktree and gets no secret values. `PROD_` secrets are available only to `release`. A Recipe with a value-looking secret fails validation. No production data is used anywhere.
- Each Project gets one bootstrap Task with one criterion per Evidence kind. It gates feature Tasks and is never merged or released. Its first test, Evidence or retry-exhaustion failure blocks onboarding, and only a new `/register` clears that.
- All limits, timeouts and retries are configuration, with defaults in `docs/specs/spec-antipod/config-defaults.md`.

## Technical Decisions

- **Hexagonal core.** `src/core/` holds domain, coordinator and ports and imports only Node built-ins and `zod`. The ports are `AgentRunner`, `StepRunner`, `Repo`, `Messenger`, `Store`, `EvidenceStore`, `WindowReader`, `Transcriber` and `Clock`. Adapters implement only the ports listed for them and never import each other. `src/app/` is the composition root.
- **One SQLite file is the system of record.** Its tables include `step_runs` and `capability_leases`. A file under `data/` exists to the system only when a row references it. Migrations are forward-only and run at boot, and the daemon refuses a database newer than its code.
- **Commit first, act second.** Events go through one serial queue. `applyEvent` is synchronous and writes the state, the `stage_events` row and the `effects` rows in one transaction. Effects run after commit and are idempotent by `effect_id`. A Stage or step event whose `stage_id` is not `tasks.current_stage_id` is recorded as `ignored(stale)`. The spine fixes the state diagram, the generic events and the causes that count toward the budget, and `transitions.ts` has a table-driven test over every `(state, event)` pair.
- **Review rounds.** `tasks.review_round` increments only when a Task enters `in_review` from `verifying`. A return through `undone` or `resume` keeps the round. Evidence is stored under `review_round + 1`.
- **Scheduler gates, in order:** Owner pause, usage window, concurrency, Review backpressure, dependencies merged, bootstrap accepted (skipped for the bootstrap Task), then the exclusive-capability hint. The hint reads `projects.exclusive_capabilities`, which registration sets, and waits with reason `capability`. Every gate reads only the database, and the failing gate is stored in `tasks.waiting_reason`. The usage gate is checked again before every Stage launch.
- **Stages.**
  - Each Stage is one `claude -p`. Its `cwd` is the Task worktree, or the read-only `_main` checkout for Intake.
  - Its `stream-json` is saved to `data/stages/<stage_id>.jsonl`. `--json-schema` comes from the Role's zod schema, and the other flags come only from the resolved Role Config. Permissions are the Role's `permissions.json` passed with `--settings`; `--setting-sources` stops user, project and local settings files from loading, and `--strict-mcp-config` limits MCP servers to the Role's `mcp.json`.
  - Output discriminators: Implementer `done|blocked`, Validator `pass|blocking|nonblocking` (plus `evidence_verdicts` in Evidence mode), Triage `rerun|park|stuck`, Evidence Producer `artifacts[]`, Intake `OwnerInstruction`.
  - A timed-out Stage gets SIGINT and, 30 s later, SIGTERM. Deadlines use monotonic time.
- **Role Config and settings.** A Role is a directory of `prompt.md`, `mcp.json`, `permissions.json` and `role.yaml`. It resolves file by file from package `roles/`, then `$ANTIPOD_HOME/roles/`, then repo `.antipod/roles/`, with later sources winning. Settings resolve the same way from `config.yaml`, then `antipod.yaml`, then the Task Contract.
- **Git.**
  - Each Project has a plain bare clone, a read-only `_main` checkout, and one worktree per Task on Branch `antipod/<task_no>-<slug>`.
  - The Branch is pushed after every Implementer Stage, then the Recipe `test` step runs.
  - Inbox files are detected by `(path, blob_sha)`. Configuration, inbox files and secret names are read only from `main` at `tasks.config_sha`.
- **Contract rows are the record.** `.antipod/tasks/<task_no>.yaml` is a projection the Coordinator commits on the first entry to `implementing`, removing the inbox file in the same commit. Stage briefs are rendered from rows.
- **Steps and step runs.**
  - Container and host Runners share one step contract: `cwd`, named secrets, `ANTIPOD_OUT`, `ANTIPOD_DATA`, `ANTIPOD_PRIOR` and `ANTIPOD_TASK`.
  - Stages run steps only through `antipod step <name>` over `$ANTIPOD_HOME/run/antipod.sock`.
  - Every step execution is a `step_runs` row, inserted before spawning and updated on exit. Its id names `data/steps/<step_run_id>/`.
  - Exclusive host capabilities are leased. A busy lease means a retry and never costs a budget unit.
  - Only the host adapter knows the OS.
- **Evidence.** Only the Evidence Producer writes Evidence, and it is never changed afterwards. Ingest copies the file, fsyncs it, then inserts the row. A repeat marks earlier rows `superseded`. Composites and callouts come only from the `antipod-evidence` CLI, which uses sharp, bundled Inter and the DESIGN.md tokens. A Peek is the only read of unrecorded files.
- **Telegram.**
  - The last `update_id` is persisted. Every send or edit is an `outbox` row, drained per chat in sequence with one Review sequence at a time.
  - `callback_data` is `cb:<ulid>`, bound to Task state and `review_round`. The previous round's keyboard is retired only when a new round begins.
  - Messages use HTML parse mode, with one template module per card kind and truncation done by the template.
  - The command menu is set with `setMyCommands` at boot.
- **Integration.** After the 10 s Undo window, the Coordinator rebases on `origin/main`, re-runs `test` and the Validator, fast-forward merges, pushes, and runs `release` if the Recipe declares it. A rebase or revalidation failure returns the Task to the Implementer and costs one budget unit. `main` is never rolled back.
- **Usage and cost** go only through `core/coordinator/usage.ts`. `WindowReader` returns `null` on any failure, and the core estimator takes over.
- **Recovery is crash-only.** At boot the daemon:
  - fails `starting` and `running` Stages with `restart` and applies the retry policy;
  - re-executes only `pending` effects (a `start_stage` effect whose Stage is no longer `starting` is marked done);
  - resends unsent outbox rows;
  - fails `running` step runs with `restart`, kills leased step processes, removes the instance's step containers and clears leases;
  - deletes orphan Evidence files.

  A wall-clock jump over 60 s extends deadlines and queues one silent `back_online` notice per Project.
- **Ops and tests.**
  - Never use `~/.antipod` in development or tests.
  - Logs are pino JSON lines carrying `project_id`, `task_id` and `stage_id`.
  - Core tests use in-memory port fakes. Adapter tests use the fakes: a fake `claude` on PATH, a grammY transformer, a temporary git remote, Podman with busybox and file-backed SQLite.
  - One end-to-end smoke test runs the `recipes/examples/openscad.yaml` bootstrap.
  - A failure the Owner must see becomes an `outbox` notice.

## UX & Interaction Patterns

- **Chat and tone.** Each Project has one private supergroup with the Owner and the bot. Copy reads like a team lead's status report: no apologies, greetings or exclamation marks. A glyph is always followed by a word. Durations are approximate and times are local. Stages and Roles are never mentioned except in `/log` and Peek.
- **Review order.**
  - First, one silent Evidence message per criterion.
  - Then the silent Demo.
  - Last, the Review card. It is the only message with sound and holds the summary, the criteria strip, the Parking Lot, the cost line and `Accept` / `Request changes`.
  - Visual Evidence comes first. Before/after is shown after a Correction, and Degraded Evidence is marked `⚠️` with its reason.
- **Accept and stale taps.** Cards are edited in place. After Accept, `Undo` shows for 10 s, and Undo restores the same card. A tap on an old card gets `This Review was replaced by a newer one.`
- **Sound.** Only the Review card, Stuck, Release failed, Onboarding blocked and Registration failed make a sound.
- **Draft card.** It shows the goal, numbered criteria with their Evidence kind, and up to 2 questions with quick answers. `⚠️` marks infeasible criteria with `Use proposal` / `Drop ACn`. Discard can be undone for 1 minute.
- **Targeting and Correction.** Targeting tries, in order, a reply to a bot message, an explicit id, a single matching Task, then candidate buttons. Text with no target goes to Intake. A Correction uses a force-reply. A note-only Correction goes straight back to the Implementer, while criteria changes need an Interpretation card. The Stuck card offers `Raise budget +2` and `Cancel Task`.
- **Commands and copy.** The commands are `/register`, `/status`, `/peek`, `/parked`, `/cost`, `/pause`, `/resume`, `/cancel`, `/evidence` and `/log`. The exact copy for every state is in EXPERIENCE.md, and the visual tokens are in DESIGN.md.

## Cross-Story Dependencies

- Story 1.1 underpins everything. Story 1.2 is the base for every Coordinator story, and 1.3 builds on it.
- The adapter stories 1.4–1.7 can mostly run in parallel after 1.2, and every flow story uses them.
- Flow stories:
  - 1.8 needs 1.4, 1.5 and 1.7.
  - 1.9 needs 1.6 and 1.7.
  - 1.10 needs 1.6 and 1.9.
  - 1.11 needs 1.4 and 1.10.
  - 1.12 needs 1.11, 1.5 and 1.6.
  - 1.13 needs the full loop.
  - 1.9, 1.10 and 1.12 read step outcomes from `step_runs` rows.
- Extensions:
  - 1.14 builds on Intake (1.8).
  - 1.15 builds on Evidence and Stage records.
  - 1.16 builds on the usage gate (1.3) and Stage results (1.7).
  - 1.17 builds on Triage parking (1.9) and drafts (1.8).
- Later epics: epic 2 (Android) reuses the Recipe, Runners and bootstrap. Epic 3 adds a `Transcriber` to Intake. Epic 4 (Unity and OpenSCAD) adds Recipes and Role Config MCPs.
