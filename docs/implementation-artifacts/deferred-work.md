# Deferred work

- source_spec: `docs/implementation-artifacts/spec-1-1-scaffold-and-operations-envelope.md`
  summary: Add CLI tests for usage, help, unknown-command and extra-argument exit codes.
  evidence: `src/app/cli.ts` argument handling has no test, so an inverted exit code or a dropped `rest.length` guard would ship green (review pass 1, #3).
- source_spec: `docs/implementation-artifacts/spec-1-1-scaffold-and-operations-envelope.md`
  summary: Add a verify script or CI step that chains typecheck, lint, build and test, and smoke-runs `node dist/app/cli.js help`.
  evidence: `pnpm test` runs `src/` only, while launchd and upgrade run `dist/` (review pass 1, #5).
- source_spec: `docs/implementation-artifacts/spec-1-1-scaffold-and-operations-envelope.md`
  summary: Revisit `antipod upgrade` ordering (migrate before kickstart) before the first destructive migration; consider stopping the agent first, or a pre-upgrade backup.
  evidence: unverified, medium if true. The old daemon checks the schema only at boot, so a failed kickstart leaves it on a newer schema; AD-23 fixes the order. Settle by checking whether any migration drops or renames columns (review pass 1, #10).
- source_spec: `docs/implementation-artifacts/spec-1-2-coordinator-core.md`
  summary: Make Integration and Release effects safe under pause, cancel or amendment: the `integrate`/`run_release` handler must re-check Task state before each step and `resume` must not queue a second one.
  evidence: medium. `pause` from `integrating` (allowed by AD-3) leaves the pending `integrate` effect running and `resume` re-enters `integrating`, pushing another `integrate`. Settle in story 1-12 with a state check in the handler and idempotency per Task, or a new cancel effect (review pass 1, #12).
- source_spec: `docs/implementation-artifacts/spec-1-2-coordinator-core.md`
  summary: Decide whether `resume` should keep the Stage's attempt count instead of starting a fresh Stage at attempt 1.
  evidence: Seen in the story 1-2 walkthrough demo: `enter()` on `resume` starts attempt 1, so pausing and resuming gives a failing Stage a new set of AD-4 retries. Defensible, since AD-4 counts retries per Stage and the Owner chose to resume; undecided by the Owner.
- source_spec: `docs/implementation-artifacts/spec-1-2-coordinator-core.md`
  summary: The `start_stage`/`run_test_step` handlers must apply `stage_failed` themselves when a launch throws.
  evidence: `failed` effects are terminal (Owner decision on #6), so a throwing launch leaves its Stage `starting` and the Task idle until the next boot's recovery. Settle in the story that registers the launch handlers (1-6/1-7).
- source_spec: `docs/implementation-artifacts/spec-1-3-scheduler-gates.md`
  summary: Reject dependency cycles and dependencies on a bootstrap Task when dependencies are recorded, or emit `deps_unsatisfiable` for them.
  evidence: medium. `isMergedToMain` never counts a bootstrap Task and the scheduler only treats `cancelled` as unsatisfiable, so such a Task waits in `waiting_on_dependencies` forever. Settle in story 1-8, which records dependencies on approval (review pass 1, #7).
- source_spec: `docs/implementation-artifacts/spec-1-4-telegram-adapter.md`
  summary: Route through `bmad-correct-course` adding `delivery_failed` to AD-10's list of kinds sent with sound.
  evidence: AD-10 says "a loud delivery-failure notice is queued" and EXPERIENCE.md calls it loud, but the `disable_notification` exception list in the same bullet leaves it out. Owner decision 2026-11-11: loud for now.
- source_spec: `docs/implementation-artifacts/spec-1-4-telegram-adapter.md`
  summary: Route through `bmad-correct-course` replacing AD-10's `❌` failure reaction with a reaction the Bot API accepts, or with the reply alone.
  evidence: high. `setMessageReaction` accepts only Telegram's standard reaction set, which lists `👀` and `👎` but not `❌` (grammY 1.46 `ReactionTypeEmoji`). `TelegramMessenger.failAck` sends `❌` as AD-10 says; Telegram will refuse it, the refusal is logged and the reply still goes out.
- source_spec: `docs/implementation-artifacts/spec-1-4-telegram-adapter.md`
  summary: Surface a `getUpdates` that keeps failing with 401 (revoked token) or 409 (second poller or webhook) somewhere the Owner sees it, and consider `deleteWebhook` at start.
  evidence: medium. `Poller.#run` retries every error with backoff and logs only `telegram_poll_failed` warnings, so Telegram silently goes deaf. Telegram is the broken channel, so the surface (daemon status, CLI, or plist exit) is an Owner decision (review pass 1, #9).
- source_spec: `docs/implementation-artifacts/spec-1-4-telegram-adapter.md`
  summary: Test that a `notify` with an unregistered `notice_kind` marks its effect `failed` and queues nothing, and decide whether the Owner should see it.
  evidence: low today, since only the two usage-window kinds are emitted and both have templates. Settle in the first story that emits a new kind (1-11/1-14) (review pass 1, #8).
- source_spec: `docs/implementation-artifacts/spec-1-4-telegram-adapter.md`
  summary: A command or text handler that throws must still give the Owner a reply: catch in the handler and queue an `outbox` notice (and `failAck`), or add one central catch in `Poller.#onMessage` that does it for every handler.
  evidence: medium. `Poller.handleUpdate` (`src/adapters/telegram/poller.ts:228`) logs `telegram_update_failed` and advances `telegram.last_update_id`, so the Owner's message is consumed with only `👀` and no reply, against AGENTS.md's rule that a failure the Owner must see becomes an `outbox` notice. Settle in the first story that registers a handler (1-5 `/register`, then 1-8 Intake, 1-15 commands). Raised in the story 1-4 walkthrough detail pass; Owner chose to carry it forward.
- source_spec: `docs/implementation-artifacts/spec-1-6-pid-reuse-guard.md`
  summary: Check that a host step's recorded start time survives a wall-clock step on the Linux VM host, or widen `START_TOLERANCE_S`.
  evidence: unverified, medium if true. Linux `ps` derives start from boot time plus ticks, so an NTP step between spawn and boot recovery could push a live step outside the 2 s tolerance and spare it while its lease is cleared. Settle by stepping the clock on the VM host with a live step (review pass 1, #5).
- source_spec: `docs/implementation-artifacts/spec-1-7-claude-cli-agentrunner-and-role-configs.md`
  summary: Make the Stage runner end the whole process group (SIGKILL after a second grace, resolve on leader exit) instead of trusting `claude` to exit on SIGTERM and close stdout.
  evidence: Unverified (would be medium): a group member ignoring SIGTERM or holding stdout keeps `run()` and daemon shutdown pending. Settle with real `claude` by leaving a SIGTERM-ignoring child in a Stage's group.
- source_spec: `docs/implementation-artifacts/spec-1-7-claude-cli-agentrunner-and-role-configs.md`
  summary: Record Stage pids like host steps so boot recovery kills an orphaned `claude` before relaunching in the same worktree.
  evidence: Unverified (would be medium): after a daemon crash AD-18 fails the Stage `restart` and relaunches while the old process may still run; it probably dies on EPIPE at its next stream-json write. Settle by SIGKILLing the daemon mid-Stage with real `claude`.
- source_spec: `docs/implementation-artifacts/spec-1-7-claude-cli-agentrunner-and-role-configs.md`
  summary: Carry a Stage failure's detail (launch error message, exit code and stderr tail, the failing schema path) into `stage_failed` and the Stuck notice, so the Owner sees why without reading logs.
  evidence: Review pass 1 finding #21; Owner asked for it as a follow-up (2026-11-15). Today `stage_failed` carries only the fixed reason name, so the Stuck notice reads "last failure: launch" while the cause (for example "no Role reviewer", "ANTHROPIC_API_KEY is not set") is only in the log. Needs a spec change: the 1-7 frozen matrix says "with the reason logged".
- source_spec: `docs/implementation-artifacts/spec-1-7-claude-cli-agentrunner-and-role-configs.md`
  summary: Run the spec's Owner-run manual check with real `claude` and a scratch `ANTIPOD_HOME`: a shipped Implementer Stage cannot write `.antipod/tasks/x.yaml` or read `$ANTIPOD_HOME/config.yaml`, ignores an `allow: ["Bash(*)"]` planted in the worktree's `.claude/settings.local.json`, lists no MCP server beyond the Role's `mcp.json`, and the materialized `permissions.json` holds `//`-prefixed realpath'd absolute rules with one deny per sibling worktree.
  evidence: Unverified, high if wrong. Fake-`claude` tests assert the argv and the rule text, not enforcement; Stage containment rests on Claude Code reading `--setting-sources ''` as no source and `//path` rules as absolute. Owner deferred it in the story 1-7 walkthrough (2026-11-16); run before Stages run unattended on a real Project, together with the SIGTERM-grace and orphan checks above.
- source_spec: `docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`
  summary: Make a failed `commit_contract` or `prepare_branch` block the Implementer `start_stage` and reach the Owner as an outbox notice, not only a `failed` effect row.
  evidence: `EffectExecutor.#runOne` marks a throwing effect `failed` and drains the next row, so the Implementer can start without the Branch projection and the Owner sees `⏳ Queued` with nothing following (review pass 1, #8).
- source_spec: `docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`
  summary: Remove the source inbox file in the first contract commit only when the Branch blob at that path still equals the imported `blob_sha`.
  evidence: If the Owner pushes a newer blob at the same path before `commit_contract` runs, the newer, unimported file is removed on the Branch and disappears from `main` at merge (review pass 1, #9).
- source_spec: `docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`
  summary: Decide what a reply to a Draft card does while that draft is in `draft` (Intake rerunning) or `discard_pending`; today it silently creates an unrelated new draft.
  evidence: `Intake.onText` routes to `draft_reply` only for `awaiting_approval` and otherwise falls through to `createTask` (review pass 1, #10). Needs an Owner decision.
- source_spec: `docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`
  summary: Decide whether Intake exhausting retries on a revision (a `draft_reply`) should return the draft to `awaiting_approval` on its previous version instead of cancelling it, and give the closed card a state line.
  evidence: `stage_retries_exhausted` in `draft` always cancels; a card closed with `closed: 'cancelled'` keeps its old text with `· draft` and no buttons (review pass 1, #11). Needs an Owner decision; the spec text reads as cancel.
- source_spec: `docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`
  summary: Fetch before reading `main` at Approve so `config_sha` and the feasibility check use the current `main`.
  evidence: The Approve handler reads the local `origin/main`, up to `git.fetch_interval_ms` stale (review pass 1, #12).
- source_spec: `docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`
  summary: Add a test that ticks inside `git.fetch_interval_ms` queue no second `scan_inbox` and a tick after it does.
  evidence: The only rescan test advances exactly 60 s and would pass without the gate (review pass 1, #13).
