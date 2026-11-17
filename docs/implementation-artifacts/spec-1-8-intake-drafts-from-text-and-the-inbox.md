---
title: 'Intake drafts from text and the inbox'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: 'daa592ec1cd8483cad6bf961f842a5e8d1b375a3'
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
- [x] `src/adapters/sqlite/migrations/0008-contracts.ts`, `src/core/ports/store.ts`, SQLite store -- rows and methods -- AD-2, AD-21
- [x] `src/core/domain/contract.ts`, `owner-instruction.ts`, `events.ts`, `effects.ts` -- domain, schemas, payloads -- AD-9, AD-16
- [x] `transitions.ts`, `coordinator.ts`, `scheduler.ts` -- Intake in `draft`, approval guard, undo, `commit_contract` on entry -- AD-3, AD-21
- [x] `src/core/ports/repo.ts`, `src/adapters/git/repo.ts` -- tree listing, worktree commit with removal -- AD-5
- [x] `src/app/intake.ts`, `src/app/stages.ts`, `src/app/daemon.ts` -- hook, brief, inbox scan, handlers -- AD-4, AD-9
- [x] `src/adapters/telegram/{poller.ts,cards/draft-card.ts,messenger.ts}` -- text routing, Draft card, commands -- AD-10, DESIGN
- [x] `test/**` -- one test per matrix row, plus a `transitions.test.ts` table update -- AD-24

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

## Review Triage Log

Pass 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG).

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | BH/EC/VG: `renderDraftCard` inserts a `bot` intake message on every open render; escaped entities | medium | `draft-card.ts` inserts unconditionally whenever `isOpen`; each tap re-renders, filling the `context_messages` window | patch |
| 2 | BH/EC/VG: `approveDraft` checks dependency refusal after `#applyNow` applied | low | Unreachable today (`approvalRefusal` runs first in the same transaction), but the branch would commit `queued` without deps; fix is a reorder | patch |
| 3 | BH/EC: one throwing inbox entry aborts the whole scan | medium | `scanInbox` loop has no per-entry catch; `readFile`/`createTask` throw propagates | patch |
| 4 | BH/EC: `Intake.tick` stops at the first `requestInboxScan` throw | low | Loop has no per-Project catch; trivial fix | patch |
| 5 | EC: `commitInWorktree` commits the whole index | low | `git commit` without pathspec; trivial fix | patch |
| 6 | EC: all-dropped inbox YAML counts as complete | low | `isCompleteContract` checks only kinds; one-line fix | patch |
| 7 | VG: missing tests (changed blob wait/new draft, inbox failure notice, refusal toast/card line, draft_reply answers/foreign id/not_actionable on revision, context_messages cap) | medium | `grep` finds no covering test for each branch | patch |
| 8 | BH/EC: `commit_contract`/`prepare_branch` failure only marks the effect failed; `start_stage` still runs; no Owner notice | medium | `EffectExecutor.#runOne` marks failed and continues with the next row (pre-existing executor behavior) | defer |
| 9 | EC: removing the inbox file on the Branch may delete a newer unimported blob at that path | medium | `commitContract` removes `source.path` regardless of blob | defer |
| 10 | EC: reply to a card whose draft is in `draft` or `discard_pending` starts an unrelated new draft | medium | `onText` falls through to `createTask` when state is not `awaiting_approval`; spec does not say what such a reply does | defer |
| 11 | BH/EC: Intake failing on a revision cancels the whole draft; `closed: 'cancelled'` renders no closing line | medium | Spec says `stage_retries_exhausted` in `draft` cancels; whether that covers revisions, and the closing copy, need an Owner decision | defer |
| 12 | EC: Approve uses the local `origin/main` without fetching | low | Up to `git.fetch_interval_ms` stale; spec says "current main SHA" | defer |
| 13 | VG: no test for `git.fetch_interval_ms` gating | low | Cost, not correctness | defer |
| 14 | BH: Recipe-unreadable fallback differs across hook, scan and Approve | low | Rare (Recipe validated at registration); no button to resolve in that case | reject |
| 15 | EC: symlinked `.antipod` in the Branch lets the projection write outside the worktree | low | Owner's own repo; unlikely; fix adds guards | reject |
| 16 | EC: two `new_draft` instructions in one output, last wins | low | Schema-valid but unlikely; adds a branch | reject |
| 17 | EC: generic `cancel` from `awaiting_approval` leaves live buttons | low | No path emits `cancel` there before 1-14; taps would get the stale toast | reject |
| 18 | EC: `q_no` restarts after revision so an old button answers a new Q1 | low | The card is edited in place, so old buttons are replaced | reject |
| 19 | EC: ready-path `draft_ready` ignored would strand the Task | false | A just-created `draft` Task always accepts `draft_ready` without `stage_id` | reject |
| 20 | EC: answering a question does not bump `contract_version` | false | Questions are draft rows, not contract rows; the spec's bump rule is about criteria | reject |
| 21 | BH: spec and sprint status disagree | false | Workflow syncs sprint status at presentation | reject |
| 22 | BH: approval checks run three times | low | Redundant work only, no harm | reject |
| 23 | BH: first scan is at the first 1 s tick, not at boot | low | Negligible | reject |
| 24 | BH: `commitInWorktree` rejects `..x` names, never pushes | false | Paths are fixed `.antipod/tasks/N.yaml`; Branch push is 1-9 per spec | reject |
| 25 | BH: `intake_failed` with no Task throws | false | Effect always carries `task_id` | reject |
| 26 | BH: refusal toast has no length cap | low | Reasons are short fixed strings | reject |
| 27 | BH: text drafts cannot carry `depends_on` | false | By design; Intake output has no deps in this story | reject |
| 28 | BH: `poller.ts` ticked but unchanged; `daemon.test` reaction assertion loosened | low | `onText` already existed and is wired in `daemon.ts`; looser assertion still checks message 9 only | reject |
