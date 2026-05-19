# Changelog

All notable changes to `@firatcand/roster` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

Per-phase retrospectives live in [`docs/retros/`](docs/retros/) and carry the long-form rationale; this file is the short, user-facing version.

## [Unreleased]

## [0.4.0] — 2026-05-19

This release rolls up Phases 2 (Core Features), 2.5 (Scheduling Primitives), and 4 (Guided Agent Authoring) — all of which landed on `main` after v0.1.0 but never shipped as separate npm releases. v0.4.0 is roster's first feature-complete release: full multi-tool install, the complete skill set, scheduling, doctor, migrate, and guided agent authoring.

Per-phase retros: [phase-2](docs/retros/phase-2.md), [phase-2.5](docs/retros/phase-2.5.md), [phase-4](docs/retros/phase-4.md). Scheduling architecture: [ADR-0001](docs/adr/0001-scheduling-architecture.md).

### Added

**Core surface — Phase 2 (closed 2026-05-14)**

- Multi-tool install — Codex CLI and Gemini CLI join Claude Code. `roster install --all` and `--tool <name>` for non-interactive flows. Codex uses flat `.md` files in `~/.codex/prompts/`; Claude and Gemini use dir-per-skill. (ROS-13, ROS-15, ROS-16)
- Full skill set — `dreamer`, `sdr`, and `chief-of-staff` skills with companion agents; `gtm/`, `product/`, `design/`, `ops/` `EXPERT.md` documents. (ROS-9, ROS-12)
- Full workspace scaffold — `roster init` lays down `gtm/`, `product/`, `design/`, `ops/`, `chief-of-staff/`, `dreamer/`, `projects/_demo/`, `scripts/`, `conventions.md`. Non-destructive on re-run, forge-aware (detects `BRIEF.md` / `spec/PRD.md` / `plans/phases.yaml`). (ROS-17, ROS-18)
- `roster doctor` — audits installed skills and agents per tool, exits 1 on drift. (ROS-19)
- `pnpm e2e` SDR contract gate — `test/e2e-sdr.sh` asserts the `/sdr` agent contract structurally so CI catches regressions of the `/sdr run cold-outreach for _demo` path. (ROS-20)
- Structured error UX with `--debug`, path-traversal security audit, GitHub Actions CI gates (smoke + e2e).

**Scheduling — Phase 2.5 (closed 2026-05-18)**

- `CONTEXT.md` architecture — `roster init` writes `CONTEXT.md` and symlinks `CLAUDE.md` / `AGENTS.md` to it on macOS/Linux (dual-write on Windows). One workspace opens cleanly in both Claude Code and Codex CLI. (ROS-31)
- `roster-orchestrator` skill — bootstrapped on every fresh CLI session from `CONTEXT.md`; dispatches subagents in isolated context. Installed into both Claude and Codex with per-tool body. (ROS-32, ROS-33)
- `roster schedule install --tool <claude|codex>` — Claude Code gets a UI hand-off spec for Desktop Scheduled Tasks (no JSON-import API; tracked under [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)). Codex CLI gets an Automation hand-off by default, plus opt-in `--via cron` programmatic path that writes a hardened crontab line wrapped by `env -i` with a `subscription_attestation` block. (ROS-34, ROS-35)
- `roster schedule list / remove / status / run / validate / estimate-usage` — full lifecycle commands. `--dry-run` is uniform across `schedule install/run/remove` and `doctor`. (ROS-36, ROS-41, ROS-44, ROS-45)
- HITL pending queue — filesystem queue at `roster/<function>/pending/`; `roster review` surfaces items; `roster hooks install` wires a SessionStart banner so pending items show in any chat session. (ROS-37)
- Failure observability — cron exit codes captured in sibling `.exit` / `.events.jsonl` files; `roster pending sync` synthesizes `error-<id>.md` items from non-zero exits and stale fires (idempotent via 8-char hash); `roster doctor` cross-references stale fires. (ROS-42)
- `roster doctor` extensions — scheduling drift (`schedules.yaml` ↔ crontab), subscription-safety (refuses installed skills that import the Anthropic SDK or call `claude -p`), secrets (`.env` 0600), Codex Windows TOML workaround, alt-skill-path detection. `--fix` mode repairs symlinks and `.env` permissions. (ROS-38, ROS-65)
- `roster migrate from-agent-team` — ports the original `~/repos/agent-team` layout to a fresh roster workspace; manifest-tracked, rerun-safe. (ROS-43)
- `docs/SCHEDULING.md` — canonical reference for the platform × tool matrix, Linux Claude gap, Codex Windows caveat, UI hand-off flow. (ROS-39)
- Scheduling tests — unit + e2e shell + manual macOS gate. (ROS-40)

