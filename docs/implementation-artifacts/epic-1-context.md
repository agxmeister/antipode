# Epic 1 Context: Coordinator lifecycle and the Telegram Review, Accept and Correction loop

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the whole Antipode MVP loop end to end on the Owner's Mac. One daemon registers a Project from a Telegram group and turns Owner requests and repo-inbox files into approved Task Contracts. A deterministic, persisted Coordinator runs each Stage as a `claude -p` subprocess, the Stages produce criterion-linked Evidence, and the Owner judges a Review on the phone, then Accepts (Integration and Release follow) or corrects. This is cut-line step 1, which must ship even if Android, voice, Unity and OpenSCAD are cut; later epics only add Project types and voice on top of it.

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

- Telegram is the only Owner surface: long polling, no public URL, only the configured Owner user id is honoured. Every Owner action is acknowledged within 5 s (`👀` reaction or toast).
- The Coordinator is deterministic, has no LLM, and is the only thing that changes Task state. LLM judgment enters only as typed Stage output. Free text that changes criteria, budget or cancellation acts only after `Confirm` on an Interpretation card. Button taps never go through Intake.
- Task state, Stage history, Evidence and the Parking Lot survive a daemon kill or reboot. An interrupted Stage is retried, never counted as a failure; Mac sleep pauses work without failing it.
- A Stage fails on timeout, crash, invalid output or `max_turns`; it is retried up to the Role limit without using Iteration Budget, then the Task goes Stuck. No agent session runs while a Task waits for the Owner.
- One Iteration Budget per Task (default 5) counts Implementer runs; Corrections, retries, restarts, resumes and amendments never count. `Raise budget +2` adds 2.
- Concurrency 1–3 (default 2); starts held at 3 open Reviews across all Projects; dependencies must be merged to `main`; new Stages held at 85% Usage Window, running ones never killed.
- A Contract cannot be approved while any criterion's Required Evidence is outside the Recipe's `evidence_kinds`. A new inbox file on `main` yields exactly one Draft; an already imported or merged contract is never offered again. Drafts ask at most two questions.
- The Validator runs in its own session and checks the Branch and every Evidence artifact; nothing passes on the Implementer's word. Video ≤ 60 s, artifacts ≤ 50 MB (larger goes back to the Implementer); a Demo over 50 MB is reported `file too large, not sent`.
- Isolation: a Stage writes only its own worktree and gets no secret values; `PROD_` secrets reach only `release`; a Recipe with a value-looking secret fails validation; no production data anywhere.
- One bootstrap Task per Project (one criterion per Evidence kind) gates feature Tasks and is never merged or released; its failure blocks onboarding until a new `/register`.
- All limits, timeouts and retries are configuration (`docs/specs/spec-antipod/config-defaults.md`), e.g. `limits.undo_discard_ms` 60 s, `intake.retries` 2, `intake.context_messages` 10.

## Technical Decisions

