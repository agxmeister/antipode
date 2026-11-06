---
id: SPEC-antipod
companions:
  - glossary.md
  - success-metrics.md
  - ../../planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md
  - ../../planning-artifacts/ux-designs/ux-antipod-2026-11-05/EXPERIENCE.md
  - ../../planning-artifacts/ux-designs/ux-antipod-2026-11-05/DESIGN.md
sources:
  - ../../planning-artifacts/prds/prd-antipod-2026-11-01/prd.md
  - ../../planning-artifacts/prds/prd-antipod-2026-11-01/addendum.md
  - ../../planning-artifacts/architecture/architecture-antipod-2026-11-05/SOLUTION-DESIGN.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Antipode MVP

Capability ids `CAP-1..CAP-31` map 1:1 to PRD `FR-1..FR-31`; the architecture spine's `binds:` lists and every `AD-n` citation use the FR numbers. `CAP-32` and `CAP-33` come from NFR-5 and the UX spine. Vocabulary is fixed in `glossary.md`. Where this file states a rule in fewer words than the spine or the UX spines, those companions hold the full rule.

## Why

A pain and an opportunity. The Owner (agxmeister) has personal software projects and almost no laptop time; routine implementation stalls them. Current agent tools (Cursor cloud agents, Copilot coding agent, Devin, Codex) end in a pull request, so the human still judges a diff on a laptop. Nothing closes the chain *contract with acceptance criteria → evidence per criterion → one-tap judgment on a phone → integration and release*. Antipode closes it: the Owner states what should exist and judges running results from a phone in about a minute; agents do everything between. The product is the acceptance surface, not the agents. It must work for very different projects from day one: an Android training tracker, a Unity game and OpenSCAD models for 3D printing, each declaring its own build, evidence and release in a Recipe.

## Capabilities

- **CAP-1** Register a Project (FR-1)
  - **intent:** The Owner can bind a repo that contains a Recipe to one Telegram chat as a Project with exactly one Owner.
  - **success:** `/register <repo>` in the Project group succeeds for a valid Recipe and answers with a loud, readable reason when it fails (no Recipe at root, invalid Recipe, secret value in Recipe, chat not a supergroup the bot can fully read); the group stays unbound on failure.

- **CAP-2** Recipe assigns a Runner per step (FR-2)
  - **intent:** The Recipe assigns each step (build, test, evidence, demo, release) to a Container Runner or a Host Runner, naming host tools by capability, so one Project can mix both.
  - **success:** A Project with a container build and a host emulator evidence step runs end to end with no manual step; two steps naming the same exclusive capability never run at the same time, across all Projects.

- **CAP-3** Bootstrap Evidence gate (FR-3)
  - **intent:** Every new Project starts with a bootstrap Task that proves the Recipe can produce Evidence; feature Tasks cannot start until the Owner accepts its Review.
  - **success:** The bootstrap Review shows at least one artifact per declared Evidence kind and is titled `#1 Bootstrap · Recipe check`; a Recipe that produces no visual or measurable Evidence leaves the Project in onboarding with a loud notice naming the failed step and its log; a bootstrap is never merged or released.

- **CAP-4** Recipe-declared Evidence kinds (FR-4)
  - **intent:** The Recipe declares which Evidence kinds the Project can produce, and Intake proposes Required Evidence only from that set.
  - **success:** A contract cannot be approved while any criterion's Required Evidence is outside the Project's declared kinds.

- **CAP-5** Preview Data and secrets (FR-5)
  - **intent:** Every Task's runs and Demo use their own throwaway Preview Data seeded from Recipe fixtures, and each step receives only the non-production secrets it names.
  - **success:** No Stage, step or Demo reads production data; a Recipe that contains a secret value, or references a `PROD_` secret outside the release step, fails validation; external services are reached only through sandbox credentials or stubs the Recipe declares; Stage agents receive no secret values at all.

