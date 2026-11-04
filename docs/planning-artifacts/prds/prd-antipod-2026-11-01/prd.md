---
title: Antipode — PRD
status: final
created: 2026-11-01
updated: 2026-11-04
---

# PRD: Antipode
*Working title — confirm.*

## 0. Document Purpose

This PRD defines the MVP of Antipode. Antipode is an autonomous, downstream software factory that one Owner runs from a phone. The PRD is written for that Owner (agxmeister) and for the downstream BMad workflows: `bmad-ux`, `bmad-architecture` and `bmad-create-epics-and-stories`.

It builds on the forged idea at `docs/forge/antipode-autonomous-dev-factory/forged-idea.md` and that session's log. Where this PRD replaces a forge lock, it says so.

How to read it:
- Vocabulary is fixed in §3 Glossary.
- Features in §4 contain globally numbered requirements (FR-N).
- Points I inferred carry `[ASSUMPTION]` tags. §13 lists them all.
- Technical direction and rejected alternatives are in `addendum.md`.
- Landscape research is in `research-landscape.md`.

## 1. Vision

Antipode lets one busy person run software projects the way a manager runs a team. The Owner decides what should exist and whether the result is good enough. Agents do the routine work in between: they write code, build, test and produce proof. The Owner never opens a laptop to check a branch. Each Task arrives on the phone as a short visual report with screenshots, a screencast or a build to try. The Owner taps **Accept**, or replies with a one-sentence correction.

The product is the **acceptance surface**, not the agents. Agents, containers, branches and CI are plumbing. Antipode adds a chain that, per `research-landscape.md`, no current tool closes end to end:

contract with acceptance criteria → evidence produced for each criterion → one-tap judgment on a phone → integration and release.

Comparable tools such as Cursor cloud agents, the Copilot coding agent, Devin and Codex end in a pull request, so the human still judges the diff. Antipode ends in a judgment of the running result.

Antipode is built for very different projects. The first three are an Android training tracker, a Unity game and OpenSCAD models for 3D printing. Each project declares how it is built, run, released and evidenced in a **Recipe**. Antipode itself is not tied to any project type.

## 2. Target User

### 2.1 Jobs To Be Done
- **Functional:** move a personal project forward without spending laptop time on routine work. Delegate implementation and keep the decisions.
- **Responsibility:** stay accountable for what ships. Nothing reaches a Release unless the Owner has seen and accepted it. The Owner accepts knowing what was deferred.
- **Steering:** keep the work on track by reacting quickly to intermediate results, instead of writing exhaustive instructions upfront.
- **Emotional:** feel like a manager guiding a capable team toward outcomes, not like someone babysitting a chatbot.
- **Contextual:** review in short gaps, such as a commute or a queue, one-handed on a phone. Aim for about a minute per Task and never more than two.

### 2.2 Non-Users (v1)
- Teams with several reviewers. The MVP has exactly one Owner per Project.
- People who want the factory to invent the product. Antipode consumes intent and does not originate it. Upstream ideation is phase two.
- People who want to review code. Code is never the review surface.

### 2.3 Key User Journeys

- **UJ-1. agxmeister kicks off a Task from the tram.**
  On the tram, agxmeister remembers the training app has no rest timer between sets. They send a voice note to the Antipode Telegram chat: "add a rest timer after each set, 90 seconds default."
  Within a few minutes Intake replies with a draft Task Contract. It has three Acceptance Criteria, each with its Required Evidence. For example: "screencast: finish set → timer starts → counts down → vibrates at zero." Intake asks one question: "Can the default be changed per exercise?"
  agxmeister answers "not yet" and taps **Approve**. The Task is queued.
  **Edge case:** if the Project's Recipe can't evidence a criterion (for example haptics in an emulator), Intake says so and proposes a substitute before it offers Approve.

