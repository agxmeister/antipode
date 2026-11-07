---
title: 'Scaffold and operations envelope'
type: 'feature'
created: '2026-11-07'
status: 'done'
baseline_commit: 'd50293ed7b14ae5ee2e34eafc78d3428fa87173a'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-antipod/config-defaults.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repo has no code. Every later story needs a package with enforced layering, an instance selected by `ANTIPOD_HOME`, validated config, structured logs, a migrated SQLite file and the ops commands (spine AD-1, AD-2, AD-15, AD-23, AD-24).

**Approach:** Scaffold the pnpm/TypeScript package in the spine's source tree. Build an `antipod` CLI with `daemon`, `backup`, `upgrade` and `plist` commands. The daemon boots by loading config, opening the database and running migrations. It then idles, reloads config on SIGHUP and exits cleanly on SIGTERM.

## Boundaries & Constraints

**Always:** Stack versions as the spine pins them: Node 24, TypeScript 7.0, better-sqlite3 13, zod 4.6, pino 10 + pino-roll 3, vitest 4. `src/core/` imports only `node:*`, `zod` and `core/` (domain ← ports ← coordinator). Adapters import only `core/`, never another adapter or `app/`, and the layering check fails the lint. Migrations are forward-only and each one runs in a transaction. Tests run under a scratch `ANTIPOD_HOME` with file-backed SQLite.

**Decisions:** A failed SIGHUP reload is log-only in this story. The Owner-visible `outbox` notice and its copy come in a later story through correct-course. The pino-roll transport writes and size-rotates `logs/antipod.log`, and the launchd plist sends StandardOut/ErrorPath to `logs/launchd.log`, which only catches crashes before the logger starts.

**Never:** No Task/Project tables: each later story adds its own migration. No Telegram, git, claude or Podman code. No test may touch `~/.antipod`, the real launchd or a real `git pull`. `antipod plist` only prints and never installs into `~/Library/LaunchAgents`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Boot, fresh home | `ANTIPOD_HOME=<tmp>` with a valid `config.yaml` | Creates `data/ logs/ run/ secrets/`, `secrets/` is mode 700; `data/antipod.db` is migrated to the latest version; logs `daemon_started` | N/A |
| Defaults | config holds only `owner.telegram_user_id` | Every key in config-defaults.md resolves to its default | N/A |
| Invalid config | missing owner id, or `limits.concurrency: 4` | Refuses to start, names the key path, exit 1 | `ConfigInvalidError` |
| Newer database | `user_version` above the highest known migration | Refuses to start, exit 1 | `DatabaseNewerThanCodeError` |
| SIGHUP, valid | edited `config.yaml` | New config takes effect; logs `config_reloaded` | N/A |
| SIGHUP, invalid | broken `config.yaml` | Keeps the previous config; logs `config_reload_failed` at error level | Never crashes |
| Backup | `backup.path` set | `VACUUM INTO` writes `<path>/antipod.db` through a temp file and a rename; rsyncs `data/` (without `antipod.db*`) to `<path>/data/` | Missing `backup.path` or rsync failure → message, exit 1 |
| Upgrade step fails | e.g. the build fails | Stops, names the failed step, exit 1; later steps do not run | N/A |

</frozen-after-approval>

## Code Map

