---
title: 'Intake drafts from text and the inbox'
type: 'feature'
created: '2026-11-16'
status: 'ready-for-dev'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing creates a Task. Owner text reaches no handler (`poller.ts` `onText` is unset), inbox files are never scanned, there are no `contracts`/`criteria` rows, no Draft card and no approval path, so the loop cannot start (CAP-4, CAP-6, CAP-7 text, CAP-8, CAP-9; AD-3, AD-5, AD-9, AD-16, AD-21).

**Approach:** Untargeted Owner text and new inbox files create a `draft` Task (creation event `new_draft`). Intake runs in `draft` on `_main` and its `OwnerInstruction` fills versioned `contracts`/`criteria` rows plus up to two questions, then `draft_ready` sends a silent Draft card. Quick-answer, `Use proposal`, `Drop ACn`, `Approve`, `Discard` and `Undo` are Coordinator commands. A reply to the card is `draft_reply` and reruns Intake. `approved` assigns `task_no`, records dependencies and creates the Branch and worktree. The first entry to `implementing` commits `.antipod/tasks/<task_no>.yaml` from the rows and `git rm`s the inbox file.

## Boundaries & Constraints

**Always:**
- Feasibility: a criterion is feasible when its `required_evidence` is in the Recipe `evidence_kinds` at `tasks.config_sha` and it carries no open `⚠️` proposal. The Coordinator refuses `approved` while any active criterion is infeasible or any question is unanswered, even when a stale `Approve` button is tapped.
- Intake output (zod, `--json-schema`): a `new_draft` criterion's `required_evidence` is an `evidenceKindSchema` value. An optional `infeasible {wanted, proposal}` gives the line `AC3 ⚠️ can't evidence <wanted> · proposed: <proposal>`.
- `AC<n>` is assigned in contract order and never reused. `Drop ACn` sets `status = dropped`. Every row change bumps `contracts.contract_version`.
- Button taps never start a Stage. A quick-answer tap records the answer on the draft row and edits the card in place, staying in `awaiting_approval`.
- A text reply to the Draft card is `draft_reply`. Its text joins the brief, Intake reruns, and the card is edited in place, never reposted.
- The Intake brief comes from rows: source text or inbox file content, current contract, unanswered questions, and the last `intake.context_messages` Owner/bot messages of the Task.
- Inbox: `.antipod/inbox/*.yaml|*.md` on `main`, keyed by `(path, blob_sha)` in `contract_sources`. A recorded pair is never offered again. A new `blob_sha` at a path whose Task is terminal is a new draft. `.antipod/tasks/` is never scanned. A `.yaml` that parses as a Task Contract with feasible per-criterion evidence becomes rows and a Draft card with no Stage. Every other file goes through Intake.
- `not_actionable` cancels the scratch draft silently, leaving only the `👀`. After `intake.retries`, `stage_retries_exhausted` in `draft` cancels it, replaces `👀` with `❌` and replies `Couldn't process that — send it again.`
- Discard: `discard_pending` with `undo_expires_at = now + limits.undo_discard_ms`. `Undo` returns to `awaiting_approval`. `undo_expired` → `cancelled` removes the card's buttons.
- Approve: toast `Queued.`, card state `⏳ Queued · starts next`. `config_sha` = current `main` SHA, Branch `antipod/<task_no>-<slug>` and worktree via `Repo.addTaskWorktree`. Dependencies from a contract file are recorded; a cycle, or a dependency on a bootstrap Task, refuses approval with the reason on the card (deferred from 1-3).
- Contract projection: `commit_contract` is the first effect on entering `implementing`, ahead of `start_stage`. It writes the YAML from rows, commits `antipod: contract v<version>` on the Branch, and in the first commit also `git rm`s the source inbox file. It is idempotent per version.

**Never:**
- No `correction`, `amendment`, `cancel`, Interpretation card or Task-candidate targeting (1-14). Such outputs stay `unhandled_output` → retried → `❌`.
- No voice (3-19), `promote_finding` (1-17), Implementer brief from contract rows or Branch push (1-9).
- Never read criteria from `.antipod/tasks/*.yaml`. Never edit committed migrations 0001–0007.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Text request | untargeted text | `👀`; draft Task; Intake; silent Draft card | — |
| Question open | `new_draft` with Q1 | `Approve after: answer Q1`, Q1 quick-answer row, no `Approve` | — |
| Quick answer | tap `Not yet` | answer stored, card edited, `Approve` shown | stale tap → toast |
| Infeasible AC | `infeasible` set | `⚠️` line, `Use proposal`/`Drop AC3` | `approved` refused |
| Reply revises | reply to card | `draft_reply` → Intake → v+1, card edited | — |
| Not actionable | `ok` | Task `cancelled`, nothing sent | — |
| Intake fails | fake crashes 3× | `❌` + `Couldn't process that — send it again.` | — |
| Discard/Undo | Discard, Undo within 60 s | `discard_pending` → `awaiting_approval` | after 60 s → `cancelled` |
| Approve | all resolved | `task_no`, Branch, worktree, `Queued.` | cycle → refused |
| Inbox complete YAML | new `inbox/a.yaml` | one card, no Stage | invalid YAML → Intake |
| Inbox story | new `inbox/b.md` | Intake from file → card | — |
| Inbox repeat | same `(path, blob_sha)` | nothing | — |
| Enter implementing | queued → implementing | `commit_contract` before `start_stage`; inbox file removed | — |

## Owner decisions (2026-11-16)

- **Scope.** One spec. The Owner kept it whole over the 1600-token target.
- **Draft label.** Follow the spine: no number before approval. The title is `<b>${task-title}</b> · draft`, and once approved it becomes `<b>#${task_no} · ${task-title}</b>` with `⏳ Queued · starts next`. DESIGN `draft-card.titlePattern` and EXPERIENCE Flow 1 still show `#12` on a draft; that doc fix goes through `bmad-correct-course`, not this story.
- **Discard copy.** While pending, the state line is `Discarded · undo within 1 min` with a single `Undo` button. On `undo_expired` it reads `Discarded` with no buttons.
- **Inbox fetch.** There is a new config key `git.fetch_interval_ms`, default 60000. Each Project is fetched at boot and on that interval, and the inbox is scanned after every fetch. Adding the key to `config-defaults.md` goes through `bmad-correct-course`.

</frozen-after-approval>

## Code Map

- `src/adapters/sqlite/migrations/0008-contracts.ts` (new) -- `contracts(task_id, version, goal)`, `criteria(task_id, ac_no, text, required_evidence, infeasible_wanted, infeasible_proposal, status)`, `draft_questions(task_id, q_no, text, quick_answers, answer)`, `contract_sources(project_id, path, blob_sha, task_id)`, `intake_messages(task_id, sender, text, at)`, `tasks.slug`, `tasks.title`
- `src/core/domain/contract.ts` (new) -- row types, `isFeasible`, `contractFileSchema` (inbox and projection YAML), `projectContract(rows) → yaml`
- `src/core/domain/stage-output/owner-instruction.ts:6` -- `required_evidence` → `evidenceKindSchema`; optional `infeasible`
- `src/core/domain/events.ts:35-40,105` -- payloads for `new_draft` (source text or inbox path/sha), `draft_reply` (text), `approved` (deps)
- `src/core/coordinator/transitions.ts:55,186-196` -- `STAGE_ROLES.draft = 'intake'`; approval guard; `queued→implementing` emits `commit_contract` before `start_stage`; `stage_retries_exhausted` in `draft` → `cancelled` + intake-failed notice
- `src/core/coordinator/coordinator.ts:116` -- `createTask` is the entry point for drafts (no callers yet)
- `src/core/coordinator/scheduler.ts:162` -- `launchGuard`: Intake skips every gate except usage; `#notifyWait` must not render a numberless Task (`cards/index.ts:19`)
- `src/core/domain/effects.ts:9` -- add `commit_contract`, `prepare_branch`, `scan_inbox`
- `src/core/ports/store.ts` -- contract, criteria, question, source and intake-message methods; reuse `nextTaskNo`, `insertDependency`, `insertCallback`, `latestCardOfTask`
- `src/core/ports/repo.ts`, `src/adapters/git/repo.ts:145,209` -- add `listTree(name, sha, dir) → {path, blob_sha}[]` and `commitInWorktree(worktree, files, removals, message)`; reuse `readFile`, `fetch`, `mainSha`, `syncMain`, `addTaskWorktree`
- `src/app/intake.ts` (new) -- Intake output hook (`stages.setOutputHook('intake')`), applying `new_draft`/`draft_reply`/`not_actionable`; inbox import
- `src/app/stages.ts:279,384` -- `renderBrief` joins rows and `intake_messages` for Intake
- `src/adapters/telegram/poller.ts:173,247` -- register `onText`: reply to a draft card → `draft_reply`, else `new_draft`; record Owner and bot text in `intake_messages`
- `src/adapters/telegram/cards/draft-card.ts` (new) -- DESIGN `draft-card` blocks and buttons, truncated to one screen; callbacks `answer`, `use_proposal`, `drop`, `approve`, `discard`, `undo` bound to states
- `src/app/daemon.ts:195-252` -- register handlers and the hook; per-Project fetch timer (boot + `git.fetch_interval_ms`) → `scan_inbox`
- `src/app/config.ts` -- `git.fetch_interval_ms` (default 60000)
- Tests: `test/helpers/{telegram,git,claude,store,clock}.ts`. `createTempRemote` is a non-bare repo on `main`, so only commit inbox files there.

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/sqlite/migrations/0008-contracts.ts`, `src/core/ports/store.ts`, SQLite store -- rows and methods -- AD-2, AD-21
- [ ] `src/core/domain/contract.ts`, `owner-instruction.ts`, `events.ts`, `effects.ts` -- domain, schemas, payloads -- AD-9, AD-16
- [ ] `transitions.ts`, `coordinator.ts`, `scheduler.ts` -- Intake in `draft`, approval guard, undo, `commit_contract` on entry -- AD-3, AD-21
- [ ] `src/core/ports/repo.ts`, `src/adapters/git/repo.ts` -- tree listing, worktree commit with removal -- AD-5
- [ ] `src/app/intake.ts`, `src/app/stages.ts`, `src/app/daemon.ts` -- hook, brief, inbox scan, handlers -- AD-4, AD-9
- [ ] `src/adapters/telegram/{poller.ts,cards/draft-card.ts,messenger.ts}` -- text routing, Draft card, commands -- AD-10, DESIGN
- [ ] `test/**` -- one test per matrix row, plus a `transitions.test.ts` table update -- AD-24

**Acceptance Criteria:**
- Given the fake `claude` returning `new_draft` with one question, when the Owner texts the bot, taps the quick answer and taps `Approve`, then the Task has `task_no` 1, the Branch and worktree exist, the card was edited in place with no repost, and no budget unit was used.
- Given an approved Task entering `implementing`, when effects drain, then the Branch head commit is `antipod: contract v<n>`, its YAML equals the projection of the rows, and the inbox file is gone on the Branch.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- Decided: Intake is held only by the usage gate. Concurrency, backpressure, dependency, bootstrap and capability gates are for Branch work.
- Decided: `Revise` is a reply to the card, not a button (DESIGN lists none).
- Decided: an untargeted message runs Intake on its own scratch draft. A `draft_reply` naming another draft is treated as unhandled until 1-14 targeting exists.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0

**Manual checks (if no CLI):**
- With a scratch `ANTIPOD_HOME`, a second bot and the fake `claude`: text the bot, then check that the Draft card renders on a phone within one screen.