- **UJ-2. agxmeister accepts a finished Task in under a minute.**
  A Review arrives:
  - one-line summary;
  - each Acceptance Criterion with a ✅ and its Evidence inline: a 20-second emulator screencast and two before/after screenshots;
  - an APK to install;
  - a Parking Lot of one finding ("timer text overlaps on very small screens");
  - a cost line ("~38k tokens, 14 min, 4% of the 5-hour window").

  agxmeister watches the screencast, installs the APK, tries it once and taps **Accept**. Later, a short confirmation arrives: "Merged and released as internal build 0.4.2."

- **UJ-3. agxmeister corrects instead of accepting.**
  The screencast shows the timer, but it is tiny. agxmeister taps **Request changes** and types "timer should be big, center of screen."
  Intake turns the note into a structured Correction. The same Task goes back to the Implementer on the same Branch, and the Validator reruns.
  The next Review opens with what changed compared with the last Review, shown as a before/after pair. agxmeister accepts.

- **UJ-4. agxmeister handles a Stuck Task.**
  A Unity task uses up its Iteration Budget because the Validator keeps rejecting a physics behavior. agxmeister receives a **Stuck** message. It shows what was attempted, the last Evidence, and Triage's one-line reason: "criterion 2 contradicts existing jump height."
  agxmeister replies "drop criterion 2, make a new task for it." Intake turns the reply into a contract amendment plus a new draft Task Contract and asks agxmeister to confirm. The Task then resumes.

- **UJ-5. agxmeister peeks at progress.**
  While waiting in a queue, agxmeister sends `/peek` on a running OpenSCAD Task. They get the latest render and one line: "Implementer: adding fillet to the hinge, lap 2 of 5." Nothing is interrupted.

## 3. Glossary

- **Owner** — the single person who approves Task Contracts and accepts or corrects each Review. Exactly one per Project.
- **Project** — one repository managed by Antipode, with one Recipe and one Owner.
- **Recipe** — a file in the Project repo, written by the Owner. It declares how to build, run, test, produce Evidence, provide a Demo and Release; the Runner for each step; Preview Data; and the *names* of the secrets each step needs. Secret values never live in the repo. Antipode consumes the Recipe and never invents it.
- **Runner** — where a Recipe step executes:
  - **Container Runner**: a Podman container.
  - **Host Runner**: directly on the Owner's Mac, for tools like the Unity editor or the Android emulator.
- **Preview Data** — throwaway seed data for one Branch's runs and Demo, created from fixtures the Recipe declares. It is never production data.
- **Task** — one unit of work in a Project. It is defined by a Task Contract and executed on its own Branch.
- **Task Contract** — a structured file in the repo. It holds the goal, the Acceptance Criteria, the Required Evidence for each criterion, and dependencies on other Tasks. It is Antipode's input API.
- **Acceptance Criterion** — one testable statement the result must satisfy.
- **Required Evidence** — the kind of proof expected for an Acceptance Criterion: screencast, screenshots, render, test result, measurement or Demo.
- **Evidence** — the artifacts actually produced for a Task, each linked to an Acceptance Criterion.
- **Degraded Evidence** — Evidence that is only non-visual test output for a criterion that has a visible result. It is allowed, but it is always labeled as degraded in the Review.
- **Demo** — Evidence the Owner can try from the phone: an installable APK, a WebGL build, a preview URL or a downloadable STL. A Demo is provided when the Recipe and the Task allow it. It is not mandatory.
- **Review** — the message sent to the Owner when a Task is reviewable. It contains a summary, the Evidence for each criterion, the Demo if there is one, the Parking Lot and the cost.
- **Review Queue** — the Reviews delivered to the Owner and not yet answered.
- **Correction** — the Owner's feedback on a Review. It returns the same Task to the Implementer on the same Branch.
- **Owner Message** — any free-text or voice input from the Owner: a new Task request, a Correction, a reply to a Stuck message or a contract edit.
- **Progress Peek** — an on-demand, read-only snapshot of a running Task: the latest visual Evidence plus one status line.
- **Role** — a kind of agent work. Each run of a Role is a fresh, ephemeral agent session. The MVP Roles are:
  - **Intake**: drafts contracts and interprets every Owner Message.
  - **Implementer**: changes the code on the Task's Branch.
  - **Validator**: independently checks the Branch against every Acceptance Criterion, and checks that the Evidence shows each criterion.
  - **Evidence Producer**: creates the Evidence for each Acceptance Criterion.
  - **Triage**: decides at branch points whether to re-run the Implementer or park findings, and writes the reason when a Task goes Stuck.

  More Roles can be added through Role Config.
