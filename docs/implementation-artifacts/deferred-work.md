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
