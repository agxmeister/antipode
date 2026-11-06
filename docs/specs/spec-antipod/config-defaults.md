# Config defaults

Initial values for `$ANTIPOD_HOME/config.yaml` and the shipped `roles/<role>/role.yaml`. Chosen on 2026-11-06 as reasonable starting points, to be corrected after the first Project runs (PRD OQ8). Every value is Owner-overridable per the layering in spine AD-15; a Task Contract may override `iteration_budget`.

## Limits (`config.yaml`)

| Key | Default | Note |
| --- | --- | --- |
| `limits.iteration_budget` | 5 | Implementer runs per Task (CAP-13); `Raise budget +2` adds 2 |
| `limits.concurrency` | 2 | Range 1–3 (CAP-15) |
| `limits.open_reviews` | 3 | Global backpressure (CAP-16) |
| `limits.undo_accept_ms` | 10000 | Undo after Accept |
| `limits.undo_discard_ms` | 60000 | Undo after Discard |
| `usage.pause_at_percent` | 85 | Hold new Stages when either window's utilization reaches this |
| `usage.poll_interval_ms` | 60000 | Window reader cadence; also sampled after every Stage |
| `intake.retries` | 2 | Before `👀` becomes `❌` |
| `intake.context_messages` | 10 | Owner and bot messages of the Task carried into the Intake brief |
| `outbox.retries` | 5 | Before a delivery-failure notice |
| `telegram.stale_after_ms` | 300000 | Older updates answered by reply; stale `/peek` dropped |

## Roles (`role.yaml`)

| Role | `timeout` | `retries` | `max_turns` |
| --- | --- | --- | --- |
| intake | 5m | 2 | 25 |
| implementer | 45m | 2 | 150 |
| validator | 20m | 2 | 60 |
| evidence-producer | 30m | 2 | 80 |
| triage | 5m | 2 | 15 |

Retries relaunch the same Stage and never consume Iteration Budget (spine AD-4).

## Usage Window reading (resolves PRD OQ4)

Spike run 2026-11-06 on the Owner's Mac with Claude Code 2.1.319:

- `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <accessToken>` and `anthropic-beta: oauth-2025-04-20` returns HTTP 200. The token is the `claudeAiOauth.accessToken` field of the macOS Keychain item `Claude Code-credentials`; it expires roughly daily and Claude Code refreshes it on its own runs.
- Response fields the `WindowReader` maps: `five_hour.utilization` (percent), `five_hour.resets_at`, `seven_day.utilization`, `seven_day.resets_at`, plus a `limits[]` array with `kind`, `percent`, `severity`, `resets_at`. Everything else is ignored.
- The endpoint is undocumented. The adapter reads the Keychain on every call, treats 401 and any schema change as `null`, and the core estimator takes over (spine AD-12). A reading is a measurement, not an estimate, when it succeeds.
- Observation: the stored credential's `subscriptionType` is `team`. The subscription-terms constraint and the API-key decision trigger are unchanged, but the Owner should know which plan the factory draws on.
