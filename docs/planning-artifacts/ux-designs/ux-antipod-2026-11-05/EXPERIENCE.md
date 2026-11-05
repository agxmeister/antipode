---
name: Antipode
status: draft
updated: 2026-11-05
sources:
  - ../../prds/prd-antipod-2026-11-01/prd.md
  - ../../prds/prd-antipod-2026-11-01/addendum.md
---

# Antipode — Experience Spine

## Foundation

- **Surface:** a single mobile surface, the Telegram client on the Owner's phone. There is no web UI in the MVP (PRD §10.3).
- **UI system:** Telegram itself. Antipode inherits Telegram's message rendering, inline keyboards, reply threading, reactions, media viewer, voice notes and notification settings. This spine specifies only Antipode's behavior on top of Telegram.
- **Visual identity:** `DESIGN.md` covers glyphs, message composition and generated imagery.
- **Chat topology:** one private Telegram group per Project, with exactly two members: the Owner and the bot (FR-1 "one chat binding per Project"). The group is named per `DESIGN.md` → Brand & Style.
  - `[NOTE FOR ARCHITECTURE: the bot must receive all group messages, so privacy mode is off or the bot is an admin.]`
  - `[NOTE FOR ARCHITECTURE: only the Owner's Telegram user ID is honored; messages from anyone else are ignored.]`
- **Language:** English only.
- **Input modalities:** button taps, text, voice notes and replies to bot messages.

## Information Architecture

In a chat product, a "surface" is a message type. Every Owner need in the PRD lands on one of these:

| Surface | Trigger | Purpose | PRD |
|---|---|---|---|
| **Draft card** | Owner text/voice request; repo contract detected; Parking Lot promotion | Show draft Task Contract, ask ≤2 questions, Approve / Discard | FR-6–9, UJ-1 |
| **Evidence messages** | Task reaches in review | One media message per criterion, then Demo file | FR-21–24 |
| **Review card** | Directly after Evidence messages | Verdict summary + Accept / Request changes + Parking Lot actions | FR-26–27, UJ-2 |
| **Correction prompt** | Tap Request changes | Force-reply asking what should change | FR-28, UJ-3 |
| **Interpretation card** | Intake turns an Owner Message about an existing Task into an instruction that needs confirmation | Show structured instruction, Confirm / Edit | FR-10 |
| **Stuck card** | Iteration Budget spent or blocker | Attempts, last Evidence, Triage reason, decision buttons | FR-13, FR-28, UJ-4 |
| **Peek reply** | `/peek` | Latest visual + one status line | FR-28, UJ-5 |
| **Status list** | `/status` | All Tasks of this Project with states; one line on other Projects | FR-28 |
| **Parked list** | `/parked` | Unpromoted Parking Lot findings, each with → Task / Dismiss | OQ7 |
| **Cost reply** | `/cost` | Per-Task, per-Project, current-window breakdown | FR-31 |
| **Evidence archive** | `/evidence {id}` | Resend a past Task's Evidence and Review card (read-only) | FR-25 |
| **Log reply** | `/log {id}` | Stage history with a link or file for each Stage log | NFR-5 |
| **Lifecycle notices** | State changes the Owner should know about | Released, Release failed, paused for window, resumed, onboarding blocked | FR-3, FR-17, FR-30 |

**Command menu:** `/status`, `/peek`, `/parked`, `/cost`, `/pause`, `/resume`, `/cancel`, `/evidence`, `/log`. The menu is registered with Telegram so it appears behind the `/` button.

**Task targeting.** Several Tasks can be active in one Project group, so every Task-scoped action resolves its Task in this order:
1. A **reply** to any bot message about a Task targets that Task. This is the primary, one-handed way.
2. An explicit ID: `/peek 12`.
3. With no reply and no ID: if exactly one Task matches the command's state (for example, one running Task for `/peek`), use it. Otherwise the bot replies with one button per candidate Task (`#12 Rest timer`, `#14 Dark mode`).

**Free text with no reply target** is treated as a new Task request and goes to Intake. If Intake reads it as being about an existing Task, it asks one question with Task buttons (FR-10).

**Cross-Project view.** `/status` in any group lists that Project's Tasks and ends with one line about the others: `Elsewhere: Unity 1 running · OpenSCAD idle`. `[ASSUMPTION: there is no separate "home" chat in the MVP; revisit if the Owner runs more than three Projects.]`

