# Roster Roadmap

Public view of what's shipped, what's in flight, and what's next. Detailed task tracking lives in Linear under project `roster` (issues `ROS-*`); planning artifacts (`spec/`, `plans/phases.yaml`) are local-only and not in the repo.

## v0.1.0 — Phase 1: Foundations (complete)

Closed **2026-05-12**. Retro: [retros/phase-1.md](retros/phase-1.md).

- CLI entry — `roster --help`, `roster --version`, exit codes 0/1/2/3.
- Tool detection — `~/.claude/` only in Phase 1.
- `roster install` — copies the `chief-of-staff` skill and `lesson-drafter` agent into `~/.claude/skills/` and `~/.claude/agents/`. Idempotent. Handles symlinks and EACCES.
- `roster init <name>` — writes a minimal workspace (`CLAUDE.md` with `{{PROJECT_NAME}}` substituted, `projects/_demo/` placeholder, gitignore-defaults appended idempotently).
- `npm pack` — clean 13 kB tarball, 11 files. Local install verified via `pnpm smoke`.

Status: not published to npm yet — locally installable via `npm pack && npm install -g <tarball>`.

## v0.2.0 — Phase 2: Core Features (complete)

Closed **2026-05-14**. Retro: [retros/phase-2.md](retros/phase-2.md).

- Full skill/agent content shipped — `dreamer`, `sdr`, `chief-of-staff` skills with companion agents.
- All four AI-tool targets — Claude Code, Codex CLI, Gemini, plus multi-tool selection (`--all`, `--tool <name>`).
- Full `templates/scaffold/` tree — `init` lays down the complete workspace, non-destructive on re-run.
- `roster doctor` — detects missing/stale skills and reports drift; exits 1 on mismatch.
- Hardening — structured error UX with `--debug`, path-traversal security audit, GitHub Actions CI with smoke + e2e gates.

## v0.2.5 — Phase 2.5: Scheduling primitives (planning)

Goal: schedule roster agents on macOS and Windows via each tool's native local scheduler (Claude Desktop Scheduled Tasks; Codex Automations or `codex exec` cron). All firing is subscription-billed — no Agent SDK or `claude -p`. Each scheduled fire is a fresh CLI session that loads `CONTEXT.md`, invokes the `roster-orchestrator` skill, and dispatches subagents in isolated context. HITL items flow through a filesystem queue surfaced as banners in any chat session.

Architecture decision: [ADR-0001 Scheduling architecture](adr/0001-scheduling-architecture.md).

### In scope (highlights)

- `CONTEXT.md` template + symlink (macOS/Linux) or dual-write (Windows) of `CLAUDE.md` / `AGENTS.md` from `roster init`.
- `roster-orchestrator` skill that bootstraps from `CONTEXT.md` on every fresh session.
- `roster schedule install --tool <claude|codex> [--via cron]` — writes crontab line or prints UI-import spec.
- HITL queue + SessionStart banner surface.
- `roster doctor` extended to detect symlink, crontab, and `.env` drift; static audit that no installed skill imports the Anthropic SDK or invokes `claude -p`.

## v0.3.0+ — Phase 3: Polish and Launch (blocked on 2.5)

- Published to npm under `@firatcand/roster`.
- Migration docs for users coming from the original `~/repos/agent-team` layout.
- Optional: a `roster update` command that re-installs skills from latest package without re-running interactive prompts.
- Versioned skills with frontmatter `version` field; `doctor` reports stale by version instead of byte comparison.

## Out of scope

- **Cursor** — its rule-file model (`.cursor/rules/*.mdc`) injects static markdown into every chat. That doesn't fit roster's skill/agent/subagent semantics: no first-class skill invocation, no subagents, no slash commands as workflow entry points. Shipping there would only bloat Cursor conversations without delivering the workflow value. Cursor users can still get value from `roster init` (the workspace pattern + conventions) without `install`.
- PRD/SPEC/phases lifecycle — see [forge](https://github.com/firatcand/forge). Roster is complementary; the two don't bundle.
- Hosted SaaS — roster runs locally.
- Substrate-vs-artifacts model changes — core opinion, not up for redesign in this repo.
