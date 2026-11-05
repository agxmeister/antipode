# Spine Pair Review — antipod

## Overall verdict

The pair is lean, on-voice and mostly buildable. All five UJs have Key Flows with a protagonist and a climax, the Review loop is specified tightly, and almost every Telegram mechanic it relies on is real Bot API behavior. It is not yet a clean contract. No flow covers how a Project's group gets bound (FR-1). Placeholder braces in DESIGN.md's component tokens collide with the `{path.to.token}` syntax. Two states that will happen every day are unhandled: Intake/transcription failure after the `👀`, and taps or messages sent while the Mac is asleep. Most cards other than the Review card have no visual composition spec. None of this is critical. With about 5 high fixes, the pair would be ready for architecture and story-dev.

## 1. Flow coverage — adequate

Checked: UJ-1..UJ-5 map to Flows 1–5, and OQ7 maps to Flow 6. Each flow has a named protagonist (agxmeister), numbered steps and a bold climax. I mapped every Telegram-facing requirement (FR-1, 3, 6–10, 13, 14, 17, 22, 24–31, NFR-5, NFR-6) to an IA surface. Every requirement lands somewhere except FR-1's chat binding, and FR-31/NFR-5 land on surfaces whose output has no defined format.

### Findings
- **high** No onboarding flow. FR-1 says "one Telegram chat binding per Project", but nothing says how the group is created and bound. Bots can't create groups, so the Owner has to create it, add the bot and bind it to a repo (a command? a deep link `?startgroup=`? CLI on the Mac?). It is also unclear where FR-1's "readable reason" for an invalid Recipe appears, and what the FR-3 bootstrap Review looks like from the Owner's side. The topic appears only as two State Patterns rows: Bootstrap Review and Onboarding blocked (EXPERIENCE.md → State Patterns; no Key Flow). *Fix:* add "Flow 0 — Onboard a Project". Cover: the Owner creates the group, adds the bot, sends `/bind {repo}` (or registers via CLI and gets a group link), registration-failure reply, bootstrap Review, Accept, then "Training is active." Also state the privacy-mode/admin requirement at the point where the bot is added.
- **medium** Flows 2–6 have no failure paths. Only Flow 1 has an Edge. Missing: Flow 2 → Integration rework / Release failed. Flow 3 → a Correction that changes criteria (Interpretation card). Flow 5 → no running Task, or no visuals yet. Flow 6 → `/parked` is empty (EXPERIENCE.md → Key Flows). *Fix:* add one "Failure:" line per flow, pointing at the State Patterns row that already exists where possible.
- **medium** Flow 4 step 4: "#9 resumes from implementing" after the Iteration Budget is spent. The spine never says whether dropping a criterion resets, refills or leaves the budget at zero. A consumer can't implement the resume. *Fix:* state the rule (for example "an amendment from a Stuck reply grants +1 lap unless the Owner raised the budget") or mark it `[NOTE FOR ARCHITECTURE]`.
- **medium** FR-26 orders the Review "1. one-line summary … 6. buttons". The spine moves the summary into the last message, after the Evidence. This is a sound choice, but it is not flagged as a deliberate reinterpretation of the PRD, so a story-dev writing to FR-26 will build it differently (DESIGN.md → Components → Review card; EXPERIENCE.md → Component Patterns → Review card). *Fix:* add one line: "Supersedes FR-26 ordering: Evidence first, summary in the card. Logged in .memlog." Raise it with the PM as a PRD touch-up.
- **medium** FR-31 and NFR-5 land on surfaces with no defined output. The format of the Review card's "cost line" is not given. The `/cost` reply has no layout. `/log` promises "a link or file for each Stage log", but a link to a log on the Mac must be authenticated or on a private network (PRD §6 Privacy; FR-24 rule) (EXPERIENCE.md → IA rows Cost reply, Log reply). *Fix:* give the cost-line pattern (`~38k tokens · 14 min · 4% of window`, per UJ-2), a 3–5 line `/cost` layout, and "Stage logs are sent as a single .txt/.zip file; no links".
- **low** FR-14: editing the contract of an in-progress Task restarts it from implementing. The Interpretation card doesn't warn the Owner about this (EXPERIENCE.md → Component Patterns → Interpretation card). *Fix:* add `Restarts #9 from implementing.` to the card when it applies.

