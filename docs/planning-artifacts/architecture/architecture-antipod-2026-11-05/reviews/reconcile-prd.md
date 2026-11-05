# Reconciliation: PRD + addendum vs ARCHITECTURE-SPINE.md

- Inputs: `../../../prds/prd-antipod-2026-11-01/prd.md` (final, 2026-11-04), `addendum.md`
- Spine: `../ARCHITECTURE-SPINE.md` (draft, 2026-11-05)
- Method: each FR-N, NFR-N, §6, §7, §8, §9, §10.3, §12 (Q1, Q2, Q3, Q6), §13 and the addendum's technical direction was checked against the Capability map and every AD. The state diagram under AD-3 is treated as normative because AD-3 says the transition table is the only mutation path.

Severity: **High** = PRD requirement absent or contradicted with no deferral; **Medium** = partially landed, or an AD reinterprets the PRD without saying so; **Low** = implicit or a detail downstream can fill without an architecture decision.

## Verdict

The spine covers the lifecycle, Evidence, Telegram, Integration and cost well. It does **not** land Preview Data (FR-5) at all, the AD-3 transition table is missing the Owner-control, contract-edit and Stuck edges the PRD requires (FR-12, FR-13, FR-14), and the isolation story (NFR-4, addendum "sandboxed host workdir") is weaker than the PRD assumes. Several quiet requirements (60 s video cap, bootstrap Task creation, BMad story mapping, cost breakdown command, global vs per-Project backpressure) are absent or silently changed.

## 1. Functional requirements