- **Hexagonal core.** `src/core/` (domain, coordinator, ports) imports only Node built-ins and `zod`. Ports: `AgentRunner`, `StepRunner`, `Repo`, `Messenger`, `Store`, `EvidenceStore`, `WindowReader`, `Transcriber`, `Clock`. Adapters never import each other; `src/app/` composes.
- **SQLite is the system of record** (including `step_runs` and `capability_leases`). A `data/` file exists only when a row references it. Migrations are forward-only at boot; a newer database is refused.
- **Commit first, act second.** One serial event queue; synchronous `applyEvent` writes state, `stage_events` and `effects` in one transaction; effects run after commit, idempotent by `effect_id`. A Stage/step event whose `stage_id` is not `tasks.current_stage_id` is recorded `ignored(stale)`. The spine fixes the state diagram (draft → awaiting_approval → queued/discard_pending, … → released/cancelled), the generic events and the budget-counting causes; `transitions.ts` has a table-driven test over every `(state, event)`.
- **Identity.** ULIDs internally; the per-Project Task number (`#12`) is assigned at approval or bootstrap creation. `AC<n>` is fixed per criterion and never reused (a dropped one keeps its id, `status = dropped`). `tasks.review_round` increments once per Review delivered; Evidence is stored under `review_round + 1`.
- **Scheduler gates, in order:** Owner pause, usage window, concurrency, Review backpressure, dependencies merged, bootstrap accepted (skipped for the bootstrap), exclusive-capability hint (reason `capability`). Gates read only the database; the failing one is `tasks.waiting_reason`. The usage gate is rechecked before every Stage launch.
- **Stages.** Each is one `claude -p` with `cwd` = the Task worktree, or the read-only `_main` checkout for Intake (no Branch). `stream-json` goes to `data/stages/<stage_id>.jsonl`; `--json-schema` comes from the Role's zod schema. Permissions are the Role's `permissions.json` (a Claude Code settings file with `permissions.allow`/`deny`) passed with `--settings`; `--setting-sources` stops user, project and local settings loading; `--strict-mcp-config` limits MCP servers to the Role's `mcp.json`; `--permission-mode`, `--append-system-prompt-file`, `--max-turns` come from the resolved Role Config. No other flag set. Shipped permissions deny writes under `.antipod/` and `$ANTIPOD_HOME`, reads under `$ANTIPOD_HOME` and other worktrees, and direct build/test tools (steps go only through `antipod step`). Timeout: SIGINT, SIGTERM 30 s later, monotonic deadlines. Outputs: Implementer `done|blocked`, Validator `pass|blocking|nonblocking` (+ `evidence_verdicts`), Triage `rerun|park|stuck`, Evidence Producer `artifacts[]`, Intake `OwnerInstruction`.
- **Intake is the one interpreter.** Started only by `owner_message`, `promote_finding`, or `inbox_detected` for a file lacking per-criterion Evidence. Output `OwnerInstruction { instructions: [1..2], question? }`, each one of `new_draft | draft_reply | correction | amendment | cancel | not_actionable`, at most one per kind. `draft_reply`, `correction`, `not_actionable` apply directly; `amendment`/`cancel` (with any accompanying `new_draft`) apply after one Interpretation-card Confirm; a lone `new_draft` becomes a Draft card. The brief is rendered from rows plus the last `intake.context_messages` Owner/bot messages and any unanswered question. Quick-answer taps update the draft row without a Stage.
- **Role Config and settings** resolve file by file: package `roles/` → `$ANTIPOD_HOME/roles/` → repo `.antipod/roles/` (later wins); settings from `config.yaml` → `antipod.yaml` → Task Contract.
- **Git.** Bare clone per Project, read-only `_main` checkout (fast-forwarded before use), one worktree per Task on `antipod/<task_no>-<slug>`. Inbox files are `.antipod/inbox/<slug>.yaml` (contract) or `.md` (BMad story) on `main`, detected after each fetch by `(path, blob_sha)` in `contract_sources`; a new `blob_sha` at a path whose Task is terminal is a new draft; `.antipod/tasks/` is never scanned. Approval assigns `task_no` and creates Branch and worktree but commits nothing. Recipe, `.antipod/roles/`, inbox and secret names are read only from `main` at `tasks.config_sha`. The Branch is pushed after every Implementer Stage, then Recipe `test` runs. Antipode writes `main` only by fast-forward in Integration.
- **Contract rows are the record.** `contracts` (versioned) and `criteria` rows; an inbox file is input only until import. The Coordinator alone writes `.antipod/tasks/<task_no>.yaml` from rows as the first effect on entering `implementing` and commits it as `antipod: contract v<version>`, the first such commit also `git rm`s the source inbox file. Briefs come from rows, never the file; budget lives on `tasks`.
- **Evidence** is immutable and criterion-linked, written only by the Evidence Producer; a repeat marks earlier rows `superseded`. Composites and callouts come only from the `antipod-evidence` renderer (sharp, Inter, DESIGN.md tokens).
- **Telegram.** Persisted `update_id`; every send/edit is an `outbox` row drained per chat in order, one Review sequence at a time. `callback_data` is `cb:<ulid>` bound to Task state and `review_round`. HTML parse mode, one template module per card kind, truncation in the template; `setMyCommands` at boot.
- **Integration.** After the 10 s Undo: rebase on `origin/main`, re-test, re-validate, fast-forward, push, then `release` if declared. Rebase or revalidation failure costs one budget unit; `main` is never rolled back.
- **Usage and cost** go only through `core/coordinator/usage.ts`; `WindowReader` returns `null` on failure and the estimator takes over.
- **Crash-only recovery.** At boot: fail `starting`/`running` Stages with `restart` and apply retry policy; re-run only `pending` effects; resend unsent outbox; fail `running` step runs, kill leased processes, remove step containers, clear leases; delete orphan Evidence files. A clock jump over 60 s extends deadlines and queues one silent `back_online` per Project.
- **Ops and tests.** Never use `~/.antipod`. pino JSON logs with `project_id`, `task_id`, `stage_id`. Core tests use in-memory port fakes; adapter tests use a fake `claude` on PATH, a grammY transformer, a temporary git remote, Podman with busybox and file-backed SQLite. A failure the Owner must see becomes an `outbox` notice.

