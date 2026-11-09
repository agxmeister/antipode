---
title: 'Sprint Change Proposal: effect replay and Review round'
date: '2026-11-09'
trigger_story: '1-2-coordinator-core'
scope: 'minor'
status: 'approved'
approved: '2026-11-09'
mode: 'batch'
---

# Sprint Change Proposal: effect replay and Review round

## 1. Issue Summary

Two Owner decisions came out of the story 1-2 walkthrough (2026-11-08/09). Review pass 1 had deferred both as findings #6 and #11 in `docs/implementation-artifacts/deferred-work.md`. Both are cases where the spine's literal wording disagrees with the rest of the design.

**#6, effect replay at boot.** AD-18 says recovery "re-executes every `effects` row not `done`", which includes `failed` rows. AD-3 describes `failed` as a final status, and retries already have their own homes: AD-4 for Stage launches and the `outbox` for Telegram sends. The story 1-2 matrix narrowed recovery to `pending` rows, and `src/core/coordinator/recovery.ts` follows the matrix. Replaying `failed` rows would re-fire effects that always fail, and old notices, on every boot.

**Owner decision:** replay `pending` rows only; `failed` is terminal.

**#11, what a Review round counts.** AD-16 says `tasks.review_round` "increments exactly on each entry to `in_review`", and AD-10 strips the previous card's keyboard "on every entry to `in_review`". Three arrows enter `in_review`, but only `evidence_verified` brings a new Review; `undone` and `resume` return to the same one. Counting every entry breaks rules that assume one round per Review:

- The Owner's live card loses its buttons after an Undo or a resume.
- A duplicate card has to be sent ("one card per Review round", EXPERIENCE.md).
- The new round has no Evidence, because Evidence is filed under the round it was produced for (AD-9, AD-16).
- `ANTIPOD_PRIOR` ("the previous Review round's Evidence") would point at an empty round.

**Owner decision:** a round counts Reviews delivered. It increments only on entry from `verifying`, and `undone` and `resume` keep the round.

**Evidence:** walkthrough of story 1-2; `src/core/coordinator/transitions.ts:126` (round bump on every entry); `src/core/coordinator/recovery.ts:67` (pending only).

## 2. Impact Analysis

**Epic impact.** Epic 1 can be completed as planned. No epic is added, removed or resequenced, and `sprint-status.yaml` needs no epic or story changes.

**Story impact.**

- 1-2 (done): a small code patch for #11 in `transitions.ts` plus tests. #6 needs no code change.
- Telegram and Review stories (1-4 and the Review/Accept story): they build `callbacks` and `retire_card` against the corrected rule. Their story text needs no change, because they inherit the rule from the spine.
- Evidence stories: `ANTIPOD_PRIOR` and the `r<round>` paths now stay aligned with no workaround.

**Artifact conflicts.**

| Artifact | Location | Change |
|---|---|---|
| ARCHITECTURE-SPINE.md | AD-18 Rule | `pending` rows only |
| ARCHITECTURE-SPINE.md | AD-16 Rule | round per Review delivered |
| ARCHITECTURE-SPINE.md | AD-10 Rule | keyboard retired when a new round begins |
| glossary.md | Review round | same definition as AD-16 |
| EXPERIENCE.md | Review card | state what the card shows after Undo |
| epic-1-context.md | Telegram line | same wording as AD-10 |

PRD, SPEC.md, `stories.yaml` and DESIGN.md need no change: none of them defines when a round increments or which effects replay. MVP scope is unaffected.

**Technical impact.** One condition in `enter()` and two or three new test cases. No migration, no config change, no deployment impact.

## 3. Recommended Approach

**Direct adjustment** (option 1): reword four spine and spec sentences, add one UX sentence, and patch story 1-2. A rollback is not justified, because the code is right except for one condition. An MVP review is not needed.

Effort is low and risk is low. Timeline impact: under an hour, done before story 1-3 starts.

## 4. Detailed Change Proposals

### Architecture

**A1. ARCHITECTURE-SPINE.md, AD-18 Rule**

OLD:
> then re-executes every `effects` row not `done` (a `start_stage` effect whose `stages` row is no longer `starting` is marked `done` without launching),

NEW:
> then re-executes every `pending` `effects` row (a `failed` row is terminal; a `start_stage` effect whose `stages` row is no longer `starting` is marked `done` without launching),

Rationale: decision #6. AD-3 already treats `failed` as final; AD-4 and the `outbox` own retries.

**A2. ARCHITECTURE-SPINE.md, AD-16 Rule**

OLD:
> `tasks.review_round` increments exactly on each entry to `in_review` and is the only round number;

NEW:
> `tasks.review_round` increments exactly once per Review delivered, on entry to `in_review` from `verifying`; a return to `in_review` through `undone` or `resume` keeps the round. It is the only round number;

Rationale: decision #11. This keeps "Evidence produced before that entry is stored under `review_round + 1`" true for every round.

**A3. ARCHITECTURE-SPINE.md, AD-10 Rule**

OLD:
> On every entry to `in_review` the previous round's card keyboard is stripped (effect `retire_card`);

NEW:
> When a new round begins, the previous round's card keyboard is stripped (effect `retire_card`); a return to `in_review` through `undone` or `resume` keeps the current card, which is edited back to its Review keyboard;

Rationale: decision #11. Callbacks stay valid on the same card because the round is unchanged. While the Task is paused or `accept_pending`, the state check refuses taps on that card.

### Spec

**S1. glossary.md, "Review round"**

OLD:
> **Review round** — increments on each entry to in review; the only round number. Callbacks are valid only for the current round.

NEW:
> **Review round** — increments once per Review delivered (entry to in review from verifying); a return through Undo or resume keeps the round. The only round number. Callbacks are valid only for the current round.

### UX

**U1. EXPERIENCE.md, Review card row**

OLD:
> On Accept, the keyboard becomes `[Undo]` for 10 s and is then removed.

NEW:
> On Accept, the keyboard becomes `[Undo]` for 10 s and is then removed. On Undo, the card is edited back to `Accept` · `Request changes`; it is still the same Review round.

Rationale: the UX did not say what the card shows after Undo; option B makes the answer "the same card, working again".

### Implementation artifacts

**I1. epic-1-context.md, Telegram line**

OLD:
> previous round's keyboard retired on each entry to `in_review`.

NEW:
> previous round's keyboard retired when a new Review round begins (entry from `verifying`); `undone`/`resume` keep the round and the card.

**I2. Story 1-2 patch**

- `src/core/coordinator/transitions.ts`, `enter()` case `in_review`: bump `review_round` only when `opts.cause === 'evidence_verified'`.
- Tests: `evidence_verified` bumps the round; `undone` and `resume` into `in_review` keep it.
- `spec-1-2-coordinator-core.md`: Spec Change Log entry citing this proposal.
- `deferred-work.md`: close the #6 and #11 entries.

## 5. Implementation Handoff

**Scope: Minor.** The Developer agent applies A1–A3, S1, U1, I1 and I2 directly. The Owner approves this proposal.

**Success criteria:**

- The spine, glossary, EXPERIENCE.md and epic-1-context.md say the same thing about rounds and replay.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` all exit 0, with new tests proving a round goes up only on `evidence_verified`.
- `deferred-work.md` no longer lists #6 or #11 as open.
