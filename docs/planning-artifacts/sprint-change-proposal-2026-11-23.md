---
title: 'Sprint Change Proposal: Card buttons act only while they can, and a stale tap says where the Task is'
date: '2026-11-23'
trigger_story: '1-9-implement-validate-and-triage-loop'
scope: 'minor'
status: 'approved'
approved: '2026-11-23'
mode: 'batch'
---

# Sprint Change Proposal: Card buttons act only while they can, and a stale tap says where the Task is

## 1. Issue Summary

**Trigger.** The 1-9 follow-up review (`spec-1-9-stuck-by-cause.md`, 2026-11-22) deferred one item: a stale Stuck card tap answers with the Review wording `This Review was replaced by a newer one.`. The Owner asked to fix the whole stale-tap experience, not one case. A look at the code found three problems.

**Problem 1: the Stuck card closes on only two of its four exits.**

| Exit from `stuck` | The card today |
|---|---|
| `budget_raised` (`Raise budget +2`) | Closed: `⏳ Budget +2 · resuming` |
| `cancel` (card or elsewhere) | Closed: `Cancelled` |
| `pause` (Owner or Project pause) | Keeps its buttons |
| `amended` (reply via Intake, 1-14) | Keeps its buttons (deferred to 1-14) |

After a pause or an amendment, the card still offers buttons that cannot act.

**Problem 2: Stuck card buttons are bound to the state `stuck`, not to the card.** On `resume`, the Task re-enters `stuck` and a new loud Stuck card is sent. The old card's buttons become valid again, so one problem has two live cards. A tap on the old card raises the budget and closes the new card, while the old card keeps its buttons.

**Problem 3: one fixed answer for every stale tap.** `STALE_TAP_TOAST` (`This Review was replaced by a newer one.`) answers stale taps on Review, Draft and Stuck cards. It is right only for Review cards. It does not say what happened, and its follow-up reply goes to "the Task's latest card", which can be the card just tapped.

**Evidence:**
- `src/core/coordinator/transitions.ts:142-147`: only `budget_raised` and `cancel` close the card.
- `src/app/stuck.ts`: commands bound to `states: ['stuck']`.
- `src/adapters/telegram/poller.ts:15`, `:353-362` (`#staleTap`). `src/app/intake.ts:342` (Draft card).
- EXPERIENCE.md:118 and :142. DESIGN.md:152-157. ARCHITECTURE-SPINE.md:223 (AD-10). epic-1-context.md:148.
- `deferred-work.md`: the Stuck card toast entry (1-9 follow-up) and "close the Stuck card on `amended`" (1-9).

**Owner decisions (2026-11-23).**
1. Every exit from `stuck` closes the Stuck card with a state line. On pause it reads `⏸ Paused by you` with no buttons; `resume` sends a fresh loud Stuck card (as today). There is one live Stuck card per stuck visit.
2. A tap that cannot act on a Stuck or Draft card answers with the Task's current state, and the tapped card is redrawn to match. Review cards keep `This Review was replaced by a newer one.`
3. The Stuck card still says why the Task is stuck and offers retry (`Raise budget +2`) and `Cancel Task`, with `Cancel Task` alone when stuck on dependencies (Sprint Change Proposal 2026-11-22).

## 2. Impact Analysis

**Epic impact.** None. Epic 1 continues as planned.

**Story impact.**
- **1-9 (`review`):** a follow-up change (section 5). Its frozen spec is not edited. This proposal supersedes its line "a tap on a card that is no longer stuck gets the stale toast".
- **1-8 (Draft card, done):** the Draft card's stale answer changes. Nothing else on the card changes.
- **1-14 (Owner messages):** the `amended` close is done here, so its deferral is resolved. 1-14 still owns how replies reach Intake.
- **1-11 and later (Review card):** no change; the "replaced" toast stays.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| DESIGN.md | Stuck card (lines 152-157) | New item: the closed state lines, one per exit |
| EXPERIENCE.md | State Patterns → Stale button (line 142) | Review keeps "replaced"; other cards answer with the Task's state and are redrawn |
| ARCHITECTURE-SPINE.md | AD-10 callbacks (line 223) | Stuck card buttons act only on the newest Stuck card; stale-tap answer by card kind |
| ARCHITECTURE-SPINE.md | AD-3 generic events (line 105) | Every exit from `stuck` closes the Stuck card |
| epic-1-context.md | After a tap (lines 148, 150) | Same (cached context) |

