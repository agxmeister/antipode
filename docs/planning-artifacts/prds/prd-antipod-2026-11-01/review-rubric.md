# PRD Quality Review — Antipode

## Overall verdict
A sharp, well-argued PRD. It has a real thesis ("The product is the **acceptance surface**, not the agents"), a precise Glossary, contiguous IDs, honest Non-Goals and counter-metrics, and it is the right size for a solo, chain-top tool. The main risk is the Task lifecycle, which architecture and stories will build on directly. It has three gaps. Post-Accept rework can merge without the Owner seeing it, which breaks the PRD's own accountability promise. No Role is assigned to interpret the Owner's free-text replies, even though the Coordinator "contains no LLM". The state machine leaves out several states and transitions that the FRs and UJs depend on. Fix those three, and make SM-3/SM-4 measurable, and the PRD is ready for bmad-architecture and epics.

## Decision-readiness — adequate
The PRD states its decisions as decisions. §4.1 says outright that it "replaces the forge's 'demo-first' lock with **evidence-first**" and gives the reason. §8 rules out an orchestrator agent, and the addendum's "Rejected alternatives" names what was given up (stacked Branches, shared working tree, Web UI). §2.2 Non-Users is pointed, not decorative. The Open Questions in §11 are genuinely open and each is routed to "→ architecture" or "spike".

Two places fall short. First, the most consequential open risk is OQ5 ("Should API-key mode move into the MVP if Antipode runs daily?"). It changes MVP scope, but the PRD gives it no `[NOTE FOR PM]` and no decision trigger. FR-14 is also built on an unverified assumption (OQ4) and has no fallback. Second, FR-26 makes a quiet decision that contradicts §2.1 (see Done-ness, first high finding).

### Findings
- **medium** Scope-changing risks deferred without a trigger (§6 Subscription terms, §11 OQ4/OQ5, FR-14). The PRD says API-key mode is "phase two, kept as a configuration switch", but OQ5 leaves open pulling it into the MVP. FR-14 also depends on "usage and window position can be read or estimated", with no fallback if that turns out false. *Fix:* add a `[NOTE FOR PM]` stating the trigger (e.g. "if the OQ4 spike shows usage can't be read, FR-14 degrades to a fixed Stage-rate cap; if daily use exceeds N concurrent Stages, API-key moves into MVP").

## Substance over theater — strong
There is very little furniture. The Vision could not be swapped into another PRD. It names its competitors and the exact point where Antipode differs: "Comparable tools … end in a pull request … Antipode ends in a judgement on the running result." There is one protagonist (the Owner), and the UJs drive concrete FRs: the haptics edge case in UJ-1 leads to FR-7, and the before/after pairs in UJ-3 lead to FR-24. The Emotional JTBD earns its place because it produces §7 Tone. The NFRs are mostly product-specific: NFR-3 Determinism and NFR-4 Isolation are not boilerplate.

### Findings
- **low** NFR-6 is written as an adjective (§5 NFR-6). It says "acknowledged within a few seconds". *Fix:* give a bound (e.g. "≤ 3 s p95 while the Mac is online").

## Strategic coherence — adequate
The thesis is clear: a contract → evidence → one-tap judgement → release chain that no existing tool closes. The features follow from it: §4.5 calls Evidence "the product's core object", and the Telegram surface is the product. SM-1 is a real test of the thesis (a training app used for real workouts, steered mostly from the phone). Counter-metrics are present and well chosen (SM-C1, SM-C2). The MVP kind is problem-solving plus experience, and the scope is consistent with that.

The weak points are measurement and sequencing. Two of the five SMs can't be measured. The MVP also has no internal cut line: everything in §9.1 has equal weight, while SM-1 sets a ~3-week clock.

