---
title: Reviewer Gate round 2 — verification of the rewritten spine
subject: ../ARCHITECTURE-SPINE.md (rewrite of 2026-11-05 23:16)
inputs: review-rubric.md, review-adversary.md, review-versions.md, reconcile-prd.md, reconcile-ux.md
reviewer: verification (round-2 gate)
date: 2026-11-05
---

# Round 2 — does the rewrite close the holes?

**Verdict:** the rewrite closes every CRITICAL finding and all but a handful of HIGH findings; the remaining HIGH items are either a one-line mechanism left unstated (H2 timer, H9 Stage access to prior files, NFR-4 wording) or a cross-document contradiction that the spine resolved on its side but the UX documents still carry (N5 Demo link fallback). All five mermaid blocks parse and render with `@mermaid-js/mermaid-cli` 11.17.1. The rewrite introduces four new contradictions between ADs that an epic author would trip on, all cheap to fix: AD-5 vs AD-21 on when the contract file is first committed; AD-3's note that `verifying` is "Coordinator-run" vs AD-4 and the sequence diagram, which run a Validator Stage there; AD-3's generic events applied "from every non-terminal state" (which lets `amended` restart a `merged` Task and `pause` freeze an undo timer); and AD-3's "stuck only after Triage" vs its own two direct `→ stuck` events. Safe to cut epics once section 3 is folded in.

Method: every CRITICAL/HIGH finding in the five first-round reviews and all twelve adversary holes were checked line-by-line against the rewritten spine. "Closed" means the specific divergence the reviewer named can no longer happen under the rewritten text; the choice made is not judged. Mediums are reported only where still open and cheap.

---

## 1. Finding-by-finding status

### review-rubric.md

| Id | Sev | Status | Reason |
| --- | --- | --- | --- |
| C-1 Stage→StepRunner path | critical | **closed** | AD-6 fixes `antipod step <name>` over `$ANTIPOD_HOME/run/antipod.sock`; direct tool use denied by Role permissions; sequence diagram redrawn `S->>C` / `C->>R`. |
| C-2 Branch-read trust boundary | critical | **closed** | AD-22 pins `antipod.yaml`, `.antipod/roles/`, `.antipod/inbox/` and secret names to `tasks.config_sha` on `main`; AD-21 denies Stage writes under `.antipod/`. |
| H-1 missing transition edges | high | **closed** | Generic `cancel`/`pause`+`resume_state`/`amended`/`stage_retries_exhausted` in AD-3; `accept_pending`, `discard_pending`, `release_failed`, `merged` states; `integrating → in_review` removed; running Stages never killed for the window. (Scoping of "every non-terminal state" is a new issue, §3 N3.) |
| H-2 Stage output discriminators deferred | high | **closed** | AD-4 fixes every discriminator; invalid output is a Stage failure under retry, never an event. |
| H-3 retry policy undefined | high | **closed** | AD-4: failure causes, `role.yaml` `timeout`/`retries`, same brief on worktree as left, never consumes budget, `stage_retries_exhausted`. AD-18 references it. |
| H-4 testing silent | high | **closed** | AD-24. |
| H-5 operations silent | high | **closed** | AD-23 (logs, backup, upgrade, migrations, `ANTIPOD_HOME` instance split) plus AD-5 worktree removal. |

### review-adversary.md