- **Role Config** — the instructions, skills and MCPs for a Role. Set globally, overridable per Project.
- **Stage** — one run of one Role on one Task.
- **Coordinator** — the deterministic component that holds Task state and starts Stages. It enforces timeouts, retries, Iteration Budgets, dependencies, concurrency, Usage Window pauses and Review Queue backpressure. It contains no LLM.
- **Iteration Budget** — the maximum number of Implementer runs for a Task, whatever caused them. Corrections requested by the Owner do not count.
- **Stuck** — the Task state reached when the Iteration Budget is spent or the agents cannot resolve a blocker. The Owner must decide.
- **Parking Lot** — the record of non-blocking findings that Triage deferred instead of fixing. It is shown in the Review.
- **Branch** — the Git branch of one Task. One Branch per Task; no stacked Branches.
- **Integration** — what happens after Accept: rebase on main, re-run the Validator and CI, then merge.
- **Release** — the step after merge, defined by the Recipe: an internal build, a WebGL deploy, a GitHub release of STLs, or nothing.
- **Usage Window** — the Claude subscription's rolling 5-hour limit and weekly limit, shared by all Stages.

## 4. Features

### 4.1 Project Onboarding & Recipe
**Description:** A Project becomes active when its Recipe works. The first Task of every new Project is "bootstrap evidence": Antipode runs the Recipe end to end on a trivial change and shows the Owner the Evidence it produced. Feature Tasks can't start until the Owner accepts that bootstrap Review.

This is **evidence-first**, and it replaces the forge's "demo-first" lock. What's mandatory is reliable Evidence, not a live preview URL. A Unity game or an OpenSCAD model has no natural URL, so recordings, renders or files are its proof.

#### FR-1: Register a Project
The Owner can register a Project by pointing Antipode at a repo that contains a Recipe.
- Registration fails with a readable reason if the Recipe is missing or invalid.
- Each Project has exactly one Owner and one Telegram chat binding.

#### FR-2: Recipe declares Runners per step
For each step (build, run, test, evidence, demo, release), the Recipe assigns either a Container Runner or a Host Runner.
- A Project that mixes Runners, for example a container build plus a host Android emulator for screencasts, runs without any manual steps.
- Host Runner steps that the Recipe marks *exclusive*, such as a single Unity editor instance, never run concurrently.

#### FR-3: Bootstrap Evidence gate
Antipode creates a bootstrap Task for each new Project and blocks every other Task in that Project until the bootstrap is accepted.
- The bootstrap Review shows at least one Evidence artifact of each kind the Recipe declares.
- If the Recipe can't produce any visual or measurable Evidence, the Project stays in onboarding and the Owner is told why.

#### FR-4: Recipe-defined Evidence kinds
The Recipe declares which Evidence kinds the Project can produce. Examples:
- Android: emulator screencast, screenshots, APK.
- Unity: play-mode recording, screenshots, WebGL build.
- OpenSCAD: multi-angle renders, printability check, STL.

Intake proposes only Required Evidence the Recipe can produce (see FR-8).

#### FR-5: Preview Data and secrets
Every Branch run and Demo uses its own Preview Data, seeded from the fixtures the Recipe declares. Stages get only the non-production secrets the Recipe names.
- No Stage, Demo or preview ever reads production data or a production snapshot.
- External services are reached only through sandbox credentials or stubs the Recipe declares.
- Secret values are stored outside the repo. A Recipe that contains a secret value fails validation.