- **CAP-6** Contracts from repo files (FR-6)
  - **intent:** The Owner can add Task Contracts or BMad story files to the repo inbox, and Antipode offers each one for approval.
  - **success:** A new inbox file on `main` yields exactly one Draft card; a file without criteria or without per-criterion Required Evidence is completed through Intake first; a contract already imported or merged is never offered again.

- **CAP-7** Draft a contract from a Telegram message (FR-7)
  - **intent:** The Owner describes a Task by text or voice and receives a draft Task Contract with at most two clarifying questions.
  - **success:** Voice is transcribed on the Mac before Intake runs; the Draft card fits one phone screen with goal, numbered criteria and the Evidence kind per criterion; the Owner's message gets a `👀` reaction within 5 s.

- **CAP-8** Evidence feasibility check (FR-8)
  - **intent:** Intake checks every criterion against the Project's Evidence kinds and proposes a substitute or flags the criterion.
  - **success:** An infeasible criterion shows `⚠️` with the proposed substitute and `Use proposal` / `Drop ACn` buttons; `Approve` stays hidden until every criterion is feasible and every question answered.

- **CAP-9** Approve, revise or discard a draft (FR-9)
  - **intent:** The Owner approves a draft with one tap, revises it by replying, or discards it.
  - **success:** On approval the Task gets its per-Project number, Branch and worktree and enters the queue; dependencies are recorded; the contract is committed on the Branch as a projection of the stored rows; the card is edited in place; Discard is undoable for 1 min.

- **CAP-10** Interpret every Owner Message (FR-10)
  - **intent:** Every free-text or voice message about an existing Task becomes one typed instruction (correction, contract amendment, new draft, cancellation or not actionable) before the Coordinator acts on it.
  - **success:** An ambiguous message gets exactly one clarifying question with buttons and nothing acts until answered; any free-text change to criteria, budget or cancellation needs `Confirm` on an Interpretation card; button taps never pass through Intake.

- **CAP-11** Persisted Task state (FR-11)
  - **intent:** Every Task's state and Stage history survive a restart of Antipode or the Mac.
  - **success:** Killing the daemon or rebooting mid-Task resumes every Task from its last completed Stage with no recorded Stage output, Evidence or Parking Lot entry lost; a Stage that was running is retried under the normal policy, never counted as a failure.

- **CAP-12** Stage execution with timeouts and retries (FR-12)
  - **intent:** The Coordinator runs each Stage as a fresh, ephemeral agent session with a per-Role timeout and typed output, and retries failures.
  - **success:** A Stage that times out, crashes, exhausts its turns or returns invalid output is relaunched up to the configured limit without using Iteration Budget, then the Task is Stuck with the reason recorded; no agent session runs while a Task waits for the Owner.

- **CAP-13** Validation routing and Iteration Budget (FR-13)
  - **intent:** The Coordinator routes each validated Task by outcome, and one Iteration Budget bounds every Implementer run whatever caused it.
  - **success:** Blocking findings return the Task to the Implementer; non-blocking findings go to Triage, which reruns or parks them; a pass goes to evidencing. Implementer runs caused by findings, Triage, failed tests, missing or rejected Evidence or Integration rework each use one budget unit; Corrections, retries, resumes and amendments never do. A spent budget produces a Stuck card with Triage's one-line reason, up to three attempts and the last Evidence. Triage always runs in a fresh session.

- **CAP-14** Owner controls (FR-14)
  - **intent:** The Owner can pause, resume or cancel any Task or Project at any time and edit any Task's contract.
  - **success:** A cancelled Task's Branch is kept and never merged; `Cancel Task` confirms in place; a confirmed amendment restarts an in-progress Task from implementing with a fresh budget; `/pause` without a Task pauses the Project.

- **CAP-15** Dependencies and concurrency (FR-15)
  - **intent:** A Task starts only when its dependencies are merged to `main`, and a global cap limits Tasks running at once.
  - **success:** The cap is configurable in 1–3 with default 2; no Task ever starts on another Task's unmerged Branch; a waiting Task shows `Queued · after #n` in `/status`.

