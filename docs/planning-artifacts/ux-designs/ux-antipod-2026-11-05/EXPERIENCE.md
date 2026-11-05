---
name: Antipode
status: final
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
- **Chat topology:** one private Telegram supergroup per Project, with exactly two members: the Owner and the bot (FR-1 "one chat binding per Project"). The Owner creates the group, because bots can't (see Flow 0). The group is named per `DESIGN.md` → Brand & Style. It must be a supergroup so message links work.
  - `[NOTE FOR ARCHITECTURE: the bot must receive all group messages, so privacy mode is off before the bot is added, or the bot is an admin.]`
  - `[NOTE FOR ARCHITECTURE: only the Owner's Telegram user ID is honored; messages from anyone else are ignored.]`
  - `[NOTE FOR ARCHITECTURE: voice notes are transcribed by Antipode, because bots don't get Telegram's transcription.]`
  - `[NOTE FOR ARCHITECTURE: callback_data is ≤64 bytes, so buttons carry short opaque IDs.]`
  - `[NOTE FOR ARCHITECTURE: bot file uploads are capped at 50 MB; larger Demos go out as authenticated links (FR-24).]`
- **Language:** English only.
- **Input modalities:** button taps, text, voice notes and replies to bot messages.

## Information Architecture

In a chat product, a "surface" is a message type. Every Owner need in the PRD lands on one of these. Name mapping to the PRD: **Peek reply** = Progress Peek, **Stuck card** = Stuck message, **Review card** = the last message of a Review.

| Surface | Trigger | Purpose | PRD |
|---|---|---|---|
| **Registration reply** | `/register ${repo}` in a new Project group | Bind the group to a Project, or say why the Recipe is missing or invalid | FR-1, FR-3 |
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
| **Evidence archive** | `/evidence ${id}` | Resend a past Task's Evidence and Review card (read-only) | FR-25 |
| **Log reply** | `/log ${id}` | Stage history, one line per Stage, with logs attached as files (no external links, for privacy) | NFR-5 |
| **Lifecycle notices** | State changes the Owner should know about | Released, Release failed, paused for window, resumed, onboarding blocked, back online | FR-3, FR-17, FR-30 |

**Command menu:** `/register`, `/status`, `/peek`, `/parked`, `/cost`, `/pause`, `/resume`, `/cancel`, `/evidence`, `/log`.

**Review order vs FR-26.** FR-26's order is kept, but it is spread across messages, because Telegram can't put buttons on media. Evidence (item 2) and the Demo (item 3) go first as separate messages. The card that follows holds the summary (item 1), the criteria strip, the Parking Lot (item 4), the cost (item 5) and the buttons (item 6). The summary moving below the media is deliberate, so the buttons end up under the thumb. `[NOTE FOR PM: confirm this reading of FR-26.]`

**One Review at a time per group.** When two Tasks in a Project become reviewable together, the second Review's sequence starts only after the first card is sent, so messages never interleave. Every Evidence caption carries its Task ID anyway. The menu is registered with Telegram so it appears behind the `/` button.

**Task targeting.** Several Tasks can be active in one Project group, so every Task-scoped action resolves its Task in this order:
1. A **reply** to any bot message about a Task targets that Task. This is the primary, one-handed way.
2. An explicit ID: `/peek 12`.
3. With no reply and no ID: if exactly one Task matches the command's state (for example, one running Task for `/peek`), use it. Otherwise the bot replies with one button per candidate Task (`#12 Rest timer`, `#14 Dark mode`).