Greenfield: only `docs/`, `_bmad/`, `.claude/`, `AGENTS.md`, `CLAUDE.md` and `.gitignore` exist. Source tree, ports list and conventions come from the spine's Structural Seed. Do not touch `_bmad/`, `.claude/skills/` or any file under `docs/`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore` -- ESM package `antipod` with `bin.antipod` → `dist/app/cli.js`, `engines.node` 24 and `packageManager` pnpm; scripts `build` (tsc → `dist/`), `typecheck`, `test` and `lint` (dependency-cruiser); ignore `node_modules/`, `dist/`, `coverage/` -- package base
- [x] `.dependency-cruiser.cjs` -- AD-1 rules: core-allowed-imports, domain-imports-nothing-up, no-adapter-to-adapter, no-adapter-to-app -- enforced layering
- [x] `src/core/domain/errors.ts`, `src/core/ports/clock.ts` -- `AntipodError` base, `ConfigInvalidError`, `DatabaseNewerThanCodeError`; the `Clock` port (`monotonicMs()`, `now()`) -- shared error vocabulary and the first port
- [x] `src/app/home.ts`, `src/app/config.ts` -- resolve `ANTIPOD_HOME` (default `~/.antipod`) and create its dirs; zod schema for `config.yaml` (`owner.telegram_user_id` required; `agent.auth` subscription|api-key; `limits`, `usage`, `intake`, `outbox` and `telegram` defaults from config-defaults.md; `backup.path` optional; `capabilities` map; `logging.level`) parsed with `yaml` -- AD-15 instance config
- [x] `src/app/logger.ts`, `src/app/clock.ts` -- pino through pino-roll to `logs/antipod.log`, rotated by size, with a `child({project_id, task_id, stage_id})` helper; system clock from `performance.now` and `Date` -- AD-23 logging, AD-18 clock seed
- [x] `src/adapters/sqlite/db.ts`, `src/adapters/sqlite/migrate.ts`, `src/adapters/sqlite/migrations/index.ts`, `migrations/0001-settings.ts` -- open with WAL and foreign keys on; apply ordered `{id, name, sql}` modules by `PRAGMA user_version`, one transaction each; refuse a newer db; 0001 creates `settings(key PK, value, updated_at)` -- AD-2, AD-23
- [x] `src/app/daemon.ts`, `src/app/cli.ts` -- boot sequence, SIGHUP reload, SIGTERM/SIGINT close; CLI via `node:util` `parseArgs` -- composition root
- [x] `src/app/ops/backup.ts`, `src/app/ops/upgrade.ts`, `src/app/ops/plist.ts`, `launchd/com.agxmeister.antipod.plist` -- backup as in the matrix; upgrade runs `git pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build` → migrate → `launchctl kickstart -k gui/<uid>/com.agxmeister.antipod` through an injected command runner; the plist template has `KeepAlive`, `RunAtLoad`, `EnvironmentVariables.ANTIPOD_HOME` and placeholders for absolute node and CLI paths -- AD-23 ops
- [x] `test/setup.ts`, `test/helpers/home.ts` -- the setup fails if `ANTIPOD_HOME` is unset or resolves to `~/.antipod`; the helper creates a temp home with config -- AD-24 guard
- [x] `test/**` -- one test per matrix row, the plist render, and layering: depcruise run on fixtures under `test/fixtures/layering/` that break each rule -- proof
- [x] `AGENTS.md` -- replace the story 1-1 TODO line with the real install/test/typecheck/lint/build commands -- agent instructions

**Acceptance Criteria:**
- Given a clean checkout, when `corepack enable pnpm && pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` runs, then every command exits 0.
- Given a file under `src/core/` that imports `pino`, or an adapter importing another adapter, when `pnpm lint` runs, then it fails and names the rule.
- Given a built package and a scratch home, when `ANTIPOD_HOME=<tmp> node dist/app/cli.js daemon` runs and then receives SIGTERM, then it exits 0 and `logs/antipod.log` holds JSON lines for `daemon_started` and `daemon_stopped`.

## Implementation Notes

- Implemented in d5b4b17. The implementation subagent committed and pushed it itself, per the Owner's commit-to-main policy.
- dependency-cruiser cannot read TypeScript 7, so it uses `parser: 'swc'` with `@swc/core`. `pnpm-workspace.yaml` (`allowBuilds: {'@swc/core': false}`) gets past pnpm 12's block on install scripts. A fixture shows that type-only imports are still caught.
- pino-roll always writes numbered files (`antipod.N.log`). `logs/antipod.log` is therefore a symlink, moved atomically to the current file on each rotation. Rotation is at 10 MB with 9 rolled files kept; config-defaults has no values for either, so these were chosen here.
- Added an `antipod migrate` command, so the upgrade's migrate step runs the freshly built code.
- Source imports use `.ts` extensions, which tsc rewrites to `.js` on build, so `node src/app/cli.ts` runs unbuilt.
- `config.yaml` objects are strict, so unknown keys are rejected. Each later story must add its own config keys to the schema. The key is `telegram.stale_after_ms`, as in config-defaults.md.
- Upgrade was exercised only with a fake runner. Backup uses the system `rsync -a --exclude 'antipod.db*'` with no `--delete`.
- Review pass 1 applied 13 patches (see Review Triage Log). They added `src/app/pid-lock.ts`, the single-daemon lock at `run/antipod.pid`, and `PATH` in the plist. The orchestrator later changed `antipod plist` to drop relative PATH entries instead of failing on them.

## Spec Change Log

## Review Triage Log

Pass 1 (blind, edge-case, verification-gap):