- **CAP-16** Review Queue backpressure (FR-16)
  - **intent:** While the Owner has too many unanswered Reviews, no new Task starts.
  - **success:** With the default of 3 open Reviews across all Projects, no Task starts; running Tasks continue; answering any Review resumes starts; the state appears only in `/status`, never as a push.

- **CAP-17** Usage Window budgeting (FR-17)
  - **intent:** The Coordinator tracks the subscription's 5-hour and weekly windows and holds new Stages before a limit, resuming when the window allows.
  - **success:** A held Task shows `⏸ waiting for usage window · resumes ~time` once per pause and a silent `Resumed` after, never a failure; running Stages are never killed for the window; an unreadable window falls back to a local estimate.

- **CAP-18** Role Configs and extensible Roles (FR-18)
  - **intent:** The Owner defines a Role's instructions, tools and MCPs globally, overrides them per Project, and adds new Roles by configuration.
  - **success:** Role files resolve package → `$ANTIPOD_HOME` → repo, file by file; a new Role directory is usable by name with no code change; a Unity Project can give its Implementer and Evidence Producer a Unity MCP; repo-level Role Config is read only from pinned `main`.

- **CAP-19** Independent validation (FR-19)
  - **intent:** A Validator in its own session checks the Branch against every criterion and, before any Review, checks that each Evidence artifact shows its criterion.
  - **success:** No criterion is ever marked passed from the Implementer's own report; the Validator never shares a Stage with the Implementer.

- **CAP-20** Branch per Task, shared read visibility (FR-20)
  - **intent:** Each Task works on its own Branch and worktree; every Stage can read `main` and other Branches but writes only its own.
  - **success:** No two agents edit the same tree; shipped Role permissions deny writes to other worktrees, `.antipod/` and `$ANTIPOD_HOME`; after every Implementer Stage the Branch is pushed and the Recipe `test` step runs.

- **CAP-21** Evidence per criterion (FR-21)
  - **intent:** The Evidence Producer creates Evidence for every criterion, each artifact linked to its criterion.
  - **success:** A Task with any criterion lacking Evidence goes back to the Implementer and never reaches the Owner; only the Evidence Producer creates artifacts; the Validator verifies every artifact before the Review is sent.

- **CAP-22** Visual-first, before/after Evidence (FR-22)
  - **intent:** A criterion with a visible result gets a visual; a change to something that already existed visibly gets a before/after pair; non-visual proof for a visible result is labeled Degraded.
  - **success:** The Review after a Correction opens with before/after composites against the previous Review; a Degraded artifact carries `⚠️` and its reason in the caption and the criteria strip and is never hidden; composites and callouts come from one renderer using the DESIGN.md tokens.

- **CAP-23** Phone-native Evidence (FR-23)
  - **intent:** Evidence arrives in forms a phone shows inline: images, videos of 60 s or less, and small files.
  - **success:** Ingest rejects a video over 60 s or an artifact over 50 MB and sends the Task back to the Implementer with the reason; each criterion is one media message; a screencast shows only the behavior of its criterion.

- **CAP-24** Demo when feasible (FR-24)
  - **intent:** When the Recipe declares a Demo and the Task changes something the Owner can try, the Review includes a file to try.
  - **success:** An APK, STL or zipped WebGL build arrives as a Telegram file captioned `Demo · what to try`, after the Evidence and before the card; a Demo over the upload cap is reported as `file too large, not sent`; nothing is ever reachable without authentication.

- **CAP-25** Durable Evidence (FR-25)
  - **intent:** Evidence outlives its Branch and worktree and can be retrieved for any past Task.
  - **success:** `/evidence <id>` resends the Task's Evidence and a read-only copy of its last Review card after the Branch is merged or deleted; Evidence files and rows are never updated or deleted.