## 2. Token completeness — adequate

Checked: every frontmatter key, and every `{…}` reference in DESIGN.md prose and component objects. These resolve: `{typography.annotation-label}`, `{spacing.composite-gap}`, `{spacing.annotation-pad}`, `{rounded.annotation}`, `{colors.annotation-plate|annotation-ink|composite-divider|annotation-highlight}`, `{components.evidence-caption.pattern}`, `{components.review-card.titlePattern|maxProseLines}`, `{components.before-after-composite}`, `{components.callout-box}`. The Typography section uses platform `note` fields for Telegram-rendered text, as the spec requires, and gives literal values only for burned-in labels. Correct.

### Findings
- **high** The template placeholders use the token-reference syntax. `evidence-caption.pattern: '<b>AC{n}</b> {glyph} {criterion-label}'` and `review-card.titlePattern: '<b>#{task-id} · {task-title}</b>'` contain `{n}`, `{glyph}`, `{criterion-label}`, `{task-id}` and `{task-title}`. A spec-compliant resolver treats any `{…}` in a component value as a token path, so it will either fail or silently leave these unresolved (DESIGN.md frontmatter lines 41–45). *Fix:* use a placeholder syntax the resolver ignores, for example `<b>AC${n}</b> ${glyph} ${criterion-label}` or `%n%`, and say so in one line under Components.
- **medium** `glyph-pass: '✅'` … `glyph-ack: '👀'` are scalar component values. The spec defines `components` as "component-name → object of component tokens", so a strict parser rejects them (DESIGN.md frontmatter lines 32–40). *Fix:* collapse them into one component, `state-glyph: { pass: '✅', fail: '❌', degraded: '⚠️', … }`, and reference it as `{components.state-glyph.pass}`.
- **medium** `annotation-highlight: '#FFD400'` is a yellow stroke. Over white or light app screenshots (the default Android light theme, OpenSCAD's light background) it has very low contrast. The DESIGN.md Colors section says the tokens "must read on top of arbitrary app screenshots in both light and dark app themes", and this one does not. *Fix:* add a 2px dark outer stroke token (for example `annotation-highlight-halo: '#000000'`) to `callout-box`, or use a double stroke.
- **low** `annotation-label` has no `lineHeight`, and it names `Inter` with no fallback rule for the render host. Burned-in text depends on whatever fonts the image renderer has. *Fix:* add `lineHeight: 1.2` and "Inter is bundled with the Evidence renderer; never rely on system fonts."
- **low** `annotation-plate: '#000000B3'` is 8-digit hex with alpha. The spec says "hex strings" without saying whether alpha is allowed. *Fix:* keep it, but note "RGBA hex, 70% alpha", or split it into colour plus `opacity`.

## 3. Component coverage — thin

Checked: every component name used in either file against DESIGN.md → Components (visual) and EXPERIENCE.md → Component Patterns (behavior).

| Component | DESIGN visual | EXPERIENCE behavior |
|---|---|---|
| Glyph vocabulary | yes | Ack row (pointer only) |
| Evidence caption / Evidence message | yes | yes |
| Review card | yes | yes |
| Parking Lot on card | partial (in Review card + Inline buttons) | yes |
| Inline buttons | yes | Interaction Primitives only |
| Before/after composite | yes | State Patterns only |
| Callout box | yes | **none** |
| Draft card | **none** | yes |
| Demo message | **none** | yes |
| Correction prompt | **none** | yes |
| Interpretation card | **none** | yes |
| Stuck card | **none** | yes |
| Peek reply | **none** (caption pattern is in EXPERIENCE) | yes |
| Status list | **none** | yes |
| Parked list | **none** | yes |
| Cost reply, Evidence archive, Log reply, Lifecycle notices | **none** | **none** |

### Findings
- **high** Eight surfaces have behavior rows but no visual composition in DESIGN.md: the Draft card, Stuck card, Interpretation card, Peek reply, Status list, Parked list, Correction prompt and Demo message. Only the Review card gets a title pattern, block order and bold rules. Two developers would format the Draft card and the Stuck card (the loudest non-Review message) differently (DESIGN.md → Components). *Fix:* add a 1–2 line composition spec per card: title pattern, block order, which lines are `<b>`, and button rows. Copy the Review card entry's shape.
- **medium** Cost reply, Evidence archive, Log reply and Lifecycle notices appear in the IA table but have no entry in either file (EXPERIENCE.md → IA). *Fix:* add behavior rows. The Evidence archive needs "resends media silently plus a read-only card copy with the buttons stripped". Lifecycle notices need their sound rule.
- **medium** The Interpretation card rule is "Required for any change to criteria, budget or cancellation". The Stuck card's `Raise budget +2` and `Cancel Task` buttons change the budget and cancel without one, so the two rules contradict each other (EXPERIENCE.md → Component Patterns → Interpretation card vs Stuck card). *Fix:* reword to "Required when a *free-text* Owner Message changes criteria, budget or cancellation. Explicit buttons act directly; cancel uses in-place confirmation."
- **low** The Review card says "After any tap … its buttons are removed", while Interaction Primitives shows an `Undo` button for 10 s after Accept. *Fix:* give the keyboard sequence: Accept → keyboard becomes `[Undo]` → after 10 s, keyboard removed.
- **low** The callout box has no rule for when to add it beyond "when the change is small" (DESIGN.md → Components → Callout box). *Fix:* say who decides (the Evidence Producer, when the changed region is under ~25% of the frame) and give one behavior row.

## 4. State coverage — thin

Checked: each IA surface against these states: loading/ack, success, error/failure, empty, stale, ambiguous input, offline/host asleep, delivery failure, concurrency/interleave. Well covered: ack, stale button, paused (window and Owner), backpressure, dependency, Degraded Evidence, Release failed, cancelled, re-review variants.

### Findings
- **high** Taps and messages sent while the Mac is asleep or the bot is down. State Patterns says "None while it happens". In practice, Telegram holds the updates. A callback query that isn't answered in time leaves the Owner's tap spinning, then shows nothing, and the `👀` reaction (NFR-6, 5 s) can't happen. On wake, the queued `Accept`, Correction and `/peek` updates arrive late, possibly after a card has gone stale (EXPERIENCE.md → State Patterns → "Mac asleep / restart"). *Fix:* add rows. On wake, process queued updates in order. Answer late taps with a reply to the card (`Accepted (received 08:12 while offline). Integrating.`), not with a toast. Add the late `👀`. Drop queued `/peek` requests older than N min. Note that NFR-6 is suspended while the host is asleep.
- **high** Intake or transcription fails after the `👀`. If the Intake Stage times out or crashes (FR-12), or the voice note can't be transcribed, the Owner sees `👀` and nothing more. Because "No proactive messages while running" applies, the silence looks deliberate (EXPERIENCE.md → State Patterns; no row). *Fix:* add a row: `❌ Couldn't read that voice note. Send it again or type it.` / `❌ Intake failed on your message · retrying` after the retry limit. Optionally swap the reaction to `🤷`/`❌`. Note that `❌` must be in the group's allowed reactions.
- **medium** Free text that is not a Task request ("ok", "thanks", "what's running?") is treated as a new Task request with no exit. FR-10's ambiguous-meaning path ("exactly one clarifying question") has no state row (EXPERIENCE.md → IA "Free text with no reply target"; State Patterns). *Fix:* add a "Not a Task" row (Intake replies with one line and no draft, or a `Draft a Task?` [Yes] [No] button) and an "Ambiguous" row (one question with quick answers).
- **medium** Empty states and invalid targets are missing: `/status` with no Tasks, `/parked` empty, `/cost` before any Stage, `/peek` when nothing is running (or the reply target is queued, done or cancelled), and `/evidence 99` with an unknown ID. Only "No visuals yet" is covered (EXPERIENCE.md → State Patterns). *Fix:* one row each, each a one-line reply in the Voice-and-Tone style.
- **medium** Telegram delivery limits. Bot uploads are capped at 50 MB. Debug APKs, Unity WebGL zips, large STLs and high-bitrate 60 s screencasts can exceed that. A failed send, or a sleeping preview behind a Demo link (FR-24 "wakes on request"), has no state (EXPERIENCE.md → Demo message). *Fix:* add rows: "Demo too large → send a private link and caption `Demo · {size} · link`". "Preview waking → the link opens a wait page, or the bot replies `Waking preview · ~30 s`". "Evidence send failed → retry, then Stuck-like notice."
- **medium** Two Reviews interleave in one group. With concurrency of 2, two Tasks in the same Project can reach review at the same time, or a Peek reply can land in the middle of a Review's Evidence. The Evidence caption pattern has no Task ID, so `AC1 ✅ …` is ambiguous when that happens (EXPERIENCE.md → Evidence message; DESIGN.md → evidence-caption). *Fix:* send one Review per chat at a time (queue the second), and/or prefix captions with `#12 ·`.
- **low** Missing card variants: merged with no Release step (`✅ Merged · no release step`), Review with no Demo, no Parking Lot or no before/after, and a Request changes force-reply the Owner never answers. *Fix:* one line each, or one sentence: "absent blocks are omitted; no placeholder".

## 5. Visual reference coverage — strong

Checked: no `mockups/`, `wireframes/` or `imports/` references in either spine. This matches the memlog decision "no key-screen mocks (all surfaces spine-only)".

### Findings
- **low** An empty `imports/` directory exists in the workspace. *Fix:* delete it, or leave it; nothing references it.

## 6. Bloat & overspecification — strong

The pair is tight: DESIGN.md is 120 lines and EXPERIENCE.md is 193, with no restated platform values and no Telegram styling that the client owns. The Voice and Tone table earns its place, and `[ASSUMPTION]` tags are used sparingly.

### Findings
- **low** DESIGN.md Brand & Style spends a paragraph on the bot avatar and naming assumption. That is fine, but the group naming (`Antipode · {Project}`) is the only part a consumer needs. *Fix:* optional trim.
- **low** The Layout & Spacing rule "Landscape renders (Unity, OpenSCAD) stack vertically" assumes OpenSCAD renders are landscape. *Fix:* key the rule on aspect ratio, not Project type.

## 7. Inheritance discipline — adequate

Checked: PRD §3 terms used verbatim, and component names consistent across both files and with `.memlog.md`. Review, Correction, Owner Message, Parking Lot, Stuck, Iteration Budget, Degraded Evidence, Demo, Intake, Triage, Usage Window, Integration and Release are all used correctly. "Lap" follows UJ-5.

### Findings
- **medium** `.memlog.md` contradicts the spines. It logs before/after pairs "as 2-photo album" while the spines use a single composite image, and the Parking Lot action as 'Make Task' while the spines use `🅿️ P1 → Task` / `→ Task`. The EXPERIENCE.md Evidence-message row still allows "a two-photo album for a before/after pair the bot can't composite", which contradicts the DESIGN.md Don't: "Send before and after as unlabelled separate photos" (EXPERIENCE.md → Component Patterns → Evidence message; DESIGN.md → Do's and Don'ts). *Fix:* add a superseding memlog entry. Either drop the album fallback, or require burned-in BEFORE/AFTER labels on each album photo (an album shows only one caption).
- **medium** The notification rule disagrees with itself. Interaction Primitives says only Reviews, Stuck and Release failed make a sound, but State Patterns marks "Onboarding blocked" as a "Loud notice" (EXPERIENCE.md → Interaction Primitives vs State Patterns). *Fix:* add Onboarding blocked to the sound list, or make it silent.
- **low** The PRD term "Progress Peek" never appears verbatim. The spine says "Peek reply" and "Peek". The PRD's "Stuck message" becomes "Stuck card". *Fix:* add a glossary note to the IA: "Peek reply = Progress Peek (PRD); Stuck card = Stuck message (PRD)".
- **low** "Review" means the whole message set in the PRD, but in the rule "only Reviews … make a sound" it effectively means the Review card. *Fix:* say "the Review card (the last message of a Review)".

## 8. Shape fit — strong

DESIGN.md follows the canonical order: Brand & Style → Colors → Typography → Layout & Spacing → Shapes → Components → Do's and Don'ts. It omits Elevation & Depth, which is legitimate because Telegram owns depth. EXPERIENCE.md has Foundation, IA, Voice and Tone, Component Patterns, State Patterns, Interaction Primitives, Accessibility Floor, Inspiration & Anti-patterns and Key Flows, matching the examples. Responsive & Platform is omitted, which is right for a single surface. Both files' `sources` paths resolve.

### Findings
- **low** DESIGN.md frontmatter carries `status`, `updated` and `sources`, which are outside the spec's token keys. They are harmless to most parsers. *Fix:* keep them, or move them to a comment if a strict design.md linter is used.

## Mechanical notes

**Telegram Bot API feasibility check**
- Feasible as written:
  - `👀` via `setMessageReaction` (it is in the standard reaction set, provided the group hasn't restricted reactions).
  - `force_reply` in groups (use `selective: true`).
  - `disable_notification` per message.
  - `editMessageText` / `editMessageReplyMarkup` on the bot's own messages, with no time limit, so "edit in place" and late `📦 Released` updates work.
  - `answerCallbackQuery` toasts (≤200 chars; all spine toasts fit).
  - `setMyCommands` with chat scope for the `/` menu.
  - Captions: the evidence-caption pattern is well under the 1024-char limit. The Review card is a text message (4096 limit), so its card text is fine.
  - Inline keyboards only on single messages. The spine never puts buttons on an album; the card comes last, so this is correct.
- Needs a constraint stated:
  - Status-list "message links" (`t.me/c/{id}/{msg}`) work only in **supergroups**. Tapping one scrolls to the message; it does not "reply to the relevant card" as written (EXPERIENCE.md → Status list). Require supergroup conversion at binding, or use per-line buttons that make the bot re-reply to the card.
  - Privacy mode: changing it in BotFather takes effect in a group only after the bot is removed and re-added. Say "set privacy off **before** adding the bot" (EXPERIENCE.md → Foundation note).
  - Voice: bots don't get Telegram's built-in transcription. The bot must download the voice note and transcribe it server-side (an architecture note for FR-7).
  - `callback_data` is ≤64 bytes. Button payloads need short IDs, not Task titles.
  - Bot file upload limit is 50 MB (see section 4).
  - Late callback answers: see the Mac-asleep finding in section 4.
- Not infeasible: nothing in the spines requires an API capability that doesn't exist.

**Reference resolution:** every `{path.to.token}` resolves, apart from the placeholder collision in section 2. Frontmatter `sources` resolve to `docs/planning-artifacts/prds/prd-antipod-2026-11-01/{prd,addendum}.md`.

**FR → surface map (Telegram-facing):**

| Requirement | Surface |
|---|---|
| FR-1 | **no surface** |
| FR-3 | Bootstrap Review / Onboarding blocked |
| FR-6–9 | Draft card |
| FR-10 | Interpretation card |
| FR-13 | Stuck card |
| FR-14 | `/pause` `/resume` `/cancel` plus card edits (no response format for the commands) |
| FR-17 | Paused notice |
| FR-22 | Re-review composites |
| FR-24 | Demo message |
| FR-25 | `/evidence` |
| FR-26–27 | Review card |
| FR-28 | Correction prompt / Peek / Status / Stuck |
| FR-29 | Re-review row |
| FR-30 | Release lines and Release failed |
| FR-31 | Cost line / `/cost` (format undefined) |
| NFR-5 | `/log` (format undefined) |
| NFR-6 | `👀` and toasts (breaks while offline) |

**Finding counts:** critical 0 · high 5 · medium 14 · low 12.
