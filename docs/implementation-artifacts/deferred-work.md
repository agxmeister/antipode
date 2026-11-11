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
