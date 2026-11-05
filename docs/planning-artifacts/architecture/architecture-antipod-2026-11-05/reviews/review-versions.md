# Review — versions and reality-check lens

**Artifact:** `ARCHITECTURE-SPINE.md` (Antipode, 2026-11-05)
**Lens:** every committed decision verified against the live web or this machine, not asserted from training data.
**Date:** 2026-11-05
**Method:** WebSearch/WebFetch against official docs (code.claude.com, core.telegram.org, git-scm.com), `npm view`, `brew info`, local binaries, and one throwaway git experiment in the scratchpad.

Items the author already verified today (Claude Code 2.1.318 and its headless flags, Node 24.13, grammY 1.46.0, better-sqlite3 13.0.3, sharp 0.35.5, zod 4.6.7, Podman 5.5.2 installed, Telegram 50 MB / 64-byte / 2 GB limits, subscription-mode `claude -p`) were not redone except where a check below touched them incidentally.

## Verdict

The Stack table is mostly current, and every Claude Code flag the spine names exists today with the semantics the spine assumes. Two things fail the reality check and one is stale: AD-5's **`--mirror` clone cannot be fetched once a Task branch is checked out in a worktree** (reproduced locally — this breaks AD-13's rebase path on the first Task), **TypeScript is at 7.0.2, not 5.x**, and AD-12's OAuth usage endpoint is undocumented and unofficial.

## Findings

### F1 — HIGH — AD-5: a `--mirror` clone refuses `git fetch` once a Task branch is checked out in a worktree

**Claim:** "Each Project has one bare mirror at `~/.antipod/data/repos/<project>.git` and each Task one worktree … on Branch `antipod/<task_no>-<slug>`"; AD-13 then "rebases the worktree on `origin/main`" and "merges by fast-forward through the mirror, then pushes".

**Reality (reproduced with git 2.47.0 in the scratchpad):**

1. `git clone --mirror` sets `remote.origin.mirror=true` and fetch refspec `+refs/*:refs/*`. From a worktree, `git push origin antipod/1-x` fails with `fatal: --mirror can't be combined with refspecs`; only a bare `git push` works, and that is a mirror push, which force-pushes every local ref and deletes remote refs that do not exist locally.
2. After the Task branch exists on origin, every `git fetch` on the mirror fails: `fatal: refusing to fetch into branch 'refs/heads/antipod/1-x' checked out at '<worktree>'`. The fetch aborts as a whole, so `main` stops updating too. An explicit `git fetch origin '+refs/heads/*:refs/heads/*'` fails the same way.
3. A mirror has no `refs/remotes/origin/main`; `origin/main` as written in AD-13 does not resolve. The upstream `main` lives at `refs/heads/main` and is force-updated by fetch.

The Git mailing list confirms this is by design (worktree-checked-out branches are protected from fetch updates; maintainers advise against building worktrees directly on mirror clones). `git grep` also misbehaves in worktrees of a bare repo unless `extensions.worktreeConfig` + per-worktree `core.bare=false` is set (reproduced: `git grep` works here on 2.47 but `rev-parse --is-bare-repository` reports `false` only in the worktree; older gits fail outright).

**Corrected fact:** worktrees from a bare object store are a sound pattern, but the store must be a plain bare clone (`git clone --bare`, or `git init --bare` + `git remote add`) with the normal refspec `+refs/heads/*:refs/remotes/origin/*`, so fetch writes `refs/remotes/origin/*` and never touches a checked-out `refs/heads/antipod/*`. Then `origin/main` exists for the rebase, Task branches push with `git push origin antipod/<n>-<slug>`, and the fast-forward of `main` is `git push origin <sha>:refs/heads/main` from the mirror (or `git branch -f main` + push). Replace the word "mirror" in AD-5, AD-13, the source tree and the container view.

### F2 — MEDIUM — Stack: TypeScript "5.x" is two majors stale

**Reality (`npm view typescript`):** `latest` is **7.0.2** (2026-07-08, the Go-native compiler); 6.0.x shipped 2026-03-23 as the last JS-based line; 5.9.3 (2025-09-30) is the last 5.x. Dist-tags: `rc: 7.0.1-rc`, `beta: 7.1.0-beta`.

**Corrected fact:** pin TypeScript 7.x (fall back to 6.0.x if a toolchain piece is not yet 7-ready). "5.x" was not confirmed against anything.

### F3 — MEDIUM — AD-12: "the OAuth usage endpoint Claude Code itself calls" is undocumented and unofficial

Web search finds only third-party monitors (`claude-usage`, `ccusage`, `claude-usage-limits`) reverse-engineering `GET /api/oauth/usage` with an `anthropic-beta: oauth-2025-04-20` header and a token read from the macOS Keychain. No Anthropic documentation describes it, the response shape is reported to vary by plan, polling is rate-limited (~5 min), and it can change without notice. The spine's seam (`WindowReader` with a local fallback) is the right shape, but the sentence reads as if the endpoint were a known API. Mark it `[ASSUMPTION]` and keep the spike in Deferred (already listed as PRD OQ4).

### F4 — LOW — Stack: Podman "6.0 current" is now 6.1.4; Node 24 has left Active LTS

- `brew info podman` today: **6.1.4** stable (installed 5.5.2). Podman 6.0 (2026-06-24) changed the macOS machine default provider to **libkrun** for new VMs and dropped Intel Macs; existing VMs keep their provider. Relevant for the VM-host move, not the MVP.
- Node 24 "Krypton": Active LTS ended 2026-10-20 (endoflife.date); it is in Maintenance until 2028-04-30, and Node 26 is the current Active LTS. "24 LTS" is still true but it is the maintenance line now. Fine for the MVP; note it.

