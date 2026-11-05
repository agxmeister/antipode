---
name: Antipode
description: Phone-first acceptance surface for an autonomous dev factory, delivered as a Telegram bot. Proof before prose; one tap to judge.
status: final
updated: 2026-11-05
sources:
  - ../../prds/prd-antipod-2026-11-01/prd.md
  - ../../prds/prd-antipod-2026-11-01/addendum.md
colors:
  annotation-ink: '#FFFFFF'
  annotation-plate: '#000000B3'
  annotation-highlight: '#FFD400'
  annotation-halo: '#000000'
  composite-divider: '#FFFFFF'
typography:
  message:
    note: 'Telegram client native — the bot never sets fonts; it uses Telegram HTML parse mode only'
  emphasis:
    note: 'Telegram <b> — card title line and criterion labels only'
  code:
    note: 'Telegram <code> — versions, Task IDs in commands (/peek 12), file names'
  annotation-label:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.2
    note: 'Burned into Evidence images and composites at 1080px width; scales with the image. Inter is bundled with the Evidence renderer; never rely on system fonts.'
rounded:
  annotation: 8px
spacing:
  annotation-pad: 12px
  composite-gap: 8px
components:
  glyph-pass: { glyph: '✅', meaning: 'pass' }
  glyph-fail: { glyph: '❌', meaning: 'fail / failed step' }
  glyph-degraded: { glyph: '⚠️', meaning: 'Degraded Evidence or infeasible criterion' }
  glyph-pending: { glyph: '⏳', meaning: 'queued or running' }
  glyph-parked: { glyph: '🅿️', meaning: 'Parking Lot finding' }
  glyph-paused: { glyph: '⏸', meaning: 'paused' }
  glyph-stuck: { glyph: '🧱', meaning: 'Stuck' }
  glyph-released: { glyph: '📦', meaning: 'released / merged' }
  glyph-ack: { glyph: '👀', meaning: 'Owner Message received (reaction)' }
  glyph-question: { glyph: '❓', meaning: 'question awaiting the Owner' }
  evidence-caption:
    pattern: '<b>#${task-id} · AC${n}</b> ${glyph} ${criterion-label}'
    maxLength: 1024
  review-card:
    titlePattern: '<b>#${task-id} · ${task-title}</b>'
    maxProseLines: 5
  draft-card:
    titlePattern: '<b>#${task-id} · ${task-title}</b> · draft'
  interpretation-card:
    titlePattern: '<b>#${task-id}</b> · understood as:'
  stuck-card:
    titlePattern: '🧱 <b>#${task-id} · ${task-title}</b> · Stuck'
  peek-reply:
    captionPattern: '${role} · ${status-line} · lap ${n}/${budget} · ${elapsed}'
  cost-line:
    pattern: '~${tokens} tok · ${minutes} min · ${window-share}% window'
  before-after-composite:
    labelBackground: '{colors.annotation-plate}'
    labelColor: '{colors.annotation-ink}'
    labelType: '{typography.annotation-label}'
    divider: '{colors.composite-divider}'
    gap: '{spacing.composite-gap}'
    labelRadius: '{rounded.annotation}'
  callout-box:
    stroke: '{colors.annotation-highlight}'
    strokeWidth: 4px
    halo: '{colors.annotation-halo}'
    haloWidth: 2px
---

## Brand & Style

Antipode has no screens of its own. Its visual identity is a set of disciplined Telegram messages plus the Evidence images Antipode generates. Everything that can be inherited from the Telegram client is inherited: fonts, bubble shapes, light and dark themes, button styling. Antipode controls only three things:

1. **Message composition:** what comes first, what is bold, which glyphs mark state.
2. **Generated imagery:** before/after composites, label plates and callout boxes burned into Evidence.
3. **Bot identity:** name, avatar and group naming.

The posture is a competent team lead's status report (PRD §8). Outcome first, proof before prose, no decoration. A Review should read like a well-labelled photo set with a verdict line under it, not like a chat transcript.

Bot name: **Antipode**. `[ASSUMPTION: the working title from the PRD is kept; the avatar is a plain monogram on a neutral background, so nothing is designed before the name is confirmed.]` Group naming: `Antipode · ${Project name}` (e.g. `Antipode · Training`), so the chat list groups the Project chats together.

Placeholders in patterns are written `${name}`. Token references are written `{path.to.token}`. The two never mix.

## Colors

The Telegram client owns every color in the chat, including theme, bubbles and buttons. The tokens here apply **only to images Antipode generates**, such as composites and annotated screenshots. They must read on top of arbitrary app screenshots in both light and dark app themes.

- **Annotation plate (`#000000B3`, RGBA hex, 70% alpha)** is a translucent black plate behind every burned-in label ("BEFORE", "AFTER", "AC2"). It is used so labels read over any content.
- **Annotation ink (`#FFFFFF`)** is the label text on the plate. Against the plate's effective background it is above 7:1.
- **Annotation highlight (`#FFD400`)** is the stroke of a callout box that points at the region a criterion is about. It is never used as a fill. It always sits on a `{colors.annotation-halo}` outer stroke, so it stays visible over light screenshots, where yellow alone has too little contrast.
- **Annotation halo (`#000000`)** is the 2px outer stroke around every callout.
- **Composite divider (`#FFFFFF`)** is the vertical gap line between the before and after halves.

`[ASSUMPTION: these are neutral, function-only values, not a brand palette. Revisit if the Owner wants a brand accent.]`

Avoid: pass/fail color coding inside images (state lives in the caption glyph), tinted overlays that change the app's real colors, and watermarks.

## Typography

