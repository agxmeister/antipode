---
title: 'Git adapter, Recipe validation and registration'
type: 'feature'
created: '2026-11-12'
status: 'in-progress'
baseline_commit: '9ee287b31224af159f1ecfe2122a782d002c53bb'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/EXPERIENCE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No Project can exist yet: nothing clones a repo, reads or validates its Recipe, or binds a Telegram group, so every later story has nothing to run against (CAP-1, CAP-4, CAP-5; AD-5, AD-10, AD-14, AD-22).

**Approach:** Add `adapters/git` behind a `Repo` port (bare clone, fetch, file read at a pinned `main` SHA, read-only `_main` checkout, Task worktree add/remove), a Recipe schema and validator in `core/domain/recipe.ts`, and one registration service in `app/` called by the `/register` command and by `antipod register <repo> --chat-id <id>`.

## Boundaries & Constraints

**Always:**
- The Recipe is read only from the bare clone's `origin/main` at a recorded SHA (AD-22), never from a working tree.
- Validation order: YAML parses → secret-value scan → schema → `PROD_` references. The first failure is the reason; line numbers come from the YAML document.
- A secret value is a string of 16+ characters under a key matching `secret|token|password|passwd|key|credential|auth` (case-insensitive). Items of a step's `secrets:` list are names (`^[A-Z_][A-Z0-9_]*$`) and are not scanned as values.
- Recipe schema per AD-7 and the spine seed: `name` (`^[a-z0-9][a-z0-9-]*$`, also the `<project>` path key), `evidence_kinds` (≥ 1 of `screenshot, screencast, render, composite, test_result, measurement, file`), `demo {kind, step}` whose step exists, `fixtures` null or a relative path, `steps` (strict: `runner` container needs `image`, host needs `capability`; `cmd`, `timeout` like `15m`, `secrets`, `outputs`, `exclusive`). Unknown top-level keys are kept (settings layering, AD-15).
- Git runs as `git` subprocesses with `GIT_TERMINAL_PROMPT=0`, plus `GIT_SSH_COMMAND` with `secrets/id_antipod` only when that file exists (AD-14). `owner/repo`-style `host/owner/repo` becomes `git@host:owner/repo.git`; anything with a scheme, `git@`, or an absolute path is used as given.
- Clones land in `data/repos/.incoming-<ulid>.git`, are renamed to `data/repos/<name>.git` only after validation, and are deleted on failure.
- Failure reply: loud `registration_failed`, `❌ Can't register: ${reason}`; the group stays unbound. Success reply is silent.

**Never:**
- No inbox detection (1-8), branch push, rebase or merge (1-9, 1-12), host-capability checks (1-6), or bootstrap criteria and gate (1-13).
- No YAML parsing in `core/` (it imports only Node built-ins and zod); parsing and line lookup live in `app/`.
- No writes to the Owner's repo from registration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | `/register github.com/a/training` in an unbound supergroup the bot can read; valid Recipe `name: training` | Project row with `repo_url`, chat bound, bare clone and `_main` checkout exist; success reply | — |
| No argument | `/register` | `❌ Can't register: usage /register <repo>` | — |
| Not a supergroup | private chat or basic group | `this chat is not a supergroup` | — |
| Bot can't read | privacy mode on and bot not admin | `the bot can't read all messages here: make it an admin or turn off privacy mode` | — |
| Unreachable | clone fails | `repo not reachable: ${first stderr line}` | staging dir removed |
| No `main` | remote has no `main` | `no main branch` | staging dir removed |
| No Recipe | no `antipod.yaml` on `main` | `no Recipe at repo root` | — |
| Secret value | `api_token: "abcd…(20)"` on line 14 | `Recipe contains a secret value (line 14)` | — |
| Invalid | schema issue | `Recipe invalid: steps.test.timeout must be a duration like 15m (line 7)` | first issue only |
| PROD outside release | `test` names `PROD_X` | `PROD_X is only allowed in the release step (line 9)` | — |
| Chat bound elsewhere | chat bound to Project B, different repo | `this group is already bound to B` | — |
| Repo bound elsewhere | repo's Project bound to another chat | `${Name} is already registered in another group` | — |
| Name taken | another repo's Project has the same `name` | `a Project named ${name} already exists` | — |
| Re-register | same chat, same repo | fetch, re-validate, success reply again | — |
| CLI | `antipod register <repo> --chat-id <id>` | same checks and rows, result printed to stdout, exit 0/1 | — |
| Handler throws | any command or text handler throws | `failAck`: `❌` reaction and reply `❌ Couldn't handle that: ${reason}` | reaction refusal logged, reply still sent |

