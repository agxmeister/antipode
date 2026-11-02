# Input reconciliation: forge → PRD

**Inputs checked:** `docs/forge/antipode-autonomous-dev-factory/forged-idea.md`, `docs/forge/antipode-autonomous-dev-factory/.memlog.md`
**Against:** `prd.md`, `addendum.md` (as of 2026-11-01 draft)
**Excluded on purpose (PRD memlog `(change)` entries):** demo-first → evidence-first; Podman-only → Container + Host Runners; every-merge-deploys-to-prod → Recipe-defined Release. Gaps that only restate those changes are not listed.

Status key: **missing** (not in PRD/addendum), **weakened** (present but softer, vaguer or untestable), **contradicted** (PRD says the opposite).

Gaps are ordered by severity.

---

## G1. Review throughput is the ceiling of the factory
- **Source:** forged-idea "Weak points": "Review throughput of one human is the true factory ceiling; design must keep acceptance to ~1 minute." Forge memlog (crack): "Human acceptance per task makes review throughput the real bottleneck of the autonomous factory; design must minimize review cost."
- **PRD status:** weakened.
  - The PRD never says that Owner review capacity limits throughput. Concurrency (FR-13) is justified only by the subscription and the Usage Window. Nothing paces work by the Owner's review backlog (for example, holding new Stages while N Reviews are unread).
  - The ~1-minute target is diluted. JTBD and UJ-2 say "about a minute" and "under a minute", but NFR-1 and SM-2 say ≤ 2 minutes. The PRD now holds two different targets.
  - SM-C1 touches on this ("more Reviews isn't better") but treats it as a counter-metric, not as a design driver.
- **Suggested fix:**
  - §1 Vision or a new §6 Risks: state "Owner review throughput is the factory's ceiling".
  - Add a bullet to FR-13: a configurable cap on unreviewed Reviews. While the cap is reached, no new Tasks start.
  - Choose one target. Keep ≤ 1 min as the design goal in NFR-1, and ≤ 2 min as the acceptable median in SM-2. Say explicitly which is which.

## G2. "Minimum text, maximum visualization" is a description, not a requirement
- **Source:** forged-idea: "Review = owner looks at the running result, not code. Minimum text, maximum visualization." Forge memlog: "Review must be cheap, not a big deal." Evidence criterion: "whatever lets the owner be confident in one glance."
- **PRD status:** weakened.
  - The intent appears only in the §4.6 description and §7 Tone. No FR has a testable bound.
  - FR-22 keeps adding text blocks: summary, per-criterion status, Parking Lot, cost line. Nothing limits their length or puts visuals first.
  - FR-25 Stuck messages and the status list have no visual-first rule at all.
  - "One glance" was dropped in favour of "≤ 2 minutes, including watching Evidence".
- **Suggested fix:**
  - Add acceptance bullets to FR-22. Visual Evidence comes first. Text per criterion is at most one line. The Parking Lot and cost are collapsed to one line each, expandable on tap. The whole Review fits in about one phone screen above the media.
  - Apply the same rule to the FR-25 Stuck message: lead with the last visual Evidence, then a one-line reason.
  - §4.5: restore "confident in one glance" as the quality bar for Evidence.

## G3. Triage (and the other loops) can run forever; the Iteration Budget doesn't cover every loop
- **Source:** forged-idea "Weak points": "Triage agent can loop; iteration budget is the only brake." Forge memlog (assumption): budget covers "implement/validate/triage laps".
- **PRD status:** weakened / missing.
  - Glossary defines the Iteration Budget as "Implementer→Validator laps" only.
  - FR-18 sends Tasks with missing Evidence "back through Triage". Those Evidence-production loops aren't counted against any budget.
  - FR-26 integration failures (rebase conflict, failed re-validation after Accept) send the Task back to the Implementer, with no stated budget.
  - Correction rounds aren't counted either.
  - The looping risk isn't listed anywhere. The PRD has no Risks section at all.
- **Suggested fix:**
  - Glossary + FR-11: count every agent lap toward the budget (Implementer, Validator, Triage, Evidence Producer). Alternatively give each loop type its own budget. Either way, state that every loop is bounded.
  - Add a bullet to FR-26: integration retries are bounded, then Stuck.
  - Add a Risks section that lists "Triage loop" as a risk, with the budget as its mitigation.

## G4. "Shared workspace = shared repo + visibility" is contradicted by NFR-4
- **Source:** forged-idea: "Shared workspace = shared repo + visibility, never simultaneous edits to one tree." Forge memlog (lock): "shared workspace means shared repo and visibility, not shared mutation." Original idea: "independent agents working on pieces of the same problem in a shared workspace."
- **PRD status:** contradicted. NFR-4 says "Stages run with access only to their Task's Branch". That removes the read visibility of main, merged work and sibling Tasks that the forge kept. The visibility half of "shared workspace" is gone; only the "no shared mutation" half survives (FR-17).
- **Suggested fix:**
  - Reword NFR-4: Stages have write access only to their Task's Branch, and read access to the Project repo (main and other Task records) as the Role Config allows.
  - Add a bullet to FR-17 stating shared read visibility.

