# Roster Roadmap

Public view of what's shipped, what's deferred, and what's next. Detailed task tracking lives in Linear under project `roster` (issues `ROS-*`); planning artifacts (`spec/`, `plans/phases.yaml`) are local-only and not in the repo.

## Released

### v0.4.0 — 2026-05-19

First feature-complete release. Rolls up Phases 2, 2.5, and 4 — all of which landed on `main` after v0.1.0 but were never published as separate npm releases. Full changelog: [CHANGELOG.md](../CHANGELOG.md#040--2026-05-19).

Phase summary:

| Phase | Theme | Closed | Retro |
|---|---|---|---|
| 1 | Foundations | 2026-05-12 | [phase-1.md](retros/phase-1.md) |
| 2 | Core Features | 2026-05-14 | [phase-2.md](retros/phase-2.md) |
| 3 | Polish and Launch | 2026-05-17 | [phase-3.md](retros/phase-3.md) |
| 4 | Guided Agent Authoring | 2026-05-17 | [phase-4.md](retros/phase-4.md) |
| 2.5 | Scheduling Primitives | 2026-05-18 | [phase-2.5.md](retros/phase-2.5.md) |

What this means for users:

- **Install** — `npm i -g @firatcand/roster`; `roster install` writes skills + agents into Claude Code, Codex CLI, or Gemini (use `--all` or `--tool <name>`).
- **Scaffold** — `roster init <name>` lays down the full agent-team workspace (`gtm/`, `product/`, `design/`, `ops/`, `chief-of-staff/`, `dreamer/`, `projects/_demo/`, `CONTEXT.md`, `conventions.md`). Non-destructive on re-run, forge-aware.
- **Schedule** — `roster schedule install --tool <claude|codex>` produces a UI hand-off spec (Claude Desktop / Codex Automations) or, with `--via cron` on Codex, writes a hardened crontab line. All firing is subscription-billed — no Agent SDK, no `claude -p`. See [SCHEDULING.md](SCHEDULING.md) and [ADR-0001](adr/0001-scheduling-architecture.md).
- **Maintain** — `roster doctor [--fix]` audits skills, scheduling, subscription-safety, and `.env` secrets; `roster review` and the SessionStart banner surface HITL items from scheduled runs.
- **Author** — `/chief-of-staff create-agent` runs a guided five-phase dialogue in TTY contexts (anti-fabrication, atomic write with rollback). Stub mode preserved via `AGENT_TEAM_NO_CONFIRM=1` and non-TTY contexts.

### v0.1.0 — 2026-05-17

Initial public release. Retro: [phase-1.md](retros/phase-1.md). Tool detection limited to `~/.claude/`; the `chief-of-staff` skill and `lesson-drafter` agent only. Superseded by v0.4.0.

## Deferred

Currently in the Linear backlog, both Low priority and not pickup-eligible under the "defer internal hardening pre-launch" rule. Will be reconsidered after the v0.4.0 launch settles.

- [ROS-63](https://linear.app/firatdogan/issue/ROS-63) — `migrate`: file-lock or CAS for manifest writes (TOCTOU window, only matters if two `roster migrate` runs race against each other on the same workspace).
- [ROS-57](https://linear.app/firatdogan/issue/ROS-57) — periodic re-check of the `claude://` URL scheme for a schedule-creation deep-link (passive watch on Claude Desktop releases; spike already filed in [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)).

## Out of scope

- **Cursor** — its rule-file model (`.cursor/rules/*.mdc`) injects static markdown into every chat. That doesn't fit roster's skill/agent/subagent semantics: no first-class skill invocation, no subagents, no slash commands as workflow entry points. Shipping there would only bloat Cursor conversations without delivering the workflow value. Cursor users can still get value from `roster init` (the workspace pattern + conventions) without `install`.
- PRD/SPEC/phases lifecycle — see [forge](https://github.com/firatcand/forge). Roster is complementary; the two don't bundle.
- Hosted SaaS — roster runs locally.
- Agent SDK / `claude -p` for scheduled firing — every fire must be subscription-billed (see [ADR-0001](adr/0001-scheduling-architecture.md)).
- Substrate-vs-artifacts model changes — core opinion, not up for redesign in this repo.