## Voice and Tone

Microcopy follows PRD §8: a team lead reporting to their manager.

| Do | Don't |
|---|---|
| `#12 Rest timer · ready for review` | `Great news! Your task is ready 🎉` |
| `Accepted. Integrating.` | `Thanks! I'll start merging now.` |
| `Released as internal build 0.4.2.` | `The release process completed successfully.` |
| `Can the default be changed per exercise?` [Yes] [Not yet] | `Before I proceed, could you clarify whether…` |
| `Haptics can't be recorded in the emulator. Proposed: test log of vibration call (degraded).` | `Unfortunately, I'm unable to…` |
| `🧱 #9 Stuck · criterion 2 contradicts existing jump height.` | `I tried my best but couldn't…` |
| `⏸ #12 waiting for usage window · resumes ~14:20` | `Error: rate limited` |

Rules:
- No apologies, greetings, sign-offs or exclamation marks.
- Every question is answerable with one tap or one word where possible.
- When the answer is closed, questions carry quick-answer buttons.
- Durations are approximate (`~14 min`) and times are local (`~14:20`).
- Never mention Stages, Roles or the Coordinator unless the Owner asks (`/log`). The exception is a Peek, whose status line names the active Role.

## Component Patterns

Behavioral rules only. Visual specs are in `DESIGN.md` → Components.

| Component | Behavioral rules |
|---|---|
| **Draft card** | Shows the goal, numbered criteria and the Evidence kind of each criterion, and fits one phone screen (FR-7). Up to 2 questions, each with quick-answer buttons when the answer is closed. **Approve** appears only when every question is answered and every criterion has feasible Evidence (FR-8). Until then a line reads `Approve after: answer Q1`. Replying with text or voice revises the draft, and the card is edited in place, not reposted. **Discard** needs no confirmation and can be undone from the edited card for 1 min. `[ASSUMPTION]` |
| **Evidence message** | One message per criterion. Photo, video (≤60 s) or a two-photo album for a before/after pair the bot can't composite. Caption per `DESIGN.md` → evidence-caption. All Evidence messages are sent silently; only the Review card makes a sound. |
| **Demo message** | APK/STL sent as a Telegram file, or a WebGL/preview link, captioned `Demo · {what to try}`. Sent silently, after the Evidence and before the card. |
| **Review card** | Always the last message of a Review, so the buttons are under the thumb. Rows: 1) `Accept` · `Request changes`; 2) Parking Lot promotion (see below). After any tap the card is **edited in place**: its buttons are removed and a state line is appended (`✅ Accepted · integrating` → `📦 Released 0.4.2`). Release confirmation is also sent as a silent reply to the card, so it appears in the chat flow (UJ-2). |
| **Parking Lot on the card** | Each finding has its own line, `🅿️ P1 timer text overlaps on very small screens`. With 1–2 findings, there is one button per finding (`🅿️ P1 → Task`). With 3 or more, a single `🅿️ Parked (n) →` button sends the list. Promoting a finding sends it to Intake, which replies with a Draft card linked to the source Task. Findings that are not promoted remain in `/parked` after Accept. Nothing is ever auto-drafted (OQ7). |
| **Correction prompt** | Tapping `Request changes` sends a force-reply message: `What should change on #12?` The Owner answers by text or voice. Intake interprets the answer (FR-10). If the Correction only adds a note under the existing criteria, it goes straight back to the Task with no confirmation step. If it changes criteria, it becomes an Interpretation card first. |
| **Interpretation card** | Shows the structured instruction as Intake understood it (`Drop AC2 from #9 · Draft new Task: "jump height vs criterion 2"`), with `Confirm` and `Edit`. Required for any change to criteria, budget or cancellation (FR-10). `Edit` = reply again. |
| **Stuck card** | Sent after the last Evidence is resent as media. Contents: up to 3 lines on what was attempted, then Triage's one-line reason. Buttons: `Raise budget +2` · `Cancel Task`. Under the buttons: `Or reply to amend or drop a criterion.` Free replies go through Intake and an Interpretation card. |
| **Peek reply** | Latest visual Evidence, or text only if there is none yet (`No visuals yet`). Caption: `{Role} · {one line} · lap {n}/{budget} · {elapsed}`. Read-only. It never interrupts a Stage and is always silent. |
| **Status list** | One line per Task: `{glyph} #{id} {title} · {state}`, grouped by Needs you / Running / Queued / Done (last 5). Each line in Needs you replies to the relevant card when tapped. `[ASSUMPTION: Telegram message links, not buttons]` |
| **Parked list** | One message per finding, each with `→ Task` and `Dismiss`. Dismiss removes the finding from the list; the entry stays in the Task record. |
| **Ack** | Covered in Interaction Primitives. |

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| Owner Message received | Owner's message | `👀` reaction within 5 s (NFR-6). The real reply follows when Intake is done. |
| Button tapped | Tapped card | Telegram toast within 5 s (`Accepted. Integrating.`). The card is edited at the same time. |
| Draft awaiting answers | Draft card | `Approve after: …` line instead of the Approve button. |
| Infeasible criterion | Draft card | The criterion line reads `AC3 ⚠️ can't evidence haptics · proposed: vibration call log (degraded)`, with `Use proposal` / `Drop AC3` buttons. |
| Running | Status list | `⏳ #12 Rest timer · implementing (lap 2/5)`. No proactive messages while running. |
| Paused for usage window | Silent notice, once per pause | `⏸ #12 waiting for usage window · resumes ~14:20`. A silent `Resumed` notice follows. Never shown as a failure (FR-17). |
| Paused by Owner | Card edit + status | `⏸ Paused by you`. `/resume` or reply `resume`. |
| Backpressure | Status list only | `Queued · waiting on 3 open Reviews`. No push: the Owner already has the Reviews in front of them (FR-16). |
| Waiting on dependency | Status list | `Queued · after #11`. |
| Re-review after Correction | Evidence messages | Opens with before/after composites against the previous Review (FR-22). The card summary starts with `Changed: …`. |
| Re-review after Integration rework | Evidence + card | Card line: `Re-review: rebase needed changes after your Accept.` (FR-29) |
| Degraded Evidence | Caption + card strip | `⚠️` with the reason. Never hidden. The Owner can still Accept. |
| Stuck | Stuck card (loud) | See Component Patterns. |
| Release failed | Loud notice | `❌ #12 merged · release failed: {reason}. Main not rolled back.` Buttons: `Retry release` · `Leave it`. |
| Onboarding blocked | Loud notice in the Project group | `Training can't start: Recipe produces no visual Evidence ({step} failed).` Followed by the step log as a file. |
| Bootstrap Review | Review | Same shape as any Review, with the title `#1 Bootstrap · Recipe check`. One criterion per Evidence kind the Recipe declares (FR-3). |
| Cancelled | Card edit | `Cancelled · branch kept`. The buttons are removed. |
| Mac asleep / restart | None while it happens | On wake, one silent notice per affected Project: `Back online · 2 Tasks resumed.` `[ASSUMPTION]` |
| Stale button | Toast | Tapping a button on an outdated card: `This Review was replaced by a newer one.` The bot then replies to the newer card. |