- **CAP-26** Review message (FR-26)
  - **intent:** A reviewable Task reaches the Owner as one Review: Evidence per criterion, the Demo, then a card with a one-line summary, criteria strip, Parking Lot, cost line and `Accept` / `Request changes`.
  - **success:** The Review is judgeable on a phone without opening the repo, a diff or a laptop; prose beyond labels is at most 5 short lines; only the card makes a sound; one Review sequence at a time per chat; the card is edited in place after any tap.

- **CAP-27** Accept (FR-27)
  - **intent:** The Owner accepts a Review with one tap and Integration follows.
  - **success:** The tap is acknowledged by toast within 5 s and the card shows `Undo` for 10 s before Integration starts; a tap on a superseded card gets `This Review was replaced by a newer one.` and acts on nothing.

- **CAP-28** Correction, Progress Peek, status and Stuck replies (FR-28)
  - **intent:** The Owner can request changes by text or voice, peek at a running Task without interrupting it, list Tasks and their states, and answer a Stuck card.
  - **success:** A Correction returns the same Task to the Implementer on the same Branch with the note and previous Evidence in context, no new contract and no budget use. `/peek` answers with the latest visual and `Role · status · lap n/budget · elapsed`, never interrupts a Stage. `/status` groups Needs you / Running / Queued / Done and ends with an `Elsewhere:` line. A Stuck card offers `Raise budget +2` and `Cancel Task`, and free replies go through Intake. Every Task-scoped action resolves by reply target, explicit id, or candidate buttons.

- **CAP-29** Integration after Accept (FR-29)
  - **intent:** After Accept the Task is rebased on `main`, re-tested and re-validated, then merged by fast-forward.
  - **success:** The merge happens without a new Review only when the rebase is clean and test and Validator pass; a conflict or failed revalidation returns the Task to the Implementer (one budget unit) and a new Review marked `Re-review: rebase needed changes after your Accept.` precedes any merge.

- **CAP-30** Recipe-defined Release (FR-30)
  - **intent:** After merge, Antipode runs the Recipe's release step if declared and confirms the outcome.
  - **success:** The card and a silent reply show `📦 Released as …` or `✅ Merged · no release step`; a failed release sends a loud notice with the reason and `Retry release` / `Leave it`, and `main` is not rolled back; Tasks depending on the merged Task become eligible.

- **CAP-31** Per-Task and per-Stage cost (FR-31)
  - **intent:** Antipode records tokens, wall time and Usage Window share per Stage and aggregates per Task and Project.
  - **success:** Every Review card carries `~tokens tok · min · window-share% window`; `/cost` answers by window, Task and Project and `/cost <id>` per Stage; an unknown share shows as `—`.

- **CAP-32** Stage logs on demand (NFR-5)
  - **intent:** Every Stage leaves its transcript and step logs in the Task record, and the Owner can retrieve them.
  - **success:** `/log <id>` lists one line per Stage (`Role · outcome · duration`) with the logs attached as a file, never as an external link.

- **CAP-33** Parking Lot promotion (UX OQ7)
  - **intent:** The Owner turns a parked finding into a draft Task, or dismisses it; nothing is drafted automatically.
  - **success:** `🅿️ Pn → Task` on the card or `→ Task` in `/parked` yields a Draft card linked to the source Task; `Dismiss` removes it from the list but not the record; unpromoted findings remain in `/parked` after Accept.

## Constraints