| # | Source | Finding | Verdict | Evidence | Route |
|---|--------|---------|---------|----------|-------|
| 1 | VG | Boot-time `logging.level` is never tested | medium | Only reload sets a non-default level in tests, so dropping the boot line would ship green | patch |
| 2 | VG | `antipod migrate` CLI is untested, and upgrade depends on it | medium | No `main(['migrate'])` call in `test/` | patch |
| 3 | VG | CLI usage and exit codes are untested | low | Operator UX only, no consumer in this story | defer |
| 4 | VG | Backup never runs with an open writer or WAL-only rows | medium | `homeWithData` stops the daemon (checkpoint) before backing up | patch |
| 5 | VG | build and typecheck are not in the test path | low | The spec's Verification runs them; a CI/verify script is the follow-up | defer |
| 6 | VG/ECH | `stop()` skips `appLogger.close()` if `db.close()` throws | low | `daemon.ts` stop has no try/finally; the fix is a direct correction | patch |
| 7 | BH | Plist has no `PATH`, so launchd's minimal PATH hides git/claude/Homebrew | medium | `EnvironmentVariables` holds only `ANTIPOD_HOME`; later stories spawn these tools | patch |
| 8 | BH | No single-instance guard: two daemons can share one home | medium | `run/` is unused; a manual `antipod daemon` beside launchd breaks AD-2/AD-3's one process | patch |
| 9 | BH/ECH | Concurrent migrators both apply the same step | medium | `from` is read outside a DEFERRED transaction; the daemon boot and upgrade's migrate can overlap | patch |
| 10 | BH/ECH | Upgrade migrates while the old daemon runs; a failed kickstart leaves old code on a newer schema | maybe-false (medium if true) | Step order follows spine AD-23; harmless until a destructive migration exists | defer |
| 11 | BH/ECH | A relative or `~` `backup.path` resolves against an arbitrary cwd | medium | `resolve(configured)` in backup.ts | patch |
| 12 | BH | Raw errors for a missing db, rename or rsync ENOENT; no `--delete` | low / false | Still exit 1 with a message; no `--delete` is intended (keep everything) | reject |
| 13 | BH | Config read error hides the errno (ENOENT vs EACCES) | low | `cannot read config file` for every read error; adding the code is a direct correction | patch |
| 14 | BH | The clean layering fixture shows core doing `node:fs` I/O as allowed | low | `clean/.../scheduler.ts` uses readFileSync and contradicts "effects via ports"; the fix is a fixture edit | patch |
| 15 | BH | No `not-to-unresolvable` / `no-circular` depcruise rules | low | tsc already fails unresolvable imports | reject |
| 16 | BH/ECH | Relink throws inside the 'ready' handler, or a stream 'error' has no listener, and either crashes the daemon | medium | logger.ts has no try/catch in relink and no 'error' listener | patch |
| 17 | BH/ECH | No uncaughtException/unhandledRejection fatal log | low | New process-level surface; rare | reject |
| 18 | BH | Home root, data/ and logs/ readable by other local users | low | Only secrets/ is 700; SPEC keeps Evidence private to the Owner; a mode flag is direct | patch |
| 19 | BH/ECH | Temp homes leak; the setup guard only sees the injected value | low | Test hygiene; the fix adds teardown plumbing | reject |
| 20 | BH | Untested spawnCommand signal mapping, close idempotence, SIGINT via process | low | Flat 128 is harmless; covered indirectly | reject |
| 21 | BH | Backup test writes a fake `antipod.db-wal` | low | SQLite ignores the invalid WAL; the test still checks the exclusion | reject |
| 22 | ECH | Negative `user_version` re-runs migrations | low | Only reachable by tampering by hand | reject |
| 23 | ECH | `close()` hangs after the stream has errored | low | Only reachable via #16, which is patched | reject |
| 24 | ECH | SIGHUP during boot uses Node's default handler and terminates | low | Millisecond window; the fix reorders the boot | reject |
| 25 | ECH | `backup.path` inside data/ makes rsync recurse | low | Needs deliberate misconfiguration; the fix adds a guard | reject |
| 26 | ECH | Unanchored `--exclude antipod.db*` drops nested files with that prefix | low | Direct correction to `/antipod.db*` | patch |
| 27 | ECH | Relative `ANTIPOD_HOME` differs by cwd | low | The plist always renders it absolute; the fix is a guard | reject |
| 28 | ECH | `antipod help extra` exits 0 | low | Cosmetic | reject |
| 29 | ECH | A barrel file directly under `src/adapters/` escapes the adapter rule | low | No such file; unlikely | reject |

## Design Notes

Migrations are TS modules rather than `.sql` files, so `tsc` ships them in `dist/` with no copy step. Biome/ESLint are skipped: typescript-eslint support for TS 7 is uncertain, so `lint` is the layering check and `typecheck` is strict `tsc`. The upgrade's repo dir is the package root, resolved from the CLI file's location.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0
- `ANTIPOD_HOME=$(mktemp -d) node dist/app/cli.js plist` -- expected: prints a plist with Label `com.agxmeister.antipod` and absolute paths