### 4.2 Intake & Owner Messages
**Description:** Tasks enter as Task Contracts. The Owner can commit contract files from any spec-driven workflow (for example BMad stories). Or the Owner can send a rough request by Telegram text or voice, which Intake turns into a draft. No Task starts without Acceptance Criteria and the Owner's approval.

Intake also interprets every later Owner Message: Corrections, replies to Stuck messages and contract edits. Antipode never invents intent: Intake asks, and the Owner decides. Realizes UJ-1, UJ-3, UJ-4.

#### FR-6: Accept contract files from the repo
The Owner can add Task Contracts as files in the Project repo. Antipode detects new or changed contracts and offers each one for approval.
- A contract without Acceptance Criteria, or with any criterion lacking Required Evidence, goes to Intake instead of the queue.
- Story files from spec-driven workflows are accepted when they map to the Task Contract fields. BMad stories are the first supported format. `[ASSUMPTION: mapping story acceptance criteria to Task Contract fields is sufficient; the exact mapping is an architecture concern.]`

#### FR-7: Draft a contract from a Telegram message
The Owner can describe a Task in a text or voice message. Intake replies with a draft Task Contract and asks at most two clarifying questions.
- Voice messages are transcribed before Intake runs.
- The draft fits on one phone screen: goal, numbered criteria, and the Evidence kind for each criterion.

#### FR-8: Evidence feasibility check
Intake checks every Acceptance Criterion against the Project's Evidence kinds (FR-4).
- If a criterion can't be evidenced, Intake proposes a substitute or flags it.
- A contract can't be approved while any criterion lacks a feasible Required Evidence.

#### FR-9: Approve, edit, or discard a draft
The Owner can approve a draft, reply with changes (Intake revises the draft), or discard it.
- On approval, the contract is committed to the repo and the Task enters the queue.
- Dependencies on other Tasks are recorded and enforced (FR-15).

#### FR-10: Interpret Owner Messages
Before the Coordinator acts on any Owner Message about an existing Task, Intake turns it into one structured instruction: a Correction note; a contract amendment (dropping, adding or editing a criterion, or raising the budget); a new draft Task Contract; or a cancellation.
- If the meaning is ambiguous, Intake asks exactly one clarifying question.
- Any change to Acceptance Criteria needs the Owner's confirmation before it takes effect.

### 4.3 Coordinator & Task Lifecycle
**Description:** The Coordinator is deterministic. It moves each Task through these states:

**draft → awaiting approval → queued → waiting on dependencies → implementing → validating → (triage) → evidencing → in review → integrating → released**

It also handles these side states:
- **paused**, for the Usage Window or the Owner;
- **Stuck**;
- **cancelled**.

State is persisted, so restarting Antipode or the Mac loses nothing. The Coordinator itself contains no LLM. Intelligence lives only in Stages.

#### FR-11: Persisted Task state
The Coordinator persists every Task's state and Stage history.
- After a restart, every Task resumes from its last completed Stage. No Stage output that was already recorded is lost.

#### FR-12: Stage execution with timeouts and retries
The Coordinator starts each Stage as a fresh, ephemeral agent session and enforces a timeout for each Role.
- A Stage that times out or crashes is retried up to a configured limit. After that, the Task becomes Stuck and the reason is recorded.
- No agent session runs while a Task waits for the Owner.

#### FR-13: Validation outcomes and Iteration Budget
After validation, the Coordinator routes the Task by outcome:
- **Blocking findings:** back to the Implementer.
- **Non-blocking findings only:** to Triage, which either re-runs the Implementer or parks the findings in the Parking Lot.
- **Pass:** on to evidencing.

Every Implementer run uses one unit of the Task's Iteration Budget, whatever triggered it: blocking findings, Triage, missing Evidence or failed Integration. The default budget is configurable and can be overridden per contract.
- When the budget is spent, Triage writes a one-line reason, and the Owner receives a Stuck message with what was attempted, the last Evidence and that reason. Realizes UJ-4.
- Owner Corrections never use the Iteration Budget.
- Triage always runs in a clean context. It is never the same session as the Implementer or the Validator.

