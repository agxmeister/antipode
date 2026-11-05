---
title: Adversarial review — Antipode Architecture Spine
lens: adversary (pairs of units built to the letter of the ADs that still clash)
target: ../ARCHITECTURE-SPINE.md (draft, 2026-11-05)
context: PRD prd-antipod-2026-11-01, EXPERIENCE.md ux-antipod-2026-11-05
created: 2026-11-05
---

# Adversarial review — Architecture Spine

**Verdict.** The spine fixes the big shape well (one process, one DB, one transition table, one Stage launch path, ports/adapters), but it leaves several seams where two teams each obeying every AD to the letter will build parts that do not fit. The worst are around *time*: the transition table is atomic but its effects are not, the Undo window has no state, and a killed or restarted Stage can still report into a Task that has moved on. The second cluster is *identity*: contracts have two homes (YAML on a Branch, rows in SQLite) and no rule for which wins or who writes; review rounds and callback staleness are defined by two different clocks. Twelve holes below, ordered by severity; each ends with proposed AD text.

Method: for each hole, two units one level below the spine (an epic, a Role Config, an adapter) are named, each is shown obeying the ADs, and the clash is shown. "Rule" text is written to drop into the spine as-is.

---

## H1 — Effects run outside the transaction; a scheduler tick and a Telegram callback can both win `[CRITICAL]`

**Pair.** `epic: Coordinator scheduler` (agent A) vs `epic: Telegram surface` (agent B).

**Each obeys the spine.** AD-3 says a transition is "applied in one SQLite transaction that also appends the event"; AD-11 says the scheduler evaluates gates "all from the database" and "returns the next actions". Agent A builds the tick as: `rows = select queued` → evaluate gates → for each winner `await agentRunner.start(task)` → apply `scheduler_start`. That is legal: the scheduler "holds no state of its own", and the transition is one transaction. Agent B builds `/pause` as: callback → apply `pause` transition in one transaction. Also legal.

**Clash.** Between A's `await start()` (spawning `claude -p`, creating the worktree, several hundred ms) and A's transaction, B's `pause` transaction commits. A's `scheduler_start` then either (a) fails against `paused` and the spawned `claude` process is orphaned with no `stages` row (invisible to AD-18 recovery — "a file without a row does not exist"), or (b) A applied `scheduler_start` first and then spawned, and B's `pause` committed in between, so the DB says `paused` while a Stage is running — exactly what FR-12 forbids. The same race exists between two scheduler ticks (the global concurrency gate counts `implementing` rows, which the first tick has not yet written) and between `implementer_done` and `cancel`. Node being single-threaded does not help: every `await` is a yield point.

Nothing in the spine says whether a transition commits *before* or *after* its effects, or that effects are themselves durable.

**Close it — tighten AD-3 and AD-18.**

> **AD-3 Rule (add):** A transition commits first and acts second. Applying `(state, event)` writes the new state, the `stage_events` row and one `effects` row per effect **in the same transaction**; no adapter is called inside it. An effect executor drains `effects` rows in insertion order after commit and marks each `done` or `failed`; an effect that spawns a Stage inserts the `stages` row with `status = starting` inside the transition, before any process exists. All events — scheduler ticks, Telegram callbacks, Stage results, timeouts, SIGHUP — enter through one in-process serial queue (`applyEvent` is synchronous; better-sqlite3 is synchronous), so no two transitions interleave. Gates (AD-11) count `stages.status IN (starting, running)`, never a process list.
>
> **AD-18 Rule (add):** At boot, `effects` rows not `done` are re-executed (effects are idempotent by `effect_id`); `stages` rows in `starting` are treated as `running` for the purpose of the `failed(restart)` sweep.

---

## H2 — The 10 s Undo window is a state the state machine does not have `[CRITICAL]`

**Pair.** `transition table` (agent A) vs `Telegram Review card` (agent B).

**Each obeys the spine.** AD-3's diagram has `in_review → integrating: accepted`, nothing else. AD-13 says Integration starts "on Accept (after the 10 s Undo window)". EXPERIENCE says the keyboard shows `[Undo]` for 10 s. Agent A applies `accepted` on the tap (adapters produce events, and this is a Coordinator command, AD-9) and the Task is `integrating`. Agent B keeps the Accept in memory, starts a `setTimeout(10_000)`, and only then emits `accepted`; it answers `Undo` by clearing the timer.

