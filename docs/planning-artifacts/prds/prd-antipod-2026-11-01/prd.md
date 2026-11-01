---
title: Antipode — PRD
status: draft
created: 2026-11-01
updated: 2026-11-01
---

# PRD: Antipode
*Working title — confirm.*

## 0. Document Purpose

This PRD defines the MVP of Antipode: an autonomous, downstream software factory run by a single owner from a phone. It is written for the owner (agxmeister) and for the downstream BMad workflows (`bmad-ux`, `bmad-architecture`, `bmad-create-epics-and-stories`). It builds on the forged idea at `docs/forge/antipode-autonomous-dev-factory/forged-idea.md` and its session log. Where this PRD changes a lock from the forge, it says so and names the replacement. Vocabulary is fixed in §3 Glossary. Features in §4 nest globally numbered requirements (FR-N). Inferred points carry inline `[ASSUMPTION]` tags, collected in §11. Technical direction and rejected alternatives live in `addendum.md`. Landscape research lives in `research-landscape.md`.

## 1. Vision

Antipode lets one busy person run software projects like a manager runs a team. The owner decides what should exist and whether the result is good enough. Agents do the routine work in between: writing code, building, testing, and producing proof. The owner never opens a laptop to check a branch. A task arrives on the phone as a short report with screenshots, a screencast, or a build to try, and the owner taps **Accept** or replies with a correction in one sentence.

The product is the **acceptance surface**, not the agents. Agents, containers, branches and CI are plumbing. What Antipode adds is a chain that no current tool closes end to end (see `research-landscape.md`):

contract with acceptance criteria → evidence produced for each criterion → one-tap judgement on a phone → integration and release.

Comparable tools (Cursor cloud agents, Copilot coding agent, Devin, Codex) end in a pull request. The human still judges the diff. Antipode ends in a judgement on the running result.

Antipode works across very different kinds of projects. The first three are an Android training tracker, a Unity game and OpenSCAD models for 3D printing. Each project declares in a **Recipe** how it is built, run, released and evidenced. Antipode itself does not depend on the type of project.

## 2. Target User

### 2.1 Jobs To Be Done
- **Functional:** move a personal project forward without spending laptop time on routine. Delegate the implementation, keep the decisions.
- **Responsibility:** stay accountable for what ships. Nothing reaches a Release without the owner accepting it, and the owner accepts knowing what was deferred.
- **Steering:** keep the work on track through quick reactions to intermediate results, not by writing detailed instructions upfront.
- **Emotional:** feel like a manager guiding a capable team toward outcomes, not like a babysitter of a chatbot.
- **Contextual:** review in short gaps (a commute, a queue) with one hand on a phone, and spend about a minute per task.

### 2.2 Non-Users (v1)
- Teams with several reviewers or approvers. MVP has exactly one Owner per Project.
- People who want the factory to invent the product. Antipode consumes intent; it does not originate it. Upstream idea-forming is phase two.
- People who want to review code. Code is never the review surface.

### 2.3 Key User Journeys

- **UJ-1. agxmeister kicks off a task from the tram.**
  agxmeister is on the tram and remembers the training app has no rest timer between sets. In the Antipode Telegram chat they send a voice note: "add a rest timer after each set, 90 seconds default." Within a few minutes the Intake agent replies with a draft Task Contract. It has three Acceptance Criteria, each with its Required Evidence, for example "screencast: finish set → timer starts → counts down → vibrates at zero." It asks one question: "Can the default be changed per exercise?" agxmeister answers "not yet" and taps **Approve**. The Task is queued, and they put the phone away.
  **Edge case:** if a criterion can't be evidenced by the Project's Recipe (for example, haptics in an emulator), Intake says so and proposes a substitute (a log line plus a screenshot) before Approve is offered.

- **UJ-2. agxmeister accepts a finished task in under a minute.**
  A Review arrives: one line summary, then each Acceptance Criterion with a ✅ and its evidence inline. That means a 20-second screencast from the emulator, two screenshots, and a link to install the APK on the phone. Below that is a Parking Lot of one deferred finding ("timer text overlaps on very small screens") and a cost line ("~38k tokens, 14 min, 4% of the 5-hour window"). agxmeister watches the screencast, installs the APK, tries it once, and taps **Accept**. Later a short message confirms: "Merged and released as internal build 0.4.2."

