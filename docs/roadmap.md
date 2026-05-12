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

## v0.2.0 — Phase 2: Core Features (active)

Goal: every supported AI tool works end-to-end. After `install` and `init`, running `/sdr run cold-outreach for _demo` in Claude Code writes a real run log.

### In scope

| ID | Task | Notes |
|---|---|---|
| ROS-9 | Port `dreamer` + `sdr` skills + agents | Skill content lives in `skills/`; agents in `agents/`. |
| ROS-12 | Port `EXPERT.md` files into `templates/scaffold/` | Workspace-resident, not installed to AI-tool dirs. |
| ROS-13 | Codex CLI tool target | Skills as flat `.md` in `~/.codex/prompts/`. |
| ROS-15 | Gemini CLI tool target | Skills as dirs in `~/.gemini/extensions/`. |
| ROS-16 | Multi-tool selection (`--all`, `--tool <name>`) | Checkbox pre-selects all detected. |
| ROS-17 | Full `templates/scaffold/` tree | Largest content task. |
| ROS-18 | Extend `init` to copy full scaffold | Non-destructive merge on re-run. |
| ROS-19 | `roster doctor` | Detect missing/stale skills; exit 1 if drift. |
| ROS-29 | Node unit tests for core lib | `detectTools`, `installToTool`, path-traversal guard, `{{PROJECT_NAME}}` substitution. |

### Gate criteria

- `pnpm typecheck && pnpm test && pnpm build` exit 0.
- `roster install` works on all four AI tools.
- `roster doctor` exits 0 on a fresh install, exits 1 after a skill is deleted.
- `roster init` produces the full workspace tree.
- After `install` + `init`, `/sdr run cold-outreach for _demo` writes a run log in Claude Code.
- Both commands remain idempotent across re-runs.

## v0.3.0+ — Phase 3 (planned)

- Published to npm under `@firatcand/roster`.
- Migration docs for users coming from the original `~/repos/agent-team` layout.
- Optional: a `roster update` command that re-installs skills from latest package without re-running interactive prompts.
- Versioned skills with frontmatter `version` field; `doctor` reports stale by version instead of byte comparison.

## Out of scope

- **Cursor** — its rule-file model (`.cursor/rules/*.mdc`) injects static markdown into every chat. That doesn't fit roster's skill/agent/subagent semantics: no first-class skill invocation, no subagents, no slash commands as workflow entry points. Shipping there would only bloat Cursor conversations without delivering the workflow value. Cursor users can still get value from `roster init` (the workspace pattern + conventions) without `install`.
- PRD/SPEC/phases lifecycle — see [forge](https://github.com/firatcand/forge). Roster is complementary; the two don't bundle.
- Hosted SaaS — roster runs locally.
- Substrate-vs-artifacts model changes — core opinion, not up for redesign in this repo.