#### FR-14: Owner controls
At any time, the Owner can pause, resume, or cancel any Task, and can edit its contract through an Owner Message (FR-10).
- A cancelled Task's Branch is kept but never merged.
- Editing the contract of a Task that is in progress restarts it from the implementing state.

#### FR-15: Dependencies and concurrency
A Task starts only when all its dependencies are merged to main. No more than a configured number of Tasks run at the same time across all Projects; the default is 2 and the allowed range is 1–3.
- No Task ever starts on another Task's unmerged Branch.

#### FR-16: Review Queue backpressure
While the Review Queue holds at least the configured number of unanswered Reviews (default 3), the Coordinator starts no new Tasks. Tasks already running continue.
- When the Owner answers a Review, the Coordinator resumes starting Tasks.

#### FR-17: Usage Window budgeting
The Coordinator tracks how much of the subscription's Usage Window has been consumed. It pauses new Stages before a limit is reached and resumes them when the window allows.
- The Owner sees a paused Task as "waiting for usage window" with an estimated resume time, not as failed.
- `[ASSUMPTION: usage and the window position can be read or estimated from what Claude Code exposes; the result is approximate.]`

### 4.4 Roles & Separation of Duties
**Description:** Each Role is a fresh agent session with its own Role Config. The worker never grades its own work. Agents share visibility of the whole repo, but each writes only to its own Task's Branch.

#### FR-18: Role Configs and extensible Roles
The Owner can define Role Configs (instructions, skills, MCPs) globally and override them per Project. The Owner can also add Roles beyond the five MVP Roles, in configuration rather than code.
- Example: a Unity Project gives its Implementer and Evidence Producer a Unity MCP, and an OpenSCAD Project gives them a render/validation MCP.

#### FR-19: Independent validation
The Validator, in a session separate from the Implementer, checks the Task's Branch against every Acceptance Criterion.
- A criterion is never marked as passed on the basis of the Implementer's own report.

#### FR-20: Branch per Task, shared read visibility
Each Task works on its own Branch, and no two agents edit the same working tree at the same time. Every Stage can read main and other Branches, but writes only to its own Task's Branch.
- CI runs on every push to every Task Branch. `[ASSUMPTION: each Project's Recipe decides where CI runs (hosted or a local runner); Unity and Android CI may need the Host Runner.]`

### 4.5 Evidence
**Description:** Evidence is the product's core object. A Task becomes reviewable only when every Acceptance Criterion has its Required Evidence. Evidence must be good enough that the Owner can be confident at a glance. Visuals come first: screenshots, screencasts, renders. Data-level proof such as counts, test names or measurements is used only where visuals can't show the result.

#### FR-21: Evidence per Acceptance Criterion
The Evidence Producer creates Evidence for each Acceptance Criterion and links every artifact to its criterion.
- If any criterion lacks Evidence, the Task does not reach the Owner. It goes back to the Implementer (FR-13).
- Before the Review is sent, the Validator checks that each piece of Evidence actually shows the behavior its criterion describes.

#### FR-22: Visual-first, before/after Evidence
For any criterion with a visible result, the Evidence includes a visual. If the Task changes something that already existed visibly, the Evidence includes a before/after pair.
- After a Correction, the next Review opens with before/after pairs against the Evidence in the previous Review.
- Evidence that is only test output for a criterion with a visible result is labeled as Degraded Evidence in the Review.

#### FR-23: Phone-native Evidence
Evidence is delivered in forms a phone shows inline: images, videos of 60 seconds or less, and small files such as APKs and STLs.
- Each screencast shows only the behavior its criterion covers.

#### FR-24: Demo when feasible
When the Recipe supports a Demo and the Task changes something the Owner can try, the Review includes one: an installable APK, a WebGL link, a preview URL or an STL download.
- A Demo link is never reachable publicly without authentication. It is either authenticated or served only over a private network path.
- An idle preview behind a Demo goes to sleep and wakes on request. Its Preview Data is discarded when the Branch is merged or cancelled.

