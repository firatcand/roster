# Changelog

All notable changes to `@firatcand/roster` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

Per-phase retrospectives live in [`docs/retros/`](docs/retros/) and carry the long-form rationale; this file is the short, user-facing version.

## [Unreleased] — v0.4.0 — Guided Agent Authoring

### Added

- **Guided dialogue mode for `/chief-of-staff create-agent`.** TTY invocations now run a five-phase interview (prose intake → classify → targeted follow-ups → consolidated preview → atomic write) that produces a fully populated `agent.md`, real `subagents/<name>.md` files, an optional starter `plans/<plan>.yaml`, and a ≤ 80-character slash-command description. The dialogue obeys an anti-fabrication invariant: gaps surface as questions, never as plausible-looking defaults. (ROS-49, ROS-50, ROS-51)
- **Atomic write contract with rollback.** Phase 5 enumerates every directory and file the transaction creates, writes `agent.md` last so any contract-aware reader observes either no agent or a complete one, and on failure (or SIGINT during Steps 4–5) walks the rollback list in reverse to leave the workspace clean. Residual paths are surfaced explicitly when cleanup is incomplete. (ROS-52)
- **`scripts/new-agent.sh --slash-only <function> <agent>`** recovery flag for the rare case where the agent tree write succeeds but `.claude/commands/<agent>.md` doesn't (e.g., permission error on the commands dir). Writes only the slash command; refuses to clobber an existing file. (ROS-53)

### Changed

- **Breaking — TTY users see an extra prompt the first time they run `/chief-of-staff create-agent`.** The skill asks *"Empty scaffold, or design this agent together?"* before any write. Set `AGENT_TEAM_NO_CONFIRM=1` to skip the prompt and force stub mode — same behavior as v0.1 / v0.2 / v0.3. Non-TTY contexts (CI, piped stdin, scripts) get stub mode automatically and require no changes.

## [0.1.0] — 2026-05-12

Initial public release. Phase 1 retrospective: [`docs/retros/phase-1.md`](docs/retros/phase-1.md).

### Added

- `roster install` — copies the `chief-of-staff` skill and `lesson-drafter` agent into `~/.claude/skills/` and `~/.claude/agents/`. Idempotent. Handles symlinks and `EACCES`.
- `roster init <name>` — writes the minimal workspace (`CLAUDE.md` with `{{PROJECT_NAME}}` substituted, `projects/_demo/` placeholder, gitignore-defaults appended idempotently).
- `roster --help` / `roster --version`, exit codes 0/1/2/3.
- Tool detection limited to `~/.claude/` in this release; Codex CLI and Gemini CLI targets land in v0.2.0.

[Unreleased]: https://github.com/firatcand/roster/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/firatcand/roster/releases/tag/v0.1.0