### Findings
- **medium** SM-3 and SM-4 can't be measured (§10). "Most Tasks are accepted with at most one Correction" and "Stuck rate stays low enough that the Owner doesn't drop back to the laptop" give no threshold. SM-1's "steered mostly from the phone" has the same problem. *Fix:* set numbers (e.g. SM-3 ≥ 70% of Tasks accepted with ≤ 1 Correction; SM-4 ≤ 1 Stuck in 10 Tasks, and zero laptop sessions needed to unblock in a 2-week window). For SM-1, count laptop interventions.
- **medium** The MVP has no priority order or cut line (§9.1 vs SM-1). §9.1 puts three Project types, voice transcription, BMad story import, Usage Window budgeting, cost breakdowns and Parking Lot in MVP at equal weight, while SM-1 expects real use within ~3 weeks. Only "Android training tracker (first)" signals any order. Epics will have nothing to sequence by. *Fix:* mark a walking-skeleton slice, for example Android + repo contracts + Coordinator + Evidence + Review/Accept/Correction. Mark the later-in-MVP items (voice, BMad import, Unity/OpenSCAD, cost breakdown) as such.
- **low** SM-C3 "counterbalances FR-29" (§10). A counter-metric should balance a metric, not an FR. *Fix:* point it at a cost SM, or say it guards against optimising FR-29's numbers.

## Done-ness clarity — thin
Most FRs have at least one testable bullet. The lifecycle FRs do not, and they are the ones story creation will rely on most. The Coordinator is defined as deterministic and LLM-free (§3, NFR-3), yet several FRs and UJs need transitions or interpretations that no component is assigned to do. Several bullets also depend on judgement calls with no owner ("visible result changed", "affects something tryable").

### Findings
- **high** Post-Accept rework can merge without the Owner seeing it (FR-26 vs §2.1 Responsibility). FR-26 says: "A rebase conflict or failed re-validation returns the Task to the Implementer. The Owner receives a new Review only if the visible result changed. Otherwise integration completes silently." The Implementer may change code after Accept, and that change merges and Releases without the Owner looking at it. This contradicts "Nothing reaches a Release without the owner accepting it." The PRD also doesn't say who decides whether the "visible result changed". *Fix:* either require a short re-acceptance (a delta Review) whenever the Implementer touched code after Accept, or define "visible result changed" as an Evidence-diff check owned by a named Role, and state explicitly that the trade-off was accepted.
- **high** No Role is assigned to interpret the Owner's free-text replies (FR-8, FR-24, FR-25, UJ-4). The Owner replies "drop criterion 2, make a new task for it" (UJ-4). FR-25 says the reply "can amend the contract, drop a criterion, raise the budget, or cancel", and FR-24 says "the agents may ask at most one clarifying question". The Coordinator "contains no LLM", and none of the five Roles is defined to handle Stuck replies or to turn a Correction into a contract amendment. *Fix:* assign this to a Role (e.g. extend Intake to "interpret any Owner free text into a structured action or amendment, confirmed before applying"), or offer fixed buttons for Stuck decisions. State which Role asks the clarifying question in FR-24.
- **high** The Task state machine is incomplete and inconsistent (§4.3 Description, FR-12, FR-18, FR-11). The listed states are "queued → implementing → validating → (triage) → evidencing → in review → integrating → released". It leaves out the states the FRs imply: onboarding/bootstrap (FR-3), draft/awaiting approval (FR-8), waiting on dependencies (FR-13), paused for the Usage Window (FR-14), Stuck, cancelled/discarded (FR-25). The transitions are also unclear:
  - FR-12 covers only *non-blocking* Validator findings, so the path for blocking findings is undefined.
  - FR-18 sends a missing-Evidence Task "back through Triage", but Triage is defined only for Validator findings.
  - FR-11 and UJ-4 rely on "Triage's reason" when the budget is spent, but no FR says Triage runs on Stuck.

  *Fix:* add a compact state/transition table to §4.3 that lists the trigger for each transition and the Role (if any) consulted. Bootstrap, approval, waiting, paused, Stuck and cancelled should be states.
- **medium** Several bullets can't be tested as written:
  - FR-6 "shown compactly on a phone"
  - FR-19 "trimmed to the behaviour the criterion covers"
  - FR-20 "the Task affects something tryable" (who decides?)
  - FR-25 "a status list of all Tasks" (what fields?)
  - FR-13 "default 2–3" (a default is one number)

  *Fix:* bound each one. For example: the draft fits one screen with no expansion; trimming is done by the Evidence Producer to ≤ 60 s, starting ≤ 2 s before the behaviour; tryability is declared per criterion in the Task Contract; the status list shows Project, Task, state, and time in state; the default concurrency is 2.