#### FR-25: Durable Evidence
Antipode stores Evidence and keeps it after the Branch is merged or deleted.
- The Owner can retrieve the Evidence of any past Task.

### 4.6 Telegram Acceptance Surface
**Description:** The Owner interacts with Antipode entirely through Telegram. Messages carry as little text as possible and lead with visuals. Each Review must be judgeable in about a minute. Realizes UJ-1 to UJ-5.

#### FR-26: Review message
When a Task is reviewable, the Owner receives a Review. It contains, in order:
1. A one-line summary.
2. Each Acceptance Criterion with its status and its Evidence inline.
3. The Demo, if any.
4. The Parking Lot.
5. A one-line cost summary (FR-31).
6. **Accept** and **Request changes** buttons.

- The Review can be judged on a phone without opening the repo, a diff or a laptop.
- Prose beyond the criterion labels is no more than 5 short lines.

#### FR-27: Accept
The Owner can accept a Review with one tap. Accepting starts Integration (FR-29).

#### FR-28: Correction, Progress Peek, status, Stuck replies
- **Correction:** the Owner can request changes by text or voice. After Intake interprets the note (FR-10), the same Task returns to the Implementer on the same Branch with the note and the previous Evidence in context. No new Task Contract is drafted: the original criteria still apply, plus the note. The next Review opens with what changed since the previous Review (FR-22). Realizes UJ-3.
- **Progress Peek:** the Owner can request a Progress Peek on any running Task. A Peek never interrupts or restarts a Stage. Realizes UJ-5.
- **Status:** the Owner can request a list of all Tasks and their states.
- **Stuck:** the Owner can answer a Stuck message by amending the contract, dropping a criterion, raising the budget or cancelling. Intake interprets the reply (FR-10).

### 4.7 Integration & Release
**Description:** Accept does not mean merge. Integration (FR-29) comes first, then the Recipe's Release step (FR-30). Nothing changed after the Owner accepted may reach a Release without a new Review.

#### FR-29: Integration after Accept
On Accept, the Coordinator rebases on main, re-runs the Validator and CI, and then merges.
- The merge completes without a new Review only when the rebase was clean and the Validator and CI pass.
- If the rebase conflicts or re-validation fails, the Task goes back to the Implementer; that run uses the Iteration Budget. After any Implementer run that follows Accept, the Owner receives a new Review before anything is merged.

#### FR-30: Recipe-defined Release
After merge, Antipode runs the Recipe's Release step, if one is declared, and confirms the outcome to the Owner. Example: "released as internal build 0.4.2."
- A Project with no Release step completes at merge.
- A failed Release is reported to the Owner with the reason. Main is not rolled back automatically. `[ASSUMPTION]`
- When a Task merges, the Tasks that depend on it become eligible to start (FR-15).

### 4.8 Usage & Cost Tracking
**Description:** The Owner sees what each Task and Stage cost: tokens, wall time and share of the Usage Window. On a subscription these figures are approximate.

#### FR-31: Per-Task and per-Stage cost
Antipode records tokens, wall time and the estimated Usage Window share for every Stage, and aggregates them per Task and per Project.
- Every Review shows a one-line cost summary.
- The Owner can request a cost breakdown at any time: per Task, per Project, or for the current window.

## 5. Cross-Cutting NFRs

- **NFR-1 Review time:** a typical Review takes about 1 minute to judge on a phone, including watching the Evidence, and never more than 2 minutes.
- **NFR-2 Durability:** restarting Antipode or the Mac loses no Task state, Evidence or Parking Lot entry (FR-11, FR-25).
- **NFR-3 Determinism:** only the Coordinator changes Task state, and only from recorded state. LLM judgment enters only through bounded Stage outputs: Triage's choice and Intake's structured interpretation, which the Owner confirms where FR-10 requires it.
- **NFR-4 Isolation:** Stages write only to their own Task's Branch and get only the non-production secrets the Recipe names (FR-5, FR-20). Production credentials are available only to the Release step.
- **NFR-5 Observability:** every Stage leaves a log and its output in the Task record. The Owner can retrieve them at any time.
- **NFR-6 Acknowledgement:** every Owner action in Telegram (approve, accept, correct, peek, pause, cancel) is acknowledged within 5 seconds, even when the work it triggers takes longer.