**Free text with no reply target** goes to Intake as a possible new Task request. If Intake reads it as being about an existing Task, it asks one question with Task buttons (FR-10). If it is not actionable (`ok`, `thanks`), the `👀` reaction stays and nothing else is sent.

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
| **Evidence message** | One message per criterion: a photo, a video (≤60 s) or a before/after composite. If compositing fails, two separately labelled photos (`DESIGN.md` → before-after-composite). Never an album. Caption per `{components.evidence-caption.pattern}`. All Evidence messages are sent silently; only the Review card makes a sound. |
| **Demo message** | An APK/STL sent as a Telegram file, or a WebGL/preview link, captioned `Demo · ${what to try}`. Files over the upload limit become authenticated links. Sent silently, after the Evidence and before the card. |
| **Review card** | Always the last message of a Review, so the buttons are under the thumb. Rows: 1) `Accept` · `Request changes`; 2) Parking Lot promotion (see below). After any tap the card is **edited in place**. On Accept, the keyboard becomes `[Undo]` for 10 s and is then removed. On Request changes, the keyboard is removed at once. A state line is appended (`✅ Accepted · integrating` → `📦 Released 0.4.2`, or `✅ Merged · no release step`). Blocks that don't apply (no Demo, empty Parking Lot, no before/after) are omitted without a placeholder. Release confirmation is also sent as a silent reply to the card, so it appears in the chat flow (UJ-2). |
| **Parking Lot on the card** | Each finding has its own line, `🅿️ P1 timer text overlaps on very small screens`. With 1–2 findings, there is one button per finding (`🅿️ P1 → Task`). With 3 or more, a single `🅿️ Parked (n) →` button sends the list. Promoting a finding sends it to Intake, which replies with a Draft card linked to the source Task. Findings that are not promoted remain in `/parked` after Accept. Nothing is ever auto-drafted (OQ7). |
| **Correction prompt** | Tapping `Request changes` sends a force-reply message: `What should change on #12?` The Owner answers by text or voice. Intake interprets the answer (FR-10). If the Correction only adds a note under the existing criteria, it goes straight back to the Task with no confirmation step. If it changes criteria, it becomes an Interpretation card first. |
| **Interpretation card** | Shows the structured instruction as Intake understood it (`Drop AC2 from #9 · Draft new Task: "jump height vs criterion 2"`), with `Confirm` and `Edit`. Required whenever **free text or voice** would change criteria, budget or cancellation (FR-10). An explicit button (`Raise budget +2`, `Cancel Task` with its confirm) already is the confirmation, so it skips this card. `Edit` = reply again. If confirming would restart an in-progress Task (FR-14), the card says `Restarts #${id} from implementing.` |
| **Evidence archive** | `/evidence ${id}` resends the Task's Evidence silently, followed by a read-only copy of its last Review card with the buttons stripped. |
| **Lifecycle notices** | One line each, as a reply to the Task's card where there is one. Sound per Interaction Primitives. Each notice is sent once and never repeated. |
| **Callout box** | The Evidence Producer adds one when the changed region covers less than about a quarter of the frame. `[ASSUMPTION]` |
| **Stuck card** | Sent after the last Evidence is resent as media. Contents: Triage's one-line reason, then up to 3 lines on what was attempted. Buttons: `Raise budget +2` · `Cancel Task`. Under the buttons: `Or reply to amend or drop a criterion.` Free replies go through Intake and an Interpretation card. When a confirmed amendment changes criteria, the Task restarts from implementing (FR-14) with a fresh Iteration Budget at its contract default. `Raise budget +2` adds 2 runs to the spent budget. `[ASSUMPTION]` |
| **Peek reply** | Latest visual Evidence, or text only if there is none yet (`No visuals yet`). Caption: `${Role} · ${one line} · lap ${n}/${budget} · ${elapsed}`. Read-only. It never interrupts a Stage and is always silent. |
| **Status list** | One line per Task, grouped by Needs you / Running / Queued / Done (last 5). Tapping a Needs you line scrolls to that card (a supergroup message link); the Owner then acts on the card itself. |
| **Parked list** | One message per finding, each with `→ Task` and `Dismiss`. Dismiss removes the finding from the list; the entry stays in the Task record. |
| **Cost reply** | Format in `DESIGN.md` → Cost reply. `/cost ${id}` narrows it to one Task, with one line per Stage. |
| **Log reply** | One line per Stage (`${Role} · ${outcome} · ${duration}`), with the Stage logs attached as one file. |
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
| Release failed | Loud notice | `❌ #12 merged · release failed: ${reason}. Main not rolled back.` Buttons: `Retry release` · `Leave it`. |
| Onboarding blocked | Loud notice in the Project group | `Training can't start: Recipe produces no visual Evidence (${step} failed).` Followed by the step log as a file. |
| Bootstrap Review | Review | Same shape as any Review, with the title `#1 Bootstrap · Recipe check`. One criterion per Evidence kind the Recipe declares (FR-3). |
| Cancelled | Card edit | `Cancelled · branch kept`. The buttons are removed. |
| Mac asleep / bot offline | Nothing can be sent while offline | NFR-6 can't be met while offline. On wake: queued updates are processed in order. Taps the Owner made while offline are answered with a short reply to their card, not a toast (the toast has expired). `/peek` requests older than 5 min are dropped. Then one silent notice per affected Project: `Back online · 2 Tasks resumed.` `[ASSUMPTION]` |
| Intake or transcription failure | Owner's message | After the retry limit, `👀` is replaced by `❌` with a reply: `Couldn't read that voice note — send it again or type it.` or `Couldn't process that — send it again.` |
| Registration failed | Registration reply (loud) | `❌ Can't register: ${reason}`, e.g. `no Recipe at repo root` or `Recipe contains a secret value (line 14)`. The group stays unbound. |
| Unknown Task ID | Reply | `No Task #${id} in Training.` |
| Empty `/status` | Status list | `No Tasks yet. Send a request to start one.` |
| Empty `/parked` | Reply | `Parking Lot is empty.` |
| Nothing to peek | Reply | `Nothing running. Next up: #${id}`, or `Nothing running.` |
| No cost data yet | Cost reply | `No usage recorded yet.` |
| Ambiguous Owner Message | Reply | One question with quick-answer or Task buttons (FR-10). Nothing acts until it is answered. |
| Peek on non-running Task | Reply | `#${id} is ${state} — nothing to peek.` |
| Demo preview asleep | Demo link | The link wakes the preview (FR-24). If the wake takes more than a few seconds, the bot replies `Waking preview · ~30 s`. |
| Evidence send failed | None, then notice | Retried silently. After the retry limit, a loud `❌ #${id} Review couldn't be delivered: ${reason}`, followed by `/evidence ${id}` once it is fixed. |
| Unanswered Correction prompt | Force-reply | Nothing happens; the Task stays in review. The next free text that replies to the prompt is the Correction. |
| Stale button | Toast | Tapping a button on an outdated card: `This Review was replaced by a newer one.` The bot then replies to the newer card. |