## Interaction Primitives

- **Tap** is the primary action on inline buttons. Every button is acknowledged with a toast.
- **Reply** targets a Task. It is the main way to give feedback.
- **Voice note:** anywhere text is accepted, voice works too. It is transcribed before Intake runs (FR-7). The transcript is not echoed, but the Interpretation or Draft card shows what was understood.
- **Commands** come from the `/` menu, with an optional Task ID.
- **Notifications:** only **Reviews**, **Stuck** and **Release failed** make a sound. Everything else uses `disable_notification`. Evidence messages are silent, and the Review card that follows them makes the sound.
- **Confirmation:** `Cancel Task` asks for confirmation in place (the buttons change to `Confirm cancel #12` · `Keep`). `Accept` is one tap (FR-27), but the edited card shows `Undo` for 10 s before Integration starts. `[ASSUMPTION: protects against a one-handed mis-tap without adding a step]`
- **Edit in place:** cards are edited rather than reposted, so the chat holds one card per Review round.
- **Banned:** proactive progress messages while running, typing-indicator theatre, polls, multi-step wizards, deep-linking out to a browser for anything except a Demo.

## Accessibility Floor

- Glyphs never carry meaning alone. Every state glyph is followed by a text word (DESIGN.md Do's).
- Every Evidence caption states what the media shows in words, so it works with screen readers and with autoplay off.
- Screencasts never depend on audio.
- Everything can be done one-handed: no action requires typing a command with an ID. Replies and buttons cover every path.
- Voice is a first-class input, never a degraded one.

## Inspiration & Anti-patterns

- **Lifted from:** CI bots that post a single, edited-in-place status comment. One card per round, updated as state changes.
- **Rejected:** pull-request review flows. Diffs, file trees and code links never appear in a Review (PRD §9).
- **Rejected:** chatty agent narration ("I'm now looking at…"). The Peek is pull-only and nothing is pushed while a Task runs.
- **Rejected:** auto-drafting a Task from every parked finding. It would add review load and break backpressure (OQ7).

## Key Flows

Protagonist: **agxmeister**, the Owner, on the phone in short gaps. The flows follow PRD UJ-1 to UJ-5 and keep their names.

### Flow 1 — Kick off a Task from the tram (UJ-1)

1. In `Antipode · Training`, agxmeister sends a voice note: "add a rest timer after each set, 90 seconds default."
2. The bot reacts `👀` within 5 s.
3. A Draft card arrives (silent): `#12 Rest timer after each set` with 3 criteria and Evidence kinds. Q1: `Can the default be changed per exercise?` [Yes] [Not yet]
4. agxmeister taps **Not yet**. The card is edited: the answer is folded in and **Approve** appears.
5. **Climax:** they tap **Approve**. The toast reads `Queued.` and the card shows `⏳ Queued · starts next`. The Task is now the factory's job.

Edge: a criterion can't be evidenced. The card shows `⚠️` with a proposed substitute and **Use proposal** / **Drop AC3** buttons, and Approve stays hidden until one is chosen.

### Flow 2 — Accept in under a minute (UJ-2)

1. The phone buzzes once.
2. The chat shows three Evidence messages: `AC1 ✅ timer starts after set` (20 s video) and two before/after composites. Then the APK, then the Review card.
3. agxmeister watches the video, installs the APK from the file message and tries it once.
4. **Climax:** they tap **Accept** on the card under their thumb. The toast reads `Accepted. Integrating.` and the card shows `✅ Accepted · integrating`, with `Undo` for 10 s.
5. Later, a silent reply to the card reads `📦 Released as internal build 0.4.2.` The card's state line updates to match.

Parking Lot variant: the card also offers `🅿️ P1 → Task`. agxmeister ignores it, and P1 waits in `/parked`.

### Flow 3 — Correct instead of accepting (UJ-3)

1. The Review shows a tiny timer. agxmeister taps **Request changes**.
2. A force-reply prompt arrives: `What should change on #12?` They type "timer should be big, center of screen."
3. `👀`. The note keeps the existing criteria, so no confirmation is needed: `Sent back to #12.`
4. The next Review opens with a before/after composite: last Review on the left, new one on the right. The card summary starts `Changed: timer enlarged and centered.`
5. **Climax:** the before/after shows the fix at a glance, and agxmeister taps **Accept**.

### Flow 4 — Handle a Stuck Task (UJ-4)

1. The phone buzzes in `Antipode · Jumper`. The last play-mode recording arrives, then the Stuck card: `🧱 #9 Stuck · criterion 2 contradicts existing jump height.` It lists 3 attempts, with [Raise budget +2] [Cancel Task] and `Or reply to amend or drop a criterion.`
2. agxmeister replies to the card: "drop criterion 2, make a new task for it."
3. An Interpretation card arrives: `Drop AC2 from #9 · New draft: "Reconcile jump height with AC2"` [Confirm] [Edit]
4. **Climax:** they tap **Confirm**. #9 resumes from implementing, and a Draft card for the new Task follows.

### Flow 5 — Peek at progress (UJ-5)

1. While waiting in a queue, agxmeister replies `/peek` to the #21 Draft card in `Antipode · Hinge`.
2. **Climax:** a silent reply arrives with the latest render: `Implementer · adding fillet to the hinge · lap 2/5 · 6 min`. Nothing was interrupted.

### Flow 6 — Promote a parked finding (OQ7)

1. A week later, agxmeister sends `/parked` in `Antipode · Training`.
2. Two findings arrive, each with **→ Task** / **Dismiss**.
3. They tap **→ Task** on `P1 timer text overlaps on very small screens (from #12)`.
4. **Climax:** a Draft card arrives with criteria built from the finding. It is approved like any other Draft (Flow 1).