**Owner decisions (2026-11-12):**
- 1-5 binds only and creates no bootstrap Task. Success copy is `${Name} registered`; 1-13 adds the bootstrap Task and the ` · bootstrap running` suffix.
- Handler failures: one central catch in `Poller.#onMessage` around command and text handlers calls `failAck` with `❌ Couldn't handle that: ${reason}`. This settles the 1-4 deferred item.
- The CLI fallback writes rows itself (works with or without the daemon running), prints the result to stdout, and sends nothing to the group.
- The full spec is kept despite its size (~2,700 tokens).

</frozen-after-approval>

## Code Map

- `src/core/ports/` -- add `repo.ts` (`Repo`): `ensureClone(url, staging)`, `fetch(name)`, `mainSha(name)`, `readFile(name, sha, path)` (undefined when absent), `syncMain(name)` (`_main` worktree fast-forwarded), `addTaskWorktree(name, taskNo, slug, baseSha)`, `removeTaskWorktree(name, taskNo)`
- `src/adapters/git/repo.ts` -- `GitRepo` over `execFile('git')`; refspec `+refs/heads/*:refs/remotes/origin/*` set on the bare clone (`git clone --bare` alone sets none); paths from AD-5
- `src/core/domain/recipe.ts` -- zod `recipeSchema`, `RECIPE_FILE = 'antipod.yaml'`, `EVIDENCE_KINDS`, `findSecretValue(tree)`, `findProdMisuse(recipe)` returning a path; callers map paths to lines
- `src/app/recipe-file.ts` -- `yaml.parseDocument` + `LineCounter`; `lineOf(path)`; `validateRecipeText(text)` → `{ok, recipe} | {ok:false, reason}`
- `src/app/registration.ts` -- `register({repo, chatId})` → `{ok, project} | {ok:false, reason}`; chat check through an injected `checkChat(chatId)`
- `src/adapters/telegram/messenger.ts` -- add `checkChat(chatId)` (`getChat` type `supergroup`; `getMe().can_read_all_group_messages` or `getChatMember(chat, me.id)` admin); add `registration_reply` and `registration_failed` cards under `cards/`
- `src/adapters/telegram/poller.ts:239` -- `#onMessage` already dispatches `/register` in unbound chats; handler contract (line ~45) says return fast, so the register handler starts the job and returns; the daemon tracks it and `stop()` awaits it
- `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts` -- `Project.repo_url`; `projectByRepo`, `projectByName`; `insertProject` writes it; `bindProjectChat` exists
- `src/adapters/sqlite/migrations/` -- append `0005-projects-repo.ts` (`repo_url TEXT`, unique index); never edit 0001–0004
- `src/core/coordinator/coordinator.ts:93` -- `createProject(name)` gains `repo_url`
- `src/app/daemon.ts:131` -- register `/register` with the messenger; `src/app/cli.ts` -- `register` command with `--chat-id`
- `test/helpers/telegram.ts`, `test/helpers/home.ts` -- reuse the API fake and `createTempHome`

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/sqlite/migrations/0005-projects-repo.ts`, `index.ts` -- `repo_url` column -- Project identity by repo
- [x] `src/core/domain/task.ts`, `src/core/ports/store.ts`, `src/adapters/sqlite/store.ts`, `coordinator.ts` -- `repo_url`, lookups -- persistence
- [x] `src/core/domain/recipe.ts` -- schema and scans -- CAP-4, CAP-5 validation
- [x] `src/core/ports/repo.ts`, `src/adapters/git/repo.ts` -- Repo port and git adapter -- AD-5
- [x] `src/app/recipe-file.ts`, `src/app/registration.ts` -- YAML lines, the one registration path -- AD-10
- [x] `src/adapters/telegram/messenger.ts`, `cards/registration.ts` -- `checkChat`, reply cards -- EXPERIENCE.md
- [x] `src/adapters/telegram/poller.ts` -- central catch around command and text handlers calling a `failAck` callback (passed in by the messenger) -- handler failures reach the Owner
- [x] `src/app/daemon.ts`, `src/app/cli.ts` -- wire `/register` and `antipod register` -- CLI fallback
- [x] `test/core/domain/recipe.test.ts`, `test/adapters/git/repo.test.ts` (temporary local remote), `test/app/registration.test.ts`, `test/app/cli.test.ts`, `test/adapters/telegram/{messenger,poller}.test.ts` -- one test per matrix row; worktree add/remove; refspec fetch -- proof

**Acceptance Criteria:**
- Given a temporary bare remote whose `main` has a valid Recipe, when `/register <path>` arrives from the Owner through the fake `Api`, then the Project is bound to the chat and one silent reply is queued.
- Given a remote whose `main` has a valid Recipe and whose other branch has an invalid one, when registering, then the `main` version is validated and registration succeeds (AD-22).
- Given a staging clone left by a crashed registration, when the next registration runs, then `data/repos/.incoming-*` is removed.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

- `Repo` port grew beyond the Code Map list: `remoteUrl` (URL normalization, so `repo_url` is compared in normalized form), `promote` (staging → `<name>.git`, replacing an orphaned clone or worktrees dir of that name), `discard`, and `removeStaging`. `mainSha` returns undefined for "no main"; clone/fetch failures throw `RepoUnreachableError` (`core/domain/errors.ts`).
- `_main` is a detached `git worktree` (no local branch), checked out `--force` and `clean -ffdx` on every `syncMain`. Read-only is by Stage permissions, not file modes.
- `PROD_` misuse is found in a non-release step's `secrets:` list and also in its `cmd` text.
- Schema messages are worded per issue (`is required`, `must be a duration like 15m`, `is not a known key`); a YAML parse error reads `Recipe is not valid YAML (line N)` (copy not in the matrix).
- `demo` and `fixtures` are optional (default null); `demo.kind` is one of the Evidence kinds; step names match `^[a-z][a-z0-9_-]*$`.
- Re-registering a repo whose Recipe `name` changed keeps the registered Project name (it is the path key) and logs `recipe_name_changed`; a rename onto another Project's name is refused.
- `checkChat` refusal when `getChat` itself fails: `can't open this chat: ${error}` (copy not in the matrix).
- CLI: `--chat-id -100…` is accepted (negative ids are rejoined before `parseArgs`); without `TELEGRAM_BOT_TOKEN` (and no injected `Api`) it exits 1, since the chat can't be checked. Registrations are serialized per process; a CLI run concurrent with a daemon registration could sweep the daemon's staging clone.

## Spec Change Log

## Review Triage Log

## Design Notes

The `/register` handler only checks the argument, queues nothing and returns; the clone and validation run as a tracked job that ends with one reply. A crash mid-job loses the registration with only `👀` showing, and the Owner sends `/register` again; the staging clone is deleted at the next registration. Project display name in copy is the Recipe `name` with its first letter upper-cased (`training` → `Training`).

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0

**Manual checks (if no CLI):**
- With a scratch `ANTIPOD_HOME` and a second bot: `/register` of a repo with a valid Recipe binds the group; a Recipe with a 20-character `token:` value gets the loud failure with its line.