Messages use Telegram HTML parse mode and nothing more:
- `<b>` for the card title line and criterion labels only.
- `<code>` for Task IDs inside commands, versions and file names.
- No italics, underline, spoilers or headings made of emoji.

Burned-in labels use `{typography.annotation-label}`: one weight, uppercase for BEFORE/AFTER, sentence case for anything else.

## Layout & Spacing

Messages: one fact per line. Lines start with a glyph when they carry a state. Use a blank line only between blocks of a card, never inside a block.

Composites: before on the left, after on the right, at equal scale, separated by `{spacing.composite-gap}`. Labels sit top-left of each half, inset `{spacing.annotation-pad}`. The layout follows the image's aspect ratio, not the Project type. Portrait images go side by side. Landscape images stack vertically, before on top. `[ASSUMPTION]`

## Shapes

Only label plates have shape: `{rounded.annotation}`. Callout boxes are square-cornered so they don't look like app UI.

## Components

Each card lists its blocks top to bottom. "Buttons" are inline-keyboard rows; one row is one line of buttons.

- **Glyph vocabulary.** These are the only state glyphs (`{components.glyph-pass}` … `{components.glyph-question}`). Each has one meaning and is always followed by text, so the glyph never carries the meaning alone.
- **Evidence message.** A photo or video with its caption per `{components.evidence-caption.pattern}`. A Degraded caption adds ` · degraded: ${reason}` on the same line. The Task ID prefix keeps interleaved messages attributable.
- **Before/after composite.** A single image with two labelled halves (`{components.before-after-composite}`). After a Correction, the "before" half is the previous Review's Evidence (FR-22). If compositing fails, send two separate photos, each with its own burned-in BEFORE/AFTER label and full caption. Never send an album.
- **Callout box.** An optional stroke rectangle with a halo (`{components.callout-box}`) around the region a criterion describes. The Evidence Producer adds it when the change is small within a full screen.
- **Demo message.** A file (APK/STL) or a link, with the caption `Demo · ${what to try}`. Any file that exceeds the Telegram bot upload limit is replaced by an authenticated link with the caption `Demo · ${what to try} · link (file too large)`.
- **Review card.**
  1. Title `{components.review-card.titlePattern}`. On a re-review the title line is followed by `Changed: ${one line}`.
  2. One-line summary.
  3. Criteria strip: `AC1 ✅ AC2 ✅ AC3 ⚠️`.
  4. Parking Lot lines: `🅿️ P${n} ${finding}`.
  5. Cost line `{components.cost-line.pattern}`.
  6. Buttons. Row 1: `Accept` · `Request changes`. Row 2: Parking Lot buttons.

  Prose beyond the labels is capped at `{components.review-card.maxProseLines}` lines (FR-26). After a tap, the buttons are removed and a state line is appended.
- **Draft card.**
  1. Title `{components.draft-card.titlePattern}`.
  2. `Goal: ${one line}`.
  3. Criteria, numbered: `AC${n} ${label} · ${evidence kind}`. An infeasible criterion shows `⚠️` and its proposed substitute.
  4. Questions: `❓ Q${n} ${question}`.
  5. `Approve after: …` line, while anything is still open.
  6. Buttons, one row per question: quick answers. Then one row per infeasible criterion: `Use proposal` · `Drop AC${n}`. Last row: `Approve` (once everything is resolved) · `Discard`.
- **Interpretation card.**
  1. Title `{components.interpretation-card.titlePattern}`.
  2. One line per instruction (`Drop AC2` · `New draft: "…"`).
  3. Buttons: `Confirm` · `Edit`.
- **Stuck card.**
  1. Title `{components.stuck-card.titlePattern}`.
  2. Triage reason (one line).
  3. Up to 3 lines of attempts, `Lap ${n}: ${what}`.
  4. Buttons. Row 1: `Raise budget +2` · `Cancel Task`.
  5. Footer: `Or reply to amend or drop a criterion.`
- **Correction prompt.** A single line `What should change on #${task-id}?`, sent as a force-reply. No buttons.
- **Peek reply.** The latest visual, with the caption `{components.peek-reply.captionPattern}`. If there are no visuals yet, the same line is sent as text.
- **Status list.** Blocks with bold headers: **Needs you**, **Running**, **Queued**, **Done** (last 5). One line per Task: `${glyph} #${id} ${title} · ${state}`. Every line in Needs you is a message link to its card. The list ends with `Elsewhere: …`.
- **Parked list.** One message per finding: `🅿️ P${n} ${finding} (from #${task-id})`, with buttons `→ Task` · `Dismiss`.
- **Cost reply.** Three blocks: **This window** (`${share}% used · resets ~${time}`), **By Task** (top 5, each as a cost line), **This Project** (a total cost line). `[ASSUMPTION]`
- **Inline buttons.** Primary actions are text-only and verb-first: `Accept`, `Request changes`, `Approve`, `Discard`, `Confirm`. Glyphs appear on buttons only for the Parking Lot (`🅿️ P1 → Task`).

## Do's and Don'ts

| Do | Don't |
|---|---|
| Lead with media; put the card with buttons last | Put buttons above Evidence the Owner hasn't seen yet |
| One glyph per state, always followed by a text label | Use decorative emoji, emoji headings or color as the only signal |
| Burn BEFORE/AFTER labels into every before/after image | Send before/after as an album or as unlabelled photos |
| Prefix every Evidence caption with the Task ID | Rely on message order to say which Task media belongs to |
| Use Telegram's native rendering for everything in chat | Imitate custom UI with box-drawing characters or ASCII tables |
| Use `<b>` sparingly: title and criterion labels | Bold whole sentences or use italics for tone |