**Clash.** Under A, Integration begins at once (rebase, Validator Stage launched) and `Undo` has no transition to apply — `integrating → in_review` exists only as `post_accept_implementer_ran`, which is a lie here and would also leave a rebased worktree and a running Validator Stage. Under B, the Accept lives only in the adapter's memory, which AD-18 forbids ("no component keeps state it cannot rebuild from the database"); a crash in the window loses the Accept, and AD-10's `callbacks.expires_at` is the only persisted timer and it belongs to the *button*, not the *Task*. Neither team can be told they broke an AD.

**Close it — new state in AD-3, new rule in AD-13.**

> **AD-3 diagram (add):** `in_review → accept_pending: accepted`; `accept_pending → in_review: undone`; `accept_pending → integrating: undo_expired`.
> **AD-3 Rule (add):** `accepted` stores `tasks.accept_expires_at = now + undo_window_ms`. The scheduler tick emits `undo_expired` for every `accept_pending` Task whose deadline has passed; `undone` is accepted only while `accept_expires_at` is in the future. No Integration effect (rebase, Validator, test, merge) may be an effect of `accepted`; all of them are effects of `undo_expired`. The Review Queue (AD-11 backpressure) counts `in_review` and `accept_pending` alike as unanswered until `undo_expired`.
> **AD-13 Rule (replace first words):** "On `undo_expired` the Coordinator rebases …".

---

## H3 — A killed, paused, restarted or amended Stage can still report into a Task that moved on; and every re-entry burns Iteration Budget `[HIGH]`

**Pair.** `claude-cli adapter` (agent A) vs `transition table + recovery` (agent B).

**Each obeys the spine.** AD-4: the adapter runs the Stage, persists the stream, and when the `result` message arrives it emits the typed event (`implementer_done`). AD-3: `implementing → paused: pause`; `stuck → implementing: amended_or_budget_raised`; FR-14: a contract edit "restarts it from the implementing state". AD-18: at boot every `running` Stage is `failed(restart)` and the "normal retry policy" applies. Agent B therefore kills the process on `pause`/`cancel`/`amended` (FR-12: "no agent session runs while a Task waits for the Owner"). Agent A emits `implementer_done` from whatever the process printed before SIGINT — a `claude -p` interrupted with SIGINT still prints a final `result` message — because AD-4 says the result "enters the core as a typed event".

**Clash.** (1) The event from the dead Stage arrives after the Task is `paused` (no transition: dropped silently, or worse, `(paused, implementer_done)` is unmapped and throws) or after an amendment restarted the Task into a *new* `implementing` Stage — then the stale result advances the Task past the new Stage, which is still running, and the Validator reads a tree the new Implementer is editing. Nothing ties an event to the Stage that produced it. (2) The spine's budget rule ("the `implementing` entry increments the Iteration Budget counter unless the cause is `correction`") makes `resume → queued → scheduler_start → implementing` and `failed(restart) → retry` each cost one unit. PRD FR-13 lists the causes that count (blocking findings, Triage, missing Evidence, failed Integration); an Owner pause, a Mac going to sleep, or a Stage crash retry is not one of them, and the Stuck rate (SM-4) would be inflated by the Owner's own pauses. (3) EXPERIENCE says an amendment gives "a fresh Iteration Budget at its contract default" and `Raise budget +2` "adds 2 runs to the spent budget"; the spine has one counter and no reset rule, so agent B picks one and the Stuck card copy is wrong for the other.

**Close it — tighten AD-3 and AD-4.**

> **AD-4 Rule (add):** Every Stage event carries `stage_id`. The transition table applies a Stage event only if `stage_id = tasks.current_stage_id` and that Stage's row is `running`; otherwise the event is appended to `stage_events` as `ignored(stale)` and does nothing. A Stage ended by the Coordinator (pause, cancel, amendment, timeout) has its row set to `cancelled(<reason>)` *before* the signal is sent, so its own `result` can never be current.
>
> **AD-3 Rule (replace the budget sentence):** The Iteration Budget counts Implementer Stages whose *cause event* is one of `scheduler_start` (first run only), `blocking_findings`, `rerun`, `evidence_missing`, `rebase_or_revalidation_failed`. `correction`, `resume`, `retry`, `restart` and `amended` never count. `budget_spent` is `tasks.budget_used >= tasks.budget_limit`, where `budget_limit` is the resolved config/contract value; `amended` (criteria changed) sets `budget_used = 0`; `budget_raised` adds the raise to `budget_limit`. A pause or cancel of a Task in `implementing`/`validating`/`evidencing` cancels the current Stage (AD-4) and, on resume, the Task re-enters at the *same* state with cause `resume`.