## G5. Preview data and secrets: seeded ephemeral DB per preview, no prod snapshots, stubs for external services
- **Source:** forged-idea: "Project recipe in repo (build, preview, CI, prod deploy, seed data, preview secrets) … Ephemeral seeded DB per preview, no prod snapshots." Forge memlog: "Each preview has its own ephemeral DB seeded from a fixture; no prod snapshots. External services via sandbox creds or stubs declared by the project."
- **PRD status:** missing / weakened.
  - The Glossary Recipe entry lists "seed data, and secrets for non-production use", but no FR acts on it. Nothing requires each Task Branch / Demo to get its own isolated data seeded from a fixture.
  - Nothing forbids production data or snapshots.
  - Nothing mentions sandbox creds or stubs for external services.
  - Nothing says how preview secrets are supplied without committing them to the repo, although the Recipe *is* in the repo.
  - NFR-4 covers prod credentials but not prod *data*.
- **Suggested fix:**
  - New FR in §4.1 (e.g. "FR-4a Isolated preview data"): every Branch's run/Demo uses its own ephemeral data store, seeded from a Recipe-declared fixture. Production data or snapshots are never used. External services use sandbox credentials or stubs declared by the Recipe.
  - The Recipe references secrets by name, and their values live outside the repo (the mechanism is an architecture concern).
  - Extend NFR-4 to say "no production data".

## G6. Preview / Demo lifecycle: per-branch, sleeps on inactivity, wakes on request, torn down
- **Source:** forged-idea: "Preview container per branch; previews sleep on inactivity." Forge memlog: "Preview containers are the only long-lived cost; they sleep on inactivity and wake on request."
- **PRD status:** weakened. Under evidence-first, live previews became an optional Demo, which is fine. But where a live Demo exists (WebGL, preview URL, future web projects), its lifecycle appears only in `addendum.md` ("Previews sleep on inactivity"), not as a requirement. Wake-on-request and teardown after merge/cancel are missing everywhere.
- **Suggested fix:** add a bullet to FR-20: long-running Demos sleep after a configurable idle period, wake when the Owner opens the link, and are removed when the Task merges or is cancelled. Name it a cost/resource guard in §6.

## G7. UI Evidence should be before/after, not only after
- **Source:** forged-idea: "UI: before/after screenshots or recording." Forge memlog: "UI tasks: before/after screenshots or recording of the preview. Backend/data tasks: … record counts before/after, checksums, request/response, named test cases."
- **PRD status:** weakened.
  - Before/after appears only for Corrections (FR-24, UJ-3).
  - FR-18 and FR-19 ask only for Evidence per criterion, with no baseline from main.
  - Data-level kinds lost "checksums" and "request/response", and "before/after" for counts.
- **Suggested fix:**
  - Add a bullet to FR-18: where the criterion changes visible or measurable state, Evidence includes a baseline (main) and a result (Branch).
  - §4.5 / FR-4: restore the data-level Evidence list (before/after counts, checksums, request/response, named tests).

## G8. Evidence quality isn't independently checked ("worker never grades its own work")
- **Source:** forged-idea: "Worker never grades its own work." Evidence bar: "whatever lets the owner be confident in one glance."
- **PRD status:** weakened.
  - FR-16 makes the Validator independent of the Implementer for *criteria*.
  - FR-18 only checks that every criterion *has* Evidence. Nobody checks that the Evidence actually shows the criterion, as opposed to a cosmetic or irrelevant clip. SM-C2 names that exact risk.
- **Suggested fix:** add a bullet to FR-18: before a Review is sent, a session other than the Evidence Producer (the Validator, or a light check Stage) confirms that each artifact demonstrates its criterion. Mismatches go back through Triage.

## G9. Tests-plus-screenshots as a degraded mode, not a way around the Recipe
- **Source:** forged-idea: "Tests-plus-screenshots evidence is degraded mode only." Forge memlog: "Fallback … exists only as a degraded mode, not a way to skip the recipe."
- **PRD status:** weakened. Evidence-first (a deliberate change) keeps the "Recipe must work first" part (FR-3). The "degraded" label is lost: a "test result" is listed in Required Evidence as an equal peer of screencasts. §4.5 only says data-level proof is used "where visuals can't show the result". Neither Intake nor the Review flags a Task that is evidenced by tests alone.
- **Suggested fix:** add to FR-7: when Intake proposes test-only Evidence for a user-visible criterion, the draft marks it as degraded. Add to FR-22: the Review marks degraded criteria visibly, so the Owner accepts knowingly.

## G10. Extensibility via skills/MCPs and "configurable independent agents" narrowed to five fixed Roles
- **Source:** original idea (forge memlog frontmatter): "Spawns configurable independent agents … Extensible via skills and MCPs per agent role." Forged-idea: "Multi-vendor agents — role config leaves the plug." PRD memlog (decision): "possible open-source/productization later … keep extensibility notes."
- **PRD status:** weakened.
  - FR-15 lets the Owner configure skills and MCPs for the five fixed Roles.
  - Nothing covers adding a custom Role or Stage (e.g. a security check or an asset-generation Role), or a per-Project Stage pipeline.
  - The PRD has no "extensibility notes" section, although the PRD memlog asked for one. The vendor plug appears only as a line in §9.2.
