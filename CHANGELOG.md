# Changelog

All notable changes to `@firatcand/roster` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

Per-phase retrospectives live in [`docs/retros/`](docs/retros/) and carry the long-form rationale; this file is the short, user-facing version.

## [Unreleased]

_(empty — staging area for post-1.0 work)_

## [1.0.0] — TBD

The single-project workspace refactor. v1.0.0 replaces the `projects/<slug>/` multi-tenant layout with a single root-level workspace, introduces shared brand/voice substrate under `config/` + `guidelines/`, and adds agent-level `.env` inheritance. **This is a breaking release — existing v0.4 workspaces require a re-scaffold (see Migration below).**

Per-phase retro: [docs/retros/v1.0.md](docs/retros/v1.0.md) — rolls up phases v1-1..v1-4.

### Removed

- **`projects/` directory dropped from `roster init` scaffolds.** The multi-tenant `projects/<slug>/` shape — including the `projects/_demo/` example workspace and the `project` field carried through scheduler entries and slash-command arguments — is gone. Roster is now opinionated single-project per workspace. (ROS-72, ROS-75)
- **`promotion-arbiter` subagent removed from `dreamer`.** Single-project workspaces collapse `dreamer`'s validated vs global-promotion decision tree into a single playbook scope. (ROS-91)
- **In-repo `.dogfood/` instance removed.** (Already on main pre-1.0.) The 102-file agent-team workspace fixture at `.dogfood/` is gone; `templates/scaffold/scripts/` is now the single canonical source for scaffold shell scripts. Promoted from `.dogfood/scripts/`: `rename-agent.sh` and `save-state.sh`. Deliberately not promoted: the old `cron/` wrappers and `new-cron.sh` — both invoked `claude -p` (the headless flag, paid API), which the doctor's subscription-safety check correctly rejects in shipped code. Scheduling is the job of `roster schedule install` (Phase 2.5); ad-hoc cron is not a shipped pattern. Dropped: `test/scripts-parity.sh` (no second tree to drift against), the `pnpm test:dogfood-scripts` script (renamed to `pnpm test:scaffold-scripts` and now runs `new-agent-slash-only.sh` alone), and the `.dogfood/...` ignore rules in `.gitignore`. The shipped surface is unchanged. Dogfooding now happens via `roster init` in a separate workspace.
- **SDR worked example removed from the shipped surface.** (Already on main pre-1.0.) `roster install` no longer copies an `sdr` skill or its `critic` / `enricher` / `prospector` / `writer` subagents; `roster init` no longer scaffolds `gtm/sdr/`. SDR was always a worked example, not a framework primitive — users now get an empty `gtm/` function dir (matching `product/` / `design/` / `ops/`) and scaffold their own agents via `/chief-of-staff create-agent <function> <agent>`. Dropped: `pnpm e2e` script and `test/e2e-sdr.sh` (CI no longer asserts an SDR-specific contract). Cuts ~20 files / ~30 KB from the npm tarball.

### Added

- **`config/` + `guidelines/` cross-agent substrate.** Fresh scaffolds ship `config/project.yaml` (project identity: name, stage, audience, motion, created) and `guidelines/{voice,messaging,brand-book,asset-links}.md` + `guidelines/icps/_persona-template.md`. Single shared source of truth for every agent in the workspace. (ROS-73)
- **Agent-level `.env` inheritance.** Each agent dir gets its own `.env` that inherits from the workspace `.env`, with agent values overriding workspace values. Empty strings remove a key inherited from the workspace. Doctor checks 13/14/15 audit the merged shape. (ROS-83, ROS-85, ROS-86, ROS-101)

### Changed

- **Schedule schema collapsed.** `roster/<function>/schedules.yaml` entries no longer carry a `project` field. The v0.4 3-tuple `function/agent/project` lookup is rejected with an explicit error; v1 entries use 2-tuple `function/agent` lookup. (ROS-80)
- **Slash-command syntax dropped the `for <project>` suffix.** `/sdr run cold-outreach for _demo` becomes `/sdr run cold-outreach`. Slash-command frontmatter no longer parses or substitutes a project arg. (ROS-89, ROS-92)
- **`chief-of-staff` plan inventory trimmed from 11 plans to 4.** The 7 project-management plans (create / archive / rename and their audits) are removed. Kept: `create-agent`, `create-function`, `audit-agent`, `audit-repo`. (ROS-90)
- **`dreamer` skill rewritten** as a single-playbook orchestrator without the `promotion-arbiter` subagent. (ROS-91)

### Migration

There is no automatic migration tool. To move from v0.4 to v1.0:

1. Scaffold a fresh workspace in a new directory: `roster init <name>`.
2. Copy your `.env`, `gtm/<agent>/state.md`, and any custom plans from the old workspace into the new one. There is no `projects/` directory in v1 — drop the `projects/<slug>/` path prefix when porting files.
3. Update any `roster/<function>/schedules.yaml` you'd written by hand: remove the `project:` field from every entry.
4. Update any custom slash-command invocations you'd embedded in scripts or cron: drop the trailing `for <project>` argument.
5. If you had a custom `dreamer` playbook that relied on the removed subagent, fold its logic into the single playbook (see [ROS-91](https://linear.app/firatdogan/issue/ROS-91) discussion).

The v0.4 → v1.0 cut is intentional: the multi-project layout shipped before we had real users, and the conceptual savings of a single-project model dwarf the cost of a one-time re-scaffold.

### Fixed

- Doctor check 12 no longer walks the dead v0.4 layout — now audits v1 `<function>/<agent>/.env` references correctly. (ROS-99)
- Doctor checks 12 + 15 no longer skip top-level infra agents (`dreamer`, `chief-of-staff`). (ROS-101)

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
- `roster schedule list / remove / status / run / validate / estimate-usage` — full lifecycle commands. `--dry-run` is uniform across `schedule install/run/remove` and `doctor`. `estimate-usage --json` rows are a strict superset of `list --json` (adds `install_mode`, `status`, `last_run`, `last_status`, `next_due_at`; nullable keys present as JSON `null`, not omitted). (ROS-36, ROS-41, ROS-44, ROS-45, ROS-71)
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

[Unreleased]: https://github.com/firatcand/roster/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/firatcand/roster/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/firatcand/roster/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/firatcand/roster/releases/tag/v0.1.0
