---
title: 'Sprint Change Proposal: Draft card has no number; Discard copy; inbox fetch interval'
date: '2026-11-17'
trigger_story: '1-8-intake-drafts-from-text-and-the-inbox'
scope: 'minor'
status: 'approved'
approved: '2026-11-17'
mode: 'batch'
---

# Sprint Change Proposal: Draft card has no number; Discard copy; inbox fetch interval

## 1. Issue Summary

While planning story 1-8 (`docs/implementation-artifacts/spec-1-8-intake-drafts-from-text-and-the-inbox.md`, Owner decisions 2026-11-16), we found three problems in the planning docs.

1. **The Draft card shows a number the Task doesn't have yet.**
   - DESIGN.md `draft-card.titlePattern` is `<b>#${task-id} · ${task-title}</b> · draft`.
   - EXPERIENCE.md Flow 1 shows `#12 Rest timer after each set` on a Draft card.
   - But SPEC CAP-9, spine AD-5 and spine AD-16 all assign the per-Project Task number at approval, so a draft has no number to show.
   - **Owner decision:** follow the spine.
2. **There is no copy for Discard and Undo.** EXPERIENCE.md says only that Discard "can be undone from the edited card for 1 min".
   - **Owner decision:** while the undo window is open, the card reads `Discarded · undo within 1 min` with a single `Undo` button.
   - When the window expires, the card reads `Discarded` and has no buttons.
3. **There is no fetch cadence.** Spine AD-5 says inbox detection runs "after every fetch", but no doc says when a fetch happens, and `config-defaults.md` has no key for it.
   - **Owner decision:** add a new key `git.fetch_interval_ms` with default 60000.
   - Each Project is fetched at boot and then on that interval.

**Evidence:**
- DESIGN.md:51 and :140.
- EXPERIENCE.md:89, :188 and :190.
- ARCHITECTURE-SPINE.md:173 (AD-5).
- SPEC.md CAP-9.
- config-defaults.md:5-19.

## 2. Impact Analysis

**Epic impact.** Epic 1 continues as planned. No epic is added, removed or resequenced.

**Story impact.**
- 1-8 (`ready-for-dev`) already specifies all three decisions. It can be implemented without contradicting the docs.
- 1-14 (Interpretation cards) and 1-17 (Parking Lot promotion) produce Draft cards and inherit the unnumbered title. Their story text is unchanged.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| DESIGN.md | `components.draft-card` | Title without a number; add an approved title |
| DESIGN.md | Draft card blocks | Add a state line for Queued and Discarded |
| EXPERIENCE.md | Component Patterns, Draft card | Discard and Undo copy |
| EXPERIENCE.md | State Patterns table | Add a Discarded row |
| EXPERIENCE.md | Flow 1, steps 3 and 5 | No number on the draft; the number appears on approval |
| config-defaults.md | Limits table | Add `git.fetch_interval_ms` |
| ARCHITECTURE-SPINE.md | AD-5 inbox bullet | Name the fetch cadence |
| epic-1-context.md | Git bullet; Draft card bullet | Same wording |

The PRD, SPEC.md, `stories.yaml` and the glossary need no change: SPEC already assigns the number at approval and leaves fetch timing open. MVP scope is unaffected.

**Technical impact.** None beyond the 1-8 code: a new config key in `src/app/config.ts` and the title of the Draft card template. No migration or deployment change.

## 3. Recommended Approach

**Direct adjustment.** These are wording edits to four documents plus the cached epic context.
- **Effort:** small.
- **Risk:** low.
- **Timeline:** no impact.

Rollback and an MVP review were considered and rejected. No code exists yet for these parts.

## 4. Detailed Change Proposals

### 4.1 DESIGN.md, `components.draft-card`

OLD:
```yaml
  draft-card:
    titlePattern: '<b>#${task-id} · ${task-title}</b> · draft'
```
NEW:
```yaml
  draft-card:
    titlePattern: '<b>${task-title}</b> · draft'
    approvedTitlePattern: '<b>#${task-id} · ${task-title}</b>'
```
Rationale: a draft has no Task number until approval (CAP-9, AD-16).

### 4.2 DESIGN.md, Draft card blocks

OLD:
> 1. Title `{components.draft-card.titlePattern}`.
> …
> 6. Buttons, one row per question: quick answers. Then one row per infeasible criterion: `Use proposal` · `Drop AC${n}`. Last row: `Approve` (once everything is resolved) · `Discard`.

NEW:
> 1. Title `{components.draft-card.titlePattern}`; after approval `{components.draft-card.approvedTitlePattern}`.
> …
> 6. Buttons, one row per question: quick answers. Then one row per infeasible criterion: `Use proposal` · `Drop AC${n}`. Last row: `Approve` (once everything is resolved) · `Discard`.
> 7. After a tap that closes the draft, the buttons are replaced by a state line:
>    - after Approve: `⏳ Queued · starts next`, with no buttons;
>    - after Discard: `Discarded · undo within 1 min`, with a single `Undo` button;
>    - when the undo window expires: `Discarded`, with no buttons.

### 4.3 EXPERIENCE.md, Component Patterns → Draft card (line 89)

OLD:
> … **Discard** needs no confirmation and can be undone from the edited card for 1 min. `[ASSUMPTION]`

NEW:
> … **Discard** needs no confirmation. The edited card reads `Discarded · undo within 1 min` with a single `Undo` button, and becomes `Discarded` with no buttons when the minute is up. `[ASSUMPTION]` The card carries no Task number until it is approved, because the number is assigned at approval.

### 4.4 EXPERIENCE.md, State Patterns table (after line 114)

ADD row:
> | Draft discarded | Draft card | `Discarded · undo within 1 min` with `Undo`; after 1 min `Discarded`, no buttons. |

### 4.5 EXPERIENCE.md, Flow 1 steps 3 and 5

OLD:
> 3. A Draft card arrives (silent): `#12 Rest timer after each set` with 3 criteria and Evidence kinds. …
> 5. **Climax:** they tap **Approve**. The toast reads `Queued.` and the card shows `⏳ Queued · starts next`. …

NEW:
> 3. A Draft card arrives (silent): `Rest timer after each set · draft` with 3 criteria and Evidence kinds. …
> 5. **Climax:** they tap **Approve**. The toast reads `Queued.` and the card is edited to `#12 · Rest timer after each set` with `⏳ Queued · starts next`. …

### 4.6 config-defaults.md, Limits table (after `telegram.stale_after_ms`)

ADD row:
> | `git.fetch_interval_ms` | 60000 | Each Project is fetched at boot and then on this interval; the inbox is scanned after every fetch |

### 4.7 ARCHITECTURE-SPINE.md, AD-5 inbox bullet (line 173)

OLD:
> … Detection after every fetch is keyed by `(path, blob_sha)` in `contract_sources`; …

NEW:
> … Each Project is fetched at boot and every `git.fetch_interval_ms`; detection after every fetch is keyed by `(path, blob_sha)` in `contract_sources`; …

### 4.8 epic-1-context.md

Make the same changes in the cached context:
- **Git bullet:** add the fetch cadence.
- **Draft card bullet:** add that the title has no number before approval, and add the Discard copy.

## 5. Implementation Handoff

**Scope: minor.** The doc edits above are applied directly as part of this proposal. Story 1-8 then implements its spec unchanged; it already carries these decisions.

**Success criteria:**
- After the edits, no planning doc shows a Task number on an unapproved draft.
- `git.fetch_interval_ms` appears in `config-defaults.md` and in `src/app/config.ts` once 1-8 lands.