- **UJ-3. agxmeister corrects instead of accepting.**
  The screencast shows the timer, but it's tiny. agxmeister taps **Request changes** and types "timer should be big, center of screen." The same Task goes back to the Implementer on the same Branch, under the original criteria plus the note. Then the Validator reruns. The next Review starts with what changed compared with what agxmeister saw last time: a before/after screenshot pair. agxmeister accepts.

- **UJ-4. agxmeister handles a stuck task.**
  A Unity task uses up its Iteration Budget because the Validator keeps rejecting a physics behaviour. agxmeister receives a **Stuck** message. It says what was attempted, the last evidence, and the Triage agent's one-line reason ("criterion 2 contradicts existing jump height"). agxmeister replies "drop criterion 2, make a new task for it". The Task resumes with an amended contract.

- **UJ-5. agxmeister peeks at progress.**
  While waiting in a queue, agxmeister sends `/peek` on a running OpenSCAD task. They get the latest render and one line: "Implementer: adding fillet to the hinge, 2nd lap of 5." Nothing is interrupted.

## 3. Glossary

- **Owner** — the single person who approves Task Contracts, reviews, accepts or corrects. Exactly one per Project.
- **Project** — one repository managed by Antipode, with one Recipe and one Owner.
- **Recipe** — a file checked into the Project repo, written by the Owner. It declares how to build, run, test, produce Evidence, provide a Demo, and Release. It also declares the Runner for each step, seed data, and secrets for non-production use. Antipode consumes it and never invents it.
- **Runner** — where a Recipe step executes: a **Container Runner** (Podman container) or a **Host Runner** (directly on the Owner's Mac, for tools such as the Unity editor or the Android emulator).
- **Task** — one unit of work in a Project, defined by a Task Contract, executed on its own Branch.
- **Task Contract** — a structured file in the repo: goal, Acceptance Criteria, Required Evidence for each criterion, dependencies on other Tasks. It is the input API of Antipode.
- **Acceptance Criterion** — one testable statement the result must satisfy.
- **Required Evidence** — the kind of proof expected for an Acceptance Criterion (screencast, screenshots, render, test result, measurement, Demo).
- **Evidence** — artifacts actually produced for a Task, mapped to its Acceptance Criteria.
- **Demo** — a hands-on form of Evidence the Owner can try from the phone (an installable APK, a WebGL build, a preview URL, a downloadable STL). Provided when the Recipe and the Task allow it; not mandatory.
- **Review** — the message sent to the Owner when a Task is reviewable: summary, Evidence per criterion, Demo if any, Parking Lot, cost.
- **Correction** — the Owner's free-text feedback on a Review. It sends the same Task back to the Implementer on the same Branch.
- **Progress Peek** — an on-demand, read-only snapshot of a running Task: latest visual Evidence plus one line of status.
- **Role** — a kind of agent work: **Intake**, **Implementer**, **Validator**, **Evidence Producer**, **Triage**. Each run of a Role is a fresh, ephemeral agent session with its own context built from the Task record, the repo and the Role Config.
- **Role Config** — instructions, skills and MCPs for a Role, set globally and overridable per Project.
- **Stage** — one run of one Role on one Task.
- **Coordinator** — the non-intelligent component that holds Task state, starts Stages, enforces timeouts, retries, Iteration Budgets, dependencies and concurrency. It contains no LLM.
- **Iteration Budget** — the maximum number of Implementer→Validator laps for a Task before it becomes **Stuck**.
- **Stuck** — a Task state: the budget is spent or a blocker can't be resolved by agents; the Owner must decide.
- **Parking Lot** — the ledger of non-blocking findings that Triage deferred instead of fixing. It is shown in the Review.
- **Branch** — the Git branch of one Task. One Branch per Task; no stacked Branches.
- **Integration** — what happens after Accept: rebase on main, re-run Validator and CI, merge.
- **Release** — the Recipe-defined step after merge (internal build, WebGL deploy, GitHub release of STLs, or none).
- **Usage Window** — the Claude subscription's rolling 5-hour and weekly limits, shared by all Stages.

## 4. Features

### 4.1 Project Onboarding & Recipe
**Description:** A Project becomes active in Antipode when it has a Recipe that works. The first Task of every new Project is "bootstrap evidence". Antipode runs the Recipe end to end on a trivial change and shows the Owner the resulting Evidence and Demo, if any. Until that Review is accepted, feature Tasks can't start. This replaces the forge's "demo-first" lock with **evidence-first**: what's mandatory is reliable Evidence, not a live preview URL. Some projects have no web preview. A Unity game or an OpenSCAD model is shown by recordings, renders or files.

#### FR-1: Register a Project
The Owner can register a Project by pointing Antipode at a repo that contains a Recipe.
- Registration fails with a readable reason if the Recipe is missing or doesn't validate against the Recipe schema.
- A Project has exactly one Owner and one Telegram chat binding.

#### FR-2: Recipe declares Runners per step
A Recipe can assign each step (build, run, test, evidence, demo, release) to a Container Runner or a Host Runner.
- A Project mixing both (e.g. Container build + Host Android emulator for screencasts) runs without manual steps.
- Steps on a Host Runner are serialised where the Recipe marks the host resource exclusive (e.g. one Unity editor instance).

#### FR-3: Bootstrap Evidence gate
Antipode creates a bootstrap Task for each new Project and blocks other Tasks until it is accepted.
- The bootstrap Review shows at least one Evidence artifact of each kind the Recipe declares.
- If the Recipe can't produce any visual or measurable Evidence, the Project stays in onboarding, and the reason is reported to the Owner.

#### FR-4: Recipe-defined Evidence kinds
The Recipe declares which Evidence kinds the Project can produce (e.g. Android: emulator screencast, screenshots, APK; Unity: play-mode recording, screenshots, WebGL build; OpenSCAD: multi-angle renders, printability check, STL).
- Intake only proposes Required Evidence the Recipe can produce (see FR-7).

### 4.2 Task Intake & Contracts
**Description:** Tasks enter as Task Contracts. The Owner either commits contract files (including stories produced by BMad), or sends a rough request by Telegram text or voice. The Intake agent then turns it into a draft contract. No Task starts without Acceptance Criteria and without the Owner's approval. Antipode never invents intent: Intake asks, it does not decide. Realizes UJ-1.

#### FR-5: Accept contract files from the repo
The Owner can add Task Contracts as files in the Project repo. Antipode detects new or changed contracts and offers them for approval.
- A contract file without Acceptance Criteria, or without Required Evidence for any criterion, is routed to Intake rather than queued.
- BMad story files are accepted as a source format. `[ASSUMPTION: a mapping from BMad story ACs to Task Contract fields is sufficient; exact mapping is an architecture concern.]`

#### FR-6: Draft a contract from a Telegram message
The Owner can send a text or voice message describing a Task. Intake replies with a draft Task Contract and at most one or two clarifying questions.
- Voice messages are transcribed before Intake runs.
- The draft is shown compactly on a phone: goal, numbered criteria, Evidence kind per criterion.

#### FR-7: Evidence feasibility check
Intake checks every Acceptance Criterion against the Project's Evidence kinds (FR-4). Where a criterion can't be evidenced, Intake proposes a substitute or flags it.
- No contract can be approved with a criterion that has no feasible Required Evidence.

#### FR-8: Approve, edit, or discard a draft
The Owner can approve a draft, reply with changes (Intake revises), or discard it.
- On approval, the contract is committed to the repo and the Task enters the queue.
- Dependencies on other Tasks are recorded and respected (FR-13).

### 4.3 Coordinator & Task Lifecycle
**Description:** A deterministic Coordinator moves each Task through its states. The states are queued → implementing → validating → (triage) → evidencing → in review → integrating → released, with Stuck and Correction loops. It persists state, so a restart of Antipode or the Mac loses nothing. It contains no LLM. Intelligence lives only inside Stages.

#### FR-9: Persisted Task state
The Coordinator persists every Task's state and Stage history.
- After a restart, every Task resumes from its last completed Stage. No Stage output that was already recorded is lost.

#### FR-10: Stage execution with timeouts and retries
The Coordinator starts each Stage as a fresh, ephemeral agent session and enforces a timeout per Role.
- A timed-out or crashed Stage is retried up to a configured limit, then the Task goes Stuck with the reason.
- No agent session runs while a Task waits for the Owner.

#### FR-11: Iteration Budget
Each Task has an Iteration Budget (default configurable; overridable per contract).
- When the budget is spent, the Task becomes Stuck. The Owner receives what was attempted, the last Evidence and Triage's reason. Realizes UJ-4.

#### FR-12: Triage at branch points
When the Validator returns non-blocking findings, the Coordinator starts a Triage Stage. Triage decides either to re-run the Implementer or to park the findings in the Parking Lot.
- Triage runs in a clean context. It is not the Implementer or the Validator.
- Every parked finding is recorded with its Task and shown in that Task's Review.

#### FR-13: Dependencies and concurrency
A Task starts only when all its dependencies are merged to main. At most N Tasks run at once across all Projects (default 2–3, configurable).
- No Task is ever started on top of another Task's unmerged Branch.

#### FR-14: Usage Window budgeting
The Coordinator tracks consumption of the subscription Usage Window. Before a limit is hit, it pauses new Stages, and resumes when the window allows.
- A paused Task is shown to the Owner as "waiting for usage window", with an estimated resume time, not as failed.
- `[ASSUMPTION: usage and window position can be read or estimated from what Claude Code exposes; accuracy is approximate.]`

### 4.4 Roles & Separation of Duties
**Description:** Each Role is a fresh agent session with its own Role Config. The worker never grades its own work.

#### FR-15: Role Configs
The Owner can define Role Configs (instructions, skills, MCPs) globally and override them per Project.
- A Unity Project can give the Implementer and the Evidence Producer a Unity MCP. An OpenSCAD Project can give a render/validation MCP.

#### FR-16: Independent validation
The Validator checks the Task against every Acceptance Criterion on the Task's Branch. It is a separate session from the Implementer.
- A criterion is never marked passed by the Implementer's own report.

#### FR-17: Branch per Task
Each Task works on its own Branch. Agents never edit the same working tree at once.
- CI runs on every push to every Task Branch. `[ASSUMPTION: CI location (hosted vs local runner) is decided per Project in the Recipe; Unity/Android CI may need the Host Runner.]`

### 4.5 Evidence
**Description:** Evidence is the product's core object. A Task can't become reviewable until every Acceptance Criterion has its Required Evidence. Evidence is visual whenever possible: screenshots, screencasts, renders. Data-level proof (counts, test names, measurements) is used where visuals can't show the result.

#### FR-18: Evidence per Acceptance Criterion
The Evidence Producer creates Evidence for each Acceptance Criterion and links each artifact to its criterion.
- A Task with any criterion lacking Evidence never reaches the Owner as a Review. It goes back through Triage.

#### FR-19: Phone-native Evidence
Evidence is delivered in forms a phone shows inline: images, short videos (target ≤ 60 s each), small files (APK, STL).
- Each screencast is trimmed to the behaviour the criterion covers.

#### FR-20: Demo when feasible
When the Recipe supports it and the Task affects something tryable, the Review includes a Demo (installable APK, WebGL link, preview URL, STL download).
- Demo links reachable over the network require authentication or a private network path. They are never public and unauthenticated.

#### FR-21: Durable Evidence
Evidence is stored by Antipode and remains available after the Branch is merged or deleted.
- The Owner can retrieve the Evidence for any past Task.

### 4.6 Telegram Acceptance Surface
**Description:** The Owner's whole interaction happens in Telegram. Messages are minimal-text and visual-first. Each Review must be judgeable in about a minute. Realizes UJ-1 to UJ-5.

#### FR-22: Review message
When a Task is reviewable, the Owner receives a Review. It contains a one-line summary, each Acceptance Criterion with its status and inline Evidence, the Demo if any, the Parking Lot, and the cost line (FR-29). It ends with buttons: **Accept** and **Request changes**.
- The Review fits on a phone without needing to open the repo, a diff, or a laptop.

#### FR-23: Accept
The Owner can accept a Review with one tap. Acceptance triggers Integration (FR-26).

#### FR-24: Correction
The Owner can request changes with free text (or voice). The same Task returns to the Implementer on the same Branch, with the note and the prior Evidence in context.
- No new intake happens. The original criteria still apply, plus the note.
- The agents may ask at most one clarifying question before working.
- The next Review starts with what changed compared with the previous Review (e.g. before/after pairs). Realizes UJ-3.

#### FR-25: Progress Peek, status, and Stuck handling
The Owner can request a Progress Peek on any running Task, and a status list of all Tasks. When a Task is Stuck, the Owner receives a Stuck message and can reply with a decision. The reply can amend the contract, drop a criterion, raise the budget, or cancel.
- A Progress Peek never interrupts or restarts a Stage. Realizes UJ-5.

### 4.7 Integration & Release
**Description:** Accept does not mean merge. After Accept, the Coordinator rebases the Branch on main, re-runs the Validator and CI, merges, then runs the Recipe's Release step.

#### FR-26: Integration after Accept
On Accept, the Coordinator rebases on main and re-runs the Validator and CI, then merges.
- A rebase conflict or failed re-validation returns the Task to the Implementer. The Owner receives a new Review only if the visible result changed. Otherwise integration completes silently with a confirmation.

#### FR-27: Recipe-defined Release
After merge, Antipode runs the Recipe's Release step, if declared, and confirms the outcome to the Owner (e.g. "released as internal build 0.4.2").
- A Project without a Release step completes at merge.
- A failed Release is reported to the Owner with the reason. Main is not rolled back automatically. `[ASSUMPTION]`

#### FR-28: Dependents unblock on merge
When a Task merges, Tasks that depend on it become eligible to start (FR-13).

### 4.8 Usage & Cost Tracking
**Description:** The Owner sees what each Task and Stage cost, as tokens, wall time and share of the Usage Window. These values are approximate on a subscription.

#### FR-29: Per-Task and per-Stage cost
Antipode records tokens, wall time and estimated Usage Window share for every Stage, aggregated per Task and per Project.
- Every Review shows a one-line cost summary.
- The Owner can request a cost breakdown on demand (per Task, per Project, current window).

## 5. Cross-Cutting NFRs

- **NFR-1 Review time:** a typical Review is judgeable in ≤ 2 minutes on a phone, including watching Evidence.
- **NFR-2 Durability:** no Task state, Evidence, or Parking Lot entry is lost on restart of Antipode or the Mac (FR-9, FR-21).
- **NFR-3 Determinism:** Task transitions are made only by the Coordinator from recorded state. No LLM decides lifecycle transitions outside of Triage's bounded choice.
- **NFR-4 Isolation:** Stages run with access only to their Task's Branch and the Project's non-production secrets. Agents never get production credentials beyond what the Recipe's Release step requires.
- **NFR-5 Observability:** every Stage leaves a log and its output in the Task record, retrievable by the Owner on demand.
- **NFR-6 Latency of acknowledgement:** every Owner action in Telegram (approve, accept, correct, peek) is acknowledged within a few seconds, even if the work it triggers takes longer.

## 6. Constraints & Guardrails

- **Subscription terms (Cost/Safety):** MVP runs the unmodified Claude Code CLI on the Owner's own subscription. Anthropic's terms assume "ordinary, individual usage." Concurrency limits (FR-13) and window budgeting (FR-14) keep usage close to that. Switching to API keys must stay a configuration change, not a redesign (phase two). See `research-landscape.md`.
- **Privacy:** Evidence and Demos are private to the Owner. They are delivered through Telegram or authenticated or private-network links only (FR-20).
- **Single machine:** everything runs on the Owner's Mac. `[ASSUMPTION: the Mac stays powered and online while Tasks run (e.g. plugged-in laptop or always-on Mac); behaviour on sleep is "pause and resume", not failure.]`
- **Licensed tools:** Host Runner steps may depend on licensed software (Unity). Antipode uses the Owner's existing installation and license; it does not provision them.

## 7. Tone of Owner-facing Messages

Messages read like a competent team lead reporting to their manager. They are short and lead with the outcome. Proof comes before prose. They don't apologize or narrate. Questions are rare, specific and answerable in one word where possible. Visuals carry the message; text labels them.

## 8. Non-Goals (Explicit)

- Antipode does not originate product ideas or write specs without the Owner. Upstream ideation is phase two.
- Antipode is not a code review tool. Diffs are never the review surface.
- No orchestrator agent. An LLM never owns project-wide state.
- Antipode is not multi-user: no teams, no shared review, no permissions model in v1.
- Antipode does not provision cloud infrastructure, app-store publishing, or licensed toolchains.

## 9. MVP Scope

### 9.1 In Scope
- Project registration with Recipe; Container and Host Runners; bootstrap Evidence gate (FR-1–4).
- Task Contracts from repo files (incl. BMad stories) and from Telegram text/voice via Intake (FR-5–8).
- Deterministic Coordinator: persisted state, timeouts, retries, Iteration Budget, Triage, dependencies, concurrency 2–3, Usage Window budgeting (FR-9–14).
- Roles: Intake, Implementer, Validator, Evidence Producer, Triage, with configurable Role Configs (FR-15–17).
- Evidence per criterion, phone-native, durable; Demo when feasible (FR-18–21).
- Telegram: Review, Accept, Correction, Progress Peek, status, Stuck handling (FR-22–25).
- Integration and Recipe-defined Release (FR-26–28).
- Cost tracking per Stage, Task, Project (FR-29).
- Proven on three Projects: Android training tracker (first), Unity game, OpenSCAD models.

### 9.2 Out of Scope for MVP
- Web UI. Telegram is enough for one Owner. Phase two.
- Multi-vendor agents (Codex etc.). Role Config leaves the plug. Phase two.
- API-key billing. Phase two, kept as a configuration switch.
- Cluster, cloud or bare-metal deployment. One Mac is enough to prove value.
- Automated reviewer agent replacing the Owner. Only after Evidence quality is proven.
- Upstream idea-forming and spec writing. Phase two.
- iOS for the training app. Android first.
- Mid-Stage steering (interrupting a running agent). Progress Peek is read-only. `[NOTE FOR PM: revisit if end-of-task Corrections prove too coarse.]`

## 10. Success Metrics

**Primary**
- **SM-1:** within ~3 weeks of the first Project's bootstrap, the Android training tracker reaches a version the Owner uses for real workouts, steered mostly from the phone. Validates FR-6, FR-22–24.
- **SM-2:** median Owner time per Review ≤ 2 minutes. Validates FR-19, FR-22, NFR-1.

**Secondary**
- **SM-3:** most Tasks are accepted with at most one Correction. Validates FR-7, FR-16, FR-18.
- **SM-4:** Stuck rate stays low enough that the Owner doesn't drop back to the laptop to unblock work. Validates FR-11, FR-12.
- **SM-5:** at least one Task is accepted in each of the three Project types. Validates FR-2, FR-4.

**Counter-metrics (do not optimize)**
- **SM-C1:** Review count per week. More Reviews isn't better. Many tiny Tasks shift routine back onto the Owner. Counterbalances SM-2.
- **SM-C2:** first-try Accept rate taken alone. Pushing it can mean weak criteria or cosmetic Evidence. Counterbalances SM-3.
- **SM-C3:** tokens spent per Task taken alone. Cheap Tasks that need extra Corrections cost the Owner's time, which is the scarce resource. Counterbalances FR-29.

## 11. Open Questions

1. **CI location.** Hosted CI (e.g. GitHub Actions) vs a local runner on the Mac, per Project. Unity and Android emulator steps likely need local. → architecture.
2. **Demo reachability from the phone.** Which private path should be used: Tailscale-like private network, authenticated tunnel, or files delivered directly in Telegram? → architecture.
3. **Evidence storage.** Should Evidence be stored on the Mac only, or also off-box? How long is it kept? → architecture.
4. **Usage Window visibility.** What exactly does Claude Code expose for subscription usage? Is window budgeting a reading or an estimate? → verify early, spike.
5. **Subscription terms risk.** At what concurrency does usage stop looking "ordinary, individual"? Should API-key mode move into the MVP if Antipode runs daily?
6. **Unity automation.** Can the Unity editor be driven headlessly or via MCP reliably enough for Implementer, Validator and Evidence Stages under the Owner's license?
7. **Recipe schema.** What is the minimum Recipe the Owner must write per Project type? Should Antipode ship example Recipes for Android, Unity and OpenSCAD?
8. **Parking Lot lifecycle.** Do parked findings become new draft Task Contracts automatically, or only on the Owner's request?

## 12. Assumptions Index

- §4.2 FR-5: mapping BMad story acceptance criteria to Task Contract fields is sufficient.
- §4.3 FR-14: subscription usage and window position can be read or estimated from Claude Code.
- §4.4 FR-17: CI location is declared per Project in the Recipe.
- §4.7 FR-27: a failed Release does not auto-roll-back main.
- §6: the Mac stays powered and online while Tasks run. On sleep, Tasks pause and resume.
