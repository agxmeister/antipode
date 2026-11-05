---
name: Antipode
description: Phone-first acceptance surface for an autonomous dev factory, delivered as a Telegram bot. Proof before prose; one tap to judge.
status: draft
updated: 2026-11-05
sources:
  - ../../prds/prd-antipod-2026-11-01/prd.md
  - ../../prds/prd-antipod-2026-11-01/addendum.md
colors:
  annotation-ink: '#FFFFFF'
  annotation-plate: '#000000B3'
  annotation-highlight: '#FFD400'
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
    note: 'Burned into Evidence images and composites at 1080px width; scales with the image'
rounded:
  annotation: 8px
spacing:
  annotation-pad: 12px
  composite-gap: 8px
components:
  glyph-pass: '✅'
  glyph-fail: '❌'
  glyph-degraded: '⚠️'
  glyph-pending: '⏳'
  glyph-parked: '🅿️'
  glyph-paused: '⏸'
  glyph-stuck: '🧱'
  glyph-released: '📦'
  glyph-ack: '👀'
  evidence-caption:
    pattern: '<b>AC{n}</b> {glyph} {criterion-label}'
  review-card:
    titlePattern: '<b>#{task-id} · {task-title}</b>'
    maxProseLines: 5
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
---

## Brand & Style

Antipode has no screens of its own. Its visual identity is a set of disciplined Telegram messages plus the Evidence images Antipode generates. Everything that can be inherited from the Telegram client is inherited: fonts, bubble shapes, light and dark themes, button styling. Antipode controls only three things:

1. **Message composition:** what comes first, what is bold, which glyphs mark state.
2. **Generated imagery:** before/after composites, label plates and callout boxes burned into Evidence.
3. **Bot identity:** name, avatar and group naming.

The posture is a competent team lead's status report (PRD §8). Outcome first, proof before prose, no decoration. A Review should read like a well-labelled photo set with a verdict line under it, not like a chat transcript.

Bot name: **Antipode**. `[ASSUMPTION: the working title from the PRD is kept; the avatar is a plain monogram on a neutral background, so nothing is designed before the name is confirmed.]` Group naming: `Antipode · {Project name}` (e.g. `Antipode · Training`), so the chat list groups the Project chats together.

## Colors

The Telegram client owns every color in the chat, including theme, bubbles and buttons. The tokens here apply **only to images Antipode generates**, such as composites and annotated screenshots. They must read on top of arbitrary app screenshots in both light and dark app themes.

- **Annotation plate (`#000000B3`)** is a translucent black plate behind every burned-in label ("BEFORE", "AFTER", "AC2"). It is used so labels read over any content.
- **Annotation ink (`#FFFFFF`)** is the label text on the plate.
- **Annotation highlight (`#FFD400`)** is the stroke of a callout box that points at the region a criterion is about. It is never used as a fill.
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

Messages: one fact per line. Lines start with a glyph when they carry a state. Use a blank line only between blocks of the Review card (criteria / Parking Lot / cost), never inside a block.

Composites: before on the left, after on the right, at equal scale, separated by `{spacing.composite-gap}`. Labels sit top-left of each half, inset `{spacing.annotation-pad}`. Portrait phone screenshots go side by side. Landscape renders (Unity, OpenSCAD) stack vertically, before on top. `[ASSUMPTION]`

## Shapes

Only label plates have shape: `{rounded.annotation}`. Callout boxes are square-cornered so they don't look like app UI.

## Components

- **Glyph vocabulary.** These are the only state glyphs Antipode uses. Each glyph has one meaning and is always followed by text, so the glyph never carries the meaning alone:
  `✅` pass · `❌` fail · `⚠️` Degraded Evidence · `⏳` pending/running · `🅿️` parked finding · `⏸` paused · `🧱` Stuck · `📦` released · `👀` "received" reaction on an Owner Message.
- **Evidence caption.** `{components.evidence-caption.pattern}`. A Degraded caption adds ` · degraded: {reason}` on the same line.
- **Review card.** A title line `{components.review-card.titlePattern}`, a one-line summary, a criteria strip (`AC1 ✅ AC2 ✅ AC3 ⚠️`), Parking Lot lines, a cost line, then inline buttons. Prose is capped at `{components.review-card.maxProseLines}` lines beyond the labels (FR-26).
- **Inline buttons.** Primary actions are text-only and verb-first: `Accept`, `Request changes`, `Approve`, `Discard`. Glyphs appear on buttons only for the Parking Lot (`🅿️ P1 → Task`).
- **Before/after composite.** A single image with two labelled halves (`{components.before-after-composite}`). After a Correction, the "before" half is the previous Review's Evidence (FR-22).
- **Callout box.** An optional stroke rectangle (`{components.callout-box}`) around the region a criterion describes, added by the Evidence Producer when the change is small within a full screen.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Lead with media; put the card with buttons last | Put buttons above Evidence the Owner hasn't seen yet |
| One glyph per state, always followed by a text label | Use decorative emoji, emoji headings or color as the only signal |
| Burn BEFORE/AFTER labels into composites | Send before and after as unlabelled separate photos |
| Use Telegram's native rendering for everything in chat | Imitate custom UI with box-drawing characters or ASCII tables |
| Use `<b>` sparingly: title and criterion labels | Bold whole sentences or use italics for tone |