- The agent is the unmodified Claude Code CLI on the Owner's subscription; API-key mode is a configuration switch (`agent.auth`), never a redesign. After one week of daily runs the Owner decides whether API-key mode enters the MVP.
- The Coordinator is deterministic, contains no LLM and is the only component that changes Task state; LLM judgment enters only through typed Stage outputs, and free text that changes criteria, budget or cancellation takes effect only after the Owner confirms.
- Telegram is the only Owner surface. The bot uses long polling with no public URL; Evidence and Demos are private to the Owner and leave the Mac only through Telegram.
- Every Owner action is acknowledged within 5 s even when the work takes longer.
- MVP host is the Owner's Mac, plugged in and awake; sleep pauses Tasks and never fails them. Nothing outside the host adapter assumes macOS, and Recipes name host capabilities, not paths, so a Linux VM is the next host without redesign.
- Isolation: Stages write only their own worktree and receive no secret values; `PROD_` secrets reach only the release step; Recipe, Role Config and inbox are read from pinned `main`, never from a Task Branch.
- Concurrency is 1–3 Tasks (default 2); backpressure holds starts at 3 open Reviews globally; one Iteration Budget per Task counts every Implementer run except Corrections, retries, resumes and amendments.
- Licensed host tools (Unity, Android SDK) are the Owner's existing installations; Antipode never provisions them.
- Owner-facing copy follows EXPERIENCE.md and DESIGN.md: outcome first, proof before prose, no apologies or narration, glyphs always followed by text, one card per Review round edited in place.
- Stack, layering, data model and testing strategy are fixed by the architecture spine (AD-1..AD-24).
- Build order and cut line, if time runs short cut from the bottom: 1) Coordinator lifecycle and the Telegram Review, Accept and Correction loop; 2) Android Evidence on the training tracker; 3) voice intake; 4) Unity and OpenSCAD Projects.

## Non-goals

- Originating product ideas or writing specs; Antipode consumes intent.
- Code review: diffs, file trees and code links never appear in a Review.
- An orchestrator agent or any LLM owning project-wide state.
- Teams, shared review or a permissions model; exactly one Owner per Project.
- Provisioning cloud infrastructure, app-store publishing or licensed toolchains.
- A web UI, multi-vendor agents (e.g. Codex), API-key billing, or a dedicated VM host; all phase two.
- An automated reviewer replacing the Owner.
- iOS for the training app.
- Steering or interrupting a running Stage; Progress Peek is read-only.
- Link Demos, preview environments and preview sleep/wake; Demos over 50 MB; off-machine Evidence copies and retention policy; all post-MVP.
- Auto-drafting Tasks from Parking Lot findings.

## Success signal

Within about three weeks of the training tracker's bootstrap, the Owner logs real workouts in the Android app, having steered most of its development from the phone, and the median Review takes about one minute to judge and never more than two. Secondary and counter-metrics are in `success-metrics.md`.

## Assumptions

- A BMad story maps to a Task Contract through Intake alone; a deterministic parser is added only if that proves unreliable.
- A failed Release never rolls back `main`.
- The Usage Window is read from the undocumented OAuth usage endpoint Claude Code's `/usage` uses, with a local estimator as fallback; per-Stage window share is the utilization delta sampled after the Stage.
- The Stage agent runs on the host; isolation is Claude Code permission policy plus a secret-free environment, not OS enforcement, until the VM host.
- Secret values live in mode-600 env files under `$ANTIPOD_HOME`; macOS Keychain is deferred.
- Voice notes are transcribed locally with whisper.cpp and never leave the Mac.
- Registration happens by `/register <repo>` from the Project group; the `antipod register` CLI is the fallback on the same code path.
- UX calls not confirmed by the PRD: Discard undo of 1 min; `Raise budget +2`; a callout box when the changed region is under about a quarter of the frame; landscape composites stack vertically; no home chat (an `Elsewhere:` line instead); bot name Antipode with a monogram avatar; neutral function-only annotation colors; the cost reply layout.

## Open Questions

- FR-26 reading: the Review is spread across messages with the summary on the card after the media, so the buttons sit under the thumb. EXPERIENCE.md asks the PM to confirm; does the Owner confirm?
- Is the working title "Antipode" final? The PRD and DESIGN.md both ask.
- Usage Window spike (PRD OQ4): does the usage endpoint work from the daemon? Until known, CAP-17 runs on the estimator.
- Unity automation spike (PRD OQ5): can the editor be driven reliably through the uplink MCP? Needed before cut-line step 4.
- Initial config values (PRD OQ8): Iteration Budget default, Role timeouts, retries, `max_turns` and `usage.pause_at_percent`.
