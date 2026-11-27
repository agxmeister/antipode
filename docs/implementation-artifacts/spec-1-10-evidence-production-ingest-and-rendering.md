---
title: 'Evidence production, ingest and rendering'
type: 'feature'
created: '2026-11-27'
status: 'in-progress'
baseline_commit: 'a472936beb2c9280e2acc9daa561ff54ca50c0ef'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-antipod-2026-11-05/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/ux-designs/ux-antipod-2026-11-05/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Task that passes validation reaches `evidencing`, and the Evidence Producer's output ends in `stage_failed(unhandled_output)`. Nothing ingests artifacts, there is no `evidence` table, `ANTIPOD_PRIOR` is always empty, the Validator's Evidence mode has no brief, and no renderer makes before/after composites (CAP-21, CAP-22, CAP-23, CAP-25 store; AD-7, AD-8, AD-20).

**Approach:** An Evidence output hook checks the artifacts, copies them into `data/evidence/` and writes immutable `evidence` rows in the `evidence_produced` transaction. A failed check gives `evidence_missing` with a reason the next Implementer brief carries. `verifying` briefs the Validator with the round's rows. Each Stage launch fills `ANTIPOD_PRIOR` from the last delivered round. A new `antipod-evidence` CLI (sharp, bundled Inter, DESIGN.md tokens) draws composites, labels and callouts.

## Boundaries & Constraints

**Always:**
- Ingest checks, in order, and any failure → `evidence_missing{reason}` with no file copied:
  - every `name` is relative, has no `..`, and resolves to a regular file in the `ANTIPOD_OUT` of one of this Stage's step runs, newest first;
  - every `criterion_id` is an active criterion;
  - every active criterion has at least one artifact;
  - `before_of` is an `evidence_id` from `prior/index.json` or the `name` of a `screenshot` in the same output;
  - each file is ≤ 50 MB;
  - each video (`.mp4`, `.mov`, `.m4v`) lasts ≤ 60 s, read from its `mvhd` box;
  - any other video extension (`.webm`, `.mkv`, `.avi`) is rejected as not playable inline.
- Ingest order (AD-8): copy each file to `data/evidence/<project>/<task_no>/r<review_round+1>/<evidence_id>.<ext>`, then `fsync` it. Then, inside the `evidence_produced` transaction, mark that round's earlier rows `superseded = 1` and insert the new rows. A name-based `before_of` is stored as the new row's `evidence_id`.
- Evidence rows and files are never updated or deleted, apart from the `superseded` flag. At boot, files under `data/evidence/` that have no row are deleted.
- `ANTIPOD_PRIOR` is rebuilt before every Stage launch of a numbered Task. It holds the rows of round `review_round` (empty in round 1) that are not superseded, as `<evidence_id>.<ext>`, plus `index.json` `[{evidence_id, criterion_id, kind}]`.
- `verifying` brief: the criteria plus one line per current-round row (id, `AC<n>`, kind, caption, degraded reason, absolute file path). The Validator Role may read that Task's Evidence directory.
- `evidence_verified` needs `pass` and a `shows_criterion: true` verdict for every current-round row. Anything less is `evidence_rejected`. The next Implementer brief lists the rejected verdict notes, or the `evidence_missing` reason.
- `antipod-evidence` is a second `bin`, shimmed into `run/bin` next to `antipod`. Its subcommands:
  - `composite --before <png|jpg> --after <png|jpg> --out <png>`: portrait images go side by side, landscape images stack, before on top;
  - `label --in --text --out`;
  - `callout --in --box x,y,w,h --out`.
- Every subcommand uses the DESIGN.md tokens: plate `#000000B3` with radius 8, ink `#FFFFFF`, Inter 600 at 28 px per 1080 px of width, pad 12, gap 8 with divider `#FFFFFF`, and a `#FFD400` 4 px stroke on a `#000000` 2 px halo. Inter is bundled, with its OFL license, and is selected through a package-local fontconfig file.

**Never:**
- No Telegram media, Evidence messages, Demo or Review card (1-11). The Stuck card's "last Evidence resent as media" also moves to 1-11. No `/evidence` command (1-15). No Progress Peek (1-15).
- The Telegram adapter never draws. No other code calls sharp.
- Never edit committed migrations 0001–0009.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy | One artifact per criterion | Files under `r1/`, rows, `verifying` | — |
| Missing AC | AC2 has no artifact | `evidence_missing` "no Evidence for AC2", budget +1 | — |
| Too big | 51 MB file | `evidence_missing` with the size | — |
| Too long | 61 s mp4 | `evidence_missing` with the duration | — |
| Bad before_of | unknown id | `evidence_missing` | — |
| Repeat | Second ingest in the same round | Earlier rows `superseded = 1` | — |
| Verified | All verdicts shown | `in_review`, `review_round` 1 | — |
| Rejected | One verdict false or missing | `implementing`, brief has the note | — |
| Round 2 prior | `review_round` 1 | `prior/` holds round-1 files and the index | — |
| Crash | File with no row | Deleted at boot | — |
| Composite | Portrait 1080×2400 pair | Side by side, BEFORE/AFTER plates | Bad input exits non-zero |

## Owner decisions (2026-11-27)