## UX & Interaction Patterns

- **Tone.** One private supergroup per Project. Status-report copy: no apologies, greetings or exclamation marks; a glyph is always followed by a word; approximate durations, local times. Stages and Roles appear only in `/log` and Peek.
- **Draft card.** Goal, numbered criteria with their Evidence kind, fits one phone screen; up to 2 questions with quick-answer buttons when closed. `Approve` is hidden until every question is answered and every criterion feasible, replaced by `Approve after: answer Q1`. An infeasible criterion reads `AC3 ⚠️ can't evidence … · proposed: …` with `Use proposal` / `Drop AC3`. A text or voice reply revises the draft and the card is edited in place. `Discard` needs no confirmation and is undoable for 1 min. Approve toasts `Queued.` and the card shows `⏳ Queued · …`.
- **Review order.** One silent Evidence message per criterion (visual first, before/after after a Correction, Degraded marked `⚠️` with reason), then the silent Demo, then the Review card (the only message with sound): summary, criteria strip, Parking Lot, cost line, `Accept` / `Request changes`.
- **Accept and stale taps.** Cards edit in place; `Undo` shows 10 s after Accept and restores the same card; a tap on an old card gets `This Review was replaced by a newer one.`
- **Sound** only for the Review card, Stuck, Release failed, Onboarding blocked and Registration failed.
- **Targeting.** Reply to a bot message, explicit id, single matching Task, then candidate buttons; untargeted text goes to Intake. A Correction uses force-reply; note-only goes straight back to the Implementer, criteria changes need an Interpretation card. Stuck offers `Raise budget +2` / `Cancel Task`.
- **Commands:** `/register`, `/status`, `/peek`, `/parked`, `/cost`, `/pause`, `/resume`, `/cancel`, `/evidence`, `/log`. Exact copy is in EXPERIENCE.md, visual tokens in DESIGN.md.

## Cross-Story Dependencies

- 1.1 underpins everything; 1.2 is the base for every Coordinator story; 1.3 builds on 1.2.
- Adapter stories 1.4–1.7 mostly run in parallel after 1.2; every flow story uses them.
- 1.8 needs 1.4, 1.5 and 1.7. 1.9 needs 1.6 and 1.7. 1.10 needs 1.6 and 1.9. 1.11 needs 1.4 and 1.10. 1.12 needs 1.11, 1.5 and 1.6. 1.13 needs the full loop. 1.9, 1.10 and 1.12 read step outcomes from `step_runs`.
- 1.14 extends Intake (1.8) with corrections, amendments, cancels and Interpretation cards; 1.15 builds on Evidence and Stage records; 1.16 on the usage gate (1.3) and Stage results (1.7); 1.17 on Triage parking (1.9) and drafts (1.8).
- Later epics: epic 2 (Android) reuses Recipe, Runners and bootstrap; epic 3 adds a `Transcriber` in front of Intake; epic 4 adds Recipes and Role Config MCPs.