| FR | Status | Finding |
| --- | --- | --- |
| FR-1 Register a Project | Landed | `app/` CLI, Recipe validated on registration (conventions), one chat per Project (ER diagram). Registration happens from the Mac CLI, not the phone; acceptable for MVP. |
| FR-2 Runners per step, `exclusive` | Landed | AD-7 step contract, AD-11 exclusive gate, AD-19 capability names. |
| FR-3 Bootstrap Evidence gate | **Partial (Medium)** | AD-11 has a "bootstrap accepted" gate, but nothing says *who creates* the bootstrap Task, that it is exempt from its own gate, that its Review must show one artifact of **every declared Evidence kind**, or that a Recipe unable to produce visual/measurable Evidence keeps the Project in onboarding. No AD binds these rules. |
| FR-4 Recipe-defined Evidence kinds | Landed | `evidence_kinds` in the Recipe seed; AD-8 closed kind set. "Printability check" maps to `test_result`/`measurement` — fine. |
| FR-5 Preview Data and secrets | **Missing (High)** | Secrets land (AD-14). **Preview Data / fixtures do not appear anywhere**: no `fixtures`/`preview_data` field in the AD-7 step contract or the Recipe seed, no per-Branch seeding, no discard on merge/cancel (FR-24), no "sandbox credentials or stubs the Recipe declares" for external services. The Capability map routes FR-5 to podman/host/git, but no AD governs it. The "never reads production data" rule is covered only by the `PROD_` prefix heuristic for secrets. |
| FR-6 Contract files from the repo | **Partial (Medium)** | AD-5 detects a contract on `main` and offers it. Missing: (a) a contract without criteria / without Required Evidence is routed to **Intake, not the queue** — not stated; (b) the **BMad story → contract mapping** (§13 assumption explicitly routed to architecture) is absent; (c) how a `main` contract gets its `task_no` before it has a Branch, and what polls `main` for changes, is unspecified. |
| FR-7 Draft from Telegram text/voice | Landed, one tightening (Low) | AD-9, AD-17. PRD allows **up to two** clarifying questions on a draft; AD-9 fixes "at most one question per message". Stricter, not contradictory, but say so. |
| FR-8 Evidence feasibility check | **Partial (Low–Medium)** | Routed to "core/domain/recipe, Intake Role Config". No AD states that the **Coordinator** (not the LLM) refuses approval while any criterion's Required Evidence is not in `evidence_kinds`. NFR-3 wants that gate deterministic. |
| FR-9 Approve / edit / discard | Landed | AD-3 (`approved`, `revised`, `discarded`), AD-5 commit on approval. |
| FR-10 Interpret Owner Messages | Landed | AD-9 union covers correction, amendment (incl. budget), new draft, cancel, question. Confirmation on criteria/budget changes present. Pause/resume are not in the union; presumably commands — state it. |
| FR-11 Persisted state | Landed | AD-2, AD-18. |
| FR-12 Stage timeouts/retries; no session while waiting | **Partial (Medium)** | Timeout (AD-4) and restart retry (AD-18) land. But: (a) the retry **limit** and where it is configured are not named (Deferred mentions timeouts only); (b) in AD-3, `stuck` is reachable **only from `implementing`** — a Validator, Triage, Evidence Producer or post-Accept Validator Stage that exhausts retries has no edge to `stuck`; (c) "no agent session runs while a Task waits for the Owner" is satisfied structurally (a Stage is a subprocess that exits with typed output; `in_review`/`stuck`/`awaiting_approval` start no Stage) but never written as an invariant. Add it to AD-4 or AD-11 so a future "keep the session warm" optimisation cannot slip in. |
| FR-13 Validation outcomes, Iteration Budget, Triage clean context | **Partial (Medium)** | Routing and budget increment land (AD-3). Missing: when the budget is spent the PRD requires **Triage to write the one-line reason**; AD-3 goes `implementing → stuck` directly with no Triage Stage. "Triage in a clean context" is satisfied by AD-4 (fresh `claude -p`, brief = contract + Evidence + Parking Lot, no Implementer/Validator transcript) but not stated as a rule — add one sentence. Also AD-3 increments budget on every `implementing` entry except `correction`; a **pause/resume** (`paused → queued → implementing`) would consume a unit, which the PRD does not intend. |
| FR-14 Owner controls | **Contradicted by the state diagram (Medium)** | PRD: pause, resume, cancel **at any time**; editing an in-progress contract **restarts from implementing**. AD-3: `pause` only from `queued`/`implementing`; `cancel` only from `stuck` (and `discarded` from `awaiting_approval`); **no `amended` edge** from `validating`, `triage`, `evidencing`, `in_review` or `integrating`. "Cancelled Branch kept, never merged" and worktree disposal are not stated. Either the diagram is incomplete (say it is illustrative) or the table is wrong. |
| FR-15 Dependencies, concurrency 1–3 default 2 | Landed | AD-11. "Never starts on another Task's unmerged Branch" is implicit (worktree from `main`) — AD-5 should say branches are cut from `main`. |
| FR-16 Review Queue backpressure | **Changed (Medium)** | PRD/glossary define the Review Queue as **all** unanswered Reviews (the limit protects one Owner's attention, §7). AD-11 makes it **per-Project**. With three Projects that is up to 9 open Reviews. Silent reinterpretation; needs a decision. |
| FR-17 Usage Window budgeting | **Partial (Medium)** | AD-12 meter + `WindowReader` land, OQ4 explicitly deferred to a spike. But the PRD pauses **new Stages**; AD-11 gates only **`queued` Tasks**. A Task in `implementing → validating → evidencing` keeps launching Stages past the threshold. The `paused` state with "waiting for usage window + estimated resume" is not wired for mid-flight Tasks. |
| FR-18 Role Configs, extensible Roles | Landed, gap (Low) | AD-15. "A new directory is a new Role, usable by name from a Recipe" — but the lifecycle is a fixed transition table; where a sixth Role would run is unspecified. |
| FR-19 Independent validation | Landed | AD-4 brief excludes the Implementer's report; separate Stage. |
| FR-20 Branch per Task; CI on every push | **Reinterpreted (Medium, flagged `[ASSUMPTION]`)** | AD-13: "CI on every push" = Recipe `test` step after every Implementer Stage; hosted CI not awaited. Acceptable as a decision, but (a) the spine never says **when a Task Branch is pushed** to the remote (only the post-merge push is mentioned), so hosted CI and off-machine backup of Branches may never happen; (b) the §13 assumption ("Recipe decides where CI runs") is replaced by "always local test step". |
| FR-21 Evidence per criterion | Landed | AD-8, AD-3 double validation. |
| FR-22 Visual-first, before/after, Degraded label | Landed | `degraded`, `before_of?` in AD-8; composites AD-20. Cross-round before/after after a Correction relies on the Evidence Producer brief carrying prior Evidence (AD-4) — fine. |
| FR-23 Phone-native: images, **video ≤ 60 s**, small files | **Missing (Medium)** | No AD states the 60 s screencast cap, a file-size cap, or who enforces it (Coordinator at ingest vs Evidence Producer). Only the 50 MB Demo cap appears, in Deferred. "Each screencast shows only its criterion" is Role-prompt territory — fine. |
| FR-24 Demo, link privacy, sleep/wake, Preview Data discard | **Partial (Medium)** | MVP Demos are Telegram **files only** (resolves OQ2; privacy trivially met). Sleep/wake is implicitly deferred with "preview environments for web Projects". Gaps: (a) **Unity WebGL Demo** is an MVP Project type (§10.2 step 4) and a WebGL build is not usable as a Telegram file — no delivery path; (b) Preview Data discard on merge/cancel — missing with FR-5. |
| FR-25 Durable Evidence, retrievable | Landed, gap (Low) | AD-2/AD-8 keep it; no Telegram command to **retrieve** past Evidence is named (cards list is in UX, but the Coordinator command surface should enumerate it). |
| FR-26 Review message | Landed | AD-10, cards, AD-12 cost line. |
| FR-27 Accept | Landed | AD-13 (adds a 10 s Undo from UX — not in PRD, not out of scope). |
| FR-28 Correction, Peek, Status, Stuck replies | Landed, gap (Low) | AD-8 Peek = newest artifact; the **one status line** ("lap 2 of 5") requires reading the live `stream-json` — feasible via AD-4 persistence but not stated. |
| FR-29 Integration | Landed | AD-13, AD-3 (`integrating → implementing`, budget counts). |
| FR-30 Release, no rollback | Landed, gap (Low) | AD-13 no-rollback. A **merged-but-Release-failed** Task has no state in AD-3 (`integrating → released` only). |
| FR-31 Cost per Stage/Task/Project; **breakdown per window on request** | **Partial (Low–Medium)** | AD-12 collects; the Review cost line lands. The on-demand breakdown (per Task / per Project / **current window**) has no command or query path named. |

## 2. Non-functional requirements

| NFR | Status | Finding |
| --- | --- | --- |
| NFR-1 Review ≤ 1–2 min | Not bound (Low) | Listed in `binds` but no AD or Capability-map row references it. The 60 s cap (FR-23) is its architectural lever — add it. |
| NFR-2 Durability | Landed | AD-2, AD-10 outbox, AD-18. |
| NFR-3 Determinism | Landed | AD-3, AD-9. Weak spot: FR-8 approval gate (see above). |
| NFR-4 Isolation | **Weak (Medium–High)** | AD-6 `[ASSUMPTION]` runs the agent **on the host** as the Owner's user with containment = `cwd` + permission rules + no secrets in env. That agent can `cat ~/.antipod/secrets/<project>.env` (same user, mode 600 is no barrier) and write to any other worktree. "Stages write only to their own Branch" and "get only the non-production secrets" are therefore policy, not enforcement. The addendum asked for "its own container or **sandboxed** host workdir"; the spine names no sandbox (Claude Code sandbox settings / deny rules / separate user). Needs an explicit decision or an honest downgrade of NFR-4 for the MVP. |
| NFR-5 Observability | Landed, gap (Low) | Logs and transcripts persisted (AD-2, AD-4); "Owner can retrieve them at any time" has no phone-side path. |
| NFR-6 5 s acknowledgement | Landed | AD-10 reacts before processing; callbacks answer with a toast. Not stated that the reaction is sent by the adapter **without** waiting on the single-process Coordinator loop — one sentence would close it. |

## 3. §6 Constraints

- Subscription terms / API-key as a config switch: landed (AD-4 `agent.auth`).
- Privacy: landed (long polling, no public URL, files via Telegram).
- Single machine; **laptop sleep pauses, does not fail**: **gap (Medium–Low)**. AD-18 handles daemon restart, not OS sleep. A suspended `claude -p` resumes past its wall-clock timeout and would be killed and retried, burning retries and possibly budget. The `Clock` port exists; nothing says timeouts use monotonic/active time or that sleep is detected.
- Licensed tools, nothing assumes macOS beyond Host Runner: landed (AD-19, AD-6 deferral, launchd confined to `app/`).

## 4. §7 Risks needing architectural mitigation

| Risk | Mitigation in spine |
| --- | --- |
| Owner capacity | AD-11 backpressure — but per-Project (see FR-16). |
| Agents loop | AD-3 budget; retries (FR-12) are a second loop source whose limit is unnamed. |
| Subscription limits | AD-12, `agent.auth`. OK. |
| Recipe burden | `recipes/examples/` dir; Recipe shape seed. OK as a seed. |
| Evidence looks right but isn't | AD-3 second validation, `degraded` flag. OK. |

## 5. §8 Tone — no violation. Conventions defer copy to EXPERIENCE/DESIGN.

## 6. §9 Non-goals — not violated. No orchestrator agent (AD-3), no diff surface, Owner-id allow-list, no provisioning (AD-19 maps existing tools).

## 7. §10.3 Out of scope — nothing pulled in. Self-hosted Bot API server, preview environments, agent-in-container and Keychain are all in Deferred. Note: FR-14 contract edit mid-Stage implies killing a running Stage — that is restart, not steering; fine.

## 8. §12 Open questions routed to architecture

| Q | Status |
| --- | --- |
| Q1 Where CI runs | Resolved by AD-13 `[ASSUMPTION]` (local `test` step; hosted not awaited). Branch push cadence still unspecified. |
| Q2 How the phone reaches a Demo | Resolved: Telegram files; >50 MB explicitly deferred. WebGL Demo not covered. |
| Q3 Evidence storage | Resolved for MVP (Mac, indefinite) and explicitly deferred for off-machine/retention. |
| Q6 Recipe schema / examples | Partially resolved: AD-7 step contract + seed + `recipes/examples/`. Schema lacks Preview Data/fixtures (FR-5) and Demo kinds beyond `file`. |

## 9. §13 Assumptions

- FR-6 story→contract mapping: **not addressed**.
- FR-17 usage readable/estimable: addressed (AD-12, deferred spike).
- FR-20 Recipe decides where CI runs: replaced by "always local test step" (AD-13) — state the replacement.
- FR-30 no rollback: addressed (AD-13).

## 10. Addendum technical direction

| Item | Status |
| --- | --- |
| Podman Container Runner; Host Runner for Unity/emulator | Landed (AD-7, AD-19). |
| Agent "in its own container or **sandboxed** host workdir" | **Weakened** — host worktree without a named sandbox (AD-6). See NFR-4. |
| Telegram inline media, videos **≤ 60 s** | 60 s cap missing (FR-23). |
| Android: APK as file, `adb screenrecord` | Landed via Recipe scripts. |
| Unity: recordings + optional WebGL Demo | WebGL Demo delivery missing. |
| OpenSCAD: renders, printability, STL | Landed. |
| Web previews behind reverse proxy | Explicitly deferred. OK. |
| Previews sleep on inactivity | Implicitly deferred with previews; no statement. OK for MVP. |
| Agent sessions never idle waiting on Owner | Structurally true, not stated. |
| Coordinator/Runners/bot host-agnostic | Landed (AD-19, AD-6). |
| Host Runner = named capability | Landed (AD-19). |
| Rejected alternatives (orchestrator, shared tree, stacked branches, demo-first, every-merge-deploys, web UI) | All honoured. |

## 11. Recommended spine edits (in priority order)

1. Add an AD for **Preview Data**: Recipe `fixtures`/`preview_data` declaration, per-Branch seeding under `ANTIPOD_OUT` or a named volume, sandbox credentials/stubs by name, discard on merge/cancel.
2. Fix **AD-3** edges: `cancel` from every non-terminal state; `pause` from every active state (and resume to the state it left, without a budget tick); `amended` from `validating|triage|evidencing|in_review|integrating → implementing`; `stuck` from any Stage-running state on retry exhaustion; a `merged_release_failed` outcome. Say whether the diagram is normative.
3. **AD-6/AD-14**: name the sandbox (Claude Code sandbox/deny rules, or a separate user), and state that the secrets file is unreadable from a Stage, or downgrade NFR-4 explicitly.
4. **AD-8 or AD-7**: 60 s screencast cap and Telegram size cap enforced at ingest.
5. **AD-11**: make backpressure global or justify per-Project; gate Stage launches (not only Task starts) on the usage window.
6. **AD-3/AD-13**: run Triage on budget exhaustion to write the reason; invariant "no Stage runs in `awaiting_approval`, `in_review`, `stuck`, `paused`".
7. **AD-5**: bootstrap Task creation and its every-kind Evidence rule; BMad story mapping; contract-without-criteria → Intake; Branch push cadence.
8. **AD-12/AD-10**: name the `/cost` (per Task/Project/window), `/evidence` and log retrieval commands.
9. **§6 sleep**: monotonic timeouts or sleep detection in the `Clock` port.