- **Rejected Evidence costs one budget unit.** SPEC CAP-13 wins over spine AD-3: `evidence_rejected` joins `COUNTING_CAUSES`. AD-3 was updated by Sprint Change Proposal 2026-11-27.
- **Stuck card media.** The "last Evidence resent as media" that 1-9 deferred moves to 1-11, which builds media sending for Evidence messages.
- **Scope.** One spec. The Owner kept it whole over the 1600-token target.

</frozen-after-approval>

## Code Map

- `src/adapters/sqlite/migrations/0010-evidence.ts` (new); register in `migrations/index.ts:18` -- `evidence(id, task_id, round, criterion_id, kind, path, bytes, degraded, before_of, caption, stage_id, superseded DEFAULT 0, created_at)`, index on `(task_id, round)`
- `src/core/ports/evidence-store.ts` (new), `src/adapters/sqlite/evidence-store.ts` (new) -- rows (`insertEvidence`, `supersedeRound`, `evidenceOf(taskId, round)`) and files (`put` with copy and fsync, `probe` for size and mp4 `mvhd` duration, `sweepOrphans`); AD-1 table: EvidenceStore = sqlite plus the data dir
- `src/core/domain/stage-output/evidence.ts` -- the schema already matches AD-8; reuse it
- `src/core/coordinator/evidence-ingest.ts` (new, pure) -- the check order above, over `{artifacts, criteria, priorIds, files: name→{path,bytes,durationS}}` → ok rows or reason
- `src/app/evidence.ts` (new) -- output hook for `evidence-producer` (register like Intake at `daemon.ts:275`); resolves names through step runs of the Stage (new `stepRunsOfStage` in `ports/store.ts:143` and the SQLite store); builds prior before launch
- `src/app/stages.ts:95-124` -- Evidence mode: require a verdict for every current-round row; `#prepare` (:303) calls the prior builder and adds role var `EVIDENCE_DIR`; `renderLoopBrief` (:579) adds `verifying` and `evidence-producer` cases and the Implementer lines for missing or rejected Evidence
- `src/core/domain/loop.ts` `lastLapOf` -- carry the `evidence_missing` reason and the rejected verdicts
- `src/core/coordinator/transitions.ts:102-109` -- add `evidence_rejected` to `COUNTING_CAUSES`; update the budget block in `test/core/coordinator/transitions.test.ts`
- `roles/validator/permissions.json`, `roles/validator/prompt.md`, `roles/evidence-producer/prompt.md` -- `Read(/{{EVIDENCE_DIR}}/**)`; the Producer is told that `name` is relative to a step's `ANTIPOD_OUT`, that `antipod-evidence --out` writes into that dir, and the fallback of two labelled images
- `src/adapters/evidence-render/` (new) -- `cli.ts`, `tokens.ts`, `fonts/Inter-SemiBold.ttf`, `fonts/OFL.txt`, `fonts.conf`; the CLI sets `FONTCONFIG_FILE` before it imports sharp; `package.json` adds `sharp@0.35` and `bin.antipod-evidence`
- `src/app/home.ts:66` -- `writeAntipodShim` also writes `antipod-evidence`
- `src/app/daemon.ts:285-292` -- boot recovery calls `sweepOrphans`
- Tests: `test/app/loop.test.ts:108-232` (extend to `in_review`), `test/helpers/claude.ts`, `test/helpers/steps.ts`, `test/app/stages.test.ts:495-510`

## Tasks & Acceptance

**Execution:**
- [x] Migration, `EvidenceStore` port and adapter, store `stepRunsOfStage` -- AD-2, AD-8
- [x] `evidence-ingest.ts` and `src/app/evidence.ts` hook, prior builder, boot sweep -- AD-7, AD-8, AD-18
- [x] `stages.ts`, `loop.ts` and roles -- Evidence-mode brief and verdict rule, Implementer brief lines -- AD-21
- [x] `adapters/evidence-render/`, `package.json`, `home.ts` -- renderer CLI and shim -- AD-20
- [x] `test/**` -- one test per matrix row; a renderer test that checks output size and the plate pixel colour -- AD-24

**Acceptance Criteria:**
- Given a scripted fake `claude` (Implementer `done`, Validator `pass`, Evidence Producer listing one artifact per criterion written by a fake `evidence` step, and the Validator in Evidence mode verifying them all), when an approved Task runs, then it reaches `in_review` with `review_round` 1. One unsuperseded row per artifact exists, and each file under `data/evidence/<project>/<n>/r1/` is byte-identical to the step output.
- Given `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, when run, then every command exits 0.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

- Decided: a Stage has no `ANTIPOD_OUT` of its own, so each `name` is looked up across the `ANTIPOD_OUT` of the Stage's step runs, newest first. This keeps AD-8's "relative to `ANTIPOD_OUT`" while one Stage runs several steps.
- Decided: the duration is read from the MP4/QuickTime `mvhd` box in plain Node. No ffprobe is installed, and Telegram plays only MP4 inline (CAP-23).
- Decided: the prior directory is a derived copy that is rebuilt before each launch. Steps already mount it read-only (`steps.ts:147-167`).

## Verification

**Commands:**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` -- expected: all exit 0