- **Suggested fix:**
  - Add an "Extensibility" subsection (§9.3 or addendum) covering: Role Config as the extension point (skills, MCPs, instructions); the agent CLI/vendor as a Role Config field; whether custom Roles or Stages are in or out for MVP; and a stable, documented Task Contract and Recipe schema as public interfaces.
  - At minimum, put a sentence in FR-15 saying that the Role set is fixed in MVP and that custom Roles are phase two.

## G11. SDD-friendliness narrowed to "BMad stories"
- **Source:** forged-idea: "Antipode consumes specs (SDD-friendly); it never invents them." Forge memlog: "This is Antipode's input API and what SDD-friendly means: it consumes stories, does not invent them." "Intake agent … (may use SDD skills to elicit)."
- **PRD status:** weakened.
  - FR-5 names only BMad story files.
  - The Task Contract isn't presented as a framework-neutral, documented schema that any SDD tool (Spec Kit, Kiro specs, BMad) can target.
  - Intake's use of SDD skills to elicit criteria is dropped.
  - The term "SDD" doesn't appear in the PRD.
- **Suggested fix:**
  - §1 Vision or §4.2: state that the Task Contract is a documented, framework-neutral schema and that BMad is the first adapter.
  - FR-6: Intake may use SDD/elicitation skills from its Role Config.
  - Open Question 7 → add "Task Contract schema".

## G12. Deciding whether the "visible result changed" after integration rework
- **Source:** forged-idea / forge memlog: "Rebase conflict or failed validation returns the task to the implementer; owner gets a new preview only if the visible result changed."
- **PRD status:** weakened. FR-26 keeps the rule but leaves it unbuildable.
  - It doesn't say that Evidence is regenerated after integration rework and compared with the accepted Evidence.
  - It doesn't say *who* decides "visible result changed". The Coordinator is non-intelligent, so this needs either a deterministic comparison or a bounded Triage-style call.
  - It doesn't say that an unchanged result keeps the earlier Accept valid.
- **Suggested fix:** add bullets to FR-26: after rework, the Evidence Producer regenerates Evidence. A bounded Stage (Validator or Triage) compares it with the accepted Evidence. If the result is unchanged, the Accept stands; if it changed, a new Review is sent, and it leads with the diff against the accepted version.

## G13. Weak points that survived the forge are not carried as risks
- **Source:** forged-idea "Weak points that survived" (four items), plus the memlog cracks.
- **PRD status:** missing as a section.
  - Subscription metering is carried (FR-14, §6, OQ4).
  - Review throughput (G1) and the Triage loop (G3) are not.
  - "Preview environments cost a quarter per product team at real companies; the recipe pushes that onto the owner" is only hinted at in OQ7 (minimum Recipe). It isn't named as an adoption risk: Recipe authoring is the biggest onboarding cost, and it rises for Host Runner projects.
- **Suggested fix:** add "§6a Known Risks" listing the four forge weak points, each with its current mitigation (review cap and visual-first Review; FR-11 budget; FR-14 estimation; example Recipes per Project type from OQ7). Also note that the forge says "owner writes it **in MVP**", which implies agent-assisted Recipe authoring could come in phase two. Add that to §9.2.

## G14. Blocking validation findings have no explicit path
- **Source:** forge memlog: "At decision points (e.g. after validation with non-critical findings), the coordinator may invoke a short-lived 'triage' agent … Intelligence is a stage."
- **PRD status:** weakened (minor). FR-12 covers only *non-blocking* findings. The lifecycle in §4.3 implies that blocking findings re-run the Implementer, but no FR states it, or states that the lap counts toward the budget.
- **Suggested fix:** add a bullet to FR-12 (or a new FR): blocking findings send the Task straight back to the Implementer with the findings in context, and this counts as a lap (FR-11).

## G15. Minor / wording
- **Forge "open a link on phone or laptop"**: the PRD is phone-only in wording. That's fine as the primary surface (PRD memlog decision), but laptop viewing of Demos could be stated as allowed. (§4.6, one clause.)
- **Forge "CI … as frequently as possible (every agent branch, not just main)"**: FR-17 keeps CI on every push but parks its location in an ASSUMPTION. Also, CI isn't in the FR-2 Recipe step list (build, run, test, evidence, demo, release) even though the forge Recipe lists CI. Add "ci" to the FR-2 step list or say that "test" covers it.
- **Forge "production on a real cluster (AWS/DO/Solus) or bare metal"**: the PRD cuts it with no direction for phase two. Add one line to §9.2 if productization matters.
- **Forge "Correction … evidence regenerated"**: implied by FR-24 but not stated. Add "Evidence is regenerated for all criteria" to FR-24.
