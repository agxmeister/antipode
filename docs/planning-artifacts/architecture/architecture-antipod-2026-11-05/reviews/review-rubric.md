---
title: Architecture Spine Review — good-spine rubric
subject: ../ARCHITECTURE-SPINE.md
inputs: prd.md, addendum.md, EXPERIENCE.md
reviewer: independent (rubric lens)
date: 2026-11-05
---

# Review: ARCHITECTURE-SPINE.md against the good-spine checklist

**Verdict:** The spine is strong on the core (FSM, hexagonal boundaries, Telegram outbox, git topology, secrets) and reads as decisions rather than rationale, but it is not yet safe to hand to parallel epic/story agents: the Stage-to-StepRunner call path is undecided, files read from a Task branch (Role Config, Recipe) form an unguarded trust boundary, the transition table omits events the PRD and UX require, and the testing and operations dimensions are silent.

Severity key: **critical** = separately built units will diverge or the system is unsafe as specified; **high** = a real divergence point or missing dimension; **medium** = gap that a story author must guess at; **low** = polish.

---

## Critical

### C-1 — How a Stage invokes a Recipe step is undecided (AD-6, AD-7, sequence diagram)
- **What's wrong:** AD-7 says steps "the agent or the Coordinator invoke run through `StepRunner`", and the sequence diagram draws `S->>R: build/test steps` from the `claude -p` subprocess straight to the StepRunner. But a Stage is a subprocess on the host with no secrets and no in-process access to `core/ports`; nothing says *how* it reaches a Runner. The Implementer story could shell out to `./gradlew` directly (bypassing the container, secrets, `ANTIPOD_OUT` and the exclusive lock), while the Evidence Producer story invents an `antipod step evidence` CLI or an MCP tool. That is exactly the "two Runner paths" AD-7 claims to prevent, and it also breaks AD-1 ("adapters never import each other") as drawn.
- **Fix:** Add a rule to AD-7 (or a new AD): "A Stage invokes a Recipe step only through the `antipod step <name>` command on the Stage's PATH (or a single `antipod-steps` MCP server). That command talks to the daemon over a local Unix socket and the daemon runs the step through `StepRunner`; the Stage never sees step secrets or the container. Direct invocation of build tools by a Stage is a Role permission violation." Then redraw the sequence diagram as `S->>C: step request` / `C->>R: run step`.