## 6. Constraints & Guardrails

- **Subscription terms (cost and safety):** the MVP runs the unmodified Claude Code CLI on the Owner's own subscription. Anthropic's terms assume "ordinary, individual usage." The concurrency cap (FR-15), Review Queue backpressure (FR-16) and window budgeting (FR-17) keep usage close to that. Switching to API keys must stay a configuration change, not a redesign. **Decision trigger:** once Antipode has run daily for a week, the Owner decides whether API-key mode moves into the MVP. See `research-landscape.md`.
- **Privacy:** Evidence and Demos are private to the Owner. They are delivered only through Telegram or through authenticated or private-network links (FR-24).
- **Single machine, MVP only:** everything runs on the Owner's Mac laptop. The laptop stays plugged in and awake while Tasks run. If it sleeps anyway, Tasks pause and resume; they do not fail. A dedicated VM is the intended host after the MVP, so nothing may assume macOS beyond what a Host Runner step declares (see §10.3).
- **Licensed tools:** Host Runner steps may depend on licensed software such as Unity. Antipode uses the Owner's existing installation and license and does not provision them.

## 7. Risks

- **Owner review capacity is the factory's ceiling.** One person's attention limits throughput. Mitigations: Review Queue backpressure (FR-16), visual-first Reviews (FR-22, FR-26) and the time target in NFR-1.
- **Agents can loop.** Triage, Evidence rework and Integration rework can all cycle. Mitigation: one Iteration Budget that counts every Implementer run (FR-13). It is the only brake, so the default budget must be tuned early.
- **Subscription limits and terms.** The usage figures are approximate, and Anthropic can enforce its terms without notice. Mitigations: window budgeting (FR-17) and the API-key decision trigger (§6).
- **Recipe burden.** Per-Project build, preview and evidence setup is real work that falls on the Owner. Mitigation: the bootstrap gate (FR-3) shows quickly whether a Recipe works. Example Recipes are an open question (§12 Q6).
- **Evidence that looks right but isn't.** Polished Evidence could hide a wrong result. Mitigations: the Validator checks that each piece of Evidence shows its criterion (FR-21), and Degraded Evidence is labeled (FR-22).

## 8. Tone of Owner-facing Messages

Messages read like a competent team lead reporting to their manager:
- Short, with the outcome first and proof before prose.
- No apologies and no narration.
- Questions are rare and specific, and answerable in one word where possible.
- Visuals carry the message; text only labels them.

## 9. Non-Goals (Explicit)

- Antipode does not originate product ideas or write specs without the Owner. Upstream ideation is phase two.
- Antipode is not a code review tool. Diffs are never the review surface.
- There is no orchestrator agent. No LLM owns project-wide state.
- There is no multi-user support in v1: no teams, no shared review, no permissions model.
- Antipode does not provision cloud infrastructure, app-store publishing or licensed toolchains.

## 10. MVP Scope

### 10.1 In Scope
- Project registration with a Recipe, Container and Host Runners, the bootstrap Evidence gate, and Preview Data and secrets (FR-1–5).
- Task Contracts from repo files and from Telegram text or voice; Intake interprets all Owner Messages (FR-6–10).
- A deterministic Coordinator: persisted state, timeouts, retries, a single Iteration Budget, Triage, Owner controls, dependencies, concurrency, Review Queue backpressure and Usage Window budgeting (FR-11–17).
- Roles with configurable and extensible Role Configs, independent validation, and shared read visibility (FR-18–20).
- Evidence per criterion that is visual-first, verified, phone-native and durable, plus a Demo when feasible (FR-21–25).
- Telegram: Review, Accept, Correction, Progress Peek, status and Stuck handling (FR-26–28).
- Integration with a re-review rule, plus Recipe-defined Release (FR-29–30).
- Cost tracking (FR-31).