**No change needed:**
- SPEC.md:134 quotes the Review text for a superseded Review card. It stays true.
- SOLUTION-DESIGN.md:95 explains the "replaced" toast for old Review cards. It is a reasons document, and the spine wins over it.
- PRD, glossary.md and config-defaults.md are untouched. Review files and `.memlog.md` files are history.

**Technical impact.** It needs no migration and no config or deployment change:
- `transitions.ts`: leaving `stuck` by `pause` or `amended` also emits the Stuck card close, with `closed: 'paused'` or `'amended'`.
- `stuck-card.ts`: two more state lines.
- Stuck card commands act only when the tapped message is the Task's newest Stuck card (`telegram_messages`), besides the state check.
- A callback command can name how to answer its stale tap. The poller uses that instead of `STALE_TAP_TOAST`. Review commands keep the current behaviour. Stuck and Draft commands answer `#${id} is ${state} now.` and redraw the tapped card. A Draft without a number uses `This draft is ${state} now.`
- Tests for each exit, the old-card tap after `resume`, and the stale answers of the three card kinds.

## 3. Recommended Approach

**Direct adjustment.** Apply the doc edits below now. Then a follow-up change to story 1-9 implements them.
- **Effort:** small to medium; one build.
- **Risk:** low. No new state, event or arrow. Cards lose buttons that could not act, and stale answers become specific.
- **Timeline:** none. It lands before 1-10.

## 4. Detailed Change Proposals

### UX

**DESIGN.md, Stuck card: new item 6 (after line 157)**

NEW:
> 6. When the Task leaves `stuck`, the buttons and footer are replaced by a state line: `⏳ Budget +2 · resuming`, `Cancelled`, `⏸ Paused by you` or `⏳ Amended · resuming`. Only the newest Stuck card of a Task has buttons; `resume` sends a new one.

**EXPERIENCE.md, State Patterns → Stale button (line 142)**

OLD:
> | Stale button | Toast | Tapping a button on an outdated card: `This Review was replaced by a newer one.` The bot then replies to the newer card. |

NEW:
> | Stale button | Toast | Tapping a button on an outdated Review card: `This Review was replaced by a newer one.` The bot then replies to the newer card. On any other card, a button that can no longer act answers with where the Task is now, `#${id} is ${state} now.` (`This draft is ${state} now.` before approval), and the tapped card is edited to its current state. |

### Architecture

**ARCHITECTURE-SPINE.md, AD-10 callbacks (line 223)**

OLD:
> … a stale tap gets the "replaced" toast and a reply pointing to the current card.

NEW:
> … a stale tap on a Review card gets the "replaced" toast and a reply pointing to the current card. A Stuck card's commands are valid only on the Task's newest Stuck card. A stale tap on any other card gets a toast naming the Task's current state, and the tapped card is re-rendered.

**ARCHITECTURE-SPINE.md, AD-3 generic events (line 105), appended**

NEW:
> Every exit from `stuck` (`budget_raised`, `cancel`, `pause`, `amended`) closes the Stuck card with a state line; `resume` back into `stuck` sends a new one.

### Implementation artifacts

**epic-1-context.md (lines 148 and 150)**

OLD:
> - A tap on an outdated card gets `This Review was replaced by a newer one.`

NEW:
> - A tap on an outdated Review card gets `This Review was replaced by a newer one.` On other cards, a tap that can no longer act gets `#${id} is ${state} now.` and the card is redrawn.

OLD (end of line 150):
> … After a blocked Implementer, Triage's `park` ends at the Stuck card.

NEW:
> … After a blocked Implementer, Triage's `park` ends at the Stuck card. Every exit from `stuck` closes the card (`⏸ Paused by you` on pause); only the newest Stuck card has buttons.

## 5. Implementation Handoff

**Scope: minor.** The Developer implements it directly, as a follow-up change to story 1-9 through `bmad-build`.

**Success criteria:**
- Each exit from `stuck` closes the Stuck card with its state line: raise, cancel, pause (`⏸ Paused by you`) and amend.
- After pause and resume, the old card has no buttons and the new card has them. A tap on the old card (if its edit failed) acts on nothing.
- A Stuck or Draft card tap that cannot act answers `#${id} is ${state} now.` (or the draft form) and redraws the tapped card. This covers a tap after the state changed and a Coordinator refusal.
- Review card stale taps still answer `This Review was replaced by a newer one.` with the reply to the current card.
- The two matching `deferred-work.md` entries (stale toast; close on `amended`) are marked resolved by this proposal.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` all exit 0.
