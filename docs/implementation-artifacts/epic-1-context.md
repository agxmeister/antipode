# Epic 1 Context: Coordinator lifecycle and the Telegram Review, Accept and Correction loop

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the whole Antipode MVP loop end to end on the Owner's Mac. A single daemon registers a Project from a Telegram group and turns Owner requests and repo-inbox files into approved Task Contracts. A deterministic, persisted Coordinator runs each Stage as a `claude -p` subprocess. Stages produce Evidence linked to each criterion, and the Owner judges the Review on a phone, then either Accepts (Integration and Release follow) or asks for changes. This is cut-line step 1 and must ship even if Android, voice, Unity and OpenSCAD are cut. Later epics only add Project types and voice on top of it.

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

- **Telegram only.** Telegram is the only Owner surface. The bot uses long polling with no public URL and honours only the configured Owner user id. Every Owner action is acknowledged within 5 s, by a `👀` reaction or a toast.
- **Deterministic Coordinator.** The Coordinator has no LLM and is the only component that changes Task state. LLM judgment arrives only as typed Stage output. Free text that changes criteria, budget or cancellation takes effect only after `Confirm` on an Interpretation card. Button taps never pass through Intake.
- **Durability.** Task state, Stage history, Evidence and the Parking Lot survive a daemon kill or a reboot. A Stage interrupted by a restart is retried and never counted as a failure. Mac sleep pauses work without failing it.
- **Stage failure.** A Stage fails on timeout, crash, invalid output or `max_turns`. It is retried up to the Role's limit without using Iteration Budget, and then the Task goes Stuck. No agent session runs while a Task waits for the Owner.
- **Iteration Budget.** Each Task has one budget, default 5, that counts Implementer runs. These causes count one unit each: first start, blocking findings, Triage rerun, test failed, Evidence missing or rejected, and Integration rework. Corrections, retries, restarts, resumes and amendments never count. A confirmed amendment restarts the Task with a fresh budget. `Raise budget +2` adds 2 runs.
- **Starting Tasks.**
  - Concurrency is 1–3 Tasks, default 2.
  - Starts are held while 3 Reviews are open across all Projects.
  - A Task starts only after its dependencies are merged to `main`.
  - New Stages are held when the Usage Window reaches 85%. Running Stages are never killed for the window.
- **Contracts.**
  - A Contract cannot be approved while any criterion's Required Evidence is outside the Recipe's `evidence_kinds`.
  - A new inbox file on `main` yields exactly one Draft. A contract already imported or merged is never offered again.
  - A Draft asks at most two questions.
  - When Intake gives up in `draft`, a revision returns to `awaiting_approval` on its previous version and a first run is cancelled. Either way the Owner's latest message gets `❌` and a reply. A draft never goes to `stuck`.
- **Validation and Evidence.**
  - The Validator runs in its own session and checks the Branch and every Evidence artifact. Nothing passes on the Implementer's word.
  - Videos are at most 60 s and artifacts at most 50 MB. A larger artifact sends the Task back to the Implementer.
  - A Demo over 50 MB is reported as `file too large, not sent`.
- **Isolation.**
  - A Stage writes only to its own worktree and receives no secret values.
  - `PROD_` secrets reach only the `release` step, and a Recipe containing a value-looking secret fails validation.
  - No production data is used anywhere.
- **Bootstrap.** Each Project gets one bootstrap Task with one criterion per Evidence kind, and it gates feature Tasks. The bootstrap is never merged or released. If it fails, onboarding stays blocked until a new `/register`.
- **Configuration.** All limits, timeouts and retries are configuration, never code. Defaults are in `docs/specs/spec-antipod/config-defaults.md`.

## Technical Decisions

- **Hexagonal core.**
  - `src/core/` (domain, coordinator, ports) imports only Node built-ins and `zod`.
  - The ports are `AgentRunner`, `StepRunner`, `Repo`, `Messenger`, `Store`, `EvidenceStore`, `WindowReader`, `Transcriber` and `Clock`.
  - Adapters never import each other. `src/app/` wires everything together.
- **SQLite is the system of record**, including `step_runs` and `capability_leases`. A file under `data/` exists to the system only when a row references it; Progress Peek is the one exception. Migrations are forward-only and run at boot. The daemon refuses a database newer than the code.
- **Commit first, act second.**
  - All events go through one serial queue.
  - A synchronous `applyEvent` writes the state, the `stage_events` row and the `effects` rows in one transaction.
  - Effects run after commit and are idempotent by `effect_id`.
  - A Stage or step event whose `stage_id` is not `tasks.current_stage_id` is recorded as `ignored(stale)`.
  - The spine fixes the state diagram, the generic events and the causes that count against the budget, including the two `draft` exits of `stage_retries_exhausted`. `transitions.ts` keeps a table-driven test over every `(state, event)` pair.