### 10.2 Build Order and Cut Line
If time runs short, cut from the bottom of this list:
1. Coordinator lifecycle and the Telegram Review, Accept and Correction loop (§4.3, §4.6, §4.7).
2. Android Evidence on the training tracker: emulator screencasts, screenshots, APK Demo (§4.1, §4.5).
3. Voice intake (FR-7 voice path). Text intake and repo contracts come with step 1.
4. Unity and OpenSCAD Projects.

### 10.3 Out of Scope for MVP
- Web UI. Telegram is enough for one Owner. Phase two.
- Multi-vendor agents such as Codex. Role Config leaves room for them. Phase two.
- API-key billing. Phase two, kept as a configuration switch (see the §6 decision trigger).
- Running on a dedicated VM. This is the intended next host; the MVP runs on the Owner's Mac only to prove value. Cluster, cloud or bare-metal deployment comes later still.
- An automated reviewer agent replacing the Owner. Only after Evidence quality is proven.
- Upstream ideation and spec writing. Phase two.
- iOS for the training app. Android comes first.
- Steering a running Stage, that is, interrupting it. Progress Peek is read-only. `[NOTE FOR PM: revisit if end-of-task Corrections prove too coarse.]`

## 11. Success Metrics

**Primary**
- **SM-1:** within about 3 weeks of the first Project's bootstrap, the Owner uses the Android training tracker for real workouts, having steered most of its development from the phone. Validates FR-7, FR-26–28.
- **SM-2:** the median Owner time per Review is about 1 minute and never above 2 minutes. Validates FR-23, FR-26, NFR-1.

**Secondary**
- **SM-3:** at least 70% of Tasks are accepted with at most one Correction. Validates FR-8, FR-19, FR-21.
- **SM-4:** at most 15% of Tasks become Stuck. Validates FR-13.
- **SM-5:** at least one Task is accepted in each of the three Project types. Validates FR-2, FR-4.

**Counter-metrics (do not optimize)**
- **SM-C1:** Reviews per week. More is not better: many tiny Tasks push routine work back onto the Owner. Counterbalances SM-2.
- **SM-C2:** the first-try Accept rate on its own. Pushing it up can mean weak criteria or cosmetic Evidence. Counterbalances SM-3.
- **SM-C3:** tokens per Task on its own. A cheap Task that needs extra Corrections costs the Owner's time, which is the scarcest resource. Counterbalances cost reporting (FR-31); there is no cost target.

## 12. Open Questions

1. **Where CI runs.** Hosted CI or a local runner on the Mac, per Project? Unity and Android emulator steps likely need local. → architecture.
2. **How the phone reaches a Demo.** A private network, an authenticated tunnel, or files sent directly in Telegram? → architecture.
3. **Evidence storage.** On the Mac only, or also off the machine, and how long is it kept? → architecture.
4. **Usage Window visibility.** What does Claude Code actually expose about subscription usage? Is budgeting a reading or an estimate? → early spike.
5. **Unity automation.** Can the Unity editor be driven headlessly or through an MCP reliably enough for the Implementer, Validator and Evidence Stages under the Owner's license? → spike before step 4 of §10.2.
6. **Recipe schema.** What is the minimum Recipe for each Project type? Should Antipode ship example Recipes for Android, Unity and OpenSCAD? → architecture.
7. **Parking Lot lifecycle.** Do parked findings become draft Task Contracts automatically, or only when the Owner asks? → UX.
8. **Iteration Budget default.** What starting value? → tune during the first Project.

## 13. Assumptions Index

- §4.2 FR-6: mapping story acceptance criteria to Task Contract fields is sufficient.
- §4.3 FR-17: subscription usage and the window position can be read or estimated from Claude Code.
- §4.4 FR-20: each Project's Recipe decides where CI runs.
- §4.7 FR-30: a failed Release does not automatically roll back main.