## Interaction Primitives

- **Tap** is the primary action on inline buttons. Every button is acknowledged with a toast.
- **Reply** targets a Task. It is the main way to give feedback.
- **Voice note:** anywhere text is accepted, voice works too. It is transcribed before Intake runs (FR-7). The transcript is not echoed, but the Interpretation or Draft card shows what was understood.
- **Commands** come from the `/` menu, with an optional Task ID.
- **Notifications:** only **Reviews**, **Stuck**, **Release failed**, **Onboarding blocked** and **Registration failed** make a sound. All of these need the Owner's decision. For a Review, the sound comes from the Review card, the last message of the Review. Everything else uses `disable_notification`. Evidence messages are silent, and the Review card that follows them makes the sound.
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

### Flow 0 — Onboard a Project (FR-1, FR-3)

1. On the Mac, agxmeister has committed a Recipe to the training-app repo.
2. On the phone, they create a private group `Antipode · Training`, add the bot (privacy mode already off) and send `/register github.com/agxmeister/training`. `[ASSUMPTION: registration by repo URL from the group; a Mac CLI is the fallback]`
3. `👀`. The bot validates the Recipe.
   - If it fails: a loud `❌ Can't register: no Recipe at repo root`. The group stays unbound, and agxmeister fixes the Recipe and sends `/register` again.
4. On success: `Training registered · bootstrap running`. The bot creates Task #1, the bootstrap.
5. The bootstrap Review arrives: one Evidence message per Evidence kind the Recipe declares (a screencast, screenshots, the APK), then the card `#1 Bootstrap · Recipe check`.
   - If the Recipe produces no visual Evidence, a loud Onboarding-blocked notice arrives instead, with the step log attached.
6. **Climax:** agxmeister taps **Accept**. The card shows `✅ Project active`, and feature Tasks can now start.

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

Failure: the rebase conflicts after Accept. The Task returns to the Implementer, and a new Review arrives with `Re-review: rebase needed changes after your Accept.` If the Release fails instead, a loud `Release failed` notice arrives (State Patterns).

### Flow 3 — Correct instead of accepting (UJ-3)

1. The Review shows a tiny timer. agxmeister taps **Request changes**.
2. A force-reply prompt arrives: `What should change on #12?` They type "timer should be big, center of screen."
3. `👀`. The note keeps the existing criteria, so no confirmation is needed: `Sent back to #12.`
4. The next Review opens with a before/after composite: last Review on the left, new one on the right. The card summary starts `Changed: timer enlarged and centered.`
5. **Climax:** the before/after shows the fix at a glance, and agxmeister taps **Accept**.

Failure: if the note changes a criterion ("and drop the vibration"), Intake sends an Interpretation card first, and nothing restarts until agxmeister taps **Confirm**.

### Flow 4 — Handle a Stuck Task (UJ-4)

1. The phone buzzes in `Antipode · Jumper`. The last play-mode recording arrives, then the Stuck card: `🧱 #9 Stuck · criterion 2 contradicts existing jump height.` It lists 3 attempts, with [Raise budget +2] [Cancel Task] and `Or reply to amend or drop a criterion.`
2. agxmeister replies to the card: "drop criterion 2, make a new task for it."
3. An Interpretation card arrives: `Drop AC2 from #9 · New draft: "Reconcile jump height with AC2"` [Confirm] [Edit]
4. **Climax:** they tap **Confirm**. #9 restarts from implementing with a fresh Iteration Budget, and a Draft card for the new Task follows.

Failure: if Intake can't tell what to drop, it asks one question with `AC1` / `AC2` / `AC3` buttons before showing the Interpretation card.

### Flow 5 — Peek at progress (UJ-5)

1. While waiting in a queue, agxmeister replies `/peek` to the #21 Draft card in `Antipode · Hinge`.
2. **Climax:** a silent reply arrives with the latest render: `Implementer · adding fillet to the hinge · lap 2/5 · 6 min`. Nothing was interrupted.

Failure: if #21 has no visuals yet, the reply is text only. If #21 isn't running, the reply is `#21 is queued — nothing to peek.`

### Flow 6 — Promote a parked finding (OQ7)

1. A week later, agxmeister sends `/parked` in `Antipode · Training`.
2. Two findings arrive, each with **→ Task** / **Dismiss**.
3. They tap **→ Task** on `P1 timer text overlaps on very small screens (from #12)`.
4. **Climax:** a Draft card arrives with criteria built from the finding. It is approved like any other Draft (Flow 1).

Failure: if nothing is parked, the reply is `Parking Lot is empty.`
