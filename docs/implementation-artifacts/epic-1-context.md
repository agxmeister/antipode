# Epic 1 Context: Coordinator lifecycle and the Telegram Review, Accept and Correction loop

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the whole Antipode MVP loop end to end on the Owner's Mac: a single daemon that registers a Project from a Telegram group, turns Owner requests and repo-inbox files into approved Task Contracts, runs each Stage as a `claude -p` subprocess under a deterministic, persisted Coordinator, produces criterion-linked Evidence, and delivers a phone-judgeable Review the Owner can Accept (followed by Integration and Release) or correct. This is cut-line step 1, the part that must ship even if Android, voice, Unity and OpenSCAD work is cut; later epics only add Project types and voice on top of it.

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

- Telegram is the only Owner surface: long polling, no public URL, only the configured Owner user id is honoured. Every Owner action is acknowledged within 5 s (`👀` reaction or toast) even when the work takes longer.
- The Coordinator is deterministic, contains no LLM, and is the only thing that changes Task state. LLM judgment enters only as typed Stage output; free text that changes criteria, budget or cancellation acts only after `Confirm` on an Interpretation card. Button taps never go through Intake.
- Task state, Stage history, Evidence and Parking Lot survive daemon kill or reboot; an interrupted Stage is retried, never counted as a failure. Mac sleep pauses, never fails.
- Stage failures (timeout, crash, invalid output, `max_turns`) retry up to the Role limit without using Iteration Budget, then Stuck. No agent session runs while a Task waits for the Owner.
- One Iteration Budget per Task (default 5) counts every Implementer run except Corrections, retries, resumes and amendments. `Raise budget +2` adds 2.
- Concurrency 1–3 (default 2); backpressure holds new starts at 3 open Reviews globally (shown only in `/status`); dependencies must be merged to `main` first; Usage Window holds new Stages at 85% and never kills running ones.
- Contracts cannot be approved while any criterion's Required Evidence is outside the Recipe's `evidence_kinds`. Validator (own session) checks the Branch and every Evidence artifact; nothing passes on the Implementer's word.
- Evidence: one media message per criterion, video ≤ 60 s, artifacts ≤ 50 MB (rejected otherwise, back to Implementer); visual first, before/after after a Correction, Degraded shown with `⚠️` and reason, never hidden. Demo files over 50 MB report `file too large, not sent`.
- Isolation: Stages write only their own worktree and get no secret values; `PROD_` secrets only in `release`; a Recipe with a value-looking secret fails validation; no production data anywhere.
- A bootstrap Task per Project (`#1 Bootstrap · Recipe check`, one criterion per Evidence kind) gates feature Tasks and is never merged or released.
- All limits, timeouts and retries are configuration (see `docs/specs/spec-antipod/config-defaults.md`): Role timeouts intake 5m, implementer 45m, validator 20m, evidence-producer 30m, triage 5m; 2 retries each; undo Accept 10 s, Discard 60 s; `intake.retries` 2; `outbox.retries` 5; stale updates after 5 min.
- Success signal context: median Review judged in about one minute, never more than two.

## Technical Decisions

