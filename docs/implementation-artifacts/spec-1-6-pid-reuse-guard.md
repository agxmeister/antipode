---
title: 'Pid-reuse guard for host step recovery'
type: 'bugfix'
created: '2026-11-14'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/implementation-artifacts/spec-1-6-step-runners.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Boot recovery (`killSteps` in `src/adapters/host/runner.ts`, AD-18) SIGKILLs the process group named by `data/steps/<step_run_id>/pid` without checking that the pid still belongs to the step. After a reboot, or when the step died while the daemon was down, the pid may have been reused by an unrelated Owner process, whose group would be killed.

**Approach:** Record the step leader's start time with its pid at spawn, and at recovery kill the group only when the process identity still matches: the leader is alive with the same start time, or the leader is gone and surviving members of that process group started no earlier than the recorded start (a pid is not reused while a process group with that id exists). Otherwise skip and log. Also drop the deferred-work entry about Projects registered before migration 0006: the Owner confirmed none exist.

</frozen-after-approval>

## Implementation Notes

- Start time is epoch seconds computed as `now - etime` from `ps -o etime=` (portable to macOS and Linux, no locale or date parsing); compared with a 2 s tolerance because `etime` has one-second resolution. The process table is read once per recovery with `ps -A -o pid=,pgid=,etime=`.
- Pid file format is now `<pid> <start_epoch_s>`. A pid file without a start time (written before this fix, or when `ps` failed at spawn) is skipped and logged: no identity, no kill.
- Leader gone and group members left: kill only if every member's start is ≥ recorded start − tolerance; any older member means the pgid is not ours.
- `ps` lives only in `adapters/host/` (AD-19). The process table reader is injectable for tests.
- Boot is dated by pid 1's start in the same process table: a pid file recorded before boot is never killed (`host restarted`), which closes the reboot case where a reused pgid has only members left.
- Spawn looks up only the leader (`ps -p`); every `ps` call has a 10 s timeout.
- `deferred-work.md`: removed the 1-6 entry on Projects registered before migration 0006 (Owner, 2026-11-14: no such Projects exist) and the 1-6 pid-reuse entry (resolved here).
- Files: `src/adapters/host/runner.ts`, `test/adapters/host/runner.test.ts`, `test/app/steps.test.ts`, `test/app/daemon.test.ts`.

## Review Triage Log

Pass 1 (2026-11-14), blind layer only (one-shot route).

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | Leader-gone rule passes after a reboot | medium | After a reboot every process is younger than the record; an unrelated group with that pgid and an exited leader would be killed | patch (boot from pid 1) |
| 2 | Skipped kill leaves a step running with its lease cleared; Owner not told | maybe-false | Only a wrongly spared real step matters; with the identity recorded at spawn that needs a clock jump (#5) or a failed `ps` | reject; see #5 |
| 3 | Pid files from before the upgrade are never killed | false | No Stage can request a step before 1-7, so no live pre-fix pid file exists | reject |
| 4 | One failed `ps` skips the remaining steps with one log line | low | Simple fix | patch (log every skipped id) |
| 5 | Wall-clock start time vs 2 s tolerance | maybe-false | macOS keeps process start as wall time, so `now - etime` is stable; Linux derives it from boot time plus ticks, so an NTP step could shift it. Settle by stepping the clock on the Linux VM host with a live step | defer |
| 6 | `execFileSync` of the full table on every spawn, no timeout | low | Simple fix | patch (`ps -p <pid>`, 10 s timeout) |
| 7 | `killLeased` doc comment stale | low | Direct correction | patch |
| 8 | Untested paths (`parseElapsed`, `writePidFile` fallback, `ps` failure, combined skip test) | low | Cheap tests | patch |
| 9 | Spec incomplete, deferred removal untraced | low | One-shot spec format; trail added above | patch |
| 10 | Skip log lacks recorded/observed starts | low | Simple fix | patch |