| Id | Sev | Status | Reason |
| --- | --- | --- | --- |
| H1 effects outside the transaction | critical | **closed** | AD-3: serial queue, synchronous `applyEvent`, `effects` rows in the transaction, `stages` row `starting` before spawn; AD-11 counts `starting`/`running`; AD-18 re-executes undone effects. (A double-launch window between the effect replay and the `failed(restart)` sweep is a new item, §3 N6.) |
| H2 Undo window has no state | critical | **partially** | `accept_pending` state, `undone`/`undo_expired` events and "Integration starts on `undo_expired`" (AD-13) are in. Still unstated: where the Task-level deadline is persisted (`tasks.accept_expires_at` or equivalent), who emits `undo_expired` (scheduler tick), and the two window lengths (10 s accept, 60 s discard — only the sequence diagram says "after 10 s"). AD-10's `callbacks.expires_at` belongs to the button, not the Task, so a crash inside the window still loses the deadline. Fix: one sentence in AD-3 — "`accepted`/`discarded` store `tasks.undo_expires_at = now + limits.undo_accept_ms | limits.undo_discard_ms`; the scheduler tick emits `undo_expired` for every `accept_pending`/`discard_pending` Task past its deadline; `undone` is accepted only before it." |
| H3 stale Stage events; budget causes | high | **closed** | AD-3: `stage_id` gating with `ignored(stale)`, `cancelled(<reason>)` before signal, exhaustive budget cause list, `amended` resets `budget_used`, `budget_raised(n)`. |
| H4 contract file identity | high | **closed** | AD-5: `.antipod/inbox/<slug>`, `(path, blob_sha)` in `contract_sources`, `git mv` on the Branch, `.antipod/tasks/` never scanned, `main` written only by fast-forward. |
| H5 criteria in two places | high | **closed** | AD-21 adopted as proposed. (Its timing now conflicts with AD-5, §3 N1.) |
| H6 three round clocks | high | **closed** | AD-16 `review_round` increments on entry to `in_review`, `review_round + 1` for pre-review Evidence; AD-8 `superseded = 1`; AD-10 callback valid iff state matches and `round = tasks.review_round`; `retire_card` effect. |
| H7 Intake worktree; promotion button | medium | **closed** | AD-4 `_main` checkout; AD-9 three start events incl. `promote_finding`, `parking_lot.status` owner, `source_finding_id`. |
| H8 Peek reads unrecorded files | medium | **closed** | AD-8 Peek rule + `AgentRunner.observe`; AD-2 names the exception. |
| H9 `before_of` target; prior Evidence reach; ingest order | medium | **partially** | `before_of` rules and ingest order (copy, `fsync`, row in the `evidence_produced` transaction) are in AD-8; `ANTIPOD_PRIOR` is in AD-7. But AD-7 gives `ANTIPOD_PRIOR` to *steps* only, while the composite is built by the Evidence Producer *Stage* invoking `antipod-evidence` (AD-20) and the brief carries `prior/index.json` (AD-4) — nothing says the Stage process receives `ANTIPOD_PRIOR` or that its Role `permissions.json` allows reads there. Fix: in AD-7 "Every step **and every Stage** receives `ANTIPOD_PRIOR`; shipped Role permissions allow reads under it." |
| H10 `UsageMeter` placement | medium | **closed** | AD-1 "UsageMeter is a core module, not a port"; `WindowReader` port → `anthropic-usage`; AD-12 sole caller of `insertCostSample`. |
| H11 two lock owners | medium | **closed** | AD-7 `capability_leases` with fail-fast `capability_busy` → retry; AD-11 reduced to a hint; AD-18 deletes leases after killing the processes. |
| H12 bootstrap vs its own gate | medium | **closed** | `[*] --> queued: bootstrap_created`; AD-11 gate skipped for `kind = bootstrap`; AD-13 generated contract, never merged, `undo_expired [bootstrap] → released`, Branch deleted. |
| smaller: `draft_reply`, Coordinator-run `test`, outbox edits, capability secret names, `deps_unsatisfiable` | — | **closed** | AD-9, AD-13, AD-10 `target_message_id`, AD-7 last sentence, AD-3 generic event. |

### review-versions.md

| Id | Sev | Status | Reason |
| --- | --- | --- | --- |
| F1 `--mirror` clone breaks fetch | high | **closed** | AD-5: "plain bare clone (never `--mirror`)" with `+refs/heads/*:refs/remotes/origin/*`; `origin/main` resolves for the AD-13 rebase; the word "mirror" appears nowhere else in the spine. |
| F2 TypeScript 5.x stale | medium | **closed** | Stack: TypeScript 7.0. |
| F3 OAuth usage endpoint unofficial | medium | **closed** | AD-12 tagged `[ASSUMPTION: undocumented endpoint; spike before relying on it]`. |
| F4 Podman / Node notes | low | **closed** | Stack rows updated. |
| F5 zod draft-07 | low | **closed** | AD-4 `z.toJSONSchema(schema, { target: "draft-7" })`. |
| F7 Manual-mode default; no `result` after SIGTERM | info | **open (cheap)** | AD-4 always passes `--permission-mode`, which covers the first; nothing says the Stage result event tolerates a missing `result` message on the SIGTERM path. Fix: AD-4 — "a Stage killed by SIGTERM yields no `result`; the adapter reports tokens/cost as unknown and the event is still `failed(timeout)`." |

