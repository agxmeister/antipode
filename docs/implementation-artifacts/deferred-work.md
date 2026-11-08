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
  summary: Decide whether boot recovery replays `failed` effects as well as `pending` ones.
  evidence: Spine AD-18 says "re-executes every `effects` row not `done`"; the story's frozen matrix narrowed it to `pending`, and `recovery.ts` follows the matrix. A `notify` or `integrate` whose handler threw is never retried at boot. Owner decision via correct-course (review pass 1, #6).
- source_spec: `docs/implementation-artifacts/spec-1-2-coordinator-core.md`
  summary: Confirm that `review_round` should increment on every entry to `in_review`, including `resume` and `undone`.
  evidence: unverified, medium if a round must mean one Review delivery. `enter('in_review')` bumps the round on each entry, matching AD-16 "exactly on each entry" and AD-10 "keyboard retired on each entry"; a pause/resume or Accept-then-Undo therefore retires the live Review card's buttons (review pass 1, #11).
- source_spec: `docs/implementation-artifacts/spec-1-2-coordinator-core.md`
  summary: Make Integration and Release effects safe under pause, cancel or amendment: the `integrate`/`run_release` handler must re-check Task state before each step and `resume` must not queue a second one.
  evidence: medium. `pause` from `integrating` (allowed by AD-3) leaves the pending `integrate` effect running and `resume` re-enters `integrating`, pushing another `integrate`. Settle in story 1-12 with a state check in the handler and idempotency per Task, or a new cancel effect (review pass 1, #12).
