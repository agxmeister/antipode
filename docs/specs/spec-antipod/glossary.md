# Glossary

Fixed vocabulary for every Antipode artifact. Capitalized terms in SPEC.md, the spine and the UX spines mean exactly this.

## People and Projects

- **Owner** — the one person who approves Task Contracts and accepts or corrects each Review. Exactly one per Project; only their Telegram user id is honoured.
- **Project** — one repository managed by Antipode, with one Recipe, one Owner and one Telegram chat (a private supergroup named `Antipode · <Project>`).
- **Recipe** — `antipod.yaml` at the repo root, written by the Owner. Declares the steps (build, test, evidence, demo, release), the Runner and timeout for each, the Evidence kinds the Project can produce, the Demo kind, fixtures for Preview Data and the *names* of secrets per step. Antipode consumes it and never invents it.
- **Runner** — where a Recipe step executes. **Container Runner**: a Podman container. **Host Runner**: the host machine, for tools that cannot run in a container here (Unity editor, Android emulator), addressed by **capability** name (`android-emulator`, `unity-editor`, `openscad`), never by path.
- **Exclusive capability** — a host capability only one step may hold at a time (one Unity editor); held through a lease.
- **Preview Data** — throwaway seed data for one Task's runs and Demo, created from Recipe fixtures. Never production data.
- **Bootstrap Task** — Task `#1` of every Project: one criterion per declared Evidence kind on a trivial visible change. Its accepted Review activates the Project. It is never merged or released.

## Tasks and contracts

- **Task** — one unit of work in a Project, defined by a Task Contract, executed on its own Branch, numbered per Project (`#12`).
- **Task Contract** — goal, Acceptance Criteria, Required Evidence per criterion, dependencies on other Tasks. Antipode's input API. Once a Task exists the stored rows are the record; `.antipod/tasks/<n>.yaml` on the Branch is a projection.
- **Inbox** — `.antipod/inbox/` on `main`, where the Owner drops contract files (`.yaml`) or BMad stories (`.md`) without numbers.
- **Acceptance Criterion (ACn)** — one testable statement the result must satisfy. Ids are assigned in contract order and never reused; a dropped criterion keeps its id.
- **Required Evidence** — the kind of proof expected for a criterion: screenshot, screencast, render, composite, test result, measurement or file.
- **Dependency** — a Task that must be merged to `main` before this one starts. No stacked Branches.
- **Branch** — the git branch and worktree of one Task (`antipod/<n>-<slug>`). Kept after cancel; worktree removed after release or cancel.
- **Iteration Budget** — the maximum number of Implementer runs for a Task, whatever caused them, except Owner Corrections, Stage retries, resumes and amendments. A spent budget makes the Task Stuck.
- **Lap** — one Implementer run counted against the budget (`lap 2/5`).
- **Stuck** — the Task state when the budget is spent, a blocker cannot be resolved, Stage retries are exhausted or dependencies are unsatisfiable. The Owner must decide.
- **Parking Lot (Pn)** — non-blocking findings Triage deferred instead of fixing, shown on the Review card and in `/parked`. Promoted or dismissed only by the Owner.

## Roles and execution

- **Role** — a kind of agent work with its own Role Config. MVP Roles: **Intake** (drafts contracts, interprets every Owner Message), **Implementer** (changes code on the Branch), **Validator** (checks the Branch against every criterion; in Evidence mode checks each artifact shows its criterion), **Evidence Producer** (creates Evidence), **Triage** (reruns or parks non-blocking findings, writes the Stuck reason).
- **Role Config** — a directory with instructions, MCP config, permissions and `role.yaml` (timeout, retries, max turns, output schema). Resolved package → `$ANTIPOD_HOME/roles/` → `.antipod/roles/` in the repo.
- **Stage** — one run of one Role on one Task: one fresh `claude -p` subprocess with typed JSON output. Stages read anything in the repo and write only their own worktree.
- **Step** — one Recipe step run, invoked by the Coordinator or by a Stage through `antipod step <name>`.
- **Coordinator** — the deterministic core: a persistent state machine over Tasks that starts Stages and steps, enforces timeouts, retries, budgets, dependencies, concurrency, Usage Window holds and backpressure. Contains no LLM.
- **Usage Window** — the Claude subscription's rolling 5-hour and weekly limits, shared by all Stages.
- **Integration** — after Accept: rebase on `main`, run the test step and the Validator, fast-forward merge, push.
- **Release** — the Recipe's release step after merge: internal build, WebGL deploy, GitHub release of STLs, or none.

## Evidence and Review

- **Evidence** — the artifacts produced for a Task, each linked to one criterion and one Review round, immutable once ingested.
- **Degraded Evidence** — non-visual proof (test output) for a criterion with a visible result. Allowed, always labeled `⚠️` with the reason.
- **Before/after composite** — one image with labelled BEFORE and AFTER halves; after a Correction the before half is the previous Review's Evidence.
- **Demo** — Evidence the Owner can try from the phone: an APK, STL or zipped WebGL build sent as a file. Optional. Link Demos are post-MVP.
- **Review** — the message sequence sent when a Task is reviewable: one Evidence message per criterion, the Demo, then the **Review card** (summary, criteria strip, Parking Lot, cost line, `Accept` / `Request changes`).
- **Review round** — increments once per Review delivered (entry to in review from verifying); a return through Undo or resume keeps the round. The only round number. Callbacks are valid only for the current round.
- **Review Queue** — Reviews delivered and not yet answered, counted across all Projects for backpressure.
- **Correction** — the Owner's `Request changes` feedback. Returns the same Task to the Implementer on the same Branch; does not use the budget.
- **Owner Message** — any free text or voice from the Owner: new Task request, Correction, Stuck reply or contract edit. Always interpreted by Intake into one typed instruction.
- **Draft card / Interpretation card / Stuck card / Peek reply / Status list / Parked list / Cost reply / Log reply** — the Telegram surfaces defined in EXPERIENCE.md → Information Architecture.
- **Progress Peek** — `/peek`: the latest visual plus one status line for a running Task. Read-only, never interrupts.
- **Undo window** — 10 s after Accept (and 1 min after Discard) during which the tap can be reversed; Integration starts only after it expires.