- **Identity.**
  - Internal ids are ULIDs.
  - The per-Project Task number (`#12`) is assigned at approval or at bootstrap creation.
  - `AC<n>` is fixed per criterion and never reused. A dropped criterion keeps its id and gets `status = dropped`.
  - `tasks.review_round` increments once per Review delivered, and Evidence is stored under `review_round + 1`.
- **Scheduler gates**, checked in this order:
  1. Owner pause
  2. Usage window
  3. Concurrency
  4. Review backpressure
  5. Dependencies merged
  6. Bootstrap accepted (skipped for the bootstrap itself)
  7. Exclusive-capability hint (reason `capability`)

  Gates read only the database, and the failing gate is stored as `tasks.waiting_reason`. The usage gate is checked again before every Stage launch.
- **Stages.**
  - Each Stage is one `claude -p` process. Its `cwd` is the Task worktree, or the read-only `_main` checkout for Intake, which has no Branch.
  - `stream-json` output goes to `data/stages/<stage_id>.jsonl`, and `--json-schema` comes from the Role's zod schema.
  - Permissions come only from the Role's `permissions.json`, passed with `--settings`; `--setting-sources` blocks every other settings file. MCP servers come only from the Role's `mcp.json`, through `--strict-mcp-config`.
  - On timeout the process gets SIGINT, then SIGTERM 30 s later. Deadlines use monotonic time.
  - Output discriminators:
    - Implementer: `done|blocked`
    - Validator: `pass|blocking|nonblocking`, with `evidence_verdicts` in Evidence mode
    - Triage: `rerun|park|stuck`
    - Evidence Producer: `artifacts[]`
    - Intake: `OwnerInstruction`
- **Recipe steps** run only through `antipod step <name>`, which reaches the daemon over a Unix socket. The Container and Host Runners share one step contract (`ANTIPOD_OUT`, `ANTIPOD_DATA`, `ANTIPOD_PRIOR`, `ANTIPOD_TASK`, only the secrets the step names). Each run is a `step_runs` row. A busy exclusive capability fails fast with `capability_busy`, which leads to a retry, never to a budget unit.
- **Intake is the only interpreter.**
  - Intake starts only on `owner_message`, `promote_finding`, or `inbox_detected` for a file without Evidence per criterion.
  - It returns 1–2 instructions plus an optional question. The instruction kinds are `new_draft`, `draft_reply`, `correction`, `amendment`, `cancel` and `not_actionable`.
  - `draft_reply`, `correction` and `not_actionable` apply directly. `amendment` and `cancel`, with any `new_draft` that accompanies them, apply after one Confirm.
  - A quick-answer tap updates the draft row without running a Stage.
- **Git.**
  - Each Project has a bare clone, a read-only `_main` checkout, and one worktree per Task on `antipod/<task_no>-<slug>`.
  - Each Project is fetched at boot and every `git.fetch_interval_ms`. The inbox is scanned after each fetch, keyed by `(path, blob_sha)`.
  - The Recipe, Role Config, inbox and secret names are read only from `main` at `tasks.config_sha`.
  - The Branch is pushed after every Implementer Stage that reports `done`, and then the Recipe `test` step runs. A blocked Implementer goes to Triage.
  - Antipode writes `main` only by fast-forward during Integration.
- **The contract rows are the record.** Stage briefs are rendered from the `contracts` and `criteria` rows. On first entering `implementing`, the Coordinator writes `.antipod/tasks/<task_no>.yaml` and commits it as `antipod: contract v<version>`; the first such commit also removes the inbox file with `git rm`. The budget is stored on `tasks`, not in the file.
- **Evidence** is immutable and linked to a criterion. Only the Evidence Producer writes it, and a repeated attempt marks the earlier rows `superseded`. `ANTIPOD_PRIOR` holds the previous round's files for before/after pairs. Composites and callouts come only from the `antipod-evidence` renderer (sharp, bundled Inter, DESIGN.md tokens).
- **Telegram.**
  - The last `update_id` is persisted.
  - Every send or edit is an `outbox` row, drained per chat in order, with one Review sequence at a time.
  - `callback_data` is `cb:<ulid>`, bound to the Task state and `review_round`.
  - Messages use HTML parse mode, with one template module per card kind; truncation happens in the template.
