# Antipode PRD — Addendum

Depth that belongs downstream (architecture, UX), not in the PRD itself.

## Technical direction carried from the forge (for architecture)

- **Runtime:** Podman for Container Runners on the Owner's Mac. Host Runner for tools that can't run in Linux containers on macOS: the Unity editor, and the Android emulator (there's no nested virtualization inside Podman's macOS VM).
- **Agents:** the unmodified Claude Code CLI, one ephemeral session per Stage, each started in its own container or sandboxed host workdir.
- **Messaging:** a Telegram bot as the only Owner interface. Media (photos, videos ≤ 60 s, APK/STL files) are sent inline, so Evidence is readable even when no Demo URL is reachable.
- **Previews/Demos by Project type:**
  - Android: build the APK per Branch, send it as a Telegram file, and record emulator screencasts via `adb screenrecord`.
  - Unity: play-mode recordings and screenshots (e.g. via the Uplink Unity MCP bridge), with an optional WebGL build as a Demo.
  - OpenSCAD: multi-angle renders and a validation/printability check (loom MCP), and the STL as a Demo file.
  - Web-type projects (future): a per-Branch container behind a reverse proxy (Traefik/Caddy) with wildcard hostnames on a private network. Coolify-style PR previews are the reference pattern.
- **Previews sleep on inactivity.** They're the only long-lived cost. Agent sessions never idle while waiting on the Owner.

## Post-MVP host: dedicated VM

The Owner's Mac is the MVP host only. A dedicated VM is the intended next host. Implications for architecture:
- Keep the Coordinator, Container Runners and the Telegram bot host-agnostic.
- Host Runner steps are the portability risk:
  - The Android emulator needs a VM with KVM or nested virtualization.
  - The Unity editor on Linux needs a license, and may need a GPU or software rendering for recordings.
- Recipes should treat "Host Runner" as "a named capability of the host", not as "macOS".

## Rejected alternatives (with reasons)

- **Orchestrator agent** — rejected. It is nondeterministic and loses state on restart. Replaced by a deterministic Coordinator plus a bounded Triage Stage.
- **Shared working tree across agents** — rejected in favour of a Branch per Task. Simultaneous edits to one tree are unsafe.
- **Stacked Branches** — rejected for MVP. Dependents wait for merge.
- **Mandatory live preview (forge "demo-first")** — replaced by evidence-first. Unity and OpenSCAD have no natural live URL, and an Android preview is an APK, not a URL.
- **"Every merge deploys to prod"** — generalized to a Recipe-defined Release, which may be none.
- **Web UI in MVP** — cut. The Owner already carries Telegram.

## Research context

See `research-landscape.md`. Closest comparable is Cursor cloud agents (video and screenshots attached to the PR). No tool ties Evidence to each Acceptance Criterion, and none moves acceptance off the PR.