- **medium** Review-time target is inconsistent (§2.1 Contextual, §4.6, NFR-1, SM-2). The PRD says "about a minute per task" and "judgeable in about a minute" in §2.1 and §4.6, but "≤ 2 minutes" in NFR-1 and SM-2. UX will design to one of these numbers. *Fix:* choose one target, or state "aim ~1 min, ceiling 2 min" in one place and refer to it.

## Scope honesty — adequate
§8 Non-Goals and §9.2 Out of Scope do real work: Web UI, multi-vendor, mid-Stage steering and iOS are all named, and the mid-Stage cut carries a useful `[NOTE FOR PM]`. The open-items count (8 OQs, 5 assumptions, 1 note) is reasonable for a solo build. The gaps are omissions a reader would silently fill in: Owner controls outside the Stuck path, and how secrets are held.

### Findings
- **medium** Owner controls are missing outside the Stuck path (FR-5, FR-8, FR-25). Cancel appears only as a reply to a Stuck message. The PRD doesn't say whether the Owner can cancel or pause a queued or running Task, edit an approved contract, or reprioritise the queue. FR-5 "detects new or changed contracts" doesn't say what happens when a contract for an in-flight Task changes. *Fix:* add an FR for Owner Task controls (cancel, pause, edit contract) with their effect on running Stages, or list them as `[NON-GOAL for MVP]`.
- **medium** The Recipe seems to imply secrets are stored in git (§3 Recipe, NFR-4). The Recipe is "a file checked into the Project repo" and it "declares … secrets for non-production use". Read literally, the secrets are committed. NFR-4 also allows Release-step production credentials without saying where they live. *Fix:* say the Recipe *references* secrets by name and the values are held outside the repo. Name where production Release credentials live, or add an `[ASSUMPTION]`.
- **low** The bootstrap Task's contract has no author (FR-3). It is unclear who writes the Acceptance Criteria for "bootstrap evidence", or whether Antipode generates them from the Recipe. *Fix:* one bullet stating that Antipode generates them from the Recipe's declared Evidence kinds.

## Downstream usability — strong
This PRD is easy to extract from. The Glossary covers every load-bearing noun and is applied consistently (Task Contract, Acceptance Criterion, Required Evidence and Evidence are kept distinct; Approve on a draft vs Accept on a Review). The IDs are contiguous: FR-1–29, UJ-1–5, SM-1–5, SM-C1–C3, NFR-1–6. Every inline cross-reference resolves. Sections refer to each other by Glossary term and FR ID, not "see above". Every UJ has a named protagonist. The three high findings above are the parts bmad-architecture would otherwise have to invent.

### Findings
- **low** UJ-2, the core happy path, isn't cited by any FR. FR-22 and FR-23 implement it but carry no "Realizes UJ-2", even though UJ-1, 3, 4 and 5 are all cited. *Fix:* add the reference to FR-22/23.

## Shape fit — strong
The shape suits a solo, chain-top tool. With a single operator, five UJs could look heavy, but here the experience *is* the product. The UJs are what bmad-ux will design from, so they are load-bearing rather than overhead. The length is close to the 4–6 page target. Technical direction is moved to the addendum, as it should be. There are no extra personas and no market sizing. Rigor is light where it can be, and the substance bar is still met.

## Mechanical notes
- **Assumptions Index roundtrip:** all 5 inline tags are indexed and all 5 index entries appear inline. However, FR-27's inline tag is a bare `[ASSUMPTION]` with no text. The index carries the content ("a failed Release does not auto-roll-back main"). Copy that text inline.
- **Naming drift:** the product is "Antipode" (with a "*Working title — confirm.*" note), but the repo and PRD folder use "antipod". Settle the name before downstream artifacts multiply it.
- **Terms not in the Glossary:** "CI" (FR-17, FR-26) and "status list" (FR-25) are used as system concepts without Glossary entries. "Accept" and "Approve" are used precisely but have no entries of their own. Adding them would protect the distinction downstream.
- **Cross-ref style:** §6 Subscription terms and §1 point to `research-landscape.md`, but that file isn't part of the reviewed set. That's fine as long as it ships alongside the PRD.
- **Required sections:** all present for the stakes (Vision, Users/UJs, Glossary, FRs, NFRs, Constraints, Non-Goals, Scope, SMs with counter-metrics, OQs, Assumptions Index).