---

## H4 — Contract files have no stable identity: a merged Task's contract is re-detected on `main`, and an Owner-added file has no `task_no` `[HIGH]`

**Pair.** `contract detection on main` (agent A) vs `approval / task numbering` (agent B).

**Each obeys the spine.** AD-5: a contract is `.antipod/tasks/<task_no>.yaml`, "committed as the first commit on its Branch at approval"; "a contract the Owner adds on `main` is detected there, offered for approval, and moved to a Branch on approval". AD-16: the Task number is "per-Project sequential". Agent A scans `main` after every fetch for files under `.antipod/tasks/` not yet in `tasks` by path. Agent B assigns `task_no` at draft time from `max(task_no)+1`.

**Clash.** (1) Every Task merges its Branch to `main` (AD-13), so after the first Release `main` contains `.antipod/tasks/12.yaml` — agent A's scan finds it and offers #12 for approval again, forever. (2) The Owner, or a BMad story workflow, writes a file on `main`: what number? The Owner does not know the next sequence; if they pick `15.yaml` and Intake has already drafted #15 from a voice note, two Tasks share one number and one file path. (3) "Moved to a Branch on approval": removing the file from `main` means Antipode commits to `main` outside Integration — a second write path to `main` that AD-13 does not mention — and if it is *not* removed, the Branch and `main` both carry it and the rebase conflicts on itself. (4) FR-6 says a *changed* contract is also offered; a Released Task whose contract on `main` is edited later must not be re-opened, but nothing says so.

**Close it — tighten AD-5.**

> **AD-5 Rule (replace the contract sentences):** Owner-supplied contracts are files under `.antipod/inbox/<slug>.yaml` on `main`; they carry no number. Antipode never commits to `main` except by fast-forward in Integration. Detection is keyed by `(path, blob_sha)` recorded in `contract_sources`; a `(path, blob_sha)` already recorded is never offered again, and a new `blob_sha` at a path whose Task is `released` or `cancelled` is offered as a *new* draft, not a change. On approval the Coordinator assigns `task_no`, and the Branch's first commit is `git mv .antipod/inbox/<slug>.yaml .antipod/tasks/<task_no>.yaml` (plus any edits from approval); the move reaches `main` at merge, which is how the inbox entry is retired. Files under `.antipod/tasks/` on `main` are *never* scanned. A BMad story file is accepted only through the inbox path.

---

## H5 — Criteria live in two places (YAML on the Branch and rows in SQLite) with no owner for amendments `[HIGH]`

**Pair.** `Intake + amendment` (agent A) vs `Stage brief renderer / git adapter` (agent B).

**Each obeys the spine.** AD-5: the contract file "holds goal, criteria, required evidence, dependencies and budget override". AD-2: SQLite "holds every durable fact"; the ER diagram has `CONTRACT ||--|{ CRITERION`. AD-9 applies amendments "after the Owner confirms". Agent A writes a confirmed `Drop AC2` to the `criteria` rows. Agent B renders the Stage brief by reading `.antipod/tasks/<no>.yaml` from the Branch (it is "the contract", and the Validator is told to check "the Branch against every Acceptance Criterion").

**Clash.** After the amendment the Implementer and Validator still see AC2 in the file; the Validator fails the Task for a criterion the Owner dropped. If instead agent A also commits the YAML, it writes into the Task worktree — while an Implementer Stage may own it (FR-20: "no two agents edit the same working tree at the same time"; AD-5: "every Stage writes only its own worktree" says nothing about the Coordinator). And `Raise budget +2`: is that a commit to the Branch, a DB column, or both? The two agents will answer differently, and AD-16's `AC1..n in contract order` renumbers if one side deletes a criterion and the other marks it dropped.

**Close it — new AD.**

