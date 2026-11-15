---
title: 'Sprint Change Proposal: Stage permissions come only from the Role'
date: '2026-11-15'
trigger_story: '1-7-claude-cli-agentrunner-and-role-configs'
scope: 'minor'
status: 'approved'
approved: '2026-11-15'
mode: 'batch'
---

# Sprint Change Proposal: Stage permissions come only from the Role

## 1. Issue Summary

While planning story 1-7 (`docs/implementation-artifacts/spec-1-7-claude-cli-agentrunner-and-role-configs.md`, Open Question 1), we found that the flag set fixed by spine AD-4 can't enforce the write-deny that SPEC CAP-20 and AD-6 require:

- **Allow-only rules.** AD-4 passes permissions only as `--allowedTools`. An allow list can't express "edit anything in the worktree except `.antipod/`", so a Stage can write the Task Contract projection and `.antipod/roles/` on its Branch. SPEC.md:106 says shipped Role permissions deny writes to `.antipod/`.
- **Settings files outside our control.** `claude` 2.1.325 merges permission rules, hooks and env from three files:
  - `~/.claude/settings.json`, the Owner's personal settings;
  - `<cwd>/.claude/settings.json`;
  - `<cwd>/.claude/settings.local.json`.

  The two `<cwd>` files sit in the Task worktree, which the Stage can write. So a Stage can widen the permissions of every later Stage in the same worktree, and the Owner's allow rules and hooks apply inside every Stage. AD-4 says "No other flag set exists", so the adapter can't switch these sources off.

**Owner decision (2026-11-15):** option (c). Pass the resolved `permissions.json` with `--settings`, so allow and deny rules travel in one Claude Code settings file and replace `--allowedTools`. Also pass `--setting-sources` so that no user, project or local settings file loads. In the same review the Owner added `--strict-mcp-config`: the Owner's MCP servers live in `~/.claude.json`, outside the settings files, so without it they could load into a Stage alongside the Role's `mcp.json`.

**Evidence:**
- ARCHITECTURE-SPINE.md:161 (AD-4 flag set), :181 (AD-6 deny list), :253 (AD-15 Role files).
- SPEC.md:106.
- `claude --help` 2.1.325: `--settings <file-or-json>` loads additional settings, and `--setting-sources <sources>` is a comma-separated list of `user`, `project` and `local`.

## 2. Impact Analysis

**Epic impact.** Epic 1 continues as planned. No epic is added, removed or resequenced.

**Story impact.**
- 1-7 (backlog, in planning) is unblocked. Its spec takes the amended flag set, and shipped `permissions.json` files become Claude Code settings files.
- 1-8, 1-9 and 1-10 launch Stages through the same adapter and inherit the change. Their story text doesn't change.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-4 Rule, launch bullet | `--settings` replaces `--allowedTools`; add `--setting-sources` and `--strict-mcp-config` |
| ARCHITECTURE-SPINE.md | AD-6 Rule | permission policy comes only from the Role; add the `.antipod/` write deny |
| ARCHITECTURE-SPINE.md | AD-15 Rule | `permissions.json` is a Claude Code settings file |
| epic-1-context.md | Stage launch bullet | same wording as the spine |

No change is needed to the PRD, SPEC.md, `stories.yaml`, the glossary or the UX documents. SPEC already requires the deny rules, and this change only makes them enforceable. MVP scope is unaffected.

**Technical impact.** None beyond the 1-7 code: the adapter's argv and the shipped `permissions.json` format. There is no migration, config or deployment change.

## 3. Recommended Approach

**Direct adjustment.** Three spine sentences change, and the cached epic context is updated to match.
- **Effort:** small.
- **Risk:** low.
- **Timeline:** no impact.

The fake `claude` can only check argv. Whether real `claude` actually applies the flags gets one manual check with a scratch `ANTIPOD_HOME`, recorded in the 1-7 spec's Verification.

## 4. Detailed Change Proposals

### 4.1 ARCHITECTURE-SPINE.md, AD-4 Rule, launch bullet

OLD:
> … `--permission-prompts none`; `--allowedTools`, `--permission-mode`, `--mcp-config`, `--append-system-prompt-file`, `--max-turns` from the resolved Role Config. Subscription mode uses the Owner's login and no `--bare`; …

NEW:
> … `--permission-prompts none`; `--settings` = the resolved `permissions.json` and `--setting-sources` set so that no user, project or local settings file loads; `--strict-mcp-config` with `--mcp-config` = the resolved `mcp.json`, so no other MCP server loads; `--permission-mode`, `--append-system-prompt-file`, `--max-turns` from the resolved Role Config. Subscription mode uses the Owner's login and no `--bare`; …

Rationale: Owner decision (c), plus `--strict-mcp-config` (Owner, same review). One file carries the allow and deny rules. The Owner's settings and the worktree's `.claude/` files, which a Stage can write, never shape a Stage's permissions.

### 4.2 ARCHITECTURE-SPINE.md, AD-6 Rule

OLD:
> … Direct invocation of a Project's build, test or emulator tools by a Stage is denied by every shipped Role `permissions.json`, as are reads under `$ANTIPOD_HOME` and other Tasks' worktrees. MVP isolation (NFR-4) is therefore Claude Code permission policy plus a secret-free environment, not OS enforcement. …

NEW:
> … Direct invocation of a Project's build, test or emulator tools by a Stage is denied by every shipped Role `permissions.json`, as are writes under `.antipod/` and `$ANTIPOD_HOME`, and reads under `$ANTIPOD_HOME` and other Tasks' worktrees. A Stage's permission policy is that file alone and its MCP servers are the Role's `mcp.json` alone (AD-4); settings and MCP configuration in the worktree or the Owner's home never apply. MVP isolation (NFR-4) is therefore Claude Code permission policy plus a secret-free environment, not OS enforcement. …

Rationale: aligns AD-6 with SPEC.md:106, which requires the `.antipod/` write deny, and states the single source of policy.

### 4.3 ARCHITECTURE-SPINE.md, AD-15 Rule

OLD:
> … A Role is a directory with `prompt.md`, `mcp.json`, `permissions.json`, `role.yaml` (`timeout`, `retries`, `max_turns`, `output_schema`); …

NEW:
> … A Role is a directory with `prompt.md`, `mcp.json`, `permissions.json` (a Claude Code settings file holding `permissions.allow` and `permissions.deny`), `role.yaml` (`timeout`, `retries`, `max_turns`, `output_schema`); …

Rationale: the file is now passed to `claude` as-is, so its format is Claude Code's settings format.

### 4.4 epic-1-context.md, Stage launch bullet

OLD:
> - Its `stream-json` is saved to `data/stages/<stage_id>.jsonl`. `--json-schema` comes from the Role's zod schema, and the other flags come only from the resolved Role Config.

NEW:
> - Its `stream-json` is saved to `data/stages/<stage_id>.jsonl`. `--json-schema` comes from the Role's zod schema, and the other flags come only from the resolved Role Config. Permissions are the Role's `permissions.json` passed with `--settings`; `--setting-sources` stops user, project and local settings files from loading, and `--strict-mcp-config` limits MCP servers to the Role's `mcp.json`.

Rationale: the cached context must match the spine.

## 5. Implementation Handoff

**Scope: minor.** The Developer:
1. applies 4.1–4.4 and commits them;
2. resolves Q1 in the 1-7 spec to the amended flag set;
3. resumes the 1-7 build at the step-02 gates.

**Success criteria:**
- AD-4, AD-6 and AD-15 state the Owner's decision.
- `epic-1-context.md` matches the spine.
- No other planning document changes.