### reconcile-prd.md

| Id | Sev | Status | Reason |
| --- | --- | --- | --- |
| FR-5 Preview Data missing | high | **closed** | AD-7 `fixtures`, `ANTIPOD_DATA` seeded once per Task, deleted with the worktree, "nothing reads production data"; Recipe seed carries `fixtures: null`. |
| NFR-4 isolation weaker than PRD | med–high | **partially** | AD-6 (still `[ASSUMPTION]`) names the containment (worktree `cwd`, Role permissions, no secrets in env) and defers the container, but does not make the honest statement the reviewer asked for: a host Stage runs as the Owner's user and can read `$ANTIPOD_HOME/secrets/*` and other worktrees; the protection is policy (permission rules), not enforcement. Fix: add to AD-6 — "Shipped Role permissions deny reads under `$ANTIPOD_HOME` and `data/worktrees/` outside the Task's own; in the MVP NFR-4 is enforced by Role permission rules, not by the OS." |
| FR-3 bootstrap | medium | **closed** | AD-13 generated contract, one criterion per Evidence kind; AD-11 gate. (The "Recipe cannot produce visual Evidence → onboarding blocked" outcome is still unwired, §3 R3.) |
| FR-6 story mapping / inbox / numbering | medium | **closed** | AD-5 inbox `.yaml`/`.md`, no number, stories without per-criterion Evidence enter as `draft` through Intake; Deferred "BMad story parser". |
| FR-8 deterministic approval gate | low–med | **closed** | AD-9: Coordinator refuses `approved` while Required Evidence is outside `evidence_kinds`. |
| FR-12 retries; stuck from every Stage | medium | **closed** | AD-4 retry policy; generic `stage_retries_exhausted → stuck`. |
| FR-13 Triage writes reason; pause burns budget | medium | **closed** | `implementing → triage: budget_spent`, `triage → stuck: reason_written`; `resume` never counts. |
| FR-14 Owner controls | medium | **closed** | Generic `cancel`/`pause`/`amended`; Branch kept. |
| FR-16 per-Project backpressure | medium | **closed** | AD-11 "across all Projects". |
| FR-17 window gates Stage launches | medium | **closed** | AD-3 and AD-11: gate re-evaluated before every Stage launch. |
| FR-20 push cadence | medium | **closed** | AD-5: push after every Implementer Stage. |
| FR-23 60 s / size cap | medium | **closed** | AD-8 ingest rejects >60 s or >50 MB with `evidence_missing`. |
| FR-24 WebGL Demo | medium | **closed** | Deferred: zipped WebGL build as a file. |
| FR-31 `/cost` | low–med | **closed** | AD-12 last sentence. |
| §6 sleep | med–low | **closed** | AD-18 monotonic deadlines, 60 s jump rule, `back_online`. |

### reconcile-ux.md