> **AD-21 — The contract row is the record; the contract file is a projection [proposed]**
> **Binds:** FR-6, FR-9, FR-10, FR-14, FR-19. **Prevents:** criteria read from one place and amended in another; a Coordinator commit landing in a tree a Stage is editing.
> **Rule:** `contracts` (versioned by `contract_version`) and `criteria` rows in SQLite are the system of record once a Task exists; an Owner-supplied file is input only until import. Criterion ids are stable (`AC<n>` is assigned once and never reused; a dropped criterion keeps its id with `status = dropped`). The Coordinator writes `.antipod/tasks/<task_no>.yaml` from the row only as the first effect on entering `implementing`, before the Stage is spawned, and commits it on the Branch with message `antipod: contract v<version>`; no other component writes that file. Stage briefs are rendered from rows, never from the file. Budget limit and raises are columns on `tasks`, never in the file.

---

## H6 — "Round" is defined by three different clocks, so stale callbacks and Evidence directories disagree `[HIGH]`

**Pair.** `evidence ingest` (agent A) vs `Telegram callbacks` (agent B) vs `Integration` (agent C).

**Each obeys the spine.** AD-8 writes Evidence to `r<round>/`; AD-16 says rounds are `r1..n`; AD-10 stores `{command, task_id, round, expires_at}` and "a stale row answers with the replaced toast". Agent A increments `round` each time the Evidence Producer runs (a round is "the produced Evidence"). Agent B treats a callback as stale when `expires_at < now` (that is the only field that says so). Agent C, on `rebase_or_revalidation_failed`, re-runs the Implementer; the new loop produces Evidence into `r2/`, a new Review card is sent, and the old card's `Accept` row is not expired (no `expires_at` was set for a Review).

**Clash.** The Owner scrolls up, taps `Accept` on the old card (round 1, state now `in_review` again), B finds the row valid, emits `accepted`, and the Task integrates round 2's branch under round 1's approval — and the "replaced" toast never fires. Conversely, after a `blocking_findings` loop that never reached the Owner, agent A's round counter is 3 while the Owner has seen one Review, so the card says `r3` and `/evidence` shows gaps.

**Close it — tighten AD-16 and AD-10.**

> **AD-16 Rule (add):** `tasks.review_round` increments exactly on each entry to `in_review` and is the only round number; Evidence produced by a loop that does not reach `in_review` is stored under the round *about to be* sent (`review_round + 1`) and superseded in place if that loop repeats (the Evidence rows of a superseded attempt are kept with `superseded = 1`, never deleted — AD-8 stands).
> **AD-10 Rule (replace staleness):** A callback row is valid iff `callbacks.task_id` is in the state its `command` expects **and** `callbacks.round = tasks.review_round`; `expires_at` is used only by `undo`. On every entry to `in_review` the Coordinator edits the previous round's card to strip its keyboard (effect `retire_card`).

---

## H7 — Parking Lot promotion is a button that must invoke Intake, and Intake has no worktree to run in `[MEDIUM]`

**Pair.** `Telegram cards` (agent A) vs `Intake Role / claude-cli adapter` (agent B).

**Each obeys the spine.** AD-9: "Inline-button taps are Coordinator commands and never pass through Intake"; every *message* becomes an Intake Stage. EXPERIENCE: `→ Task` is a button that "sends it to Intake, which replies with a Draft card". AD-4: every Stage runs with `cwd` = the Task worktree. Agent A emits a `promote_finding` command; agent B's Intake accepts only `owner_message` events and needs a Task worktree, and a draft Task has no Branch yet (the Branch is created at approval, AD-5).

**Clash.** The command has nowhere to go: no event maps to an Intake Stage, and even for a plain voice note there is no worktree for the Intake Stage to `cd` into, so agent B invents one (`main` checkout? the mirror? `/tmp`?) — each choice changes what Intake can read for FR-8 feasibility (it needs the Recipe and the repo). A second clash: who owns `parking_lot.status` (`parked | promoted | dismissed`) — `Dismiss` edits it from Telegram, `→ Task` from the Coordinator, and the draft's `source_finding` link is unspecified.

**Close it — tighten AD-4 and AD-9.**

> **AD-4 Rule (add):** Stages that have no Task Branch (Intake for a new draft, Intake for a promotion, Triage after a Stuck reply) run in the Project's read-only `main` checkout at `data/worktrees/<project>/_main/`, fast-forwarded before each such Stage. No Stage ever runs in the mirror.
> **AD-9 Rule (add):** Intake is started by exactly two events: `owner_message` and `promote_finding {task_id, finding_id}`; the latter renders the finding and its source contract as the Intake input. `parking_lot.status` is changed only by the transition table on `promote_finding` (→ `promoted`, and the resulting draft stores `source_finding_id`) and `dismiss_finding` (→ `dismissed`).

