# Success metrics

How the MVP is judged after it runs. SPEC.md → Success signal carries SM-1 and SM-2; this file holds the full set, including what must *not* be optimized.

## Primary

| Id | Metric | Validates |
| --- | --- | --- |
| SM-1 | Within about 3 weeks of the first Project's bootstrap, the Owner uses the Android training tracker for real workouts, having steered most of its development from the phone | CAP-7, CAP-26..28 |
| SM-2 | Median Owner time per Review is about 1 minute and never above 2 minutes, including watching the Evidence (NFR-1) | CAP-23, CAP-26 |

## Secondary

| Id | Metric | Validates |
| --- | --- | --- |
| SM-3 | At least 70% of Tasks are accepted with at most one Correction | CAP-8, CAP-19, CAP-21 |
| SM-4 | At most 15% of Tasks become Stuck | CAP-13 |
| SM-5 | At least one Task is accepted in each of the three Project types (Android, Unity, OpenSCAD) | CAP-2, CAP-4 |

## Counter-metrics (do not optimize)

| Id | Metric | Why it is watched, not targeted |
| --- | --- | --- |
| SM-C1 | Reviews per week | More is not better: many tiny Tasks push routine work back onto the Owner. Counterbalances SM-2 |
| SM-C2 | First-try Accept rate on its own | Pushing it up can mean weak criteria or cosmetic Evidence. Counterbalances SM-3 |
| SM-C3 | Tokens per Task on its own | A cheap Task that needs extra Corrections costs Owner time, the scarcest resource. There is no cost target; cost is reported (CAP-31), not optimized |

## Decision trigger

After Antipode has run daily for one week, the Owner decides whether API-key mode moves into the MVP (SPEC.md → Constraints, first item).
