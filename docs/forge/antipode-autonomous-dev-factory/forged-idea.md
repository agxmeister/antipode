# Antipode — forged idea

Autonomous downstream software factory for a single project owner. Product = the **acceptance surface** (preview + evidence + one-tap accept/correct from a phone). Agents, containers, branches, CI are plumbing.

## Locked
- Scope: downstream (implementation) only. Upstream idea-forming is phase two.
- First user: the author. Exactly one reviewer per project: the owner.
- Input = task contract, a structured file in the repo: goal, acceptance criteria, required evidence per criterion, dependencies. Antipode consumes specs (SDD-friendly); it never invents them. Intake agent asks the owner for missing criteria; no task starts without them.
- Branch per task. Shared workspace = shared repo + visibility, never simultaneous edits to one tree.
- Roles, each a fresh ephemeral Claude container with its own context built from the shared ground (task record + repo) and role config (instructions, skills, MCPs): intake, implementer, validator, evidence producer, triage. Worker never grades its own work.
- Coordinator is non-intelligent: persisted task state, stage triggers, timeouts, retries, iteration budget. No central LLM. Triage agent (clean context) decides at branch points: re-run implementer or park findings in a deferred-work ledger. Budget exhausted → task goes to owner as "stuck".
- Evidence artifact is mandatory before a task is reviewable. UI: before/after screenshots or recording. Data/backend: counts, checksums, request/response, named tests. Parking lot shown at review.
- Review = owner looks at the running result, not code. Minimum text, maximum visualization. Delivered via Telegram with preview link, accept, request changes.
- Correction = feedback on the same task, same branch. No new intake. Implementer re-runs with note + prior evidence; validator re-runs; report leads with diff vs what owner saw. At most one clarifying question.
- Accept ≠ merge. Accept → rebase on main → validator + CI → merge → deploy to prod. Conflict/failure returns to implementer. Dependent tasks start only after dependencies are merged. No stacked branches. Every merge deploys to prod.
- CI on every push on every branch. Preview container per branch; previews sleep on inactivity.
- Demo-first enforced: a project must have a working preview environment before feature tasks start. Project recipe in repo (build, preview, CI, prod deploy, seed data, preview secrets); owner writes it. Ephemeral seeded DB per preview, no prod snapshots. Tests-plus-screenshots evidence is degraded mode only.
- Billing: Claude Code subscription sessions in MVP, API tokens phase two. Cost tracking essential: per task and per stage (tokens, wall time) in the report and on demand.
- MVP runtime: Podman on one machine. Telegram only. Claude only.

## Cut to phase two (and why)
- Web UI — owner already carries Telegram.
- Multi-vendor agents (Codex etc.) — role config leaves the plug.
- Cluster / cloud / bare metal — one owner, one box is enough to get the week-two feeling.
- Automated reviewer agent — human gate first; replace once evidence quality is proven.
- Orchestrator agent — rejected outright: nondeterministic, loses state on restart.

## Weak points that survived
- Review throughput of one human is the true factory ceiling; design must keep acceptance to ~1 minute.
- Subscription spend is not metered in money; cost tracking rests on tokens/session time/rate-window and is approximate.
- Preview environments cost a quarter per product team at real companies; the recipe pushes that onto the owner.
- Triage agent can loop; iteration budget is the only brake.