**Guided Agent Authoring — Phase 4 (closed 2026-05-17)**

- Guided dialogue mode for `/chief-of-staff create-agent`. TTY invocations run a five-phase interview (prose intake → classify → targeted follow-ups → consolidated preview → atomic write) that produces a fully populated `agent.md`, real `subagents/<name>.md` files, an optional starter `plans/<plan>.yaml`, and a ≤ 80-character slash-command description. The dialogue obeys an anti-fabrication invariant: gaps surface as questions, never as plausible-looking defaults. (ROS-49, ROS-50, ROS-51)
- Atomic write contract with rollback. Phase 5 enumerates every directory and file the transaction creates, writes `agent.md` last so any contract-aware reader observes either no agent or a complete one, and on failure (or SIGINT during Steps 4–5) walks the rollback list in reverse to leave the workspace clean. Residual paths are surfaced explicitly when cleanup is incomplete. (ROS-52)
- `scripts/new-agent.sh --slash-only <function> <agent>` recovery flag for the rare case where the agent tree write succeeds but `.claude/commands/<agent>.md` doesn't (e.g., permission error on the commands dir). Writes only the slash command; refuses to clobber an existing file. (ROS-53)
- Fixture-driven golden-snapshot test harness under `test/fixtures/create-agent/` so the dialogue mode is regression-testable without invoking an LLM in CI. (ROS-54, ROS-55)

### Changed

- **Breaking — TTY users see an extra prompt the first time they run `/chief-of-staff create-agent`.** The skill asks *"Empty scaffold, or design this agent together?"* before any write. Set `AGENT_TEAM_NO_CONFIRM=1` to skip the prompt and force stub mode — same behavior as v0.1. Non-TTY contexts (CI, piped stdin, scripts) get stub mode automatically and require no changes.
- Tool detection expanded from Claude-only (v0.1.0) to Claude + Codex + Gemini.
- Tarball footprint grew from 13 kB / 11 files (v0.1.0) to 154 kB / 96 files (v0.4.0); well under the 1 MB SPEC budget. Bundle: 257 kB / 62 kB gzipped.
- 822 tests on `main` at release, up from 14 at v0.1.0.

### Fixed

- `migrate`: harden wrapper path resolution + shell-escape rendered commands. (ROS-64)
- `migrate`: sanitize newlines in install-script TODO comments. (ROS-68)
- `create-agent`: quote slash command description for YAML-safe emission. (ROS-62)
- `create-agent`: parse slash frontmatter as YAML before placeholder scan. (ROS-59)
- `cli`: scope `--tool` enum per subcommand in `--help`. (ROS-70)
- `scripts`: enforce slug shape in `is_valid_function` / `read_functions`. (ROS-69)

### Docs

- `docs/SCHEDULING.md` — canonical scheduling reference (ROS-39).
- `docs/adr/0001-scheduling-architecture.md` — subscription-safe scheduling model.
- `docs/retros/phase-2.md`, `phase-2.5.md`, `phase-3.md`, `phase-4.md` — per-phase retrospectives.
- `templates/scaffold/conventions.md` rewritten per ADR-0001 (ROS-66) and swept of legacy `scripts/cron/wrappers/` references (ROS-67).

## [0.1.0] — 2026-05-17

Initial public release. Phase 1 retrospective: [`docs/retros/phase-1.md`](docs/retros/phase-1.md).

### Added

- `roster install` — copies the `chief-of-staff` skill and `lesson-drafter` agent into `~/.claude/skills/` and `~/.claude/agents/`. Idempotent. Handles symlinks and `EACCES`.
- `roster init <name>` — writes the minimal workspace (`CLAUDE.md` with `{{PROJECT_NAME}}` substituted, `projects/_demo/` placeholder, gitignore-defaults appended idempotently).
- `roster --help` / `roster --version`, exit codes 0/1/2/3.
- Tool detection limited to `~/.claude/` in this release; Codex CLI and Gemini CLI targets land in v0.2.0.

[Unreleased]: https://github.com/firatcand/roster/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/firatcand/roster/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/firatcand/roster/releases/tag/v0.1.0