- **Hexagonal core around a persistent FSM.** `src/core/` (domain, coordinator, ports) imports only Node built-ins and `zod`. Ports: `AgentRunner`, `StepRunner`, `Repo`, `Messenger`, `Store`, `EvidenceStore`, `WindowReader`, `Transcriber`, `Clock`. Adapters under `src/adapters/<name>/` implement only their listed ports and never import each other; `src/app/` is the composition root (config, wiring, daemon, CLI, step socket). Import layering is enforced.
- **One process, one SQLite file** at `$ANTIPOD_HOME/data/antipod.db` is the system of record (tables include `projects`, `tasks`, `contracts`, `criteria`, `contract_sources`, `stages`, append-only `stage_events`, `effects`, `evidence`, `parking_lot`, `cost_samples`, `usage_samples`, `capability_leases`, `telegram_messages`, `outbox`, `callbacks`, `settings`). Files under `data/` exist only if a row references them. Migrations are forward-only, run at boot; the daemon refuses a newer database.
- **Commit first, act second.** All events go through one serial queue; `applyEvent` is synchronous and in one transaction writes Task state, the `stage_events` row and `effects` rows. Adapters run only after commit, from the effects executor, idempotent by `effect_id`. Stage/step events carry `stage_id` and are ignored as stale unless it matches `tasks.current_stage_id`. The state diagram and generic events (`cancel`, `pause`/`resume`, `amended`, `stage_retries_exhausted`, `deps_unsatisfiable`) and the exact budget-counting causes are fixed in the spine; `transitions.ts` gets a table-driven test over every `(state, event)` pair.
- **Scheduler gate order:** Owner pause → usage window → concurrency → Review backpressure → dependencies → bootstrap accepted (skipped for bootstrap) → exclusive-capability hint. The failing gate is stored as `tasks.waiting_reason`; the usage gate is rechecked before every Stage launch.
- **Stages:** exactly one `claude -p` per Stage, `cwd` = Task worktree (Intake uses the read-only `_main` checkout), `stream-json` persisted to `data/stages/<stage_id>.jsonl`, `--json-schema` from the Role's zod schema, flags from resolved Role Config only. Output discriminators: Implementer `done|blocked`; Validator `pass|blocking|nonblocking` (+ `evidence_verdicts` in Evidence mode); Triage `rerun|park|stuck`; Evidence `artifacts[]`; Intake `OwnerInstruction`. Timeout is SIGINT then SIGTERM after 30 s on monotonic deadlines.
- **Role Config** is a directory (`prompt.md`, `mcp.json`, `permissions.json`, `role.yaml`) resolved package `roles/` ← `$ANTIPOD_HOME/roles/` ← repo `.antipod/roles/`, file by file; a new directory is a new Role. Settings resolve `config.yaml` ← `antipod.yaml` ← Task Contract.
- **Git:** plain bare clone per Project, read-only `_main` checkout, one worktree per Task on `antipod/<task_no>-<slug>`; Branch pushed after every Implementer Stage, then the Recipe `test` step runs. Inbox (`.antipod/inbox/*.yaml|*.md`) detection keyed by `(path, blob_sha)`. Recipe, Role Config, inbox and secret names are read only from `main` at `tasks.config_sha`.
- **Contract row is the record;** `.antipod/tasks/<task_no>.yaml` is a projection written and committed by the Coordinator on first entry to `implementing`. Stage briefs are rendered from rows, never from the file.
- **Steps:** one contract for container and host Runners (`cwd`, named secrets, `ANTIPOD_OUT`, `ANTIPOD_DATA`, `ANTIPOD_PRIOR`, `ANTIPOD_TASK`); Stages invoke steps only via `antipod step <name>` over `$ANTIPOD_HOME/run/antipod.sock`. Exclusive host capabilities are leased in `capability_leases`; busy is a retry, never a budget unit. Only the host adapter knows the OS.
- **Evidence** is immutable and written only by the Evidence Producer; ingest copies, fsyncs, then inserts the row; repeats mark earlier rows `superseded`. Composites and callouts come only from the `antipod-evidence` CLI (`sharp`, bundled Inter, DESIGN.md tokens). Peek is the only read of unrecorded files.
- **Telegram:** persisted `update_id`; every send/edit is an `outbox` row drained per chat in sequence, one Review sequence at a time; `callback_data` is `cb:<ulid>` bound to Task state and `review_round`; previous round's keyboard retired when a new Review round begins (entry from `verifying`); `undone`/`resume` keep the round and the card. HTML parse mode only, one template module per card kind in `adapters/telegram/cards/`, captions ≤ 1024 and texts ≤ 4096 truncated by the template; `setMyCommands` at boot.
- **Integration:** after the 10 s Undo window, rebase on `origin/main`, re-run `test` and Validator, fast-forward merge, push, run `release` if declared; failure returns the Task to the Implementer (one budget unit). `main` is never rolled back.
- **Usage and cost** go through `core/coordinator/usage.ts` only; `WindowReader` reads the OAuth usage endpoint and returns `null` on any failure, falling back to the core estimator; per-Stage window share is the utilization delta after the Stage.
- **Recovery** is crash-only: at boot mark running Stages `failed(restart)`, re-run undone effects, resend outbox, clear leases, delete orphan Evidence files. Wall-clock jumps over 60 s extend deadlines and queue one silent `back_online` per Project.
- **Ops and tests:** `ANTIPOD_HOME` selects the instance (never use `~/.antipod` in dev/tests); launchd plist `com.agxmeister.antipod`; pino JSON logs with `project_id`/`task_id`/`stage_id`; `antipod backup` (`VACUUM INTO` + rsync) and `antipod upgrade`. vitest; core tested with in-memory port fakes; adapters with fakes (fake `claude` on PATH, grammY transformer, temp git remote, Podman with busybox, file-backed SQLite); one e2e smoke test of `recipes/examples/openscad.yaml` bootstrap. Owner-visible failures become `outbox` notices. Stack: Node 24, TypeScript 7.0, grammY 1.46, better-sqlite3 13, zod 4.6, pino 10, sharp 0.35, vitest 4, pnpm.