- **Integration.** After the 10 s Undo, Integration rebases on `origin/main`, runs the test step again, revalidates, fast-forwards, pushes, and then runs `release` if the Recipe declares it. A rebase or revalidation failure costs one budget unit. `main` is never rolled back.
- **Usage and cost** go only through `core/coordinator/usage.ts`. When `WindowReader` returns `null`, the estimator takes over.
- **Crash-only recovery.** At boot the Coordinator:
  - fails `starting` and `running` Stages with `restart` and applies the retry policy;
  - replays only `pending` effects;
  - resends unsent outbox rows;
  - fails running step runs, kills leased processes and clears leases;
  - deletes orphan Evidence files.

  A clock jump over 60 s extends deadlines and queues one silent `back_online` notice per Project.
- **Tests.** Core tests use in-memory fakes of the ports. Adapter tests use a fake `claude` on PATH, a grammY transformer, a temporary git remote, Podman with busybox, and file-backed SQLite. Tests never use `~/.antipod`, the Owner's Claude login or the real bot token.

## UX & Interaction Patterns

- **Tone.**
  - Each Project has one private supergroup.
  - Copy reads like a status report, with no apologies, greetings or exclamation marks.
  - A glyph is always followed by a word.
  - Durations are approximate and times are local.
  - Stages and Roles are named only in `/log` and in a Peek.
- **Draft card.**
  - The title is `<b>${title}</b> · draft` with no number; after approval it is `#n · title`.
  - Up to 2 questions, with quick-answer buttons when the answer is closed. `Approve` stays hidden until everything is answered and feasible.
  - An infeasible criterion shows `⚠️` with `Use proposal` / `Drop ACn`.
  - A reply revises the draft, and the card is edited in place.
  - After Discard the card reads `Discarded · undo within 1 min` with an `Undo` button; when the minute is up it reads `Discarded`.
- **Review.** The Review is sent in this order, and only the card makes a sound:
  1. One silent Evidence message per criterion. Visuals come first, a before/after pair follows a Correction, and Degraded Evidence is marked with `⚠️` and its reason.
  2. The silent Demo.
  3. The Review card, with a summary, a criteria strip, the Parking Lot, a cost line, and `Accept` / `Request changes`.
- **After a tap.**
  - Cards are edited in place.
  - `Accept` shows `Undo` for 10 s.
  - A tap on an outdated Review card gets `This Review was replaced by a newer one.` On other cards, a tap that can no longer act gets `#${id} is ${state} now.` and the card is redrawn. `${state}` uses EXPERIENCE.md → State words (`#12 is being tested now.`).
  - `Request changes` opens a force-reply. A Correction that only adds a note goes straight back to the Implementer, and a change to criteria needs an Interpretation card.
  - The Stuck card offers `Raise budget +2` / `Cancel Task` (only `Cancel Task` when stuck on dependencies), and `Cancel Task` asks for confirmation in place. After a blocked Implementer, Triage's `park` ends at the Stuck card. Every exit from `stuck` closes the card (`⏸ Paused by you` on pause); only the newest Stuck card has buttons.
- **Sound** comes only from the Review card, Stuck, Release failed, Onboarding blocked and Registration failed.
- **Targeting.** A Task is resolved from the replied-to message, then an explicit id, then a single matching Task, then candidate buttons.
- **Commands:** `/register`, `/status`, `/peek`, `/parked`, `/cost`, `/pause`, `/resume`, `/cancel`, `/evidence`, `/log`. The exact copy is in EXPERIENCE.md, and the visual tokens are in DESIGN.md.

## Cross-Story Dependencies

- **Done.** Stories 1.1–1.8 are done. They provide the scaffold, the Coordinator, the gates, the Telegram, git and claude-cli adapters, the step runners, and Intake drafting. The remaining stories build on these and do not redo them.
- **Story 1.9** needs 1.6 and 1.7.
- **Story 1.10** needs 1.6 and 1.9.
- **Story 1.11** needs 1.4 and 1.10.
- **Story 1.12** needs 1.11, 1.5 and 1.6.
- **Story 1.13** needs the full loop.
- **Stories 1.9, 1.10 and 1.12** read step outcomes from `step_runs`.
- **Story 1.14** extends Intake (1.8) with corrections, amendments, cancels and Interpretation cards.
- **Story 1.15** builds on the Evidence and Stage records.
- **Story 1.16** builds on the usage gate (1.3) and the Stage results (1.7).
- **Story 1.17** builds on Triage parking (1.9) and drafts (1.8).
- **Stories 1.14 and 1.17** inherit the draft rules: no number before approval, and the Intake give-up behaviour.
- **Later epics.**
  - Epic 2 (Android) reuses the Recipe, the Runners and the bootstrap.
  - Epic 3 puts a `Transcriber` in front of Intake.
  - Epic 4 adds Recipes and MCPs in Role Config.