### F5 — LOW — AD-4: zod → `--json-schema` needs the draft-07 target

Verified on code.claude.com/docs/en/agent-sdk/structured-outputs: Claude Code validates schemas as **JSON Schema draft-07** and rejects schemas declaring a newer dialect; **zod 4 emits draft 2020-12 by default**, so the Role schemas must be exported with `z.toJSONSchema(schema, { target: "draft-7" })`. The spine says "one `zod` schema per Role" without this; it is a one-line implementation note but it is the kind of default that bites on the first run.

Also verified: the structured result arrives in the `result` message's `structured_output` field; a `success` result can lack it (treat as failure); the stream carries `StructuredOutput` tool calls that should be filtered from transcripts.

### F6 — INFO — Telegram `setMessageReaction` and `👀`: confirmed

core.telegram.org/bots/api (now **Bot API 10.3**, 2026-08-24): `setMessageReaction` exists for bots, takes `chat_id` of "the target bot, supergroup or channel", bots may set one reaction per message, cannot react to some service messages, cannot use paid reactions. `👀` is in the `ReactionTypeEmoji` allowed list. grammY exposes it as `ctx.react("👀")` / `api.setMessageReaction`. Group caveat: the chat's admin may restrict available reactions; receiving `message_reaction` updates (not needed here) requires admin. The AD-10 `👀` acknowledgement is sound for a private chat and for a group whose reaction set allows it.

### F7 — INFO — Claude Code flags: all confirmed on code.claude.com/docs/en/cli-reference today

`--max-turns` (print mode only, no default limit), `--verbose` (every documented `stream-json` example pairs it with `--verbose`; the headless page says "Use `--output-format stream-json` with `--verbose`"), `--append-system-prompt-file`, `--json-schema`, `--permission-prompts none` (requires v2.1.259+; stream-json reports denials as `permission_denied` and in `permission_denials`), `--allowedTools`, `--permission-mode` (`default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual`), `--mcp-config`, `--bare` (never reads OAuth credentials or the Keychain; needs `ANTHROPIC_API_KEY` — matches AD-4).

Two live defaults worth folding into AD-4 since they are current behaviour, not training-data assumptions:
- Since v2.1.302 a `-p` run with no `--permission-mode` starts in **Manual** mode (every prompting call denied). The spine always passes `--permission-mode`, so fine, but the Role Config must never omit it.
- **SIGTERM** exits with 143 and records no `result`; **SIGINT** ends the turn and yields a `result`. AD-4's "SIGINT, then SIGTERM after 30 s" is the right order; the UsageMeter must tolerate a missing `result` after the SIGTERM path.
- The docs note `--bare` "will become the default for `-p` in a future release". Subscription mode then needs an explicit opt-out; track with "track latest".

### F8 — INFO — Other Stack rows checked

| Row | Spine | Verified today | Status |
| --- | --- | --- | --- |
| pino | 10 | `npm view pino version` → **10.4.0** | OK |
| grammY | 1.46 | 1.46.0, depends on `@grammyjs/types` 5.0.0 | OK |
| better-sqlite3 | 13 | 13.0.3; Node 24 prebuilds since v12 | OK |
| zod | 4.6 | 4.6.7 | OK (see F5) |
| sharp | 0.35 | 0.35.5 | OK |
| ulid (implied by AD-16) | — | `ulid` 3.0.2 on npm | OK |
| ffmpeg + whisper.cpp | "Homebrew current (not yet installed)" | `brew`: ffmpeg 9.0.2, formula is **`whisper-cpp`** 1.9.5 (binary `whisper-cli`); neither installed | OK, name the formula |
| git | 2.4x | installed 2.47.0; brew/upstream latest **2.56.0** | OK, "2.47 installed; 2.56 current" is more precise |
| launchd | macOS 27 | `sw_vers` → 27.2 | OK |
| Recipe seed image `ghcr.io/cirruslabs/android-sdk:34` | placeholder | registry answers (405 on anonymous HEAD); explicitly a placeholder | OK |

No named tool or flag in the spine was found not to exist.

## Summary of corrections to apply

1. AD-5/AD-13/diagrams: replace `--mirror` with a plain bare clone + `refs/remotes/origin/*` refspec; `origin/main` then resolves and fetch no longer aborts on checked-out Task branches.
2. Stack: TypeScript **7.x** (or 6.0.x), Podman "6.1 current", git "2.47 installed / 2.56 current", whisper.cpp as Homebrew `whisper-cpp`, Node 24 "Maintenance LTS".
3. AD-12: tag the OAuth usage endpoint `[ASSUMPTION]`.
4. AD-4: note draft-07 export from zod, Manual-mode default under `-p`, and no `result` after SIGTERM.

## Sources

- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/agent-sdk/structured-outputs
- https://core.telegram.org/bots/api (Bot API 10.3)
- https://grammy.dev/guide/reactions
- https://git-scm.com/docs/git-worktree
- https://lore.kernel.org/all/xmqqo73zg94t.fsf@gitster.g/ (fetch into checked-out branch), https://public-inbox.org/git/aN7IcSmHCM-BBLjH@kitsune.suse.cz/
- https://registry.npmjs.com/pino, `npm view typescript time`
- https://endoflife.date/nodejs
- https://linuxiac.com/podman-6-0-lands-with-breaking-changes-amd-gpus-support/
- https://github.com/tyrelh/claude-usage, https://pypi.org/project/claude-usage-limits/ (unofficial usage endpoint)
- Local: `git --version`, `sw_vers`, `brew info`, `npm view`, scratchpad experiment `gt/` (mirror + worktree fetch)