## UX & Interaction Patterns

- One private supergroup per Project (`Antipode · ${Project}`), Owner plus bot. Copy is a team lead's status report: no apologies, greetings or exclamation marks; glyphs always followed by a word; approximate durations, local times; never mention Stages or Roles except in `/log` and Peek.
- Review order: one silent Evidence message per criterion (caption `<b>#id · ACn</b> glyph label`), then the silent Demo (`Demo · what to try`), then the Review card (the only one with sound) holding summary, criteria strip, Parking Lot, cost line `~tok · min · % window` and `Accept` / `Request changes`. Cards are edited in place; Accept shows `Undo` for 10 s; stale taps get `This Review was replaced by a newer one.`
- Sound only on Review card, Stuck, Release failed, Onboarding blocked, Registration failed; everything else `disable_notification`.
- Draft card: goal, numbered criteria with Evidence kind, ≤ 2 questions with quick-answer buttons, `Approve after: …` until ready, `⚠️` infeasible criteria with `Use proposal` / `Drop ACn`; Discard undoable 1 min.
- Task targeting: reply to a bot message → explicit id → single matching Task → candidate buttons. Free text with no target goes to Intake.
- Correction: force-reply `What should change on #id?`; a note-only Correction goes straight back; criteria changes need an Interpretation card. Stuck card: reason, up to 3 attempts, `Raise budget +2` · `Cancel Task` (confirm in place).
- Commands: `/register`, `/status`, `/peek`, `/parked`, `/cost`, `/pause`, `/resume`, `/cancel`, `/evidence`, `/log`. Exact copy for every state and empty case is in EXPERIENCE.md State Patterns; composite and callout tokens in DESIGN.md.

## Cross-Story Dependencies

- 1.1 (scaffold, config, SQLite, migrations, test fakes) underpins everything; 1.2 (domain, FSM, effects, recovery) is the base for all Coordinator-driven stories; 1.3 builds on 1.2.
- Adapters 1.4 (Telegram), 1.5 (git, Recipe, `/register`), 1.6 (step runners) and 1.7 (claude CLI, Role Config) are mostly parallel after 1.2 and are consumed by every flow story.
- 1.8 Intake needs 1.4, 1.5, 1.7; 1.9 needs 1.6, 1.7; 1.10 needs 1.6, 1.9; 1.11 needs 1.4, 1.10; 1.12 needs 1.11 and 1.5/1.6; 1.13 needs the full loop through 1.12.
- 1.14–1.17 extend the loop: 1.14 relies on Intake (1.8) and Interpretation flows; 1.15 on Evidence and Stage records; 1.16 on the scheduler usage gate (1.3) and Stage results (1.7); 1.17 on Triage parking (1.9) and Intake drafts (1.8).
- Later epics depend on this one: Android onboarding (epic 2) uses the Recipe, runners and bootstrap; voice intake (epic 3) plugs a `Transcriber` into Intake; Unity/OpenSCAD (epic 4) add Recipes and Role Config MCPs.