---

## H8 — Progress Peek has nothing to show during `implementing`, so someone will read the running step's output directory `[MEDIUM]`

**Pair.** `Peek command` (agent A) vs `evidence ingest` (agent B).

**Each obeys the spine.** AD-8: Evidence rows exist only after the Evidence Producer's output is ingested; "a Progress Peek shows the newest artifact of the running round". AD-2: "a file without a row does not exist to the system". UJ-5 / EXPERIENCE: a Peek during the *Implementer* at lap 2 returns "the latest render" and a status line naming what the Implementer is doing now.

**Clash.** In round 1 during `implementing` there are no Evidence rows at all; agent A, to meet UJ-5, globs `data/steps/<latest step_run>/out/*.png` (the Implementer's `render` step wrote it) — a half-written file, with no row, in violation of AD-2 — and tails the running Stage's `.jsonl` to extract the last assistant text (no port exposes it; AD-1 forbids the Telegram adapter reading the claude-cli adapter's files). Agent B, told AD-2 is the law, answers `No visuals yet` for every Peek before the first Review, which makes UJ-5 impossible.

**Close it — tighten AD-8.**

> **AD-8 Rule (add):** A Progress Peek is an explicit exception to AD-2: it reads ephemeral, unrecorded data and records nothing. Its visual is, in order: the newest *closed* image or video file (not open by any process, mtime older than 2 s) under the `ANTIPOD_OUT` of the newest step run of the current Stage, else the newest `evidence` row of the Task in any round, else none. Its status line is the last `assistant` text block of the current Stage's stream, exposed by the `AgentRunner` port as `observe(stage_id) → {last_text, elapsed_ms}`. The Peek never copies or ingests the file.

---

## H9 — `before_of` points at something the Evidence Producer cannot see, and previous Evidence is outside every Stage's reach `[MEDIUM]`

**Pair.** `Evidence Producer Role Config` (agent A) vs `evidence ingest + Validator Role Config` (agent B).

**Each obeys the spine.** AD-8: output lists files with `{criterion_id, kind, degraded, before_of?, caption}`; FR-22: after a Correction the Review opens with before/after pairs "against the Evidence in the previous Review". AD-4: the brief carries "prior Evidence". AD-20: the Producer invokes `antipod-evidence` to build composites. Agent A's Producer needs the previous round's PNG *file* to composite with; the files are under `~/.antipod/data/evidence/…`, outside the worktree, and agent B's `permissions.json` for the Role (AD-6: "containment is the worktree cwd, the Role's permission rules") denies reads outside the worktree. Agent A sets `before_of` to the previous evidence's ULID; agent B expects it to name a file in the same output list (a "before" artifact the Producer shot itself on `main`).

**Clash.** Either the composite is impossible (no read access to prior files, and "prior Evidence" in a text prompt is a caption, not pixels) or every team invents a different reference target for `before_of`. Also unspecified: ingest ordering — copy file then insert row, or insert then copy; a crash between leaves a row without a file (worse than AD-2's "file without a row").

**Close it — tighten AD-8 and AD-7.**

> **AD-7 Rule (add):** Every step and Stage also receives `ANTIPOD_PRIOR`, a read-only directory containing the previous Review round's Evidence files of this Task (`prior/<evidence_id>.<ext>` plus `prior/index.json` with `{evidence_id, criterion_id, kind}`), empty in round 1. The container Runner bind-mounts it read-only; the Role `permissions.json` allows reads there.
> **AD-8 Rule (add):** `before_of` is either an `evidence_id` from `prior/index.json` (composite against the previous Review) or the `name` of another file in the same output list with `kind = screenshot` (a fresh "before" taken on `main`). Ingest validates the reference and rejects the output (`evidence_missing`) otherwise. Ingest order: copy file to `evidence/<project>/<task_no>/r<round>/<evidence_id>.<ext>`, `fsync`, then insert the row inside the `evidence_produced` transaction; a file with no row after a crash is deleted at boot.

---

## H10 — `UsageMeter` cannot be both a port and "the only writer of `cost_samples`" under AD-1 `[MEDIUM]`

**Pair.** `claude-cli adapter` (agent A) vs `sqlite adapter / Store` (agent B).

**Each obeys the spine.** AD-1: every external effect goes through a port; "an adapter implements exactly one port and imports nothing from another adapter". AD-12: "`UsageMeter` is the only writer of `cost_samples` and `usage_samples`" and reads tokens "from the `result` message of the Stage stream"; the Capability Map puts FR-31 in `adapters/claude-cli`. Agent A, owning the stream, implements `UsageMeter` in `claude-cli` — and now needs to write SQLite, which means importing the `sqlite` adapter (forbidden) or opening the DB itself (AD-2 forbids a second writer). Agent B implements `UsageMeter` on top of `Store` — and now `claude-cli` implements two ports or `UsageMeter` has no access to the stream.

**Clash.** Two teams, two placements, and the `WindowReader` (an HTTP call to an OAuth endpoint — clearly an adapter) is named in AD-12 but absent from the AD-1 port list and the source tree.

**Close it — tighten AD-12 and AD-1.**

> **AD-12 Rule (replace first sentence):** `UsageMeter` is a core module (`core/coordinator/usage.ts`), not a port; it is the sole caller of `Store.insertCostSample`/`insertUsageSample`. The `claude-cli` adapter returns `{tokens_in, tokens_out, cost_usd_estimate, duration_ms}` inside the typed Stage result event; the meter records it as an effect of that event. `WindowReader` is a port in `core/ports/` implemented by `adapters/anthropic-usage/` (OAuth endpoint) with a core fallback estimator over `cost_samples`.
> **AD-1 port list (add):** `WindowReader`.

---

## H11 — Exclusive host capability has two lock owners with different granularity `[MEDIUM]`

**Pair.** `scheduler gates` (agent A) vs `host StepRunner` (agent B).

**Each obeys the spine.** AD-11: a gate "exclusive capability free", evaluated "all from the database", at Task *start*. AD-7: "a host step naming an `exclusive` capability takes the per-capability lock before it starts" — in the host adapter, in process memory (nothing says it is in the DB). Agent A defines "free" as no `implementing` Task in a Project whose Recipe references the capability. Agent B takes an in-memory mutex at step time and waits.

**Clash.** With A's definition, two Tasks in the Unity Project never run together even though only the `evidence` step needs the editor — the global concurrency of 2 is silently 1 for that Project; with B's lock alone, two Tasks both reach their `evidence` step, the second waits inside a running Implementer Stage until the *Stage* timeout kills it, which AD-3 then counts as a retry and later as a Stuck. After a crash B's in-memory lock is gone while the editor process may still be alive (AD-18 does not list locks among things rebuilt from the DB).

**Close it — tighten AD-7 and AD-11.**

> **AD-7 Rule (replace the lock sentence):** Exclusive capabilities are leased in the `capability_leases` table `{capability, task_id, step_run_id, acquired_at}`. A host step naming an `exclusive` capability acquires the lease in one transaction before spawning and releases it when the step exits; if the lease is held by another Task the step fails fast with `capability_busy` (never waits), which the Coordinator maps to `retry` after the holder releases, not to a budget unit.
> **AD-11 Rule (replace the last gate):** "exclusive capability free" means no lease held by a Task of another Project *and* fewer than `capability.max_tasks` (default 1) running Tasks whose Recipe declares that capability. At boot all leases are deleted (AD-18) after the host adapter has killed the processes they name.

---

## H12 — The bootstrap Task cannot pass the gates written for normal Tasks, and nothing says whether it merges `[MEDIUM]`

**Pair.** `Project registration` (agent A) vs `transition table / Integration` (agent B).

**Each obeys the spine.** AD-11 gate: "bootstrap accepted for the Project". AD-3: the only way into `queued` is `awaiting_approval → queued: approved`. AD-5: the contract is committed at approval. AD-13: Accept → rebase, Validator, test, fast-forward merge, Release. EXPERIENCE: "the bot creates Task #1, the bootstrap"; the Owner never approves a draft for it; its criteria are "one per Evidence kind the Recipe declares".

**Clash.** Agent A inserts Task #1 straight into `queued` (no transition does that, so it writes `tasks` directly — forbidden by AD-3) and the scheduler's own bootstrap gate blocks it forever because the bootstrap is not accepted. Agent B, on Accept, merges the "trivial change" to `main` and runs the Release step — shipping internal build 0.4.1 with a no-op change and the `PROD_` secret in play before the Owner has ever seen a real Task. Nor is it said who writes the trivial change (an Implementer Stage with what brief?) or what `#1`'s contract file is.

**Close it — tighten AD-3, AD-5, AD-11, AD-13.**

> **AD-3 diagram (add):** `[*] → queued: bootstrap_created` (only for `tasks.kind = bootstrap`); `in_review → released: accepted` when `kind = bootstrap`.
> **AD-5 Rule (add):** `bootstrap_created` writes a generated contract (`goal: Recipe check`, one criterion per declared Evidence kind, `required_evidence` = that kind) to the row and, per AD-21, to `.antipod/tasks/1.yaml` on `antipod/1-bootstrap`; the Implementer brief for a bootstrap is "make a visible no-op change: add `.antipod/bootstrap.md`".
> **AD-11 Rule (amend):** the gate "bootstrap accepted for the Project" is skipped when `kind = bootstrap`.
> **AD-13 Rule (add):** A bootstrap Task is never integrated or released; on `accepted` it goes to `released` directly, its Branch is deleted, and `projects.bootstrap_accepted_at` is set.

---

## Smaller holes (noted, not expanded)

- **AD-9 vs AD-10 reply threading.** AD-10 maps `message_id → {task_id, round, kind}`; AD-9 says *every* message becomes an Intake Stage. A reply to a Draft card that answers a quick question ("not yet") is an Owner Message about a draft, not an existing Task — the `OwnerInstruction` union has no `draft_revision | draft_answer` members, so one team folds it into `new_draft` (creating a second draft) and another into `amendment` (which AD-9 says needs an Interpretation card the Draft flow does not have). Add `draft_reply` to the union and route by `telegram_messages.kind = draft`.
- **AD-13 `test` after Implementer.** "The Recipe `test` step run by the Runner after every Implementer Stage" — who runs it, the Implementer (via the agent) or the Coordinator as an effect of `implementer_done`? If both, two runs; if the agent, a failing test never becomes an event. State: the Coordinator runs `test` as an effect of `implementer_done` before `validating`; a failure is `blocking_findings` with the log.
- **AD-10 outbox vs `edit in place`.** The outbox has `sent_message_id`; an edit is a new outbox row `{kind: edit, target: message_id}` or an in-place mutation? Say: edits are outbox rows of kind `edit` referencing `telegram_messages.message_id`, drained in sequence.
- **AD-14 `.env` per Project vs AD-19 capability map in `config.yaml`.** A host capability command (e.g. Unity's license env) may need a secret; the map lives in a file that has no secret mechanism. Say whether capability commands may reference secret *names*.
- **Dependencies on a cancelled Task.** `waiting_on_dependencies → queued: deps_merged` only; a dependency that is `cancelled` leaves the dependent waiting forever with no notice. Add `deps_unsatisfiable → stuck` with a Stuck card reason.

## Summary of proposed spine changes

| Hole | Severity | Touches |
|---|---|---|
| H1 effects outside the transaction, tick/callback race | Critical | AD-3, AD-11, AD-18 |
| H2 Undo window has no state | Critical | AD-3 (new state), AD-13, AD-11 |
| H3 stale Stage events; budget burned by pause/restart; reset rule | High | AD-3, AD-4 |
| H4 contract file identity, re-detection on `main`, inbox path | High | AD-5 |
| H5 contract row vs file, who writes amendments | High | new AD-21 |
| H6 three definitions of "round"; callback staleness | High | AD-10, AD-16 |
| H7 Intake has no worktree; promotion button vs "buttons never hit Intake" | Medium | AD-4, AD-9 |
| H8 Peek must read unrecorded files | Medium | AD-8 |
| H9 `before_of` target; prior Evidence unreachable; ingest order | Medium | AD-7, AD-8 |
| H10 `UsageMeter` placement vs AD-1 | Medium | AD-1, AD-12 |
| H11 two lock owners for exclusive capability | Medium | AD-7, AD-11, AD-18 |
| H12 bootstrap Task vs its own gate; merge/release of a no-op | Medium | AD-3, AD-5, AD-11, AD-13 |