### C-2 — Files read from the Task branch form an unguarded trust boundary (AD-5, AD-14, AD-15)
- **What's wrong:** AD-15 lets a Project override any Role file at `.antipod/roles/<role>/` in the repo, and AD-5 puts the Recipe (`antipod.yaml`) and the contract on the branch. The Implementer Stage writes to that branch. It can therefore rewrite `validator/permissions.json`, `validator/prompt.md`, or add `PROD_*` secrets to the `test` step, and the next Stage of the *same Task* would run with the altered config. AD-14's "validation on every change on `main`" does not cover a branch. The spine never states which ref Role Config, Recipe and contract are read from, so one story will read the worktree and another the mirror's `main`.
- **Fix:** Add to AD-15 and AD-5: "Role Config overrides, `antipod.yaml` and secret names are read only from the mirror's `main` at the moment the Task was queued (pinned by commit SHA in the `tasks` row), never from the Task worktree. A branch that changes `antipod.yaml` or `.antipod/roles/` is validated and takes effect only after merge." State explicitly that the Task Contract on the branch is read-only for Stages (the Implementer's permission rules deny writes to `.antipod/`).

---

## High

### H-1 — The transition table misses events the PRD and UX require (AD-3 state diagram)
- **What's wrong:** Stories for Owner controls, Stage failures, contract edits and release will each invent their own edges. Missing or wrong:
  - `stuck` is reachable only from `implementing`; FR-12 says a Stage that exhausts retries (Validator, Evidence Producer, Intake, Triage) also makes the Task Stuck.
  - `pause` only from `queued`/`implementing`; FR-14 says "at any time". `cancel` only from `stuck`; FR-14 allows cancel from any non-terminal state, and EXPERIENCE has `Cancel Task` on review and stuck cards. `in_review → cancelled` is absent.
  - `paused → queued: resume` loses the pre-pause state (a Task paused in `implementing` must not re-enter the scheduler queue and burn a budget unit).
  - "Editing the contract of a Task in progress restarts it from implementing" (FR-14, EXPERIENCE Interpretation card) has no event.
  - `integrating → in_review: post_accept_implementer_ran` contradicts FR-29: after a rebase failure the Task goes `integrating → implementing`, then through validating/evidencing to `in_review` by the normal path. The direct edge is wrong.
  - `release_failed` has no state or event; EXPERIENCE offers `Retry release` / `Leave it`, and FR-30 says the Task completed at merge. `released` cannot carry "merged, release failed, retry pending".
  - The Accept `Undo` window (10 s) has no state: `in_review → accepting(undoable) → integrating`.
  - Usage-window pause (FR-17) is shown as a scheduler gate (AD-11) but the UX also pauses *running* Tasks ("waiting for usage window"); say whether a running Stage is killed, left to finish, or only new Stages are gated.
- **Fix:** Extend the table: `* (non-terminal) → cancelled: cancel`; `* (active) → paused: pause` with `paused → <previous>` on resume; `<any stage state> → stuck: stage_retries_exhausted`; `in_review → accepting: accepted`, `accepting → in_review: undo`, `accepting → integrating: undo_expired`; `integrating → release_failed: release_failed`, `release_failed → integrating: retry_release`, `release_failed → released: leave_it`; `<active> → implementing: contract_amended` (resets budget, per EXPERIENCE). Remove `integrating → in_review`. State the usage-window rule for running Stages in AD-11.

### H-2 — Stage output discriminators that drive transitions are deferred (Deferred "Exact Stage output schemas", AD-3, AD-4)
- **What's wrong:** Every FSM event in AD-3 (`implementer_done`, `blocking_findings`, `nonblocking_findings`, `pass`, `evidence_produced`, `evidence_missing`, `rerun`, `parked`, `evidence_verified`) is derived from a Stage's JSON output, yet the output shape is deferred to "the Role directories and the code". The agent writing the Validator Role and the agent writing `transitions.ts` will pick different field names and enumerations. This is the single most likely divergence between parallel stories.
- **Fix:** Keep the full schemas deferred, but fix the discriminators in AD-4: `ImplementerOutput.status: done | blocked`; `ValidatorOutput.verdict: pass | blocking | nonblocking` plus `findings[{criterion_id, blocking, note}]` and, in evidence mode, `evidence_verdicts[{evidence_id, shows_criterion}]`; `TriageOutput.decision: rerun | park`, `reason`; `EvidenceOutput.artifacts[...]` (already in AD-8); `OwnerInstruction` (already in AD-9). Add the rule: "the Coordinator maps each discriminator to exactly one event; any output that fails schema validation is a Stage failure under the retry policy, never an event."

### H-3 — Stage retry policy is referenced but never defined (AD-4, AD-12, AD-18; FR-12)
- **What's wrong:** AD-18 applies "the normal retry policy" and FR-12 requires a configured retry limit, but no AD says what is retriable (timeout, non-zero exit, invalid JSON, `max_turns` reached), where the limit lives (`role.yaml`? `config.yaml`?), whether a retry increments the Iteration Budget, or whether a retried Implementer starts from the worktree as left by the failed run. Two stories will decide differently.
- **Fix:** Add to AD-4: "A Stage fails on timeout, non-zero exit, output that does not validate, or `max_turns` exhaustion. `role.yaml` sets `retries` (default from `config.yaml`). A retry re-launches the same Stage with the same brief on the worktree as left; it does not consume Iteration Budget. After `retries` failures the Coordinator emits `stage_retries_exhausted`." Reference it from AD-18.

### H-4 — Testing strategy is entirely silent (whole dimension)
- **What's wrong:** No AD, convention, or deferred item mentions tests. The hexagonal design makes a strong test strategy cheap to state, and without it each story will choose its own (or none): some will stub `claude -p`, others will hit the real CLI and the Owner's subscription; some will test Telegram against a live bot.
- **Fix:** Add a "Testing" row to Consistency Conventions or a short AD: test runner (`node:test` or `vitest`); `core/` is tested with in-memory fakes of every port, no I/O; `transitions.ts` has a table-driven test for every `(state, event)` pair; each adapter has a contract test against its port using a fake external (a fake `claude` script on PATH emitting a canned stream-json, a grammY transformer that captures API calls, a temp git remote, an in-file SQLite); no test uses the Owner's Claude login or the production bot token; one end-to-end smoke test runs the bootstrap of `recipes/examples/openscad.yaml` with the fake `claude`.

### H-5 — Operations envelope is partly silent: backups, log destination, upgrades, dev vs prod bot (whole dimension)
- **What's wrong:** Deployment is fixed (launchd, `~/.antipod`), but: nothing says where `pino` output goes (stdout under launchd to which file, rotation); nothing says how `antipod.db` and `data/` are backed up (Deferred covers off-machine *Evidence* only, not the system of record); nothing says how an upgrade is applied (`npm i -g`? git pull + build? are `migrations/` forward-only and applied at boot?); nothing distinguishes a development instance from the production one (second bot token, `ANTIPOD_HOME` override), so a developer story will test against the Owner's real chat. Worktree and branch cleanup after merge/cancel is also unstated (disk grows without bound).
- **Fix:** Add an "Operations" AD or conventions rows: logs → `~/.antipod/logs/antipod.log` via launchd `StandardOutPath`, rotated by size (`pino-roll` or `newsyslog`); `antipod backup` copies the DB with `VACUUM INTO` plus `data/` rsync to a path in `config.yaml`, scheduled by a second launchd job; upgrades = `antipod upgrade` (git pull, build, `launchctl kickstart`), migrations forward-only at boot, refusing to start if the DB is newer than the code; `ANTIPOD_HOME` env selects the instance, and `config.yaml` carries its own bot token so dev and prod are separate bots; worktrees are removed after `released`/`cancelled` (branch kept per FR-14), evidence already copied out per AD-8.

---

## Medium

### M-1 — Port/adapter map is incomplete and contradicts "exactly one port" (AD-1, Design Paradigm)
- **What's wrong:** AD-1 says an adapter implements exactly one port. `host/` implements `StepRunner` *and* the capability map *and* exclusive locks; `claude-cli` implements `AgentRunner` and (per the capability map) feeds `UsageMeter`; `sqlite/` implements `Store` and presumably `EvidenceStore`. `WindowReader` (AD-12) is not in the ports list. `Clock` has no adapter. No one owns `EvidenceStore` or `UsageMeter` adapters by name.
- **Fix:** Replace "exactly one port" with "an adapter implements one or more ports it is listed for"; add a Port → Adapter table: `AgentRunner → claude-cli`, `StepRunner → podman, host`, `Repo → git`, `Messenger → telegram`, `Store, EvidenceStore → sqlite (+ data dir)`, `UsageMeter → core (pure, writes via Store)`, `WindowReader → claude-cli (OAuth) | usage-estimate (core)`, `Transcriber → whisper`, `Clock → app`.

### M-2 — Preview Data (FR-5) is not designed
- **What's wrong:** FR-5 requires each Branch run and Demo to use its own Preview Data seeded from Recipe fixtures and discarded on merge/cancel. The Recipe shape has no `fixtures`/`preview_data` field, AD-7 has no step env for it, and the capability map points FR-5 at AD-7/AD-14 which only cover secrets.
- **Fix:** Either add to AD-7: "a Recipe may declare `fixtures: dir`; the Runner copies it to `ANTIPOD_DATA` (per worktree, under `data/worktrees/<project>/<task_no>/.antipod-data/`) before each step and deletes it on `released`/`cancelled`; steps read seed data only from `ANTIPOD_DATA`" — or move FR-5 Preview Data explicitly to Deferred with the statement that MVP Projects (Android, Unity, OpenSCAD) have no seeded data and the `fixtures` key is reserved.

### M-3 — Two registration paths and no bootstrap Task definition (FR-1, FR-3)
- **What's wrong:** The capability map puts registration in the `app/` CLI; EXPERIENCE Flow 0 registers with `/register <repo>` from the Telegram group (CLI as fallback). Which is the MVP path, and how the chat binding is created in the CLI case, is undecided. FR-3's bootstrap Task — who creates it, what its contract is (EXPERIENCE: one criterion per declared Evidence kind), what "trivial change" the Implementer makes — appears only as a scheduler gate in AD-11.
- **Fix:** Decide: "`/register <repo-url>` in a group is the only registration path; the `antipod` CLI exposes `register` for the same code path with `--chat-id`. On registration the Coordinator writes contract `#1` from a template: goal `Bootstrap`, one criterion per `evidence_kinds` entry, Required Evidence = that kind, and the Implementer brief asks for a no-op visible change (e.g. a version label)." Also resolve the chat-topology notes from EXPERIENCE: supergroup with privacy mode off, bot admin, and the group-to-Project binding stored in `projects`.

### M-4 — Contract file from `main` and Owner-named files conflict with per-Project sequential numbering (AD-5, AD-16, FR-6)
- **What's wrong:** AD-16 says the Task number is per-Project sequential and assigned by Antipode; AD-5 says a contract the Owner adds on `main` at `.antipod/tasks/<task_no>.yaml` is detected and "moved to a Branch". The Owner must then guess the next number, and "moved" implies Antipode commits a deletion to `main`, which no AD authorises (integration is fast-forward from a branch only). FR-6's BMad story mapping (`[ASSUMPTION]` → "an architecture concern") is absent.
- **Fix:** "Owner-added contracts live at `.antipod/inbox/<any-name>.yaml` (or `docs/stories/*.md` in BMad format); on detection Antipode assigns the next number, writes `.antipod/tasks/<n>.yaml` on the new Branch and leaves `main` untouched; the inbox file is deleted by the Task's first commit so it disappears on merge." Add a BMad mapping line: story title → goal, `Acceptance Criteria` list items → criteria, a `Evidence:` sub-bullet per AC → required evidence; a story without per-AC evidence goes to Intake (FR-6).

### M-5 — Progress Peek needs mid-round visuals that AD-8 forbids (AD-8, FR-28, EXPERIENCE Peek)
- **What's wrong:** AD-8: "Only the Evidence Producer Stage creates artifacts"; Peek "shows the newest artifact of the running round". The Evidence Producer runs *after* implementing, so during `implementing (lap 2/5)` the round has no artifact and Peek can only show the previous round — but EXPERIENCE expects "the latest render" from the Implementer. Two stories will diverge on whether Implementer screenshots count as Evidence.
- **Fix:** Decide one of: (a) Peek shows the newest Evidence of the previous round plus the status line, and Implementer output is never shown; or (b) add a non-Evidence `peek` artifact class: any Stage may write to `ANTIPOD_OUT/peek/`, the newest file there is shown by Peek, never ingested as Evidence, deleted with the worktree. Update AD-8 accordingly.

### M-6 — Intake has no defined conversational context (AD-9)
- **What's wrong:** Intake asks "at most one question per message", and the Owner's answer arrives as a new message that becomes a *new* Intake Stage. AD-4 lists the brief contents (contract, prior Evidence, Correction note, Parking Lot) but not the pending draft, open questions, or the message thread. One story will persist a "pending question" row, another will replay the chat history into the brief.
- **Fix:** Add to AD-9: "The Intake brief carries the Task's current contract or draft, the last `n` Owner messages and bot replies for that Task from `telegram_messages` (n in config), and any unanswered question row. An answer to a question is routed to Intake with the question id; a tapped quick-answer button is a Coordinator command that updates the draft without Intake."

### M-7 — Git remote credentials and bot token storage are unspecified (Security)
- **What's wrong:** The daemon fetches and pushes to GitHub and holds a Telegram bot token, but nothing says where either credential lives, and AD-14's secrets file is per-Project and for Recipe steps. A story could put the bot token in `config.yaml` world-readable, use the Owner's SSH agent (unavailable under launchd), or embed a PAT in the mirror's remote URL.
- **Fix:** Add to AD-14: "`~/.antipod/secrets/antipod.env` (mode 600) holds `TELEGRAM_BOT_TOKEN` and the git credential; git pushes use a deploy key at `~/.antipod/secrets/id_antipod` via `GIT_SSH_COMMAND` set only in the `git` adapter. Stages and steps never receive these."

### M-8 — Two mechanisms for exclusive host capabilities (AD-7, AD-11)
- **What's wrong:** AD-11 gates Task *start* on "exclusive capability free"; AD-7 takes a per-capability lock at *step* start. Both together mean a Task that needs the emulator only in its `evidence` step blocks every other such Task from starting at all, while the step lock alone would suffice. Stories will implement one, the other, or both inconsistently.
- **Fix:** Pick one: keep the step-level lock (AD-7) as the enforcement, and reduce the AD-11 gate to a *scheduling hint* ("do not start a Task whose Recipe names an exclusive capability already held by a running Task" — optional), or drop the gate.

### M-9 — Usage-window pause and the Mac-asleep case have no clock rule (AD-4, AD-11, AD-18)
- **What's wrong:** Timeouts are enforced by the Coordinator; if the Mac sleeps mid-Stage, a wall-clock timeout fires on wake and kills a Stage that was only suspended (PRD §6: "Tasks pause and resume; they do not fail"). EXPERIENCE's "Back online" notice and the 5-minute `/peek` drop have no owner.
- **Fix:** Add to AD-18: "Timeouts use monotonic elapsed time (`process.hrtime`/`performance.now`); on a detected clock jump > 60 s (sleep) running Stage deadlines are extended by the gap and a `back_online` notice is queued per Project. Telegram updates older than 5 min with `/peek` are dropped."

---

## Low

### L-1 — Status tags are inconsistent (AD-6, AD-13, AD-14, AD-17)
- AD-6 has `[ASSUMPTION]` and no `[ADOPTED]`; AD-13/14/17 put `[ASSUMPTION]` in backticks. Pick one form: `[ADOPTED, ASSUMPTION]` or a status line.

### L-2 — Stack rows are vague where they should be exact (Stack)
- "git 2.4x", "Homebrew current (not yet installed)". Give the installed versions or mark "any ≥ 2.40". The version lens will judge currency; this lens only asks that each row be a decision.

### L-3 — Verify `--permission-prompts none` exists (AD-4)
- The listed flags (`--json-schema`, `--append-system-prompt-file`, `--bare`, `--permission-mode`, `--allowedTools`, `--max-turns`, `--mcp-config`) are plausible for Claude Code 2.1.x; `--permission-prompts none` is not a flag this reviewer recognises. Non-interactive `-p` already denies un-allowed tools. Replace with the exact flag or drop it.

### L-4 — Container diagram arrows (Structural Seed)
- `TGAPI -- long polling --> D` points the wrong way (the daemon polls). `D` is first referenced before its subgraph declaration; declare the subgraph first to be safe across renderers. `C->>R: rebase, test, merge, release` in the sequence diagram sends git operations to the StepRunner; split into `C->>G: rebase, ff-merge, push` and `C->>R: test, release`.

### L-5 — Recipe seed contains an explicit placeholder (Structural Seed)
- "Image names above are placeholders the Owner replaces" conflicts with checklist item 8. Either use a real image the first Project will use or move the seed to `recipes/examples/` by reference.

### L-6 — Bootstrap Task is itself subject to the bootstrap gate (AD-11)
- State "the gate is skipped for the Task flagged `bootstrap`".

### L-7 — NFR-1 is in `binds` but no AD binds it
- Either bind it (e.g. AD-8: screencasts ≤ 60 s, ingest rejects longer; a Review has at most one media message per criterion) or drop it from `binds`.

### L-8 — Three Role Config layers, two stated (AD-15)
- The package ships `roles/`, the Owner has `~/.antipod/roles/`, the Project has `.antipod/roles/`. Write the three-layer order explicitly, file-by-file.

### L-9 — FR-7 allows two questions per draft, AD-9 allows one per message
- Compatible, but say that a `new_draft` may carry up to two `questions[]` while `question` (the clarifying-question variant) carries one.

---

## Checklist scorecard

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Fixes the real divergence points, misses none | **Fails** — C-1, C-2, H-1, H-2, H-3, M-3, M-5, M-6 |
| 2 | Every Rule enforceable and preventing its divergence | Mostly — AD-1 "exactly one port" is self-contradicted (M-1); AD-7 step-writes-only is a convention on the host Runner; AD-8 blocks Peek (M-5) |
| 3 | Nothing under Deferred lets two units diverge | **Fails** — "Exact Stage output schemas" (H-2); Preview Data not even listed (M-2) |
| 4 | Named tech plausible-current | Passes, with L-2 and L-3 |
| 5 | Covers FR-1..31, NFR-1..6 | Gaps: FR-3 (M-3), FR-5 Preview Data (M-2), FR-6 story mapping (M-4), FR-12 retries (H-3), FR-14 edges (H-1), FR-30 retry (H-1), NFR-1 unbound (L-7) |
| 6 | Every dimension decided/deferred/open | **Fails** — testing silent (H-4); backups, logs, upgrades, dev/prod split silent (H-5); credentials (M-7) |
| 7 | Mermaid valid and structural | Syntactically valid; semantic errors in the state and sequence diagrams (H-1, C-1, L-4) |
| 8 | Terse, no placeholders, no template comments | Passes, with L-1, L-5 and short rationale in AD-6 and Deferred |

**Recommendation:** resolve C-1, C-2, H-1, H-2, H-3 before any epic is cut; add H-4 and H-5 as a single "Operations & Testing" section; fold the medium items into the affected ADs in the same pass.
