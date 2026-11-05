# Validation Report — antipod

- **DESIGN.md:** `docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/DESIGN.md`
- **EXPERIENCE.md:** `docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/EXPERIENCE.md`
- **Run at:** 2026-11-05
- **Lenses:** rubric walker only (Owner's choice)

## Overall verdict
Lean, on-voice and buildable on the real Telegram Bot API. The review found nothing that needs a Bot API capability Telegram lacks. Before fixes, a clean source-extract was blocked by: a missing onboarding flow (FR-1), a placeholder/token syntax collision, two everyday states with no treatment (offline, Intake failure) and visual specs for the Review card only. All 5 high findings and all 14 mediums are fixed in the spines. 10 of 12 lows are fixed, and 2 are deliberately left (see below).

## Category verdicts (as reviewed → after fixes)
- Flow coverage — adequate → strong (Flow 0 onboarding; failure path per flow)
- Token completeness — adequate → strong (`${}` placeholders; glyphs as objects; callout halo)
- Component coverage — thin → adequate (block specs for every card)
- State coverage — thin → adequate (offline, Intake failure, empty states, delivery limits, interleaving)
- Visual reference coverage — strong
- Bloat & overspecification — strong
- Inheritance discipline — adequate → strong (PRD name mapping; memlog superseded)
- Shape fit — strong

## Findings by severity

### Critical (0)

### High (5) — all fixed
- **Flow coverage** — No onboarding flow for FR-1 → added Flow 0, the `/register` surface and Registration-failed state.
- **Tokens** — `{n}`-style placeholders collided with token syntax → `${…}` everywhere, with the rule stated in Brand & Style.
- **Components** — 8 cards had no visual spec → block order, bold rules and button rows for each in DESIGN.md Components.
- **States** — Mac asleep or bot offline → on wake: queued updates processed in order, late taps answered by reply, stale `/peek` dropped, NFR-6 suspended while offline.
- **States** — Intake/transcription failure → `👀` swapped for `❌` plus a resend prompt.

### Medium (14) — all fixed
FR-26 ordering stated as a deliberate reading (with a NOTE FOR PM) · cost-line, `/cost` and `/log` formats (log sent as a file, no links) · Iteration Budget after an amendment (fresh budget at the contract default; `Raise budget +2` adds 2) · Interpretation card vs Stuck buttons (buttons are the confirmation) · failure paths in Flows 2–6 · Evidence archive / Lifecycle notices rows · free text that isn't actionable · empty states · 50 MB upload limit → Demo link; preview waking; send failure · interleaved Reviews (one Review sequence at a time per group, plus Task ID in captions) · album fallback removed · Onboarding blocked added to the sound list · glyph tokens as objects · callout halo for contrast · memlog superseded.

### Low (12) — 10 fixed, 2 left
Fixed: Undo keyboard sequence · FR-14 restart warning · callout rule · composite layout by aspect ratio · `annotation-label` lineHeight and bundled font · RGBA note · PRD name mapping · Review-card sound wording · omitted blocks rule · supergroup/privacy constraints.
Left as-is: optional trim of the avatar paragraph · non-spec frontmatter keys (`status`, `updated`, `sources`). Both are harmless.

## Reviewer files
- `review-rubric.md`