| Id | Sev | Status | Reason |
| --- | --- | --- | --- |
| N5 Demo >50 MB link fallback; preview wake | high | **open (cross-document)** | The spine made its decision (Deferred: files only in the MVP; self-hosted Bot API server as the direction) but the contradiction the reviewer named is between documents, and the UX side is unchanged: DESIGN.md line 129 still specifies `Demo · … · link (file too large)`, EXPERIENCE.md lines 22, 91 and 138 still require authenticated links and `Waking preview · ~30 s`. Fix (outside the spine): edit those four lines to "file too large, not sent — see `/log`" and drop the preview-asleep row, or move the three lines under a `[POST-MVP]` tag. |
| S3 Peek status line | high | **closed** | AD-4 `AgentRunner.observe → {last_text, elapsed_ms}`; AD-8 uses it. |
| S4 Peek visuals while implementing | high | **closed** | AD-8 newest closed file under `ANTIPOD_OUT` of the newest step run. |
| S8 cancel from every state | high | **closed** | AD-3 generic `cancel → cancelled`, Branch kept. |
| F1 wake from sleep | high | **closed** | AD-18 clock-jump rule and `back_online`; AD-10 `telegram.stale_after` reply-not-toast and `/peek` drop. |
| N2 global Owner id | medium | **closed** | AD-10 `owner.telegram_user_id` in `config.yaml` gates `/register`. |
| S1 `/register` primary path | medium | **closed** | AD-10 only registration path; CLI calls the same code with `--chat-id`. (Re-`/register` of a bound group unspecified — low.) |
| S5 Parking Lot | medium | **closed** | AD-9. ER diagram has `PARKING_LOT_FINDING ||--o| TASK : promoted_to`. |
| S6 window-share | medium | **closed** | AD-12 utilization delta `[ASSUMPTION]`, `—` when unknown. |
| S7 pause model | medium | **partially** | Owner pause → `paused` + `resume_state`, budget-exempt; window pause → `waiting_reason = usage_window` (not a state), so the two are told apart. Still unstated: what `/pause` with no Task target does and where a Project-level pause is stored (AD-11 says "Owner pause (Project or Task)" but AD-3's `pause` event is Task-level and no `projects.paused_at` column exists). Fix: AD-11 — "`/pause` without a Task sets `projects.paused_at`; the gate reads it; `/resume` without a Task clears it and does not touch Task-level `paused` rows." |
| I2/I3/I4/I11 Intake output shape | medium | **closed** | AD-9 `instructions: [1..2]`, `draft_reply`, quick-answer taps update the draft row without a Stage; AD-4 brief carries `intake.context_messages` and the unanswered question. |
| I6 discard undo | medium | **closed** | `discard_pending` state. (Deadline persistence shared with H2 above.) |
| I7 accept undo | medium | **partially** | See adversary H2. |
| I9/I10 budget raise, amendment reset | medium | **closed** | AD-3 `budget_limit`/`budget_used` columns, AD-21 "never in the file". |
| I13 Stuck reason via Triage | medium | **closed** | `budget_spent → triage → stuck`. |
| F4 outbox head-of-line | medium | **closed** | AD-10 `outbox.retries`, `failed`, skipped, loud notice. |
| F8 release failed | medium | **closed** | `merged`, `release_failed`, `retry_release`, `leave_it`, `no_release_step`. |
| F9 onboarding blocked | medium | **open (cheap)** | AD-10 lists `onboarding_blocked` as a loud outbox kind, but no AD or AD-3 edge produces it: a bootstrap whose Recipe cannot produce an Evidence kind cycles `evidencing → implementing: evidence_missing` until `budget_spent → triage → stuck`, which sends a Stuck card, not the UX's blocked notice. Fix: AD-13 — "for `kind = bootstrap`, the first `evidence_missing` or `test_failed` is terminal: the Task goes to `cancelled` with cause `onboarding_blocked`, the step log is attached, and the Project stays in onboarding." Add the edge to the diagram or to the generic-event list. |
| F10 once-per-pause window notice | medium | **open (cheap)** | No idempotency key for the "paused for usage window" / "Resumed" notices; AD-10's outbox has no dedupe field. Fix: outbox row gets `dedupe_key?` (e.g. `window_pause:<project_id>:<resets_at>`); the sender skips a row whose key was already sent. |
| D1 Inter bundling | medium | **closed** | AD-20 package-local fontconfig. |

**Counts (CRITICAL + HIGH, 22 findings):** closed 18, partially 3 (adversary H2, reconcile-prd NFR-4, reconcile-ux I7 which is the same hole as H2), open 1 (reconcile-ux N5, cross-document). Counting all adversary H1–H12 regardless of severity: closed 10, partially 2 (H2, H9), open 0.

---

## 2. Mermaid validation

Tool: `npx -y @mermaid-js/mermaid-cli@11` (resolved to 11.17.1, headless Chromium available). Each of the five fenced blocks was extracted verbatim to `/private/tmp/claude-504/-Users-alexeyfilatev-Documents-Projects-agxmeister-antipod/fc256490-eed5-43f5-b82e-2a4759863b1e/scratchpad/mermaid/block{1..5}.mmd` and rendered to SVG.

| # | Block | Result | Specific checks |
| --- | --- | --- | --- |
| 1 | `flowchart LR` layering | parses, renders | edges to subgraph ids (`APP --> adapters`) accepted; `:` in node text fine |
| 2 | `stateDiagram-v2` lifecycle | parses, renders | `[*] --> draft: owner_message / inbox_detected / promote_finding` — multi-event label with `/` rendered verbatim; `merged --> released: release_done / no_release_step` fine; `accept_pending --> released: undo_expired [bootstrap]` — the bracketed suffix is rendered as label text (not parsed as a guard; mermaid has no guard syntax, so this is cosmetic only); two `[*] -->` entry lines accepted; `released --> [*]` and `cancelled --> [*]` fine |
| 3 | `flowchart TB` container view | parses, renders | `FS[/…/]` parallelogram with `:` and commas fine; `D -- long polling --> TGAPI` direction now correct; `D -- fetch / push --> GH` edge label with `/` fine; `D` referenced inside its subgraph before any outside use |
| 4 | `sequenceDiagram` one round | parses, renders | `participant S as claude-cli (Stage)` and other multi-word aliases accepted; `-->>` and `->>` both used correctly; `C->>C:` self-messages fine |
| 5 | `erDiagram` entities | parses, renders | `PARKING_LOT_FINDING ||--o\| TASK : promoted_to` (zero-or-one) valid; `TASK }o--o{ TASK : depends_on` self-relation valid; `STAGE ||--o\| COST_SAMPLE` valid; underscore entity names fine |

No block emits a syntax error. Two semantic (not syntactic) notes: the ER diagram shows `TELEGRAM_CHAT` and `REVIEW_ROUND` as entities while AD-2's table list has neither a `telegram_chats` nor a `review_rounds` table (the chat binding presumably lives on `projects`, the round is `tasks.review_round` + `evidence.round`); and the state diagram's `[*] --> draft: owner_message` names the Owner's message where the Task row is actually created on Intake's `new_draft` output (AD-9) — see §3 R5.

---

## 3. New contradictions introduced by the rewrite, and cheap leftovers

### N — new contradictions between ADs

| # | Where | Contradiction | Fix |
| --- | --- | --- | --- |
| N1 | AD-5 vs AD-21 (and the sequence diagram) | AD-5: "On approval the Coordinator assigns `task_no`, creates the Branch, and its first commit `git mv`s the inbox file to `.antipod/tasks/<task_no>.yaml` (or writes it for Telegram-born Tasks)"; sequence diagram: `C->>G: create Branch + worktree, commit contract` right after `approved`. AD-21: "The Coordinator writes `.antipod/tasks/<task_no>.yaml` from the rows **only** as the first effect on entering `implementing`". A Task approved but gated (`queued`, `waiting_on_dependencies`) has its contract committed at two different moments depending on which AD the git-adapter epic reads; and the `git mv` happens from the inbox file while AD-21 says the file is projected from rows. | AD-5: "On approval the Coordinator assigns `task_no` and creates the Branch and worktree from `origin/main` (no commit). The Branch's first commit is the AD-21 projection on first entry to `implementing`; for an inbox-born Task that commit also `git rm`s `.antipod/inbox/<slug>.*`." Update the sequence diagram line to `create Branch + worktree` and add `commit contract v1` just before `Implementer (worktree)`. |
| N2 | AD-3 note vs AD-4, AD-8, sequence diagram | AD-3 (text under the diagram): "`testing` and `verifying` are the Recipe `test` step and the Validator's Evidence check; **both are Coordinator-run**". AD-4 defines `ValidatorOutput` "in Evidence mode" and the sequence diagram shows `C->>S: Validator (evidence mode)` — a Stage, which is subject to concurrency counting, the usage-window gate, retries and `stage_id` gating. An epic author reading AD-3 will implement the Evidence check as pure Coordinator code. | AD-3 note: "`testing` is the Coordinator-run Recipe `test` step; `verifying` is a Validator Stage in Evidence mode (AD-4). Both appear in `/status` as 'validating'." |
| N3 | AD-3 generic events "valid from every non-terminal state" vs the rest of the diagram | Taken literally: `amended → implementing` from `draft`, `awaiting_approval`, `queued` (bypasses every AD-11 gate), `merged` and `release_failed` (restarts an already-merged Task); `pause` from `accept_pending`/`discard_pending` (freezes an undo deadline that AD-10's callback still honours), from `merged` (what is paused?) and from `in_review` (nothing runs); `resume` to a `resume_state` that may itself be `accept_pending`. | AD-3: define `ACTIVE = {queued, waiting_on_dependencies, implementing, testing, validating, triage, evidencing, verifying, in_review, stuck}`; `cancel` from every non-terminal state; `pause` and `amended` from `ACTIVE` only (`amended` from `queued` re-enters `queued`, not `implementing`); `stage_retries_exhausted` from the Stage-running states only; `deps_unsatisfiable` from `waiting_on_dependencies` only. |
| N4 | AD-3 budget bullet vs AD-3 generic events | "The Task goes to `stuck` **only** after a Triage Stage has written the reason" vs `stage_retries_exhausted → stuck` and `deps_unsatisfiable → stuck`, both direct. The Stuck card (EXPERIENCE) needs a reason line in all three cases, and a Triage Stage that itself exhausts retries would recurse. | "…only after a Triage Stage has written the reason, except `stage_retries_exhausted` and `deps_unsatisfiable`, where the Coordinator writes the reason (`<role> failed <n> times: <last error>` / `depends on cancelled #<n>`)." |
| N5 | AD-11 concurrency gate vs AD-3 `testing`/`integrating` | AD-11 counts "Tasks whose current Stage is `starting` or `running`". A Task in `testing` (Coordinator-run step, no Stage) or in `integrating` between the rebase and the Validator Stage is not counted, so the scheduler can start a third Task; seconds later both resume Stage work and `limits.concurrency` is exceeded. | AD-11: count Tasks in `{implementing, testing, validating, triage, evidencing, verifying, integrating}` (i.e. Tasks that own agent or step work), not Stage rows; keep the Stage-row count only for the usage-window gate. |
| N6 | AD-3 "`stages` row `starting` inside the transition" vs AD-18 boot order | AD-18 both "marks every `stages` row in `starting` or `running` as `failed(restart)` and applies the retry policy" **and** "re-executes every `effects` row not `done`". A `start_stage` effect interrupted before the process spawned leaves a `starting` row and an undone effect; at boot the retry relaunches the Stage and the effect replay launches it again. | AD-18: "a `start_stage` effect whose `stages` row is no longer `starting` is marked `done` without launching" (or: sweep first, then replay, and the sweep marks the effect `superseded`). |
| N7 | AD-4 vs AD-3/AD-9 | AD-4 lists "Triage after a Stuck reply" as a Stage without a Branch. No AD-3 event starts Triage from `stuck`; the PRD and EXPERIENCE route Stuck replies through Intake (AD-9) to an Interpretation card. Dangling reference that will make the Triage Role epic implement a path that does not exist. | AD-4: delete "Triage after a Stuck reply"; Stages without a Branch are Intake only. |

### R — remaining first-round mediums/lows still open and cheap

| # | Source | Item | Fix |
| --- | --- | --- | --- |
| R1 | adversary H2, ux I6/I7 | Undo deadlines not persisted on the Task; window lengths unnamed. | See H2 row in §1 (one sentence in AD-3 + two `limits.*` keys in the `config.yaml` comment of the source tree). |
| R2 | adversary H9 | Stage process access to `ANTIPOD_PRIOR`. | See H9 row in §1. |
| R3 | ux F9, prd FR-3 | `onboarding_blocked` has a loud outbox kind but no producer. | See F9 row in §1. |
| R4 | prd NFR-4 | Honest statement of what AD-6 containment does and does not enforce. | See NFR-4 row in §1. |
| R5 | rubric M-3, ux N1/S1 | Chat-topology preconditions (supergroup, privacy mode off or bot admin) checked by `/register`; behaviour of `/register` in an already bound group. | AD-10: "`/register` fails loudly (`registration_failed`) unless the chat is a supergroup and the bot can read non-command messages (admin or privacy mode off); a bound chat answers with its Project name and does nothing." |
| R6 | ux S7/F10 | Project-level pause storage; once-per-pause notice dedupe. | See S7 and F10 rows in §1. |
| R7 | versions F7 | Missing `result` on the SIGTERM path. | See F7 row in §1. |
| R8 | AD-7 / AD-8 | `ANTIPOD_OUT` location is never fixed (AD-7 says what it is for; the seed's `outputs: build/outputs` is worktree-relative; AD-8's Peek globs "under `ANTIPOD_OUT` of the newest step run"). Two Runners could place it differently. | AD-7: "`ANTIPOD_OUT` = `data/steps/<step_run_id>/out/`; `outputs:` names a worktree path the Runner copies into it after the step exits." |
| R9 | AD-13 | A Recipe with no `test` step: `implementer_done` has no `test_passed` producer; OpenSCAD Projects may not declare one. | AD-13: "a Recipe without a `test` step emits `test_passed` immediately." |
| R10 | AD-5 vs AD-13 | "Branches are kept" (AD-5) vs bootstrap Branch deleted (AD-13). Intentional, but AD-5 should carry the exception. | AD-5: "Branches are kept, except the bootstrap Branch (AD-13)." |
| R11 | rubric L-1 | Status tags still inconsistent: AD-6/13/14/17 carry `` `[ASSUMPTION]` `` and no `[ADOPTED]`; every other AD has `[ADOPTED]`. | Use `[ADOPTED, ASSUMPTION]` on those four headings. |
| R12 | ER vs AD-2 | `TELEGRAM_CHAT` and `REVIEW_ROUND` entities have no table in AD-2's list. | Either drop them from the ER diagram (chat id is a column on `projects`; round is `tasks.review_round` / `evidence.round`) or add the tables to AD-2. |
| R13 | AD-3 diagram | `[*] --> draft: owner_message / inbox_detected / promote_finding` — the Task row exists only once Intake returns `new_draft` (AD-9: "A `new_draft` alone becomes a Draft card"); a `not_actionable` or `correction` output creates no Task. As drawn, the Intake Stage would need a Task row to hang on while running. | Relabel to `new_draft` and state in AD-9 that an Intake Stage for an Owner message runs under the Project, with `task_id` null until `new_draft` creates the row (or decide that the `draft` row is created on `owner_message` and deleted on `not_actionable`). |

---

## 4. Rubric scorecard after the rewrite

| # | Criterion | Round 1 | Round 2 |
| --- | --- | --- | --- |
| 1 | Fixes the real divergence points | Fails | Passes once N1–N7 are applied |
| 2 | Every Rule enforceable | Mostly | Passes (NFR-4 wording R4 pending) |
| 3 | Nothing under Deferred lets units diverge | Fails | Passes (Demo-link contradiction now lives in the UX docs, not the spine) |
| 4 | Named tech plausible-current | Passes | Passes (versions lens corrections applied) |
| 5 | Covers FR-1..31, NFR-1..6 | Gaps | Passes; FR-3 "onboarding blocked" outcome R3 pending |
| 6 | Every dimension decided/deferred/open | Fails | Passes (AD-23, AD-24) |
| 7 | Mermaid valid and structural | Syntactically valid, semantic errors | Valid, rendered; two semantic notes (§2) |
| 8 | Terse, no placeholders | Passes | Passes; R11 tag consistency |

**Recommendation:** apply N1–N7 and R1–R4 (eleven one- or two-sentence edits) before cutting epics; R5–R13 can ride along in the same pass or be absorbed by the stories that touch them. Update DESIGN.md line 129 and EXPERIENCE.md lines 22, 91, 138 for N5 in the UX pass.
