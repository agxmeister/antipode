# Landscape research digest (2026-11-01, web subagent)

- Closest comparable: Cursor cloud agents. Each runs in a VM, tests through the browser and attaches video, screenshots and logs to the PR. Copilot coding agent attaches Playwright screenshots to the PR. Devin, Codex, Jules, Factory and OpenHands are reviewed through the PR diff.
- Gap: none ties evidence to each acceptance criterion. Acceptance is still a PR merge. Spec tools (Kiro, Spec Kit) hold criteria but don't verify them. Mobile tools (Claude Remote Control, rclaude) approve tool calls, not results.
- Lessons: evidence must outlive branch deletion, so store it durably. Public, unauthenticated evidence URLs are a privacy risk.
- ToS (code.claude.com/docs/en/legal-and-compliance): subscription limits assume "ordinary, individual usage". Running the unmodified `claude` binary on your own subscription is allowed, including when hosted. Agent SDK builders should use API keys. Enforcement can happen without notice. Many concurrent 24/7 sessions are a risk.
- Limits: rolling 5-hour window plus weekly caps, shared across all containers. Sources conflict on whether subscription `claude -p` draws from a separate credit (unverified).
- Previews: Coolify PR previews (wildcard DNS, auto-cleanup), Dokku review apps, or Podman/compose per branch behind Traefik/Caddy.
