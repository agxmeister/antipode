---
title: 'Sprint Change Proposal: Owner-facing words for Task states'
date: '2026-11-24'
trigger_story: '1-9-implement-validate-and-triage-loop'
scope: 'minor'
status: 'approved'
approved: '2026-11-24'
mode: 'batch'
---

# Sprint Change Proposal: Owner-facing words for Task states

## 1. Issue Summary

**Trigger.** The review of `spec-1-9-stale-taps.md` (2026-11-23) deferred one item to the Owner. The stale-tap toast `#${id} is ${state} now.` prints the internal state name with `_` as spaces. Some states read badly. A tap while Intake revises a draft answers `This draft is draft now.`, and `accept_pending` gives `#12 is accept pending now.`.

**The wider gap.** The UX docs use `${state}` in three places, and none of them says what words it stands for:
- EXPERIENCE.md:142, the stale-tap toast (built in 1-9);
- EXPERIENCE.md:138, `#${id} is ${state} — nothing to peek.` (`/peek`, 1-14);
- DESIGN.md:161, the status list line `${glyph} #${id} ${title} · ${state}` (`/status`, 1-15).

**Owner decision (2026-11-24).** One table of Owner-facing state words in EXPERIENCE.md → Voice and Tone, used everywhere a Task's state reaches the Owner. The words are plain phrases written to read in a sentence (`#12 is being tested now.`).

**Two adjustments to the chosen table, approved by the Owner with the proposal:**
- `triage` → `deciding the next step` instead of `in triage`. Voice and Tone says: "Never mention Stages, Roles or the Coordinator unless the Owner asks". Triage is a Role.
- `in_review` → `ready for review` instead of `waiting for your review`. Voice and Tone's own example is `#12 Rest timer · ready for review`.

**Evidence:**
- EXPERIENCE.md:62-82 (Voice and Tone), :138, :142.
- DESIGN.md:161.
- `src/adapters/telegram/poller.ts` `stateToast`.
- `deferred-work.md`: the raw state names entry (spec-1-9-stale-taps).

## 2. Impact Analysis

**Epic impact.** None.

**Story impact.**
- **1-9 (`review`):** `stateToast` uses the table. This is a small follow-up change.
- **1-14 (`/peek`) and 1-15 (`/status`):** they will use the same table when built. Nothing changes in their scope.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| EXPERIENCE.md | Voice and Tone (after the Rules, line 82) | New "State words" table |
| EXPERIENCE.md | State Patterns, Peek (line 138) and Stale button (line 142) | `${state}` names the table |
| DESIGN.md | Status list (line 161) | `${state}` names the table |
| epic-1-context.md | After a tap (line 148) | Same (cached context) |

**No change needed:**
- SPEC.md, the PRD and the spine name no state wording.
- glossary.md keeps the internal state names, which code and docs still use.

**Technical impact.** It needs no migration and no config change:
- A `STATE_WORDS` map from `TaskState` to the phrase, exhaustive so that a new state cannot be left out.
- `stateToast` uses it.
- Tests: every state has words, and the toast reads as a sentence.

## 3. Recommended Approach

**Direct adjustment.**
- **Effort:** small.
- **Risk:** low; copy only.
- **Timeline:** none.

## 4. Detailed Change Proposals

### UX

**EXPERIENCE.md, Voice and Tone: new subsection after the Rules (after line 82)**

NEW:
> **State words.** Wherever a Task's state reaches the Owner (`${state}` in this document and DESIGN.md: the stale-tap toast, the Peek reply, the status list), it is written as below, never as the internal name. Each phrase reads after "is": `#12 is being tested now.`
>
> | State | Words |
> |---|---|
> | `draft` | being revised |
> | `awaiting_approval` | waiting for your approval |
> | `discard_pending` | discarded · undo open |
> | `queued` | queued |
> | `waiting_on_dependencies` | waiting on dependencies |
> | `implementing` | being implemented |
> | `testing` | being tested |
> | `validating` | being validated |
> | `triage` | deciding the next step |
> | `evidencing` | collecting Evidence |
> | `verifying` | checking Evidence |
> | `in_review` | ready for review |
> | `accept_pending` | accepted · undo open |
> | `integrating` | being merged |
> | `merged` | merged, releasing |
> | `release_failed` | merged, release failed |
> | `released` | released |
> | `cancelled` | cancelled |
> | `stuck` | stuck |
> | `paused` | paused |

**EXPERIENCE.md, State Patterns (lines 138 and 142)**

Line 138, OLD:
> | Peek on non-running Task | Reply | `#${id} is ${state} — nothing to peek.` |

Line 138, NEW:
> | Peek on non-running Task | Reply | `#${id} is ${state} — nothing to peek.` (`${state}` in State words.) |

Line 142: append to the cell:
> `${state}` is written as in Voice and Tone → State words.

**DESIGN.md, Status list (line 161)**

OLD:
> One line per Task: `${glyph} #${id} ${title} · ${state}`.

NEW:
> One line per Task: `${glyph} #${id} ${title} · ${state}`, with `${state}` in EXPERIENCE.md → State words.

### Implementation artifacts

**epic-1-context.md (line 148)**: append:
> `${state}` uses EXPERIENCE.md → State words (`#12 is being tested now.`).

## 5. Implementation Handoff

**Scope: minor.** The Developer implements it directly, as a follow-up change to story 1-9 through `bmad-build`.

**Success criteria:**
- The stale-tap toast uses the table for every state, e.g. `This draft is being revised now.` and `#12 is accepted · undo open now.`.
- The map covers every `TaskState`, and the type check enforces it.
- The matching `deferred-work.md` entry is marked resolved by this proposal.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` all exit 0.
