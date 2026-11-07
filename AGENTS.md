<!-- bmad:context -->
<!-- Verified 2026-11-07 against 13d4714. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## antipod

Antipode: a single-Owner daemon that turns Task contracts into Evidence-backed Reviews on Telegram, running each Stage as a `claude -p` subprocess. TypeScript on Node 24, pnpm, SQLite (better-sqlite3), grammY, zod, vitest. The build contract is `docs/specs/spec-antipod/SPEC.md` with its companions; story status is in `docs/implementation-artifacts/sprint-status.yaml`.

## Policy

- Commit and push straight to `main`; no feature branches or pull requests.
- Never change SPEC, architecture or UX docs to match the code. When one looks wrong or contradicts another, stop and ask the Owner; the fix goes through `bmad-correct-course`.
- Never edit `_bmad/` or `.claude/skills/`; they are BMad installer files, overwritten on update. Customize through `bmad-customize`, which writes `_bmad/custom/`.
- Tests never use the Owner's Claude login or a real Telegram bot token; use the fakes in spine AD-24 (fake `claude` on PATH, grammY transformer, temporary git remote, file-backed SQLite).
- Never run the daemon or `antipod` CLI with the default `ANTIPOD_HOME` (`~/.antipod`), which is reserved for the Owner's real instance; point `ANTIPOD_HOME` at a scratch directory.

## Where things are

- Rules for any change under `src/`: `docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md` (AD-1..AD-24, layer and port tables).
- Owner-facing message copy and visuals: `docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/EXPERIENCE.md` and `DESIGN.md`.
- Default limits, timeouts and retries: `docs/specs/spec-antipod/config-defaults.md`.

## Running and verifying

- Use pnpm, never npm or yarn; it is not installed here yet, so run `corepack enable pnpm` first.
- Node 24 LTS and TypeScript 7.0, per the spine's Stack table.
- TODO (story 1-1): install, test (vitest 4), typecheck and lint commands; record the real invocations on the first refresh.

## Conventions that differ from defaults

- `src/core/` imports only Node built-ins and `zod`; every external effect goes through a port in `src/core/ports/`, and adapters never import each other (AD-1).
- Only the Coordinator changes Task state: `applyEvent` writes the state, the `stage_events` row and `effects` rows in one SQLite transaction; never call an adapter inside it, effects run after commit (AD-3).
- Schema changes are new forward-only migrations in `src/adapters/sqlite/migrations/`; never edit one that has been committed (AD-23).
- Never update or delete Evidence rows or files; a repeat marks earlier rows `superseded` (AD-8).
- Read criteria from the `contracts`/`criteria` rows, never from `.antipod/tasks/*.yaml`, which is only a projection (AD-21).
- A failure the Owner must see becomes an `outbox` notice, never only a log line.
- "Antipode" in Owner-facing copy and docs; `antipod` in package, CLI, paths and identifiers. Use `docs/specs/spec-antipod/glossary.md` terms with their capitalization.

<!-- /bmad:context -->
